import type { FileItem } from '@shared/files'
import type { CardSurfaceSize } from '../shell/card'

/**
 * A viewer draws one FileItem, either inside a card or in the focus view. Interpreting the content (markdown,
 * csv, pdf, docx and so on) is the viewer's own work, because main passes nothing but the bytes and the kind.
 * - card: fits the height the shell gave. Long content shows only its start and leaves the rest to focus.
 * - focus: shows everything, because the focus overlay is what scrolls.
 * The look follows the vocabulary of viewers.css: headings, tables and code in .fv-doc, framed by .fv-frame.
 */
export interface ViewerProps {
  item: FileItem
  mode: 'card' | 'focus'
  size: CardSurfaceSize
}

export type Viewer = React.FC<ViewerProps>
