// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileItem } from '@shared/files'
import { createTranslator } from '@shared/i18n'
import { FileViewer } from '@/panels/viewers'
import { LayoutIntersectionObserver } from './helpers/intersection-observer'
// @ts-expect-error The generator is plain JavaScript without type declarations.
import { writePdf } from '../scripts/cdp/viewer-files/pdf-writer.mjs'

/**
 * A PDF saved again while the files card shows it, and the preview frame stopping under the PDF viewer. The viewers
 * reach the preview page through the real client, and the page's side runs in the test on a MessageChannel, one for
 * each frame the client starts, so that a test can end a frame as a crash does, with the real PDF kind: pdf.js's
 * legacy build, its worker in this thread, drawing with @napi-rs/canvas (as in preview-pdf.test.ts).
 */

const frames = vi.hoisted(() => ({ ports: [] as MessagePort[], onStart: null as ((port: MessagePort) => void) | null }))

vi.mock('pdfjs-dist', () => import('pdfjs-dist/legacy/build/pdf.mjs'))
vi.mock('@/preview/pdf-worker.ts?worker', async () => {
  const { WorkerMessageHandler } = await import('pdfjs-dist/legacy/build/pdf.worker.mjs')
  return {
    default: class {
      constructor() {
        const { port1, port2 } = new MessageChannel()
        WorkerMessageHandler.initializeFromPort(port2)
        port1.start()
        port2.start()
        return port1
      }
    }
  }
})
vi.mock('@/panels/viewers/preview-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/panels/viewers/preview-client')>()
  const { servePreview } = await import('@/preview/serve')
  const client = actual.createPreviewClient(() => {
    const { port1, port2 } = new MessageChannel()
    servePreview(port2, { './methods/pdf.ts': () => import('@/preview/methods/pdf') })
    frames.ports.push(port2)
    frames.onStart?.(port2)
    return { port: port1, gone: new Promise((resolve) => port1.addEventListener('close', () => resolve())), remove: () => undefined }
  })
  return { ...actual, openPreviewDocument: (kind: string, file: Parameters<typeof client.open>[1]) => client.open(kind, file) }
})

const t = createTranslator('ja-JP')
/** How long a test may take, given until's 15 s. */
const LONG = 30_000
const PDF_URL = 'asist-file:///Users/me/minutes.pdf'
let file = new Uint8Array()
/** The ETag the server gives the file, which asist-file makes of its length and time of change. */
let etag = ''
let saves = 0
/** The requests the server answered. */
let requests = 0

/**
 * Writes the file again, as an app that saves it does, at a new time of change. A picture of 270 KB on every page
 * keeps the pages apart, so that opening the file and drawing page 1 reads nothing of the pages in the middle.
 */
