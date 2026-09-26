import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Downloads url into file. With a sha256, anything but the pinned bytes stops the preparation. */
export async function download(url, file, sha256) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (sha256) {
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== sha256) throw new Error(`${url} has sha256 ${actual}, not the pinned ${sha256}`)
  }
  fs.writeFileSync(file, bytes)
}

/** Unpacks a .tar.gz, .tar.xz or .zip archive into dir. */
export function extract(archive, dir) {
  fs.mkdirSync(dir, { recursive: true })
  run(tarCommand(), ['-xf', archive, '-C', dir])
}

// The tar.exe of Windows is bsdtar, which reads zip like the tar of macOS. The GNU tar of Git Bash, often
// first on a developer's PATH, cannot.
function tarCommand() {
  if (process.platform !== 'win32') return 'tar'
  if (!process.env.SystemRoot) throw new Error('SystemRoot is not set, so the tar.exe of Windows cannot be found')
  return path.join(process.env.SystemRoot, 'System32', 'tar.exe')
}

/** Runs a command to completion, with its output on this terminal, and throws when it fails. */
export function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: 'inherit', windowsHide: true, ...options })
}

/** Stops with what to install when command cannot be started. */
export function requireCommand(command, install) {
  try {
    execFileSync(command, ['--version'], { stdio: 'ignore', windowsHide: true })
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${command} not found; ${install}`)
    throw error
  }
}

/** Whether output exists and none of inputs changed after it was written. */
export function upToDate(output, inputs) {
  if (!fs.existsSync(output)) return false
  const written = fs.statSync(output).mtimeMs
  return inputs.every((input) => fs.statSync(input).mtimeMs <= written)
}

/** Whether the VERSION stamp of a prepared tool records version and is newer than the module that prepares it. */
export function stampCurrent(stamp, version, module) {
  return upToDate(stamp, [module]) && fs.readFileSync(stamp, 'utf8').trim() === version
}

export function writeStamp(stamp, version) {
  fs.writeFileSync(stamp, `${version}\n`)
}

/** Runs work with a fresh folder under the system's temporary folder, and removes the folder afterwards. */
export async function withTemporaryDir(prefix, work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  try {
    return await work(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** Every file below dir, as a path relative to it with / between the parts, whatever the OS writes. */
export function filesBelow(dir) {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort()
}

/** The number of files below dir and their size in bytes. */
export function treeSize(dir) {
  const files = filesBelow(dir)
  const bytes = files.reduce((sum, file) => sum + fs.lstatSync(path.join(dir, file)).size, 0)
  return { files: files.length, bytes }
}

export const megabytes = (bytes) => `${(bytes / 1024 ** 2).toFixed(1)} MB`
