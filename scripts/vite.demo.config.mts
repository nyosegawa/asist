import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { aizuchiReview } from './aizuchi-clips/review-api.mjs'
import { PREVIEW_PAGE_HOST } from '../src/renderer/src/demo/routes'

// Runs the renderer alone in a plain browser, which is the demo mode. Electron is not started.

const root = resolve(import.meta.dirname, '..')

/**
 * The demo shell shows each sample in an iframe from its own origin, and a sample's viewers load the preview
 * page from PREVIEW_PAGE_HOST. The app's CSP in index.html allows neither, so both are added while the demo is
 * served. The preview page reads the demo's files, and the development server's client in it connects, over
 * its own origin rather than asist-file:, so its CSP gets that. The CSPs themselves are left alone.
 */
const FRAME_SRC = 'frame-src https://www.google.com'
const PREVIEW_CONNECT_SRC = 'connect-src asist-file:;'
function replaceInCsp(html: string, page: string, from: string, to: string): string {
  if (!html.includes(from)) throw new Error(`${page} の CSP に ${from} がありません。demo で開けません`)
  return html.replace(from, to)
}
const allowDemoFrames = {
  name: 'asist-demo-csp',
  transformIndexHtml(html: string, { path }: { path: string }): string {
    if (path === '/preview.html') {
      return replaceInCsp(html, path, PREVIEW_CONNECT_SRC, "connect-src asist-file: 'self';")
    }
    return replaceInCsp(html, path, FRAME_SRC, `frame-src 'self' http://${PREVIEW_PAGE_HOST}:* https://www.google.com`)
  }
}
export default defineConfig({
  root: resolve(root, 'src/renderer'),
  // .env is read from the repository root, as electron-vite does for the app, with the same renderer prefixes.
  envDir: root,
  envPrefix: ['VITE_', 'RENDERER_VITE_'],
  // Sample files only the demo uses, such as the images of the files card. They stay out of the real build.
  publicDir: resolve(root, 'src/renderer/demo-public'),
  resolve: {
    alias: {
      '@': resolve(root, 'src/renderer/src'),
      '@shared': resolve(root, 'src/shared')
    }
  },
  // The aizuchi review page (/aizuchi) reads and writes the clips under resources/aizuchi through it.
  plugins: [react(), tailwindcss(), allowDemoFrames, aizuchiReview(root)],
  server: { port: 5174, strictPort: true }
})
