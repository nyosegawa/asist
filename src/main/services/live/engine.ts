import mitt, { type Emitter } from 'mitt'
import type { AppSettings, LiveConnection, LiveEvent, LiveUsage, TurnEvent } from '@shared/ipc'
import { LiveSessionPolicy } from '@shared/live-session-policy'
import type { LiveEngineInfo } from '@shared/voice-engine'
import { errMessage } from '@shared/api-errors'
import { errorText } from '@shared/i18n/error-text'
import { record, turnScheduler } from '../brain/session'
import { InputEncoder } from './audio'
import { TranscriptTracker, type TranscriptRole } from './transcripts'

/**
 * What the live engines have in common. GPT-Live and Gemini share the audio path to and from the
 * renderer, the policy for opening and closing a session (live-session-policy), the transcript assembly
 * and the conversation log, and the usage and cost estimate. How each model signals a handover (GPT-Live
 * delegation, Gemini function calling) is not shared.
 *
 * The user and assistant lines of the conversation log are written from the input and output transcripts,
 * that is from what was actually heard. A turn id is allocated per exchange, and an exchange handed to
 * brain keeps brain's turnId.
 */

export type LiveEngineEvents = {
  /** Mono Float32 at 24 kHz, played in the order it arrives. */
  audio: Float32Array
  event: LiveEvent
}

export interface LiveEngineDeps {
  settings: () => AppSettings
  now?: () => number
}

/**
 * How long the transcript stays quiet before an utterance is final. It is long enough not to cut at a
 * pause inside a sentence, which runs around 0.5 seconds, and short enough to separate two utterances.
 */
const TRANSCRIPT_QUIET_MS = 1500
/**
 * How much audio is buffered while the session is closed. It is long enough that the roughly one second
 * the connection takes does not swallow the start of an utterance.
 */
const PRE_ROLL_MS = 3000
const POLICY_TICK_MS = 1000

export abstract class LiveEngineBase {
  readonly events: Emitter<LiveEngineEvents> = mitt<LiveEngineEvents>()
  protected readonly now: () => number
  protected readonly settings: () => AppSettings
  protected readonly policy: LiveSessionPolicy
  protected connection: LiveConnection = 'off'
  protected enabled = false
  private ticker: ReturnType<typeof setInterval> | null = null
  private opening: Promise<void> | null = null
  private readonly encoder: InputEncoder
  /** The turn id of the current exchange. The exchange closes once the assistant transcript is final. */
  protected exchangeTurnId: number | null = null
  /**
   * Who emitted the started TurnEvent of this exchange, which engines that open tools or panels need:
   * the engine itself, or brain for a turn it was handed. Whoever started a turn ends it.
   */
  private exchangeStartedBy: 'engine' | 'brain' | null = null
  /**
   * Whether a GPT-Live delegation has claimed the user's utterance in progress for brain. Until the
   * delegation takes it, the reply's transcript neither finalizes it nor closes the exchange.
   */
  private userClaimed = false
  /**
   * Whether a session the provider ends reopens at once, because the user is speaking. The start of
   * speech allows one such reopen and its end withdraws it, so a provider that ends every session as
   * soon as it starts cannot keep the engine reconnecting, and billing a session each time.
   */
  private reopenForSpeech = false
  protected readonly transcripts: TranscriptTracker
  /** Response latency measurement: when the last user transcript arrived and whether audio is still awaited. */
  private lastUserDeltaAt = -Infinity
  private awaitingFirstAudio = false
  /** When opening the session started, which gives the connect time. */
  private openStartedAt = -Infinity
  protected usage: LiveUsage = { sessionSeconds: 0, costUsd: 0 }

  constructor(
    protected readonly info: LiveEngineInfo,
    deps: LiveEngineDeps
  ) {
    this.settings = deps.settings
    this.now = deps.now ?? (() => Date.now())
    this.policy = new LiveSessionPolicy({
      idleMs: deps.settings().liveIdleSeconds * 1000,
      preRollMs: PRE_ROLL_MS,
      sampleRate: 16_000
    })
    this.encoder = new InputEncoder(info.inputRate)
    this.transcripts = new TranscriptTracker({
      quietMs: TRANSCRIPT_QUIET_MS,
      onDelta: (role, text) => this.onTranscriptDelta(role, text),
      onFinal: (role, text) => this.onTranscriptFinal(role, text)
    })
  }

  get state(): LiveConnection {
    return this.connection
  }

