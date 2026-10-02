import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizePath, type Plugin } from 'vite'
import { demoPageView } from '../scripts/demo-page-view.mts'

/**
 * The demo, which runs in a browser without <webview>, shows the files card's HTML page through its own
 * PageView. Vite names each module by its real path with forward slashes, which is not what path.resolve
 * writes for a checkout reached through a symbolic link, or on Windows.
 */

const ROOT = path.resolve(import.meta.dirname, '..')
/** The app's PageView as Vite names it. */
const APP_PAGE_VIEW = normalizePath(realpathSync.native(path.join(ROOT, 'src/renderer/src/panels/viewers/PageView.tsx')))

const links: string[] = []
afterEach(() => {
  for (const link of links.splice(0)) rmSync(path.dirname(link), { recursive: true, force: true })
})

/** The checkout, reached through a symbolic link. */
function linkedRoot(): string {
  const link = path.join(mkdtempSync(path.join(tmpdir(), 'asist-demo-link-')), 'checkout')
  symlinkSync(ROOT, link, 'dir')
  links.push(link)
  return link
}

/** What the plugin answers when Vite resolves an import of the app's PageView to `resolvedId`. */
async function swap(plugin: Plugin, resolvedId: string): Promise<unknown> {
  const resolveId = plugin.resolveId as (this: unknown, source: string, importer: string) => Promise<unknown>
  return resolveId.call({ resolve: async () => ({ id: resolvedId }) }, './PageView', path.join(ROOT, 'src/renderer/src/panels/viewers/HtmlViewer.tsx'))
}

describe("the demo's HTML page", () => {
  it('is shown by the demo PageView when the checkout is reached through a symbolic link', async () => {
    const plugin = demoPageView(linkedRoot())
    expect(await swap(plugin, APP_PAGE_VIEW)).toBe(normalizePath(realpathSync.native(path.join(ROOT, 'src/renderer/src/demo/PageView.tsx'))))
  })

  it('stops the demo instead of showing an empty frame when the app PageView is loaded anyway', () => {
    const plugin = demoPageView(linkedRoot())
    const load = plugin.load as (this: unknown, id: string) => unknown
    expect(() => load.call({}, APP_PAGE_VIEW)).toThrow()
    expect(() => load.call({}, `${APP_PAGE_VIEW}?t=1`)).toThrow()
    expect(load.call({}, normalizePath(path.join(ROOT, 'src/renderer/src/panels/viewers/HtmlViewer.tsx')))).toBeNull()
  })
})
