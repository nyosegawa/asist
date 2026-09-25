import { NOD_LONG_THRESHOLD, NOD_SHORT_THRESHOLD } from './maai-thresholds'

/**
 * Decides when to nod, the silent form of aizuchi, by turning the "nod now" probability of the MaAI
 * nod model into a small movement of the orb. Because it signals listening without adding sound, it
 * may fire more often than a spoken aizuchi, but repeated nods look restless, so they are spaced out.
 */

export type NodKind = 'short' | 'long'

export interface NodInput {
  /** True while the VAD is capturing the user's voice. */
  userSpeaking: boolean
  assistantSpeaking: boolean
  /** The latest estimate of the nod model, or null while it is not ready or its output is stale. */
  nod: { short: number; long: number } | null
  /** Milliseconds since the last nod. */
  msSinceLast: number
}

/** The shortest interval between nods, long enough for the long nod's animation to finish first. */
const MIN_INTERVAL_MS = 1500

export function shouldNod(input: NodInput): NodKind | null {
  if (!input.userSpeaking || input.assistantSpeaking) return null
  if (input.msSinceLast < MIN_INTERVAL_MS) return null
  const nod = input.nod
  if (nod === null) return null
  if (nod.long >= NOD_LONG_THRESHOLD) return 'long'
  if (nod.short >= NOD_SHORT_THRESHOLD) return 'short'
  return null
}
