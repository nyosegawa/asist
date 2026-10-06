import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildSync } from 'esbuild'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
/** How long a real process may take to start and to be stopped, with other test files running in parallel. */
const PROCESS_TIMING = { timeout: 10_000 }

// The watcher is a /bin/sh script that reads /bin/ps, and the bundled platform module derives the capabilities of
// the machine the test runs on; on Windows the job object of libuv ends the process instead.
describe.runIf(process.platform === 'darwin')('a speech process that reads nothing from ASIST, with real processes', { timeout: 30_000 }, () => {
  let root: string
  let starter: ChildProcess | undefined
  let started: number | undefined

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'asist-unattended-'))
    starter = undefined
    started = undefined
  })
  afterEach(() => {
    if (starter?.pid && alive(starter.pid)) starter.kill('SIGKILL')
    if (started && alive(started)) process.kill(started, 'SIGKILL')
    fs.rmSync(root, { recursive: true, force: true })
  })

  /** Starts, in a Node process of its own that stands for ASIST, a process that reads nothing, and resolves its PID. */
  async function startThroughAsist(script: string): Promise<number> {
    const electron = path.join(root, 'electron.cjs')
    fs.writeFileSync(electron, `exports.app={isPackaged:false,getAppPath:()=>${JSON.stringify(process.cwd())},on:()=>{}};`)
    const entry = path.join(root, 'asist.cjs')
    buildSync({
      stdin: {
        contents: `import { spawnUnattended } from './src/main/services/speech-worker'; const child = spawnUnattended(process.execPath, ['-e', ${JSON.stringify(script)}], { stdio: 'ignore', env: process.env }, 'fixture'); console.log(child.pid); setInterval(() => {}, 1000);`,
        resolveDir: process.cwd(),
        loader: 'ts'
      },
      outfile: entry, bundle: true, platform: 'node', format: 'cjs', target: 'node22',
      alias: { electron }, tsconfig: path.join(process.cwd(), 'tsconfig.node.json'), logLevel: 'silent'
    })
    starter = spawn(process.execPath, [entry], { stdio: ['ignore', 'pipe', 'inherit'] })
    let output = ''
    starter.stdout!.on('data', (data) => { output += String(data) })
    await vi.waitFor(() => expect(output).toContain('\n'), PROCESS_TIMING)
    started = Number(output.trim())
    return started
  }

  /** The watchers still running for the PID. ps writes the newlines of the watcher's script as \012, so its command line ends with the name and the PID. */
  const watchersOf = (pid: number): string[] => execFileSync('/bin/ps', ['-axww', '-o', 'command='], { encoding: 'utf8' })
    .split('\n').filter((line) => line.trimEnd().endsWith(`asist-speech-watcher ${pid}`))

  it('ends when the process that started it is killed, as the VOICEVOX engine did not', async () => {
    const pid = await startThroughAsist('setInterval(() => {}, 1000)')
    expect(alive(pid)).toBe(true)
    starter!.kill('SIGKILL')
    await vi.waitFor(() => expect(alive(pid)).toBe(false), PROCESS_TIMING)
  })

  it('leaves no watcher that could signal its PID later once it exits on its own', async () => {
    const pid = await startThroughAsist('setTimeout(() => process.exit(0), 300)')
    await vi.waitFor(() => expect(alive(pid)).toBe(false), PROCESS_TIMING)
    await vi.waitFor(() => expect(watchersOf(pid)).toEqual([]), PROCESS_TIMING)
  })
})
