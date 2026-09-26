import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({ handle: vi.fn() }))
vi.mock('electron', () => ({ protocol: { registerSchemesAsPrivileged: vi.fn(), handle: electron.handle } }))

const load = () => import('../src/main/file-protocol')

/** Registers the handler for the folder and returns what it answers for a URL and a Range header. */
async function serve(folder: string, url: string, range?: string): Promise<Response> {
  const { handleFileScheme } = await load()
  electron.handle.mockClear()
  handleFileScheme(() => [folder])
  const handler = electron.handle.mock.calls[0][1] as (request: { url: string; headers: Headers }) => Response
  return handler({ url, headers: new Headers(range ? { range } : {}) })
}

describe('asist-file:// URLs and paths', () => {
  it('turns an absolute path into a URL and reads the same path back, including Japanese characters and spaces', async () => {
    const { fileUrl, filePathFromUrl } = await load()
    const path = '/Users/me/Application Support/asist/memory/pages/大川俊介.md'
    const url = fileUrl(path)
    expect(url.startsWith('asist-file:///Users/me/')).toBe(true)
    expect(filePathFromUrl(url)).toBe(path)
    expect(filePathFromUrl(`${url}?t=1`)).toBe(path)
  })

  it('rejects other schemes and relative paths', async () => {
    const { filePathFromUrl } = await load()
    expect(filePathFromUrl('file:///etc/passwd')).toBeNull()
    expect(filePathFromUrl('asist-file://relative/a.png')).toBeNull()
  })

  it('keeps a #, a ? or a % in a file name as part of the path rather than a fragment or a query', async () => {
    const { fileUrl, filePathFromUrl } = await load()
    for (const file of ['/Users/me/Documents/C# notes.pdf', '/Users/me/Documents/why?.png', '/Users/me/Documents/Issue #12.png', '/Users/me/Documents/100%.png']) {
      const url = new URL(fileUrl(file))
      expect([url.hash, url.search]).toEqual(['', ''])
      expect(filePathFromUrl(url.href)).toBe(file)
    }
  })

  it('reads the file a page names in a relative link with its reserved characters escaped', async () => {
    const { fileUrl, filePathFromUrl } = await load()
    const page = fileUrl('/r/report.html')
    expect(filePathFromUrl(new URL('Q1%2C%20Q2.png', page).href)).toBe('/r/Q1, Q2.png')
    expect(filePathFromUrl(new URL('C%23.png', page).href)).toBe('/r/C#.png')
  })

  it('serves a file whose name holds a # from the URL the files card is given', async () => {
    const { fileUrl } = await load()
    const folder = mkdtempSync(path.join(tmpdir(), 'asist-file-protocol-'))
    writeFileSync(path.join(folder, 'C# notes.txt'), 'notes')
    const response = await serve(folder, fileUrl(path.join(folder, 'C# notes.txt')))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('notes')
  })
})

describe('the Range header that video and audio use to seek', () => {
  it('turns bytes=a-b, bytes=a- and bytes=-n into a start and an end', async () => {
    const { parseRange } = await load()
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 })
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=0-5000', 1000)).toEqual({ start: 0, end: 999 })
  })

  it('returns null for an invalid range, so the whole file is served', async () => {
    const { parseRange } = await load()
    expect(parseRange(null, 1000)).toBeNull()
    expect(parseRange('bytes=', 1000)).toBeNull()
    expect(parseRange('bytes=1000-', 1000)).toBeNull()
    expect(parseRange('bytes=50-10', 1000)).toBeNull()
    expect(parseRange('items=0-1', 1000)).toBeNull()
  })

  it('finds no byte of an empty file, and serves the empty file whole when its last bytes are asked for', async () => {
    const { fileUrl, parseRange } = await load()
    expect(parseRange('bytes=-100', 0)).toBeNull()
    expect(parseRange('bytes=0-', 0)).toBeNull()
    const folder = mkdtempSync(path.join(tmpdir(), 'asist-file-protocol-'))
    writeFileSync(path.join(folder, 'empty.mp3'), '')
    const response = await serve(folder, fileUrl(path.join(folder, 'empty.mp3')), 'bytes=-100')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
  })
})

/** Splits a Content-Security-Policy value into its directives, each with its list of sources or flags. */
function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .filter((words) => words[0])
      .map(([name, ...values]) => [name, values])
  )
}

/** The sandbox flags that would let a page reach the app, move its window, open windows or send forms. */
const ESCAPING_FLAGS = [
  'allow-same-origin',
  'allow-top-navigation',
  'allow-top-navigation-by-user-activation',
  'allow-popups',
  'allow-popups-to-escape-sandbox',
  'allow-forms',
  'allow-modals'
]

describe('the headers an HTML page is served with', () => {
  it('sandboxes the page with scripts only, whatever frame loads it', async () => {
    const { contentHeaders } = await load()
    for (const name of ['/r/report.html', '/r/INDEX.HTM']) {
      const sandbox = directives(contentHeaders(name)['Content-Security-Policy']).get('sandbox')
      expect(sandbox).toContain('allow-scripts')
      for (const flag of ESCAPING_FLAGS) expect(sandbox).not.toContain(flag)
    }
  })

  it('lets the page read no local file, embed no frame and submit no form', async () => {
    const { contentHeaders } = await load()
    const policy = directives(contentHeaders('/r/report.html')['Content-Security-Policy'])
    expect(policy.get('default-src')).toEqual(["'none'"])
    expect(policy.get('connect-src')).toEqual(['https:'])
    expect(policy.get('frame-src')).toEqual(["'none'"])
    expect(policy.get('form-action')).toEqual(["'none'"])
  })

  it('keeps the local path out of the Referer of the remote resources a page loads', async () => {
    const { contentHeaders } = await load()
    expect(contentHeaders('/r/report.html')['Referrer-Policy']).toBe('no-referrer')
  })

  it('serves the stylesheet and script next to a page with types a browser applies and runs', async () => {
    const { contentHeaders } = await load()
    expect(contentHeaders('/r/report.css')['Content-Type']).toMatch(/^text\/css/)
    expect(contentHeaders('/r/chart.js')['Content-Type']).toMatch(/^text\/javascript/)
  })
})

describe("the app page's frame-src", () => {
  it('admits no source that would show any remote site inside the app', () => {
    const html = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8')
    const policy = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? ''
    const frameSources = directives(policy).get('frame-src') ?? []
    expect(frameSources).toContain('asist-file:')
    for (const wide of ['*', 'https:', 'http:', 'data:', 'blob:', "'self'", 'file:']) expect(frameSources).not.toContain(wide)
  })
})
