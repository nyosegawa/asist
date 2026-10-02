import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

/**
 * Serves the demo of the checkout this script lives in, on a port the OS picks, for one run of a script.
 * Every run owns its server, so runs in several worktrees at once never share a port and never capture
 * another checkout's code. `npm run demo` keeps the fixed port 5174 for a person and the browser pane.
 *
 * Vite reads a port of 0 as unset and falls back to 5173, so it cannot be asked for a free port itself.
 * It runs in middleware mode instead, on an HTTP server that is already listening on the port the OS gave,
 * which leaves no moment in which two runs could pick the same number.
 *
 * Once the demo has served its CSS, the process stays alive after close() with nothing left in its
 * handles, while a run that served only scripts exits within two seconds (measured 2026-09-23). A script
 * that starts the demo therefore ends its own process when the run is done.
 */

const CONFIG = fileURLToPath(new URL('../vite.demo.config.mts', import.meta.url))

/** Where the files of the folder given to startDemo are served, by their names, on the demo's own origin. */
export const SERVED_FILES_PATH = '/served-files/'

/**
 * Starts the demo and returns its origin, such as http://localhost:51234, and a function that stops it. With
 * `files`, a folder, the files directly in it are also served under SERVED_FILES_PATH, the way the app serves a
 * file the files card shows: by ranges, and never from the browser's cache. Vite's own /@fs refuses a file
 * outside the checkout, such as one in a temporary folder, and lets the browser cache what it serves.
 */
export async function startDemo({ files } = {}) {
  const httpServer = http.createServer()
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(0, 'localhost', resolve)
  })
  const vite = await createServer({
    configFile: CONFIG,
    logLevel: 'error',
    appType: 'spa',
    server: { middlewareMode: true, hmr: { server: httpServer } }
  })
  const served = files ? serveFolder(files) : null
  httpServer.on('request', (req, res) => {
    if (served && req.url.startsWith(SERVED_FILES_PATH)) void served(req, res)
    else vite.middlewares(req, res)
  })
  const { port } = httpServer.address()
  return {
    origin: `http://localhost:${port}`,
    close: async () => {
      await vite.close()
      // A keep-alive connection a client left open would otherwise keep the process running after the run.
      httpServer.closeAllConnections()
      await new Promise((resolve) => httpServer.close(() => resolve()))
    }
  }
}

const TYPES = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.zip': 'application/zip'
}

/**
 * The largest body sent in the same write as its headers, so that no range waits for the acknowledgement of an
 * earlier write (Nagle's algorithm against a delayed ACK) and the time a viewer spends reading by ranges is its
 * own. A larger body is streamed: its size, not the writes, decides how long it takes, and it is not held in
 * memory whole. From a page in headless Chrome on an M5 on 2026-10-02, a 64 KB range took 0.4 ms here and
 * 0.8 ms from Vite's /@fs, and a 4 MB range 1.7 ms and 2.5 ms (medians of 40).
 */
const ONE_WRITE_LIMIT = 64 * 1024 * 1024

/** Answers a GET or HEAD for a file directly in the folder, whole or by one range, in a single write when it fits. */
export function serveFolder(folder) {
  return async (req, res) => {
    try {
      const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.slice(SERVED_FILES_PATH.length))
      if (name !== path.basename(name) || name.startsWith('.')) {
        res.writeHead(404).end()
        return
      }
      const file = path.join(folder, name)
      const { size } = await stat(file)
      const headers = {
        'Content-Type': TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store'
      }
      let start = 0
      let end = size - 1
      let status = 200
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
      if (range) {
        if (range[1] === '') start = Math.max(0, size - Number(range[2]))
        else {
          start = Number(range[1])
          if (range[2] !== '') end = Math.min(Number(range[2]), size - 1)
        }
        if (start > end) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end()
          return
        }
        status = 206
        headers['Content-Range'] = `bytes ${start}-${end}/${size}`
      }
      const length = end - start + 1
      headers['Content-Length'] = length
      if (req.method === 'HEAD') {
        res.writeHead(status, headers).end()
        return
      }
      if (length > ONE_WRITE_LIMIT) {
        res.writeHead(status, headers)
        createReadStream(file, { start, end }).pipe(res)
        return
      }
      const body = Buffer.allocUnsafe(length)
      const handle = await open(file, 'r')
      try {
        await handle.read(body, 0, length, start)
      } finally {
        await handle.close()
      }
      // Given the whole body at once, Node sends it in the same write as the headers.
      res.writeHead(status, headers).end(body)
    } catch (error) {
      res.writeHead(error.code === 'ENOENT' ? 404 : 500).end(String(error.message))
    }
  }
}
