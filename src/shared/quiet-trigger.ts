/**
 * Decides whether the conversation is quiet enough for background work that touches the conversation
 * itself, which is compaction.
 */

export interface QuietConditions {
  /**
   * How long since the last conversation, meaning the last append to the log. The usual value is five
   * minutes, matching the TTL of the prompt cache.
   */
  quietMs: number
}

export interface QuietState {
  now: number
  /** The time of the last conversation, or null when there has been none, as right after a start. */
  lastActivityAt: number | null
  turnActive: boolean
}

export function isQuiet(state: QuietState, conditions: QuietConditions): boolean {
  if (state.turnActive) return false
  return state.lastActivityAt === null || state.now - state.lastActivityAt >= conditions.quietMs
}
