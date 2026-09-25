import { searchTokens } from './memory-search'

/**
 * Detects self-echo: the assistant's own speech coming back through the microphone, getting
 * transcribed, and making the assistant reply to itself. This is the last line of defense for the
 * cases that get past echo cancellation and the VAD threshold boost.
 */

export function normalizeForEcho(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()
}

/**
 * Whether the utterance is an echo of a recent assistant reply. Besides full containment it accepts a
 * token overlap of 85%, because ASR output varies between passes. The tokens are the ones memory search
 * cuts, so a language written with spaces is compared word by word instead of across its word edges.
 * Very short utterances, such as an aizuchi, are never treated as an echo: the risk of a false positive
 * is too high.
 */
export function isSelfEcho(utterance: string, recentAssistantTexts: readonly string[]): boolean {
  const u = normalizeForEcho(utterance)
  if (u.length < 4) return false
  // The replies are read as one text because an echo can start in one reply and end in the next. The space
  // between them keeps the last word of one reply from being read as one word with the first of the next,
  // and it changes nothing in Japanese: normalizeForEcho drops it and a bigram is cut across it.
  const joined = recentAssistantTexts.join(' ')
  const r = normalizeForEcho(joined)
  if (r.length === 0) return false
  if (r.includes(u)) return true
  const ut = new Set(searchTokens(utterance))
  if (ut.size === 0) return false
  const rt = new Set(searchTokens(joined))
  let hit = 0
  for (const token of ut) if (rt.has(token)) hit++
  return hit / ut.size >= 0.85
}

const EDGE_PUNCT = '[\\s\\p{P}]*'
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Removes an aizuchi clip such as "はい。" or "うん" that was played over the speaker while the
 * utterance was being captured and ended up at an edge of the transcription. isSelfEcho ignores short
 * texts to avoid false positives, so short aizuchi are handled here instead, and the caller is
 * responsible for calling this only when the clip's playback time overlaps the capture window.
 *
 * - Only a clip matched at the start or the end is stripped. A match inside the sentence is left
 *   alone, so that an utterance such as "はいって返事して" survives intact.
 * - An empty result means the whole utterance was an echo, and the caller discards it.
 */
export function stripClipEcho(utterance: string, clipTexts: readonly string[]): string {
  const cands = [...new Set(clipTexts.map(normalizeForEcho).filter((t) => t.length > 0))].sort(
    (a, b) => b.length - a.length
  )
  if (cands.length === 0) return utterance
  const alt = cands.map(escapeRegex).join('|')
  // The candidates are lowercased while the utterance is not, and a transcript capitalizes its first word.
  const lead = new RegExp(`^(?:${EDGE_PUNCT}(?:${alt})${EDGE_PUNCT})+`, 'iu')
  const tail = new RegExp(`(?:${EDGE_PUNCT}(?:${alt})${EDGE_PUNCT})+$`, 'iu')
  return utterance.replace(lead, '').replace(tail, '').trim()
}
