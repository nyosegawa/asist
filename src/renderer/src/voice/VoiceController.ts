import mitt, { type Emitter } from 'mitt'
import type { HangoverMode, VapState } from '@shared/ipc'
import { isMeaningfulTranscript } from '@shared/asr-filter'
import { conversationFeatures, type ConversationLocale } from '@shared/conversation-locale'
import {
  ListeningRecorder,
  shouldBackchannel,
  type BackchannelDecision
} from '@shared/listening-aizuchi'
import type { ListeningAizuchi } from '@shared/ipc'
import { shouldNod, type NodKind } from '@shared/nod'
import { classifyOverlap, outlastsBackchannel } from '@shared/user-backchannel'
import { ECHO_TAIL_MS } from '@shared/self-echo'
import { errorText } from '@shared/i18n/error-text'
import { MicInput } from './MicInput'
import { VapAudio } from './VapAudio'
import { VadSegmenter, type VadUtterance } from './VadSegmenter'
import { SileroVad } from './SileroVad'
import type { AsrProgress } from './AsrEngine'
import { AsrBackend } from './AsrBackend'
import { speechPlayer } from './SpeechPlayer'
import { displayError, errorMessageOf } from '@/display-error'
import { osMessageKey } from '@shared/i18n/os-message'
import { platformCapabilities } from '@/platform'

export type VoiceState = 'off' | 'loading' | 'listening' | 'capturing' | 'transcribing'

export interface SpeechEnd {
  /** When capture started. It matches this event to the utterance of the same speech. */
  startedAt: number
  /** When speech ended, with the hangover's silence subtracted. */
  speechEndAt: number
  vadMs: number
  vadMode: HangoverMode
  /** The partial transcript as of the end of speech. It is older than the final one and can be missing the tail. */
  partialText: string
  /** The length of the utterance in milliseconds, without the silence. */
  utteranceMs: number
  /** The aizuchi played during this capture, and whether the user carried on after each one. */
  listening: ListeningAizuchi[]
}

type Overlap = 'none' | 'pending' | 'noise' | 'backchannel'

/** A VAP estimate older than this is not used, which covers a stopped or backed-up worker. It allows the 80 ms frame, about 20 ms of inference and the IPC. */
const VAP_STALE_MS = 500

type VoiceEvents = {
  state: VoiceState
  level: number
  /** The in-browser Whisper loading while the microphone turns on, from 0 to 100. */
  progress: number
  /** The rolling partial transcript while the user is still speaking. */
  partial: string
  /**
   * The VAD has decided that speech ended. It arrives before the utterance event, and the aizuchi
   * that opens the turn plays from here rather than waiting for the final transcript.
   */
  speechend: SpeechEnd
  utterance: {
    text: string
    vadMs: number
    /** Which path decided the end of speech, early, extended or fixed. The HUD displays it as the EoT statistics. */
    vadMode: HangoverMode
    asrMs: number
    partialText: string
    /** When speech ended, on performance.now(). It is the same value the speechend event carried. */
    speechEndAt: number
    /** When capture started, on performance.now(). It decides whether an aizuchi clip falls inside the echo window. */
    startedAt: number
  }
  /**
   * The speech a speechend announced will not become an utterance: its transcription failed, the
   * transcript meant nothing, or the microphone stopped first. Every speechend is followed by one
   * utterance or one of these, with the same startedAt.
   */
  speechdropped: { startedAt: number }
  /** The user started speaking over the assistant. Playback stops right after this event. */
  bargein: undefined
  /** A short sound from the user during playback was taken as an aizuchi and let pass; the reading continues. */
  userBackchannel: undefined
  /** A break in a long utterance where an aizuchi fits, with its kind and the grounds for it. */
  backchannel: BackchannelDecision
  /** A nod, an aizuchi without a sound, which makes the orb sway slightly. */
  nod: NodKind
  /**
   * MaAI is on but its worker did not start, so the fixed hangover decides the end of speech. It comes
   * once until MaAI is turned off and on again; the cause is in main's log.
   */
  maaiUnavailable: undefined
  error: string
}

