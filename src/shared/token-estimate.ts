/**
 * Approximates the token count as the UTF-8 byte length divided by 4, for text that has not been sent
 * yet and therefore has no usage reported by the server. It favors a stable estimate that thresholds
 * can be compared against over accuracy.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4)
}
