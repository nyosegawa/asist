// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileItem } from '@shared/files'
import { FileViewer } from '@/panels/viewers'
import { workbookOf } from './helpers/workbook'

/**
 * An Excel file saved again while the files card shows it. The viewers reach the preview page through the real
 * client, and the page's side runs in the test on a MessageChannel, one for each frame the client starts, so that a
 * test can end a frame as a crash does. The server gives the file an ETag, as asist-file does, so that a file saved
 * again at the same length is told from the old one.
 */

/** The page's end of each frame's channel, in the order the client started them. */
const frames = vi.hoisted(() => [] as MessagePort[])

vi.mock('@/panels/viewers/preview-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/panels/viewers/preview-client')>()
  const { servePreview } = await import('@/preview/serve')
  const client = actual.createPreviewClient(() => {
    const { port1, port2 } = new MessageChannel()
    servePreview(port2, { './methods/xlsx.ts': () => import('@/preview/methods/xlsx') })
    frames.push(port2)
    return { port: port1, gone: new Promise((resolve) => port1.addEventListener('close', () => resolve())), remove: () => undefined }
  })
  return { ...actual, openPreviewDocument: (kind: string, file: Parameters<typeof client.open>[1]) => client.open(kind, file) }
})

const URL = 'asist-file:///Users/me/sales.xlsx'
let file = new Uint8Array()
/** The ETag the server gives the file, which asist-file makes of its length and time of change. */
let etag = ''
let saves = 0

/**
 * A sheet whose rows each hold its marker and their number, 2,000 of them, about 90 KB stored, so that a sheet lies
 * outside the last 64 KB the reader keeps from when it opened the file, and reading it reaches the file as it is now.
 */
const rowsOf = (marker: string): string =>
  Array.from({ length: 2000 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>${marker}-${i}</t></is></c></row>`).join('')

/** Writes the file again, as an app that saves it does, at a new time of change. Every part is stored, so that markers of one length make files of one length. */
async function save(sheets: Array<[name: string, marker: string]>): Promise<void> {
  file = await workbookOf({ sheets: sheets.map(([name, marker]) => ({ name, data: rowsOf(marker) })), store: true })
  etag = `"${file.length}-${++saves}"`
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
  vi.stubGlobal('ImageBitmap', class {})
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    const range = /^bytes=(\d*)-(\d*)$/.exec(new Headers(init?.headers).get('range') ?? '')!
    const suffix = range[1] === ''
    const start = suffix ? Math.max(0, file.length - Number(range[2])) : Number(range[1])
    const end = suffix || range[2] === '' ? file.length - 1 : Math.min(Number(range[2]), file.length - 1)
    return new Response(file.slice(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${file.length}`, ETag: etag } })
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

/** Waits until the check passes, at most about a second and a half. */
async function until(check: () => void): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      check()
      return
    } catch (error) {
      if (i >= 150) throw error
    }
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
  }
}

/** The card and the focus view of the same item, each in a box of its own. */
async function show(item: FileItem, views: Array<'card' | 'focus'>): Promise<void> {
  await act(async () => {
    root.render(
      <>
        {views.map((mode) => (
          <div key={mode} className={`view-${mode}`}>
            <FileViewer item={item} mode={mode} size={mode === 'card' ? 'l' : 'focus'} />
          </div>
        ))}
      </>
    )
  })
}

/** The header and the first row below it. */
const top = (mode: 'card' | 'focus'): string[] =>
  [...container.querySelectorAll(`.view-${mode} .fv-table th, .view-${mode} .fv-table tbody:not([aria-hidden]) tr`)].slice(0, 2).map((cell) => cell.textContent ?? '')
const tabs = (mode: 'card' | 'focus'): string[] => [...container.querySelectorAll(`.view-${mode} .fv-xlsx-tabs button`)].map((tab) => tab.textContent ?? '')
const current = (mode: 'card' | 'focus'): string | null => container.querySelector(`.view-${mode} .fv-xlsx-tabs button[data-current="true"]`)?.textContent ?? null
const errors = (): string[] => [...container.querySelectorAll('.fv-note[data-tone="error"]')].map((note) => note.textContent ?? '')

async function choose(mode: 'card' | 'focus', name: string): Promise<void> {
  const tab = [...container.querySelectorAll<HTMLButtonElement>(`.view-${mode} .fv-xlsx-tabs button`)].find((button) => button.textContent === name)!
  await act(async () => tab.click())
}

const itemOf = (modifiedAt: number): FileItem => ({ path: '/Users/me/sales.xlsx', name: 'sales.xlsx', kind: 'xlsx', sizeBytes: file.length, modifiedAt, url: URL })

describe('an Excel file saved again while it is shown', () => {
  it('shows the workbook as it is now in the card and the focus view once a read finds it saved again', async () => {
    await save([['1月', 'ONE'], ['2月', 'TWO']])
    const item = itemOf(1)
    await show(item, ['card'])
    await until(() => expect(top('card')).toEqual(['ONE-0', 'ONE-1']))

    // The card's item keeps the size and time of the file as it was listed.
    await save([['1月', 'ONE-NEW'], ['2月', 'TWO-NEW']])
    await show(item, ['card', 'focus'])
    await until(() => expect(top('focus')).toEqual(['ONE-0', 'ONE-1']))
    await choose('focus', '2月')
    await until(() => expect(top('focus')).toEqual(['TWO-NEW-0', 'TWO-NEW-1']))
    await until(() => expect(top('card')).toEqual(['ONE-NEW-0', 'ONE-NEW-1']))
    expect(current('focus')).toBe('2月')
    expect(errors()).toEqual([])
  })

  it('keeps the chosen sheet by its name when a frame started after the last one stopped finds a sheet added in front of it', async () => {
    await save([['1月', 'ONE'], ['2月', 'TWO']])
    await show(itemOf(2), ['focus'])
    await until(() => expect(tabs('focus')).toEqual(['1月', '2月']))
    await choose('focus', '2月')
    await until(() => expect(top('focus')).toEqual(['TWO-0', 'TWO-1']))

    frames.at(-1)!.close()
    await save([['集計', 'SUM'], ['1月', 'ONE'], ['2月', 'TWO-NEW']])
    // Scrolling far down the sheet asks the new frame for rows, and its answer comes from the file as it is now.
    const grid = container.querySelector<HTMLElement>('.view-focus .fv-xlsx-grid')!
    Object.defineProperty(grid, 'clientHeight', { value: 280 })
    grid.scrollTop = 28 + 1500 * 28
    await act(async () => grid.dispatchEvent(new Event('scroll')))
    await until(() => expect(tabs('focus')).toEqual(['集計', '1月', '2月']))
    expect(current('focus')).toBe('2月')
    await until(() => expect(top('focus')).toEqual(['TWO-NEW-0', 'TWO-NEW-1']))
    expect(errors()).toEqual([])
  })

  it('opens the workbook again when it was saved at the same length, which only its ETag tells', async () => {
    await save([['1月', 'AAAA'], ['2月', 'BBBB']])
    const item = itemOf(3)
    await show(item, ['card', 'focus'])
    await until(() => expect(top('card')).toEqual(['AAAA-0', 'AAAA-1']))

    const length = file.length
    await save([['1月', 'CCCC'], ['2月', 'DDDD']])
    expect(file.length).toBe(length)
    await choose('focus', '2月')
    await until(() => expect(top('focus')).toEqual(['DDDD-0', 'DDDD-1']))
    await until(() => expect(top('card')).toEqual(['CCCC-0', 'CCCC-1']))
    expect(errors()).toEqual([])
  })
})