/**
 * Drives the voice input from microphone through VAD to ASR. While the user speaks it runs rolling
 * partial transcriptions, and at the end it transcribes the final buffer.
 */
export class VoiceController {
  readonly events: Emitter<VoiceEvents> = mitt<VoiceEvents>()

  private microphone = new MicInput()
  /** Which speech recognition transcribes. The setup demo replaces its preparation of the in-browser Whisper. */
  readonly recognition = new AsrBackend({ onServerLost: () => this.stopPartialLoop() })
  private vad: VadSegmenter
  /** Tells noise from voice. Where it is unavailable, the energy VAD runs alone. */
  private silero = new SileroVad()
  private state: VoiceState = 'off'
  /** The speeches, by startedAt, whose final transcript is still awaited. */
  private awaitingTranscript = new Set<number>()
  /**
   * Counts the microphone turning on and off. What was started while it was on, the transcriptions of its
   * speech included, belongs to that count; rebuilding the capture leaves it as it is.
   */
  private micGeneration = 0
  /** The microphone turning on, until it listens or has failed. */
  private enabling: Promise<void> | null = null
  private recoveryPromise: Promise<void> | null = null
  /** Final transcriptions run in the order they were recorded, so a later one finishing first cannot rewind the conversation. */
  private transcriptionTail: Promise<void> = Promise.resolve()
  private partialTimer: ReturnType<typeof setInterval> | null = null
  private partialInflight = false
  private partialRequestGeneration = 0
  private lastPartial = ''

