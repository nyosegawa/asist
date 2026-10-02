import { useEffect, useRef, useState } from 'react'
import type { FileItem } from '@shared/files'
import { baseName } from '@shared/file-path'
import { errorKeyOf } from '@shared/i18n/error-key'
import { Frame } from './Frame'
import { formatTime } from './media'
import { MediaControls, useMediaState } from './MediaControls'
import { openPreviewDocument } from './preview-client'
import type { Viewer } from './types'
import './MediaViewer.css'
import { displayError } from '@/display-error'
import { useT } from '@/i18n'
import type openAudio from '@/preview/methods/audio'

/**
 * Audio. The <audio> element stays hidden and the waveform together with MediaControls drives it; it plays the file
 * by ranges, at any size. The waveform is built in the preview page (preview/methods/audio.ts), which reads the
 * file from its start a piece at a time and sends the bars of what it has read, which are drawn as they come, the
 * part not read yet as a flat line. A file saved again while it is shown is read anew and drawn as it is now.
 * Pressing the waveform seeks to that position.
 */
const BARS = 400
const NO_BARS = new Float32Array(0)

/** The recordings that get a waveform. FLAC and OGG play without one. */
const WITH_WAVEFORM = new Set(['.mp3', '.m4a', '.aac', '.wav'])

function drawsWaveform(path: string): boolean {
  const name = baseName(path).toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot >= 0 && WITH_WAVEFORM.has(name.slice(dot))
}

type Waveform =
  | { state: 'loading' | 'unsupported' }
  | { state: 'drawing' | 'ready'; bars: Float32Array; seconds: number }
  | { state: 'failed'; message: string }

const STOPPED = 'files.errors.previewStopped'

function useWaveform({ path, url, sizeBytes, modifiedAt }: FileItem): Waveform {
  const [waveform, setWaveform] = useState<Waveform>({ state: 'loading' })
  /** How many times the file was found saved again while it was shown, each of which builds the waveform anew. */
  const [saves, setSaves] = useState(0)
  useEffect(() => {
    if (!url) return
    if (!drawsWaveform(path)) {
      setWaveform({ state: 'unsupported' })
      return
    }
    setWaveform({ state: 'loading' })
    const preview = openPreviewDocument<typeof openAudio>('audio', { url, sizeBytes, modifiedAt })
    let current = true
    const stopListening = preview.onChanged(() => {
      if (!current) return
      current = false
      setSaves((count) => count + 1)
    })
    void (async () => {
      let after = 0
      let stopped = false
      for (;;) {
        let answer
        try {
          answer = await preview.call('waveform', { bars: BARS, after })
        } catch (error) {
          if (!current) return
          // A frame that stopped before it answered, as another viewer's file can make it, is started anew and
          // reads the file from its start, so the waveform is asked for from its start once more. A second stop in
          // a row is shown, so that a file that stops the frame itself is not read again and again.
          if (errorKeyOf(error) === STOPPED && !stopped) {
            stopped = true
            after = 0
            continue
          }
          setWaveform({ state: 'failed', message: displayError(error) })
          return
        }
        if (!current) return
        stopped = false
        if (!answer.supported) {
          setWaveform({ state: 'unsupported' })
          return
        }
        after = answer.version
        setWaveform({ state: answer.done ? 'ready' : 'drawing', bars: answer.bars, seconds: answer.seconds })
        if (answer.done) return
      }
    })()
    return () => {
      current = false
      stopListening()
      preview.release()
    }
  }, [path, url, sizeBytes, modifiedAt, saves])
  return waveform
}

/**
 * Draws the waveform on the canvas: the bars read so far, then a flat line in the middle for the rest. What has
 * been played is brighter. A canvas takes no CSS, so the colors are read from the theme's tokens on the canvas at
 * each draw.
 */
function drawWaveform(canvas: HTMLCanvasElement, bars: Float32Array, progress: number): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const dpr = window.devicePixelRatio || 1
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  if (width === 0 || height === 0) return
  canvas.width = Math.round(width * dpr)
  canvas.height = Math.round(height * dpr)
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, width, height)
  const style = getComputedStyle(canvas)
  const unplayed = style.getPropertyValue('--viewer-wave').trim()
  const played = style.getPropertyValue('--color-holo-cyan').trim()
  const mid = height / 2
  const step = width / BARS
  const bar = Math.max(1, step * 0.7)
  const playedUntil = width * progress
  for (let i = 0; i < bars.length; i++) {
    const x = i * step
    const h = Math.max(1, bars[i] * (height - 4))
    ctx.fillStyle = x < playedUntil ? played : unplayed
    ctx.fillRect(x, mid - h / 2, bar, h)
  }
  const restFrom = bars.length * step
  if (restFrom >= width) return
  ctx.fillStyle = unplayed
  ctx.fillRect(restFrom, mid - 1, width - restFrom, 2)
  if (playedUntil > restFrom) {
    ctx.fillStyle = played
    ctx.fillRect(restFrom, mid - 1, playedUntil - restFrom, 2)
  }
}

export const AudioViewer: Viewer = ({ item, mode, size }) => {
  const t = useT()
  const ref = useRef<HTMLAudioElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const state = useMediaState(ref)
  const waveform = useWaveform(item)
  const [error, setError] = useState<string | null>(null)
  const progress = state.duration > 0 ? state.current / state.duration : 0
  const bars = waveform.state === 'drawing' || waveform.state === 'ready' ? waveform.bars : NO_BARS

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const draw = (): void => drawWaveform(canvas, bars, progress)
    draw()
    const resize = new ResizeObserver(draw)
    resize.observe(canvas)
    const theme = new MutationObserver(draw)
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => {
      resize.disconnect()
      theme.disconnect()
    }
  }, [bars, progress])

  if (!item.url || error) {
    return (
      <Frame mode={mode} size={size}>
        <p className="fv-note" data-tone="error">
          {error ?? t('files.viewer.audioFailed')}
        </p>
      </Frame>
    )
  }
  const reason =
    waveform.state === 'unsupported'
      ? t('files.viewer.waveformUnsupported')
      : waveform.state === 'failed'
        ? t('files.viewer.waveformFailed', { message: waveform.message })
        : null
  return (
    <Frame mode={mode} size={size} className="fv-media">
      <audio ref={ref} src={item.url} preload="metadata" onError={() => setError(t('files.viewer.audioUnplayable'))} />
      <canvas
        ref={canvasRef}
        className="fv-media-wave"
        role="img"
        aria-label={t('files.viewer.waveform')}
        data-state={waveform.state}
        data-bars={bars.length}
        data-seconds={waveform.state === 'drawing' || waveform.state === 'ready' ? waveform.seconds : undefined}
        onClick={(event) => {
          const el = ref.current
          if (!el || !state.duration) return
          const rect = event.currentTarget.getBoundingClientRect()
          const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
          el.currentTime = ratio * state.duration
        }}
      />
      <MediaControls media={ref} state={state} />
      <p className="fv-note" data-tone={waveform.state === 'failed' ? 'error' : undefined}>
        {!state.ready ? t('files.viewer.loading') : reason ? `${formatTime(state.duration)} · ${reason}` : formatTime(state.duration)}
      </p>
    </Frame>
  )
}
