import type { LiveEvent, TurnEvent } from '@shared/ipc'
import type { ConversationRecordInput } from '../brain/conversation-log'
import { TranscriptTracker, type TranscriptRole } from './transcripts'

/**
 * Which turn each stretch of what the user and the voice say belongs to, and the lines it leaves in the
 * conversation log and on screen. The user's side and the voice's side are kept apart: an utterance
 * belongs to the engine's own exchange, which a GPT-Live delegation can hand to brain, while the voice
 * speaks either for that exchange or for the brain turn whose sentences it reads.
 *
 * A stretch of the voice's speech is recorded as soon as its transcript settles, under the owner it had
 * when it began, so a reply read in pieces leaves one record per piece under one turn id, and the
 * history joins them. Only what the voice says while a delegation waits is held back, because the turn
 * it belongs to does not exist until brain starts it.
 */

/** Whom a stretch of the voice's speech belongs to. */
interface SpeechOwner {
  /** own: the engine's own exchange; claim: the utterance a delegation waits to take; brain: a brain turn. */
  kind: 'own' | 'claim' | 'brain'
  /** The turn it is recorded under. For a claim it is the id its line is shown with until brain has a turn. */
  turnId: number
}

export interface LiveExchangesOptions {
  /** How long a transcript stays quiet before it is final. */
  quietMs: number
  allocateTurnId: () => number
  record: (record: ConversationRecordInput) => void
  /** The transcript lines for the renderer. */
  emit: (event: LiveEvent) => void
  emitTurn: (event: TurnEvent) => void
  /** A user utterance the engine handles itself is final. */
  onUserUtterance: (turnId: number, text: string) => void
}

export class LiveExchanges {
  private readonly transcripts: TranscriptTracker
  /** The engine's own exchange: the input it records itself and the reply the voice gives on its own. */
  private ownTurnId: number | null = null
  /** Whether the own exchange's input has been recorded, so that the next input begins another exchange. */
  private ownInputDone = false
  /** The turns whose started event the engine emitted itself, which the voice's next reply of its own ends. */
  private readonly startedTurns = new Set<number>()
  /**
   * The brain turn whose sentences the voice reads. It lasts until a stretch of speech for it settles,
   * so that what the voice says after going quiet answers the user again, unless brain sends another
   * sentence first.
   */
  private speakingFor: number | null = null
  /** The utterance a delegation waits to take, and what the voice said about it meanwhile. */
  private claim: { turnId: number; spoken: string[] } | null = null
  /** The owner of the stretch of the voice's speech now forming, fixed when it began. */
  private pieceOwner: SpeechOwner | null = null

  constructor(private readonly options: LiveExchangesOptions) {
    this.transcripts = new TranscriptTracker({
      quietMs: options.quietMs,
      onDelta: (role, text) => this.onDelta(role, text),
      onFinal: (role, text) => this.onFinal(role, text)
    })
  }

  /** The transcript collected so far, which is not final yet. */
  pending(role: TranscriptRole): string {
    return this.transcripts.pending(role)
  }

  push(role: TranscriptRole, delta: string): void {
    // A new utterance after the input of the own exchange was recorded begins the next exchange. The
    // turns the engine started go on until the voice replies.
    if (role === 'user' && delta && !this.transcripts.pending('user') && this.ownInputDone) this.startOwnExchange()
    this.transcripts.push(role, delta)
  }

  /** Finalizes at once on an end-of-utterance signal. */
  flush(role: TranscriptRole): void {
    this.transcripts.flush(role)
  }

  /**
   * Typed input, which is an input of its own: an utterance still forming is recorded first, and the
   * text begins an exchange. Its line is already on screen.
   */
  typedInput(text: string): number {
    this.transcripts.flush('user')
    if (this.ownInputDone) this.startOwnExchange()
    const turnId = this.ownTurn()
    this.options.record({ kind: 'user', turnId, text })
    this.inputRecorded()
    return turnId
  }

  /** The turn a call of the model's belongs to, which is told to the renderer before any tool or panel of it appears. */
  toolTurn(): number {
    const turnId = this.ownTurn()
    if (!this.startedTurns.has(turnId)) {
      this.startedTurns.add(turnId)
      this.options.emitTurn({ type: 'started', turnId, origin: 'live' })
    }
    return turnId
  }

  /**
   * A delegation claims the user's utterance in progress for brain. What the voice says until brain has
   * the turn is its answer to that utterance, a stretch already forming in the same exchange included.
   */
  claimUtterance(): void {
    if (this.ownInputDone) this.startOwnExchange()
    this.speakingFor = null
    const turnId = this.ownTurn()
    this.claim = { turnId, spoken: [] }
    if (this.pieceOwner?.kind === 'own' && this.pieceOwner.turnId === turnId) this.pieceOwner = { kind: 'claim', turnId }
  }

