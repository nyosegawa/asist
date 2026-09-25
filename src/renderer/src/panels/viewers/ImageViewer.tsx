import { useState } from 'react'
import { Frame } from './Frame'
import type { Viewer } from './types'
import { useT } from '@/i18n'

/** The image is drawn from its URL, which is asist-file:// in the app and a static path in the demo. */
export const ImageViewer: Viewer = ({ item, mode, size }) => {
  const t = useT()
  const [failed, setFailed] = useState(false)
  if (!item.url || failed) {
    return (
      <Frame mode={mode} size={size}>
        <p className="fv-note" data-tone="error">
          {t('files.viewer.imageFailed')}
        </p>
      </Frame>
    )
  }
  return (
    <Frame mode={mode} size={size}>
      <img className="fv-image" src={item.url} alt={item.name} onError={() => setFailed(true)} />
    </Frame>
  )
}
