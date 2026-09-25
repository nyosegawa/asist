import type { AizuchiClip } from './ipc'

/**
 * Picks a clip within a category; which category to play is decided by the classifier in
 * aizuchi-classifier.ts, whose class is the category.
 */

/**
 * Picks a clip at random, weighted. The clip whose text was played last is excluded so the same
 * aizuchi does not come twice in a row, and the random source is injectable for tests.
 */
export function pickWeightedClip(
  clips: readonly AizuchiClip[],
  options: { excludeText?: string; random?: () => number } = {}
): AizuchiClip | null {
  const random = options.random ?? Math.random
  const pool = clips.filter((c) => c.text !== options.excludeText)
  const candidates = pool.length > 0 ? pool : [...clips]
  if (candidates.length === 0) return null
  const total = candidates.reduce((sum, c) => sum + Math.max(0, c.weight), 0)
  if (total <= 0) return candidates[Math.floor(random() * candidates.length)]
  let r = random() * total
  for (const clip of candidates) {
    r -= Math.max(0, clip.weight)
    if (r <= 0) return clip
  }
  return candidates[candidates.length - 1]
}
