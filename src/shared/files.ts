import { baseName } from './file-path'

/**
 * The types behind the files card (show_files). The main process only validates the path and reads the
 * file; interpreting and drawing the content is the renderer's viewer. A text kind travels as the body
 * inside the props, and a binary kind travels as a URL, which is asist-file:// in the app and a static
 * path in the demo.
 */

export type FileKind =
  | 'markdown'
  | 'text'
  | 'table'
  | 'data'
  | 'code'
  | 'image'
  | 'pdf'
  | 'docx'
  | 'pptx'
  | 'xlsx'
  | 'video'
  | 'audio'
  | 'notebook'
  | 'archive'
  | 'directory'
  | 'binary'

const KIND_BY_EXT: Record<string, FileKind> = {
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'text',
  '.log': 'text',
  '.csv': 'table',
  '.tsv': 'table',
  '.json': 'data',
  '.jsonl': 'data',
  '.yaml': 'data',
  '.yml': 'data',
  '.toml': 'data',
  '.ini': 'data',
  '.env': 'data',
  '.xml': 'data',
  '.plist': 'data',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.svg': 'image',
  '.heic': 'image',
  '.avif': 'image',
  '.bmp': 'image',
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.pptx': 'pptx',
  '.xlsx': 'xlsx',
  '.xlsm': 'xlsx',
  '.mp4': 'video',
  '.mov': 'video',
  '.m4v': 'video',
  '.webm': 'video',
  '.mp3': 'audio',
  '.m4a': 'audio',
  '.wav': 'audio',
  '.aac': 'audio',
  '.flac': 'audio',
  '.ogg': 'audio',
  '.ipynb': 'notebook',
  '.zip': 'archive'
}

const CODE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.rb', '.sh', '.zsh', '.bash', '.sql', '.css', '.scss',
  '.html', '.htm', '.c', '.cpp', '.cc', '.h', '.hpp', '.java', '.kt', '.swift', '.m', '.php', '.lua', '.r', '.dart', '.vue', '.svelte',
  '.makefile', '.dockerfile', '.gradle', '.proto', '.graphql', '.tf'
])

export function classifyFile(filePath: string): FileKind {
  const name = baseName(filePath).toLowerCase()
  if (name === 'dockerfile' || name === 'makefile') return 'code'
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot) : ''
  if (KIND_BY_EXT[ext]) return KIND_BY_EXT[ext]
  if (CODE_EXT.has(ext)) return 'code'
  return 'binary'
}

/** The kinds whose body travels in the props as a string. */
export const TEXT_KINDS: ReadonlySet<FileKind> = new Set(['markdown', 'text', 'table', 'data', 'code', 'notebook'])

/** The kinds the viewer fetches by URL instead. */
const URL_KINDS: ReadonlySet<FileKind> = new Set(['image', 'pdf', 'docx', 'pptx', 'xlsx', 'video', 'audio', 'archive'])

const PAGE_EXT = new Set(['.html', '.htm'])

/**
 * Whether the file is an HTML page, which the viewer renders as a page and can also show as source. It
 * stays a code file in every other respect, so it carries its text like any code file and a URL besides,
 * which the rendered page is loaded from so that the files next to it resolve.
 */
export function isHtmlPage(filePath: string): boolean {
  const name = baseName(filePath).toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot >= 0 && PAGE_EXT.has(name.slice(dot))
}

/** Whether an item of this kind and path carries a URL. */
export function carriesUrl(kind: FileKind, filePath: string): boolean {
  return URL_KINDS.has(kind) || (kind === 'code' && isHtmlPage(filePath))
}

/**
 * The limit on text carried in the props. Above it only the beginning is carried and `truncated` is
 * set, which the viewer shows as an invitation to open the file.
 */
export const MAX_TEXT_BYTES = 512 * 1024

const MB = 1024 * 1024

