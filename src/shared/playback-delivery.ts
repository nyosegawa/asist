import type { TurnPlaybackAckStatus } from './ipc'

export type PlaybackDeliveryOutcome = TurnPlaybackAckStatus | 'timeout'

interface PendingDelivery {
  timer: ReturnType<typeof setTimeout> | null
  resolve: (outcome: PlaybackDeliveryOutcome) => void
}

/**
 * Links an interjection produced in the main process to the audio that actually started playing in the
 * renderer. Finishing the LLM and TTS work does not mean the user heard anything, so the entry is kept
 * until the renderer acknowledges playback.
 */
export class PlaybackDeliveryTracker {
  private pending = new Map<number, PendingDelivery>()

  /** Starts tracking a turn. The wait has no end until expire() gives it one. */
  expect(turnId: number): Promise<PlaybackDeliveryOutcome> {
    if (this.pending.has(turnId)) throw new Error(`playback delivery already tracked: ${turnId}`)
    return new Promise<PlaybackDeliveryOutcome>((resolve) => {
      const finish = (outcome: PlaybackDeliveryOutcome): void => {
        const entry = this.pending.get(turnId)
        if (!entry) return
        if (entry.timer) clearTimeout(entry.timer)
        this.pending.delete(turnId)
        resolve(outcome)
      }
      this.pending.set(turnId, { timer: null, resolve: finish })
    })
  }

  /** Counts the delivery as timed out unless the renderer answers within timeoutMs from now. */
  expire(turnId: number, timeoutMs: number): void {
    const entry = this.pending.get(turnId)
    if (!entry || entry.timer) return
    entry.timer = setTimeout(() => entry.resolve('timeout'), timeoutMs)
    entry.timer.unref?.()
  }

  acknowledge(turnId: number, status: TurnPlaybackAckStatus): boolean {
    const delivery = this.pending.get(turnId)
    if (!delivery) return false
    delivery.resolve(status)
    return true
  }
}
