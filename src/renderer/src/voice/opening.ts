import type { BridgeClip, AizuchiClip, BridgePlan, ClipRole, SpeechSegment, TurnTimings } from '@shared/ipc'
import type { AizuchiClassification } from '@shared/aizuchi-classifier'

/**
 * Opens a turn with an aizuchi and a bridging phrase. Playback starts the moment the VAD decides
 * speech has ended, and once the final transcript arrives the words already spoken are handed to
 * brain. Waiting for the final transcript would delay the aizuchi by the ASR time, measured at a
 * p50 of about 0.4 s, so the kind of aizuchi comes from the classifier's AizuchiClassification over
 * the partial transcripts instead.
 *
 * The bridge synthesizes the phrase that the BridgePlan looked ahead for, such as "会議の件ですね。",
 * and plays it after the aizuchi and before the answer. Whether an utterance may have one at all is
 * the caller's to decide. brain is told of a bridge only when it will play, because it starts its
 * answer as the continuation of that line. If the answer's own text got queued first, the bridge
 * does not play and the outcome is recorded in the measurements.
 *
 * An utterance is identified by startedAt, the time capture began. A speech that yields no turn,
 * because its transcription failed, meant nothing or was dropped as echo, cancels it. An opening
 * lasts until a newer utterance becomes a turn, which replaces the older turn and its bridge.
 * A bridge never starts over the user: while a newer capture is open, or its speech waits for the
 * transcript, the bridge waits, and it plays once that capture comes to nothing, which it often
 * does, being noise or the echo of the opening aizuchi. A bridge promises that an answer follows,
 * so one that has not started sounding is withdrawn when no answer will: the speech is cancelled,
 * or its turn ends without saying anything.
 */

/** No aizuchi opens a turn this soon after one played while the user was speaking, because "うん。なるほど。" back to back sounds wrong. */
const LISTENING_OVERLAP_MS = 2500

export interface OpeningInput {
  startedAt: number
  speechEndAt: number
  /** The classification available when speech ended; nothing waits for a newer one. Without it no aizuchi plays. */
  classification: AizuchiClassification | null
  /** The bridge this utterance may have, or null when it may have none. */
  bridge: OpeningBridge | null
  /** Milliseconds since the last aizuchi that played while the user was speaking. */
  sinceListeningMs: number
}

export interface OpeningBridge {
  /** The look-ahead, waited out to the end of the request in flight. The phrase comes from it, and only has to play before the answer. */
  plan: Promise<BridgePlan | null>
  /**
   * The aizuchi classification has already found the utterance to be one that takes a bridge, so a
   * phrase still unsettled when the final transcript arrives is told to brain as coming and plays once
   * it settles. Without that finding the look-ahead's answer can still rule the bridge out, so a phrase
   * unsettled by then is neither told nor played.
   */
  screened: boolean
}

export interface OpeningPorts {
  /** Picks the aizuchi for this classification, or nothing. */
  pickAizuchi(classification: AizuchiClassification | null): AizuchiClip | null
  /** Queues the clip and returns what was queued, by which its start is recognized and a bridge withdrawn. */
  play(clip: { audio: string | null; text: string }, role: ClipRole): SpeechSegment
  /** Synthesizes the bridge phrase. */
  synthesizeBridge(text: string): Promise<BridgeClip>
  /** Whether the answer's own text was queued for playback after this time, which makes the bridge late. */
  bodyQueuedAfter(speechEndAt: number): boolean
  /** Records a measurement of an utterance's opening: when one of its clips started sounding, or why its bridge did not. */
  measure(startedAt: number, timings: TurnTimings): void
  /** Drops this bridge if it has not started yet, and tells whether it had not. */
  withdrawBridge(queued: SpeechSegment): boolean
}

interface Opening {
  startedAt: number
  speechEndAt: number
  aizuchi: AizuchiClip | null
  /** The aizuchi as it was handed to play. */
  queuedAizuchi: SpeechSegment | null
  /**
   * It is pending while the look-ahead runs, and decided once the phrase is settled, which may be
   * null: from the start for an utterance that may have no bridge, and at the claim for an unscreened
   * one still pending then.
   */
  bridge: { state: 'pending'; screened: boolean } | { state: 'decided'; text: string | null }
  /** The synthesized bridge, kept until it may sound. */
  synthesized: BridgeClip | null
  /** The bridge as it was handed to play. */
  queuedBridge: SpeechSegment | null
  /** The final transcript has claimed it for its turn. */
  claimed: boolean
}

export interface ClaimedOpening {
  aizuchi: string | null
  bridge: string | null
  /** A bridge may still play and its phrase is not settled yet. brain is told that a short opening phrase is still coming. */
  bridgePending: boolean
}

export class TurnOpening {
  /** The openings in the order their speech ended. Only the newest may sound its bridge. */
  private openings: Opening[] = []
  /** A capture is open that began after the newest speech end. */
  private captureOpen = false

  constructor(private readonly ports: OpeningPorts) {}