  bargeIn = true
  /**
   * The milliseconds of human voice a barge-in must accumulate to be confirmed. Real speech raises
   * Silero's probability within about 60 ms, so the delay is not felt, and only a noise, which
   * brings no evidence at all, is refused.
   */
  bargeInMinSpeechMs = 100
  partialIntervalMs = 600
  /** While the assistant speaks, a barge-in is confirmed only after the voice holds this long, so a momentary echo does not stop it. */
  bargeInConfirmMs = 250
  /** Whether a quiet aizuchi such as "うん" plays at a break in a long utterance. Set from the settings. */
  listeningAizuchi = true
  /** Prefers capture through the native microphone helper. Set from the settings, and takes effect when the microphone restarts. */
  nativeMicPreferred = true
  /** DeepFilterNet noise suppression, which applies to native capture only. Set from the settings, and takes effect when the microphone restarts. */
  noiseSuppression = true
  /** The aizuchi classifier's reading that the sentence is unfinished, wired up by conversation. It extends the VAD's hangover. */
  holdProvider: (() => boolean) | null = null
  private vapSetting = false
  /** Whether this run of the MaAI setting has already said that the worker did not start. */
  private maaiUnavailableSaid = false
  /** VAP turn taking, which moves the hangover and times the aizuchi. Set from the settings. */
  get vapEnabled(): boolean {
    return this.vapSetting
  }
  set vapEnabled(enabled: boolean) {
    if (!enabled) this.maaiUnavailableSaid = false
    this.changeMaai(() => {
      this.vapSetting = enabled
    })
  }
  private locale: ConversationLocale = 'ja-JP'
  /**
   * The language the conversation is held in, set from the settings and read at each use. The aizuchi
   * and the turn-taking model exist for Japanese only, so in another language they stay out of the
   * pipeline however the settings that switch them are saved.
   */
  get conversationLocale(): ConversationLocale {
    return this.locale
  }
  set conversationLocale(locale: ConversationLocale) {
    this.changeMaai(() => {
      this.locale = locale
    })
  }
  private vapState: VapState | null = null
  private vapStateAt = 0
  private vapUnsubscribe: (() => void) | null = null
  private vapAudio = new VapAudio((user, assistant) => {
    void window.api.vapPush(user, assistant).catch(() => {})
  })
  /**
   * What is being done with a voice that came in during playback. While pending, the decision is open
   * and the volume is down. As noise, the volume is back up and the decision waits for human speech,
   * which opens it again. As backchannel, it was read as an aizuchi: the reading carries on and the
   * capture is discarded at its end, unless the voice keeps going, which turns it into an interruption,
   * or into ordinary speech once the reading has ended.
   */
  private overlap: Overlap = 'none'
  private lastBackchannelAt = 0
  private listening = new ListeningRecorder()
  private lastNodAt = 0
  private captureStartedAt = 0
  private boostReleaseTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    this.vad = new VadSegmenter({
      onSpeechStart: () => {
        if (speechPlayer.isPlaying) this.beginOverlap()
        this.captureStartedAt = performance.now()
        this.lastPartial = ''
        this.listening.reset()
        this.startPartialLoop()
        this.settleState()
      },
      onLevel: (rms) => {
        this.events.emit('level', Math.min(1, rms * 12))
        this.maybeConfirmBargein()
        this.maybeBackchannel()
      },
      onSpeechEnd: (utterance) => this.endCapture(utterance)
    })
    this.vad.speechProbProvider = () => this.silero.currentProb()
    this.vad.eotProvider = () => (this.vapFresh() ? this.vapState!.eotUser : null)
    this.vad.holdProvider = () => this.holdProvider?.() ?? false
    speechPlayer.onOutputSamples = (samples) => {
      if (this.usesMaai() && this.state !== 'off') {
        this.vapAudio.pushAssistant(samples, speechPlayer.outputSampleRate)
      } else {
        this.vapAudio.clearAssistant()
      }
    }
    speechPlayer.events.on('segmentstart', ({ segment }) => {
      if (this.boostReleaseTimer) clearTimeout(this.boostReleaseTimer)
      this.boostReleaseTimer = null
      // Chromium's echo canceller lets echo through, so the threshold rises during playback.
      // Native capture through Apple's VPIO cancels the echo in the OS and attenuates the
      // microphone further during double talk, so a boost on top of that would put an
      // interrupting voice out of reach of the threshold.
      this.vad.thresholdBoost = this.microphone.native ? 1 : 3
      // The listening aizuchi answers the capture in progress. Muting would throw that capture
      // away, and it is not the assistant taking the floor either.
      if (segment.clip === 'listening') return
      if (!this.bargeIn) this.vad.muted = true
      // A reply that starts while the user is already speaking overlaps the voice just as a voice
      // that starts during the reply does.
      else if (this.vad.isSpeaking) this.beginOverlap()
    })
    // Reverberation and the tail of the echo linger in the microphone just after playback ends,
    // so the normal threshold returns only after a wait.
    speechPlayer.events.on('idle', () => {
      if (this.boostReleaseTimer) clearTimeout(this.boostReleaseTimer)
      this.boostReleaseTimer = setTimeout(() => {
        this.boostReleaseTimer = null
        this.vad.thresholdBoost = 1
        this.vad.muted = false
      }, ECHO_TAIL_MS)
    })
  }

  get current(): VoiceState {
    return this.state
  }

  /**
   * Opens the decision on a voice that overlaps playback. Nothing stops at once: the voice has to
   * hold first, or an echo mistaken for speech would stop it. With barge-in off the user's voice never
   * stops the assistant.
   */
  private beginOverlap(): void {
    if (!this.bargeIn || this.overlap !== 'none') return
    this.setOverlap('pending')
  }

  /**
   * Moves the decision on a voice over playback. The volume is down exactly while the decision is
   * pending, which both keeps the assistant off the user's words and makes the response feel immediate.
   */
  private setOverlap(next: Overlap): void {
    if (next === this.overlap) return
    this.overlap = next
    if (next !== 'pending') speechPlayer.unduck()
    // An aizuchi or bridge lasts about a second and sounds broken off if ducked. A real
    // interruption stops it once confirmed anyway.
    else if (!speechPlayer.isPlayingClip) speechPlayer.duck()
  }

  /**
   * Sorts a voice that came in during playback into an aizuchi to let pass, an interruption to stop
   * for, or noise. Energy gives the immediate reaction within 250 ms, Silero's evidence of a human
   * voice is what refuses noise, and bc_det detects the aizuchi. While Silero is not ready
   * speechDuration equals voicedDuration, so noise is refused exactly as it was before Silero.
   */
  private maybeConfirmBargein(): void {
    if (this.overlap === 'none') return
    const voice = {
      voicedMs: this.vad.voicedDuration,
      speechMs: this.vad.speechDuration,
      minSpeechMs: this.bargeInMinSpeechMs
    }
    if (!speechPlayer.isPlaying) {
      // Playback ended before the decision closed, so the voice goes on as ordinary speech. One let pass
      // as an aizuchi stays one until it outlasts an aizuchi, as it would over playback, because the
      // hangover of a lone 「はい」 over the last words of the reading runs on past their end.
      if (this.overlap !== 'backchannel' || outlastsBackchannel(voice)) this.setOverlap('none')
      return
    }
    const verdict = classifyOverlap({
      ...voice,
      bcDet: this.vapFresh() ? this.vapState!.bcDetUser : null,
      confirmMs: this.bargeInConfirmMs
    })
    if (verdict === 'bargein') {
      // The event goes out while the interrupted reply is still playing, so that it is counted
      // against the turn being read before the stop closes that turn's measurements.
      this.events.emit('bargein')
      speechPlayer.interrupt()
      this.setOverlap('none')
      return
    }
    if (this.overlap === 'backchannel') return
    if (verdict === 'backchannel') {
      this.setOverlap('backchannel')
      this.events.emit('userBackchannel')
      return
    }
    // Noise brings the volume back up early, so playback spends as little time as possible quietening
    // on its own, and human speech that follows inside the same capture opens the decision again.
    this.setOverlap(verdict === 'noise' ? 'noise' : 'pending')
  }

  /** Fires an aizuchi at a break in a long utterance. conversation plays it. */
  private maybeBackchannel(): void {
    if (!this.listeningAizuchi || !conversationFeatures(this.conversationLocale).aizuchi) return
    // A capture that is only noise gets no aizuchi; a human voice has to be confirmed first.
    if (!this.vad.speechConfirmed) return
    // A voice returning after an aizuchi means it landed on a pause inside a sentence.
    if (this.vad.isSpeaking && this.vad.silenceDuration === 0) this.listening.voiced()
    const now = performance.now()
    const decision = shouldBackchannel({
      userSpeaking: this.vad.isSpeaking,
      assistantSpeaking: speechPlayer.isPlaying,
      silenceMs: this.vad.silenceDuration,
      utteranceMs: this.vad.utteranceDuration,
      partialText: this.lastPartial,
      msSinceLast: now - this.lastBackchannelAt,
      vap: this.vapFresh()
        ? {
            eotUser: this.vapState!.eotUser,
            bcReact: this.vapState!.bcReact,
            bcEmo: this.vapState!.bcEmo
          }
        : null
    })
    if (decision) {
      this.lastBackchannelAt = now
      this.listening.fired(decision, now - this.captureStartedAt)
      this.events.emit('backchannel', decision)
    }
  }

  /** Decides on a nod each time the nod model's estimate arrives, once per frame. Orb plays it. */
  private maybeNod(): void {
    if (!this.vad.speechConfirmed) return
    const now = performance.now()
    const kind = shouldNod({
      userSpeaking: this.vad.isSpeaking,
      assistantSpeaking: speechPlayer.isPlaying,
      nod: this.vapFresh()
        ? { short: this.vapState!.nodShort, long: this.vapState!.nodLong }
        : null,
      msSinceLast: now - this.lastNodAt
    })
    if (kind) {
      this.lastNodAt = now
      this.events.emit('nod', kind)
    }
  }

  /** Milliseconds since the last aizuchi, which keeps the turn's opening aizuchi from doubling up. */
  get msSinceBackchannel(): number {
    return performance.now() - this.lastBackchannelAt
  }

  /** Whether MaAI takes part in this conversation: its four models are trained on Japanese. */
  private usesMaai(): boolean {
    return this.vapEnabled && conversationFeatures(this.conversationLocale).maai
  }

  /** Applies a change to the setting or the language. MaAI that starts taking part while the microphone is on starts at once. */
  private changeMaai(change: () => void): void {
    const used = this.usesMaai()
    change()
    if (!used && this.state !== 'off') this.startMaai()
  }

  /**
   * Starts MaAI's worker, if MaAI takes part, and listens to its estimates. The worker is resident in main:
   * turning the microphone off leaves it running, and a start finds it running unless it was stopped.
   */
  private startMaai(): void {
    if (!this.usesMaai()) return
    this.vapUnsubscribe ??= window.api.onVapState((state) => {
      this.vapState = state
      this.vapStateAt = performance.now()
      this.maybeNod()
    })
    void window.api.vapStart().then(
      (started) => {
        if (!started) this.sayMaaiUnavailable()
      },
      (err: unknown) => {
        console.error('MaAI start failed:', errorMessageOf(err))
        this.sayMaaiUnavailable()
      }
    )
  }

  /**
   * The conversation goes on without MaAI, on the fixed hangover, and the user hears of it once. A start
   * that ends after MaAI was turned off, or the language changed, has nothing to report.
   */
  private sayMaaiUnavailable(): void {
    if (!this.usesMaai() || this.maaiUnavailableSaid) return
    this.maaiUnavailableSaid = true
    this.events.emit('maaiUnavailable')
  }

  /** Whether the newest VAP estimate can be used. A stopped or backed-up worker leaves it stale. */
  private vapFresh(): boolean {
    return (
      this.usesMaai() && this.vapState !== null && performance.now() - this.vapStateAt < VAP_STALE_MS
    )
  }

  setHangover(ms: number): void {
    this.vad.hangoverMs = Math.max(150, Math.min(1500, ms))
  }

  /** The user's explicit consent to the in-browser Whisper, set from the settings. */
  get localFallbackEnabled(): boolean {
    return this.recognition.localFallbackEnabled
  }
  set localFallbackEnabled(enabled: boolean) {
    this.recognition.localFallbackEnabled = enabled
  }

  prepareLocalAsr(onProgress?: (info: AsrProgress) => void): Promise<string> {
    return this.recognition.prepareLocal(onProgress)
  }

  cancelLocalAsrPreparation(): void {
    this.recognition.cancelLocalPreparation()
  }

  enable(): Promise<void> {
    if (this.state !== 'off') return Promise.resolve()
    const enabling = this.turnOn().finally(() => {
      if (this.enabling === enabling) this.enabling = null
    })
    this.enabling = enabling
    return enabling
  }

  private async turnOn(): Promise<void> {
    const generation = ++this.micGeneration
    const current = (): boolean => generation === this.micGeneration
    this.setState('loading')
    // The model that tells noise from voice, about 2 MB and bundled with the app, loads while the
    // microphone is being prepared. A failure leaves ready false and the energy VAD running alone,
    // so nothing waits for it and nothing is refused over it.
    void this.silero.init()
    try {
      const permitted = await window.api.requestMicPermission()
      if (!current()) return
      if (!permitted) throw new Error(errorText(osMessageKey('voice.mic.notPermitted', platformCapabilities().os)))
      const loading = ({ progress }: AsrProgress): void => {
        if (current()) this.events.emit('progress', progress)
      }
      if (!(await this.recognition.choose(current, loading))) return
      this.startMaai()
      await this.openCapture(generation)
    } catch (err) {
      this.failToListen(generation, err)
    }
  }

  /** Turns the microphone off. The speech still being transcribed is cancelled and reported as dropped. */
  disable(): void {
    this.micGeneration++
    this.recognition.stop()
    // Detaching the chain keeps a new generation's final transcription out of the queue of an
    // aborted one.
    this.transcriptionTail = Promise.resolve()
    const dropped = [...this.awaitingTranscript]
    this.awaitingTranscript.clear()
    this.dropCapture()
    this.microphone.stop()
    for (const startedAt of dropped) this.events.emit('speechdropped', { startedAt })
    this.setState('off')
  }

  /** Applies what the service watchdog reports about the speech recognition server. */
  handleAsrStatus(available: boolean): void {
    this.recognition.handleStatus(available)
  }

  /**
   * Builds capture again after the machine sleeps and wakes or the input source goes away. Only the
   * microphone and what reads it start over: the speech already captured is still transcribed. If the
   * microphone was off, it only checks whether the backend can move up.
   */
  recover(): Promise<void> {
    if (this.recoveryPromise) return this.recoveryPromise
    const recovery = this.state === 'off' ? this.recognition.probeUpgrade() : this.rebuildCapture()
    this.recoveryPromise = recovery.finally(() => {
      this.recoveryPromise = null
    })
    return this.recoveryPromise
  }

  private async rebuildCapture(): Promise<void> {
    // A microphone still turning on opens its capture once the backend is chosen, so it is rebuilt after that.
    await this.enabling
    if (this.state === 'off') return
    const generation = this.micGeneration
    this.dropCapture()
    this.setState('loading')
    void this.silero.init()
    await this.openCapture(generation).catch((err: unknown) => this.failToListen(generation, err))
  }

  /** Opens the microphone into Silero, the VAD and MaAI, and listens once it delivers. */
  private async openCapture(generation: number): Promise<void> {
    const feed = (frame: Float32Array): void => {
      this.silero.push(frame)
      this.vad.push(frame)
      if (this.usesMaai()) this.vapAudio.pushUser(frame)
    }
    // A source that stops delivering rebuilds the capture: on getUserMedia once main has given up on the
    // native helper, and with no microphone left the rebuild fails and reports it.
    await this.microphone.start(
      { native: this.nativeMicPreferred, noiseSuppression: this.noiseSuppression },
      feed,
      () => void this.recover()
    )
    // Each start releases its own resources. Calling the shared stop from an older start would
    // also stop a recording that an off-then-on cycle has already begun.
    if (generation !== this.micGeneration) return
    this.setState(this.activity())
    void this.recognition.probeUpgrade()
  }

  /** The microphone could not start listening, so it turns off with the error, unless it was turned off or on again meanwhile. */
  private failToListen(generation: number, err: unknown): void {
    if (generation !== this.micGeneration) return
    this.events.emit('error', displayError(err))
    this.disable()
  }

  /**
   * Drops the capture in progress, which reports no end, with what reads the microphone. The speech
   * already captured is left to its transcription.
   */
  private dropCapture(): void {
    this.stopPartialLoop()
    this.setOverlap('none')
    this.vapAudio.reset()
    this.vapState = null
    this.vad.reset()
    this.silero.dispose()
  }

  private startPartialLoop(): void {
    // The in-browser Whisper is too slow to transcribe partials.
    if (!this.recognition.onServer || this.partialIntervalMs <= 0) return
    this.stopPartialLoop()
    this.partialTimer = setInterval(() => void this.partialTick(), this.partialIntervalMs)
  }

  private stopPartialLoop(): void {
    if (this.partialTimer) clearInterval(this.partialTimer)
    this.partialTimer = null
    this.partialRequestGeneration++
    this.partialInflight = false
  }

  private async partialTick(): Promise<void> {
    if (this.partialInflight) return
    // A capture that is only noise does not run through Whisper.
    if (!this.vad.speechConfirmed) return
    // The last 5 seconds keep a partial transcription cheap however long the utterance runs, so it
    // does not compete with the final one.
    const samples = this.vad.snapshot(5000)
    if (!samples) return
    const micGeneration = this.micGeneration
    const captureStartedAt = this.captureStartedAt
    const requestGeneration = ++this.partialRequestGeneration
    this.partialInflight = true
    try {
      const text = (await window.api.transcribePartial(this.normalize(samples))).trim()
      if (
        requestGeneration === this.partialRequestGeneration &&
        micGeneration === this.micGeneration &&
        captureStartedAt === this.captureStartedAt &&
        text &&
        this.vad.isSpeaking &&
        isMeaningfulTranscript(text, this.conversationLocale)
      ) {
        this.lastPartial = text
        this.events.emit('partial', text)
      }
    } catch {
      /* The request is speculative, so the failure is swallowed. */
    } finally {
      if (requestGeneration === this.partialRequestGeneration) this.partialInflight = false
    }
  }

  private normalize(samples: Float32Array): Float32Array {
    let peak = 0
    for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]))
    if (peak < 1e-4 || peak >= 0.9) return samples
    const gain = 0.9 / peak
    const out = new Float32Array(samples.length)
    for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain
    return out
  }

  /** Every capture ends here, with the utterance the VAD kept, or with nothing when it was noise or the VAD was muted. */
  private endCapture(utterance: VadUtterance | null): void {
    this.stopPartialLoop()
    // A "うん" or "はい" during the reading was let pass as an aizuchi, so it becomes neither a turn
    // nor a transcript.
    const backchannel = this.overlap === 'backchannel'
    this.setOverlap('none')
    if (utterance && !backchannel) this.enqueueUtterance(utterance.samples, utterance.vadMs, utterance.mode)
    this.settleState()
  }

  private enqueueUtterance(samples: Float32Array, vadMs: number, vadMode: HangoverMode): void {
    const generation = this.micGeneration
    const startedAt = this.captureStartedAt
    const partialText = this.lastPartial
    const speechEndAt = performance.now() - vadMs
    this.events.emit('speechend', {
      startedAt,
      speechEndAt,
      vadMs,
      vadMode,
      partialText,
      utteranceMs: Math.max(0, Math.round(samples.length / 16) - vadMs),
      listening: this.listening.take()
    })
    this.awaitingTranscript.add(startedAt)
    const previous = this.transcriptionTail.catch(() => {})
    const completion = previous.then(() =>
      this.handleUtterance(samples, vadMs, vadMode, generation, startedAt, partialText, speechEndAt)
    )
    // handleUtterance turns a failure into a UI event. Should an exception ever escape it, it must
    // still not become an unhandled rejection or stop the transcriptions behind it.
    this.transcriptionTail = completion.catch(() => {})
  }

  private async handleUtterance(
    samples: Float32Array,
    vadMs: number,
    vadMode: HangoverMode,
    generation: number,
    startedAt: number,
    partialText: string,
    speechEndAt: number
  ): Promise<void> {
    // disable has already reported the speeches of the generation it ended as dropped.
    if (generation !== this.micGeneration) return
    const t0 = performance.now()
    let heard = false
    try {
      const audio = this.normalize(samples)
      const text = await this.recognition.transcribe(audio, () => generation === this.micGeneration)
      if (generation !== this.micGeneration) return
      const asrMs = Math.round(performance.now() - t0)
      if (isMeaningfulTranscript(text, this.conversationLocale)) {
        heard = true
        this.events.emit('utterance', {
          text: text.trim(),
          vadMs,
          vadMode,
          asrMs,
          partialText,
          startedAt,
          speechEndAt
        })
      }
    } catch (err) {
      if (generation === this.micGeneration) {
        this.events.emit('error', displayError(err))
      }
    } finally {
      if (generation === this.micGeneration) {
        this.awaitingTranscript.delete(startedAt)
        if (!heard) this.events.emit('speechdropped', { startedAt })
        this.settleState()
        void this.recognition.probeUpgrade()
      }
    }
  }

  /**
   * Listening, capturing and transcribing follow from what is under way: a capture in progress, then
   * a transcript still awaited.
   */
  private activity(): VoiceState {
    return this.vad.isSpeaking ? 'capturing' : this.awaitingTranscript.size > 0 ? 'transcribing' : 'listening'
  }

  /** Only opening the capture moves the state out of loading, and only turning the microphone on out of off. */
  private settleState(): void {
    if (this.state === 'off' || this.state === 'loading') return
    this.setState(this.activity())
  }

  private setState(next: VoiceState): void {
    if (this.state === next) return
    this.state = next
    this.events.emit('state', next)
  }
}

export const voiceController = new VoiceController()
