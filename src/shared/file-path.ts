/**
 * Path handling for shared and renderer code, which cannot import node:path. A path reaches them as the
 * OS wrote it, so each function takes both the POSIX form and the Windows forms: a drive letter followed
 * by either separator, as git writes C:/Users/..., and a UNC path \\server\share\....
 */

/** The start of an absolute path: "/", a drive letter with either separator, or the "\\" of a UNC path. */
export const ABSOLUTE_PATH_START = String.raw`(?:/|[A-Za-z]:[\\/]|\\\\)`

const ABSOLUTE = new RegExp(`^${ABSOLUTE_PATH_START}`)
const WINDOWS_FORM = /^(?:[A-Za-z]:|\\\\)/

const isSeparator = (char: string | undefined): boolean => char === '/' || char === '\\'

/**
 * How many characters of p name its root: "/" or "\", a drive such as "C:" or "C:\", or "\\server\share\"
 * with the separator after the share. A relative path has none.
 */
function rootLength(p: string): number {
  if (/^[A-Za-z]:/.test(p)) return isSeparator(p[2]) ? 3 : 2
  const unc = /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+[\\/]?/.exec(p)
  if (unc) return unc[0].length
  return isSeparator(p[0]) ? 1 : 0
}

/** Whether p names a place without depending on a current folder or a current drive. */
export function isAbsolutePath(p: string): boolean {
  return ABSOLUTE.test(p)
}

/** p without the separators at its end, except those that belong to its root, so "/" and "C:\" stay as they are. */
export function trimTrailingSeparator(p: string): string {
  const root = rootLength(p)
  let end = p.length
  while (end > root && isSeparator(p[end - 1])) end--
  return p.slice(0, end)
}

/** The last name in p, as path.basename gives it; the root alone has none. */
export function baseName(p: string): string {
  const trimmed = trimTrailingSeparator(p)
  const root = rootLength(trimmed)
  let start = trimmed.length
  while (start > root && !isSeparator(trimmed[start - 1])) start--
  return trimmed.slice(start)
}

/**
 * The folder that holds p, as path.dirname gives it: always the beginning of p as written, the root for
 * a name directly under it, and "." for a single relative name.
 */
export function dirName(p: string): string {
  const root = rootLength(p)
  let end = trimTrailingSeparator(p).length
  while (end > root && !isSeparator(p[end - 1])) end--
  while (end > root && isSeparator(p[end - 1])) end--
  return end === 0 ? '.' : p.slice(0, end)
}

/**
 * Whether two absolute paths name the same place as written. A path in the Windows form compares without
 * regard to the separator or the letter case, as Windows matches names; a POSIX path compares exactly.
 * Neither side is looked up on disk, so a link and its target differ.
 */
export function samePath(a: string, b: string): boolean {
  const left = trimTrailingSeparator(a)
  const right = trimTrailingSeparator(b)
  if (!WINDOWS_FORM.test(left) || !WINDOWS_FORM.test(right)) return left === right
  const folded = (p: string): string => p.replace(/\//g, '\\').toLowerCase()
  return folded(left) === folded(right)
}

/**
 * The part of p below the folder root, without separators at either end: "" for root itself, and null
 * for a path outside it, including one whose name only begins like root's last name. The two are
 * compared as samePath compares them.
 */
export function pathInside(root: string, p: string): string | null {
  const base = trimTrailingSeparator(root)
  if (!samePath(p.slice(0, base.length), base)) return null
  const rest = p.slice(base.length)
  if (rest !== '' && !isSeparator(rest[0]) && !isSeparator(base[base.length - 1])) return null
  let start = 0
  while (isSeparator(rest[start])) start++
  return trimTrailingSeparator(rest.slice(start))
}
