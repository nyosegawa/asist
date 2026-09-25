import { isHtmlPage, type FileItem, type FileKind } from '@shared/files'
import { CodeViewer } from './CodeViewer'
import { DataViewer } from './DataViewer'
import { ArchiveViewer } from './ArchiveViewer'
import { AudioViewer } from './AudioViewer'
import { DirectoryViewer } from './DirectoryViewer'
import { DocxViewer } from './DocxViewer'
import { HtmlViewer } from './HtmlViewer'
import { PptxViewer } from './PptxViewer'
import { XlsxViewer } from './XlsxViewer'
import { ImageViewer } from './ImageViewer'
import { MarkdownViewer } from './MarkdownViewer'
import { PdfViewer } from './PdfViewer'
import { NotebookViewer } from './NotebookViewer'
import { StubViewer } from './StubViewer'
import { TableViewer } from './TableViewer'
import { TextViewer } from './TextViewer'
import { VideoViewer } from './VideoViewer'
import type { Viewer, ViewerProps } from './types'
import './viewers.css'

/** A kind with no entry here, such as binary, and an item that could not be read both fall back to StubViewer. */
const VIEWERS: Partial<Record<FileKind, Viewer>> = {
  markdown: MarkdownViewer,
  text: TextViewer,
  table: TableViewer,
  image: ImageViewer,
  pdf: PdfViewer,
  directory: DirectoryViewer,
  code: CodeViewer,
  data: DataViewer,
  notebook: NotebookViewer,
  video: VideoViewer,
  audio: AudioViewer,
  archive: ArchiveViewer,
  docx: DocxViewer,
  xlsx: XlsxViewer,
  pptx: PptxViewer
}

export function viewerFor(item: FileItem): Viewer {
  if (item.error) return StubViewer
  if (item.kind === 'code' && isHtmlPage(item.path)) return HtmlViewer
  return VIEWERS[item.kind] ?? StubViewer
}

export function FileViewer(props: ViewerProps): React.JSX.Element {
  const Component = viewerFor(props.item)
  return <Component {...props} />
}

export type { Viewer, ViewerProps } from './types'
