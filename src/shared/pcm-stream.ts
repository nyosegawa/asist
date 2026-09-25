/**
 * Restores a little-endian float32 byte stream into Float32Array samples. PCM arriving through a pipe
 * has chunk boundaries that do not line up with 4-byte sample boundaries, so leftover bytes are carried
 * over into the next chunk.
 */
export class Float32StreamReader {
  private remainder = new Uint8Array(0)

  push(chunk: Uint8Array): Float32Array | null {
    let bytes: Uint8Array
    if (this.remainder.length > 0) {
      bytes = new Uint8Array(this.remainder.length + chunk.length)
      bytes.set(this.remainder)
      bytes.set(chunk, this.remainder.length)
    } else {
      bytes = chunk
    }
    const sampleCount = Math.floor(bytes.length / 4)
    const usedBytes = sampleCount * 4
    this.remainder = bytes.slice(usedBytes)
    if (sampleCount === 0) return null
    // The incoming buffer may not start on a 4-byte boundary, so always copy before viewing it as
    // Float32Array.
    const aligned = new Uint8Array(usedBytes)
    aligned.set(bytes.subarray(0, usedBytes))
    return new Float32Array(aligned.buffer)
  }

  reset(): void {
    this.remainder = new Uint8Array(0)
  }
}
