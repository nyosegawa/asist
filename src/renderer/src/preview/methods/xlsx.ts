import * as XLSX from 'xlsx/dist/xlsx.mini.min.js'
import { errorKey } from '@shared/i18n/error-key'
import { partTooLarge, readWorkbookParts, sheetTooLarge, unescapeXml } from '@shared/office-package'
import type { OpenPreviewDocument } from '../serve'
import { indexRows, indexStrings, itemText, parseCells, parseStyles, rowsWithin, type RawCell, type RowIndex, type StringIndex } from '../sheet-xml'
import { openZip, type RangedZip } from '../zip-ranges'

/**
 * An Excel workbook (xlsx, xlsm) in the preview iframe. It reads the workbook, its relationships, the styles, the
 * shared strings and the sheet the viewer shows through the zip reader by ranges, and no other sheet. The sheet's
 * XML is kept as bytes with an index of where each row starts (sheet-xml.ts), and each request parses only the rows
 * it asks for; switching to another sheet lets go of the one before. On the 50,000-row sheet of the viewer budget
 * scene (19 MB of XML) the iframe held 21 MB for the sheet, its bytes and their index, where SheetJS's parsed sheet
 * held 40 MB in its dense form and the first rows took four times as long to show (headless Chrome on an Apple M5,
 * 2026-10-02).
 */

type Bytes = Uint8Array<ArrayBuffer>

/** A cell as the viewer draws it: the text Excel's number format gives it, and whether it is a number. */
export interface SheetCell {
  text: string
  numeric: boolean
}

/**
 * A sheet as the viewer lays it out: the first row with a value is the header, and the rows below it down to the
 * last with a value are counted, each from the first column with a value. A sheet whose XML or shared strings are
 * over SHEET_XML_LIMIT is not read and is reported as too large.
 */
export type SheetSummary = { shows: 'rows'; header: string[]; rowCount: number; columnCount: number } | { shows: 'tooLarge' }

/**
 * The columns a row carries, from the first with a value. The focus view scrolls sideways as well as down, so
 * this is how far it is worth scrolling rather than what fits: the focus frame is 850px wide at window size l and
 * the demo sheet's columns are 136 to 200px (measured 2026-09-26), so 50 columns are about eight frames across.
 */
export const SHOWN_COLUMNS = 50

const damaged = (): Error => new Error(errorKey('files.errors.zipDamaged'))

/** SheetJS's number formatter, which its types leave as any. */
const SSF: {
  format(format: number | string, value: number | string, options: { table: Record<number, string>; date1904: boolean }): string
  get_table(): Record<number, string>
} = XLSX.SSF

/**
 * A format code with the dots of its date and time sections escaped, as in dd\.mm\.yyyy. Excel shows a dot between
 * the parts of a date as it is, while SSF throws "bad second format" on one that does not follow seconds, which
 * dates written by pandas, openpyxl and XlsxWriter, German ones above all, often have. A dot before a 0 is the
 * fraction of a second, which SSF reads.
 */
export function escapeDateDots(code: string): string {
  const sections: string[] = []
  let escaped = ''
  let plain = ''
  let isDate = false
  const finish = (): void => {
    sections.push(isDate ? escaped : plain)
    escaped = plain = ''
    isDate = false
  }
  for (let i = 0; i < code.length; i++) {
    const char = code[i]
    // A quoted text, an escaped or padded character and a bracketed condition, colour or locale are taken whole.
    let stop = i + 1
    if (char === '"') stop = code.includes('"', i + 1) ? code.indexOf('"', i + 1) + 1 : code.length
    else if (char === '\\' || char === '_' || char === '*') stop = i + 2
    else if (char === '[') stop = code.includes(']', i) ? code.indexOf(']', i) + 1 : code.length
    else if (char === ';') {
      finish()
      continue
    }
    const piece = code.slice(i, stop)
    if (stop === i + 1 && /[ymdhs]/i.test(char)) isDate = true
    escaped += char === '.' && code[i + 1] !== '0' ? '\\.' : piece
    plain += piece
    i = stop - 1
  }
  finish()
  return sections.join(';')
}

interface LoadedSheet {
  xml: Bytes
  index: RowIndex
}

interface SharedStrings {
  xml: Bytes
  index: StringIndex
}

const decoder = new TextDecoder()

async function readText(zip: RangedZip, part: string): Promise<string> {
  if (partTooLarge(zip.entries, part)) throw new Error(errorKey('files.viewer.tooLarge'))
  return decoder.decode(await zip.read(part))
}

