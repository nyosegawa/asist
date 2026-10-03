import fs from 'node:fs/promises'
import { errorKeyOf } from '@shared/i18n/error-key'
import { errorText } from '@shared/i18n/error-text'
import { documentLeftOut, workbookLeftOut, type LeftOut } from '@shared/office-package'
import { entriesByName, readDirectory, TAIL_LENGTH, type ReadBytes } from '@shared/zip-directory'

/**
 * What the files card leaves unread of a Word document or an Excel workbook for its size, decided as the preview
 * page's viewers decide it (shared/office-package.ts), from the names and sizes the zip's directory declares, so that
 * the model is told what the card did not show. Main reads the zip's end records and its central directory and no
 * part of the file: parsing the user's file is the preview page's work, in a process of its own, so that a file that
 * holds that work up or takes it out of memory leaves the app and the conversation going. The directory is bounded
 * before it is parsed (shared/zip-directory.ts).
 */

/** Reads the bytes from start up to end of the open file, which has to still hold them. */
const reader =
  (file: fs.FileHandle, signal: AbortSignal): ReadBytes =>
  async (start, end) => {
    signal.throwIfAborted()
    const bytes = new Uint8Array(end - start)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, start)
    if (bytesRead !== bytes.length) throw new Error(errorText('files.errors.changedWhileReading'))
    return bytes
  }

/**
 * The largest file a file system can keep without allocating blocks for it: NTFS keeps a file of up to about 700
 * bytes inside its MFT record, and up to about 3.5 KB where the records are 4 KB, while an online-only file of
 * iCloud Drive or OneDrive of any size has no blocks until it is downloaded.
 */
export const KEPT_WITHOUT_BLOCKS = 4096

/** Whether the file's bytes are on this computer, so that reading them does not wait for a download. */
export const onThisComputer = ({ size, blocks }: { size: number; blocks: number }): boolean => size <= KEPT_WITHOUT_BLOCKS || blocks > 0

/**
 * What the size net leaves unread of the file, or null when the file is not on this computer: reading the directory
 * of an online-only file would wait for its download, which the card's viewer starts when it opens the file.
 */
export async function officeLeftOut(filePath: string, kind: 'docx' | 'xlsx', signal: AbortSignal): Promise<LeftOut | null> {
  const file = await fs.open(filePath, 'r')
  try {
    const stat = await file.stat()
    if (!onThisComputer(stat)) return null
    const { size } = stat
    const read = reader(file, signal)
    const tailStart = Math.max(0, size - TAIL_LENGTH)
    const records = await readDirectory(await read(tailStart, size), tailStart, read).catch((error: unknown) => {
      if (errorKeyOf(error) === 'files.viewer.tooLarge') return null
      throw error
    })
    // A directory too large to parse is too large to show, as the viewers find it.
    if (!records) return 'file'
    const entries = entriesByName(records)
    return kind === 'docx' ? documentLeftOut(entries) : workbookLeftOut(entries)
  } finally {
    await file.close()
  }
}
