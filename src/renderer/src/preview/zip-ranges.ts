import { errorKey } from '@shared/i18n/error-key'
import {
  CENTRAL_LENGTH,
  CENTRAL_SIGNATURE,
  dataOf,
  damaged,
  DEFLATED,
  END_LENGTH,
  END_SIGNATURE,
  FLAG_DATA_DESCRIPTOR,
  FLAG_UTF8,
  joined,
  LOCAL_LENGTH,
  LOCAL_SIGNATURE,
  readable,
  readDirectory,
  STORED,
  TAIL_LENGTH,
  U16_FULL,
  U32_FULL,
  viewOf,
  type CentralRecord,
  type ZipEntry
} from '@shared/zip-directory'
import { fetchRange, loadFailed, readRange, versionText, type Bytes } from './ranges'

/**
 * A zip container (docx, xlsx, pptx) read by HTTP ranges, so that a viewer reads the directory and the entries
 * it shows and never the rest of the file. It runs in the preview iframe, with nothing but what a browser page
 * has, and throws its errors as keys, since the iframe does not load the dictionary. The directory is read as main
 * reads it (shared/zip-directory.ts); this adds reading by ranges, inflating an entry, and writing a slimmed zip.
 */

export type { ZipEntry } from '@shared/zip-directory'

export interface RangedZip {
  /**
   * The version of the file the zip is read from: its length and, where the server gives one, the ETag of the answer
   * that gave it. Every later answer has to come from the same version.
   */
  readonly version: string
  readonly entries: ReadonlyMap<string, ZipEntry>
  /** The content of one entry, inflated. */
  read(name: string): Promise<Bytes>
  /**
   * The same container with each entry `stub` chooses replaced by a stored entry whose content is its own path,
   * so that a library reading the container meets the entry without its bytes being read, and the path tells
   * the caller which entry to read later. An entry `contents` holds is written stored with that content instead,
   * and only the entries neither names are read from the file.
   */
  slimmed(stub: (name: string) => boolean, contents?: ReadonlyMap<string, Bytes>): Promise<Bytes>
}

/** The version of the format a reader needs for a stored or deflated entry without ZIP64. */
const VERSION_NEEDED = 20

/**
 * Inflates into the size the central directory declares, which the caller has compared with its limit, and stops
 * at the first byte past it, so that data inflating beyond its declared size takes no more memory than that.
 */
async function inflate(data: Bytes, size: number): Promise<Bytes> {
  const out = new Uint8Array(size)
  // A writer can store an empty file as deflated with no bytes at all, which is no deflate stream and which
  // DecompressionStream refuses; JSZip reads it as empty, and so does this.
  if (data.length === 0 && size === 0) return out
  let filled = 0
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader()
  for (;;) {
    // The stream fails on data that is not deflate, or that ends before its last block.
    const chunk = await reader.read().catch(() => null)
    if (chunk === null) throw damaged()
    if (chunk.done) break
    if (filled + chunk.value.length > size) {
      await reader.cancel()
      throw damaged()
    }
    out.set(chunk.value, filled)
    filled += chunk.value.length
  }
  if (filled !== size) throw damaged()
  return out
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Bytes): number {
  let crc = U32_FULL
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ U32_FULL) >>> 0
}

/** An entry of the slimmed zip: what its headers say, and the data that follows its local header. */
interface Written {
  record: CentralRecord
  flags: number
  method: number
  crc32: number
  size: number
  data: Bytes
}

/**
 * Writes the entries as a plain zip, with no extra fields, data descriptors or ZIP64 records, which a container
 * without its pictures does not need. One that would need them, for a count, an offset or the size of an entry,
 * is refused rather than written with fields that overflow.
 */