/**
 * An ISO 8601 date, which a cell of type d holds, as an Excel date serial in the workbook's date system. A date
 * without a zone is the time on the sheet's clock, as Excel writes it, so it is counted as UTC. As in Excel and
 * SheetJS, a day before 1 March 1900 counts the 29 February 1900 that never was.
 */
function dateSerial(iso: string, date1904: boolean): number {
  const time = Date.parse(/(?:Z|[+-]\d\d:?\d\d)$/.test(iso) || !iso.includes('T') ? iso : `${iso}Z`)
  if (Number.isNaN(time)) throw damaged()
  const days = (time - Date.UTC(1899, 11, 30)) / 86_400_000
  if (date1904) return days - 1462
  return days < 61 ? days - 1 : days
}

const openXlsx = async (url: string) => {
  const zip = await openZip(url)
  const workbook = await readWorkbookParts(zip.entries.keys(), (part) => readText(zip, part))
  const stringsPart = workbook.strings
  const stylesPart = workbook.styles
  const styles = stylesPart ? parseStyles(await readText(zip, stylesPart)) : { formats: {}, cellFormats: [] }
  // The format codes SSF looks an id up in: Excel's built-in ones and this workbook's own, kept per workbook
  // rather than loaded into SSF's table, which every workbook open in the iframe shares.
  const formatTable = { ...SSF.get_table(), ...styles.formats }

  let strings: Promise<SharedStrings | null> | null = null
  /** The shared strings, read and indexed once, or null for a workbook that has none. */
  function sharedStrings(): Promise<SharedStrings | null> {
    if (strings) return strings
    const reading = stringsPart ? zip.read(stringsPart).then((xml) => ({ xml, index: indexStrings(xml) })) : Promise.resolve(null)
    strings = reading
    // Strings that failed to load are not kept, so that the next request reads them again.
    reading.catch(() => {
      if (strings === reading) strings = null
    })
    return reading
  }
  /** The sheet the viewer shows, read and indexed, or null for one too large to read. */
  let shown: { sheet: number; loaded: LoadedSheet | null } | null = null
  /** The sheet being read to take its place. */
  let loading: { sheet: number; promise: Promise<LoadedSheet | null> } | null = null

  /**
   * The sheet, read and indexed once while it is the one shown. The sheet shown before is let go only once the next
   * one has loaded, so that a sheet that fails to load, as every one does after the file is saved again, leaves the
   * shown one as it was; nothing that failed is kept, and the next request reads it again.
   */
  function load(sheet: number): Promise<LoadedSheet | null> {
    if (shown?.sheet === sheet) return Promise.resolve(shown.loaded)
    if (loading?.sheet === sheet) return loading.promise
    // A viewer asks only for the sheets the workbook had when it listed them, so a sheet past the end means the
    // document was opened again, in a frame started after the last one stopped, from a file saved since.
    if (sheet >= workbook.sheets.length) throw new Error(errorKey('files.errors.changedWhileReading'))
    const promise = sheetTooLarge(zip.entries, workbook, sheet)
      ? Promise.resolve(null)
      : Promise.all([zip.read(workbook.sheets[sheet].part), sharedStrings()]).then(([xml]) => ({ xml, index: indexRows(xml) }))
    const reading = { sheet, promise }
    loading = reading
    promise.then(
      (loaded) => {
        if (loading !== reading) return
        shown = { sheet, loaded }
        loading = null
      },
      () => {
        if (loading === reading) loading = null
      }
    )
    return promise
  }

  function sharedString(table: SharedStrings | null, value: string): string {
    const position = Number(value)
    if (!table || !Number.isInteger(position) || position < 0 || position >= table.index.starts.length) throw damaged()
    return itemText(decoder.decode(table.xml.subarray(table.index.starts[position], table.index.ends[position])))
  }

  const formatOptions = { table: formatTable, date1904: workbook.date1904 }

  /**
   * A value as its cell's format shows it, or null when SSF cannot read the format even with the dots of its dates
   * escaped. SSF throws a string or an Error on a format it cannot read; each cell is formatted on its own, so that
   * such a format leaves only its own cells as SheetJS's reader left them, in the General format.
   */
  function formatted(formatId: number, value: number | string): string | null {
    try {
      return SSF.format(formatId, value, formatOptions)
    } catch {
      const code = formatTable[formatId]
      const escaped = code === undefined ? code : escapeDateDots(code)
      if (escaped === undefined || escaped === code) return null
      try {
        return SSF.format(escaped, value, formatOptions)
      } catch {
        return null
      }
    }
  }

  const formatOf = (cell: RawCell): number => (cell.style === undefined ? 0 : (styles.cellFormats[cell.style] ?? 0))

  const numberCell = (value: number, cell: RawCell): SheetCell => ({
    text: formatted(formatOf(cell), value) ?? SSF.format(0, value, formatOptions),
    numeric: true
  })

  /** A text, through the text section of its cell's format, which can write a title after a name or wrap it in brackets. */
  const textCell = (text: string, cell: RawCell): SheetCell => ({ text: formatOf(cell) === 0 ? text : (formatted(formatOf(cell), text) ?? text), numeric: false })

  /** A cell's value as SheetJS reads it, and as its format shows it. */
  function cellOf(cell: RawCell, table: SharedStrings | null): SheetCell {
    if (cell.type === 'inlineStr') return cell.inline === undefined ? { text: '', numeric: false } : textCell(itemText(cell.inline), cell)
    const { value } = cell
    if (value === undefined) return { text: '', numeric: false }
    switch (cell.type) {
      case 's':
        return textCell(sharedString(table, value), cell)
      case 'str':
        return textCell(unescapeXml(value), cell)
      case 'e':
        return { text: unescapeXml(value), numeric: false }
      case 'b':
        return { text: ['1', 'true'].includes(value) ? 'TRUE' : 'FALSE', numeric: false }
      case 'd':
        return numberCell(dateSerial(unescapeXml(value), workbook.date1904), cell)
      default: {
        const number = Number(unescapeXml(value))
        if (Number.isNaN(number)) throw damaged()
        return numberCell(number, cell)
      }
    }
  }

  /** The rows numbered from `from` up to `to`, each with the columns from `firstColumn`, empty rows included. */
  async function rowsOf(loaded: LoadedSheet, from: number, to: number, firstColumn: number, columns: number): Promise<SheetCell[][]> {
    const table = await sharedStrings()
    const { first, last } = rowsWithin(loaded.index, from, to)
    const empty = (): SheetCell[] => Array.from({ length: columns }, () => ({ text: '', numeric: false }))
    const rows = Array.from({ length: to - from }, empty)
    for (let position = first; position < last; position++) {
      const row = rows[loaded.index.numbers[position] - from]
      const xml = decoder.decode(loaded.xml.subarray(loaded.index.starts[position], loaded.index.ends[position]))
      for (const cell of parseCells(xml)) {
        const column = cell.column - firstColumn
        if (column >= 0 && column < columns) row[column] = cellOf(cell, table)
      }
    }
    return rows
  }

  const shownColumns = (loaded: LoadedSheet): number => {
    const { used } = loaded.index
    return used ? Math.min(used.lastColumn - used.firstColumn + 1, SHOWN_COLUMNS) : 0
  }

  return {
    version: zip.version,
    methods: {
      sheets: (): string[] => workbook.sheets.map(({ name }) => name),

      async sheet(sheet: number): Promise<SheetSummary> {
        const loaded = await load(sheet)
        if (!loaded) return { shows: 'tooLarge' }
        const { used } = loaded.index
        if (!used) return { shows: 'rows', header: [], rowCount: 0, columnCount: 0 }
        const [header] = await rowsOf(loaded, used.firstRow, used.firstRow + 1, used.firstColumn, shownColumns(loaded))
        return {
          shows: 'rows',
          header: header.map((cell) => cell.text),
          rowCount: used.lastRow - used.firstRow,
          columnCount: used.lastColumn - used.firstColumn + 1
        }
      },

      /** Rows below the header, counted from 0 at the first of them, as many as there are up to `count`. */
      async rows({ sheet, from, count }: { sheet: number; from: number; count: number }): Promise<SheetCell[][]> {
        const loaded = await load(sheet)
        if (!loaded?.index.used) return []
        const { used } = loaded.index
        const start = used.firstRow + 1 + from
        const end = Math.min(start + count, used.lastRow + 1)
        return end > start ? rowsOf(loaded, start, end, used.firstColumn, shownColumns(loaded)) : []
      }
    },
    close(): void {
      shown = null
      loading = null
      strings = null
    }
  }
}

export default openXlsx satisfies OpenPreviewDocument
