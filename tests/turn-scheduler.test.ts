import { describe, expect, it, vi } from 'vitest'
import { LatestTurnScheduler } from '@shared/turn-scheduler'

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('LatestTurnScheduler', () => {
  it('aborts the running turn when a new one starts and runs the new one only after the old one ends', async () => {
    const scheduler = new LatestTurnScheduler()
    const release = deferred()
    const started = deferred()
    const order: string[] = []

    const first = scheduler.start(async ({ signal }) => {
      order.push('first:start')
      started.resolve()
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            order.push('first:abort')
            resolve()
          },
          { once: true }
        )
      })
      await release.promise
      order.push('first:end')
    })
    await started.promise

    const secondRun = vi.fn(async () => {
      order.push('second:start')
    })
    const second = scheduler.start(secondRun)
    await Promise.resolve()

    expect(order).toEqual(['first:start', 'first:abort'])
    expect(secondRun).not.toHaveBeenCalled()
    release.resolve()
    await Promise.all([first.completion, second.completion])
    expect(order).toEqual(['first:start', 'first:abort', 'first:end', 'second:start'])
  })

  it('runs a waiting turn that was replaced before it began with its signal already aborted, in order, so it can record its input', async () => {
    const scheduler = new LatestTurnScheduler()
    const started = deferred()
    const release = deferred()
    const order: string[] = []
    const first = scheduler.start(async () => {
      started.resolve()
      await release.promise
      order.push('first')
    })
    await started.promise

    const middle = scheduler.start(async ({ signal }) => {
      order.push(`middle, aborted: ${signal.aborted}`)
    })
    const last = scheduler.start(async ({ signal }) => {
      order.push(`last, aborted: ${signal.aborted}`)
    })

    release.resolve()
    await Promise.all([first.completion, middle.completion, last.completion])
    expect(order).toEqual(['first', 'middle, aborted: true', 'last, aborted: false'])
  })

  it('hands out increasing turn ids and lets a turn be aborted by its id', async () => {
    const scheduler = new LatestTurnScheduler()
    const seen: number[] = []
    const started = deferred()
    const handle = scheduler.start(async ({ turnId, signal }) => {
      seen.push(turnId)
      started.resolve()
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    expect(handle.signal.aborted).toBe(false)
    await started.promise
    scheduler.abort(handle.turnId)
    expect(handle.signal.aborted).toBe(true)
    await handle.completion

    const next = scheduler.start(async ({ turnId }) => {
      seen.push(turnId)
    })
    await next.completion
    expect(seen).toEqual([1, 2])
    expect(scheduler.activeTurnId).toBeNull()
  })

  it('does not interrupt a running turn for an idle-only interjection', async () => {
    const scheduler = new LatestTurnScheduler()
    const started = deferred()
    const release = deferred()
    const active = scheduler.start(async ({ signal }) => {
      started.resolve()
      await release.promise
      expect(signal.aborted).toBe(false)
    })
    await started.promise

    const interjection = vi.fn(async () => {})
    expect(scheduler.startIfIdle(interjection)).toBeNull()
    expect(interjection).not.toHaveBeenCalled()

    release.resolve()
    await active.completion
    const accepted = scheduler.startIfIdle(interjection)
    expect(accepted).not.toBeNull()
    await accepted?.completion
    expect(interjection).toHaveBeenCalledOnce()
  })

  it('keeps a held turn running through a newer turn and an abort, aborts it at the release, and only then runs the newer turn', async () => {
    const scheduler = new LatestTurnScheduler()
    const held = deferred()
    const answered = deferred()
    const order: string[] = []
    const first = scheduler.start(async ({ signal, hold }) => {
      const release = hold()
      held.resolve()
      await answered.promise
      order.push(`answered, aborted: ${signal.aborted}`)
      release()
      order.push(`released, aborted: ${signal.aborted}`)
    })
    await held.promise

    scheduler.abort(first.turnId)
    const secondRun = vi.fn(async () => {
      order.push('second')
    })
    const second = scheduler.start(secondRun)
    await Promise.resolve()
    expect(first.signal.aborted).toBe(false)
    expect(secondRun).not.toHaveBeenCalled()

    answered.resolve()
    await Promise.all([first.completion, second.completion])
    expect(order).toEqual(['answered, aborted: false', 'released, aborted: true', 'second'])
  })

  it('leaves a turn running when its hold is released with no abort asked for, and aborts it at once afterwards', async () => {
    const scheduler = new LatestTurnScheduler()
    const released = deferred()
    const handle = scheduler.start(async ({ signal, hold }) => {
      hold()()
      released.resolve()
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    await released.promise
    expect(handle.signal.aborted).toBe(false)
    scheduler.abort(handle.turnId)
    expect(handle.signal.aborted).toBe(true)
    await handle.completion
  })

  it('reads the first turn id only when an id is first needed, and gives turns and live exchanges ids from one counter', async () => {
    const firstTurnId = vi.fn(() => 58)
    const scheduler = new LatestTurnScheduler(firstTurnId)
    expect(firstTurnId).not.toHaveBeenCalled()
    expect(scheduler.allocateTurnId()).toBe(58)
    const handle = scheduler.start(async () => {})
    expect(handle.turnId).toBe(59)
    expect(scheduler.allocateTurnId()).toBe(60)
    expect(firstTurnId).toHaveBeenCalledOnce()
    await handle.completion
  })
})
