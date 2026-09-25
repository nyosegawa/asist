// @vitest-environment happy-dom
import JSZip from 'jszip'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatBytes, type FileItem } from '@shared/files'
import { createTranslator } from '@shared/i18n'
import { archiveTotals, flattenArchive } from '@/panels/viewers/archive'
import { ArchiveViewer, listZip } from '@/panels/viewers/ArchiveViewer'
import { AudioViewer } from '@/panels/viewers/AudioViewer'
import { downsampleWaveform, formatTime } from '@/panels/viewers/media'
import { VideoViewer } from '@/panels/viewers/VideoViewer'
import type { ViewerProps } from '@/panels/viewers/types'

/**
 * The video, audio and zip viewers: the pure logic (time formatting, waveform downsampling, the zip tree and its
 * totals) and the DOM behavior of the controls. happy-dom does not play media, so play and pause on the media
 * element are replaced and the events are dispatched by hand.
 */

describe('time formatting', () => {
  it('formats minutes and seconds, adds hours past an hour, and shows 0:00 while the duration is unknown', () => {
    expect(formatTime(3.9)).toBe('0:03')
    expect(formatTime(65)).toBe('1:05')
    expect(formatTime(3723)).toBe('1:02:03')
    expect(formatTime(NaN)).toBe('0:00')
    expect(formatTime(Infinity)).toBe('0:00')
  })
})

describe('waveform downsampling', () => {
  it('takes the peak amplitude of each bucket across all channels and normalizes the largest to 1', () => {
    const left = new Float32Array([0.1, -0.4, 0.2, 0.0, 0.1, 0.1])
    const right = new Float32Array([0.0, 0.0, 0.0, -0.8, 0.0, 0.0])
    expect(downsampleWaveform([left, right], 3)).toEqual([0.5, 1, 0.125])
  })

  it('returns one value per bucket even with fewer samples than buckets and leaves silence at 0', () => {
    expect(downsampleWaveform([new Float32Array([0, 0])], 4)).toEqual([0, 0, 0, 0])
    expect(downsampleWaveform([new Float32Array([0.5])], 2)).toHaveLength(2)
    expect(downsampleWaveform([], 3)).toEqual([])
  })
})

describe('the zip tree', () => {
  const entries = [
    { path: 'b.txt', dir: false, size: 30, compressedSize: 20 },
    { path: 'docs/', dir: true, size: 0, compressedSize: 0 },
    { path: 'docs/readme.md', dir: false, size: 100, compressedSize: 60 },
    { path: 'img/deep/x.png', dir: false, size: 500, compressedSize: 490 },
    { path: 'a.txt', dir: false, size: 10, compressedSize: 5 },
    { path: '__MACOSX/._a.txt', dir: false, size: 99, compressedSize: 99 },
    { path: '.DS_Store', dir: false, size: 99, compressedSize: 99 }
  ]

  it('puts folders first and sorts by name at each level, builds a missing folder from the paths, and hides hidden files', () => {
    const rows = flattenArchive(entries)
    expect(rows.map((row) => `${'  '.repeat(row.depth)}${row.name}${row.dir ? '/' : ''}`)).toEqual([
      'docs/',
      '  readme.md',
      'img/',
      '  deep/',
      '    x.png',
      'a.txt',
      'b.txt'
    ])
    expect(rows.find((row) => row.name === 'img')).toMatchObject({ dir: true, children: 1 })
  })

  it('counts only files in the totals and leaves out what is hidden', () => {
    expect(archiveTotals(flattenArchive(entries))).toEqual({ files: 4, size: 640, compressedSize: 575 })
  })

  it('carries both the uncompressed and the compressed size of every entry read with jszip', async () => {
    const zip = new JSZip()
    zip.file('long.txt', 'a'.repeat(4000))
    zip.folder('sub')!.file('n.txt', 'x')
    const bytes = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' })
    const listed = await listZip(bytes)
    const long = listed.find((entry) => entry.path === 'long.txt')!
    expect(long.size).toBe(4000)
    expect(long.compressedSize).toBeGreaterThan(0)
    expect(long.compressedSize).toBeLessThan(4000)
    expect(listed.find((entry) => entry.path === 'sub/')).toMatchObject({ dir: true })
  })
})

