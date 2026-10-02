// @vitest-environment happy-dom
import React, { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Frame } from '@/panels/viewers/Frame'
import { ScrollRoot, useNear } from '@/panels/viewers/use-near'
import { LayoutIntersectionObserver } from './helpers/intersection-observer'

/**
 * The watcher for "within a screen of the view", which PDF pages, slides and Word pictures use to draw only what
 * the user is about to see. The boxes of the scrolling box and the pages are given here, since happy-dom lays
 * nothing out, and an observer that computes intersections as a browser does stands in for the browser's.
 */

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
  vi.stubGlobal('IntersectionObserver', LayoutIntersectionObserver)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  LayoutIntersectionObserver.reset()
  vi.unstubAllGlobals()
})

function Page({ index }: { index: number }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const near = useNear(ref)
  return <div ref={ref} className="page" data-index={index} data-near={near ? 'true' : undefined} />
}

const pages = (count: number): React.JSX.Element[] => Array.from({ length: count }, (_, i) => <Page key={i} index={i} />)

/** Puts an element at a place in the window, from top to bottom, as the layout would. */
function place(element: Element, top: () => number, height: number): void {
  element.getBoundingClientRect = () => {
    const at = top()
    return { top: at, bottom: at + height, left: 0, right: 760, width: 760, height, x: 0, y: at } as DOMRect
  }
}

/** Lets the observers report, as a browser does after a frame. */
const frame = (): Promise<void> => act(async () => LayoutIntersectionObserver.update())

const nearPages = (): number[] => [...container.querySelectorAll<HTMLElement>('.page[data-near]')].map((page) => Number(page.dataset.index))

describe('the near-view watcher', () => {
  /** The focus view: a card that scrolls and clips, around a Frame that grows with its pages. */
  function FocusView({ children }: { children: React.ReactNode }): React.JSX.Element {
    const scroller = useRef<HTMLDivElement>(null)
    return (
      <div ref={scroller} className="scroller" style={{ overflowY: 'auto' }}>
        <ScrollRoot.Provider value={scroller}>
          <Frame mode="focus" size="focus">
            {children}
          </Frame>
        </ScrollRoot.Provider>
      </div>
    )
  }

  it('reports a page as near while it is still hidden below the box that scrolls, and as no longer near a screen away', async () => {
    await act(async () => root.render(<FocusView>{pages(10)}</FocusView>))
    // The box shows 600 px from y = 100 of the window, and each page is 500 px tall.
    let scrolled = 0
    place(container.querySelector('.scroller')!, () => 100, 600)
    for (const page of container.querySelectorAll<HTMLElement>('.page')) place(page, () => 100 + Number(page.dataset.index) * 500 - scrolled, 500)
    await frame()
    // Page 2 starts 400 px below what the box shows.
    expect(nearPages()).toEqual([0, 1, 2])

    scrolled = 1500
    await frame()
    expect(nearPages()).toEqual([1, 2, 3, 4, 5])
  })

  it('watches the box of a card, which scrolls inside the card, rather than the box around the card', async () => {
    function Outer(): React.JSX.Element {
      const outer = useRef<HTMLDivElement>(null)
      return (
        <div ref={outer} className="outer" style={{ overflowY: 'auto' }}>
          <ScrollRoot.Provider value={outer}>
            <Frame mode="card" size="l">
              {pages(6)}
            </Frame>
          </ScrollRoot.Provider>
        </div>
      )
    }
    await act(async () => root.render(<Outer />))
    place(container.querySelector('.outer')!, () => 0, 2000)
    place(container.querySelector('.fv-scroll')!, () => 0, 420)
    for (const page of container.querySelectorAll<HTMLElement>('.page')) place(page, () => Number(page.dataset.index) * 300, 300)
    await frame()
    expect(nearPages()).toEqual([0, 1, 2])
  })
})
