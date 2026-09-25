import { Pause, Play, Volume2, VolumeX } from 'lucide-react'
import { useEffect, useState, type RefObject } from 'react'
import { formatTime } from './media'
import { useT } from '@/i18n'

/**
 * The playback controls the video and audio viewers share. They are drawn here rather than left to the
 * browser's own controls, and the state is read from the media element's events. Nothing plays by itself, so
 * that a file with sound never starts on its own.
 */

export interface MediaState {
  /** The duration in seconds, 0 until the metadata arrives. */
  duration: number
  current: number
  playing: boolean
  muted: boolean
  /** Whether loadedmetadata has arrived. */
  ready: boolean
}

const INITIAL: MediaState = { duration: 0, current: 0, playing: false, muted: false, ready: false }

export function useMediaState(ref: RefObject<HTMLMediaElement | null>): MediaState {
  const [state, setState] = useState<MediaState>(INITIAL)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const read = (): void =>
      setState({
        duration: Number.isFinite(el.duration) ? el.duration : 0,
        current: el.currentTime,
        playing: !el.paused && !el.ended,
        muted: el.muted,
        ready: el.readyState >= 1 || Number.isFinite(el.duration)
      })
    const events = ['loadedmetadata', 'durationchange', 'timeupdate', 'play', 'pause', 'ended', 'volumechange', 'seeked']
    for (const name of events) el.addEventListener(name, read)
    read()
    return () => {
      for (const name of events) el.removeEventListener(name, read)
    }
  }, [ref])
  return state
}

export function MediaControls({ media, state }: { media: RefObject<HTMLMediaElement | null>; state: MediaState }): React.JSX.Element {
  const t = useT()
  const toggle = (): void => {
    const el = media.current
    if (!el) return
    if (el.paused) void el.play()
    else el.pause()
  }
  return (
    <div className="fv-media-controls">
      <button
        type="button"
        className="fv-media-button"
        onClick={toggle}
        aria-label={state.playing ? t('files.viewer.pause') : t('files.viewer.play')}
        disabled={!state.ready}
      >
        {state.playing ? <Pause size={14} /> : <Play size={14} />}
      </button>
      <span className="fv-media-time">{formatTime(state.current)}</span>
      <input
        type="range"
        className="fv-media-seek"
        aria-label={t('files.viewer.seek')}
        min={0}
        max={state.duration || 0}
        step={0.01}
        value={Math.min(state.current, state.duration || 0)}
        disabled={!state.ready}
        onChange={(event) => {
          const el = media.current
          if (el) el.currentTime = Number(event.currentTarget.value)
        }}
        style={{ '--fv-media-progress': `${state.duration ? (state.current / state.duration) * 100 : 0}%` } as React.CSSProperties}
      />
      <span className="fv-media-time">{formatTime(state.duration)}</span>
      <button
        type="button"
        className="fv-media-button"
        onClick={() => {
          const el = media.current
          if (el) el.muted = !el.muted
        }}
        aria-label={state.muted ? t('files.viewer.unmute') : t('files.viewer.mute')}
        aria-pressed={state.muted}
      >
        {state.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
      </button>
    </div>
  )
}
