import type { SileroRequest, SileroResponse } from './silero-worker'

/**
 * The typed client of silero-worker. It gathers microphone frames into chunks of 512 samples and
 * keeps the newest voice probability in latestProb.
 *
 * A failure creating the worker, loading the model or running inference only drops ready to false,
 * and the caller keeps working from the energy VAD alone. No failure here can discard speech.
 */

const CHUNK_SAMPLES = 512
/** Once this many chunks are unanswered, later chunks are dropped: the probability goes stale, but the conversation does not stop. */
const MAX_IN_FLIGHT = 8
/**
 * Beyond this age the probability counts as stale and the decision falls back to audio energy
 * alone. It normally updates once per 32 ms chunk, so a gap means the worker has lost the CPU. The
 * bound keeps a stale probability, usually a 0 from the silence just before, from discarding speech.
 */
const STALE_MS = 250
/** The backlog and staleness warnings are not repeated more often than this. */
const WARN_INTERVAL_MS = 5000

export interface SileroVadOptions {
  /** Replaces how the Worker is created, for tests. */
  workerFactory?: () => Worker
  /** Replaces the clock, for tests. */
  now?: () => number
}

export class SileroVad {
  private readonly workerFactory: () => Worker
  private readonly now: () => number
  private worker: Worker | null = null
  private initialization: Promise<void> | null = null
  private available = false
  private chunk = new Float32Array(CHUNK_SAMPLES)
  private chunkLength = 0
  private nextId = 1
  private newestProbId = 0
  private inFlight = 0
  /** When the last probability arrived. Compared with lastSentAt, it tells whether the probability is stale. */
  private latestProbAt = 0
  private lastSentAt = 0
  private lastWarnAt = -Infinity

  /** The voice probability of the newest chunk, from 0 to 1. It is 0 while the worker is not ready or is stopped. */
  latestProb = 0

  constructor(options: SileroVadOptions = {}) {
    this.workerFactory =
      options.workerFactory ??
      (() => new Worker(new URL('./silero-worker.ts', import.meta.url), { type: 'module' }))
    this.now = options.now ?? (() => performance.now())
  }

  /**
   * The probability to decide on. It is null, meaning energy alone decides, while the worker is not
   * ready and when chunks are going out but no probability has come back for STALE_MS. That keeps a
   * worker that has fallen behind from discarding speech as "not a voice" on a stale probability.
   */
  currentProb(): number | null {
    if (!this.available) return null
    if (this.lastSentAt > this.latestProbAt && this.now() - this.latestProbAt > STALE_MS) {
      this.warn(`silero vad stale (no result for ${STALE_MS}ms); energy-only until it catches up`)
      return null
    }
    return this.latestProb
  }

  private warn(message: string): void {
    const now = this.now()
    if (now - this.lastWarnAt < WARN_INTERVAL_MS) return
    this.lastWarnAt = now
    console.warn(message)
  }

  /** True once the probability can be used; while it is false the caller decides from energy alone. */
  get ready(): boolean {
    return this.available
  }

  /** Loads the model. A failure resolves rather than rejects, and leaves the caller on energy alone. */
  init(): Promise<void> {
    if (this.initialization) return this.initialization
    this.initialization = new Promise<void>((resolve) => {
      let worker: Worker
      try {
        worker = this.workerFactory()
      } catch (err) {
        console.warn('silero vad unavailable (worker creation failed):', err)
        resolve()
        return
      }
      const fail = (detail: string): void => {
        console.warn(`silero vad unavailable: ${detail}`)
        this.available = false
        this.latestProb = 0
        if (this.worker === worker) this.worker = null
        worker.terminate()
        resolve()
      }
      worker.onerror = (event) => fail(event.message || 'worker crashed')
      worker.onmessage = (event: MessageEvent<SileroResponse>) => {
        const message = event.data
        if (message.type === 'ready') {
          this.available = true
          resolve()
        } else if (message.type === 'prob') {
          this.inFlight = Math.max(0, this.inFlight - 1)
          // Responses can arrive out of order, so only a newer chunk's probability is taken.
          if (message.id > this.newestProbId) {
            this.newestProbId = message.id
            this.latestProb = message.prob
            this.latestProbAt = this.now()
          }
        } else {
          fail(message.message)
        }
      }
      this.worker = worker
      worker.postMessage({ type: 'init' } satisfies SileroRequest)
    })
    return this.initialization
  }

  /** Takes a 16 kHz mono frame of any length and gathers it into chunks of 512 samples. */
  push(frame: Float32Array): void {
    if (!this.available || !this.worker) return
    let offset = 0
    while (offset < frame.length) {
      const take = Math.min(frame.length - offset, CHUNK_SAMPLES - this.chunkLength)
      this.chunk.set(frame.subarray(offset, offset + take), this.chunkLength)
      this.chunkLength += take
      offset += take
      if (this.chunkLength === CHUNK_SAMPLES) {
        this.chunkLength = 0
        if (this.inFlight >= MAX_IN_FLIGHT) {
          this.warn(`silero vad fell behind (${this.inFlight} chunks in flight); dropping chunks`)
          continue
        }
        this.inFlight++
        this.lastSentAt = this.now()
        const copy = this.chunk.slice(0)
        this.worker.postMessage({ type: 'infer', id: this.nextId++, chunk: copy } satisfies SileroRequest, [
          copy.buffer
        ])
      }
    }
  }

  /** Clears the capture buffer and the LSTM state when the microphone restarts. */
  reset(): void {
    this.chunkLength = 0
    this.latestProb = 0
    this.latestProbAt = 0
    this.lastSentAt = 0
    if (this.available && this.worker) {
      this.worker.postMessage({ type: 'reset' } satisfies SileroRequest)
    }
  }

  /** Discards the worker when the microphone is turned off. The next init builds it again. */
  dispose(): void {
    this.worker?.terminate()
    this.worker = null
    this.initialization = null
    this.available = false
    this.chunkLength = 0
    this.latestProb = 0
    this.latestProbAt = 0
    this.lastSentAt = 0
    this.inFlight = 0
    this.newestProbId = 0
  }
}
