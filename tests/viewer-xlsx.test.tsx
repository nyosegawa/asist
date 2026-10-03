// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTranslator } from '@shared/i18n'
import { errorKey } from '@shared/i18n/error-key'
import { errorText, readErrorText } from '@shared/i18n/error-text'
import type { FileItem } from '@shared/files'
import { DEMO_OFFICE_ITEMS } from '@/demo/fixtures/files-office'
import { FileViewer } from '@/panels/viewers'
import { createPreviewClient, type PreviewFile, type PreviewHandle } from '@/panels/viewers/preview-client'
import { PART_LIMIT } from '@/preview/methods/xlsx'
import { servePreview, type OpenPreviewDocument } from '@/preview/serve'
import { declareSize, serveByRanges, workbookOf } from './helpers/workbook'

/**
 * The Excel viewer, with the preview page served in this process on a channel of its own instead of in an iframe,
 * so that the viewer reaches the real Excel document. The workbook is served to fetch by ranges. Each request the
 * viewer makes of the document is recorded, and a test can hold the answers back or make a request fail.
 */

const preview = vi.hoisted(() => ({ open: null as null | ((kind: string, file: PreviewFile) => PreviewHandle<OpenPreviewDocument>) }))
vi.mock('@/panels/viewers/preview-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/panels/viewers/preview-client')>()),
  openPreviewDocument: (kind: string, file: PreviewFile) => preview.open!(kind, file)
}))

const t = createTranslator('ja-JP')
const kinds = import.meta.glob<{ default: OpenPreviewDocument }>('../src/renderer/src/preview/methods/*.ts')
const demoItem = DEMO_OFFICE_ITEMS.find((office) => office.kind === 'xlsx')!
const demoFile = new Uint8Array(readFileSync(resolve('src/renderer/demo-public', `.${demoItem.url}`)))
const itemOf = (name: string): FileItem => ({ path: `/Users/me/${name}`, name, kind: 'xlsx', sizeBytes: 1000, modifiedAt: 1_790_000_000_000, url: `asist-file:///Users/me/${name}` })

let container: HTMLDivElement
let root: Root
let requests: Array<{ method: string; args: unknown }>
/** What every answer waits for before it reaches the viewer, as it does while the frame is busy parsing. */
let held: Promise<void>
/** The error a request fails with instead of being answered, as when the frame stops or a part cannot be read. */
let failure: (method: string, args: unknown) => Error | null

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
  // The page's side looks for bitmaps among what it returns.
  vi.stubGlobal('ImageBitmap', class {})
  requests = []
  held = Promise.resolve()
  failure = () => null
  const client = createPreviewClient(() => {
    const { port1, port2 } = new MessageChannel()
    servePreview(port2, kinds)
    return { port: port1, gone: new Promise<void>(() => undefined), remove: () => port2.close() }
  })
  preview.open = (kind, file) => {
    const handle = client.open<OpenPreviewDocument>(kind, file)
    return {
      call: async (method, args) => {
        requests.push({ method, args })
        const error = failure(method, args)
        if (error) throw error
        const value = await handle.call(method, args)
        await held
        return value
      },
      onChanged: (listener) => handle.onChanged(listener),
      release: () => handle.release()
    }
  }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

/** Opens the focus view of a sheet of `count` rows below its header, and gives its grid a height of ten rows. */
async function focusOnRows(count: number): Promise<HTMLElement> {
  const rows = Array.from({ length: count }, (_, i) => `<row r="${i + 2}"><c r="A${i + 2}" t="inlineStr"><is><t>行${i}</t></is></c></row>`).join('')
  serveByRanges(await workbookOf({ sheets: [{ name: '明細', data: `<row r="1"><c r="A1" t="inlineStr"><is><t>番号</t></is></c></row>${rows}` }] }))
  await render(<FileViewer item={itemOf('明細.xlsx')} mode="focus" size="focus" />)
  const grid = container.querySelector<HTMLElement>('.fv-xlsx-grid')!
  Object.defineProperty(grid, 'clientHeight', { value: 280 })
  return grid
}

/**
 * Lets the requests the viewer made be answered and drawn: waits until nothing says it is loading, which the first
 * request of a run takes longest for, since it loads the Excel kind of the preview page.
 */
async function settle(): Promise<void> {
  const loading = t('files.viewer.loading')
  for (let waited = 0; waited < 5_000; waited += 10) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
    if (waited >= 40 && !container.textContent?.includes(loading) && !container.querySelector('tr[data-loading]')) return
  }
}

