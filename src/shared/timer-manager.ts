import { errorText } from './i18n/error-text'
import type { StoredFormat } from './stored-format'
import type { AppTimer, TimerCreateRequest, TimerEvent } from './ipc'

const MAX_TIMEOUT_MS = 2_147_483_647
const MAX_FINISHED_TIMERS = 50
const PERSIST_RETRY_MS = 1_000
const NOTIFICATION_RETRY_MS = 5_000

/** What the timers file holds. Its format version is written and checked where the file is read. */
export interface TimerPersistenceData {
  timers: AppTimer[]
}

interface TimerManagerOptions {
  load: () => unknown
  save: (data: TimerPersistenceData) => void
  /** What a timer is called when the request carries no label, in the language of the interface. */
  defaultLabel: () => string
  notify: (timer: AppTimer) => void | Promise<void>
  onEvent?: (event: TimerEvent) => void
  now?: () => number
  schedule?: (callback: () => void, delayMs: number) => unknown
  cancelSchedule?: (handle: unknown) => void
}

export class TimerManager {
  private readonly records = new Map<string, AppTimer>()
  private readonly handles = new Map<string, unknown>()
  private readonly notificationHandles = new Map<string, unknown>()
  private readonly notifying = new Set<string>()
  /**
   * When the notification was shown but only saving the delivered state failed, the same process
   * retries the save without showing the notification again. If the process dies in that window the
   * timer is still pending and will be shown a second time. An OS notification and a disk update
   * cannot be made atomic, so this small duplicate window is accepted in exchange for an at-least-once
   * outbox that never loses a notification.
   */
  private readonly shownThisProcess = new Set<string>()
  private initialized = false
  private readonly now: () => number
  private readonly schedule: (callback: () => void, delayMs: number) => unknown
  private readonly cancelSchedule: (handle: unknown) => void

