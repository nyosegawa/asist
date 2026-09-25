import { useState } from 'react'
import * as XLSX from 'xlsx/dist/xlsx.mini.min.js'
import { Frame } from './Frame'
import type { Viewer } from './types'
import { useParsedBytes } from './use-parsed-bytes'
import './XlsxViewer.css'
import { useT } from '@/i18n'

/**
 * Excel (xlsx / xlsm) drawn as a table, with a small tab per sheet. The first row becomes the header and
 * numeric cells are right-aligned. A cell's text is the value as Excel's display format renders it (w). A
 * card shows the first 20 rows and the focus view up to 500.
 */
const CARD_ROWS = 20
const FOCUS_ROWS = 500

export interface SheetCell {
  text: string
  numeric: boolean
}
export interface SheetRows {
  name: string
  header: string[]
  rows: SheetCell[][]
}

/** Turns a sheet into a header and rows. An empty sheet gets neither. */
export function sheetToRows(name: string, sheet: XLSX.WorkSheet): SheetRows {
  if (!sheet['!ref']) return { name, header: [], rows: [] }
  const range = XLSX.utils.decode_range(sheet['!ref'])
  const grid: SheetCell[][] = []
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row: SheetCell[] = []
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined
      if (!cell || cell.v === undefined || cell.v === null) {
        row.push({ text: '', numeric: false })
        continue
      }
      row.push({ text: cell.w ?? String(cell.v), numeric: cell.t === 'n' })
    }
    grid.push(row)
  }
  const [header, ...rows] = grid
  return { name, header: header.map((cell) => cell.text), rows }
}

async function parseXlsx(bytes: ArrayBuffer): Promise<SheetRows[]> {
  const workbook = XLSX.read(new Uint8Array(bytes), { type: 'array' })
  return workbook.SheetNames.map((name) => sheetToRows(name, workbook.Sheets[name]))
}

export const XlsxViewer: Viewer = ({ item, mode, size }) => {
  const t = useT()
  const parsed = useParsedBytes(item, parseXlsx)
  const [active, setActive] = useState(0)
  if (parsed.status !== 'ready') {
    return (
      <Frame mode={mode} size={size}>
        {parsed.status === 'loading' ? (
          <p className="fv-note">{t('files.viewer.loading')}</p>
        ) : (
          <p className="fv-note" data-tone="error">
            {t('files.viewer.xlsxFailed', { message: parsed.message })}
          </p>
        )}
      </Frame>
    )
  }
  const sheets = parsed.value
  const sheet = sheets[Math.min(active, sheets.length - 1)]
  const limit = mode === 'card' ? CARD_ROWS : FOCUS_ROWS
  const shown = sheet.rows.slice(0, limit)
  const rest = sheet.rows.length - shown.length
  return (
    <Frame mode={mode} size={size}>
      {sheets.length > 1 && (
        <ul className="fv-xlsx-tabs" role="tablist">
          {sheets.map((entry, i) => (
            <li key={entry.name}>
              <button type="button" role="tab" aria-selected={entry === sheet} data-current={entry === sheet ? 'true' : undefined} onClick={() => setActive(i)}>
                {entry.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {sheet.header.length === 0 ? (
        <p className="fv-note">{t('files.viewer.emptySheet')}</p>
      ) : (
        <table className="fv-table">
          <thead>
            <tr>
              {sheet.header.map((cell, i) => (
                <th key={i}>{cell}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c} data-numeric={cell.numeric ? 'true' : undefined}>
                    {cell.text}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rest > 0 && <p className="fv-note">{t('files.viewer.moreLines', { count: rest })}</p>}
    </Frame>
  )
}