async function render(element: React.ReactNode): Promise<HTMLElement> {
  await act(async () => root.render(element))
  await settle()
  return container
}

const texts = (elements: Iterable<Element>): string[] => [...elements].map((element) => element.textContent ?? '')
const rowsAsked = (): unknown[] => requests.filter(({ method }) => method === 'rows').map(({ args }) => args)

describe('the Excel viewer', () => {
  it('switches sheets from the tabs and builds a table with a header row and right-aligned numbers', async () => {
    serveByRanges(demoFile)
    const frame = await render(<FileViewer item={demoItem} mode="card" size="l" />)
    const tabs = [...frame.querySelectorAll<HTMLButtonElement>('.fv-xlsx-tabs button')]
    expect(texts(tabs)).toEqual(['料金', 'ヒアリング'])
    expect(tabs[0].dataset.current).toBe('true')
    expect(texts(frame.querySelectorAll('.fv-table thead th'))).toEqual(['サービス', '月額(USD)', '同時接続', '無料枠', '更新日'])
    expect(frame.querySelectorAll('.fv-table tbody tr')).toHaveLength(6)
    expect(frame.querySelector('.fv-table tbody td:nth-child(2)')?.getAttribute('data-numeric')).toBe('true')
    expect(frame.querySelector('.fv-table tbody td:nth-child(1)')?.getAttribute('data-numeric')).toBeNull()
    await act(async () => tabs[1].click())
    await settle()
    expect(texts(frame.querySelectorAll('.fv-table thead th'))).toEqual(['日付', '相手', 'メモ'])
    expect(frame.querySelectorAll('.fv-table tbody tr')).toHaveLength(3)
  })

  it('opens one document for the card and the focus view of a file', async () => {
    const served = serveByRanges(demoFile)
    await render(
      <>
        <FileViewer item={demoItem} mode="card" size="l" />
        <FileViewer item={demoItem} mode="focus" size="focus" />
      </>
    )
    expect(container.querySelectorAll('.fv-table thead')).toHaveLength(2)
    // A document reads the end of the file once, for the zip's directory, when it opens.
    expect(served.ranges.filter(([, end]) => end === demoFile.length - 1)).toHaveLength(1)
  })

  it('shows every row in the focus view, asking only for the rows within a screen of the grid and letting go of those it scrolls away from', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => `<row r="${i + 2}"><c r="A${i + 2}" t="inlineStr"><is><t>行${i}</t></is></c></row>`).join('')
    serveByRanges(await workbookOf({ sheets: [{ name: '明細', data: `<row r="1"><c r="A1" t="inlineStr"><is><t>番号</t></is></c></row>${rows}` }] }))
    await render(<FileViewer item={itemOf('明細.xlsx')} mode="focus" size="focus" />)
    const grid = container.querySelector<HTMLElement>('.fv-xlsx-grid')!
    expect(rowsAsked()).toEqual([{ sheet: 0, from: 0, count: 100 }])
    expect(container.textContent).not.toContain(t('files.viewer.moreLines', { count: 980 }))

    // Ten rows of 28px fit in the grid; it is scrolled to show the row 500 at its top, under the header.
    Object.defineProperty(grid, 'clientHeight', { value: 280 })
    grid.scrollTop = 28 + 500 * 28
    await act(async () => grid.dispatchEvent(new Event('scroll')))
    await settle()
    // The block in view first, then the one above it.
    expect(rowsAsked().slice(1)).toEqual([
      { sheet: 0, from: 500, count: 100 },
      { sheet: 0, from: 400, count: 100 }
    ])
    const drawn = [...grid.querySelectorAll<HTMLElement>('tbody:not([aria-hidden]) tr')]
    expect(drawn.map((row) => Number(row.getAttribute('aria-rowindex')) - 2)).toEqual(Array.from({ length: 31 }, (_, i) => 490 + i))
    expect(texts(drawn).slice(0, 2)).toEqual(['行490', '行491'])
    expect(drawn.every((row) => row.dataset.loading === undefined)).toBe(true)

    // The first block was let go, so coming back to the top asks for it again.
    grid.scrollTop = 0
    await act(async () => grid.dispatchEvent(new Event('scroll')))
    await settle()
    expect(rowsAsked().slice(3)).toEqual([{ sheet: 0, from: 0, count: 100 }])
    expect(texts(grid.querySelectorAll('tbody:not([aria-hidden]) tr')).slice(0, 2)).toEqual(['行0', '行1'])
  })

  it('asks only for the blocks near where the grid stops when it is dragged far, not for every block it passes', async () => {
    const grid = await focusOnRows(1000)
    let release = (): void => undefined
    held = new Promise((resolve) => (release = resolve))
    for (const row of [150, 350, 550, 750]) {
      grid.scrollTop = 28 + row * 28
      await act(async () => grid.dispatchEvent(new Event('scroll')))
    }
    release()
    await settle()
    expect(rowsAsked().slice(1)).toEqual([
      { sheet: 0, from: 100, count: 100 },
      { sheet: 0, from: 300, count: 100 },
      { sheet: 0, from: 700, count: 100 }
    ])
    expect(texts(grid.querySelectorAll('tbody:not([aria-hidden]) tr')).slice(0, 2)).toEqual(['行740', '行741'])
  })

  it('asks again once for rows the preview page stopped before answering, as when another file took its frame down', async () => {
    let stopped = false
    failure = (method) => (method === 'rows' && !stopped ? ((stopped = true), new Error(errorText('files.errors.previewStopped'))) : null)
    await focusOnRows(1000)
    expect(rowsAsked()).toEqual([
      { sheet: 0, from: 0, count: 100 },
      { sheet: 0, from: 0, count: 100 }
    ])
    expect(container.querySelector('.fv-note[data-tone="error"]')).toBeNull()
    expect(texts(container.querySelectorAll('.fv-xlsx-grid tbody:not([aria-hidden]) tr')).slice(0, 2)).toEqual(['行0', '行1'])
  })

  it('says a block of rows could not be read under the grid, shows the rows around it, and asks again once the grid comes back to it', async () => {
    const unreadable = errorText('files.errors.zipDamaged')
    failure = (method, args) => (method === 'rows' && (args as { from: number }).from === 300 ? new Error(unreadable) : null)
    const grid = await focusOnRows(1000)
    grid.scrollTop = 28 + 395 * 28
    await act(async () => grid.dispatchEvent(new Event('scroll')))
    await settle()
    expect(container.querySelector('.fv-note[data-tone="error"]')?.textContent).toBe(t('files.viewer.xlsxFailed', { message: readErrorText(unreadable, 'ja-JP')! }))
    expect(texts(grid.querySelectorAll('tbody:not([aria-hidden]) tr'))).toContain('行400')

    for (const row of [0, 395]) {
      grid.scrollTop = 28 + row * 28
      await act(async () => grid.dispatchEvent(new Event('scroll')))
      await settle()
    }
    expect(rowsAsked().filter((args) => (args as { from: number }).from === 300)).toHaveLength(2)
  })

  it('says a sheet too large to read is too large, and shows the other sheets', async () => {
    const sheets = [
      { name: '大きい', data: '<row r="1"><c r="A1"><v>1</v></c></row>' },
      { name: '小さい', data: '<row r="1"><c r="A1" t="inlineStr"><is><t>伝票番号</t></is></c></row><row r="2"><c r="A2"><v>2</v></c></row>' }
    ]
    serveByRanges(declareSize(await workbookOf({ sheets }), 'xl/worksheets/sheet1.xml', PART_LIMIT + 1))
    const frame = await render(<FileViewer item={itemOf('売上.xlsx')} mode="card" size="l" />)
    expect(frame.querySelector('.fv-note')?.textContent).toBe(t('files.viewer.tooLarge'))
    expect(frame.querySelector('.fv-table')).toBeNull()
    await act(async () => frame.querySelectorAll<HTMLButtonElement>('.fv-xlsx-tabs button')[1].click())
    await settle()
    expect(texts(frame.querySelectorAll('.fv-table th'))).toEqual(['伝票番号'])
  })

  it('shows why a file that is not a workbook could not be read', async () => {
    serveByRanges(new TextEncoder().encode('not a zip at all'))
    const frame = await render(<FileViewer item={itemOf('壊れた.xlsx')} mode="card" size="l" />)
    const note = frame.querySelector('.fv-note[data-tone="error"]')
    expect(note?.textContent).toBe(t('files.viewer.xlsxFailed', { message: readErrorText(errorKey('files.errors.zipDamaged'), 'ja-JP')! }))
  })
})