  begin(input: OpeningInput): void {
    const aizuchi =
      input.sinceListeningMs < LISTENING_OVERLAP_MS ? null : this.ports.pickAizuchi(input.classification)
    const opening: Opening = {
      startedAt: input.startedAt,
      speechEndAt: input.speechEndAt,
      aizuchi,
      queuedAizuchi: null,
      bridge: input.bridge ? { state: 'pending', screened: input.bridge.screened } : { state: 'decided', text: null },
      synthesized: null,
      queuedBridge: null,
      claimed: false
    }
    this.openings.push(opening)
    // The capture this speech ends is the utterance's own.
    this.captureOpen = false
    if (aizuchi) opening.queuedAizuchi = this.ports.play(aizuchi, 'aizuchi')
    void input.bridge?.plan.then((plan) => {
      if (!this.alive(opening) || opening.bridge.state !== 'pending') return
      const text = plan?.bridge || null
      opening.bridge = { state: 'decided', text }
      if (text) this.requestBridge(opening, text)
    })
  }

  /** Whether this opening still leads into a turn that may come or is under way. */
  private alive(opening: Opening): boolean {
    return this.openings.includes(opening)
  }

  private requestBridge(opening: Opening, text: string): void {
    this.ports.synthesizeBridge(text).then(
      (bridge) => {
        if (!this.alive(opening)) return
        opening.synthesized = bridge
        this.release()
      },
      (error: unknown) => {
        console.error('aizuchi bridge failed:', error)
        if (this.alive(opening)) this.ports.measure(opening.startedAt, { bridge: 'failed' })
      }
    )
  }

  /** Queues the bridge of the newest opening once no newer capture is being heard. */
  private release(): void {
    const opening = this.openings.at(-1)
    if (!opening?.synthesized || opening.queuedBridge || this.captureOpen) return
    if (this.ports.bodyQueuedAfter(opening.speechEndAt)) {
      opening.synthesized = null
      this.ports.measure(opening.startedAt, { bridge: 'late' })
      return
    }
    opening.queuedBridge = this.ports.play(opening.synthesized, 'bridge')
  }

  /** A capture opened. A bridge that has not started yet waits, since it would sound over the user. */
  captureStarted(): void {
    this.captureOpen = true
    for (const opening of this.openings) {
      if (opening.queuedBridge && this.ports.withdrawBridge(opening.queuedBridge)) opening.queuedBridge = null
    }
  }

  /** A capture closed. When it ended in no speech, the bridge it held back plays. */
  captureEnded(): void {
    if (!this.captureOpen) return
    this.captureOpen = false
    this.release()
  }

  /**
   * Called when a clip actually starts playing, and records the time since its utterance's speech
   * ended and the clip's length. An aizuchi played while the user was speaking belongs to no opening.
   */
  clipStarted(segment: SpeechSegment, durationMs: number, now: number): void {
    const opening = this.openings.find((o) => o.queuedAizuchi === segment || o.queuedBridge === segment)
    if (!opening) return
    const sinceEnd = Math.max(0, Math.round(now - opening.speechEndAt))
    const clipMs = Math.round(durationMs)
    this.ports.measure(
      opening.startedAt,
      segment === opening.queuedAizuchi
        ? { aizuchiMs: sinceEnd, aizuchiClipMs: clipMs }
        : { bridgeMs: sinceEnd, bridgeClipMs: clipMs, bridge: 'played' }
    )
  }

  /**
   * Claims the opening of the utterance whose final transcript arrived and returns the aizuchi and
   * bridge wording for brain. A bridge that has not played yet is still handed over, on the
   * assumption that it plays before the answer; how often it did not is tracked as bridge=late. An
   * unscreened bridge whose phrase is not settled yet is given up here. The openings of older
   * utterances end with it, as this turn replaces theirs.
   */
  claim(startedAt: number): ClaimedOpening | null {
    const index = this.openings.findIndex((o) => o.startedAt === startedAt && !o.claimed)
    if (index < 0) return null
    for (const older of this.openings.slice(0, index)) this.withdrawBridge(older)
    this.openings = this.openings.slice(index)
    const opening = this.openings[0]
    opening.claimed = true
    if (opening.bridge.state === 'pending' && !opening.bridge.screened) opening.bridge = { state: 'decided', text: null }
    return {
      aizuchi: opening.aizuchi?.text ?? null,
      bridge: opening.bridge.state === 'decided' ? opening.bridge.text : null,
      bridgePending: opening.bridge.state === 'pending'
    }
  }

  /** Called when the speech yields no turn. Its aizuchi has already been heard, and an older bridge it held back may play. */
  cancel(startedAt: number): void {
    const opening = this.openings.find((o) => o.startedAt === startedAt && !o.claimed)
    if (!opening) return
    this.withdrawBridge(opening)
    this.openings = this.openings.filter((o) => o !== opening)
    this.release()
  }

  /**
   * Called when the turn an opening was claimed for ends without saying anything, or is replaced by
   * typed input, which leaves its bridge nothing to lead into.
   */
  withdraw(): void {
    for (const opening of this.openings) if (opening.claimed) this.withdrawBridge(opening)
    this.openings = this.openings.filter((o) => !o.claimed)
  }

  private withdrawBridge(opening: Opening): void {
    if (opening.queuedBridge) this.ports.withdrawBridge(opening.queuedBridge)
  }

  /** The user talked over the turn, so nothing more of any opening plays. */
  interrupt(): void {
    this.openings = []
  }
}
