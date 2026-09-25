import type { HangoverMode } from '@shared/ipc'
import { VAP_EOT_CONFIRM, VAP_EOT_HOLD_BELOW } from '@shared/maai-thresholds'

/**
 * Detects the stretches of speech by combining two signals, each with its own job, in this one
 * place. Keeping the voice decision here rather than at each consumer is what makes it impossible
 * for one consumer to miss the gate.
 *
 * - Energy, against an adaptive noise floor, cuts the stretches out and gives the immediate
 *   reaction. The start of speech, silence, ducking and how quickly barge-in feels like it responds
 *   all follow the level, because Silero's probability lags by about one chunk, 32 ms, and routing
 *   the start through it would be felt. Energy also sets the floor against a television, a distant
 *   conversation and the echo of the assistant's own speech, which raises thresholdBoost while it
 *   plays.
 * - Silero VAD decides whether what was cut out is a human voice. It accumulates into
 *   speechDuration and speechConfirmed, which the decision to send audio to ASR, the partial
 *   transcripts, the aizuchi played while the user speaks and the noise rejection of a confirmed
 *   barge-in all read. A noise such as typing or an object set down has high energy but adds
 *   nothing to speechDuration, which stops Whisper from hallucinating words out of it. While
 *   speechProbProvider returns null, because Silero is not ready or has failed, audio energy alone
 *   decides, so no failure here can discard speech.
 */

export interface VadEvents {
  onSpeechStart?: () => void
  /** samples holds the whole stretch of speech, vadMs the hangover the end decision took, and mode the path that decision went through. */
  onUtterance?: (samples: Float32Array, vadMs: number, mode: HangoverMode) => void
  /** The RMS, roughly 0 to 1, that the level meter in the UI displays. */
  onLevel?: (rms: number) => void
}

const SAMPLE_RATE = 16_000

const PRE_ROLL_MS = 300
const MIN_UTTERANCE_MS = 300
const MAX_UTTERANCE_MS = 20_000
const NOISE_FLOOR_INIT = 0.008
const NOISE_FLOOR_ALPHA = 0.05
const SPEECH_RATIO = 3.0
const MIN_THRESHOLD = 0.012
const MIN_VOICED_MS = 250
/** A voiced frame counts as speech when Silero VAD's voice probability reaches this. */
const SPEECH_PROB_THRESHOLD = 0.5
/** The speech that must accumulate before audio goes to ASR. Noise never reaches it, however loud. */
const MIN_SPEECH_MS = 150

/*
 * The VAP moves the hangover. A silence whose EoT, the probability that the turn has ended, stays
 * high ends the utterance early, and one whose EoT is low, a pause inside a sentence with more to
 * come, extends it. While the VAP is not ready or its value is stale the provider returns null and
 * the configured fixed value applies. The EoT thresholds and the measurements behind them are
 * specific to the model and live in maai-thresholds.
 */
/** How long a high EoT must hold. A momentary spike, where an aizuchi would fit, must not end the utterance early. */
const VAP_EOT_PERSIST_MS = 200
/** The shortest hangover an early end can use. */
const VAP_EARLY_HANGOVER_MS = 300
/** The longest hangover an extension can use. */
const VAP_EXTENDED_HANGOVER_MS = 900

export class VadSegmenter {
  private preRoll: Float32Array[] = []
  private preRollSamples = 0
  private utterance: Float32Array[] = []
  private utteranceSamples = 0
  private speaking = false
  private silenceMs = 0
  private voicedMs = 0
  private speechMs = 0
  private noiseFloor = NOISE_FLOOR_INIT
  /** Speech ends once silence lasts this long. The settings can tune it. */
  hangoverMs = 350
  /** While true, every frame is ignored outright. */
  muted = false
  /** Raised while the assistant speaks, so its echo does not trip barge-in. */
  thresholdBoost = 1
  /**
   * Supplies Silero VAD's voice probability. The newest value, about one 32 ms chunk behind, is
   * accurate enough. While it returns null, because Silero is not ready or has failed, energy alone
   * decides.
   */
  speechProbProvider: (() => number | null) | null = null
  /**
   * Supplies the VAP's EoT, the probability that the user's turn has ended. It moves the hangover
   * according to whether a silence is an ending or a pause with more to come. While it returns
   * null, the configured fixed hangover applies.
   */
  eotProvider: (() => number | null) | null = null
  /**
   * Reports whether the aizuchi classifier reads the partial transcript as an unfinished sentence.
   * A silence while it is true is waiting for the rest, so the hangover extends whatever the VAP
   * says: measured on 2026-09-20, the classifier's hold reached F1 0.95 on unseen material, which
   * is more reliable than the VAP's EoT.
   */
  holdProvider: (() => boolean) | null = null
  /** How long, in milliseconds, the EoT has stayed at or above the confirm threshold within the current silence. */
  private eotHighMs = 0

