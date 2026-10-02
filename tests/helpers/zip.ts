/**
 * Where each entry of a zip lies in the file, from its local header to where the next entry or the central
 * directory starts, read from the central directory of a zip without ZIP64 records or a comment, as JSZip writes
 * one. The tests compare it with the ranges a reader asked for.
 */
export function entryRanges(file: Uint8Array): Map<string, { start: number; end: number }> {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
  const directory = view.getUint32(file.length - 22 + 16, true)
  const count = view.getUint16(file.length - 22 + 10, true)
  const starts: Array<{ name: string; start: number }> = []
  for (let at = directory, i = 0; i < count; i++) {
    const nameLength = view.getUint16(at + 28, true)
    starts.push({ name: new TextDecoder().decode(file.subarray(at + 46, at + 46 + nameLength)), start: view.getUint32(at + 42, true) })
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true)
  }
  const ends = [...starts.map(({ start }) => start), directory].sort((a, b) => a - b)
  return new Map(starts.map(({ name, start }) => [name, { start, end: ends.find((next) => next > start)! }]))
}
