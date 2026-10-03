import { afterEach, describe, expect, it, vi } from 'vitest'
import { errorKey } from '@shared/i18n/error-key'
import openXlsx, { PART_LIMIT, type SheetCell } from '@/preview/methods/xlsx'
import { indexRows, rowsWithin, type RowIndex } from '@/preview/sheet-xml'
import { declareSize, offsetOf, serveByRanges, workbookOf, worksheet } from './helpers/workbook'

/**
 * The Excel document of the preview iframe: what it reads of a workbook, how it finds the rows of a sheet from their
 * index, and what each cell shows. The workbook is served to fetch by ranges, as asist-file serves it.
 */

const URL = 'asist-file:///Users/me/sales.xlsx'

afterEach(() => vi.unstubAllGlobals())

const STYLES =
  '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy/mm/dd"/></numFmts>' +
  '<cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs>' +
  '<cellXfs count="3"><xf numFmtId="0" xfId="0"/><xf numFmtId="4" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" xfId="0" applyNumberFormat="1"><alignment horizontal="center"/></xf></cellXfs>'

const STRINGS = [
  '<t>品目</t>',
  '<t>金額</t>',
  // Rich text in two runs, with the reading that Japanese Excel writes beside a name.
  '<r><t>東京</t></r><r><rPr><b/></rPr><t>本社</t></r><rPh sb="0" eb="2"><t>トウキョウ</t></rPh><phoneticPr fontId="1"/>',
  '<t xml:space="preserve">A &amp; B_x000D_</t>'
]

const cell = (text: string, numeric = false): SheetCell => ({ text, numeric })
const empty = cell('')

