import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { errorText } from '@shared/i18n/error-text'
import { MACOS, WINDOWS, setCapabilities } from './helpers/platform'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async (original) => ({ ...(await original<typeof import('node:child_process')>()), spawn: (...args: unknown[]) => mocks.spawn(...args) }))
vi.mock('electron', () => ({ app: { on: vi.fn() } }))
vi.mock('../src/main/services/platform', () => import('./helpers/platform'))

function fakeChild(pid: number | undefined) {
  const written: string[] = []
  const stdin = new PassThrough()
  stdin.on('data', (data) => written.push(String(data)))
  return Object.assign(new EventEmitter(), { pid, stdin, kill: vi.fn(), written })
}

beforeEach(() => {
  mocks.spawn.mockReset()
})

describe('a speech process that reads nothing from ASIST', () => {
  it('runs on macOS in a process group of its own, with a watcher that stops the group if ASIST ends and is let go once it exits', async () => {
    setCapabilities(MACOS)
    const leader = fakeChild(4242)
    const watcher = fakeChild(4243)
    mocks.spawn.mockReturnValueOnce(leader).mockReturnValueOnce(watcher)
    const { spawnUnattended } = await import('../src/main/services/speech-worker')
    spawnUnattended('/app/llama-server', ['--port', '1'], { stdio: 'ignore', env: {} }, 'Qwen3-ASR 1.7B')
    expect(mocks.spawn.mock.calls[0][2]).toMatchObject({ detached: true })
    const [shell, args] = mocks.spawn.mock.calls[1] as [string, string[]]
    expect(shell).toBe('/bin/sh')
    expect(args.slice(-2)).toEqual(['asist-speech-watcher', '4242'])
    leader.emit('exit', 0)
    expect(watcher.written).toEqual(['\n'])
  })

  it('is not left running on macOS when its watcher cannot be started, and the error names the engine', async () => {
    setCapabilities(MACOS)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const leader = fakeChild(4242)
    mocks.spawn.mockReturnValueOnce(leader).mockReturnValueOnce(fakeChild(undefined))
    const { spawnUnattended } = await import('../src/main/services/speech-worker')
    expect(() => spawnUnattended('/app/llama-server', [], { stdio: 'ignore', env: {} }, 'Qwen3-ASR 1.7B'))
      .toThrow(errorText('voice.speech.watcherUnavailable', { engine: 'Qwen3-ASR 1.7B' }))
    expect(leader.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('stays on Windows in the job object libuv puts every child into, with no watcher', async () => {
    setCapabilities(WINDOWS)
    mocks.spawn.mockReturnValueOnce(fakeChild(4242))
    const { spawnUnattended } = await import('../src/main/services/speech-worker')
    spawnUnattended('C:\\app\\llama-server.exe', [], { stdio: 'ignore', env: {} }, 'Qwen3-ASR 0.6B')
    expect(mocks.spawn).toHaveBeenCalledOnce()
    expect(mocks.spawn.mock.calls[0][2]).toMatchObject({ detached: false })
  })
})
