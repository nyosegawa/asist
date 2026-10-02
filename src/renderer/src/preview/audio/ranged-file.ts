import { errorKey } from '@shared/i18n/error-key'
import { fetchRange, loadFailed, readRange, versionText, type Bytes } from '../ranges'

/**
 * A recording read by HTTP ranges from its start to its end, a piece at a time, so that what is held of it at
 * once is two pieces however long it is: the one being decoded and the next, asked for meanwhile.
 */

/** The size of a piece, which a two-hour MP3 at 128 kbps takes 27 of. */
export const PIECE_BYTES = 4 * 1024 * 1024

export const audioDamaged = (): Error => new Error(errorKey('files.errors.audioDamaged'))

export interface RangedFile {
  /** The file's length when its first piece was read. */
  readonly size: number
  /** The version of the file the first piece came from, which every later answer has to come from too. */
  readonly version: string
  /** The bytes [start, end), from the first piece when it holds them. */
  read(start: number, end: number): Promise<Bytes>
  /**
   * The bytes [start, end) in order, in pieces of at most PIECE_BYTES, each asked for while the caller works on
   * the one before it.
   */
  pieces(start: number, end: number): AsyncGenerator<Bytes>
}

/**
 * Opens the file at url by reading its first piece, whose answer gives the file's version as it is now. Once
 * `signal` aborts, the requests under way stop and no piece is asked for ahead.
 */
export async function openRangedFile(url: string, signal?: AbortSignal): Promise<RangedFile> {
  const first = await fetchRange(url, `bytes=0-${PIECE_BYTES - 1}`, signal)
  // A range holds no byte of an empty file.
  if (!first) throw audioDamaged()
  const { size, bytes: head } = first
  // A server that answers with other bytes than the range asked for is no server this can read by ranges.
  if (first.start !== 0 || head.length !== Math.min(size, PIECE_BYTES)) throw loadFailed(206)

  const read = (start: number, end: number): Promise<Bytes> =>
    end <= head.length ? Promise.resolve(head.subarray(start, end)) : readRange(url, start, end, first, signal)

  async function* pieces(start: number, end: number): AsyncGenerator<Bytes> {
    const ask = (from: number): Promise<Bytes> | null => (from < end && !signal?.aborted ? read(from, Math.min(end, from + PIECE_BYTES)) : null)
    let at = start
    let next: Promise<Bytes> | null = null
    try {
      // The first piece is already read, and what it holds of the range goes out first, the next piece asked for meanwhile.
      if (at < head.length) {
        const until = Math.min(end, head.length)
        next = ask(until)
        yield head.subarray(at, until)
        at = until
      } else {
        next = ask(at)
      }
      while (next) {
        const bytes = await next
        at += bytes.length
        next = ask(at)
        yield bytes
      }
    } finally {
      // A caller that stops early leaves the piece asked for ahead unread, and its failure unseen.
      next?.catch(() => undefined)
    }
  }

  return { size, version: versionText(first), read, pieces }
}
