import mammoth from 'mammoth/mammoth.browser.js'
import { isExternalLink } from '@shared/external-link'
import { Frame } from './Frame'
import type { Viewer } from './types'
import { useParsedBytes } from './use-parsed-bytes'
import { useT } from '@/i18n'
import { openLink } from '@/open-link'
import { useToastStore } from '@/state/stores'

/**
 * Word (docx) drawn as a document. mammoth turns it into HTML, and only the allowed elements and attributes
 * reach .fv-doc. mammoth's output carries the meaning of the document (headings, paragraphs, lists, tables,
 * emphasis, images) and brings no colors or spacing with it. Images arrive as data URLs. A link to a web page
 * or a mail address opens outside the app, and a link to a place in the document, such as an entry of its
 * table of contents or a footnote, scrolls to that place.
 */

/**
 * mammoth writes the bookmarks and notes of the document as ids with this prefix, which keeps them apart
 * from the ids and the global names of the app's own page the document is drawn into.
 */
const ID_PREFIX = 'docx-'

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

/**
 * The attributes kept per element. The value is checked as well: href must be a link the app opens or a
 * place in the document, an id one of the document's own, and src a data:image.
 */
const ALLOWED_ATTRS: Record<string, Record<string, (value: string) => boolean>> = {
  a: { href: (value) => isExternalLink(value) || value.startsWith(`#${ID_PREFIX}`), id: (value) => value.startsWith(ID_PREFIX) },
  li: { id: (value) => value.startsWith(ID_PREFIX) },
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
    // A link the viewer cannot follow, such as javascript:, keeps its text but is not drawn as a link.
    if (tag === 'a' && !clean.hasAttributes()) {
      sanitizeNode(element, out, doc)
      continue
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

/**
 * The nearest box around the element that scrolls its content, below the page. The frame scrolls in a card,
 * while in the focus view the frame shows the whole document and the view around it scrolls.
 */
function scrollerOf(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node
  }
  return null
}

async function parseDocx(bytes: ArrayBuffer): Promise<string> {
  const result = await mammoth.convertToHtml({ arrayBuffer: bytes }, { idPrefix: ID_PREFIX })
  return sanitizeDocxHtml(result.value)
}

export const DocxViewer: Viewer = ({ item, mode, size }) => {
  const t = useT()
  const toast = useToastStore((s) => s.push)
  const parsed = useParsedBytes(item, parseDocx)
  const follow = (container: HTMLElement, href: string): void => {
    if (!href.startsWith('#')) return openLink(href)
    const target = container.querySelector<HTMLElement>(`#${CSS.escape(href.slice(1))}`)
    if (!target) {
      toast({ kind: 'error', title: t('files.viewer.anchorMissing') })
      return
    }
    // scrollIntoView would also scroll the boxes further out, even those that hide their overflow, so only
    // the nearest one that scrolls moves. With none, nothing around the document can scroll.
    const scroller = scrollerOf(target)
    if (scroller) scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  }
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
            const anchor = (event.target as HTMLElement).closest('a[href]')
            if (!anchor) return
            event.preventDefault()
            follow(event.currentTarget, anchor.getAttribute('href')!)
          }}
          dangerouslySetInnerHTML={{ __html: parsed.value }}
        />
      )}
    </Frame>
  )
}
