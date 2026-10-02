import '../set-immediate'
import { errorKey } from '@shared/i18n/error-key'
import { DOCX_ID_PREFIX } from '@/panels/viewers/docx-html'
import type { PreviewDocument } from '../serve'
import { openZip, type RangedZip } from '../zip-ranges'

/**
 * Word (docx) in the preview page. mammoth turns the document into HTML here, on a copy of the zip that holds the
 * parts mammoth reads and every other entry replaced by its own path (zip-ranges' slimmed zip): mammoth meets each
 * picture as a reference, which it writes into the HTML as a data URL of the path, and the viewer asks for the
 * picture once it comes within a screen of the view. A card shows the head, the first blocks of the body; the focus
 * view shows the head first and then the whole document, which it mounts a piece at a time.
 *
 * mammoth reads the zip with the JSZip it bundles, which hands data on 16 KB at a time and waits for a
 * setTimeout(0) between two steps where it finds no setImmediate; Chromium holds such a nested timeout for at
 * least 4 ms. With its photos, a 300-page report with 100 photos (61 MB) takes 8,498 of these steps and 24 s to
 * convert, and 3.2 s with a setImmediate defined (headless Chrome on an M5, 2026-10-02). The page has one
 * (set-immediate.ts), and without its pictures the same report is 1.1 MB of XML, which converts in about 0.1 s.
 */

type Bytes = Uint8Array<ArrayBuffer>

/** The XML parts of a zip, and the relationships between them. */
const XML_PART = /\.(?:xml|rels)$/i

/**
 * The most XML the parts of a document may declare together before the viewer says it is too large to show here
 * rather than read any of it. A 300-page report holds 1.1 MB, so this stops only a file far beyond anything
 * written by hand.
 */
const MAX_XML_BYTES = 128 * 1024 * 1024

/** How many blocks of the body the head holds: paragraphs with something to show, and rows of tables. */
const HEAD_BLOCKS = 40

/** How much HTML a piece of the whole document holds, about what the focus view mounts in one frame. */
const PIECE_CHARS = 48_000

const RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
/** A style map mammoth itself embeds in a document it writes, and reads from one it converts. */
const STYLE_MAP = 'mammoth/style-map'

export interface DocxHead {
  /** mammoth's HTML of the first HEAD_BLOCKS blocks of the body. */
  html: string
  /** Whether the body goes on past them. */
  more: boolean
}

export interface DocxPicture {
  /** The picture, no wider than the width it was asked for. */
  bitmap: ImageBitmap
  /** The picture's own size, which the document gives it unless the column is narrower. */
  width: number
  height: number
}

/** What `make` gives, made once; a failure is not kept, so that the next call tries again. */
function once<T>(make: () => Promise<T>): () => Promise<T> {
  let made: Promise<T> | null = null
  return () =>
    (made ??= make().catch((error: unknown) => {
      made = null
      throw error
    }))
}

/**
 * mammoth, loaded only once set-immediate.ts has run: its JSZip decides how it waits as it loads, and a dynamic
 * import runs after this module's own imports whichever chunk the bundler puts mammoth in.
 */
const loadMammoth = once(async () => (await import('mammoth/mammoth.browser.js')).default)

/** The relationships a .rels part lists, by type and target. */
function relationshipsIn(rels: Bytes | undefined): Array<{ type: string; target: string }> {
  if (!rels) return []
  const parsed = new DOMParser().parseFromString(new TextDecoder().decode(rels), 'application/xml')
  return [...parsed.getElementsByTagName('Relationship')].map((rel) => ({ type: rel.getAttribute('Type') ?? '', target: rel.getAttribute('Target') ?? '' }))
}

const folderOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')))
const relsOf = (path: string): string => `${path.slice(0, path.lastIndexOf('/') + 1)}_rels/${path.slice(path.lastIndexOf('/') + 1)}.rels`

/**
 * The parts mammoth reads, read here first, each inflated by the zip reader to no more than its declared size,
 * since mammoth's JSZip inflates without comparing what it gets with the size the zip declares. They are found
 * as mammoth finds them (its docx-reader.js): the main document through the package's relationships, the styles,
 * numbering, notes and comments through the main document's, each with mammoth's fallback, and the relationships
 * of the parts that hold a body.
 */
