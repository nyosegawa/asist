/**
 * Shapes the raw output of Qwen3-TTS while it streams. Measured on 2026-09-21 over 20 Japanese
 * generations with four voices: a generation starts with 0.2 to 0.75 s of silence and ends with 0.3
 * to 1.0 s of it, which would delay the first word and leave gaps of over a second between
 * sentences; and the level of one voice varies between generations by 15 dB (voiced RMS 0.011 to
 * 0.056 for `ono_anna`). The noise floor stays below 0.002, so a 20 ms frame counts as voiced from
 * an RMS of 0.004.
 *
 * The shaper drops the leading silence, holds silence back until voiced audio follows it so that
 * the trailing silence can be cut to a short tail, and brings the voiced level to a common target.
 */

const FRAME_SECONDS = 0.02
const VOICED_FRAME_RMS = 0.004
/** Frames of silence kept after the last voiced frame. One frame is kept before the first, so an onset is not clipped. */
const TAIL_FRAMES = 5
/** The voiced RMS the louder voices produce on their own, which is also about the level of VOICEVOX. */
const TARGET_RMS = 0.07
const MIN_GAIN = 0.5
const MAX_GAIN = 6
const PEAK_CEILING = 0.95
/** A change of gain between two pieces is spread over this many frames. */
const GAIN_RAMP_FRAMES = 5

export class SpeechShaper {
  private readonly frameSize: number
  private carry = new Float32Array(0)
  private started = false
  private lastSilent: Float32Array | null = null
  private held: Float32Array[] = []
  private voicedSquares = 0
  private voicedSamples = 0
  private peak = 0
  private gain: number | null = null

  constructor(sampleRate: number) {
    this.frameSize = Math.round(sampleRate * FRAME_SECONDS)
  }

  /** Takes the next piece from the model and returns the samples that are ready to play, which may be none. */
  push(piece: Int16Array): Float32Array {
    const samples = new Float32Array(this.carry.length + piece.length)
    samples.set(this.carry)
    for (let i = 0; i < piece.length; i++) samples[this.carry.length + i] = piece[i] / 32768
    const frameCount = Math.floor(samples.length / this.frameSize)
    this.carry = samples.slice(frameCount * this.frameSize)

    const frames: Array<{ samples: Float32Array; voiced: boolean }> = []
    for (let f = 0; f < frameCount; f++) {
      const frame = samples.subarray(f * this.frameSize, (f + 1) * this.frameSize)
      let squares = 0
      let peak = 0
      for (const value of frame) {
        squares += value * value
        peak = Math.max(peak, Math.abs(value))
      }
      const voiced = Math.sqrt(squares / frame.length) >= VOICED_FRAME_RMS
      if (voiced) {
        this.voicedSquares += squares
        this.voicedSamples += frame.length
        this.peak = Math.max(this.peak, peak)
      }
      frames.push({ samples: frame, voiced })
    }

    const released: Float32Array[] = []
    for (const frame of frames) {
      if (frame.voiced) {
        if (!this.started) {
          this.started = true
          if (this.lastSilent) released.push(this.lastSilent)
        }
        released.push(...this.held, frame.samples)
        this.held = []
      } else if (this.started) {
        this.held.push(frame.samples)
      } else {
        this.lastSilent = frame.samples
      }
    }
    return this.level(released)
  }

  /** Returns the short tail of silence that ends the sentence. */
  flush(): Float32Array {
    const tail = this.started ? this.held.slice(0, TAIL_FRAMES) : []
    this.held = []
    this.carry = new Float32Array(0)
    return this.level(tail)
  }

  /** The whole piece is measured before any of it is released, so its own level already counts towards its gain. */
  private level(frames: Float32Array[]): Float32Array {
    const length = frames.reduce((sum, frame) => sum + frame.length, 0)
    const output = new Float32Array(length)
    if (length === 0) return output
    const rms = Math.sqrt(this.voicedSquares / Math.max(1, this.voicedSamples))
    const target = Math.min(Math.max(TARGET_RMS / rms, MIN_GAIN), MAX_GAIN, PEAK_CEILING / this.peak)
    // The previous gain was chosen before this piece was known, so it is capped to what this piece can take without clipping.
    const loudest = frames.reduce((peak, frame) => frame.reduce((max, value) => Math.max(max, Math.abs(value)), peak), 0)
    const from = Math.min(this.gain ?? target, PEAK_CEILING / loudest)
    const rampSamples = GAIN_RAMP_FRAMES * this.frameSize
    let offset = 0
    for (const frame of frames) {
      for (let i = 0; i < frame.length; i++) {
        const position = offset + i
        const gain = position >= rampSamples ? target : from + ((target - from) * position) / rampSamples
        output[position] = frame[i] * gain
      }
      offset += frame.length
    }
    this.gain = target
    return output
  }
}

/** Encodes mono samples as a 16-bit PCM WAV file. */
export function encodeWav(pieces: Float32Array[], sampleRate: number): Buffer {
  const length = pieces.reduce((sum, piece) => sum + piece.length, 0)
  const wav = Buffer.alloc(44 + length * 2)
  wav.write('RIFF', 0, 'ascii')
  wav.writeUInt32LE(36 + length * 2, 4)
  wav.write('WAVEfmt ', 8, 'ascii')
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36, 'ascii')
  wav.writeUInt32LE(length * 2, 40)
  let offset = 44
  for (const piece of pieces) {
    for (const value of piece) {
      wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), offset)
      offset += 2
    }
  }
  return wav
}
