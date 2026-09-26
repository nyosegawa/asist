import { errorText } from '@shared/i18n/error-text'

/**
 * The codes Node's fetch puts on the cause of its "fetch failed" when no connection could be made or it
 * was cut: the name did not resolve, nothing answered, or the network is down. Only for these is checking
 * the network worth saying; another cause, such as a certificate the system does not trust, is not one
 * the network settings fix.
 */
const CONNECTION_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETDOWN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET'
])

/**
 * The error of a fetch for a card that failed before any answer came, worded for the screen. Node's fetch
 * rejects every such failure with a TypeError that says only "fetch failed" and keeps the reason on its
 * cause, which the log keeps instead. Any other error, such as the abort of the caller or of a time limit,
 * is returned as it is, because the card words a time limit itself.
 */
export function fetchFailure(url: string, error: unknown): unknown {
  if (!(error instanceof TypeError) || error.cause === undefined) return error
  const host = new URL(url).hostname
  console.warn(`fetch from ${host} failed:`, error)
  const code = (error.cause as { code?: unknown }).code
  const key = typeof code === 'string' && CONNECTION_CODES.has(code) ? 'panels.errors.unreachable' : 'panels.errors.connectFailed'
  return new Error(errorText(key, { host }), { cause: error })
}