  async start(): Promise<void> {
    if (this.enabled) return
    this.enabled = true
    this.setConnection('idle')
    this.ticker = setInterval(() => {
      if (this.policy.tick(this.now(), this.working()) === 'close') void this.close('idle')
    }, POLICY_TICK_MS)
  }

  async stop(): Promise<void> {
    if (!this.enabled) return
    this.enabled = false
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
    this.reopenForSpeech = false
    // A delegation ends with the engine and hands nothing to brain, so an utterance it claimed is
    // recorded as it was heard, like any other still in progress.
    this.userClaimed = false
    this.transcripts.flush('user')
    this.transcripts.flush('assistant')
    await this.close('stop')
    this.transcripts.dispose()
    this.setConnection('off')
  }

  /** Mono Float32 from the microphone at 16 kHz. While the session is closed it goes into the pre-roll. */
  pushAudio(frame: Float32Array): void {
    if (!this.enabled) return
    if (!this.policy.isOpen) {
      this.policy.buffer(frame)
      return
    }
    const encoded = this.encoder.encode(frame)
    if (encoded) this.transmitAudio(encoded, frame.length / 16_000)
  }

  /** The renderer's VAD heard a human voice start or stop. The start opens a closed session. */
  activity(active: boolean): void {
    if (!this.enabled) return
    this.reopenForSpeech = active
    if (active && this.policy.onUserSpeech(this.now()) === 'open') void this.ensureOpen()
  }

  abstract sendText(text: string): Promise<void>

  /**
   * Opens the session. Once it resolves, audio can be sent. The engine owns the socket from the moment
   * it creates it, and ignores what any socket it no longer owns reports.
   */
  protected abstract openSession(): Promise<void>
  /** Closes the socket the engine owns, including one whose opening failed or has not finished. */
  protected abstract closeSession(reason: 'idle' | 'stop' | 'error'): Promise<void>
  /** Sends base64 PCM16 at the input rate. `seconds` is the length of that audio, which the usage counts. */
  protected abstract transmitAudio(base64: string, seconds: number): void

  protected async ensureOpen(): Promise<void> {
    // A brain turn that took over an utterance can still send sentences after a stop, and a session
    // opened for them would stay open and billed, with no idle close left to end it.
    if (!this.enabled || this.policy.isOpen) return
    if (this.opening) return this.opening
    this.openStartedAt = this.now()
    this.setConnection('connecting')
    this.opening = this.openSession()
      .then(() => {
        this.policy.opened(this.now())
        this.setConnection('open')
        const connectMs = Math.round(this.now() - this.openStartedAt)
        this.events.emit('event', { type: 'latency', responseMs: 0, connectMs })
        for (const frame of this.policy.takePreRoll()) {
          const encoded = this.encoder.encode(frame)
          if (encoded) this.transmitAudio(encoded, frame.length / 16_000)
        }
      })
      .catch(async (err) => {
        // Left open, the socket of a session that did not start can still start late, and the provider
        // bills it for as long as it is open.
        await this.release('error')
        const detail = errMessage(err)
        this.setConnection('error', detail)
        this.events.emit('event', { type: 'error', message: errorText('voice.live.connectFailed', { detail }) })
      })
      .finally(() => {
        this.opening = null
      })
    return this.opening
  }

  protected async close(reason: 'idle' | 'stop' | 'error'): Promise<void> {
    if (!this.policy.isOpen && !this.opening) return
    await this.opening?.catch(() => {})
    await this.release(reason)
    if (this.enabled) this.setConnection(reason === 'error' ? 'error' : 'idle')
  }

  private async release(reason: 'idle' | 'stop' | 'error'): Promise<void> {
    this.policy.closed()
    try {
      await this.closeSession(reason)
    } catch (err) {
      console.error('live session close failed:', errMessage(err))
    }
  }

  /**
   * The provider ended the session, as at its time limit. Speech in progress opens a new one at once,
   * as the start of speech would have, and meanwhile goes into the pre-roll; while the user is silent,
   * the next speech opens it, as after an idle close.
   */
  protected sessionEnded(): void {
    this.policy.closed()
    if (!this.enabled) return
    this.setConnection('idle')
    if (!this.reopenForSpeech) return
    this.reopenForSpeech = false
    void this.ensureOpen()
  }

  /** Marks the conversation as still going, such as model audio or brain work, and pushes back the idle close. */
  protected touch(): void {
    this.policy.activity(this.now())
  }

  /**
   * Whether the engine itself still runs something for the conversation, such as a function call waiting
   * for approval, which gives no sign of life until it ends. An engine that hands its tools to brain turns
   * has nothing of its own.
   */
  protected working(): boolean {
    return false
  }

