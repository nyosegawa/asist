// @vitest-environment happy-dom
import JSZip from 'jszip'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTranslator } from '@shared/i18n'
import type { FileItem } from '@shared/files'
import { FileViewer } from '@/panels/viewers'
import { LayoutIntersectionObserver } from './helpers/intersection-observer'

/**
 * A PowerPoint file saved again while the files card shows it. The viewers reach the preview page through the real
 * client, and the page's side runs in the test on a MessageChannel, one for each frame the client starts, so that a
 * test can end a frame as a crash does. The decks hold text alone, since happy-dom has no bitmap to send.
 */

/** The page's end of each frame's channel, in the order the client started them. */
const frames = vi.hoisted(() => [] as MessagePort[])

vi.mock('@/panels/viewers/preview-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/panels/viewers/preview-client')>()
  const { servePreview } = await import('@/preview/serve')
  const client = actual.createPreviewClient(() => {
    const { port1, port2 } = new MessageChannel()
    servePreview(port2, { './methods/pptx.ts': () => import('@/preview/methods/pptx') })
    frames.push(port2)
    return { port: port1, gone: new Promise((resolve) => port1.addEventListener('close', () => resolve())), remove: () => undefined }
  })
  return { ...actual, openPreviewDocument: (kind: string, file: Parameters<typeof client.open>[1]) => client.open(kind, file) }
})

const t = createTranslator('ja-JP')
const DECK_URL = 'asist-file:///Users/me/deck.pptx'
let file = new Uint8Array()
/** The ETag the server gives the file, which asist-file makes of its length and time of change. */
let etag = ''
let saves = 0

/** Writes the file again, as an app that saves it does, at a new time of change. */
async function save(titles: string[], options?: { stored?: boolean }): Promise<void> {
  file = await deckOf(titles, options)
  etag = `"${file.length}-${++saves}"`
}

const PPT_NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const RELS_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"'

/**
 * A deck of a title on each slide, with 200 KB of other parts behind the slides, so that a slide lies outside the
 * last 64 KB the reader keeps from when it opened the file, and reading it reaches the file as it is now. With
 * `stored`, nothing is compressed, so that titles of the same length make a file of the same length.
 */
