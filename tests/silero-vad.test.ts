import { describe, expect, it, vi } from 'vitest'
import { SileroVad } from '../src/renderer/src/voice/SileroVad'
import type { SileroRequest, SileroResponse } from '../src/renderer/src/voice/silero-worker'

class FakeWorker {
  onmessage: ((event: MessageEvent<SileroResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  readonly posted: SileroRequest[] = []
  terminated = false

  postMessage(message: SileroRequest): void {
    this.posted.push(message)
  }

  terminate(): void {
    this.terminated = true
  }

  message(message: SileroResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<SileroResponse>)
  }
}

const asWorker = (worker: FakeWorker): Worker => worker as unknown as Worker

async function readyVad(): Promise<{ vad: SileroVad; worker: FakeWorker }> {
  const worker = new FakeWorker()
  const vad = new SileroVad({ workerFactory: () => asWorker(worker) })
  const init = vad.init()
  worker.message({ type: 'ready' })
  await init
  return { vad, worker }
}

const frames = (worker: FakeWorker): Extract<SileroRequest, { type: 'infer' }>[] =>
  worker.posted.filter((m): m is Extract<SileroRequest, { type: 'infer' }> => m.type === 'infer')

describe('SileroVad', () => {
  it('batches frames into 512 samples before sending them to the worker and keeps the probability', async () => {
    const { vad, worker } = await readyVad()
    expect(vad.ready).toBe(true)

    // 320 samples are fewer than one 512-sample chunk, so nothing is sent yet.
    vad.push(new Float32Array(320))
    expect(frames(worker)).toHaveLength(0)
    // The second push brings the total to 640, which sends one chunk and leaves 128 samples buffered.
    vad.push(new Float32Array(320))
    expect(frames(worker)).toHaveLength(1)
    expect(frames(worker)[0].chunk.length).toBe(512)

    worker.message({ type: 'prob', id: frames(worker)[0].id, prob: 0.87 })
    expect(vad.latestProb).toBeCloseTo(0.87)
  })

  it('takes the probability of the newest chunk only, even when the replies arrive out of order', async () => {
    const { vad, worker } = await readyVad()
    vad.push(new Float32Array(512 * 2))
    const [first, second] = frames(worker)
    worker.message({ type: 'prob', id: second.id, prob: 0.9 })
    worker.message({ type: 'prob', id: first.id, prob: 0.1 })
    expect(vad.latestProb).toBeCloseTo(0.9)
  })

  it('stays usable with ready false where a Worker cannot be created', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const vad = new SileroVad({
        workerFactory: () => {
          throw new Error('no Worker in this environment')
        }
      })
      // init resolves instead of rejecting.
      await vad.init()
      expect(vad.ready).toBe(false)
      vad.push(new Float32Array(1024))
      expect(vad.latestProb).toBe(0)
    } finally {
      warn.mockRestore()
    }
  })

  it('gives up on detection after a worker error instead of discarding the audio', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { vad, worker } = await readyVad()
      vad.latestProb = 0.9
      worker.message({ type: 'error', message: 'inference failed' })
      expect(vad.ready).toBe(false)
      expect(vad.latestProb).toBe(0)
      expect(worker.terminated).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  it('reset clears the input buffer and the probability and resets the worker too', async () => {
    const { vad, worker } = await readyVad()
    vad.push(new Float32Array(320))
    vad.latestProb = 0.8
    vad.reset()
    expect(vad.latestProb).toBe(0)
    expect(worker.posted.some((m) => m.type === 'reset')).toBe(true)
    // After a reset the batching starts over, so the 320-sample remainder is not carried across.
    vad.push(new Float32Array(320))
    expect(frames(worker)).toHaveLength(0)
  })

  it('dispose terminates the worker and a later init builds a new one', async () => {
    const workers = [new FakeWorker(), new FakeWorker()]
    const factory = vi.fn(() => asWorker(workers[factory.mock.calls.length - 1]))
    const vad = new SileroVad({ workerFactory: factory })
    const first = vad.init()
    workers[0].message({ type: 'ready' })
    await first
    vad.dispose()
    expect(workers[0].terminated).toBe(true)
    expect(vad.ready).toBe(false)
    const second = vad.init()
    workers[1].message({ type: 'ready' })
    await second
    expect(vad.ready).toBe(true)
  })
})

describe('SileroVad currentProb does not judge speech from a stale probability', () => {
  async function readyVadWithClock(): Promise<{
    vad: SileroVad
    worker: FakeWorker
    clock: { now: number }
  }> {
    const clock = { now: 1000 }
    const worker = new FakeWorker()
    const vad = new SileroVad({ workerFactory: () => asWorker(worker), now: () => clock.now })
    const init = vad.init()
    worker.message({ type: 'ready' })
    await init
    return { vad, worker, clock }
  }

  it('returns the last probability while replies keep arriving', async () => {
    const { vad, worker, clock } = await readyVadWithClock()
    vad.push(new Float32Array(512))
    clock.now += 10
    worker.message({ type: 'prob', id: frames(worker)[0].id, prob: 0.8 })
    clock.now += 100
    expect(vad.currentProb()).toBeCloseTo(0.8)
  })

  it('returns null when no probability arrives for 250 ms after a chunk was sent, leaving only the energy check', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { vad, worker, clock } = await readyVadWithClock()
      vad.push(new Float32Array(512))
      clock.now += 10
      // The silence just before the utterance.
      worker.message({ type: 'prob', id: frames(worker)[0].id, prob: 0.05 })
      clock.now += 50
      // Speech starts, but the worker never answers for this chunk.
      vad.push(new Float32Array(512))
      clock.now += 300
      expect(vad.currentProb()).toBeNull()
      expect(warn).toHaveBeenCalledTimes(1)
      // Once a reply comes back, the probability is used again.
      worker.message({ type: 'prob', id: frames(worker)[1].id, prob: 0.9 })
      expect(vad.currentProb()).toBeCloseTo(0.9)
    } finally {
      warn.mockRestore()
    }
  })

  it('returns null while it is not ready', async () => {
    const vad = new SileroVad({
      workerFactory: () => {
        throw new Error('no Worker')
      }
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await vad.init()
      expect(vad.currentProb()).toBeNull()
    } finally {
      warn.mockRestore()
    }
  })

  it('warns at most once every 5 seconds while a backlog makes it drop chunks', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { vad, worker } = await readyVadWithClock()
      // Eight chunks are sent and the remaining four are dropped.
      vad.push(new Float32Array(512 * 12))
      expect(frames(worker)).toHaveLength(8)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})
