// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"navigation":{"disableChildFrameNavigation":true}}}
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileItem } from '@shared/files'
import { createTranslator } from '@shared/i18n'
import { FileViewer } from '@/panels/viewers'

/**
 * The HTML viewer: the page runs in a frame that cannot reach the app, the source is one tab away, a page
 * that cannot be fetched shows the error instead, and a link the app's policy blocked turns into a note.
 */

const t = createTranslator('ja-JP')

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

const ESCAPING_FLAGS = [
  'allow-same-origin',
  'allow-top-navigation',
  'allow-top-navigation-by-user-activation',
  'allow-popups',
  'allow-popups-to-escape-sandbox',
  'allow-forms',
  'allow-modals'
]

const openExternal = vi.fn(async () => {})
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<h1>x</h1>', { status: 200 })))
  openExternal.mockClear()
  Object.assign(window, { api: { openExternal } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const PAGE: FileItem = {
  path: '/jobs/report/index.html',
  name: 'index.html',
  kind: 'code',
  sizeBytes: 40,
  text: '<!doctype html>\n<h1>レポート</h1>\n<script src="chart.js"></script>',
  url: 'asist-file:///jobs/report/index.html'
}

async function render(item: FileItem): Promise<void> {
  await act(async () => {
    root.render(
      <div className="card" data-size="l">
        <FileViewer item={item} mode="card" size="l" />
      </div>
    )
  })
}

const frame = (): HTMLIFrameElement | null => container.querySelector('iframe')
const tab = (key: string): HTMLButtonElement => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === t(key))!

async function violate(url: string): Promise<void> {
  await act(async () => {
    document.dispatchEvent(Object.assign(new Event('securitypolicyviolation'), { effectiveDirective: 'frame-src', blockedURI: url }))
  })
}

describe('html: the rendered page', () => {
  it('loads the page from its own URL in a frame that may run scripts but cannot reach the app', async () => {
    await render(PAGE)
    const page = frame()
    expect(page?.getAttribute('src')).toBe(PAGE.url)
    const flags = page?.getAttribute('sandbox')?.split(/\s+/) ?? []
    expect(flags).toContain('allow-scripts')
    for (const flag of ESCAPING_FLAGS) expect(flags).not.toContain(flag)
    expect(tab('files.viewer.htmlPage').getAttribute('aria-selected')).toBe('true')
  })

  it('shows the highlighted source on the other tab and the page again on the first', async () => {
    await render(PAGE)
    await act(async () => tab('files.viewer.htmlSource').click())
    expect(frame()).toBeNull()
    expect(container.querySelectorAll('.fv-code-line')).toHaveLength(3)
    expect(container.querySelector('.fv-code-text .hljs-tag')).not.toBeNull()
    await act(async () => tab('files.viewer.htmlPage').click())
    expect(frame()?.getAttribute('src')).toBe(PAGE.url)
  })

  it('shows the error and no page when the page cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })))
    await render(PAGE)
    expect(frame()).toBeNull()
    expect(container.querySelector('[data-tone="error"]')?.textContent).toBe(t('files.errors.loadFailed', { status: 403 }))
  })

  it('shows the error and no page when the item has no URL', async () => {
    await render({ ...PAGE, url: undefined })
    expect(frame()).toBeNull()
    expect(container.querySelector('[data-tone="error"]')?.textContent).toBe(t('files.viewer.urlMissing'))
  })

  it('leaves other code, such as a script, to the code viewer without tabs', async () => {
    await render({ ...PAGE, path: '/jobs/report/chart.js', name: 'chart.js', text: 'draw()', url: undefined })
    expect(container.querySelector('[role="tab"]')).toBeNull()
    expect(container.querySelector('.fv-code-line')?.textContent).toContain('draw()')
  })
})

describe('html: a link the app blocked', () => {
  it('replaces the error page the blocked link left with a note that offers the link to the browser', async () => {
    await render(PAGE)
    await violate('https://example.com/')
    await act(async () => frame()!.dispatchEvent(new Event('load')))
    expect(frame()).toBeNull()
    expect(container.querySelector('.fv-html-blocked .fv-note')?.textContent).toBe(t('files.viewer.htmlLinkBlocked', { url: 'https://example.com/' }))
    const [open, back] = container.querySelectorAll<HTMLButtonElement>('.fv-html-blocked button')
    await act(async () => open.click())
    expect(openExternal).toHaveBeenCalledWith('https://example.com/')
    await act(async () => back.click())
    expect(frame()?.getAttribute('src')).toBe(PAGE.url)
  })

  it('keeps the page when a violation is not followed by a load of this frame', async () => {
    await render(PAGE)
    await violate('https://example.com/')
    expect(frame()).not.toBeNull()
    expect(container.querySelector('.fv-html-blocked')).toBeNull()
  })

  it('keeps the page when the frame loads a page of its own folder without a violation', async () => {
    await render(PAGE)
    await act(async () => frame()!.dispatchEvent(new Event('load')))
    expect(frame()).not.toBeNull()
  })
})
