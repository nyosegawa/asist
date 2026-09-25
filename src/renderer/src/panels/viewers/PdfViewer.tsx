import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Frame, FRAME_MAX_HEIGHT } from './Frame'
import type { PdfDocument, PdfLoader, PdfPage } from './pdf-types'
import type { Viewer, ViewerProps } from './types'
import './PdfViewer.css'
import { displayError } from '@/display-error'
import { useT } from '@/i18n'
import type { Translate } from '@shared/i18n'

/**
 * A PDF drawn onto a canvas. Parsing and rendering belong to pdf.js (pdf-loader.ts), and this part decides
 * only which page is drawn at which size.
 * - card: page 1 alone, fitted into the Frame's height.
 * - focus: every page stacked vertically, each one drawn as it comes into view (IntersectionObserver), so
 *   that even a document of 100 pages opens without delay.
 * The canvas holds devicePixelRatio times the pixels, and its CSS size is the size in pt times the scale.
 * There is no text layer, so nothing in a page can be selected or copied.
 */

/** The inner padding of .fv-pdf, the same value as in the CSS. */
const PAD = 10
/** The height of one note line, 12px of text plus a 10px gap. A card subtracts it when it sizes page 1. */
const NOTE_HEIGHT = 22
/** The assumed aspect ratio, portrait A4, of a page whose size is not known yet. It reserves the room for a page the focus view has not reached. */
const PLACEHOLDER_RATIO = 842 / 595

let injectedLoader: PdfLoader | null = null

/** Replaces the way a document is loaded, so that a test does not have to load pdf.js. null restores the real pdf-loader. */
export function setPdfLoader(loader: PdfLoader | null): void {
  injectedLoader = loader
}

async function load(url: string): Promise<PdfDocument> {
  const loader = injectedLoader ?? (await import('./pdf-loader')).loadPdf
  return loader(url)
}

export interface PageBox {
  width: number
  height: number
  /** The factor applied to pt, which does not include devicePixelRatio. */
  scale: number
}

/** Spreads a page over the full width, as the focus view does with every page. */
export function fitToWidth(page: { width: number; height: number }, frameWidth: number): PageBox {
  const scale = frameWidth / page.width
  return { width: frameWidth, height: page.height * scale, scale }
}

/** Fits a page into both the width and the height, as a card does with page 1. */
export function fitToHeight(page: { width: number; height: number }, frameWidth: number, maxHeight: number): PageBox {
  const scale = Math.min(frameWidth / page.width, maxHeight / page.height)
  return { width: page.width * scale, height: page.height * scale, scale }
}

/** A card takes page 1 alone, and the focus view takes every page. */
export function pageRange(pageCount: number, mode: ViewerProps['mode']): number[] {
  if (pageCount <= 0) return []
  if (mode === 'card') return [1]
  return Array.from({ length: pageCount }, (_, i) => i + 1)
}

/** The text of the note. A Title comes first, and the page count appears in a card only when there is more than one page, and always in focus. */
export function noteText(doc: { pageCount: number; title?: string }, mode: ViewerProps['mode'], t: Translate): string {
  const parts: string[] = []
  if (doc.title) parts.push(doc.title)
  if (mode === 'focus' || doc.pageCount > 1) parts.push(t('files.viewer.pdfPages', { count: doc.pageCount }))
  return parts.join(' · ')
}

/** The height page 1 may use in a card: the Frame's limit less the padding and the note. */
export function cardPageHeight(size: ViewerProps['size'], hasNote: boolean): number {
  return FRAME_MAX_HEIGHT[size] - PAD * 2 - (hasNote ? NOTE_HEIGHT : 0)
}

type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; doc: PdfDocument }