async function deckOf(titles: string[], { stored = false } = {}): Promise<Uint8Array> {
  const zip = new JSZip()
  const ids = titles.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')
  zip.file('ppt/presentation.xml', `<p:presentation ${PPT_NS}><p:sldIdLst>${ids}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`)
  zip.file('ppt/_rels/presentation.xml.rels', `<Relationships ${RELS_NS}>${titles.map((_, i) => `<Relationship Id="rId${i + 1}" Type="x" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>`)
  titles.forEach((title, i) => {
    zip.file(
      `ppt/slides/slide${i + 1}.xml`,
      `<p:sld ${PPT_NS}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
    )
  })
  zip.file('ppt/media/filler.bin', new Uint8Array(200_000).map((_, i) => (i * 7919) % 251), { compression: 'STORE' })
  return zip.generateAsync({ type: 'uint8array', compression: stored ? 'STORE' : 'DEFLATE' })
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
  vi.stubGlobal('IntersectionObserver', LayoutIntersectionObserver)
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    const range = /^bytes=(\d*)-(\d*)$/.exec(new Headers(init?.headers).get('range') ?? '')!
    const suffix = range[1] === ''
    const start = suffix ? Math.max(0, file.length - Number(range[2])) : Number(range[1])
    const end = suffix || range[2] === '' ? file.length - 1 : Math.min(Number(range[2]), file.length - 1)
    return new Response(file.slice(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${file.length}`, ETag: etag } })
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  LayoutIntersectionObserver.reset()
  vi.unstubAllGlobals()
})

/** Lets the observers report, as a browser does after a frame. */
const frame = (): Promise<void> => act(async () => LayoutIntersectionObserver.update())

/** Waits until the check passes, letting the observers report every 10 ms as a browser does at each frame. */
async function until(check: () => void): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      check()
      return
    } catch (error) {
      if (i >= 100) throw error
    }
    await act(async () => new Promise((r) => setTimeout(r, 10)))
    await frame()
  }
}

/** The card and, once it is opened, the focus view of the same item, each in a box of its own, with their slides laid out. */
async function show(item: FileItem, views: Array<'card' | 'focus'>): Promise<void> {
  await act(async () => {
    root.render(
      <>
        {views.map((mode) => (
          <div key={mode} className={`view-${mode}`}>
            <FileViewer item={item} mode={mode} size={mode === 'card' ? 'l' : 'focus'} />
          </div>
        ))}
      </>
    )
  })
  for (const mode of views) await until(() => expect(container.querySelector(`.view-${mode} .fv-pptx-slide`)).not.toBeNull())
}

const titlesIn = (mode: 'card' | 'focus'): string[] => [...container.querySelectorAll(`.view-${mode} .fv-pptx-figure`)].map((figure) => figure.querySelector('.fv-pptx-para')?.textContent ?? '')
const notesIn = (mode: 'card' | 'focus'): string[] => [...container.querySelectorAll(`.view-${mode} .fv-note`)].map((note) => note.textContent ?? '')
const errors = (): string[] => [...container.querySelectorAll('.fv-note[data-tone="error"]')].map((note) => note.textContent ?? '')

describe('a PowerPoint file saved again while it is shown', () => {
  it('shows the deck as it is now in the focus view and the card, when it was saved after the card opened it', async () => {
    await save(['一枚目', '二枚目', '三枚目'])
    const item: FileItem = { path: '/Users/me/deck.pptx', name: 'deck.pptx', kind: 'pptx', sizeBytes: file.length, modifiedAt: 1, url: DECK_URL }
    await show(item, ['card'])
    await frame()
    await until(() => expect(titlesIn('card')).toEqual(['一枚目']))

    // The card's item keeps the size and time of the file as it was listed.
    await save(['一枚目', '二枚目(直した)', '三枚目', '四枚目'])
    await show(item, ['card', 'focus'])
    await frame()
    await until(() => expect(titlesIn('focus')).toEqual(['一枚目', '二枚目(直した)', '三枚目', '四枚目']))
    await until(() => expect(notesIn('card')).toContain(t('files.viewer.pptxCountMore', { count: 4 })))
    expect(errors()).toEqual([])
  })

  it('opens the deck again when a frame started after the last one stopped finds it saved with fewer slides', async () => {
    await save(['一枚目', '二枚目', '三枚目'])
    const item: FileItem = { path: '/Users/me/deck.pptx', name: 'deck.pptx', kind: 'pptx', sizeBytes: file.length, modifiedAt: 2, url: DECK_URL }
    await show(item, ['focus'])
    // The first slide is in view, and the others more than a screen below it.
    let scrolled = 0
    container.querySelectorAll<HTMLElement>('.fv-pptx-slide').forEach((slide, index) => {
      slide.getBoundingClientRect = () => {
        const top = index * 3 * window.innerHeight - scrolled
        return { top, bottom: top + 400, left: 0, right: 712, width: 712, height: 400, x: 0, y: top } as DOMRect
      }
    })
    await frame()
    await until(() => expect(titlesIn('focus')).toEqual(['一枚目', '', '']))

    frames.at(-1)!.close()
    await save(['新しい一枚目', '新しい二枚目'])
    scrolled = 6 * window.innerHeight
    await frame()
    await until(() => expect(titlesIn('focus')).toEqual(['新しい一枚目', '新しい二枚目']))
    expect(errors()).toEqual([])
  })

  it('opens the deck again when a frame started after the last one stopped finds it saved at the same length', async () => {
    await save(['一枚目', '二枚目', '三枚目'], { stored: true })
    const item: FileItem = { path: '/Users/me/deck.pptx', name: 'deck.pptx', kind: 'pptx', sizeBytes: file.length, modifiedAt: 3, url: DECK_URL }
    await show(item, ['focus'])
    let scrolled = 0
    container.querySelectorAll<HTMLElement>('.fv-pptx-slide').forEach((slide, index) => {
      slide.getBoundingClientRect = () => {
        const top = index * 3 * window.innerHeight - scrolled
        return { top, bottom: top + 400, left: 0, right: 712, width: 712, height: 400, x: 0, y: top } as DOMRect
      }
    })
    await frame()
    await until(() => expect(titlesIn('focus')).toEqual(['一枚目', '', '']))

    frames.at(-1)!.close()
    const length = file.length
    await save(['壱枚目', '弐枚目', '参枚目'], { stored: true })
    expect(file.length).toBe(length)
    scrolled = 6 * window.innerHeight
    await frame()
    await until(() => expect(titlesIn('focus')).toEqual(['壱枚目', '弐枚目', '参枚目']))
    expect(errors()).toEqual([])
  })
})
