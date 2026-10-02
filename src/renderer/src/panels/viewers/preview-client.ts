import type { FileItem } from '@shared/files'
import { errorKeyOf } from '@shared/i18n/error-key'
import { errorText } from '@shared/i18n/error-text'
import { PREVIEW_PAGE_URL } from '@shared/preview-page'
import { CONNECTED, type OpenPreviewDocument, type PreviewReply, type PreviewRequest } from '@/preview/serve'

/**
 * The viewers' side of the preview page (src/renderer/src/preview/), where they do their heavy work: a viewer
 * opens its file there as a document of its kind and asks the document for what it draws. The page runs in an
 * iframe nobody sees, which Chromium gives a process of its own, so a file that takes it out of memory ends that
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
  /**
   * Calls the listener when a request finds the file changed since its document was opened, as a file saved again
   * while a card shows it is. The client has then let that document go, and the next request of any viewer of the
   * file opens it again as it is now. The same happens when a frame started after one stopped opens the document
   * from a file saved in between, which the page tells by the version it reports. Answers depend on the version
   * they were read from, such as a slide count or the order of the sheets, so the viewer drops everything it has
   * from the document and starts over from its first request. The request that found the change fails after the
   * listener has run, and so does every other request sent to the old version, whenever its answer comes. Returns
   * what stops the listening.
   */
  onChanged(listener: () => void): () => void
  /** Lets go of the document, which the page closes once no viewer holds it. */
  release(): void
}

interface Running {
  frame: PreviewFrame
  /** The requests the frame has not answered yet, by id, with the page's key of the document each one asked. */
  pending: Map<number, { key: string; sent: string; resolve(value: unknown): void; reject(error: Error): void }>
}

/** The file a document is opened from: its URL, and the size and time of change that tell one version from another. */
export type PreviewFile = Pick<FileItem, 'sizeBytes' | 'modifiedAt'> & { url: string }

/**
 * The key of a document. The card and the focus view of one file share its document, while a card of the same
 * file written again since gets one of its own.
 */
const documentKey = (kind: string, { url, sizeBytes, modifiedAt }: PreviewFile): string => JSON.stringify([kind, url, sizeBytes, modifiedAt ?? null])

export interface PreviewClient {
  /** Opens a file as a document of a kind. */
  open<Open extends OpenPreviewDocument>(kind: string, file: PreviewFile): PreviewHandle<Open>
}