function save(pages: number): void {
  file = writePdf({ pages, textBytes: 2000, pictureEvery: 1, picture: { width: 300, height: 300 } })
  etag = `"${file.length}-${++saves}"`
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
  vi.stubGlobal('IntersectionObserver', LayoutIntersectionObserver)
  // A bitmap crosses the channel by cloning here, so it holds only its size.
  vi.stubGlobal('createImageBitmap', async ({ width, height }: { width: number; height: number }) => ({ width, height }))
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 600 })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ transferFromImageBitmap: () => undefined }) as never)
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    requests += 1
    const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('range') ?? '')!
    const start = Number(range[1])
    const end = Math.min(Number(range[2]), file.length - 1)
    return new Response(file.slice(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${file.length}`, ETag: etag } })
  })
  frames.onStart = null
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  LayoutIntersectionObserver.reset()
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Lets the observers report, as a browser does after a frame. */
const frame = (): Promise<void> => act(async () => LayoutIntersectionObserver.update())

/**
 * Waits until the check passes, letting the observers report every 10 ms as a browser does at each frame, for up to
 * 15 s: pdf.js loads and parses in this thread, which took 1 to 3 s under the load of other test files.
 */
async function until(check: () => void): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      check()
      return
    } catch (error) {
      if (i >= 1500) throw error
    }
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
    await frame()
  }
}

/** The card and the focus view of the same item, each in a box of its own. */
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
}

/** Lays the focus view's pages out a screen and a half apart, the view scrolled down by `scrolled` screens. */
function layOutPages(scrolled: () => number): void {
  container.querySelectorAll<HTMLElement>('.view-focus .fv-pdf-page').forEach((page) => {
    page.getBoundingClientRect = () => {
      const top = ((Number(page.dataset.page) - 1) * 3 - scrolled()) * window.innerHeight
      return { top, bottom: top + 400, left: 0, right: 600, width: 600, height: 400, x: 0, y: top } as DOMRect
    }
  })
}

const notesIn = (mode: 'card' | 'focus'): string[] => [...container.querySelectorAll(`.view-${mode} .fv-note`)].map((note) => note.textContent ?? '')
const drawnIn = (mode: 'card' | 'focus'): number[] =>
  [...container.querySelectorAll<HTMLElement>(`.view-${mode} .fv-pdf-page`)].filter((page) => page.querySelector('canvas')?.width !== 300 && page.querySelector('canvas')).map((page) => Number(page.dataset.page))
const errors = (): string[] => [...container.querySelectorAll('.fv-note[data-tone="error"]')].map((note) => note.textContent ?? '')

describe('a PDF saved again while it is shown', () => {
  it('starts over from the page count in the card and the focus view, when a page read after the save finds the file changed', async () => {
    save(40)
    const item: FileItem = { path: '/Users/me/minutes.pdf', name: 'minutes.pdf', kind: 'pdf', sizeBytes: file.length, modifiedAt: 1, url: PDF_URL }
    await show(item, ['card'])
    await until(() => expect(drawnIn('card')).toEqual([1]))
    expect(notesIn('card')).toEqual([t('files.viewer.pdfPages', { count: 40 })])

    // The card's item keeps the size and time of the file as it was listed.
    save(30)
    await show(item, ['card', 'focus'])
    let scrolled = 0
    await until(() => expect(container.querySelectorAll('.view-focus .fv-pdf-page')).toHaveLength(40))
    layOutPages(() => scrolled)
    // Page 20 in view.
    scrolled = 57
    await frame()
    await until(() => expect(notesIn('card')).toEqual([t('files.viewer.pdfPages', { count: 30 })]))
    await until(() => expect(container.querySelectorAll('.view-focus .fv-pdf-page')).toHaveLength(30))
    expect(errors()).toEqual([])
  }, LONG)

  it('starts over when a frame started after the last one stopped finds the file saved with fewer pages', async () => {
    save(8)
    const item: FileItem = { path: '/Users/me/minutes.pdf', name: 'minutes.pdf', kind: 'pdf', sizeBytes: file.length, modifiedAt: 2, url: PDF_URL }
    await show(item, ['focus'])
    let scrolled = 0
    await until(() => expect(container.querySelectorAll('.view-focus .fv-pdf-page')).toHaveLength(8))
    layOutPages(() => scrolled)
    await frame()
    await until(() => expect(drawnIn('focus')).toEqual([1]))

    frames.ports.at(-1)!.close()
    save(3)
    scrolled = 6
    await frame()
    await until(() => expect(notesIn('focus')).toEqual([t('files.viewer.pdfPages', { count: 3 })]))
    expect(errors()).toEqual([])
  }, LONG)
})

describe('the preview frame stopping under the PDF viewer', () => {
  it('asks once more in a new frame for what a frame that stopped did not answer', async () => {
    save(4)
    const item: FileItem = { path: '/Users/me/minutes.pdf', name: 'minutes.pdf', kind: 'pdf', sizeBytes: file.length, modifiedAt: 3, url: PDF_URL }
    // The first frame stops as soon as the summary is asked of it.
    frames.onStart = (port) => {
      frames.onStart = null
      port.addEventListener('message', () => port.close(), { once: true })
    }
    await show(item, ['card'])
    await until(() => expect(drawnIn('card')).toEqual([1]))
    expect(frames.ports.length).toBeGreaterThanOrEqual(2)
    expect(errors()).toEqual([])
  }, LONG)

  it('shows that the frame stopped when it stops twice in a row', async () => {
    save(4)
    const item: FileItem = { path: '/Users/me/minutes.pdf', name: 'minutes.pdf', kind: 'pdf', sizeBytes: file.length, modifiedAt: 4, url: PDF_URL }
    frames.onStart = (port) => port.addEventListener('message', () => port.close(), { once: true })
    await show(item, ['card'])
    await until(() => expect(errors()).toEqual([t('files.errors.previewStopped')]))
  }, LONG)

  it('tells no frame of the drawings a frame that stopped held, when the focus view closes', async () => {
    save(8)
    const item: FileItem = { path: '/Users/me/minutes.pdf', name: 'minutes.pdf', kind: 'pdf', sizeBytes: file.length, modifiedAt: 5, url: PDF_URL }
    await show(item, ['card', 'focus'])
    await until(() => expect(container.querySelectorAll('.view-focus .fv-pdf-page')).toHaveLength(8))
    layOutPages(() => 0)
    await frame()
    await until(() => expect(drawnIn('focus')).toEqual([1]))
    const started = frames.ports.length
    frames.ports.at(-1)!.close()
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
    const read = requests

    await show(item, ['card'])
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(frames.ports.length).toBe(started)
    expect(requests).toBe(read)
  }, LONG)
})
