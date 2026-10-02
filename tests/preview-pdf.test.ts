import { readFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { errorKey } from '@shared/i18n/error-key'
import openPdf, { openPdfWithin } from '@/preview/methods/pdf'
// @ts-expect-error The generator is plain JavaScript without type declarations.
import { writePdf } from '../scripts/cdp/viewer-files/pdf-writer.mjs'

/**
 * The PDF of the preview page, opened by pdf.js and drawn with @napi-rs/canvas, pdf.js's own canvas in Node. The
 * file is served as asist-file answers a Range request, counting the requests and the bytes it sends, so that a test
 * sees how much of the file a view reads. pdf.js's legacy build stands in for the one the page loads: the same parser
 * and renderer, with the polyfills Node 22 needs, since the other calls Map.prototype.getOrInsertComputed, which
 * Node 22 lacks. Its worker runs in this thread on a MessageChannel, with the same watch on its console that the
 * page's worker script (preview/pdf-worker.ts) has.
 */

vi.mock('pdfjs-dist', () => import('pdfjs-dist/legacy/build/pdf.mjs'))
vi.mock('@/preview/pdf-worker.ts?worker', async () => {
  const { WorkerMessageHandler } = await import('pdfjs-dist/legacy/build/pdf.worker.mjs')
  const { PICTURE_LEFT_OUT, watchLeftOutPictures } = await import('@/preview/pdf-worker-messages')
  return {
    default: class {
      constructor() {
        const { port1, port2 } = new MessageChannel()
        watchLeftOutPictures(console, () => port2.postMessage(PICTURE_LEFT_OUT))
        WorkerMessageHandler.initializeFromPort(port2)
        port1.start()
        port2.start()
        return port1
      }
    }
  }
})
// pdf.js's decoders of JBIG2 and CCITT fax pictures and of JPEG 2000 pictures, standing in a folder of the tests that
// notes in globalThis.pdfDecodersLoaded which of them were loaded.
vi.mock('pdfjs-dist/wasm/jbig2_nowasm_fallback.js?url', () => ({ default: new URL('./fixtures/pdf-decoders/jbig2_nowasm_fallback.js', import.meta.url).href }))
vi.mock('pdfjs-dist/wasm/openjpeg_nowasm_fallback.js?url', () => ({ default: new URL('./fixtures/pdf-decoders/openjpeg_nowasm_fallback.js', import.meta.url).href }))

const FILE_URL = 'asist-file:///Users/me/manual.pdf'
const MB = 1024 * 1024

const served = { requests: 0, bytes: 0, opened: 0 }
/** The status each range is answered with from now on, in place of its bytes. */
let failWith: number | null = null

function serve(file: Uint8Array): void {
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    if (failWith !== null) return new Response(null, { status: failWith })
    const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('range') ?? '')
    const start = range ? Number(range[1]) : 0
    const end = range ? Math.min(Number(range[2]), file.length - 1) : file.length - 1
    served.requests += 1
    if (start === 0) served.opened += 1
    if (!range || start > end) {
      served.bytes += file.length
      return new Response(file.slice(), { status: 200 })
    }
    const body = file.slice(start, end + 1)
    served.bytes += body.length
    return new Response(body, { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${file.length}` } })
  })
}

/** A bitmap as the page would get it, with the canvas's pixels copied, since the canvas is given up once it is made. */
interface Bitmap {
  width: number
  height: number
  /** The red, green and blue of a pixel. */
  pixel(x: number, y: number): number[]
  close(): void
}

beforeAll(() => {
  vi.stubGlobal('createImageBitmap', async (canvas: HTMLCanvasElement): Promise<Bitmap> => {
    const { width, height } = canvas
    const { data } = canvas.getContext('2d')!.getImageData(0, 0, width, height)
    return { width, height, pixel: (x, y) => [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 3)], close: () => undefined }
  })
})

const documents: Array<{ close?(): void }> = []
afterEach(() => {
  for (const document of documents.splice(0)) document.close?.()
  Object.assign(served, { requests: 0, bytes: 0, opened: 0 })
  failWith = null
  vi.restoreAllMocks()
})

async function open(file: Uint8Array, opener = openPdf) {
  serve(file)
  const document = await opener(FILE_URL)
  documents.push(document)
  const { methods } = document
  return {
    ...methods,
    /** Draws a page into a bitmap; a drawing released before it was done gives null. */
    drawn: async (args: { id: number; number: number; scale: number }) => {
      const drawn = await methods.draw(args)
      return drawn && { bitmap: drawn.bitmap as unknown as Bitmap, pictureLeftOut: drawn.pictureLeftOut }
    }
  }
}

/** The prototype of pdf.js's pages, which the tests watch for what the preview page asks of a page. */
async function pageProto(): Promise<{ cleanup(): boolean; render(params: unknown): { cancel(): void } }> {
  const pdfjs = await import('pdfjs-dist')
  const task = pdfjs.getDocument({ data: writePdf({ pages: 1, textBytes: 100 }) })
  const proto = Object.getPrototypeOf(await (await task.promise).getPage(1))
  await task.destroy()
  return proto
}

/** A manual of 1,000 pages, a photo on every fifth, with a balanced page tree as Chrome prints one: 38 MB. */
const manual: Uint8Array = writePdf({ pages: 1000, textBytes: 8000, pictureEvery: 5, picture: { width: 224, height: 224 } })

describe('a PDF in the preview page', () => {
  it('reads less than a megabyte of a 1,000-page PDF to open it and draw page 1 in a card', async () => {
    expect(manual.length).toBeGreaterThan(30 * MB)
    const pdf = await open(manual)
    expect(pdf.summary()).toEqual({ pageCount: 1000, title: undefined, firstPage: { width: 595, height: 842 } })
    const drawn = await pdf.drawn({ id: 1, number: 1, scale: 0.6 })
    expect(drawn?.bitmap).toMatchObject({ width: Math.round(595 * 0.6), height: Math.round(842 * 0.6) })
    // The photo is drawn, and with it everything page 1 needs was read.
    expect(drawn?.bitmap.pixel(178, 171)).not.toEqual([255, 255, 255])
    expect(drawn?.pictureLeftOut).toBe(false)
    // Nor does it read on while the card shows the page.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(served.bytes).toBeLessThan(1 * MB)
  })

  it('opens a PDF whose page tree holds every page under one node in a few reads, rather than one read for each page', async () => {
    const flat: Uint8Array = writePdf({ pages: 1000, textBytes: 8000, fanOut: 1000, pictureEvery: 5, picture: { width: 224, height: 224 } })
    const pdf = await open(flat)
    await pdf.drawn({ id: 1, number: 1, scale: 0.6 })
    expect(pdf.summary().pageCount).toBe(1000)
    expect(served.requests).toBeLessThan(30)
  })

  it('reads a page far into the document without reading the pages before it', async () => {
    const pdf = await open(manual)
    await pdf.drawn({ id: 1, number: 1, scale: 0.6 })
    const opened = served.bytes
    await pdf.drawn({ id: 2, number: 700, scale: 1 })
    expect(served.bytes - opened).toBeLessThan(0.5 * MB)
  })

  it('draws a page without decoding a picture of more than 100 megapixels on it, and says the picture was left out', async () => {
    // A black mask of 10,001 x 10,000 pixels, 12 MB decoded and 400 MB once drawn, but 12 KB in the file.
    const width = 10_001
    const height = 10_000
    const mask = { entries: '/ImageMask true /BitsPerComponent 1 /Filter /FlateDecode', bytes: deflateSync(new Uint8Array(Math.ceil(width / 8) * height)) }
    const pdf = await open(writePdf({ pages: 2, textBytes: 0, pictureEvery: 2, picture: { width, height, stream: mask } }))
    const drawn = await pdf.drawn({ id: 1, number: 1, scale: 1 })
    expect(drawn?.bitmap).toMatchObject({ width: 595, height: 842 })
    // The middle of where the mask would cover is left as white paper.
    expect(drawn?.bitmap.pixel(297, 285)).toEqual([255, 255, 255])
    expect(drawn?.pictureLeftOut).toBe(true)
    // Drawn again at another size from what pdf.js kept of the page, it is still said to lack the picture.
    expect((await pdf.drawn({ id: 2, number: 1, scale: 0.5 }))?.pictureLeftOut).toBe(true)
    expect((await pdf.drawn({ id: 3, number: 2, scale: 1 }))?.pictureLeftOut).toBe(false)
  })

  it('gives no bitmap for a drawing released before it is done', async () => {
    const pdf = await open(manual)
    const drawing = pdf.drawn({ id: 1, number: 2, scale: 1 })
    pdf.release(1)
    expect(await drawing).toBeNull()
  })

  it('stops a drawing released while pdf.js draws it', async () => {
    const proto = await pageProto()
    const render = proto.render
    const pdf = await open(manual)
    const cancelled = vi.fn()
    vi.spyOn(proto, 'render').mockImplementationOnce(function (this: unknown, params: unknown) {
      const task = render.call(this, params)
      const cancel = task.cancel.bind(task)
      task.cancel = () => {
        cancelled()
        cancel()
      }
      // Released once the drawing holds the task, as a release from the viewer arrives, while pdf.js still draws.
      queueMicrotask(() => pdf.release(1))
      return task
    })
    expect(await pdf.drawn({ id: 1, number: 2, scale: 1 })).toBeNull()
    expect(cancelled).toHaveBeenCalledTimes(1)
  })

  it('lets a page release what pdf.js decoded for it once no drawing of it is held', async () => {
    const proto = await pageProto()
    const cleanup = vi.spyOn(proto, 'cleanup')
    const pdf = await open(manual)
    await pdf.drawn({ id: 1, number: 6, scale: 0.5 })
    await pdf.drawn({ id: 2, number: 6, scale: 1 })
    pdf.release(1)
    expect(cleanup).not.toHaveBeenCalled()
    pdf.release(2)
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('fails the drawing whose range cannot be read, and opens the file again for the next one', async () => {
    const pdf = await open(manual)
    failWith = 500
    await expect(pdf.drawn({ id: 1, number: 500, scale: 1 })).rejects.toThrow(errorKey('files.errors.loadFailed', { status: 500 }))
    failWith = null
    const drawn = await pdf.drawn({ id: 2, number: 500, scale: 1 })
    expect(drawn?.bitmap).toMatchObject({ width: 595, height: 842 })
    expect(await pdf.size(501)).toEqual({ width: 595, height: 842 })
    expect(served.opened).toBe(2)
  })

  it('fails a drawing when the file was written again since it was opened, and reads it as it is now for the next one', async () => {
    const pdf = await open(manual)
    serve(writePdf({ pages: 600, textBytes: 8000, pictureEvery: 5, picture: { width: 224, height: 224 } }))
    await expect(pdf.drawn({ id: 1, number: 500, scale: 1 })).rejects.toThrow(errorKey('files.errors.changedWhileReading'))
    expect(await pdf.drawn({ id: 2, number: 500, scale: 1 })).not.toBeNull()
    expect(pdf.summary().pageCount).toBe(600)
  })

  it('opens the file again once it has read a lot since it opened, and draws on', async () => {
    const pdf = await open(manual, openPdfWithin({ reopenAfterBytes: 1 * MB, holdLimitBytes: 64 * MB }))
    for (const [id, number] of [1, 101, 201, 301, 401, 501].entries()) await pdf.drawn({ id, number, scale: 0.5 })
    expect(served.opened).toBe(1)
    // Six photos of 150 KB each and the ranges around them are past a megabyte.
    expect((await pdf.drawn({ id: 9, number: 601, scale: 0.5 }))?.bitmap.pixel(149, 143)).not.toEqual([255, 255, 255])
    expect(served.opened).toBe(2)
  })

  it('says a PDF is too large to draw here when pdf.js would read more of it at once than one opening may hold', async () => {
    // Ten bytes after the header put every object away from where the cross-reference table says, and pdf.js reads
    // the whole file to find them.
    const good: Uint8Array = writePdf({ pages: 30, textBytes: 8000, pictureEvery: 2, picture: { width: 224, height: 224 } })
    const headerEnd = good.indexOf(10, 10) + 1
    const broken = new Uint8Array(good.length + 10)
    broken.set(good.subarray(0, headerEnd))
    broken.set(new TextEncoder().encode('%shifted!\n'), headerEnd)
    broken.set(good.subarray(headerEnd), headerEnd + 10)
    await expect(open(broken, openPdfWithin({ reopenAfterBytes: 1 * MB, holdLimitBytes: 1 * MB }))).rejects.toThrow(
      errorKey('files.errors.pdfTooMuchToRead', { size: '1 MB' })
    )
    const pdf = await open(broken, openPdfWithin({ reopenAfterBytes: 4 * MB, holdLimitBytes: 8 * MB }))
    expect(pdf.summary().pageCount).toBe(30)
  })

  it('draws a scanned page in CCITT fax, JBIG2 or JPEG 2000, loading the decoder a picture needs only when a page first holds one', async () => {
    const loaded = (): string[] => (globalThis as { pdfDecodersLoaded?: string[] }).pdfDecodersLoaded ?? []
    const scan = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./fixtures/pdf-scans/${name}.pdf`, import.meta.url)))
    /** A page of tests/fixtures/pdf-scans at 72 dpi: its box of ink, and the paper beside it. */
    const drawScan = async (name: string): Promise<{ ink: number[]; paper: number[] }> => {
      const pdf = await open(scan(name))
      const drawn = await pdf.drawn({ id: 1, number: 1, scale: 1 })
      expect(drawn?.bitmap).toMatchObject({ width: 400, height: 560 })
      return { ink: drawn!.bitmap.pixel(120, 80), paper: drawn!.bitmap.pixel(300, 80) }
    }

    const report = await open(writePdf({ pages: 1, textBytes: 1000, pictureEvery: 1 }))
    await report.drawn({ id: 1, number: 1, scale: 1 })
    expect(loaded()).toEqual([])

    expect(await drawScan('ccitt')).toEqual({ ink: [0, 0, 0], paper: [255, 255, 255] })
    expect(loaded()).toEqual(['jbig2'])
    expect(await drawScan('jbig2')).toEqual({ ink: [0, 0, 0], paper: [255, 255, 255] })
    expect(loaded()).toEqual(['jbig2'])

    const jpx = await drawScan('jpx')
    expect(loaded()).toEqual(['jbig2', 'openjpeg'])
    // The red of the box and white paper, as near as a lossy coding keeps them.
    expect(jpx.ink.map((value, i) => Math.abs(value - [220, 30, 30][i]) <= 12)).toEqual([true, true, true])
    expect(jpx.paper.every((value) => value >= 245)).toBe(true)
  })
})
