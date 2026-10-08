import { estimateSpeechMs } from '@shared/speech-rate'
import { PcmScheduler } from './pcm-scheduler'

/**
 * Playback of an incomplete segment starts this long after its first audio, less the audio that has arrived
 * by then, so that the pieces made while the first plays arrive before it runs out. Replayed from the worker's
 * chunks of speech.cpp 0.8.0 through the shaper, 60 Japanese sentences each (2026-10-09): Qwen3-TTS 0.6B on an
 * Apple M2 ran dry in 30 sentences with 0.15 s and in none with 0.2 s; on an Apple M5, 0.6B and 1.7B ran dry in
 * none with 0.2 s, their voice heard 0.35 s and 0.26 s after the request in the median. Waiting instead for 0.3 s
 * of audio to arrive, the silence before the voice cut, heard it after 0.33 s and 0.30 s on the M5 and 0.56 s on
 * the M2, which ran dry in 6. A segment whose turn comes while an earlier one plays has gathered that much
 * already and starts at once.
 */
const START_LEAD_S = 0.2
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
  /** Reports the start once the first audio, scheduled ahead, sounds. */
  private startTimer: ReturnType<typeof setTimeout> | null = null

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
    if (this.startTimer) clearTimeout(this.startTimer)
    this.startTimer = null
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
    if (!this.audible && this.pending.length > 0) {
      const buffered = this.pending.reduce((sum, piece) => sum + piece.length, 0) / this.sampleRate
      const lead = this.complete ? 0 : Math.max(0, START_LEAD_S - buffered)
      this.pending.forEach((piece, i) => scheduler.schedule(piece, this.sampleRate, i === 0 ? lead : 0))
      this.audible = true
      if (lead === 0) this.callbacks?.onStarted()
      else this.startTimer = setTimeout(() => this.callbacks?.onStarted(), lead * 1000)
    } else {
      for (const piece of this.pending) scheduler.schedule(piece, this.sampleRate)
    }
    this.pending = []
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
