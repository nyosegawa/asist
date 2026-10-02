/**
 * The most peaks a recording is held as. A track that fills them merges each two neighbours into one and goes on
 * with peaks twice as long, so that a recording longer than this many frames is held as 2,048 to 4,096 peaks
 * whatever its length and whatever its header says it is.
 */
export const MAX_PEAKS = 4096

/** A bar's edges are rounded to the peak they fall on when they miss it by a rounding error only. */
const EDGE = 1e-9

/**
 * The peaks of a recording, added in order as it is decoded: the largest amplitude in each stretch of
 * `framesPerPeak` frames, a frame being one sample of every channel.
 */
export class PeakTrack {
  framesPerPeak = 1
  /** The frames added so far. */
  frames = 0
  private readonly values = new Float32Array(MAX_PEAKS)
  private count = 0
  /** The largest amplitude of the peak being filled, and how many frames it holds. */
  private current = 0
  private filled = 0

  constructor(readonly sampleRate: number) {}

  /** How many more frames the peak being filled takes. */
  get room(): number {
    return this.framesPerPeak - this.filled
  }

  /** The peaks that are complete. */
  get peaks(): number {
    return this.count
  }

  get seconds(): number {
    return this.frames / this.sampleRate
  }

  /** Adds `frames` frames, no more than `room`, whose largest amplitude is `peak`. */
  add(peak: number, frames: number): void {
    if (peak > this.current) this.current = peak
    this.filled += frames
    this.frames += frames
    if (this.filled >= this.framesPerPeak) this.complete()
  }

  /** Adds `length` frames held in one array for each of the first `channels` arrays. */
  addChannels(planes: readonly Float32Array[], channels: number, length: number): void {
    for (let at = 0; at < length; ) {
      const take = Math.min(this.room, length - at)
      const end = at + take
      let peak = 0
      for (let c = 0; c < channels; c++) {
        const plane = planes[c]
        for (let i = at; i < end; i++) {
          const value = plane[i] < 0 ? -plane[i] : plane[i]
          if (value > peak) peak = value
        }
      }
      this.add(peak, take)
      at = end
    }
  }

  /** Ends the recording, completing the peak being filled with the frames it holds. */
  end(): void {
    if (this.filled > 0) this.complete()
  }

  /**
   * The heights of the bars of a waveform `bars` wide across a recording `seconds` long, for the part decoded so
   * far: each bar the largest peak within its stretch of time, scaled so that the largest bar is 1, which keeps a
   * quiet recording visible. A recording longer than `seconds` said is drawn to the end of its peaks.
   */
  bars(bars: number, seconds: number): Float32Array {
    const peakSeconds = this.framesPerPeak / this.sampleRate
    const read = this.count * peakSeconds
    const total = Math.max(seconds, read)
    if (this.count === 0 || !(total > 0) || bars <= 0) return new Float32Array(0)
    const heights = new Float32Array(Math.min(bars, Math.ceil((read / total) * bars - EDGE)))
    const perBar = total / bars / peakSeconds
    let largest = 0
    for (let b = 0; b < heights.length; b++) {
      const from = Math.floor(b * perBar + EDGE)
      // A bar narrower than a peak takes the peak it starts in.
      const to = Math.min(this.count, Math.max(from + 1, Math.ceil((b + 1) * perBar - EDGE)))
      let peak = 0
      for (let i = from; i < to; i++) if (this.values[i] > peak) peak = this.values[i]
      heights[b] = peak
      if (peak > largest) largest = peak
    }
    if (largest > 0) for (let b = 0; b < heights.length; b++) heights[b] /= largest
    return heights
  }

  private complete(): void {
    this.values[this.count++] = this.current
    this.current = 0
    this.filled = 0
    if (this.count < MAX_PEAKS) return
    // The peak being filled starts where the merged ones end, at a whole number of the longer peaks.
    for (let i = 0; i < MAX_PEAKS / 2; i++) this.values[i] = Math.max(this.values[2 * i], this.values[2 * i + 1])
    this.count = MAX_PEAKS / 2
    this.framesPerPeak *= 2
  }
}
