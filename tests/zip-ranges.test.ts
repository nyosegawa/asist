import { randomBytes } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import JSZip from 'jszip'
import mammoth from 'mammoth/mammoth.browser.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { errorText } from '@shared/i18n/error-text'
import { openZip } from '@/preview/zip-ranges'

/**
 * The zip reader of the preview iframe, against a server that answers Range requests the way asist-file does: a
 * 206 with the bytes of the range, cut at the end of the file, and a 200 with the whole file for a range that
 * starts past its end. The server counts the bytes it sends.
 */

const URL = 'asist-file:///tmp/a.docx'
/** The size of a picture, which is four times the 64 KB a reader takes from the end of the file first. */
const PICTURE = 256 * 1024

let sent = 0

function serve(file: Uint8Array): void {
  sent = 0
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('range') ?? '')
    if (!range || Number(range[1]) >= file.length) {
      sent += file.length
      return new Response(file.slice(), { status: 200 })
    }
    const body = file.slice(Number(range[1]), Math.min(Number(range[2]), file.length - 1) + 1)
    sent += body.length
    return new Response(body, { status: 206 })
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

/** A zip as Office writes one: the entries alone, without an entry for each folder. */
async function zipOf(files: Record<string, Uint8Array | string>, options: { store?: string[] } = {}): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content, { compression: options.store?.includes(name) ? 'STORE' : 'DEFLATE', createFolders: false })
  }
  return zip.generateAsync({ type: 'uint8array' })
}

/**
 * A zip written the way a ZIP64 writer writes one: every size and offset of the central directory in its ZIP64
 * field, a ZIP64 field in each local header too, and the counts in the ZIP64 end record. `declared` overrides
 * the size the central directory gives an entry, as a huge sheet would declare it.
 */
function zip64Of(files: Array<{ name: string; content: Uint8Array; declared?: number }>): Uint8Array {
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const { name, content, declared } of files) {
    const rawName = new TextEncoder().encode(name)
    const data = deflateRawSync(content)
    const local = new DataView(new ArrayBuffer(30 + rawName.length + 20))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 45, true)
    local.setUint16(8, 8, true)
    local.setUint32(18, 0xffffffff, true)
    local.setUint32(22, 0xffffffff, true)
    local.setUint16(26, rawName.length, true)
    local.setUint16(28, 20, true)
    new Uint8Array(local.buffer).set(rawName, 30)
    local.setUint16(30 + rawName.length, 0x0001, true)
    local.setUint16(32 + rawName.length, 16, true)
    local.setBigUint64(34 + rawName.length, BigInt(content.length), true)
    local.setBigUint64(42 + rawName.length, BigInt(data.length), true)
    const record = new DataView(new ArrayBuffer(46 + rawName.length + 28))
    record.setUint32(0, 0x02014b50, true)
    record.setUint16(4, 45, true)
    record.setUint16(6, 45, true)
    record.setUint16(10, 8, true)
    record.setUint32(20, 0xffffffff, true)
    record.setUint32(24, 0xffffffff, true)
    record.setUint16(28, rawName.length, true)
    record.setUint16(30, 28, true)
    record.setUint32(42, 0xffffffff, true)
    new Uint8Array(record.buffer).set(rawName, 46)
    record.setUint16(46 + rawName.length, 0x0001, true)
    record.setUint16(48 + rawName.length, 24, true)
    record.setBigUint64(50 + rawName.length, BigInt(declared ?? content.length), true)
    record.setBigUint64(58 + rawName.length, BigInt(data.length), true)
    record.setBigUint64(66 + rawName.length, BigInt(offset), true)
    parts.push(new Uint8Array(local.buffer), data)
    central.push(new Uint8Array(record.buffer))
    offset += local.byteLength + data.length
  }
  const centralLength = central.reduce((sum, record) => sum + record.length, 0)
  const ends = new DataView(new ArrayBuffer(56 + 20 + 22))
  ends.setUint32(0, 0x06064b50, true)
  ends.setBigUint64(4, 44n, true)
  ends.setUint16(12, 45, true)
  ends.setUint16(14, 45, true)
  ends.setBigUint64(24, BigInt(files.length), true)
  ends.setBigUint64(32, BigInt(files.length), true)
  ends.setBigUint64(40, BigInt(centralLength), true)
  ends.setBigUint64(48, BigInt(offset), true)
  ends.setUint32(56, 0x07064b50, true)
  ends.setBigUint64(64, BigInt(offset + centralLength), true)
  ends.setUint32(72, 1, true)
  ends.setUint32(76, 0x06054b50, true)
  ends.setUint16(84, 0xffff, true)
  ends.setUint16(86, 0xffff, true)
  ends.setUint32(88, 0xffffffff, true)
  ends.setUint32(92, 0xffffffff, true)
  return Buffer.concat([...parts, ...central, new Uint8Array(ends.buffer)])
}

