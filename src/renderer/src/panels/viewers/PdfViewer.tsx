import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type openPdf from '@/preview/methods/pdf'
import type { DrawnPage, PageSize, PdfSummary } from '@/preview/methods/pdf'
import { Frame, FRAME_MAX_HEIGHT } from './Frame'
import { openPreviewDocument, type PreviewFile } from './preview-client'
import type { Viewer, ViewerProps } from './types'
import { useNear } from './use-near'
import './PdfViewer.css'
import { displayError } from '@/display-error'
import { errorKeyOf } from '@shared/i18n/error-key'
import { useT } from '@/i18n'
import type { Translate } from '@shared/i18n'

/**
 * A PDF, opened in the preview page (preview/methods/pdf.ts), where pdf.js reads it by ranges and draws each page
 * into a bitmap that a canvas here shows. This part decides only which page is drawn at which size.
 * - card: page 1 alone, fitted into the Frame's height.
 * - focus: every page stacked vertically, each laid out at page 1's size until its own is known. Only a page within
 *   a screen of the view has a canvas; one that leaves gives up its bitmap and lets the preview page release
 *   what it decoded for it, so that paging through a long document holds a few pages at a time.
 * The canvas shows devicePixelRatio times the pixels, and its CSS size is the size in pt times the scale.
 * There is no text layer, so nothing in a page can be selected or copied.
 */

/** The inner padding of .fv-pdf, the same value as in the CSS. */
const PAD = 10
/** The height of one note line, 12px of text plus a 10px gap. A card subtracts it when it sizes page 1. */
const NOTE_HEIGHT = 22

export interface PageBox {
  width: number
  height: number
  /** The factor applied to pt, which does not include devicePixelRatio. */
  scale: number
}

/** Spreads a page over the full width, as the focus view does with every page. */
export function fitToWidth(page: PageSize, frameWidth: number): PageBox {
  const scale = frameWidth / page.width
  return { width: frameWidth, height: page.height * scale, scale }
}

/** Fits a page into both the width and the height, as a card does with page 1. */
export function fitToHeight(page: PageSize, frameWidth: number, maxHeight: number): PageBox {
  const scale = Math.min(frameWidth / page.width, maxHeight / page.height)
  return { width: page.width * scale, height: page.height * scale, scale }
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

/** Ids for the drawings of every PDF viewer, which a card and the focus view of one file ask of the same document. */
let nextDrawing = 0

/** A page being drawn into a bitmap: null when it was released before it was done. */
interface PageDrawing {
  drawn: Promise<DrawnPage | null>
  release(): void
}

/** The viewer's side of a PDF open in the preview page. */
interface PdfPages {
  summary(): Promise<PdfSummary>
  size(number: number): Promise<PageSize>
  draw(number: number, scale: number): PageDrawing
  close(): void
}

/** Whether an error says the preview frame stopped, after which the client starts a new one for the next request. */
const frameStopped = (error: unknown): boolean => errorKeyOf(error) === 'files.errors.previewStopped'

/**
 * Opens the file in the preview page.
 * - A request whose frame stopped, as when another viewer's file took the frame out of memory, is made once more in
 *   a new frame, and a second stop in a row is shown.
 * - When the file changes under the document, `onChanged` is called and the viewer starts over from the summary;
 *   what the requests made before then end with is never shown.
 * - Closing tells the document of every drawing still held before it lets go of it: the card of the same file can
 *   keep the document open after the focus view closes, and React runs the viewer's own cleanup before its pages',
 *   whose releases then ask nothing of the document. A drawing is told of only where the document is open
 *   (PreviewHandle.tell), since a frame that stopped took its drawings with it.
 */
function openPdfPages(file: PreviewFile, onChanged: () => void): PdfPages {
  const doc = openPreviewDocument<typeof openPdf>('pdf', file)
  const held = new Set<number>()
  let changed = false
  const stopListening = doc.onChanged(() => {
    changed = true
    onChanged()
  })
  const ask = <T,>(request: () => Promise<T>): Promise<T> =>
    request()
      .catch((error: unknown) => (frameStopped(error) ? request() : Promise.reject(error)))
      .catch((error: unknown) => (changed ? new Promise<T>(() => undefined) : Promise.reject(error)))
  const release = (id: number): void => {
    if (held.delete(id)) doc.tell('release', id)
  }
  return {
    summary: () => ask(() => doc.call('summary', undefined)),
    size: (number) => ask(() => doc.call('size', number)),
    draw(number, scale) {
      const id = nextDrawing++
      held.add(id)
      return { drawn: ask(() => doc.call('draw', { id, number, scale })), release: () => release(id) }
    },
    close() {
      for (const id of [...held]) release(id)
      stopListening()
      doc.release()
    }
  }
}

type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; pages: PdfPages; summary: PdfSummary }

