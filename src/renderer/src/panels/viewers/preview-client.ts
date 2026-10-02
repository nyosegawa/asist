import { errorText } from '@shared/i18n/error-text'
import { PREVIEW_PAGE_URL } from '@shared/preview-page'
import { CONNECTED, documentKey, type OpenPreviewDocument, type PreviewReply, type PreviewRequest } from '@/preview/serve'

/**
 * The viewers' side of the preview page (src/renderer/src/preview/), where they do their heavy work: a viewer
 * opens its file there as a document of its kind and asks the document for what it draws. The page runs in a
 * hidden iframe, which Chromium gives a process of its own, so a file that takes it out of memory ends that
 * frame and not the app's page. The frame starts with the first request and goes once no document is open,
 * since its process holds about 80 MB with nothing open (Electron 43.7.7 on an M5, 2026-10-02).
 */

/** A frame of the preview page. */
export interface PreviewFrame {
  /** The port the frame's page answers on. */
  port: MessagePort
  /** Settles once the frame has gone: its process died, its page closed the port, or it never held the page. */
  gone: Promise<void>
  remove(): void
}

type Methods<Open extends OpenPreviewDocument> = Awaited<ReturnType<Open>>['methods']

/** A viewer's hold on a document open in the preview page. */
export interface PreviewHandle<Open extends OpenPreviewDocument> {
  /**
   * Asks the document for something. A frame that dies or is removed before it answers fails the request with an
   * error a viewer can show, and the next request starts a new frame, which opens the document again.
   */
  call<Name extends keyof Methods<Open> & string>(
    method: Name,
    args: Parameters<Methods<Open>[Name]>[0]
  ): Promise<Awaited<ReturnType<Methods<Open>[Name]>>>
  /** Lets go of the document, which the page closes once no viewer holds it. */
  release(): void
}

interface Running {
  frame: PreviewFrame
  /** The requests the frame has not answered yet, by id. */
  pending: Map<number, { resolve(value: unknown): void; reject(error: Error): void }>
}

export interface PreviewClient {
  /** Opens the file at a URL as a document of a kind, which the card and the focus view of one file share. */
  open<Open extends OpenPreviewDocument>(kind: string, url: string): PreviewHandle<Open>
}

export function createPreviewClient(startFrame: () => PreviewFrame): PreviewClient {
  let running: Running | null = null
  let nextId = 0
  /** How many handles hold each open document, by documentKey. */
  const holders = new Map<string, number>()

  function end(ended: Running): void {
    if (running === ended) running = null
    ended.frame.port.close()
    ended.frame.remove()
    for (const { reject } of ended.pending.values()) reject(new Error(errorText('files.errors.previewStopped')))
    ended.pending.clear()
  }

  function start(): Running {
    const started: Running = { frame: startFrame(), pending: new Map() }
    const { port } = started.frame
    port.addEventListener('message', ({ data }: MessageEvent<PreviewReply>) => {
      if (data === CONNECTED) return
      const request = started.pending.get(data.id)
      if (!request) return
      started.pending.delete(data.id)
      if ('error' in data) request.reject(new Error(data.error))
      else request.resolve(data.value)
    })
    port.start()
    void started.frame.gone.then(() => end(started))
    return started
  }

  /**
   * Closes a document no handle holds and removes the frame once none is held. It runs after the handles of the
   * same render have been taken, so a card that gives a document up while the focus view takes it keeps it open.
   */
  function settle(kind: string, url: string): void {
    if (holders.has(documentKey(kind, url)) || !running) return
    running.frame.port.postMessage({ type: 'close', kind, url } satisfies PreviewRequest)
    if (holders.size === 0) end(running)
  }

  return {
    open<Open extends OpenPreviewDocument>(kind: string, url: string): PreviewHandle<Open> {
      const key = documentKey(kind, url)
      holders.set(key, (holders.get(key) ?? 0) + 1)
      let held = true
      return {
        call(method, args) {
          if (!held) throw new Error(`the ${kind} document of ${url} was released`)
          running ??= start()
          const { frame, pending } = running
          const id = nextId++
          return new Promise((resolve, reject) => {
            pending.set(id, { resolve: (value) => resolve(value as never), reject })
            frame.port.postMessage({ type: 'call', id, kind, url, method, args } satisfies PreviewRequest)
          })
        },
        release() {
          if (!held) return
          held = false
          const left = holders.get(key)! - 1
          if (left > 0) holders.set(key, left)
          else holders.delete(key)
          queueMicrotask(() => settle(kind, url))
        }
      }
    }
  }
}

/**
 * How long a frame that has loaded may take to answer on its port. The preview page has run its script by its
 * load event and answers as soon as the port reaches it; a frame that loaded anything else, such as an error,
 * drops the port without closing it and never answers.
 */
const CONNECT_MS = 5_000

/** Starts the preview page in a hidden iframe and hands it its port once it has loaded. */
function startIframe(page: string): PreviewFrame {
  const iframe = document.createElement('iframe')
  iframe.hidden = true
  iframe.src = page
  const { port1, port2 } = new MessageChannel()
  let connected = false
  port1.addEventListener('message', () => (connected = true), { once: true })
  const gone = new Promise<void>((resolve) => {
    // Electron fires close on a port whose other end has gone, the process of a frame that died included. The
    // event is Electron's own, and Chrome 154 has none, so in the demo a frame that dies leaves its requests waiting.
    port1.addEventListener('close', () => resolve())
    iframe.addEventListener(
      'load',
      () => {
        setTimeout(() => {
          if (connected || !iframe.isConnected) return
          console.error(`the preview frame did not connect: ${page}`)
          resolve()
        }, CONNECT_MS)
        // The port goes only to a page of the preview page's origin.
        iframe.contentWindow?.postMessage('connect', page, [port2])
      },
      { once: true }
    )
  })
  document.body.append(iframe)
  return { port: port1, gone, remove: () => iframe.remove() }
}

let page = PREVIEW_PAGE_URL
let client: PreviewClient | null = null

/** The demo, which has no asist-preview scheme, serves the same page from a site of its own. */
export function servePreviewFrom(url: string): void {
  page = url
}

/**
 * Opens the file at a URL in the preview page. The page reads a relative URL, as the demo's files have, from the
 * server that serves it.
 */
export function openPreviewDocument<Open extends OpenPreviewDocument>(kind: string, url: string): PreviewHandle<Open> {
  client ??= createPreviewClient(() => startIframe(page))
  return client.open<Open>(kind, url)
}