describe('reading a zip by ranges', () => {
  it('reads one entry without reading the others', async () => {
    const pictures = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`word/media/image${i}.png`, randomBytes(PICTURE)]))
    const file = await zipOf({ 'word/document.xml': '<w:document>本文</w:document>'.repeat(200), ...pictures }, { store: Object.keys(pictures) })
    serve(file)
    const zip = await openZip(URL, file.length)
    expect([...zip.entries.keys()]).toEqual(['word/document.xml', ...Object.keys(pictures)])
    expect(zip.entries.get('word/media/image3.png')).toMatchObject({ size: PICTURE, compressedSize: PICTURE })
    expect(sent).toBeLessThan(PICTURE)

    sent = 0
    expect(pictures['word/media/image3.png'].equals(await zip.read('word/media/image3.png'))).toBe(true)
    expect(text(await zip.read('word/document.xml'))).toBe('<w:document>本文</w:document>'.repeat(200))
    // The picture and the document, and nothing of the seven other pictures.
    expect(sent).toBeLessThan(PICTURE * 1.5)
  })

  it('reads a central directory that the end of the file it reads first does not hold', async () => {
    // 1,500 entries take about 105 KB of central directory.
    const files = Object.fromEntries(Array.from({ length: 1500 }, (_, i) => [`ppt/slides/slide${i}.xml`, `<p:sld>${i}</p:sld>`]))
    const file = await zipOf(files)
    serve(file)
    const zip = await openZip(URL, file.length)
    expect(zip.entries.size).toBe(1500)
    expect(text(await zip.read('ppt/slides/slide0.xml'))).toBe('<p:sld>0</p:sld>')
    expect(text(await zip.read('ppt/slides/slide1499.xml'))).toBe('<p:sld>1499</p:sld>')
  })

  it('takes the sizes, offsets and counts a ZIP64 zip keeps in its ZIP64 fields and records', async () => {
    const sheet = new TextEncoder().encode('<sheetData><row r="1"/></sheetData>'.repeat(100))
    const file = zip64Of([
      { name: 'xl/workbook.xml', content: new TextEncoder().encode('<workbook/>') },
      { name: 'xl/worksheets/sheet1.xml', content: sheet },
      { name: 'xl/worksheets/sheet2.xml', content: new TextEncoder().encode('<sheetData/>'), declared: 5 * 2 ** 30 }
    ])
    serve(file)
    const zip = await openZip(URL, file.length)
    expect([...zip.entries.keys()]).toEqual(['xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml'])
    // A size past 4 GB is known before anything of the entry is read, so a viewer can refuse it.
    expect(zip.entries.get('xl/worksheets/sheet2.xml')!.size).toBe(5 * 2 ** 30)
    expect(text(await zip.read('xl/workbook.xml'))).toBe('<workbook/>')
    expect(await zip.read('xl/worksheets/sheet1.xml')).toEqual(sheet)
  })
})