/**
 * The largest file, by its size on disk, that each viewer reads whole into the page and parses there. A larger one
 * is not read: the viewer says it is too large to show here, above the card's button that shows it in Finder or File
 * Explorer. Audio still plays, since <audio> reads it by ranges, and only its waveform, which decodes the whole file,
 * is left out. The kinds not listed travel as text up to MAX_TEXT_BYTES, or are loaded by the page's own image,
 * media and frame elements.
 *
 * Each limit is about where the costliest likely file of its kind took a second or so to show and grew the page by
 * less than a gigabyte, so that a machine two or three times slower still shows it within a few seconds. Measured
 * on 2026-10-02 in the demo under headless Chrome on an Apple M5 with 32 GB, opening generated files in a card and in
 * the focus view, the slower of the two given:
 * - xlsx: sales records, 9.3 MB in 1.2 s and 37 MB in 4.9 s; a grid of small numbers, 5.8 MB in 1.1 s and 11.6 MB
 *   in 2.0 s. The whole time holds the page's thread.
 * - docx: prose, 2.7 MB in 0.9 s and 5.5 MB in 1.8 s, growing the page by 1.1 GB, almost all of it holding the thread.
 *   A paragraph repeated over and over costs four times as much for its size; photos cost 0.03 s per MB.
 * - pptx: a photo on every slide, 36 MB in 0.9 s and 69 MB in 1.8 s, holding the thread at most 0.1 s.
 * - pdf: scanned pages, 281 MB in 0.7 s growing the page by 0.6 GB, and 1.1 GB in 1.7 s by 2.3 GB.
 * - zip: 129,000 small files in 43 MB, 0.7 s with 0.6 s held; data that does not compress, 256 MB in 0.8 s by 0.5 GB.
 * - audio: speech at 32 kbps mono decoded in 0.7 s for 4.6 MB (20 minutes) and grew the page by 0.66 GB; 18 MB
 *   (80 minutes) grew it by 2.6 GB. At 128 kbps stereo, 9.2 MB grew it by 0.68 GB.
 */
export const WHOLE_READ_LIMIT: Partial<Record<FileKind, number>> = {
  xlsx: 8 * MB,
  docx: 4 * MB,
  pptx: 32 * MB,
  pdf: 256 * MB,
  archive: 64 * MB,
  audio: 4 * MB
}

/** Whether the item's file is larger than its viewer reads whole (WHOLE_READ_LIMIT). */
export function tooLargeToRead(item: Pick<FileItem, 'kind' | 'sizeBytes'>): boolean {
  const limit = WHOLE_READ_LIMIT[item.kind]
  return limit !== undefined && item.sizeBytes > limit
}

export interface FileEntry {
  name: string
  path: string
  kind: FileKind
  sizeBytes: number
}

export interface FileItem {
  path: string
  name: string
  kind: FileKind
  sizeBytes: number
  modifiedAt?: number
  /** Why the file could not be read. When it is present, none of the other fields are. */
  error?: string
  /** The body of a text kind, up to MAX_TEXT_BYTES. */
  text?: string
  truncated?: boolean
  /** The URL a binary kind is fetched from. */
  url?: string
  /** The contents of a directory, folders first and by name, without hidden files; only the first of a large one. */
  entries?: FileEntry[]
  /** How many entries the directory holds, which is more than `entries` carries when its list was cut short. */
  entryCount?: number
}

/** The props of show_files: `paths` is the input and `items` is what the main process read. */
export interface FilesProps {
  title?: string
  paths: string[]
  items?: FileItem[]
  /** The item selected in the card. The focus overlay shares this selection. */
  selected?: number
}

/** Formats a size like "2.3MB", "48KB" or "120B". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`
  return `${bytes}B`
}

/** The shape of the card: a single file gets the viewer, images alone get a grid, and anything else gets a list. */
export type FilesLayout = 'single' | 'gallery' | 'list'

export function filesLayout(items: readonly FileItem[]): FilesLayout {
  if (items.length === 1) return 'single'
  const shown = items.filter((item) => !item.error)
  if (shown.length >= 2 && shown.every((item) => item.kind === 'image')) return 'gallery'
  return 'list'
}