export const PdfViewer: Viewer = ({ item, mode, size }) => {
  const t = useT()
  const [state, setState] = useState<State>({ status: 'loading' })
  /** How many times the file changed under the viewer, which opens it again each time. */
  const [changes, setChanges] = useState(0)
  const [width, setWidth] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const { url, sizeBytes, modifiedAt } = item

  useEffect(() => {
    if (!url) return
    const pages = openPdfPages({ url, sizeBytes, modifiedAt }, () => setChanges((count) => count + 1))
    let cancelled = false
    setState({ status: 'loading' })
    pages.summary().then(
      (summary) => {
        if (!cancelled) setState({ status: 'ready', pages, summary })
      },
      (error: unknown) => {
        if (!cancelled) setState({ status: 'error', message: displayError(error) })
      }
    )
    return () => {
      cancelled = true
      pages.close()
    }
  }, [url, sizeBytes, modifiedAt, changes])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => setWidth(Math.max(0, el.clientWidth - PAD * 2))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const shown: State = url ? state : { status: 'error', message: t('files.viewer.pdfFailed') }
  const note = shown.status === 'ready' ? noteText(shown.summary, mode, t) : ''
  return (
    <Frame mode={mode} size={size}>
      <div className="fv-pdf" ref={ref} data-mode={mode}>
        {shown.status === 'loading' && <p className="fv-note">{t('files.viewer.loading')}</p>}
        {shown.status === 'error' && (
          <p className="fv-note" data-tone="error">
            {shown.message}
          </p>
        )}
        {shown.status === 'ready' && note && <p className="fv-note">{note}</p>}
        {shown.status === 'ready' &&
          width > 0 &&
          (mode === 'card' ? (
            <CardPage pages={shown.pages} box={fitToHeight(shown.summary.firstPage, width, cardPageHeight(size, note !== ''))} />
          ) : (
            Array.from({ length: shown.summary.pageCount }, (_, i) => (
              <FocusPage key={i + 1} pages={shown.pages} number={i + 1} pageCount={shown.summary.pageCount} firstPage={shown.summary.firstPage} width={width} />
            ))
          ))}
      </div>
    </Frame>
  )
}

function PageFailed({ number, message }: { number: number; message: string }): React.JSX.Element {
  const t = useT()
  return (
    <p className="fv-note" data-tone="error">
      {t('files.viewer.pdfPageFailed', { number, message })}
    </p>
  )
}

/** The note under a page that pdf.js drew without a picture larger than it decodes. */
function PictureLeftOut(): React.JSX.Element {
  const t = useT()
  return <p className="fv-note">{t('files.viewer.pdfPictureLeftOut')}</p>
}

function CardPage({ pages, box }: { pages: PdfPages; box: PageBox }): React.JSX.Element {
  const [failed, setFailed] = useState<string | null>(null)
  const [leftOut, setLeftOut] = useState(false)
  return (
    <div className="fv-pdf-page" data-page={1}>
      {failed ? <PageFailed number={1} message={failed} /> : <PageCanvas pages={pages} number={1} box={box} onFailed={setFailed} onLeftOut={setLeftOut} />}
      {leftOut && <PictureLeftOut />}
    </div>
  )
}

function FocusPage({ pages, number, pageCount, firstPage, width }: { pages: PdfPages; number: number; pageCount: number; firstPage: PageSize; width: number }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const near = useNear(ref)
  const [size, setSize] = useState<PageSize | null>(number === 1 ? firstPage : null)
  const [failed, setFailed] = useState<string | null>(null)
  const [leftOut, setLeftOut] = useState(false)

  useEffect(() => {
    if (!near || size) return
    let current = true
    pages.size(number).then(
      (known) => {
        if (current) setSize(known)
      },
      (error: unknown) => {
        if (current) setFailed(displayError(error))
      }
    )
    return () => {
      current = false
    }
  }, [pages, number, near, size])

  const box = fitToWidth(size ?? firstPage, width)
  let content: React.JSX.Element
  if (failed) content = <PageFailed number={number} message={failed} />
  else if (near && size) content = <PageCanvas pages={pages} number={number} box={box} onFailed={setFailed} onLeftOut={setLeftOut} />
  else content = <div className="fv-pdf-blank" style={{ width: `${box.width}px`, height: `${box.height}px` }} />
  return (
    <div className="fv-pdf-page" ref={ref} data-page={number}>
      {content}
      {leftOut && <PictureLeftOut />}
      <span className="fv-pdf-num">
        {number} / {pageCount}
      </span>
    </div>
  )
}

/**
 * A page's canvas, blank until its bitmap arrives. The bitmap moves into the canvas without a copy, and the canvas
 * gives it up when it goes or is drawn again at another size, rather than when it is collected.
 */
function PageCanvas({
  pages,
  number,
  box,
  onFailed,
  onLeftOut
}: {
  pages: PdfPages
  number: number
  box: PageBox
  onFailed: (message: string) => void
  onLeftOut: (leftOut: boolean) => void
}): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  const scale = box.scale * (window.devicePixelRatio || 1)

  useEffect(() => {
    const canvas = ref.current!
    const drawing = pages.draw(number, scale)
    let current = true
    drawing.drawn.then(
      (drawn) => {
        if (!current || !drawn) {
          drawn?.bitmap.close()
          return
        }
        const { bitmap } = drawn
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        canvas.getContext('bitmaprenderer')!.transferFromImageBitmap(bitmap)
        onLeftOut(drawn.pictureLeftOut)
      },
      (error: unknown) => {
        if (current) onFailed(displayError(error))
      }
    )
    return () => {
      current = false
      drawing.release()
      canvas.getContext('bitmaprenderer')?.transferFromImageBitmap(null)
    }
  }, [pages, number, scale, onFailed, onLeftOut])

  return <canvas ref={ref} style={{ width: `${box.width}px`, height: `${box.height}px` }} />
}
