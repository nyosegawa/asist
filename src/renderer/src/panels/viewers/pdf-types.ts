/**
 * The contract holding only what PdfViewer asks of pdf.js. pdf-loader.ts satisfies it with pdf.js, and a test
 * replaces it without loading pdf.js at all.
 */
export interface PdfPage {
  /** The width and height in pt at scale 1. */
  width: number
  height: number
  /** Draws onto the canvas. scale is the factor applied to pt, devicePixelRatio included. */
  render(canvas: HTMLCanvasElement, scale: number): Promise<void>
}

export interface PdfDocument {
  pageCount: number
  /** The Title from the PDF's metadata, undefined when there is none. */
  title?: string
  page(number: number): Promise<PdfPage>
  destroy(): void
}

export type PdfLoader = (url: string) => Promise<PdfDocument>
