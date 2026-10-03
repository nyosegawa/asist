import fs from 'node:fs/promises'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import { errorKey, errorKeyOf } from '@shared/i18n/error-key'
import { documentTooLarge, partTooLarge, readWorkbookParts, sheetTooLarge } from '@shared/office-package'
import { damaged, dataOf, DEFLATED, readable, readDirectory, TAIL_LENGTH, type Bytes, type ReadBytes } from '@shared/zip-directory'

/**
 * What the files card leaves out of a Word document or an Excel workbook for its size, decided as the preview page's
 * viewers decide it (shared/office-package.ts) from the zip's directory, read here from the file, so that the model
 * is told what the card did not show. A workbook is read only as far as which part holds each sheet.
 */

/** Nothing, the whole file, or the sheets of a workbook the card leaves unread, by their names. */
export type LeftOut = { leaves: 'nothing' } | { leaves: 'file' } | { leaves: 'sheets'; sheets: string[] }

const decoder = new TextDecoder()

/** Inflates off main's thread, since a workbook part may be as large as the limit. */
const inflateRaw = promisify(zlib.inflateRaw)

/** Reads the bytes from start up to end of the open file, which has to still hold them. */
const reader =
  (file: fs.FileHandle): ReadBytes =>
  async (start, end) => {
    const bytes = new Uint8Array(end - start)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, start)
    if (bytesRead !== bytes.length) throw new Error(errorKey('files.errors.changedWhileReading'))
    return bytes
  }

export async function officeLeftOut(filePath: string, kind: 'docx' | 'xlsx'): Promise<LeftOut> {
  const file = await fs.open(filePath, 'r')
  try {
    const { size } = await file.stat()
    const read = reader(file)
    const tailStart = Math.max(0, size - TAIL_LENGTH)
    const records = await readDirectory(await read(tailStart, size), tailStart, read)
    if (kind === 'docx') return documentTooLarge(records) ? { leaves: 'file' } : { leaves: 'nothing' }
    const entries = new Map(records.map((record) => [record.name, record]))
    const workbook = await readWorkbookParts(entries.keys(), async (part) => {
      const record = entries.get(part)
      if (!record) throw new Error(errorKey('files.errors.zipEntryMissing', { path: part }))
      // The viewer refuses the whole workbook when its relationships or the workbook part are over the limit.
      if (partTooLarge(entries, part)) throw new Error(errorKey('files.viewer.tooLarge'))
      if (!readable(record)) throw new Error(errorKey('files.errors.zipEntryUnsupported', { path: part }))
      const data: Bytes = dataOf(record, await read(record.offset, record.end))
      // A writer can store an empty part as deflated with no bytes at all, which zlib refuses as no stream. Data that
      // is not deflate, or inflates past the size the directory declares, is a damaged file, as the viewer finds it.
      const content =
        record.method === DEFLATED && data.length > 0
          ? await inflateRaw(data, { maxOutputLength: Math.max(1, record.size) }).catch(() => {
              throw damaged()
            })
          : data
      if (content.length !== record.size) throw damaged()
      return decoder.decode(content)
    }).catch((error: unknown) => {
      if (errorKeyOf(error) === 'files.viewer.tooLarge') return null
      throw error
    })
    if (!workbook) return { leaves: 'file' }
    const sheets = workbook.sheets.filter((_, sheet) => sheetTooLarge(entries, workbook, sheet)).map(({ name }) => name)
    if (sheets.length === 0) return { leaves: 'nothing' }
    return sheets.length === workbook.sheets.length ? { leaves: 'file' } : { leaves: 'sheets', sheets }
  } finally {
    await file.close()
  }
}
