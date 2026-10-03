import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * A new folder in the temporary folder, spelled with the names the disk stores, which is how git and ASIST
 * name a repository. On Windows %TEMP% can hold an 8.3 short name, as C:\Users\RUNNER~1 does on a machine whose
 * user name is longer than eight letters, which fs.realpathSync keeps and only the native call expands.
 */
export function longTempFolder(prefix: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), prefix)))
}

/**
 * A new folder in the user's temporary folder of Windows (%LOCALAPPDATA%\Temp, on the system drive) with its long
 * name, and the same folder spelled with its 8.3 short name, or null where the volume makes none. %TEMP% is not
 * used, since CI moves it to a drive without short names. Into a pipe, cmd.exe writes in the OEM code page, which
 * garbles a user name outside it; /u makes it write UTF-16LE.
 */
export function shortNamedFolder(prefix: string): { long: string; short: string | null } {
  const local = process.env.LOCALAPPDATA
  if (!local) throw new Error('LOCALAPPDATA is not set, so the temporary folder of Windows cannot be found')
  const long = fs.realpathSync.native(fs.mkdtempSync(path.join(local, 'Temp', prefix)))
  const short = execFileSync('cmd.exe', ['/d', '/u', '/s', '/c', `"for %I in ("${long}") do @echo %~sI"`], {
    encoding: 'utf16le',
    windowsHide: true,
    windowsVerbatimArguments: true
  }).trim()
  return { long, short: short.toLowerCase() === long.toLowerCase() ? null : short }
}
