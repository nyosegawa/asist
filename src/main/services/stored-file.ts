import fs from 'node:fs'
import path from 'node:path'
import { openStoredContent, storedContent, type StoredFormat } from '@shared/stored-format'
import { writeJsonFileAtomic, writeJsonFileAtomicSync } from './atomic-json'

/**
 * Opens what was read from a file under userData. When the file is of an older version, the original
 * is kept beside it as <name>.v<version>.json and the upgraded content replaces it, so that an upgrade
 * that went wrong can be undone by hand and the upgrade does not run again at every start.
 */

export function backupPath(file: string, version: number): string {
  const { dir, name, ext } = path.parse(file)
  return path.join(dir, `${name}.v${version}${ext}`)
}

export function openStoredFileSync<T>(file: string, stored: unknown, format: StoredFormat<T>): T {
  const opened = openStoredContent(format, stored)
  if (opened.storedVersion < format.version) {
    const backup = backupPath(file, opened.storedVersion)
    fs.copyFileSync(file, backup)
    fs.chmodSync(backup, 0o600)
    writeJsonFileAtomicSync(file, storedContent(format, opened.value))
    console.log(`${format.name}: upgraded from version ${opened.storedVersion} to ${format.version}, the original kept as ${path.basename(backup)}`)
  }
  return opened.value
}

export async function openStoredFile<T>(file: string, stored: unknown, format: StoredFormat<T>): Promise<T> {
  const opened = openStoredContent(format, stored)
  if (opened.storedVersion < format.version) {
    const backup = backupPath(file, opened.storedVersion)
    await fs.promises.copyFile(file, backup)
    await fs.promises.chmod(backup, 0o600)
    await writeJsonFileAtomic(file, storedContent(format, opened.value))
    console.log(`${format.name}: upgraded from version ${opened.storedVersion} to ${format.version}, the original kept as ${path.basename(backup)}`)
  }
  return opened.value
}