  constructor(private readonly options: TimerManagerOptions) {
    this.now = options.now ?? Date.now
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.cancelSchedule =
      options.cancelSchedule ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  init(): void {
    if (this.initialized) return
    const persisted = parseTimerPersistenceData(this.options.load())
    for (const timer of persisted.timers) this.records.set(timer.id, timer)
    this.initialized = true

    // An active timer whose deadline passed while the app was closed expires once here, at startup.
    for (const timer of [...this.records.values()]) {
      if (timer.status === 'active') this.arm(timer.id)
      else if (timer.notificationStatus === 'pending') this.deliverNotification(timer.id)
    }
  }

  list(): AppTimer[] {
    this.init()
    return [...this.records.values()]
      .map(cloneTimer)
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === 'active' ? -1 : 1
        return a.status === 'active'
          ? a.endsAt - b.endsAt
          : (b.finishedAt ?? b.endsAt) - (a.finishedAt ?? a.endsAt)
      })
  }

  /**
   * An id that already exists is returned as it is rather than rescheduled, so that StrictMode's
   * double render and reopening the card at a larger size still leave one timer.
   */
  create(request: TimerCreateRequest): AppTimer {
    this.init()
    const id = request.id.trim()
    if (!id) throw new Error(errorText('cardsTime.timer.errors.idRequired'))
    if (!Number.isInteger(request.seconds) || request.seconds <= 0) {
      throw new Error(errorText('cardsTime.timer.errors.seconds'))
    }
    const label = request.label?.trim() || this.options.defaultLabel()
    const existing = this.records.get(id)
    if (existing) {
      if (existing.seconds !== request.seconds || existing.label !== label) {
        throw new Error(errorText('cardsTime.timer.errors.idConflict'))
      }
      return cloneTimer(existing)
    }

    const createdAt = this.now()
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
      throw new Error(errorText('cardsTime.timer.errors.clockInvalid'))
    }
    const timer: AppTimer = {
      id,
      label,
      seconds: request.seconds,
      createdAt,
      endsAt: createdAt + request.seconds * 1000,
      status: 'active',
      notificationStatus: undefined
    }
    if (!Number.isSafeInteger(timer.endsAt)) throw new Error(errorText('cardsTime.timer.errors.tooLong'))
    const next = new Map(this.records)
    next.set(id, timer)
    this.saveAndReplace(next)
    this.emit({ type: 'updated', timer: cloneTimer(timer) })
    this.arm(id)
    return cloneTimer(timer)
  }

  cancel(id: string): boolean {
    this.init()
    const key = id.trim()
    if (!this.records.has(key)) return false
    const next = new Map(this.records)
    next.delete(key)
    // A failed save leaves both the running schedule and the in-memory state as they were.
    this.saveAndReplace(next)
    this.clearHandle(key)
    this.emit({ type: 'removed', id: key })
    return true
  }

  /**
   * Arms every active timer again against the wall clock, which the caller does when the Mac wakes.
   * Node's timers on macOS run on a clock that stops while the Mac sleeps, so a schedule armed before
   * a sleep fires as late as the sleep was long, and a timer that ended during it would be announced
   * only then.
   */
  resync(): void {
    for (const timer of [...this.records.values()]) {
      if (timer.status === 'active') this.arm(timer.id)
    }
  }

  /** Drops the schedules only. An active timer stays active and is picked up at the next start. */
  shutdown(): void {
    for (const handle of this.handles.values()) this.cancelSchedule(handle)
    for (const handle of this.notificationHandles.values()) this.cancelSchedule(handle)
    this.handles.clear()
    this.notificationHandles.clear()
  }

  private arm(id: string): void {
    const timer = this.records.get(id)
    if (!timer || timer.status !== 'active') return
    this.clearHandle(id)
    const remaining = timer.endsAt - this.now()
    if (remaining <= 0) {
      this.finish(id)
      return
    }
    const handle = this.schedule(() => this.arm(id), Math.min(remaining, MAX_TIMEOUT_MS))
    this.handles.set(id, handle)
  }

  private finish(id: string): void {
    const timer = this.records.get(id)
    if (!timer || timer.status !== 'active') return
    this.clearHandle(id)
    const finished: AppTimer = {
      ...timer,
      status: 'finished',
      finishedAt: this.now(),
      notificationStatus: 'pending'
    }
    const next = new Map(this.records)
    next.set(id, finished)

    // The finished state is saved before the notification. If the save fails the timer stays active
    // and is retried, so it never becomes a timer that was notified while disk still says active,
    // which would notify a second time.
    try {
      this.saveAndReplace(next)
    } catch (err) {
      console.warn('timer persistence failed; retrying:', err)
      this.handles.set(id, this.schedule(() => this.arm(id), PERSIST_RETRY_MS))
      return
    }
    const snapshot = cloneTimer(finished)
    this.emit({ type: 'updated', timer: snapshot })
    this.deliverNotification(id)
  }

  private deliverNotification(id: string): void {
    const timer = this.records.get(id)
    if (
      !timer ||
      timer.status !== 'finished' ||
      timer.notificationStatus !== 'pending' ||
      this.notifying.has(id)
    ) {
      return
    }
    this.clearNotificationHandle(id)
    this.notifying.add(id)
    const complete = (): void => {
      try {
        this.markNotificationDelivered(id)
      } catch (err) {
        console.warn('timer notification delivery persistence failed; retrying:', err)
        this.scheduleNotificationRetry(id)
      } finally {
        this.notifying.delete(id)
      }
    }

    if (this.shownThisProcess.has(id)) {
      complete()
      return
    }

    try {
      const result = this.options.notify(cloneTimer(timer))
      if (isPromiseLike(result)) {
        void Promise.resolve(result).then(
          () => {
            this.shownThisProcess.add(id)
            complete()
          },
          (err: unknown) => {
            this.notifying.delete(id)
            console.warn('timer notification failed; retrying:', err)
            this.scheduleNotificationRetry(id)
          }
        )
      } else {
        this.shownThisProcess.add(id)
        complete()
      }
    } catch (err) {
      this.notifying.delete(id)
      console.warn('timer notification failed; retrying:', err)
      this.scheduleNotificationRetry(id)
    }
  }

  private markNotificationDelivered(id: string): void {
    const timer = this.records.get(id)
    if (!timer || timer.status !== 'finished' || timer.notificationStatus !== 'pending') return
    const delivered: AppTimer = { ...timer, notificationStatus: 'delivered' }
    const next = new Map(this.records)
    next.set(id, delivered)
    this.saveAndReplace(next)
    this.emit({ type: 'updated', timer: cloneTimer(delivered) })
    this.clearNotificationHandle(id)
  }

  private scheduleNotificationRetry(id: string): void {
    this.clearNotificationHandle(id)
    this.notificationHandles.set(
      id,
      this.schedule(() => {
        this.notificationHandles.delete(id)
        this.deliverNotification(id)
      }, NOTIFICATION_RETRY_MS)
    )
  }

  private clearNotificationHandle(id: string): void {
    const handle = this.notificationHandles.get(id)
    if (handle !== undefined) this.cancelSchedule(handle)
    this.notificationHandles.delete(id)
  }

  private clearHandle(id: string): void {
    const handle = this.handles.get(id)
    if (handle !== undefined) this.cancelSchedule(handle)
    this.handles.delete(id)
  }

  /** Replaces the in-memory state only after the save has succeeded. */
  private saveAndReplace(next: Map<string, AppTimer>): void {
    const active = [...next.values()].filter((timer) => timer.status === 'active')
    // The outbox of timers not yet notified is never dropped by a count limit. Only the delivered
    // history is pruned, to the most recent MAX_FINISHED_TIMERS entries.
    const pending = [...next.values()]
      .filter(
        (timer) => timer.status === 'finished' && timer.notificationStatus === 'pending'
      )
      .sort((a, b) => (b.finishedAt ?? b.endsAt) - (a.finishedAt ?? a.endsAt))
    const delivered = [...next.values()]
      .filter(
        (timer) => timer.status === 'finished' && timer.notificationStatus === 'delivered'
      )
      .sort((a, b) => (b.finishedAt ?? b.endsAt) - (a.finishedAt ?? a.endsAt))
      .slice(0, MAX_FINISHED_TIMERS)
    const kept = [...active, ...pending, ...delivered]
    this.options.save({ timers: kept.map(cloneTimer) })
    this.records.clear()
    for (const timer of kept) this.records.set(timer.id, timer)
  }

  private emit(event: TimerEvent): void {
    try {
      this.options.onEvent?.(event)
    } catch (err) {
      console.warn('timer event listener failed:', err)
    }
  }
}