  /**
   * Takes the claimed utterance for brain, which records it. Its line and the voice's line about it
   * close on screen under the id they were shown with, and the next utterance begins another exchange.
   */
  takeUtterance(): string {
    const claim = this.claim
    if (!claim) throw new Error('no utterance is claimed')
    if (this.pieceOwner?.kind === 'claim') this.transcripts.flush('assistant')
    const text = this.transcripts.take('user')
    if (text) this.options.emit({ type: 'userTranscript', turnId: claim.turnId, text, final: true })
    this.startOwnExchange()
    return text
  }

  /**
   * Brain's turn has the utterance: what the voice said about it goes there, and so does what it says
   * next, unless a turn still running handed the voice a sentence during the wait, which the voice reads
   * first.
   */
  handOver(turnId: number): void {
    const spoken = this.claim?.spoken ?? []
    this.claim = null
    for (const text of spoken) this.options.record({ kind: 'assistant', turnId, text })
    this.speakingFor ??= turnId
  }

  /** The voice is handed a sentence of a brain turn, and what it says next belongs to that turn. */
  speakFor(turnId: number): void {
    this.speakingFor = turnId
  }

  /**
   * The engine stops. A delegation hands nothing to brain then, so the utterance it claimed is recorded
   * as it was heard, with what the voice said about it, and the turns the engine started end.
   */
  end(): void {
    if (this.pieceOwner?.kind === 'claim') this.transcripts.flush('assistant')
    const claim = this.claim
    this.claim = null
    this.transcripts.flush('user')
    if (claim) for (const text of claim.spoken) this.options.record({ kind: 'assistant', turnId: claim.turnId, text })
    this.transcripts.flush('assistant')
    this.endStartedTurns('')
    this.startOwnExchange()
    this.speakingFor = null
    this.transcripts.dispose()
  }

  private ownTurn(): number {
    this.ownTurnId ??= this.options.allocateTurnId()
    return this.ownTurnId
  }

  private startOwnExchange(): void {
    this.ownTurnId = null
    this.ownInputDone = false
  }

  /** The input of the own exchange is recorded, and what the voice says next answers it. */
  private inputRecorded(): void {
    this.ownInputDone = true
    this.speakingFor = null
  }

  private owner(): SpeechOwner {
    if (this.speakingFor !== null) return { kind: 'brain', turnId: this.speakingFor }
    if (this.claim) return { kind: 'claim', turnId: this.claim.turnId }
    return { kind: 'own', turnId: this.ownTurn() }
  }

  private endStartedTurns(fullText: string): void {
    for (const turnId of this.startedTurns) this.options.emitTurn({ type: 'done', turnId, fullText })
    this.startedTurns.clear()
  }

  private onDelta(role: TranscriptRole, text: string): void {
    if (role === 'user') {
      this.options.emit({ type: 'userTranscript', turnId: this.ownTurn(), text, final: false })
      return
    }
    this.pieceOwner ??= this.owner()
    this.options.emit({ type: 'assistantTranscript', turnId: this.pieceOwner.turnId, text, final: false })
  }

  private onFinal(role: TranscriptRole, text: string): void {
    if (role === 'user') {
      const turnId = this.ownTurn()
      this.options.record({ kind: 'user', turnId, text })
      this.inputRecorded()
      this.options.emit({ type: 'userTranscript', turnId, text, final: true })
      this.options.onUserUtterance(turnId, text)
      return
    }
    const owner = this.pieceOwner ?? this.owner()
    this.pieceOwner = null
    // The input transcript can arrive after the voice's own reply to it, and is recorded first so that
    // the log keeps the user's line before the reply.
    if (owner.kind === 'own' && owner.turnId === this.ownTurnId && this.transcripts.pending('user')) this.transcripts.flush('user')
    this.options.emit({ type: 'assistantTranscript', turnId: owner.turnId, text, final: true })
    if (owner.kind === 'claim' && this.claim?.turnId === owner.turnId) {
      this.claim.spoken.push(text)
      return
    }
    this.options.record({ kind: 'assistant', turnId: owner.turnId, text })
    if (owner.kind === 'brain') {
      if (this.speakingFor === owner.turnId) this.speakingFor = null
      return
    }
    // The voice's own reply ends its exchange and the turns the engine started.
    if (owner.turnId === this.ownTurnId) this.startOwnExchange()
    this.endStartedTurns(text)
  }
}
