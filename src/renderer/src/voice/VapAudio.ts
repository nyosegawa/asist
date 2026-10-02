import { StreamResampler } from './MicCapture'

/** MaAI runs inference on 16 kHz audio every 80 ms. */
const FRAME_SAMPLES = 1_280
/**
 * The longest the microphone goes between deliveries: the native helper's AVAudioNode tap hands over 100 to
 * 400 ms at a time, the supported range of its buffer size.
 */
const DELIVERY_MAX_SAMPLES = 6_400
/**
 * Room for the jitter between the output tap's deliveries and the microphone's. On 2026-10-02 a simulation of
 * 30 s of the tap's 128-sample render quanta against microphone chunks of 10, 21, 100 and 300 ms, each up to
 * 10 ms early or late, lost no played audio with this much and lost some in every case of 10 and 21 ms
 * chunks without it.
 */
const JITTER_SAMPLES = 320
/**
 * The played audio kept waiting: as much as the microphone audio held for the first measurement and the longest
 * wait for the next delivery can need.
 */
const ASSISTANT_MAX_SAMPLES = 2 * DELIVERY_MAX_SAMPLES + JITTER_SAMPLES

/**
 * Aligns the microphone and the audio actually being played into the equal-length frames MaAI expects.
 *
 * The output tap delivers continuously while the microphone hands its audio over at intervals, so played audio
 * waits for the microphone audio it pairs with. Right after a delivery, what still waits beyond the microphone
 * audio not yet in a frame is the jitter between the two, or a backlog, such as a reply played while the
 * microphone was starting, that would pair every later frame with played audio that much older. The least of it
 * over the longest stretch between deliveries is measured, and what exceeds the jitter is dropped. The measure
 * does not depend on how the microphone audio is cut up: DeepFilterNet hands each 100 ms delivery of the native
 * helper over in pieces of 10.7 ms, which a limit sized on the largest piece cut into every 80 ms frame.
 *
 * Until the first such stretch has been measured, played audio from before the microphone started cannot be told
 * from what the microphone audio pairs with, so the frames wait for it, about 400 ms once per start. Lining the two
 * up at the first delivery instead would take DeepFilterNet's first piece for the whole delivery.
 */
export class VapAudio {
  private assistantChunks: Float32Array[] = []
  private assistantSamples = 0
  private resampler: StreamResampler | null = null
  private userChunks: Float32Array[] = []
  private userSamples = 0
  /** Whether the backlog has been measured over a first stretch since either side started. */
  private measured = false
  /** The least played audio left waiting right after a delivery, since the backlog was last dropped. */
  private leastSurplus = Infinity
  /** The microphone audio delivered since the backlog was last dropped. */
  private deliveredSinceDrop = 0

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
    this.leastSurplus = Math.min(this.leastSurplus, this.assistantSamples - this.userSamples)
    this.deliveredSinceDrop += frame.length
    if (this.deliveredSinceDrop >= DELIVERY_MAX_SAMPLES) this.dropBacklog()
    if (!this.measured) return
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

  private dropBacklog(): void {
    const backlog = this.leastSurplus - JITTER_SAMPLES
    if (backlog > 0) {
      takeSamples(this.assistantChunks, backlog)
      this.assistantSamples -= backlog
    }
    this.measured = true
    this.leastSurplus = Infinity
    this.deliveredSinceDrop = 0
  }

  /**
   * Forgets both sides, as when the microphone stops or MaAI stops taking part, so that neither is paired with what
   * comes after.
   */
  reset(): void {
    this.userChunks = []
    this.userSamples = 0
    this.assistantChunks = []
    this.assistantSamples = 0
    this.resampler = null
    this.measured = false
    this.leastSurplus = Infinity
    this.deliveredSinceDrop = 0
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
