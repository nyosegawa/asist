import { describe, expect, it, vi } from 'vitest'
import { PlaybackDeliveryTracker } from '@shared/playback-delivery'

describe('PlaybackDeliveryTracker', () => {
  it('resolves only the matching turn acknowledgement', async () => {
    const tracker = new PlaybackDeliveryTracker()
    const delivery = tracker.expect(7, 1_000)

    expect(tracker.acknowledge(8, 'started')).toBe(false)
    expect(tracker.acknowledge(7, 'started')).toBe(true)
    await expect(delivery).resolves.toBe('started')
    expect(tracker.acknowledge(7, 'interrupted')).toBe(false)
  })

  it('distinguishes an unplayed interruption from a timeout', async () => {
    vi.useFakeTimers()
    try {
      const tracker = new PlaybackDeliveryTracker()
      const interrupted = tracker.expect(1, 1_000)
      tracker.acknowledge(1, 'interrupted')
      await expect(interrupted).resolves.toBe('interrupted')

      const timedOut = tracker.expect(2, 1_000)
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(timedOut).resolves.toBe('timeout')
    } finally {
      vi.useRealTimers()
    }
  })
})
