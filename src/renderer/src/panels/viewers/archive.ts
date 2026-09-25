export interface ArchiveEntry {
  /** The path inside the zip. A folder may or may not end with a slash. */
  path: string
  dir: boolean
  size: number
  compressedSize: number
}

export interface ArchiveRow {
  path: string
  name: string
  dir: boolean
  /** The depth in the tree, counted from 0 directly under the root. */
  depth: number
  size: number
  compressedSize: number
  /** The number of entries directly inside the folder. */
  children: number
}

interface Node {
  name: string
  path: string
  dir: boolean
  size: number
  compressedSize: number
  children: Map<string, Node>
}

/** Hidden files and what the macOS Finder adds are left out, as in main's folder listing. */
const hidden = (segments: string[]): boolean => segments.some((s) => s.startsWith('.') || s === '__MACOSX')

/**
 * Builds a tree from the entries and flattens it depth first, with folders before files and then by name at
 * each level. A zip that carries no folder entries still gets its intermediate folders, built from the paths
 * of the files.
 */
export function flattenArchive(entries: readonly ArchiveEntry[]): ArchiveRow[] {
  const root: Node = { name: '', path: '', dir: true, size: 0, compressedSize: 0, children: new Map() }
  for (const entry of entries) {
    const segments = entry.path.split('/').filter((s) => s !== '')
    if (segments.length === 0 || hidden(segments)) continue
    let node = root
    segments.forEach((segment, index) => {
      const last = index === segments.length - 1
      const path = segments.slice(0, index + 1).join('/')
      let child = node.children.get(segment)
      if (!child) {
        child = { name: segment, path, dir: !last || entry.dir, size: 0, compressedSize: 0, children: new Map() }
        node.children.set(segment, child)
      }
      if (last && !entry.dir) {
        child.size = entry.size
        child.compressedSize = entry.compressedSize
      }
      node = child
    })
  }
  const rows: ArchiveRow[] = []
  const walk = (node: Node, depth: number): void => {
    const children = [...node.children.values()].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, 'ja'))
    for (const child of children) {
      rows.push({ path: child.path, name: child.name, dir: child.dir, depth, size: child.size, compressedSize: child.compressedSize, children: child.children.size })
      walk(child, depth + 1)
    }
  }
  walk(root, 0)
  return rows
}

/** The number of files, with the totals of their uncompressed and compressed sizes. */
export function archiveTotals(rows: readonly ArchiveRow[]): { files: number; size: number; compressedSize: number } {
  let files = 0
  let size = 0
  let compressedSize = 0
  for (const row of rows) {
    if (row.dir) continue
    files++
    size += row.size
    compressedSize += row.compressedSize
  }
  return { files, size, compressedSize }
}
