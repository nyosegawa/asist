import { formatBytes } from '@shared/files'
import { Frame } from './Frame'
import type { Viewer } from './types'
import { useT } from '@/i18n'

/**
 * The placard for a kind whose content cannot be drawn yet, such as an executable, and for an item that could
 * not be read. It gives the name, the kind and the size, and leaves opening the file to the card's Finder
 * action.
 */
export const StubViewer: Viewer = ({ item, mode, size }) => {
  const t = useT()
  return (
    <Frame mode={mode} size={size}>
      <div className="fv-stub">
        <span>{item.error ?? t('files.viewer.stub', { kind: t(`files.kind.${item.kind}`) })}</span>
        <small>
          {item.path}
          {item.sizeBytes > 0 && ` · ${formatBytes(item.sizeBytes)}`}
        </small>
      </div>
    </Frame>
  )
}
