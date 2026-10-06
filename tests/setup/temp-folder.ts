import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PREFIX = 'asist-test-'
/** The folder of a run, named after the pid of the Vitest that made it. */
const RUN = new RegExp(`^${PREFIX}(\\d+)-[A-Za-z0-9]{6}$`)
/** Chrome, git and the speech processes the tests start can hold a file for a moment after they exit. */
const REMOVE = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }
/** The variables os.tmpdir() reads, which the child processes of the tests read too. */
const TEMP_VARIABLES = process.platform === 'win32' ? ['TEMP', 'TMP'] : ['TMPDIR']

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Gives write and search permission back to a folder and every folder in it. The tests that check a permission
 * error take it from a folder and give it back in a finally, which a killed run, or a test that hangs past its
 * timeout, never reaches, and fs.rmSync fails with EACCES on a folder it may not list or empty. On Windows a mode
 * with the write bit clears the read-only attribute.
 */
function unlock(folder: string): void {
  fs.chmodSync(folder, 0o700)
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (entry.isDirectory()) unlock(path.join(folder, entry.name))
  }
}

function remove(folder: string): void {
  try {
    unlock(folder)
  } catch (error) {
    // Two runs that start together remove the same leftover. A folder in it disappears only after the other run
    // has unlocked the whole leftover, so fs.rmSync can remove what is left.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  fs.rmSync(folder, REMOVE)
}

/**
 * Gives the run one folder in the temporary folder and points os.tmpdir() of every worker into it, so that the
 * folders the tests make go when the run ends, whether it passes or fails. The workers start after this and
 * inherit the environment. A run killed before its teardown leaves its folder, which a later run removes once
 * the Vitest that made it is gone.
 */
export default function setup(): () => void {
  const parent = os.tmpdir()
  for (const name of fs.readdirSync(parent)) {
    const match = RUN.exec(name)
    if (match && !alive(Number(match[1]))) remove(path.join(parent, name))
  }
  const run = fs.mkdtempSync(path.join(parent, `${PREFIX}${process.pid}-`))
  const before = TEMP_VARIABLES.map((name) => [name, process.env[name]] as const)
  for (const name of TEMP_VARIABLES) process.env[name] = run
  // Watch mode runs the setup again after a restart, which must find the temporary folder it started from.
  return () => {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    remove(run)
  }
}
