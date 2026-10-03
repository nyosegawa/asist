// @vitest-environment happy-dom
import React, { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FileItem } from '@shared/files'
import { fitToWidth, PdfViewer } from '@/panels/viewers/PdfViewer'
import { ScrollRoot } from '@/panels/viewers/use-near'
import { LayoutIntersectionObserver } from './helpers/intersection-observer'

/**
 * What the PDF viewer leaves held in the preview page, through the real preview client and the real side of the
 * preview page (serve.ts), joined by a MessageChannel, with a kind standing in for the PDF one that notes the drawings
 * it holds. The card of a file and its focus view share one document, so the card keeps it open after the focus view
 * closes, and whatever the focus view did not release stays held for as long as the card is shown.
 */

const page = vi.hoisted(() => ({ held: new Map<number, number>() }))

vi.mock('@/panels/viewers/preview-client', async () => {
  const actual = await vi.importActual<typeof import('@/panels/viewers/preview-client')>('@/panels/viewers/preview-client')
  const { servePreview } = await vi.importActual<typeof import('@/preview/serve')>('@/preview/serve')
  const openStandIn = async () => ({
    methods: {
      summary: () => ({ pageCount: 40, firstPage: { width: 595, height: 842 } }),
      size: () => ({ width: 595, height: 842 }),
      draw: ({ id, number, scale }: { id: number; number: number; scale: number }) => {
        page.held.set(id, number)
        return { bitmap: { width: Math.round(595 * scale), height: Math.round(842 * scale) }, pictureLeftOut: false }
      },
      release: (id: number) => void page.held.delete(id)
    }
  })
  const client = actual.createPreviewClient(() => {
    const { port1, port2 } = new MessageChannel()
    servePreview(port2, { './methods/pdf.ts': async () => ({ default: openStandIn as never }) })
    return { port: port1, gone: new Promise<void>(() => undefined), remove: () => undefined }
  })
  return {
    ...actual,
    openPreviewDocument: (kind: string, file: never) => {
      const handle = client.open(kind, file)
      return {
        ...handle,
        // A bitmap that crossed the channel lost its close(), which an ImageBitmap has.
        call: async (method: never, args: never) => {
          const value = (await handle.call(method, args)) as { bitmap?: object } | null
          return method === 'draw' && value ? { ...value, bitmap: { ...value.bitmap, close: () => undefined } } : value
        }
      }
    }
  }
})

const BOX_WIDTH = 600
const PAGE_STEP = fitToWidth({ width: 595, height: 842 }, BOX_WIDTH - 20).height + 30

let cardContainer: HTMLDivElement
let focusContainer: HTMLDivElement
let cardRoot: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('devicePixelRatio', 2)
  vi.stubGlobal('ImageBitmap', class {})
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
  vi.stubGlobal('IntersectionObserver', LayoutIntersectionObserver)
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => BOX_WIDTH })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ transferFromImageBitmap: () => undefined }) as never)
  cardContainer = document.createElement('div')
  focusContainer = document.createElement('div')
  document.body.append(cardContainer, focusContainer)
  cardRoot = createRoot(cardContainer)
})
afterEach(async () => {
  await act(async () => cardRoot.unmount())
  cardContainer.remove()
  focusContainer.remove()
  LayoutIntersectionObserver.reset()
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const item: FileItem = { path: '/Users/me/report.pdf', name: 'report.pdf', kind: 'pdf', sizeBytes: 95_000_000, modifiedAt: 1_790_000_000_000, url: 'asist-file:///Users/me/report.pdf' }

/** Lets the messages cross the channel and the effects they start run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

function Focus(): React.JSX.Element {
  const scroller = useRef<HTMLDivElement>(null)
  return (
    <div ref={scroller} className="scroller" style={{ overflowY: 'auto' }}>
      <ScrollRoot.Provider value={scroller}>
        <PdfViewer item={item} mode="focus" size="focus" />
      </ScrollRoot.Provider>
    </div>
  )
}

/** Lays the focus view out 680 px tall from y = 100 of the window, scrolled down by `scrolled`. */
function layOutFocus(scrolled: number): void {
  const place = (element: Element, top: number, height: number): void => {
    element.getBoundingClientRect = () => ({ top, bottom: top + height, left: 0, right: BOX_WIDTH, width: BOX_WIDTH, height, x: 0, y: top }) as DOMRect
  }
  place(focusContainer.querySelector('.scroller')!, 100, 680)
  for (const element of focusContainer.querySelectorAll<HTMLElement>('.fv-pdf-page')) {
    place(element, 100 + 40 + (Number(element.dataset.page) - 1) * PAGE_STEP - scrolled, PAGE_STEP - 10)
  }
}

it('releases in the preview page the drawings of a focus view that closes while the card of the same file stays', async () => {
  await act(async () => cardRoot.render(<PdfViewer item={item} mode="card" size="l" />))
  await settle()
  const card = new Map(page.held)
  expect([...card.values()]).toEqual([1])

  for (const scrolled of [10 * PAGE_STEP, 25 * PAGE_STEP]) {
    const focusRoot = createRoot(focusContainer)
    await act(async () => focusRoot.render(<Focus />))
    await settle()
    layOutFocus(scrolled)
    await act(async () => LayoutIntersectionObserver.update())
    await settle()
    expect(page.held.size).toBeGreaterThan(card.size)
    await act(async () => focusRoot.unmount())
    await settle()
    expect(page.held).toEqual(card)
  }
})
