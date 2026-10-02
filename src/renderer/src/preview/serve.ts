/**
 * The preview page's side of the channel to the viewers (panels/viewers/preview-client.ts). A viewer opens its
 * file as a document of a kind and asks the document for what it draws; each kind is a file under methods/, so
 * that the work of one viewer lives in its own file and is loaded only when that viewer first asks for it.
 */

/** A document open in the preview page: what a viewer can ask of it by name, and how to let go of what it holds. */
export interface PreviewDocument {
  methods: Record<string, (args: never) => unknown>
  close?(): void
}

/** What a file under methods/ exports by default: opens the file at a URL as a document of its kind, named by the file. */
export type OpenPreviewDocument = (url: string) => Promise<PreviewDocument>

export type PreviewKinds = Record<string, () => Promise<{ default: OpenPreviewDocument }>>

/** A message from the viewers' side: a call to a method of a document, or the end of a document no viewer holds any more. */
export type PreviewRequest =
  | { type: 'call'; id: number; kind: string; url: string; method: string; args: unknown }
  | { type: 'close'; kind: string; url: string }

/**
 * The page's first message on its port, sent as soon as the port reaches it. A frame that loaded anything else,
 * such as an error, never sends it, and nothing else tells the viewers' side that the frame did not load the page.
 */
export const CONNECTED = 'connected'

export type PreviewReply = typeof CONNECTED | { id: number; value: unknown } | { id: number; error: string }

/** The key of a document. A URL never holds a space, so the key reads back as one kind and one URL. */
export const documentKey = (kind: string, url: string): string => `${kind} ${url}`

/**
 * The buffers and bitmaps in a result, which go to the viewer without a copy. A method gives up what it
 * returns: a buffer it also keeps is empty on its side afterwards.
 */
function transferables(result: unknown): Transferable[] {
  const found = new Set<Transferable>()
  const seen = new Set<object>()
  const stack = [result]
  while (stack.length > 0) {
    const value = stack.pop()
    if (value === null || typeof value !== 'object' || seen.has(value)) continue
    seen.add(value)
    if (value instanceof ArrayBuffer || value instanceof ImageBitmap) found.add(value)
    else if (ArrayBuffer.isView(value)) {
      if (value.buffer instanceof ArrayBuffer) found.add(value.buffer)
    } else stack.push(...Object.values(value))
  }
  return [...found]
}

async function openDocument(kinds: PreviewKinds, kind: string, url: string): Promise<PreviewDocument> {
  // Vite writes the keys of import.meta.glob as module specifiers, which end in /<name>.ts on every OS.
  const load = Object.entries(kinds).find(([specifier]) => specifier.endsWith(`/${kind}.ts`))?.[1]
  if (!load) throw new Error(`the preview page has no kind ${kind}`)
  const { default: open } = await load()
  return open(url)
}

/** Answers the viewers' requests on the port, keeping one document open for each kind and URL the viewers hold. */
export function servePreview(port: MessagePort, kinds: PreviewKinds): void {
  const documents = new Map<string, Promise<PreviewDocument>>()

  async function answer(request: Extract<PreviewRequest, { type: 'call' }>): Promise<void> {
    try {
      const key = documentKey(request.kind, request.url)
      let opening = documents.get(key)
      if (!opening) {
        opening = openDocument(kinds, request.kind, request.url)
        documents.set(key, opening)
      }
      const { methods } = await opening
      if (!Object.hasOwn(methods, request.method)) throw new Error(`the ${request.kind} preview has no method ${request.method}`)
      const value = await methods[request.method](request.args as never)
      port.postMessage({ id: request.id, value } satisfies PreviewReply, transferables(value))
    } catch (error) {
      port.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) } satisfies PreviewReply)
    }
  }

  port.addEventListener('message', ({ data }: MessageEvent<PreviewRequest>) => {
    if (data.type === 'call') {
      void answer(data)
      return
    }
    const key = documentKey(data.kind, data.url)
    const closing = documents.get(key)
    documents.delete(key)
    // A document that failed to open has nothing to let go of.
    void closing?.then(
      (opened) => opened.close?.(),
      () => undefined
    )
  })
  port.start()
  port.postMessage(CONNECTED satisfies PreviewReply)
}
