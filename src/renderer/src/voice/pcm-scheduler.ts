/**
 * Plays PCM chunks that arrive over time as one gapless sound: each chunk is scheduled directly after
 * the previous one, and a chunk that arrives after the scheduled audio ran out continues from now.
 */
export class PcmScheduler {
  private nextTime = 0
  private readonly sources = new Set<AudioBufferSourceNode>()
  /** Called when the last scheduled chunk has finished playing. More chunks may still follow. */
  onDrained: (() => void) | null = null

  constructor(private readonly ctx: AudioContext, private readonly destination: AudioNode) {}

  /** `leadSeconds` delays a chunk that starts from now, which absorbs the jitter in how the following chunks arrive. */
  schedule(samples: Float32Array, sampleRate: number, leadSeconds = 0): void {
    const buffer = this.ctx.createBuffer(1, samples.length, sampleRate)
    buffer.getChannelData(0).set(samples)
    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    source.connect(this.destination)
    const now = this.ctx.currentTime
    const startAt = this.nextTime > now ? this.nextTime : now + leadSeconds
    this.nextTime = startAt + buffer.duration
    this.sources.add(source)
    source.onended = (): void => {
      this.sources.delete(source)
      if (this.sources.size === 0) this.onDrained?.()
    }
    source.start(startAt)
  }

  /** Seconds of scheduled audio that have not played yet. */
  get remainingSeconds(): number {
    return Math.max(0, this.nextTime - this.ctx.currentTime)
  }

  get drained(): boolean {
    return this.sources.size === 0
  }

  /** Stops and drops everything scheduled, without calling `onDrained`. */
  stop(): void {
    for (const source of this.sources) {
      source.onended = null
      try {
        source.stop()
      } catch {
        // The source has already stopped.
      }
    }
    this.sources.clear()
    this.nextTime = 0
  }
}