describe('the rows of a sheet in the preview iframe', () => {
  it('lays a sheet out from its first to its last value, with the empty rows between, and shows each cell as Excel formats it', async () => {
    const data =
      // The values start at B2; row 1 and column A hold none.
      '<row r="2" spans="2:4"><c r="B2" t="s"><v>0</v></c><c r="C2" t="s"><v>1</v></c><c r="D2" t="inlineStr"><is><t>備考</t></is></c></row>' +
      '<row r="3"><c r="B3" t="s"><v>2</v></c><c r="C3" s="1"><v>1234.5</v></c><c r="D3" s="2"><v>45658</v></c></row>' +
      // An empty row with a height, and a row of cells that have a style or a formula but no value.
      '<row r="4" ht="30" customHeight="1"/>' +
      '<row r="5"><c r="B5" s="1"/><c r="C5"><f>1/0</f><v></v></c></row>' +
      // A row without r follows the one before it, and so does a cell without r.
      '<row><c r="B6" t="s"><v>3</v></c><c t="b"><v>1</v></c><c t="e"><v>#DIV/0!</v></c></row>' +
      '<row r="8"><c r="B8" t="inlineStr"><is><r><t>リッチ</t></r><r><t xml:space="preserve"> テキスト</t></r></is></c><c r="D8" t="str"><v>x&lt;y</v></c></row>'
    serveByRanges(await workbookOf({ sheets: [{ name: '売上', data }], strings: STRINGS, styles: STYLES }))
    const { methods } = await openXlsx(URL)
    expect(methods.sheets()).toEqual(['売上'])
    expect(await methods.sheet(0)).toEqual({ shows: 'rows', header: ['品目', '金額', '備考'], rowCount: 6, columnCount: 3 })
    expect(await methods.rows({ sheet: 0, from: 0, count: 100 })).toEqual([
      [cell('東京本社'), cell('1,234.50', true), cell('2025/01/01', true)],
      [empty, empty, empty],
      [empty, empty, empty],
      [cell('A & B\r'), cell('TRUE'), cell('#DIV/0!')],
      [empty, empty, empty],
      [cell('リッチ テキスト'), empty, cell('x<y')]
    ])
    expect(await methods.rows({ sheet: 0, from: 3, count: 2 })).toEqual([[cell('A & B\r'), cell('TRUE'), cell('#DIV/0!')], [empty, empty, empty]])
  })

  it('reads a sheet whose elements carry a prefix and whose rows and cells have no r, and an empty sheet', async () => {
    const prefixed = `<?xml version="1.0"?><x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row><x:c t="inlineStr"><x:is><x:t>番号</x:t></x:is></x:c><x:c t="inlineStr"><x:is><x:t>氏名</x:t></x:is></x:c></x:row><x:row><x:c><x:v>1</x:v></x:c><x:c t="inlineStr"><x:is><x:t>佐藤</x:t></x:is></x:c></x:row><x:row><x:c><x:v>2</x:v></x:c></x:row></x:sheetData></x:worksheet>`
    const blank = '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>'
    serveByRanges(await workbookOf({ sheets: [{ name: 'SDK', data: prefixed }, { name: '空', data: blank }] }))
    const { methods } = await openXlsx(URL)
    expect(await methods.sheet(0)).toEqual({ shows: 'rows', header: ['番号', '氏名'], rowCount: 2, columnCount: 2 })
    expect(await methods.rows({ sheet: 0, from: 0, count: 10 })).toEqual([
      [cell('1', true), cell('佐藤')],
      [cell('2', true), empty]
    ])
    expect(await methods.sheet(1)).toEqual({ shows: 'rows', header: [], rowCount: 0, columnCount: 0 })
    expect(await methods.rows({ sheet: 1, from: 0, count: 10 })).toEqual([])
  })

  it('formats each cell on its own: a dotted date as Excel shows it, a format SSF cannot read in the General format, and a text through its section', async () => {
    const styles =
      '<numFmts count="3"><numFmt numFmtId="164" formatCode="DD.MM.YYYY"/><numFmt numFmtId="165" formatCode="&quot;a&quot;;&quot;b&quot;;&quot;c&quot;;&quot;d&quot;;&quot;e&quot;"/><numFmt numFmtId="166" formatCode="@&quot; 様&quot;"/></numFmts>' +
      '<cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/><xf numFmtId="165" applyNumberFormat="1"/><xf numFmtId="166" applyNumberFormat="1"/></cellXfs>'
    const data =
      '<row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="B1" s="1"><v>45658</v></c><c r="C1" t="inlineStr"><is><t>Betrag</t></is></c></row>' +
      '<row r="2"><c r="A2" t="inlineStr" s="3"><is><t>山田</t></is></c><c r="B2" s="1"><v>45658.25</v></c><c r="C2" s="2"><v>7</v></c></row>'
    serveByRanges(await workbookOf({ sheets: [{ name: 'S', data }], styles }))
    const { methods } = await openXlsx(URL)
    expect(await methods.sheet(0)).toEqual({ shows: 'rows', header: ['Name', '01.01.2025', 'Betrag'], rowCount: 1, columnCount: 3 })
    expect(await methods.rows({ sheet: 0, from: 0, count: 10 })).toEqual([[cell('山田 様'), cell('01.01.2025', true), cell('7', true)]])
  })

  it('counts dates from 1904 in a workbook that says so, and reads dates written as ISO 8601', async () => {
    const styles = '<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs>'
    const data =
      '<row r="1"><c r="A1" t="inlineStr"><is><t>日付</t></is></c></row>' +
      '<row r="2"><c r="A2" s="1"><v>0</v></c></row>' +
      '<row r="3"><c r="A3" t="d" s="1"><v>2025-01-01T00:00:00</v></c></row>' +
      '<row r="4"><c r="A4" t="d" s="1"><v>2025-01-01</v></c></row>'
    const read = async (workbook: string): Promise<SheetCell[][]> => {
      serveByRanges(await workbookOf({ sheets: [{ name: 'S', data }], styles, workbook }))
      const { methods } = await openXlsx(URL)
      return methods.rows({ sheet: 0, from: 0, count: 10 })
    }
    expect(await read('<workbookPr date1904="1"/>')).toEqual([[cell('1/1/04', true)], [cell('1/1/25', true)], [cell('1/1/25', true)]])
    expect(await read('<workbookPr/>')).toEqual([[cell('1/0/00', true)], [cell('1/1/25', true)], [cell('1/1/25', true)]])
  })

  it('reads CDATA as text, and leaves out the rows, cells and strings inside comments', async () => {
    const strings = ['<t><![CDATA[x & y]]></t>', '<t>a</t></si><!-- <si><t>wrong</t></si> --><si><t>b</t>']
    const data =
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="str"><v><![CDATA[a<b]]></v></c></row>' +
      '<!-- <row r="900"><c r="A900"><v>9</v></c></row> -->' +
      '<row r="2"><c r="A2"><v><![CDATA[5]]></v></c><!-- <c r="B2"><v>6</v></c> --><c r="B2" t="s"><v>2</v></c></row>' +
      '<row r="3"><c r="A3" t="inlineStr"><is><t><![CDATA[<i>]]></t></is></c></row>'
    serveByRanges(await workbookOf({ sheets: [{ name: 'S', data }], strings }))
    const { methods } = await openXlsx(URL)
    expect(await methods.sheet(0)).toEqual({ shows: 'rows', header: ['x & y', 'a<b'], rowCount: 2, columnCount: 2 })
    expect(await methods.rows({ sheet: 0, from: 0, count: 10 })).toEqual([[cell('5', true), cell('b')], [cell('<i>'), empty]])
  })

  it('finds a sheet whose part the workbook names in another case than the zip, as Excel and SheetJS do', async () => {
    serveByRanges(await workbookOf({ sheets: [{ name: 'S', data: '<row r="1"><c r="A1"><v>1</v></c></row>' }], target: (i) => `Worksheets/Sheet${i + 1}.XML` }))
    const { methods } = await openXlsx(URL)
    expect(await methods.sheet(0)).toEqual({ shows: 'rows', header: ['1'], rowCount: 0, columnCount: 1 })
  })

  it('finds the rows in view by a binary search of the index, reading a few of its million numbers', () => {
    const count = 1_000_000
    let reads = 0
    const numbers = new Proxy(Uint32Array.from({ length: count }, (_, i) => i * 2), {
      get(target, key) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads++
        const value = Reflect.get(target, key, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    const index = { numbers, starts: new Uint32Array(count), ends: new Uint32Array(count), used: null } as RowIndex
    expect(rowsWithin(index, 1_200_000, 1_200_010)).toEqual({ first: 600_000, last: 600_005 })
    expect(reads).toBeLessThan(40)
  })

  it('finds the rows in view of a long sheet by its index, in order', async () => {
    const rows = Array.from({ length: 3000 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join('')
    serveByRanges(await workbookOf({ sheets: [{ name: '長い', data: rows }] }))
    const { methods } = await openXlsx(URL)
    expect(await methods.sheet(0)).toMatchObject({ header: ['0'], rowCount: 2999 })
    expect(await methods.rows({ sheet: 0, from: 1500, count: 3 })).toEqual([[cell('1501', true)], [cell('1502', true)], [cell('1503', true)]])
    expect(await methods.rows({ sheet: 0, from: 2997, count: 100 })).toEqual([[cell('2998', true)], [cell('2999', true)]])
  })

  it('puts in order the rows a writer wrote out of order', () => {
    const xml = new TextEncoder().encode(worksheet('<row r="3"><c r="A3"><v>3</v></c></row><row r="1"><c r="A1"><v>1</v></c></row><row r="2"/>'))
    const index = indexRows(xml)
    expect([...index.numbers]).toEqual([0, 1, 2])
    const texts = [...index.numbers.keys()].map((i) => new TextDecoder().decode(xml.subarray(index.starts[i], index.ends[i])))
    expect(texts).toEqual(['<row r="1"><c r="A1"><v>1</v></c></row>', '<row r="2"/>', '<row r="3"><c r="A3"><v>3</v></c></row>'])
    expect(index.used).toEqual({ firstRow: 0, lastRow: 2, firstColumn: 0, lastColumn: 0 })
  })
})

/** A sheet of 2,000 rows of text written once, about 100 KB, which starts with its marker. */
const filler = (marker: string): string =>
  `<row r="1"><c r="A1" t="inlineStr"><is><t>${marker}</t></is></c></row>` +
  Array.from({ length: 2000 }, (_, i) => `<row r="${i + 2}"><c r="A${i + 2}" t="inlineStr"><is><t>${marker}-${i}-${'x'.repeat(16)}</t></is></c></row>`).join('')

/** Whether any range sent covers the byte at `at`. */
const covered = (ranges: Array<[number, number]>, at: number): boolean => ranges.some(([start, end]) => start <= at && at <= end)

describe('what the preview iframe reads of a workbook', () => {
  it('reads only the sheet shown, and the next one when the viewer switches to it', async () => {
    const markers = ['SHEET-ONE', 'SHEET-TWO', 'SHEET-THREE']
    const file = await workbookOf({ sheets: markers.map((marker, i) => ({ name: `${i + 1}月`, data: filler(marker) })), strings: STRINGS, styles: STYLES })
    const served = serveByRanges(file)
    const [one, two, three] = markers.map((marker) => offsetOf(file, marker))
    const { methods } = await openXlsx(URL)
    expect(methods.sheets()).toEqual(['1月', '2月', '3月'])
    expect(await methods.sheet(1)).toMatchObject({ header: ['SHEET-TWO'], rowCount: 2000 })
    expect(await methods.rows({ sheet: 1, from: 1999, count: 1 })).toEqual([[cell(`SHEET-TWO-1999-${'x'.repeat(16)}`)]])
    expect([covered(served.ranges, one), covered(served.ranges, two), covered(served.ranges, three)]).toEqual([false, true, false])

    served.ranges.length = 0
    expect(await methods.sheet(2)).toMatchObject({ header: ['SHEET-THREE'] })
    expect([covered(served.ranges, one), covered(served.ranges, two), covered(served.ranges, three)]).toEqual([false, false, true])

    // The second sheet was let go when the third loaded, so going back to it reads it again.
    served.ranges.length = 0
    expect(await methods.sheet(1)).toMatchObject({ header: ['SHEET-TWO'] })
    expect([covered(served.ranges, one), covered(served.ranges, two), covered(served.ranges, three)]).toEqual([false, true, false])
  })

  it('keeps showing the sheet it shows when the file is saved again, and tries the next sheet again on each request', async () => {
    const sheets = (rows: number): Array<{ name: string; data: string }> =>
      ['ONE', 'TWO'].map((marker) => ({ name: marker, data: Array.from({ length: rows }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>${marker}-${i}</t></is></c></row>`).join('') }))
    serveByRanges(await workbookOf({ sheets: sheets(3000) }))
    const { methods } = await openXlsx(URL)
    const shown = await methods.sheet(0)
    const served = serveByRanges(await workbookOf({ sheets: sheets(3010) }))
    await expect(methods.sheet(1)).rejects.toThrow(errorKey('files.errors.changedWhileReading'))
    expect(await methods.sheet(0)).toEqual(shown)
    expect(await methods.rows({ sheet: 0, from: 2998, count: 5 })).toEqual([[cell('ONE-2999')]])
    const asked = served.ranges.length
    await expect(methods.sheet(1)).rejects.toThrow(errorKey('files.errors.changedWhileReading'))
    expect(served.ranges.length).toBeGreaterThan(asked)
  })

  it('says a sheet whose XML is over the limit is too large without reading it, and still shows the others', async () => {
    const file = await workbookOf({ sheets: [{ name: '大きい', data: filler('HUGE') }, { name: '小さい', data: filler('SMALL') }] })
    const huge = offsetOf(file, 'HUGE')
    const served = serveByRanges(declareSize(file, 'xl/worksheets/sheet1.xml', PART_LIMIT + 1))
    const { methods } = await openXlsx(URL)
    expect(await methods.sheet(0)).toEqual({ shows: 'tooLarge' })
    expect(await methods.rows({ sheet: 0, from: 0, count: 20 })).toEqual([])
    expect(await methods.sheet(1)).toMatchObject({ shows: 'rows', header: ['SMALL'] })
    expect(covered(served.ranges, huge)).toBe(false)
  })

  it('says every sheet is too large when the shared strings are over the limit, without reading them', async () => {
    const file = await workbookOf({ sheets: [{ name: '売上', data: '<row r="1"><c r="A1" t="s"><v>0</v></c></row>' }], strings: [`<t>STRINGS-${'y'.repeat(300_000)}</t>`], store: true })
    const strings = offsetOf(file, 'STRINGS')
    const served = serveByRanges(declareSize(file, 'xl/sharedStrings.xml', PART_LIMIT + 1))
    const { methods } = await openXlsx(URL)
    expect(await methods.sheet(0)).toEqual({ shows: 'tooLarge' })
    expect(covered(served.ranges, strings)).toBe(false)
  })

  it('fails a sheet that names a shared string the workbook does not have, as a damaged file', async () => {
    serveByRanges(await workbookOf({ sheets: [{ name: '売上', data: '<row r="1"><c r="A1" t="s"><v>9</v></c></row>' }], strings: STRINGS }))
    const { methods } = await openXlsx(URL)
    await expect(methods.sheet(0)).rejects.toThrow(errorKey('files.errors.zipDamaged'))
  })
})
