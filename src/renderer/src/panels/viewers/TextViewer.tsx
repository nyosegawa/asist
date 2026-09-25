import { Frame } from './Frame'
import type { Viewer } from './types'
import { useT } from '@/i18n'

/** Inside a card only the first 60 lines are drawn, while the focus view shows all of them. */
const CARD_LINES = 60

export const TextViewer: Viewer = ({ item, mode, size }) => {
  const t = useT()
  const lines = (item.text ?? '').split('\n')
  const shown = mode === 'card' ? lines.slice(0, CARD_LINES) : lines
  const rest = lines.length - shown.length
  return (
    <Frame mode={mode} size={size}>
      <pre className="fv-mono">{shown.join('\n')}</pre>
      {(rest > 0 || item.truncated) && (
        <p className="fv-note">
          {rest > 0 ? t('files.viewer.moreLines', { count: rest }) : ''}
          {item.truncated ? t('files.viewer.truncated') : ''}
        </p>
      )}
    </Frame>
  )
}
