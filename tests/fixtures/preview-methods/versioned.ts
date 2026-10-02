import { errorKey } from '@shared/i18n/error-key'
import type { OpenPreviewDocument } from '../../../src/renderer/src/preview/serve'

/**
 * A kind of the preview page whose file can be saved again, for the tests of its channel: a document reads the
 * version of its file as it opens, and a later request fails with changedWhileReading, as the zip reader's does,
 * once the file has moved on. It counts the documents it opens and closes.
 */

/** The version of each file, by URL, which a test raises to save the file again. */
export const versions = new Map<string, number>()
export const openings = new Map<string, number>()
export const closings = new Map<string, number>()

const count = (counts: Map<string, number>, url: string): void => void counts.set(url, (counts.get(url) ?? 0) + 1)

const openVersioned = async (url: string) => {
  const version = versions.get(url) ?? 0
  count(openings, url)
  return {
    methods: {
      read: (): number => {
        if ((versions.get(url) ?? 0) !== version) throw new Error(errorKey('files.errors.changedWhileReading'))
        return version
      }
    },
    close: () => count(closings, url)
  }
}

export default openVersioned satisfies OpenPreviewDocument
