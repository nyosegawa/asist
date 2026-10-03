/**
 * PDFs written directly, for the tests of the PDF viewer and for the budget scene's file of a flat page tree. Each
 * page's content stream, picture and page dictionary come in page order, then the page tree, the font and the
 * catalog, and a cross-reference table at the end. The page tree puts `fanOut` pages under each node: 8 balances it
 * as Chrome's "Save as PDF" (Skia) does, and as many as there are pages makes it flat, one node holding every page,
 * as LibreOffice writes it. A page is A4 with lines of text in a standard font, the page's number as a mark
 * (PAGE_MARK), and a picture on every `pictureEvery`-th page, starting with page 1, 515 pt wide from 40 pt in and
 * 245 pt up, as raw RGB that no decoder has to read unless the picture says otherwise.
 */

/**
 * The mark of a page's number, which the budget scene reads back from a drawn page (viewer-budgets/pdf.mjs): a row
 * of `squares` squares of `square` mm at the top right of an A4 page, from `left` mm to the right and `top` mm down,
 * the first always black and the others the number in binary, the highest bit first, black for 1. viewer-files/pdf.mjs
 * draws the same mark on the pages Chrome prints.
 */
export const PAGE_MARK = { squares: 12, square: 5, left: 132, top: 18 }

const MM = 72 / 25.4
const A4 = [595, 842]
const encoder = new TextEncoder()

/** Bytes that differ from page to page, so that nothing in the file repeats where a reader could share it. */
function noise(length, seed) {
  const out = new Uint8Array(length)
  let state = seed * 2654435761 + 1
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) >>> 0
    out[i] = state >>> 24
  }
  return out
}

/** The content that draws a page's mark. */
function markOf(number) {
  const { squares, square, left, top } = PAGE_MARK
  const size = square * MM
  const y = A4[1] - (top + square) * MM
  const filled = []
  for (let i = 0; i < squares; i++) {
    const black = i === 0 || (number >> (squares - 1 - i)) & 1
    if (black) filled.push(`${((left + i * square) * MM).toFixed(2)} ${y.toFixed(2)} ${size.toFixed(2)} ${size.toFixed(2)} re`)
  }
  return `0 g ${filled.join(' ')} f`
}

function textOf(number, bytes) {
  const lines = [`BT /F1 10 Tf 40 760 Td 12 TL (Page ${number}) Tj`]
  let length = lines[0].length
  for (let line = 0; length < bytes; line++) {
    const text = `(The quarterly figures for line ${line} of page ${number} are within the plan.) '`
    lines.push(text)
    length += text.length + 1
  }
  lines.push('ET')
  return lines.join('\n')
}

/**
 * Writes a PDF of `pages` pages, each with about `textBytes` of text. `picture` is { width, height, stream }, where
 * stream, when given, is { entries, bytes }: the entries of the image's dictionary besides its size, and its bytes.
 */
export function writePdf({ pages, textBytes, fanOut = 8, pictureEvery = 0, picture = { width: 64, height: 64 } }) {
  // Object numbers: 1 the catalog, 2 the font, then three for each page (its content, its picture, itself), then
  // the nodes of the page tree from the leaves up.
  const catalog = 1
  const font = 2
  const contentOf = (index) => 3 + index * 3
  const pictureOf = (index) => 4 + index * 3
  const pageOf = (index) => 5 + index * 3
  let next = 3 + pages * 3
  const levels = []
  let below = Array.from({ length: pages }, (_, index) => ({ number: pageOf(index), count: 1 }))
  do {
    const level = []
    for (let i = 0; i < below.length; i += fanOut) {
      const kids = below.slice(i, i + fanOut)
      level.push({ number: next++, kids: kids.map((kid) => kid.number), count: kids.reduce((sum, kid) => sum + kid.count, 0) })
    }
    levels.push(level)
    below = level
  } while (below.length > 1)
  const root = below[0].number
  const parentOf = new Map()
  for (const level of levels) for (const node of level) for (const kid of node.kids) parentOf.set(kid, node.number)

  const chunks = []
  const offsets = new Map()
  let length = 0
  const write = (part) => {
    const bytes = typeof part === 'string' ? encoder.encode(part) : part
    chunks.push(bytes)
    length += bytes.length
  }
  const object = (number, body) => {
    offsets.set(number, length)
    write(`${number} 0 obj\n${body}\nendobj\n`)
  }
  const stream = (number, dictionary, bytes) => {
    offsets.set(number, length)
    write(`${number} 0 obj\n<< ${dictionary} /Length ${bytes.length} >>\nstream\n`)
    write(bytes)
    write('\nendstream\nendobj\n')
  }

  write('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
  for (let index = 0; index < pages; index++) {
    const withPicture = pictureEvery > 0 && index % pictureEvery === 0
    let content = `${markOf(index + 1)}\n${textOf(index + 1, textBytes)}`
    if (withPicture) content = `q 515 0 0 ${Math.round((515 * picture.height) / picture.width)} 40 245 cm /Im1 Do Q\n${content}`
    stream(contentOf(index), '', encoder.encode(content))
    if (withPicture) {
      const { entries, bytes } = picture.stream ?? { entries: '/ColorSpace /DeviceRGB /BitsPerComponent 8', bytes: noise(picture.width * picture.height * 3, index) }
      stream(pictureOf(index), `/Type /XObject /Subtype /Image /Width ${picture.width} /Height ${picture.height} ${entries}`, bytes)
    }
    const xobjects = withPicture ? ` /XObject << /Im1 ${pictureOf(index)} 0 R >>` : ''
    object(
      pageOf(index),
      `<< /Type /Page /Parent ${parentOf.get(pageOf(index))} 0 R /MediaBox [0 0 ${A4.join(' ')}] /Resources << /Font << /F1 ${font} 0 R >>${xobjects} >> /Contents ${contentOf(index)} 0 R >>`
    )
  }
  for (const level of levels) {
    for (const node of level) {
      const parent = parentOf.get(node.number)
      object(node.number, `<< /Type /Pages${parent ? ` /Parent ${parent} 0 R` : ''} /Kids [${node.kids.map((kid) => `${kid} 0 R`).join(' ')}] /Count ${node.count} >>`)
    }
  }
  object(font, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  object(catalog, `<< /Type /Catalog /Pages ${root} 0 R >>`)

  // A number with no object, such as the picture of a page without one, is listed as free.
  const xref = length
  const entries = ['0000000000 65535 f ']
  for (let number = 1; number < next; number++) {
    const offset = offsets.get(number)
    entries.push(offset === undefined ? '0000000000 65535 f ' : `${String(offset).padStart(10, '0')} 00000 n `)
  }
  write(`xref\n0 ${next}\n${entries.join('\n')}\ntrailer\n<< /Size ${next} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`)

  const file = new Uint8Array(length)
  let at = 0
  for (const chunk of chunks) {
    file.set(chunk, at)
    at += chunk.length
  }
  return file
}