async function readParts(zip: RangedZip): Promise<{ contents: Map<string, Bytes>; main: string }> {
  const contents = new Map<string, Bytes>()
  const read = async (path: string): Promise<Bytes | undefined> => {
    if (!zip.entries.has(path)) return undefined
    const bytes = await zip.read(path)
    contents.set(path, bytes)
    return bytes
  }
  const partOf = (rels: Bytes | undefined, name: string, folder: string, fallback: string): string =>
    relationshipsIn(rels)
      .filter(({ type }) => type === RELATIONSHIPS + name)
      .map(({ target }) => (target.startsWith('/') || folder === '' ? target : `${folder}/${target}`).replace(/^\//, ''))
      .find((path) => zip.entries.has(path)) ?? fallback
  const [, packageRels] = await Promise.all([read('[Content_Types].xml'), read('_rels/.rels'), read(STYLE_MAP)])
  const main = partOf(packageRels, 'officeDocument', '', 'word/document.xml')
  const mainRels = await read(relsOf(main))
  const related = (name: string): string => partOf(mainRels, name, folderOf(main), `word/${name}.xml`)
  const bodies = ['footnotes', 'endnotes', 'comments'].map(related)
  await Promise.all([main, related('styles'), related('numbering'), ...bodies, ...bodies.map(relsOf)].map(read))
  return { contents, main }
}

const LT = 0x3c
const GT = 0x3e
const SLASH = 0x2f
const QUESTION = 0x3f
const BANG = 0x21
const DASH = 0x2d
const BRACKET = 0x5b
const QUOTE = 0x22
const APOSTROPHE = 0x27

/** Where `marker` next ends at or after `from`, or -1. */
function endOf(xml: Bytes, from: number, marker: string): number {
  const first = marker.charCodeAt(0)
  for (let at = xml.indexOf(first, from); at !== -1; at = xml.indexOf(first, at + 1)) {
    let i = 1
    while (i < marker.length && xml[at + i] === marker.charCodeAt(i)) i++
    if (i === marker.length) return at + marker.length
  }
  return -1
}

/** Where a start tag that begins at `at` ends, past a `>` inside a quoted attribute value. */
function startTagEnd(xml: Bytes, at: number): number {
  let quote = 0
  for (let i = at + 1; i < xml.length; i++) {
    const byte = xml[i]
    if (quote !== 0) {
      if (byte === quote) quote = 0
    } else if (byte === QUOTE || byte === APOSTROPHE) quote = byte
    else if (byte === GT) return i + 1
  }
  return -1
}

/** The qualified name of the tag that begins at `at`, a `/` of an end tag left out. Names in Office XML are ASCII. */
function nameAt(xml: Bytes, at: number): string {
  let start = at + 1
  if (xml[start] === SLASH) start++
  let end = start
  while (end < xml.length && xml[end] > 0x20 && xml[end] !== SLASH && xml[end] !== GT) end++
  return String.fromCharCode(...xml.subarray(start, end))
}

const localName = (name: string): string => name.slice(name.indexOf(':') + 1)

/**
 * What an element is to the head: the body and the content controls and custom XML that wrap its blocks hold
 * blocks; a paragraph or a table's row is a block; anything else holds none.
 */
type Role = 'document' | 'blocks' | 'control' | 'table' | 'paragraph' | 'row' | 'inside' | 'other'

function roleOf(local: string, parent: Role | undefined): Role {
  switch (parent) {
    case undefined:
      return 'document'
    case 'document':
      return local === 'body' ? 'blocks' : 'other'
    case 'blocks':
      return local === 'p' ? 'paragraph' : local === 'tbl' ? 'table' : local === 'sdt' ? 'control' : local === 'customXml' ? 'blocks' : 'other'
    case 'control':
      return local === 'sdtContent' ? 'blocks' : 'other'
    case 'table':
      return local === 'tr' ? 'row' : 'other'
    case 'paragraph':
    case 'row':
    case 'inside':
      return 'inside'
    default:
      return 'other'
  }
}

/** What makes mammoth write a paragraph; it leaves out one with none of them. */
const SHOWN = new Set(['t', 'tab', 'br', 'cr', 'sym', 'noBreakHyphen', 'drawing', 'pict', 'object'])

/**
 * The main part cut after `blocks` blocks of its body, every element still open closed again, or null when the body
 * has no block past them. It reads the tags of the bytes as they come, up to the first block it leaves out, rather
 * than parsing the whole part. A paragraph counts once it holds something mammoth shows, a table by its rows, and
 * the blocks inside a content control or custom XML count as the body's own. A part it cannot read is left to
 * mammoth whole.
 */
function cutBody(xml: Bytes, blocks: number): Bytes | null {
  const open: Array<{ name: string; role: Role; shown: boolean }> = []
  let counted = 0
  let cut: { at: number; closing: string } | null = null
  /** A block ended at `end`: the cut, once one has been made and another block follows it. */
  const ended = (end: number): Bytes | null => {
    if (cut) {
      const closing = new TextEncoder().encode(cut.closing)
      const bytes = new Uint8Array(cut.at + closing.length)
      bytes.set(xml.subarray(0, cut.at))
      bytes.set(closing, cut.at)
      return bytes
    }
    if (++counted === blocks) cut = { at: end, closing: open.map(({ name }) => `</${name}>`).reverse().join('') }
    return null
  }
  /** An element inside a block begins: what it is may make the paragraph that holds it one mammoth shows. */
  const shows = (local: string): void => {
    if (!SHOWN.has(local)) return
    for (let i = open.length - 1; i >= 0; i--) {
      if (open[i].role === 'paragraph') open[i].shown = true
      if (open[i].role !== 'inside') return
    }
  }
  for (let at = xml.indexOf(LT); at !== -1; ) {
    const next = xml[at + 1]
    let end: number
    if (next === QUESTION || next === BANG) {
      end = endOf(xml, at, next === QUESTION ? '?>' : xml[at + 2] === DASH ? '-->' : xml[at + 2] === BRACKET ? ']]>' : '>')
    } else if (next === SLASH) {
      end = endOf(xml, at, '>')
      const closed = open.pop()
      if (!closed || end === -1) return null
      if (closed.role === 'blocks' && localName(closed.name) === 'body') return null
      const done = closed.role === 'row' || (closed.role === 'paragraph' && closed.shown) ? ended(end) : null
      if (done) return done
    } else {
      end = startTagEnd(xml, at)
      if (end === -1) return null
      const name = nameAt(xml, at)
      const local = localName(name)
      const role = roleOf(local, open.at(-1)?.role)
      if (role === 'inside') shows(local)
      if (xml[end - 2] !== SLASH) open.push({ name, role, shown: false })
      else if (role === 'row') {
        const done = ended(end)
        if (done) return done
      }
    }
    if (end === -1) return null
    at = xml.indexOf(LT, end)
  }
  return null
}

const escapeText = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * A table too large for one piece as tables of rows of about PIECE_CHARS each, every one with the table's own
 * attributes and its header rows, so that the focus view mounts and lays it out a part at a time.
 */
function tableParts(table: Element): string[] {
  const shell = table.cloneNode(false) as Element
  const open = `${shell.outerHTML.slice(0, -'</table>'.length)}${table.querySelector(':scope > thead')?.outerHTML ?? ''}<tbody>`
  const parts: string[] = []
  let rows = ''
  for (const row of table.querySelectorAll(':scope > tbody > tr')) {
    rows += row.outerHTML
    if (rows.length < PIECE_CHARS) continue
    parts.push(`${open}${rows}</tbody></table>`)
    rows = ''
  }
  if (rows !== '') parts.push(`${open}${rows}</tbody></table>`)
  return parts
}

/**
 * mammoth's HTML cut between its top-level elements into pieces of about PIECE_CHARS characters, the first no
 * shorter than the head's HTML (`head`), so that the first piece takes the head's place without leaving out any
 * of what the head showed.
 */
function piecesOf(html: string, head: number): string[] {
  const pieces: string[] = []
  let piece = ''
  const add = (part: string): void => {
    piece += part
    if (piece.length < (pieces.length === 0 ? Math.max(head, PIECE_CHARS) : PIECE_CHARS)) return
    pieces.push(piece)
    piece = ''
  }
  for (const node of new DOMParser().parseFromString(html, 'text/html').body.childNodes) {
    if (!(node instanceof Element)) add(escapeText(node.textContent ?? ''))
    else if (node.localName === 'table' && node.outerHTML.length > PIECE_CHARS) tableParts(node).forEach(add)
    else add(node.outerHTML)
  }
  if (piece !== '') pieces.push(piece)
  return pieces
}

/**
 * Decodes a picture and scales it down to `width` pixels when it is wider, so that the page that draws it holds no
 * more than it shows.
 */
async function picture(zip: RangedZip, { path, width }: { path: string; width: number }): Promise<DocxPicture> {
  const decoded = await createImageBitmap(new Blob([await zip.read(path)]), { imageOrientation: 'from-image' })
  const size = { width: decoded.width, height: decoded.height }
  if (size.width <= width) return { bitmap: decoded, ...size }
  const height = Math.max(1, Math.round((size.height * width) / size.width))
  const bitmap = await createImageBitmap(decoded, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' })
  decoded.close()
  return { bitmap, ...size }
}

/** Opens the Word file at url, refusing one whose XML parts declare more than MAX_XML_BYTES before any part is read. */
export default async function openDocx(url: string) {
  const zip = await openZip(url)
  const xmlBytes = [...zip.entries.values()].reduce((sum, { name, size }) => (XML_PART.test(name) ? sum + size : sum), 0)
  if (xmlBytes > MAX_XML_BYTES) throw new Error(errorKey('files.viewer.tooLarge'))
  const parts = once(() => readParts(zip))
  const convert = async (contents: ReadonlyMap<string, Bytes>): Promise<string> => {
    const mammoth = await loadMammoth()
    const slim = await zip.slimmed((name) => !contents.has(name), contents)
    return (await mammoth.convertToHtml({ arrayBuffer: slim.buffer }, { idPrefix: DOCX_ID_PREFIX })).value
  }
  const head = once(async (): Promise<DocxHead> => {
    const { contents, main } = await parts()
    const xml = contents.get(main)
    const cut = xml && cutBody(xml, HEAD_BLOCKS)
    if (!cut) return { html: await convert(contents), more: false }
    return { html: await convert(new Map(contents).set(main, cut)), more: true }
  })
  const whole = once(async () => piecesOf(await convert((await parts()).contents), (await head()).html.length))
  return {
    methods: {
      head: () => head(),
      /** The whole document as pieces of HTML, in order. */
      whole: () => whole(),
      picture: (args: { path: string; width: number }) => picture(zip, args)
    }
  } satisfies PreviewDocument
}
