import { describe, expect, it, vi } from 'vitest'
import type { AppTimer } from '@shared/ipc'
import { syncTimerEvent } from '../src/renderer/src/panels/timer-sync'

const timer = (patch: Partial<AppTimer> = {}): AppTimer => ({
  id: 'timer:1',
  label: 'お茶',
  seconds: 60,
  createdAt: 1_000,
  endsAt: 61_000,
  status: 'active',
  ...patch
})

describe('renderer timer sync', () => {
  it('shows an active timer and a pending notification saved in main regardless of the turn state', () => {
    const target = { show: vi.fn(), dismiss: vi.fn() }
    const active = timer()
    const pending = timer({
      id: 'timer:2',
      status: 'finished',
      finishedAt: 61_000,
      notificationStatus: 'pending'
    })

    syncTimerEvent({ type: 'updated', timer: active }, target)
    syncTimerEvent({ type: 'updated', timer: pending }, target)

    expect(target.show.mock.calls).toEqual([[active], [pending]])
    expect(target.dismiss).not.toHaveBeenCalled()
  })

  it('does not show an already delivered timer again and drops a canceled id from the display', () => {
    const target = { show: vi.fn(), dismiss: vi.fn() }
    syncTimerEvent(
      {
        type: 'updated',
        timer: timer({
          status: 'finished',
          finishedAt: 61_000,
          notificationStatus: 'delivered'
        })
      },
      target
    )
    syncTimerEvent({ type: 'removed', id: 'timer:1' }, target)

    expect(target.show).not.toHaveBeenCalled()
    expect(target.dismiss).toHaveBeenCalledWith('timer:1')
  })
})
