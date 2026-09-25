import { describe, expect, it, vi } from 'vitest'
import { DfnDenoiser } from '../src/renderer/src/voice/DfnDenoiser'
import type { DfnRequest, DfnResponse } from '../src/renderer/src/voice/dfn-worker'

class FakeWorker {
  onmessage: ((event: MessageEvent<DfnResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  readonly posted: DfnRequest[] = []
  terminated = false

  postMessage(message: DfnRequest): void {
    this.posted.push(message)
  }

  terminate(): void {
    this.terminated = true
  }

  message(message: DfnResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<DfnResponse>)
  }
}

const asWorker = (worker: FakeWorker): Worker => worker as unknown as Worker

const infers = (worker: FakeWorker): Extract<DfnRequest, { type: 'infer' }>[] =>
  worker.posted.filter((m): m is Extract<DfnRequest, { type: 'infer' }> => m.type === 'infer')

async function readyDenoiser(): Promise<{
  dfn: DfnDenoiser
  worker: FakeWorker
  outputs: Float32Array[]
}> {
  const worker = new FakeWorker()
  const dfn = new DfnDenoiser({ workerFactory: () => asWorker(worker) })
  const outputs: Float32Array[] = []
  dfn.onOutput = (chunk) => outputs.push(chunk)
  const init = dfn.init()
  worker.message({ type: 'ready' })
  await init
  return { dfn, worker, outputs }
}

describe('DfnDenoiser', () => {
  it('groups frames into 512-sample chunks for the worker and outputs the answers in order', async () => {
    const { dfn, worker, outputs } = await readyDenoiser()
    expect(dfn.ready).toBe(true)

    dfn.push(new Float32Array(320))
    expect(infers(worker)).toHaveLength(0)
    // 640 samples make one chunk of 512 with 128 samples left over.
    dfn.push(new Float32Array(320))
    expect(infers(worker)).toHaveLength(1)
    expect(infers(worker)[0].chunk.length).toBe(512)
    // Nothing is output until the worker answers.
    expect(outputs).toHaveLength(0)

    const enhanced = new Float32Array(512).fill(0.5)
    worker.message({ type: 'enhanced', id: infers(worker)[0].id, chunk: enhanced })
    expect(outputs).toHaveLength(1)
    expect(outputs[0][0]).toBeCloseTo(0.5)
  })

  it('passes audio through before the worker is ready, so loading never stops the audio', () => {
    const worker = new FakeWorker()
    const dfn = new DfnDenoiser({ workerFactory: () => asWorker(worker) })
    const outputs: Float32Array[] = []
    dfn.onOutput = (chunk) => outputs.push(chunk)
    // The worker has not reported ready, so init is still pending.
    void dfn.init()

    const frame = new Float32Array(512).fill(0.25)
    dfn.push(frame)
    expect(outputs).toHaveLength(1)
    expect(outputs[0][0]).toBeCloseTo(0.25)
    expect(infers(worker)).toHaveLength(0)
  })

  it('passes audio through in an environment that cannot create a Worker', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const dfn = new DfnDenoiser({
        workerFactory: () => {
          throw new Error('no Worker in this environment')
        }
      })
      const outputs: Float32Array[] = []
      dfn.onOutput = (chunk) => outputs.push(chunk)
      await dfn.init()
      expect(dfn.ready).toBe(false)
      dfn.push(new Float32Array(1024))
      expect(outputs).toHaveLength(2)
    } finally {
      warn.mockRestore()
    }
  })

