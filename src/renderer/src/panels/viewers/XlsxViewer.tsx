import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FileItem } from '@shared/files'
import { errorText } from '@shared/i18n/error-text'
import type openXlsx from '@/preview/methods/xlsx'
import type { SheetCell, SheetSummary } from '@/preview/methods/xlsx'
import { displayError } from '@/display-error'
import { Frame } from './Frame'
import { openPreviewDocument, type PreviewHandle } from './preview-client'
import type { Viewer, ViewerProps } from './types'
import './XlsxViewer.css'
import { useT } from '@/i18n'

/**
 * Excel (xlsx / xlsm) drawn as a table, with a small tab per sheet. The first row with a value becomes the header
 * and numeric cells are right-aligned. A cell's text is the value as Excel's display format renders it. The
 * workbook is read in the preview iframe (preview/methods/xlsx.ts), which reads only the sheet shown. A card shows
 * its first 20 rows; the focus view shows every row in a grid that scrolls on its own and asks the iframe only for
 * the rows within a screen of what it shows.
 */
const CARD_ROWS = 20
/** The rows the focus view asks the iframe for at once. */
const BLOCK_ROWS = 100
/**
 * How many blocks the focus view asks for at a time, nearest the view first. Dragging the scrollbar far would
 * otherwise ask for every block it passes, and the iframe would parse each before the one the view stopped at.
 */
const BLOCKS_ASKED = 2
/** The height of every row of the focus view's grid, in which the text of a cell fits on one line. */
const ROW_PX = 28

type Workbook = PreviewHandle<typeof openXlsx>

type Loaded<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; value: T }

/** A workbook open in the preview iframe, its sheets, and how many times they have been answered. */
interface OpenWorkbook {
  workbook: Workbook | null
  sheets: Loaded<string[]>
  answer: number
}

/**
 * Makes a request of the workbook, and makes it once more when the preview page stopped before it answered, as it
 * does when the file of another viewer takes the shared frame down: the next request starts a new frame.
 */
async function asking<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request()
  } catch (error) {
    if (!(error instanceof Error) || error.message !== errorText('files.errors.previewStopped')) throw error
    return request()
  }
}

/**
 * Holds the workbook open in the preview iframe while the viewer shows it, and lists its sheets. Everything the
 * viewer shows below the list is asked for again after each answer, `answer` counting them, since the rows depend
 * on the order of the sheets and on where each one's values start. A file without a URL has nothing to open.
 */
function useWorkbook({ url, sizeBytes, modifiedAt }: FileItem): OpenWorkbook {
  const [state, setState] = useState<OpenWorkbook>({ workbook: null, sheets: { status: 'loading' }, answer: 0 })
  useEffect(() => {
    if (!url) return
    let cancelled = false
    const workbook = openPreviewDocument<typeof openXlsx>('xlsx', { url, sizeBytes, modifiedAt })
    setState((known) => ({ workbook, sheets: { status: 'loading' }, answer: known.answer }))
    asking(() => workbook.call('sheets', undefined)).then(
      (sheets) => !cancelled && setState((known) => ({ workbook, sheets: { status: 'ready', value: sheets }, answer: known.answer + 1 })),
      (error: unknown) => !cancelled && setState((known) => ({ workbook, sheets: { status: 'error', message: displayError(error) }, answer: known.answer }))
    )
    return () => {
      cancelled = true
      workbook.release()
    }
  }, [url, sizeBytes, modifiedAt])
  return state
}

/** The answer to a request of the workbook, made again whenever `request` changes and forgotten when it arrives after that. */
function useAnswer<T>(request: () => Promise<T>): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({ status: 'loading' })
  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    asking(request).then(
      (value) => !cancelled && setState({ status: 'ready', value }),
      (error: unknown) => !cancelled && setState({ status: 'error', message: displayError(error) })
    )
    return () => {
      cancelled = true
    }
  }, [request])
  return state
}

function Failure({ message }: { message: string }): React.JSX.Element {
  const t = useT()
  return (
    <p className="fv-note" data-tone="error">
      {t('files.viewer.xlsxFailed', { message })}
    </p>
  )
}

function Cells({ row }: { row: SheetCell[] }): React.JSX.Element {
  return (
    <>
      {row.map((cell, c) => (
        <td key={c} data-numeric={cell.numeric ? 'true' : undefined}>
          {cell.text}
        </td>
      ))}
    </>
  )
}

