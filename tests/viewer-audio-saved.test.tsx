// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTranslator } from '@shared/i18n'
import type { FileItem } from '@shared/files'
import { FileViewer } from '@/panels/viewers'
import { wavFile } from './helpers/audio-files'

/**
 * A recording saved again while the files card shows it, and a preview frame that stops. The viewers reach the
 * preview page through the real client, and the page's side runs in the test on a MessageChannel, one for each frame
 * the client starts, so that a test can end a frame as a crash does. The recordings are WAV files, which the page
 * reads without a decoder; the canvas tells how long a recording its waveform covers.
 */

/** The page's end of each frame's channel, in the order the client started them. */
const frames = vi.hoisted(() => [] as MessagePort[])

vi.mock('@/panels/viewers/preview-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/panels/viewers/preview-client')>()
  const { servePreview } = await import('@/preview/serve')
  const client = actual.createPreviewClient(() => {
    const { port1, port2 } = new MessageChannel()
    servePreview(port2, { './methods/audio.ts': () => import('@/preview/methods/audio') })
    frames.push(port2)
    return { port: port1, gone: new Promise((resolve) => port1.addEventListener('close', () => resolve())), remove: () => undefined }
  })
  return { ...actual, openPreviewDocument: (kind: string, file: Parameters<typeof client.open>[1]) => client.open(kind, file) }
})

const t = createTranslator('ja-JP')
const URL = 'asist-file:///Users/me/memo.wav'
let file = new Uint8Array()
/** The ETag the server gives the file, which asist-file makes of its length and time of change. */
let etag = ''
let saves = 0
/** While set, every read waits for it, as a read of a file on a disk that does not answer does. */
let held: Promise<void> | null = null

/** Writes the file again, as a recorder that saves it does, at a new time of change: two seconds of samples at `rate`. */
function save(rate: number): void {
  file = wavFile({ bits: 16, channels: 1, sampleRate: rate }, 2 * 8000, () => 0.5)
  etag = `"${file.length}-${++saves}"`
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  held = null
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    await held
    const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('range') ?? '')!
    const start = Number(range[1])
    const end = Math.min(Number(range[2]), file.length - 1)
    return new Response(file.slice(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${file.length}`, ETag: etag } })
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function until(check: () => void): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      check()
      return
    } catch (error) {
      if (i >= 100) throw error
    }
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
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

/** How long a recording the waveform of each view covers, once it is drawn whole. */
const drawn = (mode: 'card' | 'focus'): string | null => {
  const wave = container.querySelector(`.view-${mode} .fv-media-wave`)
  return wave?.getAttribute('data-state') === 'ready' ? wave.getAttribute('data-seconds') : null
}
const errors = (): string[] => [...container.querySelectorAll('.fv-note[data-tone="error"]')].map((note) => note.textContent ?? '')

const itemOf = (modifiedAt: number): FileItem => ({ path: '/Users/me/memo.wav', name: 'memo.wav', kind: 'audio', sizeBytes: file.length, modifiedAt, url: URL })

describe('a recording saved again while it is shown', () => {
  it('draws the recording as it is now in the focus view and the card, when it was saved after the card drew it, at the same length', async () => {
    save(8000)
    const item = itemOf(1)
    await show(item, ['card'])
    await until(() => expect(drawn('card')).toBe('2'))

    // The same samples at twice the rate: a file of the same length, which only its ETag tells from the first.
    const length = file.length
    save(16_000)
    expect(file.length).toBe(length)
    // The card's item keeps the size and time of the file as it was listed.
    await show(item, ['card', 'focus'])
    await until(() => expect([drawn('card'), drawn('focus')]).toEqual(['1', '1']))
    expect(errors()).toEqual([])
  })

  it('draws the recording anew when a frame started after the last one stopped finds it saved since', async () => {
    save(8000)
    const item = itemOf(2)
    await show(item, ['card'])
    await until(() => expect(drawn('card')).toBe('2'))

    frames.at(-1)!.close()
    save(16_000)
    await show(item, ['card', 'focus'])
    await until(() => expect([drawn('card'), drawn('focus')]).toEqual(['1', '1']))
    expect(errors()).toEqual([])
  })
})

describe('a preview frame that stops while the waveform is read', () => {
  it('asks again in a new frame once, and draws the recording', async () => {
    save(8000)
    let go = (): void => undefined
    held = new Promise((resolve) => (go = resolve))
    const before = frames.length
    await show(itemOf(3), ['card'])
    await until(() => expect(frames).toHaveLength(before + 1))
    frames[before].close()
    await until(() => expect(frames).toHaveLength(before + 2))
    go()
    await until(() => expect(drawn('card')).toBe('2'))
    expect(errors()).toEqual([])
  })

  it('shows a second stop in a row rather than asking again', async () => {
    save(8000)
    held = new Promise(() => undefined)
    const before = frames.length
    await show(itemOf(4), ['card'])
    await until(() => expect(frames).toHaveLength(before + 1))
    frames[before].close()
    await until(() => expect(frames).toHaveLength(before + 2))
    frames[before + 1].close()
    await until(() => expect(container.querySelector('.fv-media-wave')?.getAttribute('data-state')).toBe('failed'))
    // happy-dom loads no media, so the duration the note starts with is given by hand.
    const audio = container.querySelector('audio')!
    Object.defineProperty(audio, 'duration', { value: 2, configurable: true })
    Object.defineProperty(audio, 'readyState', { value: 1, configurable: true })
    await act(async () => {
      audio.dispatchEvent(new Event('loadedmetadata'))
    })
    expect(errors()).toEqual([`0:02 · ${t('files.viewer.waveformFailed', { message: t('files.errors.previewStopped') })}`])
    expect(frames).toHaveLength(before + 2)
  })
})
