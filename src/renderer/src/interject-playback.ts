import type { SpeechSegment, TurnPlaybackAckStatus } from '@shared/ipc'

const ACK_RETRY_DELAYS_MS = [250, 1_000]

/** Tracks the interjections that entered the renderer's queue but have never sounded. */
export class InterjectPlaybackAcks {
  private pending = new Map<number, { bodyQueued: boolean }>()

  constructor(
    private readonly send: (turnId: number, status: TurnPlaybackAckStatus) => Promise<void>
  ) {}

  track(turnId: number): void {
    this.pending.set(turnId, { bodyQueued: false })
  }

  /** Records that a body segment of this turn is queued and still waiting to start playing. */
  markSegmentQueued(segment: SpeechSegment): boolean {
    if (segment.index < 0 || segment.index === 998) return false
    const delivery = this.pending.get(segment.turnId)
    if (!delivery) return false
    delivery.bodyQueued = true
    return true
  }

  /** Counts as delivered only when the body of the report actually starts playing, not when a working filler does. */
  markSegmentStarted(segment: SpeechSegment): boolean {
    if (segment.index < 0 || segment.index === 998 || !this.pending.delete(segment.turnId)) {
      return false
    }
    this.sendWithRetry(segment.turnId, 'started')
    return true
  }

  /** Called right before user input discards the unplayed queue of the SpeechPlayer. */
  interruptPending(): number[] {
    const turnIds = [...this.pending.keys()]
    this.pending.clear()
    for (const turnId of turnIds) this.sendWithRetry(turnId, 'interrupted')
    return turnIds
  }

  /** The started event itself was refused because a user turn or a pending turn in the renderer collided with it. */
  rejectStarted(turnId: number): void {
    this.pending.delete(turnId)
    this.sendWithRetry(turnId, 'interrupted')
  }

  /**
   * A turn that ended without a single body segment, after a TTS failure for instance, is requeued
   * at once. When the body is already in the SpeechPlayer it sounds after done, so the interjection
   * is held until the start acknowledgement arrives.
   */
  finishTurn(turnId: number): boolean {
    const delivery = this.pending.get(turnId)
    if (!delivery || delivery.bodyQueued) return false
    this.pending.delete(turnId)
    this.sendWithRetry(turnId, 'interrupted')
    return true
  }

  private sendWithRetry(
    turnId: number,
    status: TurnPlaybackAckStatus,
    attempt = 0
  ): void {
    void this.send(turnId, status).catch((error: unknown) => {
      const delay = ACK_RETRY_DELAYS_MS[attempt]
      if (delay === undefined) {
        console.warn('playback acknowledgement failed:', error)
        return
      }
      setTimeout(() => this.sendWithRetry(turnId, status, attempt + 1), delay)
    })
  }
}