function writeZip(written: Written[]): Bytes {
  const localLength = written.reduce((sum, { record, data }) => sum + LOCAL_LENGTH + record.rawName.length + data.length, 0)
  const centralLength = written.reduce((sum, { record }) => sum + CENTRAL_LENGTH + record.rawName.length, 0)
  const total = localLength + centralLength + END_LENGTH
  if (written.length >= U16_FULL || total >= U32_FULL || written.some(({ size }) => size >= U32_FULL)) {
    throw new Error(errorKey('files.viewer.tooLarge'))
  }
  const out = new Uint8Array(total)
  const view = viewOf(out)
  const offsets: number[] = []
  let at = 0
  for (const { record, flags, method, crc32, size, data } of written) {
    offsets.push(at)
    view.setUint32(at, LOCAL_SIGNATURE, true)
    view.setUint16(at + 4, VERSION_NEEDED, true)
    view.setUint16(at + 6, flags, true)
    view.setUint16(at + 8, method, true)
    view.setUint16(at + 10, record.time, true)
    view.setUint16(at + 12, record.date, true)
    view.setUint32(at + 14, crc32, true)
    view.setUint32(at + 18, data.length, true)
    view.setUint32(at + 22, size, true)
    view.setUint16(at + 26, record.rawName.length, true)
    out.set(record.rawName, at + LOCAL_LENGTH)
    out.set(data, at + LOCAL_LENGTH + record.rawName.length)
    at += LOCAL_LENGTH + record.rawName.length + data.length
  }
  written.forEach(({ record, flags, method, crc32, size, data }, i) => {
    view.setUint32(at, CENTRAL_SIGNATURE, true)
    view.setUint16(at + 4, record.versionMadeBy, true)
    view.setUint16(at + 6, VERSION_NEEDED, true)
    view.setUint16(at + 8, flags, true)
    view.setUint16(at + 10, method, true)
    view.setUint16(at + 12, record.time, true)
    view.setUint16(at + 14, record.date, true)
    view.setUint32(at + 16, crc32, true)
    view.setUint32(at + 20, data.length, true)
    view.setUint32(at + 24, size, true)
    view.setUint16(at + 28, record.rawName.length, true)
    view.setUint16(at + 36, record.internalAttributes, true)
    view.setUint32(at + 38, record.externalAttributes, true)
    view.setUint32(at + 42, offsets[i], true)
    out.set(record.rawName, at + CENTRAL_LENGTH)
    at += CENTRAL_LENGTH + record.rawName.length
  })
  view.setUint32(at, END_SIGNATURE, true)
  view.setUint16(at + 8, written.length, true)
  view.setUint16(at + 10, written.length, true)
  view.setUint32(at + 12, centralLength, true)
  view.setUint32(at + 16, localLength, true)
  return out
}

/**
 * Opens the zip at url. It reads the last 64 KB by a suffix range, whose answer gives the file's length as it is
 * now, so a file saved again since it was listed is read as it is. Those bytes hold the end of central directory
 * record whatever its comment, and they are kept, so the part of the central directory or an entry inside them is
 * not read again. Every later answer has to come from the same version of the file.
 */
export async function openZip(url: string): Promise<RangedZip> {
  const tail = await fetchRange(url, `bytes=-${TAIL_LENGTH}`)
  // A suffix range holds no byte of an empty file alone.
  if (!tail) throw damaged()
  const { size, start: tailStart } = tail
  // A server that does not take a suffix range, such as Vite's for a file over 64 KB, sends other bytes.
  if (tailStart !== Math.max(0, size - TAIL_LENGTH) || tail.bytes.length !== size - tailStart) throw loadFailed(206)
  const read = (start: number, end: number): Promise<Bytes> => readRange(url, start, end, tail)
  const bytes = (start: number, end: number): Promise<Bytes> => joined(tail.bytes, tailStart, start, end, read)
  const records = await readDirectory(tail.bytes, tailStart, read)
  const byName = new Map(records.map((record) => [record.name, record]))

  return {
    version: versionText(tail),
    entries: byName,

    async read(name) {
      const record = byName.get(name)
      if (!record) throw new Error(errorKey('files.errors.zipEntryMissing', { path: name }))
      if (!readable(record)) throw new Error(errorKey('files.errors.zipEntryUnsupported', { path: name }))
      const data = dataOf(record, await bytes(record.offset, record.end))
      if (record.method === DEFLATED) return inflate(data, record.size)
      if (data.length !== record.size) throw damaged()
      // A copy, because the data can be a view of the kept tail, which a caller could transfer away.
      return data.slice()
    },

    async slimmed(stub, contents = new Map()) {
      const ordered = [...records].sort((a, b) => a.offset - b.offset)
      // The kept entries that lie next to each other in the file are read in one range.
      const runs: CentralRecord[][] = []
      let previousKept = false
      for (const record of ordered) {
        const keep = !contents.has(record.name) && !stub(record.name)
        if (keep && previousKept) runs.at(-1)!.push(record)
        else if (keep) runs.push([record])
        previousKept = keep
      }
      const kept = new Map<CentralRecord, Bytes>()
      await Promise.all(
        runs.map(async (run) => {
          const first = run[0].offset
          const read = await bytes(first, run.at(-1)!.end)
          for (const record of run) kept.set(record, dataOf(record, read.subarray(record.offset - first, record.end - first)))
        })
      )
      const encoder = new TextEncoder()
      return writeZip(
        ordered.map((record): Written => {
          const given = contents.get(record.name)
          if (given) return { record, flags: record.flags & FLAG_UTF8, method: STORED, crc32: crc32(given), size: given.length, data: given }
          const data = kept.get(record)
          if (data) return { record, flags: record.flags & ~FLAG_DATA_DESCRIPTOR, method: record.method, crc32: record.crc32, size: record.size, data }
          const path = encoder.encode(record.name)
          return { record, flags: record.flags & FLAG_UTF8, method: STORED, crc32: crc32(path), size: path.length, data: path }
        })
      )
    }
  }
}
