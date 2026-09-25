import type { DfnRequest, DfnResponse } from './dfn-worker'

/**
 * The typed client of dfn-worker. It gathers 48 kHz mono frames into chunks of 512 samples and
 * hands the denoised audio back through onOutput in the same order.
 *
 * Unlike SileroVad this transforms the audio path itself, so order must hold: while the worker is
 * in use every chunk goes through it and the output follows the order the responses arrive in,
 * which is the order they were sent.
 *
 * Nothing here interrupts the audio. A failure creating the worker, loading the model or running
 * inference, and a backlog of unanswered chunks alike, only switch later chunks to passing straight
 * through. The only audio ever lost is the few hundred milliseconds in flight at the switch.
 */

const CHUNK_SAMPLES = 512
/**
 * The limit on unanswered chunks, about 340 ms at 10.7 ms per 512-sample chunk. Against a measured
 * 0.6 ms per frame that is deep enough that only a broken worker reaches it. Past the limit the
 * audio passes through without noise suppression.
 */
const MAX_IN_FLIGHT = 32
/**
 * How long noise suppression stays off after a backlog stopped it. The load right after startup,
 * such as the turn-taking worker loading its model, settles within a few seconds, so the rest of
 * the session should not run without noise suppression.
 */
const RESUME_AFTER_MS = 2000

export interface DfnDenoiserOptions {
  /** Replaces how the Worker is created, for tests. */
  workerFactory?: () => Worker
  /** Replaces the clock, for tests. */
  now?: () => number
}

export class DfnDenoiser {
  private readonly workerFactory: () => Worker
  private readonly now: () => number
  private worker: Worker | null = null
  private initialization: Promise<void> | null = null
  /** True once the model is loaded and the worker can be used. */
  private loaded = false
  /** True while chunks go through the worker. A backlog switches it off and audio passes straight through. */
  private available = false
  /** Once noise suppression has stopped, the worker is used again from this time onwards. */
  private resumeAt = Infinity
  private chunk = new Float32Array(CHUNK_SAMPLES)
  private chunkLength = 0
  private nextId = 1
  /** The ids that have been sent and not yet answered. Responses must arrive in exactly this order. */
  private pendingIds: number[] = []
  /** A response below this id answers a chunk sent before noise suppression stopped or before a reset, and is ignored. */
  private ignoreBelowId = 0

  /** Receives each audio chunk, denoised or passed through, in the order the input arrived. */
  onOutput: ((chunk: Float32Array) => void) | null = null

  constructor(options: DfnDenoiserOptions = {}) {
    this.workerFactory =
      options.workerFactory ??
      (() => new Worker(new URL('./dfn-worker.ts', import.meta.url), { type: 'module' }))
    this.now = options.now ?? (() => performance.now())
  }

  /** True while chunks go through the worker; while it is false the audio passes straight through. */
  get ready(): boolean {
    return this.available
  }

  /** Loads the model. A failure resolves rather than rejects, and leaves the audio passing through. */
  init(): Promise<void> {
    if (this.initialization) return this.initialization
    this.initialization = new Promise<void>((resolve) => {
      let worker: Worker
      try {
        worker = this.workerFactory()
      } catch (err) {
        console.warn('dfn denoiser unavailable (worker creation failed):', err)
        resolve()
        return
      }
      const fail = (detail: string): void => {
        console.warn(`dfn denoiser unavailable: ${detail}`)
        this.loaded = false
        this.available = false
        // The chunks in flight are lost, at most a few hundred milliseconds. Audio continues
        // by passing straight through.
        this.pendingIds = []
        if (this.worker === worker) this.worker = null
        worker.terminate()
        resolve()
      }
      worker.onerror = (event) => fail(event.message || 'worker crashed')
      worker.onmessage = (event: MessageEvent<DfnResponse>) => {
        const message = event.data
        if (message.type === 'ready') {
          this.loaded = true
          this.available = true
          resolve()
        } else if (message.type === 'enhanced') {
          if (message.id < this.ignoreBelowId) return
          const expected = this.pendingIds.shift()
          if (expected === undefined) return
          if (expected !== message.id) {
            fail(`out-of-order response (expected ${expected}, got ${message.id})`)
            return
          }
          this.onOutput?.(message.chunk)
        } else {
          fail(message.message)
        }
      }
      this.worker = worker
      worker.postMessage({ type: 'init' } satisfies DfnRequest)
    })
    return this.initialization
  }

  /** Takes a 48 kHz mono frame of any length and gathers it into chunks of 512 samples. */
  push(frame: Float32Array): void {
    let offset = 0
    while (offset < frame.length) {
      const take = Math.min(frame.length - offset, CHUNK_SAMPLES - this.chunkLength)
      this.chunk.set(frame.subarray(offset, offset + take), this.chunkLength)
      this.chunkLength += take
      offset += take
      if (this.chunkLength === CHUNK_SAMPLES) {
        this.chunkLength = 0
        this.emitChunk(this.chunk)
      }
    }
  }

  private emitChunk(chunk: Float32Array): void {
    if (!this.available) {
      if (this.loaded && this.worker && this.now() >= this.resumeAt) {
        // The backlog has probably cleared. Nothing is unanswered, so order still holds when the
        // worker takes over again from a fresh state.
        console.log('dfn denoiser resumed')
        this.available = true
        this.resumeAt = Infinity
        this.worker.postMessage({ type: 'reset' } satisfies DfnRequest)
      } else {
        this.onOutput?.(chunk.slice(0))
        return
      }
    }
    if (!this.worker) {
      this.onOutput?.(chunk.slice(0))
      return
    }
    if (this.pendingIds.length >= MAX_IN_FLIGHT) {
      // The worker is behind and order can no longer be held, so noise suppression stops here and
      // resumes after RESUME_AFTER_MS.
      console.warn(`dfn denoiser fell behind (${this.pendingIds.length} frames); passing through`)
      this.available = false
      this.resumeAt = this.now() + RESUME_AFTER_MS
      this.pendingIds = []
      this.ignoreBelowId = this.nextId
      this.onOutput?.(chunk.slice(0))
      return
    }
    const id = this.nextId++
    this.pendingIds.push(id)
    const copy = chunk.slice(0)
    this.worker.postMessage({ type: 'infer', id, chunk: copy } satisfies DfnRequest, [copy.buffer])
  }

  /** Clears the capture buffer and the model state when the microphone restarts. */
  reset(): void {
    this.chunkLength = 0
    this.pendingIds = []
    this.ignoreBelowId = this.nextId
    if (this.loaded && this.worker) {
      // Restarting capture puts the worker back in use even if noise suppression had stopped.
      this.available = true
      this.resumeAt = Infinity
      this.worker.postMessage({ type: 'reset' } satisfies DfnRequest)
    }
  }

  /** Discards the worker when the microphone is turned off. The next init builds it again. */
  dispose(): void {
    this.worker?.terminate()
    this.worker = null
    this.initialization = null
    this.loaded = false
    this.available = false
    this.resumeAt = Infinity
    this.chunkLength = 0
    this.pendingIds = []
    this.onOutput = null
  }
}
