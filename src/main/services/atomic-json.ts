import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { errorText } from '@shared/i18n/error-text'

/**
 * Reads and writes the JSON files under userData. A write goes to a temporary file and is then renamed,
 * and the rename is the point at which the save counts as done. An abort is accepted until the rename
 * starts, and a rename that has started is awaited.
 */

/** A missing file returns null. Content that does not parse as JSON fails without touching the original file. */
export async function readJsonFile(filePath: string): Promise<unknown | null> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null
    throw error
  }
  try {
    return JSON.parse(raw) as unknown
  } catch (error) {
    throw new Error(errorText('app.storage.jsonBroken', { file: path.basename(filePath) }), { cause: error })
  }
}

export async function writeJsonFileAtomic(filePath: string, value: unknown, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.tmp`
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      signal
    })
    signal?.throwIfAborted()
    await fs.rename(temporaryPath, filePath)
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

/** The same write for a caller that reads and writes synchronously. */
export function writeJsonFileAtomicSync(filePath: string, value: unknown): void {
  fsSync.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.tmp`
  try {
    fsSync.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    fsSync.renameSync(temporaryPath, filePath)
  } catch (error) {
    fsSync.rmSync(temporaryPath, { force: true })
    throw error
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}
