import type { ResponsesClientEvent } from 'openai/resources/responses/responses'
import type { ResponsesStreamMessage } from 'openai/resources/responses/internal-base'
import type { ResponsesSocket } from '../../src/main/services/llm/responses-socket'

/**
 * A WebSocket of the Responses API in memory. Each `response.create` it is sent is answered by `answer`,
 * whose messages arrive in order; a handshake refusal or a close can be played instead.
 */
export class FakeResponsesSocket implements ResponsesSocket {
  readonly sent: ResponsesClientEvent[] = []
  closed = false
  private readonly queue: ResponsesStreamMessage[] = []
  private readonly waiting: Array<(result: IteratorResult<ResponsesStreamMessage>) => void> = []
  private readonly closeListeners: Array<() => void> = []

  constructor(
    readonly token: string,
    private readonly answer: (event: ResponsesClientEvent, socket: FakeResponsesSocket) => ResponsesStreamMessage[] | void
  ) {}

  send(event: ResponsesClientEvent): void {
    this.sent.push(event)
    for (const message of this.answer(event, this) ?? []) this.push(message)
  }

  push(message: ResponsesStreamMessage): void {
    const next = this.waiting.shift()
    if (next) next({ value: message, done: false })
    else this.queue.push(message)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.push({ type: 'close', code: 1000, reason: '', unsent: [] })
    for (const listener of this.closeListeners) listener()
  }

  on(_event: 'close', listener: () => void): this {
    this.closeListeners.push(listener)
    return this
  }

  [Symbol.asyncIterator](): AsyncIterator<ResponsesStreamMessage> {
    return {
      next: () => {
        const message = this.queue.shift()
        if (message) return Promise.resolve({ value: message, done: false })
        return new Promise((resolve) => this.waiting.push(resolve))
      }
    }
  }
}

/** The messages of a response that writes `text` and completes. */
export function completedResponse(text: string, model = 'gpt-5.6-terra'): ResponsesStreamMessage[] {
  const item = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
  const response = { id: 'resp_1', status: 'completed', model, output: [item], usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 4 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 } } }
  return [
    { type: 'message', message: { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } } },
    { type: 'message', message: { type: 'response.output_text.delta', delta: text, item_id: 'msg_1', output_index: 0, content_index: 0 } },
    { type: 'message', message: { type: 'response.output_item.done', item, output_index: 0 } },
    { type: 'message', message: { type: 'response.completed', response } }
  ] as unknown as ResponsesStreamMessage[]
}
