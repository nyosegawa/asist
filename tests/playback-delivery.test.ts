import { describe, expect, it, vi } from 'vitest'
import { PlaybackDeliveryTracker } from '@shared/playback-delivery'

describe('PlaybackDeliveryTracker', () => {
  it('resolves only the matching turn acknowledgement', async () => {
    const tracker = new PlaybackDeliveryTracker()
    const delivery = tracker.expect(7)

    expect(tracker.acknowledge(8, 'started')).toBe(false)
    expect(tracker.acknowledge(7, 'started')).toBe(true)
    await expect(delivery).resolves.toBe('started')
    expect(tracker.acknowledge(7, 'interrupted')).toBe(false)
  })

  it('distinguishes an unplayed interruption from a timeout, and counts the timeout only from when it is given', async () => {
    vi.useFakeTimers()
    try {
      const tracker = new PlaybackDeliveryTracker()
      const interrupted = tracker.expect(1)
      tracker.acknowledge(1, 'interrupted')
      await expect(interrupted).resolves.toBe('interrupted')

      let outcome: string | null = null
      void tracker.expect(2).then((result) => (outcome = result))
      // A turn that takes long before it speaks has not failed to deliver.
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(outcome).toBeNull()
      tracker.expire(2, 1_000)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(outcome).toBe('timeout')
    } finally {
      vi.useRealTimers()
    }
  })
})
