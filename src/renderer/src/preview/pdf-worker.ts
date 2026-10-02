import pdfJsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { PICTURE_LEFT_OUT, watchLeftOutPictures, type WorkerFailed } from './pdf-worker-messages'

/**
 * The script of pdf.js's worker in the preview page: pdf.js's own worker, which starts on this worker's port as it
 * is imported, and a watch on the console for the pictures it leaves out (pdf-worker-messages.ts). pdf.js's side
 * starts talking as soon as the worker exists, before pdf.js has been imported here to listen, so what arrives
 * meanwhile is held and handed to pdf.js once it listens.
 */

watchLeftOutPictures(console, () => postMessage(PICTURE_LEFT_OUT))

const early: MessageEvent[] = []
const hold = (event: MessageEvent): void => {
  early.push(event)
  event.stopImmediatePropagation()
}
addEventListener('message', hold)

import(/* @vite-ignore */ pdfJsWorkerUrl).then(
  () => {
    removeEventListener('message', hold)
    for (const { data, ports } of early.splice(0)) dispatchEvent(new MessageEvent('message', { data, ports: [...ports] }))
  },
  (error: unknown) => {
    postMessage({ type: 'asist:pdf-worker-failed', message: error instanceof Error ? error.message : String(error) } satisfies WorkerFailed)
  }
)
