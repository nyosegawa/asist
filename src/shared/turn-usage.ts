import type { RoundUsage, TurnTimings } from './ipc'

/**
 * Aggregates the per-round usage of a turn into the shape of the turn metrics. Besides the totals it
 * keeps the input sum of the last round, that is input plus cache_read plus cache_creation, as the
 * context length actually sent during the turn.
 */

export function summarizeTurnUsage(
  rounds: readonly RoundUsage[]
): Pick<
  TurnTimings,
  'inputTokens' | 'cacheReadTokens' | 'cacheCreationTokens' | 'outputTokens' | 'contextTokens' | 'rounds'
> {
  const total = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 }
  for (const round of rounds) {
    total.input += round.input
    total.cacheRead += round.cacheRead
    total.cacheCreation += round.cacheCreation
    total.output += round.output
  }
  const last = rounds[rounds.length - 1]
  return {
    inputTokens: total.input,
    cacheReadTokens: total.cacheRead,
    cacheCreationTokens: total.cacheCreation,
    outputTokens: total.output,
    contextTokens: last ? last.input + last.cacheRead + last.cacheCreation : 0,
    rounds: rounds.length
  }
}

/** The cache hit rate, or null when there was no input at all. */
export function cacheHitRate(usage: {
  inputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}): number | null {
  const input = usage.inputTokens ?? 0
  const read = usage.cacheReadTokens ?? 0
  const creation = usage.cacheCreationTokens ?? 0
  const total = input + read + creation
  return total > 0 ? read / total : null
}
