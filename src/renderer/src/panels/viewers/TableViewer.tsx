import { Frame } from './Frame'
import type { Viewer } from './types'
import { useT } from '@/i18n'

/**
 * The delimiter follows the extension, a tab for tsv, and a delimiter or a newline inside quotes belongs to
 * the cell. A card stops at 20 rows and the focus view at 500.
 */
const CARD_ROWS = 20
const FOCUS_ROWS = 500

export function parseDelimited(text: string, delimiter: ',' | '\t'): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        cell += ch
      }
      continue
    }
    if (ch === '"') {
      quoted = true
    } else if (ch === delimiter) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else {
      cell += ch
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''))
}

const isNumeric = (value: string): boolean => /^-?[\d,]+(\.\d+)?%?$/.test(value.trim()) && value.trim() !== ''

export const TableViewer: Viewer = ({ item, mode, size }) => {
  const t = useT()
  const delimiter = item.name.toLowerCase().endsWith('.tsv') ? '\t' : ','
  const rows = parseDelimited(item.text ?? '', delimiter)
  const [header, ...body] = rows
  const limit = mode === 'card' ? CARD_ROWS : FOCUS_ROWS
  const shown = body.slice(0, limit)
  const rest = body.length - shown.length
  if (!header) {
    return (
      <Frame mode={mode} size={size}>
        <p className="fv-note">{t('files.viewer.emptyTable')}</p>
      </Frame>
    )
  }
  return (
    <Frame mode={mode} size={size}>
      <table className="fv-table">
        <thead>
          <tr>
            {header.map((cell, i) => (
              <th key={i}>{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, r) => (
            <tr key={r}>
              {header.map((_, c) => (
                <td key={c} data-numeric={isNumeric(row[c] ?? '') ? 'true' : undefined}>
                  {row[c] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {(rest > 0 || item.truncated) && (
        <p className="fv-note">
          {rest > 0 ? t('files.viewer.moreLines', { count: rest }) : ''}
          {item.truncated ? t('files.viewer.truncated') : ''}
        </p>
      )}
    </Frame>
  )
}
