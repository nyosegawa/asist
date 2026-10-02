/**
 * What the preview page's worker for pdf.js posts on its port besides pdf.js's own messages, which pdf.js's side
 * ignores. pdf.js only logs a picture it leaves out of a page for being larger than its maxImageSize, as a warning on
 * the worker's console, so the worker's script watches the console and posts PICTURE_LEFT_OUT. A worker whose pdf.js
 * did not load would leave every document waiting for it, so it posts why instead.
 */

export const PICTURE_LEFT_OUT = 'asist:pdf-picture-left-out'

export interface WorkerFailed {
  type: 'asist:pdf-worker-failed'
  message: string
}

export const isWorkerFailed = (data: unknown): data is WorkerFailed =>
  typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'asist:pdf-worker-failed'

/** The warning pdf.js 6.3.289 logs as it leaves such a picture out. */
const LEFT_OUT_WARNING = 'Warning: Image exceeded maximum allowed size and was removed.'

/** Calls report for each warning of a picture left out, which the console still logs. */
export function watchLeftOutPictures(target: Pick<Console, 'warn'>, report: () => void): void {
  const warn = target.warn.bind(target)
  target.warn = (...args: unknown[]) => {
    if (args[0] === LEFT_OUT_WARNING) report()
    warn(...args)
  }
}
