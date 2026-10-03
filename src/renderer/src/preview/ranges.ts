import { errorKey } from '@shared/i18n/error-key'

/**
 * Reading a file of the user's by HTTP ranges, as the viewers that read only what they show do: the zip reader of
 * the Office files, pdf.js and the waveform of a recording. It runs in the preview iframe and throws its errors as
 * keys.
 */

export type Bytes = Uint8Array<ArrayBuffer>

export const loadFailed = (status: number): Error => new Error(errorKey('files.errors.loadFailed', { status }))

/**
 * The version of a file a reader holds: its length and, where the server gives one, the ETag of the answer that gave
 * it, which asist-file makes of the length and the time of change.
 */
export interface FileVersion {
  size: number
  etag: string | null
}

/** The version as a viewer compares it, the same for every reader. */
export const versionText = ({ size, etag }: FileVersion): string => JSON.stringify([size, etag])

/** The bytes of an answer to a Range request, where they start in the file, and the version of the file now. */
export interface RangeAnswer extends FileVersion {
  bytes: Bytes
  start: number
}

/**
 * Asks for a range of the file, and reads from the answer's Content-Range which bytes it holds and the file's
 * length, and its ETag. asist-file answers a range that holds no byte of the file with a 200 and the whole file,
 * which is left unread, and null stands for it. A signal that aborts stops the request.
 */
export async function fetchRange(url: string, range: string, signal?: AbortSignal): Promise<RangeAnswer | null> {
  const response = await fetch(url, { headers: { Range: range }, signal })
  if (!response.ok) throw loadFailed(response.status)
  const answered = /^bytes (\d+)-\d+\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '')
  if (response.status !== 206 || !answered) {
    await response.body?.cancel()
    // A 206 always names its range, so one whose Content-Range cannot be read is not an answer this can use.
    if (response.status === 206) throw loadFailed(response.status)
    return null
  }
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    start: Number(answered[1]),
    size: Number(answered[2]),
    etag: response.headers.get('ETag')
  }
}

/**
 * The bytes from start up to end of a file of the version first read. An answer from another version, or with other
 * bytes than those asked for, means the file was written again meanwhile, and the bytes read before no longer belong
 * with these. A file saved again at the same length shows only in its ETag.
 */
export async function readRange(url: string, start: number, end: number, version: FileVersion, signal?: AbortSignal): Promise<Bytes> {
  if (start === end) return new Uint8Array(0)
  const answer = await fetchRange(url, `bytes=${start}-${end - 1}`, signal)
  if (!answer || answer.size !== version.size || answer.etag !== version.etag || answer.start !== start || answer.bytes.length !== end - start) {
    throw new Error(errorKey('files.errors.changedWhileReading'))
  }
  return answer.bytes
}
