import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMBEDDING_MODEL } from '@shared/memory-embedding'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  settings: { aizuchi: true, conversationLocale: 'ja-JP', voiceEngine: 'cascade', uiLocale: 'en-US' },
  startEmbedding: vi.fn(async () => false)
}))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('electron', () => ({ app: {
  isPackaged: false, getAppPath: () => '/unused', getPath: () => '/unused', on: vi.fn()
} }))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => mocks.settings }))
vi.mock('../src/main/services/asr', () => ({ available: async () => true, revive: async () => true }))
vi.mock('../src/main/services/tts', () => ({ available: async () => true, ensureEngine: async () => true }))
vi.mock('../src/main/services/aizuchi', () => ({ invalidate: vi.fn(), getBank: vi.fn() }))
vi.mock('../src/main/services/memory', () => ({ startEmbeddingIfEnabled: mocks.startEmbedding }))

function fakeChild(script: string) {
  const input: Array<{ id: string }> = []
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    exitCode: null as number | null, killed: false, kill: vi.fn(), input, script
  })
  child.kill.mockImplementation(() => { child.killed = true; return true })
  child.stdin.on('data', (data) => input.push(JSON.parse(String(data))))
  return child
}
type Child = ReturnType<typeof fakeChild>
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const arch = Object.getOwnPropertyDescriptor(process, 'arch')!
let children: Child[] = []
const classifierChildren = (): Child[] => children.filter((child) => child.script.endsWith('aizuchi_worker.py'))
let watchdog: typeof import('../src/main/services/watchdog')
let classifier: typeof import('../src/main/services/aizuchi-classifier')
let embedding: typeof import('../src/main/services/embedding')

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
  Object.defineProperty(process, 'arch', { ...arch, value: 'arm64' })
  vi.stubEnv('ASIST_EMBEDDING_PYTHON', '/unused/python')
  vi.spyOn(fs, 'existsSync').mockReturnValue(true)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  mocks.settings.aizuchi = true
  mocks.startEmbedding.mockClear()
  children = []
  mocks.spawn.mockReset().mockImplementation((_python: string, args: string[]) => {
    const child = fakeChild(args[0])
    children.push(child)
    return child
  })
  watchdog = await import('../src/main/services/watchdog')
  classifier = await import('../src/main/services/aizuchi-classifier')
  embedding = await import('../src/main/services/embedding')
})
afterEach(() => {
  classifier.stop()
  embedding.stop()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  Object.defineProperty(process, 'platform', platform)
  Object.defineProperty(process, 'arch', arch)
  for (const child of children) {
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
  }
})

async function classifierReady(child: Child): Promise<void> {
  child.stdout.write('ASIST_JSON:{"type":"ready"}\n')
  await vi.advanceTimersByTimeAsync(100)
  expect(classifier.running()).toBe(true)
}

describe('the watchdog', () => {
  it('starts the aizuchi classifier again after a timeout stopped it', async () => {
    watchdog.start(() => {})
    await vi.advanceTimersByTimeAsync(10)
    await classifierReady(classifierChildren()[0])
    const timedOut = classifier.classify({ prev: '', text: '明日の天気' }).catch(() => 'failed')
    await vi.advanceTimersByTimeAsync(5_100)
    expect(await timedOut).toBe('failed')
    expect(classifier.running()).toBe(false)

    await vi.advanceTimersByTimeAsync(30_000)
    const revived = classifierChildren()
    expect(revived).toHaveLength(2)
    await classifierReady(revived[1])
    const request = classifier.classify({ prev: '', text: '明日の天気' })
    await vi.advanceTimersByTimeAsync(10)
    revived[1].stdout.write(
      `ASIST_JSON:${JSON.stringify({ type: 'result', id: revived[1].input[0].id, cls: 'correct', prob: 0.9, complete: 0.9 })}\n`
    )
    await expect(request).resolves.toMatchObject({ cls: 'correct' })
  })

  it('leaves the aizuchi classifier stopped while aizuchi are not wanted', async () => {
    mocks.settings.aizuchi = false
    watchdog.start(() => {})
    await vi.advanceTimersByTimeAsync(60_000)
    expect(classifierChildren()).toEqual([])
  })

  it('has memory start the embedding worker again once it has exited, and leaves a running one alone', async () => {
    const starting = embedding.ensureStarted()
    const [child] = children
    child.stdout.write(`ASIST_JSON:{"type":"ready","dim":${EMBEDDING_MODEL.dim}}\n`)
    await vi.advanceTimersByTimeAsync(100)
    expect(await starting).toBe(true)
    watchdog.start(() => {})
    await vi.advanceTimersByTimeAsync(10)
    expect(mocks.startEmbedding).not.toHaveBeenCalled()

    child.exitCode = 1
    child.emit('exit', 1)
    expect(embedding.running()).toBe(false)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mocks.startEmbedding).toHaveBeenCalledOnce()
  })
})
