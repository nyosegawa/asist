import path from 'node:path'

/**
 * The folders of a Windows PATH value, in order, as Windows searches them. A folder whose name holds `;`
 * is written in double quotes, and a quote only switches whether `;` separates, so the quotes are dropped
 * wherever they stand. An empty entry and a relative folder, which would be searched from whatever the
 * current folder is, are left out.
 */
export function windowsPathFolders(value: string): string[] {
  const folders: string[] = []
  let folder = ''
  let quoted = false
  for (const char of value) {
    if (char === '"') quoted = !quoted
    else if (char === ';' && !quoted) {
      folders.push(folder)
      folder = ''
    } else folder += char
  }
  folders.push(folder)
  return folders.filter((entry) => entry !== '' && path.win32.isAbsolute(entry))
}