  it('falls back to passthrough when the worker reports an error, without stopping the audio', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { dfn, worker, outputs } = await readyDenoiser()
      dfn.push(new Float32Array(512))
      worker.message({ type: 'error', message: 'inference failed' })
      expect(dfn.ready).toBe(false)
      expect(worker.terminated).toBe(true)
      dfn.push(new Float32Array(512).fill(0.1))
      expect(outputs).toHaveLength(1)
      expect(outputs[0][0]).toBeCloseTo(0.1)
    } finally {
      warn.mockRestore()
    }
  })

  it('falls back to passthrough when the answers stall, and ignores the answers that arrive late', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { dfn, worker, outputs } = await readyDenoiser()
      // Push chunks up to MAX_IN_FLIGHT (32) without answering any of them.
      for (let i = 0; i < 32; i++) dfn.push(new Float32Array(512))
      expect(infers(worker)).toHaveLength(32)
      expect(outputs).toHaveLength(0)
      // The 33rd chunk crosses the limit and falls back to passthrough.
      dfn.push(new Float32Array(512).fill(0.3))
      expect(dfn.ready).toBe(false)
      expect(outputs).toHaveLength(1)
      expect(outputs[0][0]).toBeCloseTo(0.3)
      // A late answer for a stalled chunk must not join the output, because that would break the order.
      worker.message({ type: 'enhanced', id: infers(worker)[0].id, chunk: new Float32Array(512) })
      expect(outputs).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('drops the buffered samples and resets the state of the worker', async () => {
    const { dfn, worker } = await readyDenoiser()
    dfn.push(new Float32Array(320))
    dfn.reset()
    expect(worker.posted.some((m) => m.type === 'reset')).toBe(true)
    // After a reset the chunking starts over, so the 320 leftover samples are not carried across.
    dfn.push(new Float32Array(320))
    expect(infers(worker)).toHaveLength(0)
  })

  it('terminates the worker on dispose and creates a new one on the next init', async () => {
    const workers = [new FakeWorker(), new FakeWorker()]
    const factory = vi.fn(() => asWorker(workers[factory.mock.calls.length - 1]))
    const dfn = new DfnDenoiser({ workerFactory: factory })
    const first = dfn.init()
    workers[0].message({ type: 'ready' })
    await first
    dfn.dispose()
    expect(workers[0].terminated).toBe(true)
    expect(dfn.ready).toBe(false)
    const second = dfn.init()
    workers[1].message({ type: 'ready' })
    await second
    expect(dfn.ready).toBe(true)
  })
})

describe('DfnDenoiser recovery from a stall', () => {
  it('goes back to the worker two seconds after falling back, resetting it before it sends again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const clock = { now: 1000 }
      const worker = new FakeWorker()
      const dfn = new DfnDenoiser({ workerFactory: () => asWorker(worker), now: () => clock.now })
      const outputs: Float32Array[] = []
      dfn.onOutput = (chunk) => outputs.push(chunk)
      const init = dfn.init()
      worker.message({ type: 'ready' })
      await init
      for (let i = 0; i < 33; i++) dfn.push(new Float32Array(512))
      expect(dfn.ready).toBe(false)
      expect(outputs).toHaveLength(1)
      // Until two seconds have passed the denoiser stays in passthrough.
      clock.now += 1000
      dfn.push(new Float32Array(512).fill(0.2))
      expect(outputs).toHaveLength(2)
      expect(infers(worker)).toHaveLength(32)
      // The first chunk after two seconds resets the worker and goes through it again.
      clock.now += 1500
      const resets = worker.posted.filter((m) => m.type === 'reset').length
      dfn.push(new Float32Array(512).fill(0.4))
      expect(dfn.ready).toBe(true)
      expect(worker.posted.filter((m) => m.type === 'reset').length).toBe(resets + 1)
      expect(infers(worker)).toHaveLength(33)
      // Nothing is output until the answer arrives.
      expect(outputs).toHaveLength(2)
      worker.message({ type: 'enhanced', id: infers(worker)[32].id, chunk: new Float32Array(512).fill(0.9) })
      expect(outputs).toHaveLength(3)
      expect(outputs[2][0]).toBeCloseTo(0.9)
    } finally {
      warn.mockRestore()
      log.mockRestore()
    }
  })

  it('goes back to the worker on reset even while it is in passthrough', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { dfn, worker } = await readyDenoiser()
      for (let i = 0; i < 33; i++) dfn.push(new Float32Array(512))
      expect(dfn.ready).toBe(false)
      dfn.reset()
      expect(dfn.ready).toBe(true)
      dfn.push(new Float32Array(512))
      expect(infers(worker)).toHaveLength(33)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('DfnDenoiser stale answers after recovery', () => {
  it('keeps the worker when the answer for a chunk sent before the fallback arrives after recovery', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const clock = { now: 1000 }
      const worker = new FakeWorker()
      const dfn = new DfnDenoiser({ workerFactory: () => asWorker(worker), now: () => clock.now })
      const outputs: Float32Array[] = []
      dfn.onOutput = (chunk) => outputs.push(chunk)
      const init = dfn.init()
      worker.message({ type: 'ready' })
      await init
      for (let i = 0; i < 33; i++) dfn.push(new Float32Array(512))
      clock.now += 2500
      // The denoiser recovers here and sends this chunk as id 33.
      dfn.push(new Float32Array(512))
      expect(dfn.ready).toBe(true)
      // The answer for id 1, which was sent before the fallback, arrives late.
      worker.message({ type: 'enhanced', id: infers(worker)[0].id, chunk: new Float32Array(512) })
      expect(dfn.ready).toBe(true)
      expect(worker.terminated).toBe(false)
      worker.message({ type: 'enhanced', id: infers(worker)[32].id, chunk: new Float32Array(512).fill(0.7) })
      expect(outputs.at(-1)?.[0]).toBeCloseTo(0.7)
    } finally {
      warn.mockRestore()
      log.mockRestore()
    }
  })
})
