import { estimateSpeechMs } from '@shared/speech-rate'
import { PcmScheduler } from './pcm-scheduler'

/**
 * Playback starts once this much audio has arrived, or the segment is complete. The first piece can
 * be as short as 0.1 s after its leading silence is cut, while the next one takes about 0.2 s to
 * generate (0.3 s on an M2), so starting on the first piece alone would stutter right at the onset.
 */
const START_BUFFER_S = 0.3
/**
 * A segment that is neither playing nor receiving for this long is closed, so that neither a lost
 * `last` nor an `onended` swallowed by sleep or a device change can stall the queue.
 */
const STALL_MS = 8_000
/** Measured on 2026-09-21 for Japanese read by Qwen3-TTS, used for the progress until the real length is known. */
const ESTIMATED_MS_PER_SYLLABLE = 160

export interface SegmentStreamCallbacks {
  onStarted: () => void
  onFinished: () => void
}

/**
 * The audio of one segment that arrives in pieces while it is synthesized. The pieces wait here
 * until the segment's turn in the playback queue comes, and from then on play back to back as they
 * arrive.
 */
export class SegmentStream {
  private pending: Float32Array[] = []
  private receivedSamples = 0
  private complete = false
  private scheduler: PcmScheduler | null = null
  private callbacks: SegmentStreamCallbacks | null = null
  private audible = false
  private stallTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly sampleRate: number, private readonly text: string) {}

  push(samples: Float32Array, last: boolean): void {
    if (this.complete) return
    this.complete = last
    this.receivedSamples += samples.length
    if (samples.length > 0) this.pending.push(samples)
    this.advance()
  }

  /** Begins playback into `destination`. `onStarted` fires when the first audio is scheduled, `onFinished` when the last has played. */
  start(ctx: AudioContext, destination: AudioNode, callbacks: SegmentStreamCallbacks): void {
    this.scheduler = new PcmScheduler(ctx, destination)
    this.scheduler.onDrained = (): void => this.advance()
    this.callbacks = callbacks
    this.advance()
  }

  stop(): void {
    this.clearStallTimer()
    this.scheduler?.stop()
    this.scheduler = null
    this.callbacks = null
    this.pending = []
  }

  /** The length of the segment: the real one once it is complete, until then an estimate from the text that never falls below what has arrived. */
  get durationMs(): number {
    const received = (this.receivedSamples / this.sampleRate) * 1000
    return this.complete ? received : Math.max(received, estimateSpeechMs(this.text, ESTIMATED_MS_PER_SYLLABLE))
  }

  private advance(): void {
    const scheduler = this.scheduler
    if (!scheduler) return
    const buffered = this.pending.reduce((sum, piece) => sum + piece.length, 0) / this.sampleRate
    if (this.audible || this.complete || buffered >= START_BUFFER_S) {
      for (const piece of this.pending) scheduler.schedule(piece, this.sampleRate)
      if (this.pending.length > 0 && !this.audible) {
        this.audible = true
        this.callbacks?.onStarted()
      }
      this.pending = []
    }
    this.clearStallTimer()
    if (this.complete && scheduler.drained) this.finish()
    else this.stallTimer = setTimeout(() => this.finish(), scheduler.remainingSeconds * 1000 + STALL_MS)
  }

  private finish(): void {
    const finished = this.callbacks?.onFinished
    this.complete = true
    this.stop()
    finished?.()
  }

  private clearStallTimer(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer)
    this.stallTimer = null
  }
}
