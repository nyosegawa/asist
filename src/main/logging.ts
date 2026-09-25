import { app, type BrowserWindow } from 'electron'
import { installAppLog } from './services/app-log'
import { revealedApiKeys } from './services/api-key-secrets'

/**
 * Runs as the second dependency of index.ts, so that the console output of every service loaded after it,
 * and any failure during loading, still reaches the file. The directory is the macOS standard
 * ~/Library/Logs/<app name>/, which Console.app also shows.
 */
const log = installAppLog(app.getPath('logs'), revealedApiKeys)

app.on('child-process-gone', (_event, details) => {
  if (details.reason !== 'clean-exit') console.error(`child process gone: ${details.type} ${details.name ?? ''} reason=${details.reason} exit=${details.exitCode}`)
})

/** Records the renderer's warnings and errors and its abnormal exits. Info is too noisy to be worth keeping. */
export function logRenderer(window: BrowserWindow): void {
  window.webContents.on('console-message', (event) => {
    if (event.level !== 'warning' && event.level !== 'error') return
    const where = event.sourceId ? ` (${event.sourceId}:${event.lineNumber})` : ''
    log.write(event.level === 'error' ? 'error' : 'warn', 'renderer', [`${event.message}${where}`])
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error(`renderer process gone: reason=${details.reason} exit=${details.exitCode}`)
  })
}
