import {
  getDocument,
  PDFDataRangeTransport,
  PDFWorker,
  RenderingCancelledException,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask
} from 'pdfjs-dist'
import jbig2DecoderUrl from 'pdfjs-dist/wasm/jbig2_nowasm_fallback.js?url'
import openJpegDecoderUrl from 'pdfjs-dist/wasm/openjpeg_nowasm_fallback.js?url'
import { errorKey } from '@shared/i18n/error-key'
import { isWorkerFailed, PICTURE_LEFT_OUT } from '../pdf-worker-messages'
import PdfJsWorker from '../pdf-worker.ts?worker'
import { fetchRange, readRange, type Bytes } from '../ranges'
import type { OpenPreviewDocument } from '../serve'

/**
 * A PDF in the preview page. pdf.js reads the file in ranges as it needs them and reads nothing ahead of its own, so
 * a card reads the file's cross-reference table, its page tree down to page 1 and to the last page, which pdf.js
 * checks, and what page 1 draws, and the focus view reads the pages near what it shows. Each page is drawn into a
 * bitmap the viewer shows; pdf.js keeps the page's decoded pictures and its operator list until the viewer releases
 * the drawing.
 *
 * pdf.js keeps every byte it has read until the document closes, and a read that fails leaves it waiting, so the
 * document opens the file again for the next request after a read failed, or once it has read a lot since it
 * opened. The viewer keeps the pages it was shown.
 *
 * pdf.js needs nothing beyond the page's policy: its worker and its decoders are the page's own scripts, the ranges
 * reach it from the page, and an embedded font is loaded from its bytes.
 */

/** The length of each range pdf.js asks for, which is also its own unit of what it has read. */
const RANGE_BYTES = 64 * 1024

/**
 * Requests of pdf.js's that come one after another, each within this distance of the last, are pdf.js walking the
 * file one object at a time: through a page tree that holds every page under one node, as LibreOffice 26.2 writes it
 * (a 216-page document exported on 2026-10-03), pdf.js reads every page's dictionary from the last to the first, one
 * range at a time, to check the page count (306 ranges for 1,000 pages in a test), and it reads the pages a view
 * draws in turn as they come.
 */
const NEARBY_BYTES = 1024 * 1024

/**
 * The most one read takes in for such a walk. Each read takes twice as much as the one before, in the direction the
 * walk goes, and pdf.js is handed from it only what it asks for, so that it keeps no more than before.
 */
const READ_AHEAD_BYTES = 4 * 1024 * 1024

/** The reads kept to answer pdf.js from, at most this many times READ_AHEAD_BYTES. */
const KEPT_READS = 3

/** How much of the file a document may hold in the frame. */
export interface ReadLimits {
  /** What a document may read beyond what opening the file took before the next request opens it again. */
  reopenAfterBytes: number
  /**
   * The most one opening of the file may hold. pdf.js reads a file whose cross-reference table is broken whole, to
   * rebuild it, and a larger one would take the frame's memory.
   */
  holdLimitBytes: number
}

const READ_LIMITS: ReadLimits = { reopenAfterBytes: 256 * 1024 * 1024, holdLimitBytes: 512 * 1024 * 1024 }

/**
 * The most pixels a picture may have for pdf.js to decode it. pdf.js reads a larger one's bytes with the rest of its
 * object, but draws the page without decoding it, and the viewer says so on the page. Decoded, a picture of 100
 * megapixels takes 400 MB, while a scan of an A3 page at 600 dpi has 70 megapixels.
 */
const MAX_PICTURE_PIXELS = 100_000_000

/**
 * The folder pdf.js's worker imports its decoders of JBIG2 and CCITT fax pictures and of JPEG 2000 pictures from,
 * the first time a page holds such a picture. pdf.js asks for each by a name of its own in one folder, so the
 * renderer's build keeps those names. They are the JavaScript builds pdfjs-dist ships beside its WebAssembly,
 * which the page's policy does not let it compile (useWasm: false).
 */