  protected setConnection(state: LiveConnection, detail?: string): void {
    this.connection = state
    this.events.emit('event', { type: 'connection', state, ...(detail ? { detail } : {}) })
  }

  /** Passes the model's audio to the renderer and measures the response latency. */
  protected emitAudio(samples: Float32Array): void {
    this.touch()
    if (this.awaitingFirstAudio) {
      this.awaitingFirstAudio = false
      const responseMs = Math.round(this.now() - this.lastUserDeltaAt)
      if (responseMs >= 0) this.events.emit('event', { type: 'latency', responseMs })
    }
    this.events.emit('audio', samples)
  }

  protected emitUsage(usage: LiveUsage): void {
    this.usage = usage
    this.events.emit('event', { type: 'usage', usage })
  }

  /** The turn id of the current exchange, allocated on first use. */
  protected exchange(): number {
    this.exchangeTurnId ??= turnScheduler.allocateTurnId()
    return this.exchangeTurnId
  }

  /**
   * The exchange is handed to a brain turn, so later assistant transcripts are recorded under that turn.
   * Brain started the turn and ends it when its reply is over, which can be after the voice has read the
   * first of its sentences.
   */
  protected adoptTurn(turnId: number): void {
    this.exchangeTurnId = turnId
    this.exchangeStartedBy = 'brain'
  }

  /** Tells the renderer about this exchange's turn before any tool or panel appears. */
  protected ensureTurnStarted(emit: (event: TurnEvent) => void): number {
    const turnId = this.exchange()
    if (this.exchangeStartedBy === null) {
      this.exchangeStartedBy = 'engine'
      emit({ type: 'started', turnId, origin: 'live' })
    }
    return turnId
  }

  /** Ends the exchange, emitting done only for a turn the engine started itself. */
  protected finishExchange(emit: (event: TurnEvent) => void, fullText: string): void {
    if (this.exchangeTurnId !== null && this.exchangeStartedBy === 'engine') {
      emit({ type: 'done', turnId: this.exchangeTurnId, fullText })
    }
    this.exchangeTurnId = null
    this.exchangeStartedBy = null
  }

  protected pushTranscript(role: TranscriptRole, delta: string): void {
    if (role === 'user') {
      this.lastUserDeltaAt = this.now()
      this.awaitingFirstAudio = true
      this.touch()
    }
    this.transcripts.push(role, delta)
  }

  /** A delegation claims the user's utterance in progress for brain, until takeUserUtterance hands it over. */
  protected claimUserUtterance(): void {
    this.userClaimed = true
  }

  /**
   * Hands the claimed utterance to brain. Its line on screen closes under the turn it was shown with,
   * and it is not recorded here, because brain records the utterance it takes over.
   */
  protected takeUserUtterance(): string {
    this.userClaimed = false
    const text = this.transcripts.take('user')
    if (text) this.events.emit('event', { type: 'userTranscript', turnId: this.exchange(), text, final: true })
    return text
  }

  private onTranscriptDelta(role: TranscriptRole, text: string): void {
    const turnId = this.exchange()
    this.events.emit('event', role === 'user' ? { type: 'userTranscript', turnId, text, final: false } : { type: 'assistantTranscript', turnId, text, final: false })
  }

  private onTranscriptFinal(role: TranscriptRole, text: string): void {
    // The input transcript can arrive after the model's reply. A pending user utterance is finalized
    // before the reply is recorded, so that the conversation log keeps the order user then assistant.
    // An utterance a delegation claimed is left for brain, and its exchange stays open for brain's reply.
    if (role === 'assistant' && !this.userClaimed && this.transcripts.pending('user')) this.transcripts.flush('user')
    const turnId = this.exchange()
    if (role === 'user') {
      record({ kind: 'user', turnId, text })
      this.events.emit('event', { type: 'userTranscript', turnId, text, final: true })
      this.onUserUtterance(turnId, text)
      return
    }
    record({ kind: 'assistant', turnId, text })
    this.events.emit('event', { type: 'assistantTranscript', turnId, text, final: true })
    if (!this.userClaimed) this.onAssistantUtterance(turnId, text)
  }

  /** A user utterance is final in an exchange the model handles itself, without brain. It does nothing by default. */
  protected onUserUtterance(_turnId: number, _text: string): void {}

  /** An assistant utterance is final. By default this closes the exchange. */
  protected onAssistantUtterance(_turnId: number, text: string): void {
    this.finishExchange((event) => this.emitTurn(event), text)
  }

  protected abstract emitTurn(event: TurnEvent): void
}
