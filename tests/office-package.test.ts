import { describe, expect, it } from 'vitest'
import { DOCUMENT_XML_LIMIT, documentLeftOut, parseWorkbook, SHEET_XML_LIMIT, tags, workbookLeftOut } from '@shared/office-package'
import type { ZipEntry } from '@shared/zip-directory'

/**
 * What the preview page's Office viewers and main share of an Office package: reading the tags of its small parts,
 * and the size net decided from the names and sizes of its zip's directory.
 */

const entriesOf = (sizes: Record<string, number>): Map<string, ZipEntry> =>
  new Map(Object.entries(sizes).map(([name, size]) => [name, { name, size, compressedSize: 0 }]))

describe('the tags of a part', () => {
  it('reads the attributes of every tag, with a > in a value and a prefix on a name', () => {
    expect(parseWorkbook('<x:workbook><x:sheets><x:sheet name="a&gt;b" sheetId="1" r:id="rId1"/><sheet name=\'c\' r:id="rId2"></sheet></x:sheets></x:workbook>')).toEqual({
      sheets: [
        { name: 'a>b', id: 'rId1' },
        { name: 'c', id: 'rId2' }
      ],
      date1904: false
    })
  })

  it('reads tags that never close in a time that grows with the text, not its square', () => {
    const xml = `<workbook><sheets>${'<sheet a'.repeat(32_000)}"</sheets></workbook>`
    const started = performance.now()
    expect(tags(xml, 'sheet')).toEqual([])
    // 32,000 of them took 10.7 s when a try could run on past the next < to the end of the text (2026-10-03).
    expect(performance.now() - started).toBeLessThan(1000)
  })
})

describe('the size net, from the directory alone', () => {
  it('refuses a whole workbook when a part read for every sheet is over the limit, whatever the case of its name', () => {
    for (const part of ['xl/sharedStrings.xml', 'xl/SharedStrings.xml', 'xl/styles.xml', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels']) {
      expect(workbookLeftOut(entriesOf({ 'xl/worksheets/sheet1.xml': 10, [part]: SHEET_XML_LIMIT + 1 }))).toBe('file')
    }
  })

  it('leaves out only the sheets over the limit, and nothing for a large part the viewer does not read', () => {
    expect(workbookLeftOut(entriesOf({ 'xl/worksheets/sheet1.xml': 10, 'xl/worksheets/sheet2.xml': SHEET_XML_LIMIT + 1 }))).toBe('someSheets')
    expect(workbookLeftOut(entriesOf({ 'xl/worksheets/sheet1.xml': SHEET_XML_LIMIT, 'xl/media/image1.png': SHEET_XML_LIMIT * 4 }))).toBe('nothing')
  })

  it('refuses a Word document whose XML parts are over the limit together, and counts no picture', () => {
    const third = Math.ceil(DOCUMENT_XML_LIMIT / 3) + 1
    expect(documentLeftOut(entriesOf({ 'word/document.xml': third, 'word/styles.xml': third, 'word/_rels/document.xml.rels': third }))).toBe('file')
    expect(documentLeftOut(entriesOf({ 'word/document.xml': third, 'word/media/image1.png': DOCUMENT_XML_LIMIT * 4 }))).toBe('nothing')
  })
})