/** The first rows of the sheet in the card, which scrolls inside its frame. */
function CardTable({ workbook, sheet, summary }: { workbook: Workbook; sheet: number; summary: Extract<SheetSummary, { shows: 'rows' }> }): React.JSX.Element {
  const t = useT()
  const rows = useAnswer(useCallback(() => workbook.call('rows', { sheet, from: 0, count: CARD_ROWS }), [workbook, sheet]))
  if (rows.status === 'loading') return <p className="fv-note">{t('files.viewer.loading')}</p>
  if (rows.status === 'error') return <Failure message={rows.message} />
  const rest = summary.rowCount - rows.value.length
  return (
    <>
      <table className="fv-table">
        <thead>
          <tr>
            {summary.header.map((cell, i) => (
              <th key={i}>{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.value.map((row, r) => (
            <tr key={r}>
              <Cells row={row} />
            </tr>
          ))}
        </tbody>
      </table>
      {rest > 0 && <p className="fv-note">{t('files.viewer.moreLines', { count: rest })}</p>}
    </>
  )
}

/**
 * A row of the focus view's grid, drawn empty until its block arrives, and marked as loading unless its block could
 * not be read. It is drawn again only when its own cells change, so that a block that arrives or a screen of
 * scrolling draws only the rows it brings.
 */
const GridRow = memo(function GridRow({
  index,
  row,
  failed,
  columns
}: {
  index: number
  row: SheetCell[] | undefined
  failed: boolean
  columns: number
}): React.JSX.Element {
  return (
    <tr aria-rowindex={index + 2} data-loading={row || failed ? undefined : 'true'} style={{ height: ROW_PX }}>
      {row ? <Cells row={row} /> : Array.from({ length: columns }, (_, c) => <td key={c} />)}
    </tr>
  )
})

/**
 * Every row of the sheet in the focus view, in a grid that scrolls on its own under a header that stays. Only the
 * rows within a screen of what the grid shows are drawn, and the blocks of rows that move further away are let go.
 * A row whose block has not arrived yet is drawn empty and marked as loading, and a block that cannot be read is said
 * so under the grid and asked for again once the grid has scrolled away from it and back. Every row has the height
 * ROW_PX, so that where a row lies is counted rather than measured: a height measured from the rows was off by a
 * fraction of a pixel, which 50,000 rows made into more than a screen. A column keeps the widest it has been, so that
 * the columns do not move as rows of other widths scroll past.
 */
function FocusGrid({ workbook, sheet, summary }: { workbook: Workbook; sheet: number; summary: Extract<SheetSummary, { shows: 'rows' }> }): React.JSX.Element {
  const scroller = useRef<HTMLDivElement>(null)
  const head = useRef<HTMLTableSectionElement>(null)
  const [view, setView] = useState({ top: 0, height: 0 })
  const [headPx, setHeadPx] = useState(ROW_PX)
  const [widths, setWidths] = useState<number[]>([])
  const [blocks, setBlocks] = useState<ReadonlyMap<number, SheetCell[][]>>(new Map())
  /** Why each block near the view could not be read. */
  const [failures, setFailures] = useState<ReadonlyMap<number, string>>(new Map())
  /** Counts the answers, so that each one lets the next block be asked for. */
  const [answered, setAnswered] = useState(0)
  const { rowCount, header } = summary

  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    const measure = (): void => setView({ top: element.scrollTop, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const screen = Math.max(1, Math.ceil(view.height / ROW_PX))
  const topRow = Math.min(rowCount - 1, Math.floor(Math.max(0, view.top - headPx) / ROW_PX))
  // The first row drawn is always an even one, so that the stripes of the rows stay on the same rows as they scroll.
  const first = Math.max(0, topRow - screen) & ~1
  const last = Math.min(rowCount, topRow + 2 * screen + 1)
  const firstBlock = Math.floor(first / BLOCK_ROWS)
  const lastBlock = Math.floor((last - 1) / BLOCK_ROWS)
  const wanted = useRef({ firstBlock, lastBlock })
  const asked = useRef(new Set<number>())

  const topBlock = Math.floor(topRow / BLOCK_ROWS)

  useEffect(() => {
    wanted.current = { firstBlock, lastBlock }
    const near = (block: number): boolean => block >= wanted.current.firstBlock && block <= wanted.current.lastBlock
    const nearOnly = <T,>(held: ReadonlyMap<number, T>): ReadonlyMap<number, T> =>
      [...held.keys()].every(near) ? held : new Map([...held].filter(([block]) => near(block)))
    setBlocks(nearOnly)
    setFailures(nearOnly)
    const nearest = Array.from({ length: lastBlock - firstBlock + 1 }, (_, i) => firstBlock + i).sort((a, b) => Math.abs(a - topBlock) - Math.abs(b - topBlock))
    for (const block of nearest) {
      if (asked.current.size >= BLOCKS_ASKED) break
      if (asked.current.has(block) || blocks.has(block) || failures.has(block)) continue
      asked.current.add(block)
      // A block the grid scrolled away from while it was read is not kept, and neither is why it could not be.
      asking(() => workbook.call('rows', { sheet, from: block * BLOCK_ROWS, count: BLOCK_ROWS })).then(
        (rows) => {
          asked.current.delete(block)
          if (near(block)) setBlocks((held) => new Map(held).set(block, rows))
          setAnswered((count) => count + 1)
        },
        (error: unknown) => {
          asked.current.delete(block)
          if (near(block)) setFailures((held) => new Map(held).set(block, displayError(error)))
          setAnswered((count) => count + 1)
        }
      )
    }
  }, [workbook, sheet, firstBlock, lastBlock, topBlock, blocks, failures, answered])

  useLayoutEffect(() => {
    const section = head.current
    if (!section) return
    if (section.offsetHeight > 0 && section.offsetHeight !== headPx) setHeadPx(section.offsetHeight)
    const measured = Array.from(section.querySelectorAll('th'), (cell) => cell.offsetWidth)
    setWidths((known) => (measured.some((width, c) => width > (known[c] ?? 0)) ? measured.map((width, c) => Math.max(width, known[c] ?? 0)) : known))
  })

  const shown = Array.from({ length: Math.max(0, last - first) }, (_, i) => first + i)
  const spacer = (rows: number): React.JSX.Element | null =>
    rows > 0 ? (
      <tbody className="fv-xlsx-spacer" aria-hidden="true">
        <tr>
          <td colSpan={header.length} style={{ height: rows * ROW_PX }} />
        </tr>
      </tbody>
    ) : null
  const failure = failures.values().next()
  return (
    <>
      <div ref={scroller} className="fv-xlsx-grid" onScroll={(event) => setView({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}>
        <table className="fv-table" aria-rowcount={rowCount + 1}>
          <thead ref={head}>
            <tr aria-rowindex={1}>
              {header.map((cell, i) => (
                <th key={i} style={widths[i] ? { minWidth: widths[i] } : undefined}>
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          {spacer(first)}
          <tbody>
            {shown.map((r) => (
              <GridRow
                key={r}
                index={r}
                row={blocks.get(Math.floor(r / BLOCK_ROWS))?.[r % BLOCK_ROWS]}
                failed={failures.has(Math.floor(r / BLOCK_ROWS))}
                columns={header.length}
              />
            ))}
          </tbody>
          {spacer(rowCount - last)}
        </table>
      </div>
      {!failure.done && <Failure message={failure.value} />}
    </>
  )
}

/** One sheet of the workbook: what it holds, read when the sheet is chosen, and its rows in the card or the focus view. */
function Sheet({ workbook, sheet, mode }: { workbook: Workbook; sheet: number; mode: ViewerProps['mode'] }): React.JSX.Element {
  const t = useT()
  const summary = useAnswer(useCallback(() => workbook.call('sheet', sheet), [workbook, sheet]))
  if (summary.status === 'loading') return <p className="fv-note">{t('files.viewer.loading')}</p>
  if (summary.status === 'error') return <Failure message={summary.message} />
  const shown = summary.value
  if (shown.shows === 'tooLarge') return <p className="fv-note">{t('files.viewer.tooLarge')}</p>
  if (shown.header.length === 0) return <p className="fv-note">{t('files.viewer.emptySheet')}</p>
  const restColumns = shown.columnCount - shown.header.length
  return (
    <>
      {mode === 'card' ? <CardTable workbook={workbook} sheet={sheet} summary={shown} /> : <FocusGrid workbook={workbook} sheet={sheet} summary={shown} />}
      {restColumns > 0 && <p className="fv-note">{t('files.viewer.moreColumns', { count: restColumns })}</p>}
    </>
  )
}

export const XlsxViewer: Viewer = ({ item, mode, size }) => {
  const t = useT()
  const { workbook, sheets, answer } = useWorkbook(item)
  const [active, setActive] = useState(0)
  if (!item.url) {
    return (
      <Frame mode={mode} size={size}>
        <p className="fv-note" data-tone="error">
          {t('files.viewer.urlMissing')}
        </p>
      </Frame>
    )
  }
  if (sheets.status === 'error') {
    return (
      <Frame mode={mode} size={size}>
        <Failure message={sheets.message} />
      </Frame>
    )
  }
  if (sheets.status !== 'ready' || workbook === null) {
    return (
      <Frame mode={mode} size={size}>
        <p className="fv-note">{t('files.viewer.loading')}</p>
      </Frame>
    )
  }
  const sheet = Math.min(active, sheets.value.length - 1)
  return (
    <Frame mode={mode} size={size}>
      {sheets.value.length > 1 && (
        <ul className="fv-xlsx-tabs" role="tablist">
          {sheets.value.map((name, i) => (
            <li key={i}>
              <button type="button" role="tab" aria-selected={i === sheet} data-current={i === sheet ? 'true' : undefined} onClick={() => setActive(i)}>
                {name}
              </button>
            </li>
          ))}
        </ul>
      )}
      <Sheet key={`${answer} ${sheet}`} workbook={workbook} sheet={sheet} mode={mode} />
    </Frame>
  )
}
