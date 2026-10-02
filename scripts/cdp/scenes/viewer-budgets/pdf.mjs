/**
 * The PDF viewer's cases: two reports Chrome printed, whose page trees are balanced, and a PDF of 1,000 pages written
 * with one node holding every page, as LibreOffice writes it (viewer-files/pdf-writer.mjs).
 *
 * Every page in view has to be drawn, and drawn right. The viewer gives a canvas only to the pages within a screen of
 * the view, and the rest are blank boxes of their size, so a screen can show a drawn page beside one still blank,
 * which the default check takes for shown because it finds a drawn canvas somewhere in view. Every generated page
 * carries its number as a mark (PAGE_MARK of viewer-files/pdf-writer.mjs, repeated in the check, which runs in the
 * page with nothing from outside its body), so the check reads the number back from each canvas in view, and takes
 * the canvas for drawn when the number is its page's and the canvas holds devicePixelRatio times the pixels of its
 * size on the screen.
 */
function everyPageInViewDrawn(root) {
  const SQUARES = 12
  const SQUARE_MM = 5
  const LEFT_MM = 132
  const TOP_MM = 18
  const A4_MM = [210, 297]
  const frame = root.querySelector('.fv-frame')
  if (!frame || window.__budgetRefusal(root)) return false
  const clips = [root, frame.querySelector('.fv-scroll') ?? frame].map((el) => el.getBoundingClientRect())
  const top = Math.max(0, ...clips.map((clip) => clip.top))
  const bottom = Math.min(innerHeight, ...clips.map((clip) => clip.bottom))
  const pages = [...frame.querySelectorAll('.fv-pdf-page')].filter((page) => {
    const box = page.getBoundingClientRect()
    return Math.min(box.bottom, bottom) - Math.max(box.top, top) >= 1
  })
  if (pages.length === 0) return false
  const sample = (window.__pdfMarkSample ??= new OffscreenCanvas(SQUARES, 1).getContext('2d', { willReadFrequently: true }))
  return pages.every((page) => {
    const canvas = page.querySelector('canvas')
    if (!canvas || Math.abs(canvas.width - parseFloat(canvas.style.width) * devicePixelRatio) > 2) return false
    sample.clearRect(0, 0, SQUARES, 1)
    // The middle of each square, a quarter of the square in from each side.
    const width = ((SQUARE_MM / 2) * canvas.width) / A4_MM[0]
    const height = ((SQUARE_MM / 2) * canvas.height) / A4_MM[1]
    const y = ((TOP_MM + SQUARE_MM / 4) * canvas.height) / A4_MM[1]
    for (let i = 0; i < SQUARES; i++) sample.drawImage(canvas, ((LEFT_MM + (i + 0.25) * SQUARE_MM) * canvas.width) / A4_MM[0], y, width, height, i, 0, 1, 1)
    const data = sample.getImageData(0, 0, SQUARES, 1).data
    const dark = (i) => data[i * 4 + 3] === 255 && data[i * 4] < 96 && data[i * 4 + 1] < 96 && data[i * 4 + 2] < 96
    if (!dark(0)) return false
    let number = 0
    for (let i = 1; i < SQUARES; i++) number = number * 2 + (dark(i) ? 1 : 0)
    return number === Number(page.dataset.page)
  })
}

const budget = {
  cardFirstMs: 1500,
  cardHeldMs: 150,
  cardPeakMb: 350,
  focusFirstMs: 1000,
  focusHeldMs: 150,
  slowestScreenMs: 400,
  peakMb: 800,
  finalMb: 500,
  gpuPeakMb: 300
}

export const cases = [
  { name: 'pdf-200', file: 'pdf-200', shown: everyPageInViewDrawn, budget },
  { name: 'pdf-1000', file: 'pdf-1000', shown: everyPageInViewDrawn, budget },
  // The card reads most of this file, in 18 reads, to check the page count through the page tree; on 2026-10-03 its
  // peak was 0.35 GB.
  { name: 'pdf-flat', file: 'pdf-flat', shown: everyPageInViewDrawn, budget: { ...budget, cardPeakMb: 450 } }
]
