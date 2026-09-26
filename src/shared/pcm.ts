/**
 * PCM conversion. The live APIs send and receive 16-bit little-endian PCM as base64 while the
 * renderer's audio path uses Float32, so the two are converted here. Resampling is streaming linear
 * interpolation, which stays continuous across chunk boundaries.
 */

export function floatToPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]))
    out[i] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767)
  }
  return out
}

export function pcm16ToFloat(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] / 32768
  return out
}

/** Reads little-endian bytes, dropping a trailing odd byte. */
export function pcm16FromBytes(bytes: Uint8Array): Int16Array {
  const length = Math.floor(bytes.byteLength / 2)
  const out = new Int16Array(length)
  const view = new DataView(bytes.buffer, bytes.byteOffset, length * 2)
  for (let i = 0; i < length; i++) out[i] = view.getInt16(i * 2, true)
  return out
}

export function pcm16ToBytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i], true)
  return out
}

/** A linear-interpolation resampler that stays continuous across chunk boundaries. */
export class StreamResampler {
  private carry = new Float32Array(0)
  private pos = 0

  constructor(
    private readonly from: number,
    private readonly to: number
  ) {}

  process(chunk: Float32Array): Float32Array {
    if (this.from === this.to) return chunk
    const src = new Float32Array(this.carry.length + chunk.length)
    src.set(this.carry)
    src.set(chunk, this.carry.length)

    const ratio = this.from / this.to
    const out = new Float32Array(Math.max(0, Math.floor((src.length - 1 - this.pos) / ratio) + 1))
    let pos = this.pos
    let count = 0
    while (pos + 1 < src.length) {
      const i = Math.floor(pos)
      const frac = pos - i
      out[count++] = src[i] * (1 - frac) + src[i + 1] * frac
      pos += ratio
    }
    // Downsampling can step past the end of the chunk; the position then continues into the next one
    // instead of restarting at its first sample.
    const keep = Math.min(Math.floor(pos), src.length)
    this.carry = src.slice(keep)
    this.pos = pos - keep
    return out.subarray(0, count)
  }
}
