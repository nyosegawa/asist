import { describe, expect, it, vi } from 'vitest'
import { errorKey } from '@shared/i18n/error-key'
import { DIRECTORY_LIMIT, MOST_ENTRIES, readDirectory, type Bytes } from '@shared/zip-directory'
import { manyEntriesDeclared } from './helpers/workbook'

/**
 * Reading a zip's directory, which the preview page and main share. The file is given as its last bytes and a reader
 * for the rest, which counts what it is asked for.
 */

const tooLarge = errorKey('files.viewer.tooLarge')

/** A zip of `count` empty stored entries, each named a single letter, with its directory after them. */
function emptyEntries(count: number): Bytes {
  const local = 30 + 1
  const central = 46 + 1
  const out = new Uint8Array(count * (local + central) + 22)
  const view = new DataView(out.buffer)
  let at = 0
  for (let i = 0; i < count; i++) {
    view.setUint32(at, 0x04034b50, true)
    view.setUint16(at + 26, 1, true)
    out[at + 30] = 0x61
    at += local
  }
  const directoryStart = at
  for (let i = 0; i < count; i++) {
    view.setUint32(at, 0x02014b50, true)
    view.setUint16(at + 28, 1, true)
    view.setUint32(at + 42, i * local, true)
    out[at + 46] = 0x61
    at += central
  }
  view.setUint32(at, 0x06054b50, true)
  view.setUint16(at + 8, count, true)
  view.setUint16(at + 10, count, true)
  view.setUint32(at + 12, at - directoryStart, true)
  view.setUint32(at + 16, directoryStart, true)
  return out
}

describe('the directory of a zip', () => {
  it('says a directory of as many entries as a zip can count or more is too large, before reading any of it', async () => {
    const read = vi.fn(async (): Promise<Bytes> => new Uint8Array())
    await expect(readDirectory(manyEntriesDeclared(MOST_ENTRIES), 0, read)).rejects.toThrow(tooLarge)
    await expect(readDirectory(manyEntriesDeclared(300_000), 0, read)).rejects.toThrow(tooLarge)
    expect(read).not.toHaveBeenCalled()
  })

  it('says a directory larger than the limit is too large, before reading any of it', async () => {
    const read = vi.fn(async (): Promise<Bytes> => new Uint8Array())
    await expect(readDirectory(manyEntriesDeclared(1000, DIRECTORY_LIMIT + 1), DIRECTORY_LIMIT + 1, read)).rejects.toThrow(tooLarge)
    expect(read).not.toHaveBeenCalled()
  })

  it('finds where each of 65,000 entries ends in a time that grows with their number, not its square', async () => {
    const file = emptyEntries(65_000)
    let fastest = Infinity
    for (let run = 0; run < 3; run++) {
      const before = process.threadCpuUsage()
      const records = await readDirectory(file, 0, async () => {
        throw new Error('the whole file is the tail')
      })
      const { user, system } = process.threadCpuUsage(before)
      fastest = Math.min(fastest, (user + system) / 1000)
      expect(records).toHaveLength(65_000)
      expect(records.slice(0, 2).map(({ offset, end }) => [offset, end])).toEqual([
        [0, 31],
        [31, 62]
      ])
    }
    // The processor time of the test's own thread, which neither the other test files running beside it nor the
    // collector's helper threads lengthen, as they lengthened the time on the clock past a bound of 400 ms. On an M5
    // under a load average of 33, a search through every start for each entry took 1,055 to 1,094 ms of it and the
    // binary search 20 to 29 ms (2026-10-03). Ten times fewer entries do not tell the two apart: the binary search's
    // time on the clock grew 49 to 121 times from 6,500 entries to 65,000 as the collector began to run, against
    // about 90 times for the search through every start.
    expect(fastest).toBeLessThan(400)
  })
})
