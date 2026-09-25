import type { BackchannelKind, BackchannelSource, ListeningAizuchi } from './ipc'
import {
  BC_EMO_THRESHOLD,
  BC_REACT_THRESHOLD,
  BC_REACT_WITH_TEXT_THRESHOLD,
  VAP_EOT_CONFIRM
} from './maai-thresholds'

export type { BackchannelKind, BackchannelSource }

/**
 * Decides when to play a listening aizuchi, a quiet "うん" while the user is still speaking. In
 * corpora of real conversation a listener answers at every clause boundary of the speaker's sentence.
 * A false one cuts the speaker off, so every condition here is joined with AND and stays conservative.
 *
 * The clause boundaries, the pause window and the frequency ceiling are all measured on Japanese, so
 * VoiceController asks this only while the conversation is held in Japanese.
 */

/** Clause boundaries: conjunctive and sentence-final forms that promise the sentence continues, where an aizuchi sounds natural. */
const CLAUSE_END =
  /(ので|んで|けど|けれど|が|から|して|してて|していて|てて|でて|でして|まして|とか|ですね|んですよ|ですが|なんですけど)[、。]?$/

export interface BackchannelInput {
  /** The user is speaking, that is the VAD is capturing. */
  userSpeaking: boolean
  /** The assistant is speaking, and nothing is played then. */
  assistantSpeaking: boolean
  /** How long the current silence has lasted, in milliseconds. An aizuchi lands within the mid-sentence pause window. */
  silenceMs: number
  /** How long the utterance has lasted, in milliseconds. A short utterance gets nothing. */
  utteranceMs: number
  /** The partial transcript, which is what the clause boundary is read from. */
  partialText: string
  /** Milliseconds since the previous listening aizuchi. */
  msSinceLast: number
  /**
   * The latest MaAI estimate, null while it is not ready or has gone stale. `bcReact` and `bcEmo` are
   * the probabilities that an aizuchi belongs here, from the backchannel model bc_2type, and
   * `eotUser` is the end-of-turn probability from the turn-taking model.
   */
  vap?: { eotUser: number; bcReact: number; bcEmo: number } | null
}

export interface BackchannelDecision {
  kind: BackchannelKind
  source: BackchannelSource
}

/** The mid-sentence pause window: below it the user is still talking, above it the hangover that decides the end of the utterance takes over. */
const PAUSE_MIN_MS = 250
const PAUSE_MAX_MS = 550
/** Only a longer utterance gets a listening aizuchi; for a short one the aizuchi of the real answer is enough. */
const MIN_UTTERANCE_MS = 2500
/** The frequency ceiling, a conservative value taken from the intervals between clause boundaries measured in the corpus. */
const MIN_INTERVAL_MS = 5000
/** Past this many characters the user has been talking long enough for an aizuchi even without a clause-boundary form. */
const LONG_PARTIAL_CHARS = 40

/** The clause boundary as the text alone shows it. */
function clauseBoundary(partialText: string): boolean {
  const text = partialText.trim()
  if (text.length === 0) return false
  return CLAUSE_END.test(text) || text.length >= LONG_PARTIAL_CHARS
}

/**
 * The backchannel model's thresholds in maai-thresholds come from a replication with vap-test. Just
 * before a real aizuchi point the model is weak: AUC 0.70 for react and 0.73 for emo. When the model
 * is available, model and text decide together: a high model score alone is enough, and a somewhat
 * lower score is enough when the text is at a clause boundary. The text alone is never enough,
 * because firing on a boundary form while the model score is low produced many aizuchi that landed in
 * the middle of a sentence. Once EoT reaches the early-confirm level VAP_EOT_CONFIRM the utterance is
 * ending, so the aizuchi gives way.
 */
export function shouldBackchannel(input: BackchannelInput): BackchannelDecision | null {
  if (!input.userSpeaking || input.assistantSpeaking) return null
  if (input.silenceMs < PAUSE_MIN_MS || input.silenceMs > PAUSE_MAX_MS) return null
  if (input.utteranceMs < MIN_UTTERANCE_MS) return null
  if (input.msSinceLast < MIN_INTERVAL_MS) return null
  const boundary = clauseBoundary(input.partialText)
  const vap = input.vap ?? null
  if (vap === null) return boundary ? { kind: 'continuer', source: 'text' } : null
  if (vap.eotUser >= VAP_EOT_CONFIRM) return null
  if (vap.bcEmo >= BC_EMO_THRESHOLD) return { kind: 'assessment', source: 'model' }
  if (vap.bcReact >= BC_REACT_THRESHOLD) return { kind: 'continuer', source: 'model' }
  if (boundary && vap.bcReact >= BC_REACT_WITH_TEXT_THRESHOLD) {
    return { kind: 'continuer', source: 'both' }
  }
  return null
}

/**
 * The listening aizuchi of one utterance. If the user speaks again after one was played it counts as
 * continued, which means it landed in a mid-sentence pause; if the utterance ends instead, it missed.
 * The hit rate goes into metrics and is what the thresholds are tuned against.
 */
export class ListeningRecorder {
  private records: ListeningAizuchi[] = []

  /** Called when capture starts. */
  reset(): void {
    this.records = []
  }

  fired(decision: BackchannelDecision, atMs: number): void {
    this.records.push({ ...decision, atMs: Math.max(0, Math.round(atMs)), continued: false })
  }

  /** Called on a voiced frame from the user, which marks the pending records as continued. */
  voiced(): void {
    for (const record of this.records) record.continued = true
  }

  /** Called when capture ends, and it hands the records over, an empty array when there were none. */
  take(): ListeningAizuchi[] {
    const records = this.records
    this.records = []
    return records
  }
}
