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
 * Whether the path sits under an allowed root, which are the jobs' working directories, the memory folder
 * and the folders allowed in the settings. Both sides are compared with symbolic links resolved, so a link
 * inside a root that points outside it, such as one checked into a cloned repository, is refused.
 */
export function isPathAllowed(target: string, allowedRoots: readonly string[]): boolean {
  if (!target.startsWith('/')) return false
  const resolved = realPath(target)
  return allowedRoots.some((root) => {
    if (!root) return false
    const resolvedRoot = realPath(root)
    // path.join leaves a single separator at the end, so the root folder "/" is a prefix of every path too.
    return resolved === resolvedRoot || resolved.startsWith(path.join(resolvedRoot, path.sep))
  })
}

/**
 * The absolute path with the symbolic links of its existing part resolved, spelled as the disk stores it.
 * The part that does not exist is kept as written, so that a missing file is still reported as missing by
 * the read that follows.
 */
function realPath(target: string): string {
  const rest: string[] = []
  let existing = path.resolve(target)
  for (;;) {
    try {
      // fs.realpathSync keeps the letter case and the Unicode normalization the path was written in, while
      // the default APFS volume matches names regardless of both. The native call returns the names as they
      // are stored, so a Japanese folder name written in the other normalization form, or a name in another
      // letter case, still matches its root.
      return path.join(fs.realpathSync.native(existing), ...rest)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err
      const parent = path.dirname(existing)
      if (parent === existing) throw err
      rest.unshift(path.basename(existing))
      existing = parent
    }
  }
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
