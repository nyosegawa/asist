import type { TurnMetricLog, TurnTimings } from '@shared/ipc'

export interface RequestTimings {
  typed: boolean
  speechEndAt?: number
}

type PendingMetrics = RequestTimings & { occurredAt: number }
interface TurnMeasurement {
  id: string
  snapshot: TurnTimings & { occurredAt: number; typed?: boolean }
  speechEndAt?: number
  completed: boolean
  /** How many times this entry has been saved. Among the rows with one id, the reader takes the highest value. */
  revision: number
  /** Whether a value changed after the last save. */
  dirty: boolean
  cleanupTimer?: ReturnType<typeof setTimeout>
}

/** The upper bound on waiting for playback to end, so that a turn whose body never arrives, or whose speech runs long, is still written. */
const IDLE_WAIT_MS = 120_000

/**
 * Keeps the generation of a response and its actual playback in one measurement. Values that arrive
 * after the turn is complete, such as when playback really started and how many barge-ins or ignored
 * aizuchi occurred during speech, are appended under the same id with the revision raised.
 */
export class TurnMetrics {
  private requests = new Map<string, PendingMetrics>()
  private turns = new Map<number, TurnMeasurement>()

  constructor(
    private readonly save: (payload: TurnMetricLog) => Promise<void>,
    private readonly now: () => number = () => performance.now(),
    private readonly wallNow: () => number = () => Date.now()
  ) {}

  beginRequest(id: string, timings: RequestTimings): void {
    this.requests.clear()
    this.requests.set(id, { ...timings, occurredAt: this.wallNow() })
  }

  discardRequest(id: string): void {
    this.requests.delete(id)
  }

  activate(turnId: number, requestId: string, timings: TurnTimings): void {
    const request = this.requests.get(requestId)
    if (!request) return
    this.turns.set(turnId, {
      id: requestId,
      snapshot: {
        ...timings,
        occurredAt: request.occurredAt,
        ...(request.typed ? { typed: true } : {})
      },
      speechEndAt: request.speechEndAt,
      completed: false,
      revision: 0,
      dirty: true
    })
    this.requests.delete(requestId)
  }

  update(turnId: number, timings: TurnTimings): boolean {
    const entry = this.turns.get(turnId)
    if (!entry) return false
    entry.snapshot = { ...entry.snapshot, ...timings }
    entry.dirty = true
    return true
  }

  /** Counts an event during playback, a barge-in or an aizuchi that was let pass. An unknown turn is ignored. */
  increment(turnId: number, key: 'userBackchannels' | 'bargeIns'): boolean {
    const entry = this.turns.get(turnId)
    if (!entry) return false
    entry.snapshot = { ...entry.snapshot, [key]: (entry.snapshot[key] ?? 0) + 1 }
    entry.dirty = true
    return true
  }

  /** Measures only when the first body segment sounds. A filler played while working, and typed input, are out of scope. */
  playbackStarted(turnId: number, segmentIndex: number): number | undefined {
    const entry = this.turns.get(turnId)
    if (segmentIndex !== 0 || !entry || entry.snapshot.typed || entry.snapshot.e2eMs !== undefined || entry.speechEndAt === undefined) {
      return undefined
    }
    const e2eMs = Math.max(0, Math.round(this.now() - entry.speechEndAt))
    entry.snapshot = { ...entry.snapshot, e2eMs }
    entry.dirty = true
    if (entry.completed) this.persist(entry)
    return e2eMs
  }

  /** Handles done from the brain: the measurement is saved, and events during playback are still accepted until playback ends. */
  finish(turnId: number): void {
    const entry = this.turns.get(turnId)
    if (!entry) return
    entry.completed = true
    if (entry.dirty) this.persist(entry)
    if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer)
    entry.cleanupTimer = setTimeout(() => this.discard(turnId), IDLE_WAIT_MS)
  }

  /**
   * The playback queue has run empty. A turn whose body playback is already measured is closed after
   * the changed values are appended. When the body has not arrived yet, which happens when only an
   * aizuchi finished sounding, the turn keeps waiting.
   */
  playbackIdle(turnId: number): void {
    const entry = this.turns.get(turnId)
    if (!entry || !entry.completed) return
    if (!entry.snapshot.typed && entry.snapshot.e2eMs === undefined) return
    if (entry.dirty) this.persist(entry)
    this.discard(turnId)
  }

  discard(turnId: number): void {
    const timer = this.turns.get(turnId)?.cleanupTimer
    if (timer) clearTimeout(timer)
    this.turns.delete(turnId)
  }

  private persist(entry: TurnMeasurement): void {
    const snapshot = entry.snapshot
    const hasMeasurement = (['vadMs', 'asrMs', 'aizuchiMs', 'ttftMs', 'ttsMs', 'e2eMs'] as const)
      .some((key) => typeof snapshot[key] === 'number' && Number.isFinite(snapshot[key]))
    if (!hasMeasurement) return
    entry.revision += 1
    entry.dirty = false
    const payload: TurnMetricLog = {
      id: entry.id,
      revision: entry.revision,
      ...snapshot
    }
    void this.save(payload).catch((firstError: unknown) => {
      setTimeout(() => {
        void this.save(payload).catch((secondError: unknown) => {
          console.warn('metrics persistence failed:', secondError ?? firstError)
        })
      }, 250)
    })
  }
}
