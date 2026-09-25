import { floatToPcm16, pcm16FromBytes, pcm16ToBytes, pcm16ToFloat, StreamResampler } from '@shared/pcm'

/**
 * Converts audio between the live APIs and the renderer. The renderer sends Float32 at 16 kHz while an API
 * takes base64 of 16-bit PCM, at 24 kHz for GPT-Live and 16 kHz for Gemini. An API's output is base64 of
 * 16-bit PCM at 24 kHz and reaches the renderer as Float32.
 */

/** Turns Float32 at 16 kHz into base64 PCM16 at the API's input rate, continuously across chunk boundaries. */
export class InputEncoder {
  private readonly resampler: StreamResampler

  constructor(targetRate: number) {
    this.resampler = new StreamResampler(16_000, targetRate)
  }

  encode(frame16k: Float32Array): string {
    const resampled = this.resampler.process(frame16k)
    if (resampled.length === 0) return ''
    return Buffer.from(pcm16ToBytes(floatToPcm16(resampled))).toString('base64')
  }
}

/** Turns an API's output, base64 PCM16, into Float32. */
export function decodeOutput(base64: string): Float32Array {
  const bytes = Buffer.from(base64, 'base64')
  return pcm16ToFloat(pcm16FromBytes(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)))
}
