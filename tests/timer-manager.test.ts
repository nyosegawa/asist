import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTranslator } from '@shared/i18n'
import { errorText } from '@shared/i18n/error-text'
import type { AppTimer, TimerEvent } from '@shared/ipc'
import { TimerManager, type TimerPersistenceData } from '@shared/timer-manager'

const ja = createTranslator('ja-JP')
const defaultLabel = (): string => ja('cardsTime.timer.defaultLabel')

interface Harness {
  manager: TimerManager
  notifications: ReturnType<typeof vi.fn<(timer: AppTimer) => void>>
  events: TimerEvent[]
  saved: () => TimerPersistenceData
  restart: () => TimerManager
}

function harness(): Harness {
  let data: TimerPersistenceData = { timers: [] }
  const notifications = vi.fn<(timer: AppTimer) => void>()
  const events: TimerEvent[] = []
  const make = (): TimerManager =>
    new TimerManager({
      load: () => structuredClone(data),
      save: (next) => (data = structuredClone(next)),
      defaultLabel,
      notify: notifications,
      onEvent: (event) => events.push(event)
    })
  return {
    manager: make(),
    notifications,
    events,
    saved: () => structuredClone(data),
    restart: make
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-03T00:00:00.000Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('TimerManager', () => {
  it('owns creation, listing and expiry in main and notifies exactly once', () => {
    const h = harness()
    const timer = h.manager.create({ id: 'timer:1', seconds: 2, label: '紅茶' })
    expect(timer).toMatchObject({ id: 'timer:1', label: '紅茶', status: 'active' })
    expect(h.manager.list()).toHaveLength(1)

    vi.advanceTimersByTime(2_000)

    expect(h.notifications).toHaveBeenCalledTimes(1)
    expect(h.manager.list()[0].status).toBe('finished')
    expect(h.saved().timers[0].status).toBe('finished')
    vi.advanceTimersByTime(10_000)
    expect(h.notifications).toHaveBeenCalledTimes(1)
  })

  it('does not reschedule when the same id is created again, so the focus view and StrictMode leave a single timer', () => {
    const h = harness()
    const first = h.manager.create({ id: 'timer:1', seconds: 3, label: '最初' })
    vi.advanceTimersByTime(1_000)
    const second = h.manager.create({ id: 'timer:1', seconds: 3, label: '最初' })

    expect(second).toEqual(first)
    vi.advanceTimersByTime(2_000)
    expect(h.notifications).toHaveBeenCalledTimes(1)
    expect(h.notifications.mock.calls[0][0].label).toBe('最初')
  })

  it('rejects a create that reuses an id with different content as a conflict', () => {
    const h = harness()
    h.manager.create({ id: 'timer:1', seconds: 3, label: '最初' })

    expect(() => h.manager.create({ id: 'timer:1', seconds: 99, label: '別物' })).toThrow(
      errorText('cardsTime.timer.errors.idConflict')
    )
    expect(h.manager.list()).toMatchObject([{ seconds: 3, label: '最初', status: 'active' }])
  })

  it('keeps running when nothing subscribes to its events any more', () => {
    const notifications = vi.fn<(timer: AppTimer) => void>()
    const manager = new TimerManager({
      load: () => ({ timers: [] }),
      save: () => {},
      defaultLabel,
      notify: notifications
      // onEvent is left out, which stands for a renderer that has no timer panel.
    })
    manager.create({ id: 'timer:1', seconds: 1 })

    vi.advanceTimersByTime(1_000)

    expect(notifications).toHaveBeenCalledTimes(1)
    expect(manager.list()[0].status).toBe('finished')
  })

  it('restores the schedule from the remaining time after a restart', () => {
    const h = harness()
    h.manager.create({ id: 'timer:1', seconds: 5 })
    vi.advanceTimersByTime(2_000)
    h.manager.shutdown()

    const restarted = h.restart()
    restarted.init()
    vi.advanceTimersByTime(2_999)
    expect(h.notifications).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(h.notifications).toHaveBeenCalledTimes(1)
    expect(restarted.list()[0].status).toBe('finished')
  })

  it('on waking, finishes a timer that ended during the sleep and gives one still running the time the wall clock leaves it', () => {
    // Node's timers stop while the Mac sleeps, so the schedules here fire only when the test calls them.
    let wall = 1_000_000
    let saved: TimerPersistenceData = { timers: [] }
    const scheduled: number[] = []
    const notify = vi.fn()
    const manager = new TimerManager({
      load: () => saved,
      save: (next) => (saved = next),
      defaultLabel,
      notify,
      now: () => wall,
      schedule: (_callback, delay) => scheduled.push(delay),
      cancelSchedule: () => undefined
    })
    manager.create({ id: 'timer:tea', seconds: 600 })
    manager.create({ id: 'timer:bread', seconds: 7200 })
    // Two minutes pass awake, then the Mac sleeps for an hour.
    wall += 62 * 60_000
    manager.resync()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(manager.list().map((timer) => [timer.id, timer.status])).toEqual([
      ['timer:bread', 'active'],
      ['timer:tea', 'finished']
    ])
    expect(scheduled.at(-1)).toBe((7200 - 62 * 60) * 1000)
  })

  it('notifies once at the next start for a timer that expired while the app was down, and not again after that', () => {
    const h = harness()
    h.manager.create({ id: 'timer:1', seconds: 1 })
    h.manager.shutdown()
    vi.setSystemTime(new Date('2026-08-03T00:00:02.000Z'))

    const restarted = h.restart()
    restarted.init()
    expect(h.notifications).toHaveBeenCalledTimes(1)
    restarted.shutdown()

    const restartedAgain = h.restart()
    restartedAgain.init()
    expect(h.notifications).toHaveBeenCalledTimes(1)
  })

  it('removes a canceled timer from the saved data and the schedule and never notifies it', () => {
    const h = harness()
    h.manager.create({ id: 'timer:1', seconds: 1 })

    expect(h.manager.cancel('timer:1')).toBe(true)
    expect(h.manager.cancel('timer:1')).toBe(false)
    expect(h.manager.list()).toEqual([])
    expect(h.saved().timers).toEqual([])
    expect(h.events.at(-1)).toEqual({ type: 'removed', id: 'timer:1' })

    vi.advanceTimersByTime(2_000)
    expect(h.notifications).not.toHaveBeenCalled()
  })

  it('leaves no unscheduled record in memory when saving a new timer fails', () => {
    const notifications = vi.fn<(timer: AppTimer) => void>()
    const manager = new TimerManager({
      load: () => ({ timers: [] }),
      save: () => {
        throw new Error('disk full')
      },
      defaultLabel,
      notify: notifications
    })

    expect(() => manager.create({ id: 'timer:1', seconds: 1 })).toThrow('disk full')
    expect(manager.list()).toEqual([])
    vi.advanceTimersByTime(2_000)
    expect(notifications).not.toHaveBeenCalled()
  })

  it('keeps the original schedule and the active status when saving a cancel fails', () => {
    let failSave = false
    let data: TimerPersistenceData = { timers: [] }
    const notifications = vi.fn<(timer: AppTimer) => void>()
    const manager = new TimerManager({
      load: () => structuredClone(data),
      save: (next) => {
        if (failSave) throw new Error('disk full')
        data = structuredClone(next)
      },
      defaultLabel,
      notify: notifications
    })
    manager.create({ id: 'timer:1', seconds: 2 })
    failSave = true

    expect(() => manager.cancel('timer:1')).toThrow('disk full')
    expect(manager.list()[0].status).toBe('active')
    expect(data.timers[0].status).toBe('active')

    failSave = false
    vi.advanceTimersByTime(2_000)
    expect(notifications).toHaveBeenCalledTimes(1)
    expect(manager.list()[0].status).toBe('finished')
  })

  it('does not let a failed save at expiry escape the timer callback, and notifies once after the save succeeds', () => {
    let failSave = false
    let data: TimerPersistenceData = { timers: [] }
    const notifications = vi.fn<(timer: AppTimer) => void>()
    const manager = new TimerManager({
      load: () => structuredClone(data),
      save: (next) => {
        if (failSave) throw new Error('disk full')
        data = structuredClone(next)
      },
      defaultLabel,
      notify: notifications
    })
    manager.create({ id: 'timer:1', seconds: 1 })
    failSave = true

    expect(() => vi.advanceTimersByTime(1_000)).not.toThrow()
    expect(manager.list()[0].status).toBe('active')
    expect(notifications).not.toHaveBeenCalled()

    failSave = false
    vi.advanceTimersByTime(1_000)
    expect(manager.list()[0].status).toBe('finished')
    expect(data.timers[0].status).toBe('finished')
    expect(notifications).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(5_000)
    expect(notifications).toHaveBeenCalledTimes(1)
  })

  it('fails closed on a corrupt record or a future schema and does not overwrite it on the next create', () => {
    const save = vi.fn()
    const manager = new TimerManager({
      load: () => ({ timers: [{ id: '', status: 'active' }] }),
      save,
      defaultLabel,
      notify: () => {}
    })
    expect(() => manager.list()).toThrow(errorText('cardsTime.timer.errors.storeItemBroken'))
    expect(() => manager.create({ id: 'x', seconds: 1 })).toThrow(errorText('cardsTime.timer.errors.storeItemBroken'))
    expect(save).not.toHaveBeenCalled()

  })

  it('neither notifies nor saves when the stored file cannot be opened', () => {
    const save = vi.fn()
    const notify = vi.fn()
    const load = (): never => {
      throw new Error('timers.json was written by a newer ASIST')
    }
    const manager = new TimerManager({ load, save, defaultLabel, notify })
    expect(() => manager.list()).toThrow()
    expect(() => manager.create({ id: 'new', seconds: 1 })).toThrow()
    expect(save).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('keeps the notification pending and retries it, and saves delivered once it succeeds', async () => {
    let data: TimerPersistenceData = { timers: [] }
    const notify = vi
      .fn<(timer: AppTimer) => Promise<void>>()
      .mockRejectedValueOnce(new Error('notification service down'))
      .mockResolvedValue(undefined)
    const manager = new TimerManager({
      load: () => structuredClone(data),
      save: (next) => (data = structuredClone(next)),
      defaultLabel,
      notify
    })
    manager.create({ id: 'timer:pending', seconds: 1 })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(data.timers[0]).toMatchObject({ status: 'finished', notificationStatus: 'pending' })
    expect(notify).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(notify).toHaveBeenCalledTimes(2)
    expect(data.timers[0]).toMatchObject({ notificationStatus: 'delivered' })
  })

  it('resends the pending notifications at startup and moves them to delivered', () => {
    const now = Date.now()
    let data: TimerPersistenceData = {
      timers: [
        {
          id: 'timer:pending',
          label: '再送',
          seconds: 1,
          createdAt: now - 2_000,
          endsAt: now - 1_000,
          status: 'finished',
          finishedAt: now - 1_000,
          notificationStatus: 'pending'
        }
      ]
    }
    const notify = vi.fn()
    const manager = new TimerManager({
      load: () => structuredClone(data),
      save: (next) => (data = structuredClone(next)),
      defaultLabel,
      notify
    })

    manager.init()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(data.timers[0].notificationStatus).toBe('delivered')
  })

  it('retries only the save, without notifying twice in the same process, when storing delivered fails', () => {
    let data: TimerPersistenceData = { timers: [] }
    let rejectDeliveredOnce = true
    const notify = vi.fn()
    const manager = new TimerManager({
      load: () => structuredClone(data),
      save: (next) => {
        if (
          rejectDeliveredOnce &&
          next.timers.some((timer) => timer.notificationStatus === 'delivered')
        ) {
          rejectDeliveredOnce = false
          throw new Error('disk full after notification')
        }
        data = structuredClone(next)
      },
      defaultLabel,
      notify
    })
    manager.create({ id: 'timer:save-retry', seconds: 1 })

    vi.advanceTimersByTime(1_000)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(data.timers[0].notificationStatus).toBe('pending')

    vi.advanceTimersByTime(5_000)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(data.timers[0].notificationStatus).toBe('delivered')
  })

  it('rejects an invalid number of seconds', () => {
    const manager = new TimerManager({
      load: () => ({ timers: [] }),
      save: () => {},
      defaultLabel,
      notify: () => {}
    })
    expect(() => manager.create({ id: 'x', seconds: 0 })).toThrow(errorText('cardsTime.timer.errors.seconds'))
    expect(() => manager.create({ id: 'x', seconds: 1.5 })).toThrow(errorText('cardsTime.timer.errors.seconds'))
  })
})
