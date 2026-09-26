import path from 'node:path'
import fs from 'node:fs'
import { carriesUrl, classifyFile, MAX_TEXT_BYTES, TEXT_KINDS, type FileEntry, type FileItem } from '@shared/files'
import { t } from './i18n'

/**
 * The main-process side of the files card (show_files). It validates paths and reads files, and leaves
 * interpreting the content to the renderer's viewer.
 */

export { classifyFile } from '@shared/files'

/**
 * The path to read for target when it lies under an allowed root, which are the jobs' working directories,
 * the memory folder and the folders allowed in the settings, or null when it does not. Both sides are
 * compared as the OS resolves them, so a link inside a root that points outside it, such as one checked into
 * a cloned repository, is refused, and so is a .. that climbs out of such a link. The caller reads the
 * returned path and never target itself, so that what is read is what was checked.
 */
export function allowedPath(target: string, allowedRoots: readonly string[]): string | null {
  if (!target.startsWith('/')) return null
  const resolved = realPath(target)
  if (resolved === null) return null
  const allowed = allowedRoots.some((root) => {
    const resolvedRoot = root.startsWith('/') ? realPath(root) : null
    if (resolvedRoot === null) return false
    // path.join leaves a single separator at the end, so the root folder "/" is a prefix of every path too.
    return resolved === resolvedRoot || resolved.startsWith(path.join(resolvedRoot, path.sep))
  })
  return allowed ? resolved : null
}

/**
 * The absolute path the OS opens for target, spelled as the disk stores it. The names of the part that does
 * not exist are kept as written, so that the read that follows reports the file as missing; a . or .. among
 * them could never be reached, and the path is refused.
 */
function realPath(target: string): string | null {
  // The path is not normalized as text first: path.resolve would collapse "link/.." to the folder that holds
  // the link, while the OS follows the link first and climbs out of its target.
  const names = target.split('/').filter(Boolean)
  for (let existing = names.length; existing >= 0; existing--) {
    let real: string
    try {
      // fs.realpathSync keeps the letter case and the Unicode normalization the path was written in, while
      // the default APFS volume matches names regardless of both. The native call returns the names as they
      // are stored, so a Japanese folder name written in the other normalization form, or a name in another
      // letter case, still matches its root.
      real = fs.realpathSync.native(`/${names.slice(0, existing).join('/')}`)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') continue
      throw err
    }
    const missing = names.slice(existing)
    return missing.some((name) => name === '.' || name === '..') ? null : path.join(real, ...missing)
  }
  return null
}

const MAX_DIRECTORY_ENTRIES = 200

/** The contents of a folder, by name with folders first, leaving out hidden files and node_modules. */
export function listDirectory(dir: string): FileEntry[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const out: FileEntry[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push({ name: entry.name, path: full, kind: 'directory', sizeBytes: 0 })
    } else if (entry.isFile()) {
      let size = 0
      try {
        size = fs.statSync(full).size
      } catch {
        continue
      }
      out.push({ name: entry.name, path: full, kind: classifyFile(full), sizeBytes: size })
    }
  }
  out.sort((a, b) => {
    if ((a.kind === 'directory') !== (b.kind === 'directory')) return a.kind === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name, 'ja')
  })
  return out.slice(0, MAX_DIRECTORY_ENTRIES)
}

/**
 * Turns one path into a FileItem. A path that cannot be read comes back with the reason in `error`, so
 * that the caller can still show the other items. `toUrl` builds the asist-file:// URL binary kinds are
 * fetched over.
 */
export function readFileItem(filePath: string, toUrl: (filePath: string) => string): FileItem {
  const name = path.basename(filePath)
  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return {
      path: filePath,
      name,
      kind: 'binary',
      sizeBytes: 0,
      error: code === 'ENOENT' ? t('files.errors.missing') : String(error)
    }
  }
  if (stat.isDirectory()) {
    try {
      return { path: filePath, name, kind: 'directory', sizeBytes: 0, modifiedAt: stat.mtimeMs, entries: listDirectory(filePath) }
    } catch (error) {
      return { path: filePath, name, kind: 'directory', sizeBytes: 0, error: t('files.errors.folderFailed', { message: String(error) }) }
    }
  }
  if (!stat.isFile()) return { path: filePath, name, kind: 'binary', sizeBytes: 0, error: t('files.errors.notAFile') }
  const kind = classifyFile(filePath)
  const base: FileItem = { path: filePath, name, kind, sizeBytes: stat.size, modifiedAt: stat.mtimeMs }
  if (TEXT_KINDS.has(kind)) {
    try {
      const fd = fs.openSync(filePath, 'r')
      try {
        const buffer = Buffer.alloc(Math.min(stat.size, MAX_TEXT_BYTES))
        const read = fs.readSync(fd, buffer, 0, buffer.length, 0)
        base.text = buffer.subarray(0, read).toString('utf8')
        base.truncated = stat.size > MAX_TEXT_BYTES
      } finally {
        fs.closeSync(fd)
      }
    } catch (error) {
      return { ...base, error: t('files.errors.readFailed', { message: String(error) }) }
    }
  }
  if (carriesUrl(kind, filePath)) base.url = toUrl(filePath)
  return base
}