describe('viewer rendering', () => {
  let container: HTMLDivElement
  let root: Root
  const play = vi.fn(async () => {})
  const pause = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {}
      }
    )
    play.mockClear()
    pause.mockClear()
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pause)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  /** Mounts with a new key every time, so rendering the same item twice still starts again from the fetch. */
  let mounts = 0
  async function render(Viewer: React.FC<ViewerProps>, item: FileItem, size: ViewerProps['size'] = 'l'): Promise<HTMLElement> {
    await act(async () => {
      root.render(
        React.createElement('div', { className: 'card', 'data-size': size }, React.createElement(Viewer, { key: mounts++, item, mode: size === 'focus' ? 'focus' : 'card', size }))
      )
    })
    return container.querySelector<HTMLElement>('.card')!
  }

  /** happy-dom never loads metadata, so the duration and the position are made writable and the event is sent by hand. */
  async function loadMetadata(el: HTMLMediaElement, duration: number, extra: Record<string, unknown> = {}): Promise<void> {
    Object.defineProperty(el, 'duration', { value: duration, configurable: true })
    Object.defineProperty(el, 'readyState', { value: 1, configurable: true })
    for (const [key, value] of Object.entries(extra)) Object.defineProperty(el, key, { value, configurable: true })
    await act(async () => {
      el.dispatchEvent(new Event('loadedmetadata'))
    })
  }

  const video: FileItem = { path: '/v/clip.mp4', name: 'clip.mp4', kind: 'video', sizeBytes: 13475, url: '/demo-files/media/interview.mp4' }
  const audio: FileItem = { path: '/v/tone.wav', name: 'tone.wav', kind: 'audio', sizeBytes: 40044, url: '/demo-files/media/interview.wav' }

  it('keeps the video controls disabled until the metadata arrives, then notes the duration and size and passes play and pause to the element', async () => {
    const card = await render(VideoViewer, video)
    const el = card.querySelector('video')!
    expect(el.hasAttribute('autoplay')).toBe(false)
    expect(el.hasAttribute('controls')).toBe(false)
    const playButton = card.querySelector<HTMLButtonElement>('[aria-label="再生"]')!
    expect(playButton.disabled).toBe(true)
    expect(card.querySelector('.fv-note')?.textContent).toBe(createTranslator('ja-JP')('files.viewer.loading'))

    await loadMetadata(el, 3, { videoWidth: 160, videoHeight: 120 })
    expect(card.querySelector('.fv-note')?.textContent).toBe('0:03 · 160×120')
    expect(playButton.disabled).toBe(false)
    expect(card.querySelector<HTMLInputElement>('.fv-media-seek')?.max).toBe('3')

    await act(async () => playButton.click())
    expect(play).toHaveBeenCalledTimes(1)
    Object.defineProperty(el, 'paused', { value: false, configurable: true })
    await act(async () => {
      el.dispatchEvent(new Event('play'))
    })
    const pauseButton = card.querySelector<HTMLButtonElement>('[aria-label="一時停止"]')!
    await act(async () => pauseButton.click())
    expect(pause).toHaveBeenCalledTimes(1)
  })

  it('follows timeupdate on the seek bar, writes currentTime when it is dragged, and toggles muted on the element', async () => {
    const card = await render(VideoViewer, video)
    const el = card.querySelector('video')!
    await loadMetadata(el, 10)
    el.currentTime = 4
    await act(async () => {
      el.dispatchEvent(new Event('timeupdate'))
    })
    const seek = card.querySelector<HTMLInputElement>('.fv-media-seek')!
    expect(seek.value).toBe('4')
    expect([...card.querySelectorAll('.fv-media-time')].map((node) => node.textContent)).toEqual(['0:04', '0:10'])

    // A controlled React input fires onChange only when the value is set through the native setter before the input event.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(seek, '7.5')
    await act(async () => {
      seek.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(el.currentTime).toBe(7.5)

    await act(async () => card.querySelector<HTMLButtonElement>('[aria-label="消音"]')!.click())
    expect(el.muted).toBe(true)
    await act(async () => {
      el.dispatchEvent(new Event('volumechange'))
    })
    expect(card.querySelector('[aria-label="消音を解く"]')?.getAttribute('aria-pressed')).toBe('true')
  })

  it('decodes the audio bytes to build the waveform and declines with a note instead of decoding a file that is too large', async () => {
    const decodeAudioData = vi.fn(async () => ({ numberOfChannels: 1, getChannelData: () => new Float32Array([0.2, 0.9, 0.1, 0.4]) }))
    vi.stubGlobal(
      'AudioContext',
      class {
        decodeAudioData = decodeAudioData
        close = async (): Promise<void> => {}
      }
    )
    const fetch = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }))
    vi.stubGlobal('fetch', fetch)

    const card = await render(AudioViewer, audio)
    await act(async () => {
      await Promise.resolve()
    })
    expect(fetch).toHaveBeenCalledWith(audio.url)
    expect(decodeAudioData).toHaveBeenCalledTimes(1)
    expect(card.querySelector('.fv-media-wave')?.getAttribute('data-state')).toBe('ready')
    await loadMetadata(card.querySelector('audio')!, 2.5)
    expect(card.querySelector('.fv-note')?.textContent).toBe('0:02')

    fetch.mockClear()
    decodeAudioData.mockClear()
    const big = await render(AudioViewer, { ...audio, sizeBytes: 21 * 1024 * 1024 })
    expect(fetch).not.toHaveBeenCalled()
    expect(decodeAudioData).not.toHaveBeenCalled()
    expect(big.querySelector('.fv-media-wave')?.getAttribute('data-state')).toBe('skipped')
    await loadMetadata(big.querySelector('audio')!, 600)
    expect(big.querySelector('.fv-note')?.textContent).toBe(`10:00 · ${createTranslator('ja-JP')('files.viewer.waveformTooLarge', { size: '21.0MB' })}`)
  })

  it('seeks to the matching fraction of the track when the waveform is clicked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) })))
    const card = await render(AudioViewer, audio)
    const el = card.querySelector('audio')!
    await loadMetadata(el, 8)
    const wave = card.querySelector<HTMLCanvasElement>('.fv-media-wave')!
    vi.spyOn(wave, 'getBoundingClientRect').mockReturnValue({ left: 100, width: 200, top: 0, height: 72, right: 300, bottom: 72, x: 100, y: 0, toJSON: () => ({}) })
    await act(async () => {
      wave.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 150 }))
    })
    expect(el.currentTime).toBe(2)
  })

  async function zipBytes(): Promise<ArrayBuffer> {
    const zip = new JSZip()
    zip.file('README.md', '# 資料\n')
    zip.file('transcript.txt', 'x'.repeat(2000))
    zip.folder('slides')!.file('agenda.md', '# 議題\n')
    zip.folder('slides')!.file('pricing.csv', 'a,b\n1,2\n')
    zip.folder('slides/figures')!.file('shot.png', new Uint8Array(300))
    zip.file('notes/followup.md', '- 1\n')
    return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' })
  }
  const stubFetch = (bytes: ArrayBuffer): void => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => bytes })))
  }
  const archive: FileItem = { path: '/v/handout.zip', name: 'handout.zip', kind: 'archive', sizeBytes: 2249, url: '/demo-files/media/handout.zip' }
  const settle = async (): Promise<void> => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }

  it('lays the zip out as a folder tree, keeps 3 rows at size s with the count and totals in the note, and shows all of it in the focus view', async () => {
    const bytes = await zipBytes()
    const totals = archiveTotals(flattenArchive(await listZip(bytes)))
    stubFetch(bytes)
    const small = await render(ArchiveViewer, archive, 's')
    await settle()
    const rows = [...small.querySelectorAll<HTMLElement>('.fv-archive-row')]
    expect(rows.map((row) => row.querySelector('.card-row-title')?.textContent)).toEqual(['notes', 'followup.md', 'slides'])
    expect(rows.map((row) => row.style.getPropertyValue('--fv-archive-depth'))).toEqual(['0', '1', '0'])
    expect(rows[0].querySelector('.card-row-meta')?.textContent).toBe('1件')
    expect(rows[0].querySelector('button')).toBeNull()
    expect(small.querySelector('.fv-note')?.textContent).toBe(`他 6 件は拡大表示で · 6 ファイル · 合計 ${formatBytes(totals.size)}(圧縮後 ${formatBytes(totals.compressedSize)})`)

    const focus = await render(ArchiveViewer, archive, 'focus')
    await settle()
    expect([...focus.querySelectorAll('.fv-archive-row .card-row-title')].map((el) => el.textContent)).toEqual([
      'notes',
      'followup.md',
      'slides',
      'figures',
      'shot.png',
      'agenda.md',
      'pricing.csv',
      'README.md',
      'transcript.txt'
    ])
    expect(focus.querySelector('.fv-note')?.textContent).toBe(`6 ファイル · 合計 ${formatBytes(totals.size)}(圧縮後 ${formatBytes(totals.compressedSize)})`)
  })

  it('shows the reason in a red note for a password-protected or a corrupt zip', async () => {
    // jszip cannot build a password-protected archive, so the encryption bit of the general purpose flag is set by hand.
    const bytes = new Uint8Array(await zipBytes())
    for (let i = 0; i < bytes.length - 4; i++) {
      const sig = bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)
      if (sig === 0x04034b50) bytes[i + 6] |= 1
      if (sig === 0x02014b50) bytes[i + 8] |= 1
    }
    stubFetch(bytes.buffer)
    const encrypted = await render(ArchiveViewer, archive)
    await settle()
    expect(encrypted.querySelector('.fv-note')?.getAttribute('data-tone')).toBe('error')
    expect(encrypted.querySelector('.fv-note')?.textContent).toBe(createTranslator('ja-JP')('files.viewer.zipEncrypted'))

    stubFetch(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer)
    const corrupt = await render(ArchiveViewer, archive)
    await settle()
    expect(corrupt.querySelector('.fv-note')?.getAttribute('data-tone')).toBe('error')
    expect(corrupt.querySelector('.fv-note')?.textContent).toMatch(/^zip として読めません: /)
  })
})
