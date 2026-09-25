import { beforeEach, expect, it, vi } from 'vitest'
import { NativeMicSource } from '@/voice/NativeMic'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
beforeEach(() => {
  vi.stubGlobal('window', { api: {
    micNativeStart: vi.fn(), micNativeStop: vi.fn(async () => {}),
    onMicNativeFrame: vi.fn(() => vi.fn()), onMicNativeStatus: vi.fn(() => vi.fn())
  } })
})

it('ignores an old failed native start after a replacement succeeds', async () => {
  const oldReply = deferred<{ ok: boolean; sampleRate: number }>()
  vi.mocked(window.api.micNativeStart)
    .mockReturnValueOnce(oldReply.promise)
    .mockResolvedValueOnce({ ok: true, sampleRate: 48_000 })
  const native = new NativeMicSource()
  let oldFinished = false
  const old = native.start(() => {}, () => {}).then(() => { oldFinished = true })
  native.stop()
  expect(await native.start(() => {}, () => {})).toBe(true)
  expect(oldFinished).toBe(true)
  const stops = vi.mocked(window.api.micNativeStop).mock.calls.length
  oldReply.resolve({ ok: false, sampleRate: 48_000 })
  await old
  for (let n = 0; n < 5; n++) await Promise.resolve()
  expect(window.api.micNativeStop).toHaveBeenCalledTimes(stops)
  native.stop()
})
