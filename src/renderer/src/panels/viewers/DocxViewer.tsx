import mammoth from 'mammoth/mammoth.browser.js'
import { Frame } from './Frame'
import type { Viewer } from './types'
import { useParsedBytes } from './use-parsed-bytes'
import { useT } from '@/i18n'

/**
 * Word (docx) drawn as a document. mammoth turns it into HTML, and only the allowed elements and attributes
 * reach .fv-doc. mammoth's output carries the meaning of the document (headings, paragraphs, lists, tables,
 * emphasis, images) and brings no colors or spacing with it. Images arrive as data URLs. Links open in the
 * browser, as in the markdown viewer.
 */

/** The elements that are kept. Any other element is unwrapped and its content kept, while a dropped tag goes with its content. */
const ALLOWED_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'strong',
  'em',
  'b',
  'i',
  'u',
  's',
  'del',
  'sup',
  'sub',
  'br',
  'a',
  'img',
  'blockquote',
  'pre',
  'code'
])
const DROPPED_TAGS = new Set(['script', 'style', 'template', 'iframe', 'object', 'embed'])

/** The attributes kept per element. The value is checked as well: href must be http(s) and src a data:image. */
const ALLOWED_ATTRS: Record<string, Record<string, (value: string) => boolean>> = {
  a: { href: (value) => /^https?:\/\//i.test(value) },
  img: { src: (value) => /^data:image\//i.test(value), alt: () => true },
  td: { colspan: (value) => /^\d+$/.test(value), rowspan: (value) => /^\d+$/.test(value) },
  th: { colspan: (value) => /^\d+$/.test(value), rowspan: (value) => /^\d+$/.test(value) }
}

function sanitizeNode(node: Node, out: Node, doc: Document): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      out.appendChild(doc.createTextNode(child.textContent ?? ''))
      continue
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue
    const element = child as Element
    const tag = element.tagName.toLowerCase()
    if (DROPPED_TAGS.has(tag)) continue
    if (!ALLOWED_TAGS.has(tag)) {
      sanitizeNode(element, out, doc)
      continue
    }
    const clean = doc.createElement(tag)
    const allowed = ALLOWED_ATTRS[tag]
    if (allowed) {
      for (const [name, accept] of Object.entries(allowed)) {
        const value = element.getAttribute(name)
        if (value !== null && accept(value)) clean.setAttribute(name, value)
      }
    }
    sanitizeNode(element, clean, doc)
    out.appendChild(clean)
  }
}

export function sanitizeDocxHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const out = doc.createElement('div')
  sanitizeNode(doc.body, out, doc)
  return out.innerHTML
}

async function parseDocx(bytes: ArrayBuffer): Promise<string> {
  const result = await mammoth.convertToHtml({ arrayBuffer: bytes })
  return sanitizeDocxHtml(result.value)
}

export const DocxViewer: Viewer = ({ item, mode, size }) => {
  const t = useT()
  const parsed = useParsedBytes(item, parseDocx)
  return (
    <Frame mode={mode} size={size}>
      {parsed.status === 'loading' && <p className="fv-note">{t('files.viewer.loading')}</p>}
      {parsed.status === 'error' && (
        <p className="fv-note" data-tone="error">
          {t('files.viewer.docxFailed', { message: parsed.message })}
        </p>
      )}
      {parsed.status === 'ready' && (
        <div
          className="fv-doc"
          onClick={(event) => {
            const anchor = (event.target as HTMLElement).closest('a')
            if (!anchor) return
            event.preventDefault()
            const href = anchor.getAttribute('href')
            if (href) void window.api.openExternal(href)
          }}
          dangerouslySetInnerHTML={{ __html: parsed.value }}
        />
      )}
    </Frame>
  )
}