const DECODERS = ((): string => {
  const decoders = { 'jbig2_nowasm_fallback.js': jbig2DecoderUrl, 'openjpeg_nowasm_fallback.js': openJpegDecoderUrl }
  const urls = Object.entries(decoders).map(([name, url]) => ({ name, url: new URL(url, import.meta.url).href }))
  const folder = urls[0].url.slice(0, urls[0].url.lastIndexOf('/') + 1)
  const astray = urls.filter(({ name, url }) => url !== `${folder}${name}`)
  if (astray.length > 0) throw new Error(`pdf.js's decoders are not in one folder by their names: ${astray.map(({ url }) => url).join(', ')}`)
  return folder
})()

/** The size of a page in pt, turned as the page is shown. */
export interface PageSize {
  width: number
  height: number
}

export interface PdfSummary {
  pageCount: number
  /** The Title from the PDF's metadata, undefined when there is none. */
  title?: string
  /** Page 1's size, which the viewer gives the pages whose own size it does not know yet. */
  firstPage: PageSize
}

/** A page drawn into a bitmap, and whether pdf.js left a picture out of it for its size. */
export interface DrawnPage {
  bitmap: ImageBitmap
  pictureLeftOut: boolean
}

/**
 * pdf.js's factory of canvases, which its types leave as Object: a canvas of the page in a browser, and one of
 * @napi-rs/canvas in Node, where the tests draw.
 */
interface CanvasFactory {
  create(width: number, height: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D }
  destroy(made: { canvas: HTMLCanvasElement | null }): void
}

const megabytes = (bytes: number): string => `${Math.round(bytes / 1024 / 1024)} MB`

/**
 * pdf.js's source of the file's bytes. It asks for each range it lacks and waits for it without a way to hear that
 * the range failed, so a failure goes to `fail`, which ends every request of the opening that waits.
 */
class FileRanges extends PDFDataRangeTransport {
  /** What pdf.js has been given, all of which it keeps. */
  held = 0
  readonly #url: string
  readonly #holdLimit: number
  readonly #reading = new AbortController()
  readonly #fail: (error: unknown) => void
  #last: { begin: number; end: number } | null = null
  #span = RANGE_BYTES
  /**
   * The last reads, done or still running, by the part of the file each holds. pdf.js asks for several ranges at
   * once as well as one after another, so a request waits for a read that holds it rather than start its own.
   */
  #reads: Array<{ start: number; stop: number; bytes: Promise<Bytes> }> = []

  constructor(url: string, size: number, start: Bytes, holdLimit: number, fail: (error: unknown) => void) {
    super(size, start)
    this.held = start.length
    this.#url = url
    this.#holdLimit = holdLimit
    this.#fail = fail
  }

