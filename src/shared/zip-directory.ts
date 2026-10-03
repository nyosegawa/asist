import { errorKey } from './i18n/error-key'

/**
 * The directory of a zip container (docx, xlsx, pptx), read from the end of the file before any entry is: the end
 * of central directory record, the ZIP64 records in front of it when a count, a size or an offset does not fit in
 * its field, and the central directory, laid out as PKWARE's APPNOTE describes them. Reading the bytes is left to
 * the caller, so that the preview page reads them by HTTP ranges and main reads them from the file, and both know
 * an entry's size before reading any of it. Errors are thrown as keys, since the preview page does not load the
 * dictionary.
 */

export type Bytes = Uint8Array<ArrayBuffer>

/** One file inside the zip, as the central directory describes it before any of its bytes are read. */
export interface ZipEntry {
  readonly name: string
  /** The size of the content, which a viewer compares with its limit before it reads the entry. */
  readonly size: number
  readonly compressedSize: number
}

/** An entry as the central directory records it, with where its local record lies in the file. */
export interface CentralRecord extends ZipEntry {
  readonly rawName: Bytes
  readonly versionMadeBy: number
  readonly flags: number
  readonly method: number
  readonly time: number
  readonly date: number
  readonly crc32: number
  readonly internalAttributes: number
  readonly externalAttributes: number
  /** Where the entry's local header starts in the file. */
  readonly offset: number
  /** Where the next entry, or the central directory, starts. The entry's local record never runs past it. */
  readonly end: number
}

/** Reads the bytes of the file from start up to end. */
export type ReadBytes = (start: number, end: number) => Promise<Bytes>

export const LOCAL_SIGNATURE = 0x04034b50
export const LOCAL_LENGTH = 30
export const CENTRAL_SIGNATURE = 0x02014b50
export const CENTRAL_LENGTH = 46
export const END_SIGNATURE = 0x06054b50
export const END_LENGTH = 22
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
const ZIP64_LOCATOR_LENGTH = 20
const ZIP64_END_SIGNATURE = 0x06064b50
const ZIP64_END_LENGTH = 56
const ZIP64_EXTRA_ID = 0x0001
/** The value a field of 16 or 32 bits holds when the real one is in the ZIP64 records. */
export const U16_FULL = 0xffff
export const U32_FULL = 0xffffffff
export const STORED = 0
export const DEFLATED = 8
export const FLAG_ENCRYPTED = 0x1
export const FLAG_DATA_DESCRIPTOR = 0x8
export const FLAG_UTF8 = 0x800
/** The end of central directory record with the longest comment, and the ZIP64 locator in front of it. */
export const TAIL_LENGTH = END_LENGTH + U16_FULL + ZIP64_LOCATOR_LENGTH

export const damaged = (): Error => new Error(errorKey('files.errors.zipDamaged'))

export const viewOf = (bytes: Bytes): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

/** A 64-bit field. It holds a size or an offset, so a value past Number's exact integers is no real one. */
function u64(view: DataView, at: number): number {
  const value = view.getBigUint64(at, true)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw damaged()
  return Number(value)
}

/**
 * Where the end of central directory record starts in the tail: the last signature whose comment fits before
 * the end of the file. Bytes may follow the comment, as a newline does after some exports, which JSZip and
 * SheetJS read past as well.
 */
function findEnd(tail: Bytes): number {
  const view = viewOf(tail)
  for (let at = tail.length - END_LENGTH; at >= 0; at--) {
    if (view.getUint32(at, true) === END_SIGNATURE && at + END_LENGTH + view.getUint16(at + 20, true) <= tail.length) return at
  }
  throw damaged()
}

/** The values of the ZIP64 extended information field, which stand in for the fields that hold U32_FULL. */
function zip64Values(extra: Bytes, wanted: number): number[] {
  const view = viewOf(extra)
  for (let at = 0; at + 4 <= extra.length; at += 4 + view.getUint16(at + 2, true)) {
    if (view.getUint16(at, true) !== ZIP64_EXTRA_ID) continue
    if (view.getUint16(at + 2, true) < wanted * 8 || at + 4 + wanted * 8 > extra.length) throw damaged()
    return Array.from({ length: wanted }, (_, i) => u64(view, at + 4 + i * 8))
  }
  throw damaged()
}