function cloneTimer(timer: AppTimer): AppTimer {
  return { ...timer }
}

export function parseTimerPersistenceData(value: unknown): TimerPersistenceData {
  if (!isRecord(value)) throw new Error(errorText('cardsTime.timer.errors.storeBroken'))
  if (!Array.isArray(value.timers)) throw new Error(errorText('cardsTime.timer.errors.storeListBroken'))
  const seen = new Set<string>()
  const parsed: AppTimer[] = []
  for (const candidate of value.timers) {
    if (!isSavedTimer(candidate)) {
      throw new Error(errorText('cardsTime.timer.errors.storeItemBroken'))
    }
    if (seen.has(candidate.id)) throw new Error(errorText('cardsTime.timer.errors.storeDuplicateId', { id: candidate.id }))
    seen.add(candidate.id)
    parsed.push(cloneTimer(candidate))
  }
  return { timers: parsed }
}

/** Version 2 is the first that wrote a version; no file of version 1 was ever released. */
export const TIMERS_FORMAT: StoredFormat<TimerPersistenceData> = {
  name: 'timers.json',
  version: 2,
  upgrades: {},
  parse: parseTimerPersistenceData,
  serialize: (data) => ({ timers: data.timers })
}

function isSavedTimer(value: unknown): value is AppTimer {
  if (!isRecord(value)) return false
  const timer = value as Partial<AppTimer>
  const createdAt = timer.createdAt
  const endsAt = timer.endsAt
  const seconds = timer.seconds
  const finishedAt = timer.finishedAt
  return (
    typeof timer.id === 'string' &&
    timer.id === timer.id.trim() &&
    timer.id.length > 0 &&
    typeof timer.label === 'string' &&
    timer.label === timer.label.trim() &&
    timer.label.length > 0 &&
    Number.isSafeInteger(seconds) &&
    (seconds ?? 0) > 0 &&
    Number.isSafeInteger(createdAt) &&
    (createdAt ?? -1) >= 0 &&
    Number.isSafeInteger(endsAt) &&
    endsAt === (createdAt ?? 0) + (seconds ?? 0) * 1000 &&
    (timer.status === 'active' || timer.status === 'finished') &&
    (timer.status === 'active'
      ? finishedAt === undefined && timer.notificationStatus === undefined
      : Number.isSafeInteger(finishedAt) &&
        (finishedAt ?? -1) >= 0 &&
        (timer.notificationStatus === 'pending' || timer.notificationStatus === 'delivered'))
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPromiseLike(value: void | Promise<void>): value is Promise<void> {
  return Boolean(value && typeof (value as Promise<void>).then === 'function')
}