  override requestDataRange(begin: number, end: number): void {
    if (this.held + (end - begin) > this.#holdLimit) {
      this.#fail(new Error(errorKey('files.errors.pdfTooMuchToRead', { size: megabytes(this.#holdLimit) })))
      return
    }
    this.held += end - begin
    const read = this.#reads.find((one) => one.start <= begin && end <= one.stop) ?? this.#read(begin, end)
    this.#last = { begin, end }
    read.bytes.then((bytes) => this.onDataRange(begin, bytes.slice(begin - read.start, end - read.start)), this.#fail)
  }

  /** Reads the range, and past it in the direction pdf.js has been walking the file, if it has. */
  #read(begin: number, end: number): { start: number; stop: number; bytes: Promise<Bytes> } {
    const last = this.#last
    const forward = last !== null && begin >= last.end && begin - last.end <= NEARBY_BYTES
    const backward = last !== null && end <= last.begin && last.begin - end <= NEARBY_BYTES
    this.#span = forward || backward ? Math.min(this.#span * 2, READ_AHEAD_BYTES) : RANGE_BYTES
    const span = Math.max(this.#span, end - begin)
    const start = backward ? Math.max(0, Math.floor((end - span) / RANGE_BYTES) * RANGE_BYTES) : begin
    const stop = forward ? Math.min(this.length, start + span) : end
    const read = { start, stop, bytes: readRange(this.#url, start, stop, this.length, this.#reading.signal) }
    read.bytes.catch(() => undefined)
    this.#reads = [read, ...this.#reads].slice(0, KEPT_READS)
    return read
  }

  override abort(): void {
    this.#reading.abort()
  }
}

/** One opening of the file by pdf.js. */
interface Opening {
  task: PDFDocumentLoadingTask
  doc: PDFDocumentProxy
  ranges: FileRanges
  summary: PdfSummary
  /** A request of pdf.js's, ended by a read that failed rather than left waiting for it. */
  settled<T>(request: Promise<T>): Promise<T>
  /** Ends the requests waiting on the opening. */
  fail(error: unknown): void
  /** A read failed: the next request opens the file again. */
  broken: boolean
  /** What opening the file took, past which what it reads counts towards reopenAfterBytes. */
  heldWhenOpened: number
  /** The pages pdf.js left a picture out of, which it says only once, while it reads the page's content. */
  pictureLeftOut: Set<number>
  /** The requests using it, after which an opening that was replaced is closed. */
  users: number
  replaced: boolean
}

/** What fails when pdf.js's worker could not start: every opening that waits on it. */
const failWhenWorkerFails = new Set<(error: unknown) => void>()

/** The page being drawn, whose picture a warning of pdf.js's worker is about. */
let drawingNow: { opening: Opening; number: number } | null = null

let worker: PDFWorker | null = null

/**
 * pdf.js's worker, one for every document of the frame, which goes with the frame. A drawing is matched to a warning
 * of the worker only because the frame draws one page at a time (inTurn).
 */
function sharedWorker(): PDFWorker {
  if (worker) return worker
  const port = new PdfJsWorker()
  port.addEventListener('message', ({ data }: MessageEvent) => {
    if (data === PICTURE_LEFT_OUT && drawingNow) drawingNow.opening.pictureLeftOut.add(drawingNow.number)
    else if (isWorkerFailed(data)) for (const fail of failWhenWorkerFails) fail(new Error(data.message))
  })
  worker = PDFWorker.create({ port })
  return worker
}

let turn: Promise<unknown> = Promise.resolve()

/** Runs work once the frame's drawings before it are done. */
function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const result = turn.then(work)
  turn = result.catch(() => undefined)
  return result
}

const sizeOf = (page: PDFPageProxy): PageSize => {
  const { width, height } = page.getViewport({ scale: 1 })
  return { width, height }
}

async function openFile(url: string, limits: ReadLimits): Promise<Opening> {
  // The first range holds the file's header and tells its length; pdf.js reads the rest as it needs it.
  const first = await fetchRange(url, `bytes=0-${RANGE_BYTES - 1}`)
  // asist-file answers a range with no byte of the file only for an empty file.
  if (!first) throw new Error(errorKey('files.viewer.pdfFailed'))
  let reject!: (error: unknown) => void
  const failed = new Promise<never>((_, rejectWith) => (reject = rejectWith))
  failed.catch(() => undefined)
  const opening = { broken: false, pictureLeftOut: new Set<number>(), users: 0, replaced: false } as Opening
  opening.fail = (error) => {
    opening.broken = true
    reject(error)
  }
  opening.ranges = new FileRanges(url, first.size, first.bytes, limits.holdLimitBytes, opening.fail)
  opening.settled = (request) => Promise.race([request, failed])
  failWhenWorkerFails.add(opening.fail)
  opening.task = getDocument({
    range: opening.ranges,
    rangeChunkSize: RANGE_BYTES,
    disableAutoFetch: true,
    disableStream: true,
    worker: sharedWorker(),
    maxImageSize: MAX_PICTURE_PIXELS,
    wasmUrl: DECODERS,
    useWasm: false,
    // pdf.js hands a JPEG to the browser's ImageDecoder by default, and the pictures it decoded stayed in the
    // frame's compositor cache after their pages were released: 266 MB in the frame's process after paging through
    // 120 screens of a 200-page report with a photo on every other page, and none with pdf.js's own decoder (Chrome
    // 154, 2026-10-02). That one runs in pdf.js's worker as well, and drew a page with a photo of 1,600 x 1,200
    // about 0.2 s later (the built preview page in Electron 43.7.7 on an M5, 2026-10-02).
    isImageDecoderSupported: false
  })
  try {
    opening.doc = await opening.settled(opening.task.promise)
    const { info } = await opening.settled(opening.doc.getMetadata())
    const rawTitle = (info as { Title?: unknown }).Title
    opening.summary = {
      pageCount: opening.doc.numPages,
      title: typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim() : undefined,
      firstPage: sizeOf(await opening.settled(opening.doc.getPage(1)))
    }
    opening.heldWhenOpened = opening.ranges.held
    return opening
  } catch (error) {
    // The worker holds what pdf.js read for a document until its task is destroyed, and a document that fails to
    // open, such as a broken one or one asking for a password, never reaches the viewer that would close it.
    close(opening)
    throw error
  }
}

function close(opening: Opening): void {
  failWhenWorkerFails.delete(opening.fail)
  void opening.task.destroy()
}

/** A drawing the viewer holds, by the id it gave it. */
interface Drawing {
  number: number
  page?: PDFPageProxy
  task?: RenderTask
  released: boolean
}

/** Opens PDFs that hold no more of the file than the limits allow; the tests give smaller ones. */
export const openPdfWithin = (limits: ReadLimits) => async (url: string) => {
  let current = await openFile(url, limits)
  let reopening: Promise<Opening> | null = null
  let closed = false
  const drawings = new Map<number, Drawing>()

  function done(opening: Opening): void {
    opening.users -= 1
    if (opening.replaced && opening.users === 0) close(opening)
  }

  /** The opening a request uses: the current one, or the file opened again when a read failed or it read a lot. */
  async function use(): Promise<Opening> {
    if (current.broken || current.ranges.held - current.heldWhenOpened > limits.reopenAfterBytes) {
      reopening ??= openFile(url, limits).then(
        (next) => {
          reopening = null
          if (closed) {
            close(next)
            return next
          }
          const previous = current
          current = next
          previous.replaced = true
          if (previous.users === 0) close(previous)
          return next
        },
        (error: unknown) => {
          reopening = null
          throw error
        }
      )
      await reopening
    }
    current.users += 1
    return current
  }

  return {
    methods: {
      summary: (): PdfSummary => current.summary,

      size: async (number: number): Promise<PageSize> => {
        const opening = await use()
        try {
          return sizeOf(await opening.settled(opening.doc.getPage(number)))
        } finally {
          done(opening)
        }
      },

      /**
       * Draws a page at a scale (pt to pixels) into a bitmap, or gives null when the drawing was released before it
       * was done. The id is the viewer's own, unique among the drawings of the document.
       */
      draw: ({ id, number, scale }: { id: number; number: number; scale: number }): Promise<DrawnPage | null> => {
        const drawing: Drawing = { number, released: false }
        drawings.set(id, drawing)
        return inTurn(async () => {
          if (drawing.released) return null
          const opening = await use()
          try {
            const page = await opening.settled(opening.doc.getPage(number))
            drawing.page = page
            if (drawing.released) return null
            const viewport = page.getViewport({ scale })
            const canvases = opening.doc.canvasFactory as CanvasFactory
            const made = canvases.create(Math.max(1, Math.round(viewport.width)), Math.max(1, Math.round(viewport.height)))
            drawingNow = { opening, number }
            try {
              drawing.task = page.render({ canvas: made.canvas, viewport })
              await opening.settled(drawing.task.promise)
              return { bitmap: await createImageBitmap(made.canvas), pictureLeftOut: opening.pictureLeftOut.has(number) }
            } catch (error) {
              if (error instanceof RenderingCancelledException) return null
              throw error
            } finally {
              drawingNow = null
              canvases.destroy(made)
            }
          } finally {
            done(opening)
          }
        })
      },

      /**
       * Lets go of a drawing: one still running stops, and once no drawing holds its page, the page lets go of its
       * decoded pictures and operator list, which it would otherwise keep for as long as the document is open.
       */
      release: (id: number): void => {
        const drawing = drawings.get(id)
        if (!drawing) return
        drawings.delete(id)
        drawing.released = true
        drawing.task?.cancel()
        if (drawing.page && ![...drawings.values()].some((other) => other.page === drawing.page)) drawing.page.cleanup()
      }
    },
    close() {
      closed = true
      close(current)
    }
  }
}

const openPdf = openPdfWithin(READ_LIMITS)

export default openPdf satisfies OpenPreviewDocument