describe('a zip that cannot be read', () => {
  const damaged = errorText('files.errors.zipDamaged')

  it('fails on a file cut short, and on one that is no zip', async () => {
    const file = await zipOf({ 'word/document.xml': new Uint8Array(randomBytes(200_000)) })
    const cut = file.slice(0, Math.floor(file.length / 2))
    serve(cut)
    await expect(openZip(URL, cut.length)).rejects.toThrow(damaged)
    const pdf = new TextEncoder().encode(`%PDF-1.7\n${'0'.repeat(1000)}\n%%EOF\n`)
    serve(pdf)
    await expect(openZip(URL, pdf.length)).rejects.toThrow(damaged)
    serve(new Uint8Array(0))
    await expect(openZip(URL, 0)).rejects.toThrow(damaged)
  })

  it('fails on a central directory that points past the file, and on an entry whose data is not deflate', async () => {
    const file = await zipOf({ 'word/document.xml': '<w:document/>'.repeat(100), 'word/styles.xml': '<w:styles/>' })
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
    const end = file.length - 22
    const wrongOffset = file.slice()
    new DataView(wrongOffset.buffer).setUint32(end + 16, view.getUint32(end + 16, true) + 1000, true)
    serve(wrongOffset)
    await expect(openZip(URL, wrongOffset.length)).rejects.toThrow(damaged)

    // A first byte of 0xff marks a final block of the reserved type 3, which no deflate stream has.
    const broken = file.slice()
    broken[30 + view.getUint16(26, true) + view.getUint16(28, true)] = 0xff
    serve(broken)
    const zip = await openZip(URL, broken.length)
    await expect(zip.read('word/document.xml')).rejects.toThrow(damaged)
    expect(text(await zip.read('word/styles.xml'))).toBe('<w:styles/>')
  })

  it('says the file changed when it is no longer the size it was listed with, and gives the HTTP status of a refusal', async () => {
    const file = await zipOf({ 'word/document.xml': '<w:document/>' })
    serve(file.slice(0, file.length - 10))
    await expect(openZip(URL, file.length)).rejects.toThrow(errorText('files.errors.changedWhileReading'))
    vi.stubGlobal('fetch', async () => new Response('forbidden', { status: 403 }))
    await expect(openZip(URL, file.length)).rejects.toThrow(errorText('files.errors.loadFailed', { status: 403 }))
  })

  it('names an entry the zip does not have', async () => {
    const file = await zipOf({ 'word/document.xml': '<w:document/>' })
    serve(file)
    const zip = await openZip(URL, file.length)
    await expect(zip.read('word/styles.xml')).rejects.toThrow(errorText('files.errors.zipEntryMissing', { path: 'word/styles.xml' }))
  })
})

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
/** A paragraph holding one picture, as Word writes it, which refers to the picture's file through rel. */
const drawing = (rel: string, name: string): string =>
  '<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">' +
  `<wp:extent cx="952500" cy="952500"/><wp:docPr id="1" name="${name}" descr="${name}"/>` +
  '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
  `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
  `<pic:blipFill><a:blip r:embed="${rel}"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`

/** A docx with two paragraphs and two pictures. */
async function docxWithPictures(): Promise<{ file: Uint8Array; original: JSZip }> {
  const files = {
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels':
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml':
      `<w:document ${W} ${R}><w:body><w:p><w:r><w:t>調査の結果</w:t></w:r></w:p>${drawing('rId5', '図1')}<w:p><w:r><w:t>次の段落</w:t></w:r></w:p>${drawing('rId6', '写真')}</w:body></w:document>`,
    'word/media/image1.png': randomBytes(PICTURE),
    'word/media/photo.jpeg': randomBytes(PICTURE),
    'word/_rels/document.xml.rels':
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>' +
      '<Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/photo.jpeg"/></Relationships>',
    'docProps/core.xml': '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"/>'
  }
  const file = await zipOf(files, { store: ['word/media/image1.png', 'word/media/photo.jpeg'] })
  return { file, original: await JSZip.loadAsync(file) }
}

describe('the slimmed zip', () => {
  const isPicture = (name: string): boolean => name.startsWith('word/media/')

  it('keeps every other entry as it was, replaces each chosen entry by its path, and reads none of the chosen ones', async () => {
    const { file, original } = await docxWithPictures()
    serve(file)
    const zip = await openZip(URL, file.length)
    sent = 0
    const slim = await JSZip.loadAsync(await zip.slimmed(isPicture), { checkCRC32: true })
    expect(sent).toBeLessThan(PICTURE)
    expect(Object.keys(slim.files)).toEqual(Object.keys(original.files))
    for (const name of Object.keys(original.files)) {
      const content = await slim.file(name)!.async('uint8array')
      if (isPicture(name)) expect(text(content)).toBe(name)
      else expect(content).toEqual(await original.file(name)!.async('uint8array'))
    }
  })

  it('is read by mammoth, which writes each picture as a reference to its path', async () => {
    const { file } = await docxWithPictures()
    serve(file)
    const slim = await (await openZip(URL, file.length)).slimmed(isPicture)
    const { value } = await mammoth.convertToHtml({ arrayBuffer: slim.buffer })
    expect([...value.matchAll(/<p>([^<]+)<\/p>/g)].map((match) => match[1])).toEqual(['調査の結果', '次の段落'])
    const images = [...value.matchAll(/<img [^>]*src="data:([^;]+);base64,([^"]+)"/g)].map((match) => ({
      type: match[1],
      path: Buffer.from(match[2], 'base64').toString('utf8')
    }))
    expect(images).toEqual([
      { type: 'image/png', path: 'word/media/image1.png' },
      { type: 'image/jpeg', path: 'word/media/photo.jpeg' }
    ])
  })
})
