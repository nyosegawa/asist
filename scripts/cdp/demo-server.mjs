import http from 'node:http'
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

/** Starts the demo and returns its origin, such as http://localhost:51234, and a function that stops it. */
export async function startDemo() {
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
  httpServer.on('request', vite.middlewares)
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