  constructor(private readonly events: VadEvents) {}

  get isSpeaking(): boolean {
    return this.speaking
  }

  /** The milliseconds of the current utterance that were voiced by energy. The immediate barge-in decision reads it. */
  get voicedDuration(): number {
    return this.voicedMs
  }

  /**
   * The milliseconds of the current utterance confirmed as a human voice, which is what rejects
   * noise when a barge-in is confirmed. While Silero is not ready it equals voicedDuration.
   */
  get speechDuration(): number {
    return this.speechMs
  }

  /** The current silence in milliseconds. It decides whether a pause inside a sentence invites an aizuchi. */
  get silenceDuration(): number {
    return this.speaking ? this.silenceMs : 0
  }

  /** Whether the captured audio is confirmed as a human voice. The partial transcripts and the aizuchi wait for it. */
  get speechConfirmed(): boolean {
    return this.speechMs >= MIN_SPEECH_MS
  }

  /** The milliseconds since speech started. */
  get utteranceDuration(): number {
    return this.speaking ? (this.utteranceSamples / SAMPLE_RATE) * 1000 : 0
  }

  /**
   * A snapshot of the utterance buffer being captured, for the partial transcripts. With maxMs only
   * the tail comes back, because the load Whisper carries grows linearly with the length of the
   * utterance and the tail is enough to read the intent from.
   */
  snapshot(maxMs = Infinity): Float32Array | null {
    if (!this.speaking || this.utteranceSamples < SAMPLE_RATE / 2) return null
    const all = this.concat()
    const maxSamples = Math.floor((maxMs / 1000) * SAMPLE_RATE)
    return all.length > maxSamples ? all.slice(all.length - maxSamples) : all
  }

  push(frame: Float32Array): void {
    if (this.muted) {
      if (this.speaking) this.reset()
      return
    }

    const rms = this.rms(frame)
    this.events.onLevel?.(rms)
    const threshold = Math.max(MIN_THRESHOLD, this.noiseFloor * SPEECH_RATIO) * this.thresholdBoost
    const frameMs = (frame.length / SAMPLE_RATE) * 1000

    if (!this.speaking) {
      // The noise floor learns only from quiet frames, those at or below the threshold. Mixing a
      // loud frame into it sends the floor up, multiplied again by the boost during playback, and
      // locks speech out.
      if (rms <= threshold) {
        this.noiseFloor = this.noiseFloor * (1 - NOISE_FLOOR_ALPHA) + rms * NOISE_FLOOR_ALPHA
      }
      this.appendPreRoll(frame)
      // The start follows energy alone so that ducking and barge-in stay immediate. If a noise
      // starts a capture, too little voice accumulates and the utterance is discarded at the end.
      if (rms > threshold) {
        this.speaking = true
        this.silenceMs = 0
        this.utterance = [...this.preRoll]
        this.utteranceSamples = this.preRollSamples
        this.events.onSpeechStart?.()
      }
      return
    }

    this.utterance.push(frame)
    this.utteranceSamples += frame.length
    if (rms > threshold) {
      this.silenceMs = 0
      this.eotHighMs = 0
      this.voicedMs += frameMs
      const prob = this.speechProbProvider?.() ?? null
      if (prob === null || prob >= SPEECH_PROB_THRESHOLD) this.speechMs += frameMs
    } else {
      this.silenceMs += frameMs
      const eot = this.eotProvider?.() ?? null
      if (eot !== null && eot >= VAP_EOT_CONFIRM) this.eotHighMs += frameMs
      else this.eotHighMs = 0
    }

    const utteranceMs = (this.utteranceSamples / SAMPLE_RATE) * 1000
    const hangover = this.effectiveHangover()
    if (this.silenceMs >= hangover.ms) {
      this.finalize(utteranceMs, hangover.mode)
    } else if (utteranceMs >= MAX_UTTERANCE_MS) {
      this.finalize(utteranceMs, 'fixed')
    }
  }

