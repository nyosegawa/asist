import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import { isPathAllowed } from './services/file-preview'

/**
 * Serves files under an allowed folder to the renderer as asist-file:///<absolute path>. The files card
 * fetches its images, PDFs, Office documents, audio and video over this URL rather than carrying bytes in
 * its props, and loads an HTML page from it so that the page's relative links resolve to the files next to
 * it. Range requests are answered so that video and audio can seek. Permission is checked on every
 * request, because a job adds new working directories as it goes.
 */

export const FILE_SCHEME = 'asist-file'

export const fileUrl = (filePath: string): string => `${FILE_SCHEME}://${encodeURI(filePath)}`

/** Has to be called before app.whenReady. */
export function registerFileScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: FILE_SCHEME, privileges: { secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
  ])
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.zip': 'application/zip',
  // The header's charset overrides a page's own meta charset. Agents write UTF-8, and a page without a
  // meta charset would otherwise be decoded as windows-1252 and its Japanese garbled.
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8'
}

/**
 * The policy an HTML page is served with, which holds even where the page is loaded without the files
 * card's sandboxed iframe. `sandbox allow-scripts` gives the document an opaque origin, so it cannot reach
 * the app's page or the preload bridge, and asist-file:// sends it no CORS header, so it can run and draw
 * the files next to it but cannot read them. Remote scripts, styles and images load, because reports draw
 * their charts with a library from a CDN; frames are refused, so a page never shows a remote site inside
 * the app.
 */
export const HTML_PAGE_POLICY = [
  'sandbox allow-scripts',
  "default-src 'none'",
  `script-src ${FILE_SCHEME}: https: blob: 'unsafe-inline' 'unsafe-eval'`,
  `style-src ${FILE_SCHEME}: https: 'unsafe-inline'`,
  `img-src ${FILE_SCHEME}: https: data: blob:`,
  `font-src ${FILE_SCHEME}: https: data:`,
  `media-src ${FILE_SCHEME}: https: data: blob:`,
  'connect-src https:',
  "frame-src 'none'",
  "worker-src blob:",
  "form-action 'none'",
  `base-uri ${FILE_SCHEME}:`
].join('; ')

/** The headers that depend on the file. An HTML page also keeps its local path out of the Referer of its remote requests. */
export function contentHeaders(filePath: string): Record<string, string> {
  const type = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  if (!type.startsWith('text/html')) return { 'Content-Type': type }
  return { 'Content-Type': type, 'Content-Security-Policy': HTML_PAGE_POLICY, 'Referrer-Policy': 'no-referrer' }
}

/** Takes the absolute path out of the URL. Only the form asist-file:///Users/... is accepted. */
export function filePathFromUrl(url: string): string | null {
  if (!url.startsWith(`${FILE_SCHEME}://`)) return null
  const rest = url.slice(`${FILE_SCHEME}://`.length)
  const withoutQuery = rest.split(/[?#]/)[0]
  try {
    const decoded = decodeURI(withoutQuery)
    return decoded.startsWith('/') ? decoded : null
  } catch {
    return null
  }
}

/** Turns a Range header of the form `bytes=a-b` into [start, end], or null when it is invalid. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  if (m[1] === '' && m[2] === '') return null
  if (m[1] === '') {
    const suffix = Number(m[2])
    return suffix <= 0 ? null : { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(m[1])
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  return start > end || start >= size ? null : { start, end }
}

/** Has to be called after app.whenReady. allowedRoots is read per request, because a new job adds roots. */
export function handleFileScheme(allowedRoots: () => string[]): void {
  protocol.handle(FILE_SCHEME, (request) => {
    const filePath = filePathFromUrl(request.url)
    if (!filePath || !isPathAllowed(filePath, allowedRoots())) return new Response('forbidden', { status: 403 })
    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch {
      return new Response('not found', { status: 404 })
    }
    if (!stat.isFile()) return new Response('not a file', { status: 404 })
    const range = parseRange(request.headers.get('range'), stat.size)
    const headers: Record<string, string> = {
      ...contentHeaders(filePath),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store'
    }
    if (range) {
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`
      headers['Content-Length'] = String(range.end - range.start + 1)
      const stream = fs.createReadStream(filePath, { start: range.start, end: range.end })
      return new Response(Readable.toWeb(stream) as ReadableStream, { status: 206, headers })
    }
    headers['Content-Length'] = String(stat.size)
    return new Response(Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream, { status: 200, headers })
  })
}