export function createPreviewClient(startFrame: () => PreviewFrame): PreviewClient {
  let running: Running | null = null
  let nextId = 0
  /** How many handles hold each open document, by documentKey. */
  const holders = new Map<string, number>()
  /**
   * How many times each document was found out of date, by documentKey. The page knows a document by its key and
   * this count, so a file saved again since its card was made is opened again under the same documentKey.
   */
  const outdated = new Map<string, number>()
  const pageKey = (key: string): string => `${outdated.get(key) ?? 0} ${key}`
  /** What the handles of each document listen for its change with, by documentKey. */
  const listeners = new Map<string, Set<() => void>>()
  /**
   * The version of the file each document's first answer came from, by the page's key. A frame started after one
   * stopped opens the document again from the file as it is then, and an answer of another version means the file
   * was saved since, even at the same length and slide count.
   */
  const versions = new Map<string, string>()

  /** Lets go of a document the file has changed under, once for all the requests that find it. */
  function changed(frame: PreviewFrame, key: string, sent: string): void {
    if (sent !== pageKey(key)) return
    outdated.set(key, (outdated.get(key) ?? 0) + 1)
    versions.delete(sent)
    frame.port.postMessage({ type: 'close', key: sent } satisfies PreviewRequest)
    for (const listener of [...(listeners.get(key) ?? [])]) listener()
  }

  /** Whether an answer came from another version of the file than the document's first answer did. */
  function otherVersion(sent: string, version: string | undefined): boolean {
    if (version === undefined) return false
    const first = versions.get(sent)
    if (first === undefined) versions.set(sent, version)
    return first !== undefined && first !== version
  }

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
      if ('error' in data) {
        if (errorKeyOf(data.error) === 'files.errors.changedWhileReading') changed(started.frame, request.key, request.sent)
        request.reject(new Error(data.error))
      } else if (request.sent !== pageKey(request.key)) {
        // An answer the old version gave after the change was found would mix the two versions in the viewer.
        request.reject(new Error(errorText('files.errors.changedWhileReading')))
      } else if (otherVersion(request.sent, data.version)) {
        changed(started.frame, request.key, request.sent)
        request.reject(new Error(errorText('files.errors.changedWhileReading')))
      } else request.resolve(data.value)
    })
    port.start()
    void started.frame.gone.then(() => end(started))
    return started
  }

  /**
   * Closes a document no handle holds and removes the frame once none is held. It runs after the handles of the
   * same render have been taken, so a card that gives a document up while the focus view takes it keeps it open.
   */
  function settle(key: string): void {
    if (holders.has(key) || !running) return
    versions.delete(pageKey(key))
    running.frame.port.postMessage({ type: 'close', key: pageKey(key) } satisfies PreviewRequest)
    if (holders.size === 0) end(running)
  }

  return {
    open<Open extends OpenPreviewDocument>(kind: string, file: PreviewFile): PreviewHandle<Open> {
      const key = documentKey(kind, file)
      const { url } = file
      holders.set(key, (holders.get(key) ?? 0) + 1)
      let held = true
      /** This handle's listeners, which its release stops. */
      const own = new Set<() => void>()
      const unlisten = (heard: () => void): void => {
        own.delete(heard)
        const all = listeners.get(key)
        all?.delete(heard)
        if (all?.size === 0) listeners.delete(key)
      }
      return {
        call(method, args) {
          if (!held) throw new Error(`the ${kind} document of ${url} was released`)
          running ??= start()
          const { frame, pending } = running
          const id = nextId++
          const sent = pageKey(key)
          return new Promise((resolve, reject) => {
            pending.set(id, { key, sent, resolve: (value) => resolve(value as never), reject })
            frame.port.postMessage({ type: 'call', id, key: sent, kind, url, method, args } satisfies PreviewRequest)
          })
        },
        onChanged(listener) {
          const heard = (): void => listener()
          own.add(heard)
          listeners.set(key, (listeners.get(key) ?? new Set()).add(heard))
          return () => unlisten(heard)
        },
        release() {
          if (!held) return
          held = false
          for (const heard of [...own]) unlisten(heard)
          const left = holders.get(key)! - 1
          if (left > 0) holders.set(key, left)
          else holders.delete(key)
          queueMicrotask(() => settle(key))
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

/**
 * Starts the preview page in an iframe nobody sees and hands it its port once it has loaded. Chromium runs no
 * animation frame in a frame it does not draw, as with display: none, visibility: hidden or a frame off the
 * screen, and pdf.js draws a page in steps it schedules on animation frames, so in such a frame a heavy page
 * never finished; a transparent frame of one pixel inside the window drew it (Electron 43.7.7, 2026-10-02).
 * The frame is kept from the pointer, the keyboard and the accessibility tree. Its sandbox leaves out popups:
 * a window the page opened would reach the window's open handler, which hands a web link to the default
 * browser. allow-same-origin keeps the page's own origin, which its module scripts and its reads need.
 */
export function startIframe(page: string): PreviewFrame {
  const iframe = document.createElement('iframe')
  iframe.style.cssText = 'position: fixed; left: 0; top: 0; width: 1px; height: 1px; border: 0; opacity: 0; pointer-events: none'
  iframe.inert = true
  iframe.sandbox.add('allow-scripts', 'allow-same-origin')
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
 * Opens a file in the preview page. The page reads a relative URL, as the demo's files have, from the server
 * that serves it.
 */
export function openPreviewDocument<Open extends OpenPreviewDocument>(kind: string, file: PreviewFile): PreviewHandle<Open> {
  client ??= createPreviewClient(() => startIframe(page))
  return client.open<Open>(kind, file)
}
