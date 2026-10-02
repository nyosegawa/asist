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
 * The most played audio that can wait for the microphone audio it pairs with: the part of a frame the microphone
 * has delivered, the longest wait for the next delivery and the jitter. More means the microphone has stopped
 * delivering for a while, and the played audio of that time pairs with nothing it will deliver.
 */
const ASSISTANT_MAX_SAMPLES = FRAME_SAMPLES + DELIVERY_MAX_SAMPLES + JITTER_SAMPLES

/**
 * Aligns the microphone and the audio actually being played into the equal-length frames MaAI expects.
 *
 * The output tap delivers continuously while the microphone hands its audio over at intervals, so played audio
 * waits for the microphone audio it pairs with. Right after a delivery, what still waits beyond the microphone
 * audio not yet in a frame is the jitter between the two. More is a backlog, such as a reply played while the
 * microphone was starting, that pairs every later frame with played audio that much older; less, as after a first
 * delivery that came late, pairs every later frame with played audio that much newer. Over each stretch as long as
 * the longest wait between deliveries, the least of it should lie between none and twice the jitter. Outside that
 * range it is brought back to the jitter, by dropping played audio or by putting silence in front of it; inside it
 * nothing moves, so that the jitter alone, such as the up to 10.7 ms of a delivery that DeepFilterNet keeps for the
 * next one, never cuts the played audio.
 *
 * When nothing is known of the alignment, after a reset or after the microphone stopped delivering, the next
 * delivery lines the two up on its own, so that MaAI gets each frame as soon as the microphone has delivered it.
 * Holding the frames until a whole stretch has been measured would leave MaAI without an estimate for the first
 * 400 ms and then hand it five frames at once, a backlog that a worker running just at real time carries for
 * seconds. The measure is taken only where a delivery ends: DeepFilterNet hands each delivery of the native helper
 * on in pieces of 10.7 ms, and its first piece taken for the whole delivery would drop the played audio the rest
 * of it pairs with.
 */
export class VapAudio {
  private assistantChunks: Float32Array[] = []
  private assistantSamples = 0
  private resampler: StreamResampler | null = null
  private userChunks: Float32Array[] = []
  private userSamples = 0
  /** Whether a delivery has lined the two up since the last reset or since the microphone last stopped delivering. */
  private aligned = false
  /** The least played audio left waiting right after a delivery in this stretch. */
  private leastSurplus = Infinity
  /** The microphone audio delivered in this stretch. */
  private stretchSamples = 0

  constructor(private readonly emit: (user: Float32Array, assistant: Float32Array) => void) {}

  pushAssistant(samples: Float32Array, sampleRate: number): void {
    this.resampler ??= new StreamResampler(sampleRate, 16_000)
    const frame = this.resampler.process(samples)
    if (frame.length === 0) return
    this.assistantChunks.push(frame)
    this.assistantSamples += frame.length
    if (this.assistantSamples > ASSISTANT_MAX_SAMPLES) {
      takeSamples(this.assistantChunks, this.assistantSamples - ASSISTANT_MAX_SAMPLES)
      this.assistantSamples = ASSISTANT_MAX_SAMPLES
      // What was measured before refers to played audio that is gone now.
      this.forgetAlignment()
    }
  }

  /**
   * The microphone frames must already be 16 kHz, and deliveryEnds says whether a frame closes what the microphone
   * handed over at once. Each time 80 ms is complete it is emitted with the played audio.
   */
  pushUser(frame: Float32Array, deliveryEnds: boolean): void {
    this.userChunks.push(frame)
    this.userSamples += frame.length
    this.stretchSamples += frame.length
    if (deliveryEnds) {
      this.leastSurplus = Math.min(this.leastSurplus, this.assistantSamples - this.userSamples)
      if (!this.aligned || this.stretchSamples >= DELIVERY_MAX_SAMPLES) this.realign()
    }
    if (!this.aligned) return
    while (this.userSamples >= FRAME_SAMPLES) {
      const user = takeSamples(this.userChunks, FRAME_SAMPLES)
      this.userSamples -= FRAME_SAMPLES
      // Where no played audio is available, the rest of the frame stays silent. The silence stands in for played
      // audio, so every surplus measured before it is that much larger now.
      const assistant = new Float32Array(FRAME_SAMPLES)
      const available = Math.min(this.assistantSamples, FRAME_SAMPLES)
      if (available > 0) {
        assistant.set(takeSamples(this.assistantChunks, available))
        this.assistantSamples -= available
      }
      this.leastSurplus += FRAME_SAMPLES - available
      this.emit(user, assistant)
    }
  }

  private realign(): void {
    const excess = this.leastSurplus - JITTER_SAMPLES
    if (excess > JITTER_SAMPLES) {
      takeSamples(this.assistantChunks, excess)
      this.assistantSamples -= excess
    } else if (excess < -JITTER_SAMPLES) {
      this.assistantChunks.unshift(new Float32Array(-excess))
      this.assistantSamples -= excess
    }
    this.aligned = true
    this.leastSurplus = Infinity
    this.stretchSamples = 0
  }

  private forgetAlignment(): void {
    this.aligned = false
    this.leastSurplus = Infinity
    this.stretchSamples = 0
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
    this.forgetAlignment()
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
