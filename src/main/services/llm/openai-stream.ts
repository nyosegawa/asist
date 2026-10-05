import { APIError } from 'openai'
import { CHATGPT_NOT_ELIGIBLE, CHATGPT_USAGE_LIMIT } from '@shared/chatgpt'
import { statusError } from './adapter'

/** The failures of a stream read through the openai package, which the OpenAI and the Cerebras adapters both use. */

/** The status a request refused for the same reason answers with, by the code a stream reports. */
const STATUS_OF_CODE: Readonly<Record<string, number>> = {
  rate_limit_exceeded: 429,
  server_error: 500,
  [CHATGPT_USAGE_LIMIT]: 429,
  [CHATGPT_NOT_ELIGIBLE]: 403,
  subscription_sharing_usage_unavailable: 503,
  subscription_sharing_user_unavailable: 503
}

/**
 * A failure the server reports inside a stream carries a code, or only a type, but no HTTP status, so it
 * is given the status a request failing the same way would get, which is what tells a transient failure
 * apart. The code stays on the error, since a limit of the ChatGPT plan answers 429 like a rate limit but
 * does not lift on a retry.
 */
export function streamFailure(provider: string, reason: string | null | undefined, message: string | undefined): Error {
  const status = (reason && STATUS_OF_CODE[reason]) || 400
  return Object.assign(statusError(status, `${provider}: ${reason ?? 'failed'}: ${message ?? 'the response failed'}`), { code: reason ?? undefined })
}

/**
 * The events of a stream. The openai package raises an error the server sends inside the stream, as an
 * `error` event or as a chunk carrying `error`, itself as an APIError without a status before the reader
 * sees it (openai/core/streaming.js), so it becomes a failure with a status here.
 */
export async function* streamEvents<Event>(provider: string, stream: AsyncIterable<Event>): AsyncGenerator<Event> {
  try {
    yield* stream
  } catch (error) {
    if (error instanceof APIError && error.status === undefined && error.error !== undefined) {
      throw streamFailure(provider, error.code ?? error.type, error.message)
    }
    throw error
  }
}
