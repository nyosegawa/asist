import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('node:fs', () => ({ default: { existsSync: () => true } }))
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/unused', on: vi.fn() } }))

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    killed: false, exitCode: null, kill: vi.fn()
  })
}
let children: ReturnType<typeof fakeChild>[] = []
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
  vi.resetModules()
  vi.useFakeTimers()
  children = []
  mocks.spawn.mockImplementation(() => {
    const child = fakeChild()
    children.push(child)
    return child
  })
})
afterEach(async () => {
  const native = await import('../src/main/services/native-mic')
  native.stop()
  vi.clearAllTimers()
  vi.useRealTimers()
  Object.defineProperty(process, 'platform', platform)
  for (const child of children) {
    child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy()
  }
})

it('settles a start cancelled before the first frame and clears its deadline', async () => {
  const native = await import('../src/main/services/native-mic')
  let result: { ok: boolean } | undefined
  void native.start(() => {}, () => {}).then(value => { result = value })
  native.stop()
  await vi.advanceTimersByTimeAsync(0)
  expect(result?.ok).toBe(false)
  await vi.advanceTimersByTimeAsync(6_000)
  expect(mocks.spawn).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('settles the old start without stopping the replacement or forwarding old frames', async () => {
  const native = await import('../src/main/services/native-mic')
  const oldFrame = vi.fn()
  let oldResult: { ok: boolean } | undefined
  void native.start(oldFrame, () => {}).then(value => { oldResult = value })
  const currentFrame = vi.fn()
  const current = native.start(currentFrame, () => {})
  const samples = Buffer.from(new Float32Array([0.1, 0.2]).buffer)
  children[0].stdout.write(samples)
  children[1].stdout.write(samples)
  expect((await current).ok).toBe(true)
  await vi.advanceTimersByTimeAsync(0)
  expect(oldResult?.ok).toBe(false)
  expect(oldFrame).not.toHaveBeenCalled()
  expect(currentFrame).toHaveBeenCalledOnce()
  expect(children[1].stdin.writableEnded).toBe(false)
})
