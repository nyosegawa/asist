import type { ResponseCreateParamsStreaming, ResponsesClientEvent, ResponseStreamEvent } from 'openai/resources/responses/responses'
import type { ResponsesStreamMessage } from 'openai/resources/responses/internal-base'
import { statusError } from './adapter'
import { streamFailure } from './openai-stream'

/**
 * Responses requests over WebSocket connections that stay open between requests. On the ChatGPT plan's route
 * the first response on a connection waits as long as an HTTP request does, and the later ones much less:
 * the first text arrived after a median of 2190 ms over HTTP and 1567 ms over a connection already used, and
 * 2785 ms against 1065 ms on the lighter model (6 requests each, 2026-10-05). So a connection that finished a
 * response waits for the next one instead of closing. Each carries one response at a time, which needs no
 * stream_id, a field the plan's route is not documented to accept; a second request while one is running
 * opens or takes another connection.
 */

/** The part of the openai package's ResponsesWS used here, which tests replace. */
export interface ResponsesSocket {
  send(event: ResponsesClientEvent): void
  close(): void
  on(event: 'close', listener: () => void): unknown
  [Symbol.asyncIterator](): AsyncIterator<ResponsesStreamMessage>
}

interface Connection {
  token: string
  socket: ResponsesSocket
  events: AsyncIterator<ResponsesStreamMessage>
  closed: boolean
  idleTimer: ReturnType<typeof setTimeout> | null
}

export interface ResponsesSocketPoolOptions {
  /** Opens a connection that authenticates with the access token. */
  open: (token: string) => ResponsesSocket
  /** How long a connection waits for its next response before it closes. */
  idleMs?: number
  /** How many connections may wait at once. */
  maxIdle?: number
  provider: string
}

/**
 * A connection idle longer than this is closed rather than reused, since a router between this computer and
 * OpenAI may have dropped it without either end hearing, and a request sent on it would wait for nothing.
 */
const IDLE_MS = 4 * 60_000
const MAX_IDLE = 2
const TERMINAL = new Set(['response.completed', 'response.failed', 'response.incomplete'])

export class ResponsesSocketPool {
  private readonly idle: Connection[] = []
  constructor(private readonly options: ResponsesSocketPoolOptions) {}

  /**
   * The events of one response. Its connection goes back to the pool once the response ends; one left before
   * then, by an abort or a failure, is closed, which is also what stops the response on OpenAI's side.
   */
  async *events(token: string, params: ResponseCreateParamsStreaming, signal: AbortSignal): AsyncGenerator<ResponseStreamEvent> {
    signal.throwIfAborted()
    const connection = this.take(token)
    // In WebSocket mode the transport says it streams; the body leaves out `stream` and `background`.
    const { stream: _stream, background: _background, ...body } = params
    connection.socket.send({ type: 'response.create', ...body } as ResponsesClientEvent)
    let finished = false
    // Closing the connection ends the read below, which then raises the abort.
    const abort = (): void => this.discard(connection)
    signal.addEventListener('abort', abort, { once: true })
    try {
      for (;;) {
        const { value, done } = await connection.events.next()
        if (done || value.type === 'close') {
          this.discard(connection)
          signal.throwIfAborted()
          throw new Error(`${this.options.provider}: premature close, the connection closed before the response ended`)
        }
        if (value.type === 'error') throw this.failure(value.error)
        if (value.type !== 'message') continue
        // The events of WebSocket mode are those of the HTTP stream with fields of their own added.
        const event = value.message as unknown as ResponseStreamEvent
        if (TERMINAL.has(event.type)) finished = true
        yield event
        if (finished) return
      }
    } finally {
      signal.removeEventListener('abort', abort)
      if (finished) this.release(connection)
      else this.discard(connection)
    }
  }

  /** Closes every waiting connection, as when the app quits. */
  closeAll(): void {
    for (const connection of this.idle.splice(0)) this.close(connection)
  }

  private take(token: string): Connection {
    // A connection that closed, or one of a token renewed since, is not used again.
    for (const stale of this.idle.filter((connection) => connection.closed || connection.token !== token)) this.discard(stale)
    const reused = this.idle.pop()
    if (reused) {
      if (reused.idleTimer) clearTimeout(reused.idleTimer)
      reused.idleTimer = null
      return reused
    }
    const socket = this.options.open(token)
    const connection: Connection = { token, socket, events: socket[Symbol.asyncIterator](), closed: false, idleTimer: null }
    socket.on('close', () => {
      connection.closed = true
      this.discard(connection)
    })
    return connection
  }

  private release(connection: Connection): void {
    if (connection.closed || this.idle.length >= (this.options.maxIdle ?? MAX_IDLE)) {
      this.close(connection)
      return
    }
    connection.idleTimer = setTimeout(() => {
      const at = this.idle.indexOf(connection)
      if (at >= 0) this.idle.splice(at, 1)
      this.close(connection)
    }, this.options.idleMs ?? IDLE_MS)
    this.idle.push(connection)
  }

  private discard(connection: Connection): void {
    const at = this.idle.indexOf(connection)
    if (at >= 0) this.idle.splice(at, 1)
    this.close(connection)
  }

  private close(connection: Connection): void {
    if (connection.idleTimer) clearTimeout(connection.idleTimer)
    connection.idleTimer = null
    if (connection.closed) return
    connection.closed = true
    connection.socket.close()
  }

  /**
   * The failure the openai package reports: an error event of the API, whose code it carries, or a failure of
   * the socket itself, where a refused handshake names the HTTP status in its message.
   */
  private failure(error: Error & { error?: unknown }): Error {
    const apiError = (error.error as { error?: { code?: string | null; message?: string } } | undefined)?.error
    if (apiError) return streamFailure(this.options.provider, apiError.code, apiError.message)
    const handshake = /Unexpected server response: (\d{3})/.exec(error.message)
    if (handshake) return statusError(Number(handshake[1]), `${this.options.provider}: the connection was refused: ${error.message}`, error)
    return new Error(`${this.options.provider}: the connection failed: ${error.message}`, { cause: error })
  }
}
