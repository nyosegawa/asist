import type { AizuchiClip } from '@shared/ipc'
import type { BackchannelKind } from '@shared/listening-aizuchi'
import { categoryOfClassification, type AizuchiClassification } from '@shared/aizuchi-classifier'
import { pickWeightedClip } from '@shared/aizuchi-clips'
import { conversationFeatures, type ConversationLocale } from '@shared/conversation-locale'

/**
 * The renderer's cache of the aizuchi bank. Holding the clips that the main process synthesized in
 * advance is what lets playback start tens of milliseconds after end of speech is detected. A clip
 * is drawn at random with weights from its corpus frequency, and the previous clip is excluded so
 * the same one does not repeat.
 */

let bank: AizuchiClip[] = []
let lastText = ''
let loadGeneration = 0

/**
 * Called at startup, on a speaker change, when the conversation language changes and when TTS
 * recovers. While it fails, no aizuchi plays, and a language without aizuchi keeps the bank empty
 * without asking the main process to build one.
 */
export async function loadAizuchiBank(locale: ConversationLocale): Promise<void> {
  const generation = ++loadGeneration
  bank = []
  lastText = ''
  if (!conversationFeatures(locale).aizuchi) return
  try {
    const clips = await window.api.aizuchiBank()
    if (generation === loadGeneration) bank = clips
  } catch {
    /* Continue without aizuchi. */
  }
}

export interface AizuchiPolicy {
  enabled: boolean
  /** The probability of playing an aizuchi, from 0 to 1. */
  rate: number
}

/**
 * Picks the aizuchi that opens a turn, or nothing. Without a classification nothing plays, and no
 * rule over the text stands in for one; the same holds when the category has no clip.
 */
export function pickAizuchi(classification: AizuchiClassification | null, policy: AizuchiPolicy): AizuchiClip | null {
  if (!policy.enabled || bank.length === 0) return null
  if (Math.random() > policy.rate) return null
  const category = categoryOfClassification(classification)
  if (category === null) return null
  const clip = pickWeightedClip(bank.filter((c) => c.category === category), { excludeText: lastText })
  if (clip) lastText = clip.text
  return clip
}

/** The longest assessment clip, such as "なるほど。" or "確かに。", that plays while the user speaks without talking over them. */
const ASSESSMENT_MAX_CHARS = 6

/**
 * Picks an aizuchi to play while the user is still speaking; only clips that carry audio qualify.
 * A continuer comes from the 'flow' category ("うん", "はい"), an assessment from the short clips of
 * the 'understand' and 'agree' categories ("なるほど", "確かに").
 */
export function pickListeningClip(kind: BackchannelKind = 'continuer'): AizuchiClip | null {
  const candidates = bank.filter(
    (c) =>
      c.audio &&
      (kind === 'assessment'
        ? (c.category === 'understand' || c.category === 'agree') &&
          c.text.length <= ASSESSMENT_MAX_CHARS
        : c.category === 'flow')
  )
  const clip = pickWeightedClip(candidates, { excludeText: lastText })
  if (clip) lastText = clip.text
  return clip
}
