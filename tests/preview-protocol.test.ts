import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { longTempFolder } from './helpers/temp'

const electron = vi.hoisted(() => ({ handle: vi.fn(), fetch: vi.fn() }))
vi.mock('electron', () => ({ protocol: { handle: electron.handle }, net: { fetch: electron.fetch } }))

/** What Electron's net.fetch answers for a file: the bytes on disk, or 404 for a file that is not there. */
async function fetchFile(url: string): Promise<Response> {
  const file = fileURLToPath(url)
  return fs.existsSync(file) ? new Response(fs.readFileSync(file)) : new Response('', { status: 404 })
}

/**
 * A built renderer as electron-vite writes it: the app's page and the preview page, a chunk each, a chunk they
 * share, a chunk the preview page loads on demand with a worker asset, and what only the app's page loads.
 */
function builtRenderer(): string {
  const folder = longTempFolder('asist-preview-')
  const files: Record<string, string> = {
    'index.html': '<script src="./assets/index.js"></script>',
    'preview.html': '<script src="./assets/preview.js"></script>',
    'assets/index.js': 'app',
    'assets/index.css': 'app style',
    'assets/app-only.js': 'app on demand',
    'assets/preview.js': 'preview',
    'assets/shared.js': 'shared',
    'assets/pdf.js': 'pdf',
    'assets/pdf.worker.mjs': 'worker'
  }
  const manifest = {
    'index.html': { file: 'assets/index.js', isEntry: true, imports: ['_shared.js'], dynamicImports: ['src/app-only.ts'], css: ['assets/index.css'] },
    'preview.html': { file: 'assets/preview.js', isEntry: true, imports: ['_shared.js'], dynamicImports: ['src/preview/methods/pdf.ts'] },
    '_shared.js': { file: 'assets/shared.js' },
    'src/app-only.ts': { file: 'assets/app-only.js', isDynamicEntry: true },
    'src/preview/methods/pdf.ts': { file: 'assets/pdf.js', isDynamicEntry: true, imports: ['_shared.js'], assets: ['assets/pdf.worker.mjs'] }
  }
  for (const [name, body] of Object.entries({ ...files, '.vite/manifest.json': JSON.stringify(manifest) })) {
    fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true })
    fs.writeFileSync(path.join(folder, name), body)
  }
  return folder
}

/** Registers the handler for a renderer source and returns what it answers for a URL. */
async function handler(source: { server: string } | { folder: string }, appPage: string): Promise<(url: string) => Promise<Response>> {
  const { handlePreviewScheme } = await import('../src/main/preview-protocol')
  electron.handle.mockClear()
  electron.fetch.mockClear()
  handlePreviewScheme(source, appPage)
  const handle = electron.handle.mock.calls[0][1] as (request: Request) => Promise<Response>
  return (url) => handle(new Request(url))
}

describe('asist-preview:// in a packaged app', () => {
  const appPage = 'file:///Applications/ASIST.app/Contents/Resources/app.asar/out/renderer/index.html'

  it('serves the preview page and every file its scripts load, embedded only by the app page', async () => {
    electron.fetch.mockImplementation(fetchFile)
    const serve = await handler({ folder: builtRenderer() }, appPage)
    const page = await serve('asist-preview://app/preview.html')
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toBe('frame-ancestors file:')
    for (const name of ['assets/preview.js', 'assets/shared.js', 'assets/pdf.js', 'assets/pdf.worker.mjs']) {
      const response = await serve(`asist-preview://app/${name}`)
      expect([name, response.status]).toEqual([name, 200])
      expect(response.headers.get('content-security-policy')).toBeNull()
    }
  })

  it('refuses the app page, what only the app page loads, the manifest, a path out of the folder and another host', async () => {
    electron.fetch.mockImplementation(fetchFile)
    const serve = await handler({ folder: builtRenderer() }, appPage)
    for (const url of [
      'asist-preview://app/index.html',
      'asist-preview://app/assets/index.js',
      'asist-preview://app/assets/index.css',
      'asist-preview://app/assets/app-only.js',
      'asist-preview://app/.vite/manifest.json',
      'asist-preview://app/assets/../../main/index.js',
      'asist-preview://app/%2e%2e/main/index.js',
      'asist-preview://other/preview.html'
    ]) {
      expect([url, (await serve(url)).status]).toEqual([url, 404])
    }
    expect(electron.fetch.mock.calls.map(([url]) => url)).toEqual([])
  })
})

describe('asist-preview:// in a development launch', () => {
  const server = 'http://localhost:5173/'

  /** What electron-vite's server answers: a module for a script, and the app's page for any other path. */
  function devServer(url: string): Response {
    const { pathname } = new URL(url)
    if (pathname === '/preview.html') return new Response('<script type="module" src="/src/preview/main.ts"></script>', { headers: { 'Content-Type': 'text/html' } })
    if (pathname.endsWith('.ts')) return new Response('export {}', { headers: { 'Content-Type': 'text/javascript' } })
    return new Response('<div id="root"></div>', { headers: { 'Content-Type': 'text/html' } })
  }

  it('passes the preview page and its modules on from the server, the page embedded only by the server', async () => {
    electron.fetch.mockImplementation(async (url: string) => devServer(url))
    const serve = await handler({ server }, server)
    const page = await serve('asist-preview://app/preview.html')
    expect(await page.text()).toContain('/src/preview/main.ts')
    expect(page.headers.get('content-security-policy')).toBe('frame-ancestors http://localhost:5173')
    const module = await serve('asist-preview://app/src/preview/main.ts?t=1')
    expect(module.status).toBe(200)
    expect(electron.fetch).toHaveBeenLastCalledWith('http://localhost:5173/src/preview/main.ts?t=1')
  })

  it('refuses the app page, whether asked for by name or by a path the server answers with it', async () => {
    electron.fetch.mockImplementation(async (url: string) => devServer(url))
    const serve = await handler({ server }, server)
    for (const url of ['asist-preview://app/index.html', 'asist-preview://app/', 'asist-preview://app/settings']) {
      expect([url, (await serve(url)).status]).toEqual([url, 404])
    }
  })
})
