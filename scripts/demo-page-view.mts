import { existsSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'
import { normalizePath, type Plugin } from 'vite'

/**
 * The files card shows an HTML page in Electron's <webview>, which a browser does not have, so the demo puts its
 * own PageView, an iframe, in place of the app's. Vite names a module by its real path with forward slashes,
 * which differs from what path.resolve writes on Windows and through a symbolic link, so both sides are compared
 * in Vite's form. A swap missed anyway would leave an empty frame on every HTML card, so the app's PageView
 * stops the demo when it is loaded.
 */

/** A file as Vite names a module: its real path, with forward slashes. */
const moduleName = (file: string): string => normalizePath(realpathSync.native(file))

const PAGE_VIEW = 'PageView.tsx'

/** The module a Vite id names, or null for one that is not a page view, such as a virtual module. */
function pageViewModule(id: string): string | null {
  const file = id.replace(/[?#].*$/, '')
  return basename(file) === PAGE_VIEW && isAbsolute(file) && existsSync(file) ? moduleName(file) : null
}

export function demoPageView(root: string): Plugin {
  const app = moduleName(resolve(root, 'src/renderer/src/panels/viewers', PAGE_VIEW))
  const demo = moduleName(resolve(root, 'src/renderer/src/demo', PAGE_VIEW))
  return {
    name: 'asist-demo-page-view',
    enforce: 'pre',
    async resolveId(source, importer) {
      const resolved = await this.resolve(source, importer, { skipSelf: true })
      return resolved && pageViewModule(resolved.id) === app ? demo : null
    },
    load(id) {
      if (pageViewModule(id) === app) throw new Error(`demo が ${app} を読み込もうとしました。<webview> はブラウザに無いので、${demo} に置き換わっていなければなりません`)
      return null
    }
  }
}