/** The central directory's records. `shift` is how far into the file the zip starts, which every offset is counted from. */
function parseCentral(directory: Bytes, count: number, directoryStart: number, shift: number): CentralRecord[] {
  const view = viewOf(directory)
  const decoder = new TextDecoder()
  const parsed: Array<Omit<CentralRecord, 'end'>> = []
  let at = 0
  for (let i = 0; i < count; i++) {
    if (at + CENTRAL_LENGTH > directory.length || view.getUint32(at, true) !== CENTRAL_SIGNATURE) throw damaged()
    const nameEnd = at + CENTRAL_LENGTH + view.getUint16(at + 28, true)
    const extraEnd = nameEnd + view.getUint16(at + 30, true)
    const next = extraEnd + view.getUint16(at + 32, true)
    if (next > directory.length) throw damaged()
    // The ZIP64 field carries, in this order, only the values whose own field is full.
    let size = view.getUint32(at + 24, true)
    let compressedSize = view.getUint32(at + 20, true)
    let offset = view.getUint32(at + 42, true)
    const full = [size, compressedSize, offset].filter((value) => value === U32_FULL).length
    if (full > 0) {
      const values = zip64Values(directory.subarray(nameEnd, extraEnd), full)
      if (size === U32_FULL) size = values.shift()!
      if (compressedSize === U32_FULL) compressedSize = values.shift()!
      if (offset === U32_FULL) offset = values.shift()!
    }
    const rawName = directory.slice(at + CENTRAL_LENGTH, nameEnd)
    parsed.push({
      name: decoder.decode(rawName),
      rawName,
      size,
      compressedSize,
      versionMadeBy: view.getUint16(at + 4, true),
      flags: view.getUint16(at + 8, true),
      method: view.getUint16(at + 10, true),
      time: view.getUint16(at + 12, true),
      date: view.getUint16(at + 14, true),
      crc32: view.getUint32(at + 16, true),
      internalAttributes: view.getUint16(at + 36, true),
      externalAttributes: view.getUint32(at + 38, true),
      offset: offset + shift
    })
    at = next
  }
  const starts = [...new Set(parsed.map((record) => record.offset)), directoryStart].sort((a, b) => a - b)
  return parsed.map((record) => {
    const end = starts.find((start) => start > record.offset)
    if (end === undefined || end > directoryStart || end - record.offset < LOCAL_LENGTH + record.compressedSize) throw damaged()
    return { ...record, end }
  })
}

/**
 * The central directory of a zip, from the last TAIL_LENGTH bytes of the file, which start at `tailStart`, and
 * `read` for anything in front of them: the ZIP64 end record, when the tail does not hold it, and the directory.
 */
export async function readDirectory(tail: Bytes, tailStart: number, read: ReadBytes): Promise<CentralRecord[]> {
  const bytes = (start: number, end: number): Promise<Bytes> => joined(tail, tailStart, start, end, read)
  const endAt = findEnd(tail)
  const endRecord = viewOf(tail.subarray(endAt))
  let count = endRecord.getUint16(10, true)
  let directoryLength = endRecord.getUint32(12, true)
  let directoryOffset = endRecord.getUint32(16, true)
  // The central directory ends where the records after it start: the ZIP64 end record or the end record.
  let directoryEnd = tailStart + endAt
  const locatorAt = endAt - ZIP64_LOCATOR_LENGTH
  if (locatorAt >= 0 && viewOf(tail.subarray(locatorAt)).getUint32(0, true) === ZIP64_LOCATOR_SIGNATURE) {
    // The ZIP64 end record ends where its locator starts, and is 56 bytes long without the extensible data that
    // only PKWARE's strong encryption writes, which this does not read. Its place is taken from there rather
    // than from the locator's offset, which bytes in front of the zip would move.
    const zip64At = tailStart + locatorAt - ZIP64_END_LENGTH
    if (zip64At < 0) throw damaged()
    const zip64 = viewOf(await bytes(zip64At, zip64At + ZIP64_END_LENGTH))
    if (zip64.getUint32(0, true) !== ZIP64_END_SIGNATURE) throw damaged()
    count = u64(zip64, 32)
    directoryLength = u64(zip64, 40)
    directoryOffset = u64(zip64, 48)
    directoryEnd = zip64At
  } else if (count === U16_FULL || directoryLength === U32_FULL || directoryOffset === U32_FULL) {
    throw damaged()
  }
  // Offsets count from the start of the zip, and bytes in front of it, such as a newline an export wrote first,
  // move every one by the same distance: the one between where the central directory is and where it is said to be.
  const directoryStart = directoryEnd - directoryLength
  const shift = directoryStart - directoryOffset
  if (shift < 0) throw damaged()
  return parseCentral(await bytes(directoryStart, directoryEnd), count, directoryStart, shift)
}

/** The bytes from start up to end: those in the tail taken from it, and those in front of it read. */
export async function joined(tail: Bytes, tailStart: number, start: number, end: number, read: ReadBytes): Promise<Bytes> {
  if (start >= tailStart) return tail.subarray(start - tailStart, end - tailStart)
  if (end <= tailStart) return read(start, end)
  const bytes = new Uint8Array(end - start)
  bytes.set(await read(start, tailStart))
  bytes.set(tail.subarray(0, end - tailStart), tailStart - start)
  return bytes
}

/** The compressed data inside the bytes of an entry's local record. */
export function dataOf(record: CentralRecord, local: Bytes): Bytes {
  const view = viewOf(local)
  if (local.length < LOCAL_LENGTH || view.getUint32(0, true) !== LOCAL_SIGNATURE) throw damaged()
  // The local extra field can differ from the central one: Excel writes a ZIP64 field in the local header alone.
  const start = LOCAL_LENGTH + view.getUint16(26, true) + view.getUint16(28, true)
  if (start + record.compressedSize > local.length) throw damaged()
  return local.subarray(start, start + record.compressedSize)
}

/** Whether the entry can be read: neither encrypted nor compressed by any method but storing and deflate. */
export const readable = (record: CentralRecord): boolean => (record.flags & FLAG_ENCRYPTED) === 0 && (record.method === STORED || record.method === DEFLATED)
