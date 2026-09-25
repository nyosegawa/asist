import { StreamResampler } from './MicCapture'

/** MaAI runs inference on 16 kHz audio every 80 ms. */
const FRAME_SAMPLES = 1_280
/** Only the last second of played audio is kept, which bounds how far it can drift from the microphone. */
const ASSISTANT_MAX_SAMPLES = 16_000

/** Aligns the microphone and the audio actually being played into the equal-length frames MaAI expects. */
export class VapAudio {
  private assistantChunks: Float32Array[] = []
  private assistantSamples = 0
  private resampler: StreamResampler | null = null
  private userChunks: Float32Array[] = []
  private userSamples = 0

  constructor(private readonly emit: (user: Float32Array, assistant: Float32Array) => void) {}

  pushAssistant(samples: Float32Array, sampleRate: number): void {
    this.resampler ??= new StreamResampler(sampleRate, 16_000)
    const frame = this.resampler.process(samples)
    if (frame.length === 0) return
    this.assistantChunks.push(frame)
    this.assistantSamples += frame.length
    while (this.assistantSamples > ASSISTANT_MAX_SAMPLES && this.assistantChunks.length > 0) {
      this.assistantSamples -= this.assistantChunks.shift()!.length
    }
  }

  /** The microphone frames must already be 16 kHz. Each time 80 ms is complete it is emitted with the played audio. */
  pushUser(frame: Float32Array): void {
    this.userChunks.push(frame)
    this.userSamples += frame.length
    while (this.userSamples >= FRAME_SAMPLES) {
      const user = takeSamples(this.userChunks, FRAME_SAMPLES)
      this.userSamples -= FRAME_SAMPLES
      // Where no played audio is available, the rest of the frame stays silent.
      const assistant = new Float32Array(FRAME_SAMPLES)
      const available = Math.min(this.assistantSamples, FRAME_SAMPLES)
      if (available > 0) {
        assistant.set(takeSamples(this.assistantChunks, available))
        this.assistantSamples -= available
      }
      this.emit(user, assistant)
    }
  }

  clearAssistant(): void {
    this.assistantChunks = []
    this.assistantSamples = 0
    this.resampler = null
  }

  reset(): void {
    this.userChunks = []
    this.userSamples = 0
    this.clearAssistant()
  }
}

/** Takes the requested number of samples off the front of the chunks and leaves the remainder for the next frame. */
function takeSamples(chunks: Float32Array[], count: number): Float32Array {
  const out = new Float32Array(count)
  let offset = 0
  while (offset < count && chunks.length > 0) {
    const head = chunks[0]
    const take = Math.min(head.length, count - offset)
    out.set(head.subarray(0, take), offset)
    if (take === head.length) chunks.shift()
    else chunks[0] = head.subarray(take)
    offset += take
  }
  return out
}
