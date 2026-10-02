import type { OpenPreviewDocument } from '../../../src/renderer/src/preview/serve'

/**
 * A kind of the preview page for the tests of its channel, found by import.meta.glob as the app's kinds are. It
 * counts the documents it opens and closes, hands over a buffer it also keeps, and can leave a request unanswered.
 */

/** How many times a document of each URL was opened and closed. */
export const opened = new Map<string, number>()
export const closed = new Map<string, number>()

const count = (counts: Map<string, number>, url: string): void => void counts.set(url, (counts.get(url) ?? 0) + 1)

/** The buffer the last bytes call handed over, as the kind still holds it. */
export const kept: { buffer: ArrayBuffer | null } = { buffer: null }

const openEcho = async (url: string) => {
  count(opened, url)
  return {
    methods: {
      echo: (args: { text: string }) => ({ url, text: args.text }),
      bytes: (args: { length: number }) => {
        kept.buffer = new Uint8Array(args.length).fill(7).buffer
        return { pages: [{ bytes: new Uint8Array(kept.buffer) }] }
      },
      wait: () => new Promise<never>(() => undefined)
    },
    close: () => count(closed, url)
  }
}

export default openEcho satisfies OpenPreviewDocument
