import { describe, expect, it } from 'vitest'
import type { ResponseCreateParamsStreaming, ResponseStreamEvent } from 'openai/resources/responses/responses'
import type { ResponsesStreamMessage } from 'openai/resources/responses/internal-base'
import { isTransientApiError } from '../src/shared/api-errors'
import { CHATGPT_USAGE_LIMIT } from '../src/shared/chatgpt'
import { ResponsesSocketPool } from '../src/main/services/llm/responses-socket'
import { FakeResponsesSocket, completedResponse } from './helpers/responses-socket'

/**
 * Responses over WebSocket connections that wait for the next request: one finished response leaves its
 * connection for the next, a second request while one runs takes another, and a connection a request left
 * before its end is closed, which is also what stops the response at OpenAI.
 */

const PARAMS = { model: 'gpt-5.6-terra', input: [{ role: 'user', content: 'hi' }], store: false, stream: true } as ResponseCreateParamsStreaming

function pool(answer: (socket: FakeResponsesSocket) => ResponsesStreamMessage[] | void = () => completedResponse('hello')) {
  const opened: FakeResponsesSocket[] = []
  const sockets = new ResponsesSocketPool({
    provider: 'ChatGPT',
    open: (token) => {
      const socket = new FakeResponsesSocket(token, (_event, self) => answer(self))
      opened.push(socket)
      return socket
    }
  })
  return { sockets, opened }
}

async function read(events: AsyncIterable<ResponseStreamEvent>): Promise<string[]> {
  const types: string[] = []
  for await (const event of events) types.push(event.type)
  return types
}

describe('Responses over WebSocket', () => {
  it('sends the body without the fields of the HTTP transport and reads the response through its end', async () => {
    const { sockets, opened } = pool()
    const types = await read(sockets.events('token-1', { ...PARAMS, background: false }, new AbortController().signal))
    expect(types).toEqual(['response.created', 'response.output_text.delta', 'response.output_item.done', 'response.completed'])
    expect(opened[0].sent).toEqual([{ type: 'response.create', model: 'gpt-5.6-terra', input: PARAMS.input, store: false }])
  })

  it('sends the next request on the connection the last one finished on', async () => {
    const { sockets, opened } = pool()
    await read(sockets.events('token-1', PARAMS, new AbortController().signal))
    await read(sockets.events('token-1', PARAMS, new AbortController().signal))
    expect(opened).toHaveLength(1)
    expect(opened[0].sent).toHaveLength(2)
    expect(opened[0].closed).toBe(false)
  })

  it('opens another connection for a request made while one is running', async () => {
    let held: FakeResponsesSocket | null = null
    const { sockets, opened } = pool((socket) => {
      if (held === null) {
        held = socket
        return []
      }
      return completedResponse('second')
    })
    const first = sockets.events('token-1', PARAMS, new AbortController().signal)
    const firstRead = first.next()
    expect(await read(sockets.events('token-1', PARAMS, new AbortController().signal))).toContain('response.completed')
    expect(opened).toHaveLength(2)
    for (const message of completedResponse('first')) held!.push(message)
    expect((await firstRead).value?.type).toBe('response.created')
  })

  it('does not send a request with a renewed token on a connection opened with the old one', async () => {
    const { sockets, opened } = pool()
    await read(sockets.events('token-1', PARAMS, new AbortController().signal))
    await read(sockets.events('token-2', PARAMS, new AbortController().signal))
    expect(opened.map((socket) => socket.token)).toEqual(['token-1', 'token-2'])
    expect(opened[0].closed).toBe(true)
  })

  it('closes the connection of an aborted request and raises the abort', async () => {
    const { sockets, opened } = pool((socket) => (socket === opened[0] ? [] : completedResponse('next')))
    const controller = new AbortController()
    const reading = read(sockets.events('token-1', PARAMS, controller.signal))
    await Promise.resolve()
    controller.abort(new DOMException('stopped', 'AbortError'))
    await expect(reading).rejects.toThrow('stopped')
    expect(opened[0].closed).toBe(true)
    expect(await read(sockets.events('token-1', PARAMS, new AbortController().signal))).toContain('response.completed')
    expect(opened).toHaveLength(2)
  })

  it('reports an error event of the API with its code and the status the same refusal answers over HTTP', async () => {
    const { sockets, opened } = pool(() => [
      { type: 'error', error: Object.assign(new Error('limit'), { error: { type: 'error', error: { code: CHATGPT_USAGE_LIMIT, message: 'limit' } } }) }
    ] as unknown as ResponsesStreamMessage[])
    const error = await read(sockets.events('token-1', PARAMS, new AbortController().signal)).catch((caught: unknown) => caught as Error & { status?: number; code?: string })
    expect([error.status, error.code]).toEqual([429, CHATGPT_USAGE_LIMIT])
    expect(isTransientApiError(error)).toBe(false)
    expect(opened[0].closed).toBe(true)
  })

  it('reports a refused handshake with its HTTP status', async () => {
    const { sockets } = pool(() => [{ type: 'error', error: new Error('Unexpected server response: 401') }] as unknown as ResponsesStreamMessage[])
    const error = await read(sockets.events('token-1', PARAMS, new AbortController().signal)).catch((caught: unknown) => caught as Error & { status?: number })
    expect(error.status).toBe(401)
  })

  it('reports a connection that closed before the response ended as a dropped connection, which is worth a retry', async () => {
    const { sockets } = pool((socket) => {
      queueMicrotask(() => socket.close())
      return completedResponse('cut').slice(0, 2)
    })
    const error = await read(sockets.events('token-1', PARAMS, new AbortController().signal)).catch((caught: unknown) => caught)
    expect(isTransientApiError(error)).toBe(true)
  })
})