  /**
   * Moves the hangover according to what the silence is. A sentence the classifier reads as
   * unfinished extends it, up to 900 ms. A silence whose VAP EoT stays high ends the utterance
   * early, down to 300 ms, and a low EoT extends it; anything else, and a VAP that is not ready,
   * keeps the configured value. A configured value already shorter than the early bound, or longer
   * than the extended bound, is left alone and the mode stays fixed.
   */
  private effectiveHangover(): { ms: number; mode: HangoverMode } {
    if (this.holdProvider?.() && VAP_EXTENDED_HANGOVER_MS > this.hangoverMs) {
      return { ms: VAP_EXTENDED_HANGOVER_MS, mode: 'extended' }
    }
    const eot = this.eotProvider?.() ?? null
    if (eot === null) return { ms: this.hangoverMs, mode: 'fixed' }
    if (this.eotHighMs >= VAP_EOT_PERSIST_MS && VAP_EARLY_HANGOVER_MS < this.hangoverMs) {
      return { ms: VAP_EARLY_HANGOVER_MS, mode: 'early' }
    }
    if (eot <= VAP_EOT_HOLD_BELOW && VAP_EXTENDED_HANGOVER_MS > this.hangoverMs) {
      return { ms: VAP_EXTENDED_HANGOVER_MS, mode: 'extended' }
    }
    return { ms: this.hangoverMs, mode: 'fixed' }
  }

  private finalize(utteranceMs: number, mode: HangoverMode): void {
    const samples = this.concat()
    const voicedMs = this.voicedMs
    const speechMs = this.speechMs
    const vadMs = Math.round(this.silenceMs)
    this.reset()
    // A short noise must not start Whisper, and requiring accumulated voice from Silero on top of
    // that stops a long noise, such as a run of keystrokes, from being hallucinated into words. The
    // length is measured without the silence, so an early VAP end that shortens the hangover does
    // not discard a short utterance.
    if (
      utteranceMs - vadMs >= MIN_UTTERANCE_MS &&
      voicedMs >= MIN_VOICED_MS &&
      speechMs >= MIN_SPEECH_MS
    ) {
      this.events.onUtterance?.(samples, vadMs, mode)
    } else if (voicedMs > 0) {
      // The breakdown makes it possible to follow up a report that speaking did nothing.
      console.log(
        `vad: utterance discarded (utterance=${Math.round(utteranceMs)}ms voiced=${Math.round(voicedMs)}ms speech=${Math.round(speechMs)}ms silence=${vadMs}ms)`
      )
    }
  }

  /** Stopping and restarting capture must not carry the previous utterance buffer over. */
  reset(): void {
    this.speaking = false
    this.silenceMs = 0
    this.eotHighMs = 0
    this.voicedMs = 0
    this.speechMs = 0
    this.utterance = []
    this.utteranceSamples = 0
    this.preRoll = []
    this.preRollSamples = 0
  }

  private appendPreRoll(frame: Float32Array): void {
    this.preRoll.push(frame)
    this.preRollSamples += frame.length
    const maxSamples = (PRE_ROLL_MS / 1000) * SAMPLE_RATE
    while (this.preRollSamples - (this.preRoll[0]?.length ?? 0) > maxSamples) {
      this.preRollSamples -= this.preRoll.shift()!.length
    }
  }

  private concat(): Float32Array {
    const out = new Float32Array(this.utteranceSamples)
    let offset = 0
    for (const chunk of this.utterance) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    return out
  }

  private rms(frame: Float32Array): number {
    let sum = 0
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
    return Math.sqrt(sum / frame.length)
  }
}