export const PdfViewer: Viewer = ({ item, mode, size }) => {
  const t = useT()
  const [state, setState] = useState<State>({ status: 'loading' })
  const [width, setWidth] = useState(0)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!item.url) {
      setState({ status: 'error', message: t('files.viewer.pdfFailed') })
      return
    }
    let cancelled = false
    let doc: PdfDocument | undefined
    setState({ status: 'loading' })
    load(item.url).then(
      (loaded) => {
        if (cancelled) {
          loaded.destroy()
          return
        }
        doc = loaded
        setState({ status: 'ready', doc: loaded })
      },
      (error: unknown) => {
        if (!cancelled) setState({ status: 'error', message: displayError(error) })
      }
    )
    return () => {
      cancelled = true
      doc?.destroy()
    }
  }, [item.url, t])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => setWidth(Math.max(0, el.clientWidth - PAD * 2))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const note = state.status === 'ready' ? noteText(state.doc, mode, t) : ''
  return (
    <Frame mode={mode} size={size}>
      <div className="fv-pdf" ref={ref} data-mode={mode}>
        {state.status === 'loading' && <p className="fv-note">{t('files.viewer.loading')}</p>}
        {state.status === 'error' && (
          <p className="fv-note" data-tone="error">
            {state.message}
          </p>
        )}
        {state.status === 'ready' && note && <p className="fv-note">{note}</p>}
        {state.status === 'ready' &&
          width > 0 &&
          pageRange(state.doc.pageCount, mode).map((number) => (
            <Page
              key={number}
              doc={state.doc}
              number={number}
              width={width}
              maxHeight={mode === 'card' ? cardPageHeight(size, note !== '') : undefined}
              lazy={mode === 'focus'}
            />
          ))}
      </div>
    </Frame>
  )
}

function Page({ doc, number, width, maxHeight, lazy }: { doc: PdfDocument; number: number; width: number; maxHeight?: number; lazy: boolean }): React.JSX.Element {
  const t = useT()
  const [visible, setVisible] = useState(!lazy)
  const [page, setPage] = useState<PdfPage | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // A render starts only once the previous one has finished, because pdf.js throws when two renders overlap
  // on the same canvas.
  const queue = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    if (!lazy) return
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '400px 0px' }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [lazy])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    doc.page(number).then(
      (loaded) => {
        if (!cancelled) setPage(loaded)
      },
      (error: unknown) => {
        if (!cancelled) setFailed(displayError(error))
      }
    )
    return () => {
      cancelled = true
    }
  }, [doc, number, visible])

  const box = page ? (maxHeight === undefined ? fitToWidth(page, width) : fitToHeight(page, width, maxHeight)) : null
  const boxWidth = box?.width ?? 0
  const boxHeight = box?.height ?? 0
  const boxScale = box?.scale ?? 0

  useEffect(() => {
    const canvas = canvasRef.current
    if (!page || !canvas || boxWidth <= 0) return
    const dpr = window.devicePixelRatio || 1
    queue.current = queue.current.then(async () => {
      canvas.width = Math.round(boxWidth * dpr)
      canvas.height = Math.round(boxHeight * dpr)
      await page.render(canvas, boxScale * dpr)
    })
    queue.current = queue.current.catch((error: unknown) => setFailed(displayError(error)))
  }, [page, boxWidth, boxHeight, boxScale])

  const placeholderHeight = maxHeight ?? Math.round(width * PLACEHOLDER_RATIO)
  return (
    <div className="fv-pdf-page" ref={ref} data-page={number} data-rendered={page ? 'true' : undefined}>
      {failed ? (
        <p className="fv-note" data-tone="error">
          {t('files.viewer.pdfPageFailed', { number, message: failed })}
        </p>
      ) : (
        <canvas ref={canvasRef} style={box ? { width: `${boxWidth}px`, height: `${boxHeight}px` } : { width: `${width}px`, height: `${placeholderHeight}px` }} />
      )}
      {lazy && (
        <span className="fv-pdf-num">
          {number} / {doc.pageCount}
        </span>
      )}
    </div>
  )
}
