import { useRef, useState } from 'react'
import { Frame } from './Frame'
import { formatTime } from './media'
import { MediaControls, useMediaState } from './MediaControls'
import type { Viewer } from './types'
import './MediaViewer.css'
import { useT } from '@/i18n'

/**
 * Video. main answers Range requests, so the position bar can seek. Inside a card the video is fitted with
 * object-fit: contain into the Frame's height less the controls and the note.
 */
export const VideoViewer: Viewer = ({ item, mode, size }) => {
  const t = useT()
  const ref = useRef<HTMLVideoElement>(null)
  const state = useMediaState(ref)
  const [error, setError] = useState<string | null>(null)
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null)
  if (!item.url || error) {
    return (
      <Frame mode={mode} size={size}>
        <p className="fv-note" data-tone="error">
          {error ?? t('files.viewer.videoFailed')}
        </p>
      </Frame>
    )
  }
  return (
    <Frame mode={mode} size={size} className="fv-media">
      <video
        ref={ref}
        className="fv-media-video"
        src={item.url}
        preload="metadata"
        playsInline
        onLoadedMetadata={(event) => setDimensions({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight })}
        onError={() => setError(t('files.viewer.videoUnplayable'))}
      />
      <MediaControls media={ref} state={state} />
      <p className="fv-note">
        {state.ready && dimensions ? `${formatTime(state.duration)} · ${dimensions.width}×${dimensions.height}` : t('files.viewer.loading')}
      </p>
    </Frame>
  )
}
