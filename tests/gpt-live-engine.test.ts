import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as LiveAPI from 'openai/resources/live/live'
import type { LiveEvent, TurnEvent } from '@shared/ipc'
import { LIVE_ENGINE_INFO } from '@shared/voice-engine'

/** These tests drive the GPT-Live engine end to end against a fake socket. */

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  nextTurnId: 100
}))

vi.mock('../src/main/services/brain/session', () => ({
  record: mocks.record,
  turnScheduler: { allocateTurnId: () => mocks.nextTurnId++ }
}))
vi.mock('../src/main/services/tts', () => ({ synthesize: vi.fn() }))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ conversationLocale: 'ja-JP', uiLocale: 'ja-JP' }) }))

type Handler = (...args: unknown[]) => void

/** Follows LiveWS: a server's error event reaches both 'event' and 'error', and a send on a closing socket becomes an 'error'. */
class FakeSocket {
  readonly sent: LiveAPI.ClientEvent[] = []
  readonly handlers = new Map<string, Handler[]>()
  readonly socket = { readyState: 1 }
  closed = false
  send(event: LiveAPI.ClientEvent): void {
    if (this.socket.readyState > 1) {
      this.fire('error', new Error('cannot send on a closed WebSocket'))
      return
    }
    this.sent.push(event)
  }
  close(): void {
    this.closed = true
  }
  on(event: string, listener: Handler): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener])
    return this
  }
  fire(name: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(name) ?? []) handler(...args)
  }
  emit(event: LiveAPI.ServerEvent): void {
    this.fire('event', event)
    if (event.type === 'error') this.fire('error', Object.assign(new Error(JSON.stringify(event)), { error: event }))
  }
  started(): void {
    this.emit({ type: 'session.started', event_id: 'e1', session: { id: 's', expires_at: 0, model: 'gpt-live-1', status: 'active' } })
  }
  ofType<T extends LiveAPI.ClientEvent['type']>(type: T): Array<Extract<LiveAPI.ClientEvent, { type: T }>> {
    return this.sent.filter((event): event is Extract<LiveAPI.ClientEvent, { type: T }> => event.type === type)
  }
}

async function setup(): Promise<{
  engine: import('../src/main/services/live/gpt-live').GptLiveEngine
  sockets: FakeSocket[]
  events: LiveEvent[]
  audio: Float32Array[]
  beginTurn: ReturnType<typeof vi.fn>
  turnEvents: TurnEvent[]
}> {
  const { GptLiveEngine } = await import('../src/main/services/live/gpt-live')
  const sockets: FakeSocket[] = []
  const events: LiveEvent[] = []
  const audio: Float32Array[] = []
  const turnEvents: TurnEvent[] = []
  const beginTurn = vi.fn((_text: string, _typed: boolean) => ({ turnId: 42, signal: new AbortController().signal, completion: Promise.resolve() }))
  const engine = new GptLiveEngine(LIVE_ENGINE_INFO['gpt-live'], {
    settings: () => ({ liveIdleSeconds: 30, gptLive: { model: 'gpt-live-1', voice: 'marin' }, persona: '' }) as never,
    client: () => ({}) as never,
    connect: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    beginTurn,
    onTurnEvent: () => () => {},
    emitTurn: (event) => turnEvents.push(event),
    instructions: () => 'INSTRUCTIONS',
    history: () => [
      { role: 'user', content: 'こんにちは' },
      { role: 'assistant', content: 'こんにちは。' }
    ]
  })
  engine.events.on('event', (event) => events.push(event))
  engine.events.on('audio', (samples) => audio.push(samples))
  await engine.start()
  return { engine, sockets, events, audio, beginTurn, turnEvents }
}

describe('GptLiveEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    mocks.record.mockClear()
    mocks.nextTurnId = 100
  })
  afterEach(() => vi.useRealTimers())

  it('opens on the first speech, puts voice, delegation and history in session.start, and sends the buffered audio first', async () => {
    const { engine, sockets, events } = await setup()
    engine.pushAudio(new Float32Array(160).fill(0.1))
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(sockets).toHaveLength(1)
    const start = sockets[0].ofType('session.start')[0]
    expect(start.session).toMatchObject({
      model: 'gpt-live-1',
      audio: { format: { type: 'audio/pcm', rate: 24000 }, output: { voice: 'marin' } },
      delegation: { type: 'client' },
      instructions: 'INSTRUCTIONS'
    })
    expect(start.session.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'こんにちは' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'こんにちは。' }] }
    ])
    expect(sockets[0].ofType('session.input_audio.append')).toHaveLength(0)
    sockets[0].started()
    await vi.advanceTimersByTimeAsync(0)
    expect(sockets[0].ofType('session.input_audio.append')).toHaveLength(1)
    expect(events.map((e) => e.type === 'connection' && e.state)).toContain('connecting')
    expect(events.at(-2)).toMatchObject({ type: 'connection', state: 'open' })
    expect(events.at(-1)).toMatchObject({ type: 'latency', connectMs: 0 })
    engine.pushAudio(new Float32Array(160))
    expect(sockets[0].ofType('session.input_audio.append')).toHaveLength(2)
    await engine.stop()
  })

  it('turns a settled input transcript into a brain turn and sends the brain text as commentary with the delegation id', async () => {
    const { engine, sockets, events, beginTurn } = await setup()
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    const socket = sockets[0]
    socket.started()
    await vi.advanceTimersByTimeAsync(0)
    socket.emit({ type: 'session.input_transcript.delta', delta: '明日の', event_id: 'a', start_ms: 0, end_ms: 1 })
    socket.emit({ type: 'session.delegation.created', event_id: 'd', offset_ms: 1, delegation: { id: 'dlg1', type: 'delegation', target: 'client' } })
    socket.emit({ type: 'session.input_transcript.delta', delta: '天気は', event_id: 'b', start_ms: 1, end_ms: 2 })
    expect(events.filter((e) => e.type === 'userTranscript').map((e) => e.type === 'userTranscript' && e.text)).toEqual(['明日の', '明日の天気は'])
    await vi.advanceTimersByTimeAsync(600)
    expect(beginTurn).toHaveBeenCalledOnce()
    expect(beginTurn.mock.calls[0][0]).toBe('明日の天気は')
    expect(beginTurn.mock.calls[0][1]).toBe(false)
    // The brain records an utterance it took over, so the final transcript is not recorded again here.
    expect(mocks.record).not.toHaveBeenCalled()
    const route = beginTurn.mock.calls[0][2] as { open: (ctx: unknown) => { push: (s: string) => void; drain: () => Promise<void> } }
    const sink = route.open({ turnId: 42, signal: new AbortController().signal, emit: vi.fn() })
    sink.push('晴れです。')
    sink.push('')
    await sink.drain()
    expect(socket.ofType('session.commentary.append')).toEqual([{ type: 'session.commentary.append', delegation_id: 'dlg1', content: '晴れです。' }])
    // The output transcript of what was spoken is recorded under the turn id of the brain.
    socket.emit({ type: 'session.output_transcript.delta', delta: '明日は晴れですよ。', event_id: 'c', start_ms: 2, end_ms: 3 })
    await vi.advanceTimersByTimeAsync(1500)
    expect(events.at(-1)).toMatchObject({ type: 'assistantTranscript', turnId: 42, text: '明日は晴れですよ。', final: true })
    await engine.stop()
    expect(mocks.record).toHaveBeenCalledWith({ kind: 'assistant', turnId: 42, text: '明日は晴れですよ。' })
  })

  it('records an exchange that was not delegated from the transcripts, emits Float32 audio, and measures the response time', async () => {
    const { engine, sockets, events, audio } = await setup()
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    const socket = sockets[0]
    socket.started()
    socket.emit({ type: 'session.input_transcript.delta', delta: 'おはよう', event_id: 'a', start_ms: 0, end_ms: 1 })
    await vi.advanceTimersByTimeAsync(200)
    socket.emit({ type: 'session.output_audio.delta', delta: Buffer.from([0, 64, 0, 192]).toString('base64') })
    expect(audio).toHaveLength(1)
    expect(audio[0][0]).toBeCloseTo(0.5, 3)
    expect(events.find((e) => e.type === 'latency' && e.responseMs > 0)).toMatchObject({ responseMs: 200 })
    socket.emit({ type: 'session.output_transcript.delta', delta: 'おはようございます。', event_id: 'b', start_ms: 1, end_ms: 2 })
    await vi.advanceTimersByTimeAsync(1500)
    expect(mocks.record.mock.calls.map((c) => c[0])).toEqual([
      { kind: 'user', turnId: 100, text: 'おはよう' },
      { kind: 'assistant', turnId: 100, text: 'おはようございます。' }
    ])
    await engine.stop()
  })

  it('passes typed text to the voice side as context and starts the brain turn as typed', async () => {
    const { engine, sockets, beginTurn } = await setup()
    const sending = engine.sendText('3分タイマー')
    await vi.advanceTimersByTimeAsync(0)
    sockets[0].started()
    await sending
    expect(sockets[0].ofType('session.thinking.append')[0]).toMatchObject({ delegation_id: null, content: '[ユーザーが文字で入力した] 3分タイマー' })
    expect(beginTurn).toHaveBeenCalledWith('3分タイマー', true, expect.anything())
    await engine.stop()
  })

  it('derives the cost from the usage, closes an idle session, and opens a new one on the next speech', async () => {
    const { engine, sockets, events } = await setup()
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    sockets[0].started()
    sockets[0].emit({ type: 'session.usage.updated', event_id: 'u', usage: { seconds: 120 } })
    expect(events.at(-1)).toEqual({ type: 'usage', usage: { sessionSeconds: 120, costUsd: 0.1 } })
    await vi.advanceTimersByTimeAsync(31_000)
    expect(sockets[0].ofType('session.close')).toHaveLength(1)
    expect(sockets[0].closed).toBe(true)
    expect(engine.state).toBe('idle')
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(sockets).toHaveLength(2)
    sockets[1].started()
    sockets[1].emit({ type: 'session.usage.updated', event_id: 'u2', usage: { seconds: 60 } })
    expect(events.at(-1)).toEqual({ type: 'usage', usage: { sessionSeconds: 180, costUsd: 0.15 } })
    await engine.stop()
    expect(sockets[1].closed).toBe(true)
    expect(engine.state).toBe('off')
  })

  it('closes the socket of a session that did not start in time, and ignores what that socket reports afterwards', async () => {
    const { engine, sockets, events } = await setup()
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(15_001)
    expect(engine.state).toBe('error')
    // GPT-Live bills a session by the second for as long as it is open.
    expect(sockets[0].closed).toBe(true)
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    sockets[1].started()
    sockets[1].emit({ type: 'session.usage.updated', event_id: 'u1', usage: { seconds: 10 } })
    sockets[0].started()
    sockets[0].emit({ type: 'session.usage.updated', event_id: 'u0', usage: { seconds: 600 } })
    expect(events.filter((e) => e.type === 'usage').at(-1)).toEqual({ type: 'usage', usage: { sessionSeconds: 10, costUsd: expect.any(Number) } })
    await engine.stop()
  })

  it('reports a server error once with its message, as the failure to connect when it comes before the session started', async () => {
    const { t } = await import('../src/main/services/i18n')
    const { engine, sockets, events } = await setup()
    const errors = (): string[] => events.flatMap((e) => (e.type === 'error' ? [e.message] : []))
    const serverError = { type: 'error' as const, event_id: 'x', error: { type: 'invalid_request_error', code: 'invalid_value', message: 'Invalid value for voice.' } }
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    sockets[0].emit(serverError)
    await vi.advanceTimersByTimeAsync(0)
    expect(errors()).toEqual([t('voice.live.connectFailed', { detail: 'Invalid value for voice.' })])
    expect(sockets[0].closed).toBe(true)
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    sockets[1].started()
    await vi.advanceTimersByTimeAsync(0)
    sockets[1].emit(serverError)
    expect(errors().slice(1)).toEqual(['Invalid value for voice.'])
    await engine.stop()
  })

  it('sends nothing once the server has begun to close the socket, and goes idle when it has closed', async () => {
    const { engine, sockets, events } = await setup()
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    const socket = sockets[0]
    socket.started()
    await vi.advanceTimersByTimeAsync(0)
    engine.activity(false)
    const appended = socket.ofType('session.input_audio.append').length
    socket.socket.readyState = 2
    for (let i = 0; i < 3; i++) engine.pushAudio(new Float32Array(512))
    expect(events.filter((e) => e.type === 'error')).toEqual([])
    socket.socket.readyState = 3
    socket.fire('close', 1000, '')
    expect(engine.state).toBe('idle')
    expect(socket.ofType('session.input_audio.append')).toHaveLength(appended)
    await engine.stop()
  })

  it('closes the user line on screen under the turn it was shown with when the utterance is handed to brain', async () => {
    const { engine, sockets, events, beginTurn } = await setup()
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    const socket = sockets[0]
    socket.started()
    await vi.advanceTimersByTimeAsync(0)
    socket.emit({ type: 'session.input_transcript.delta', delta: '明日の天気は', event_id: 'a', start_ms: 0, end_ms: 1 })
    socket.emit({ type: 'session.delegation.created', event_id: 'd', offset_ms: 1, delegation: { id: 'dlg1', type: 'delegation', target: 'client' } })
    await vi.advanceTimersByTimeAsync(3000)
    expect(beginTurn).toHaveBeenCalledOnce()
    const lines = events.flatMap((e) => (e.type === 'userTranscript' ? [[e.turnId, e.text, e.final]] : []))
    expect(lines).toEqual([
      [100, '明日の天気は', false],
      [100, '明日の天気は', true]
    ])
    // Brain records the utterance it took over.
    expect(mocks.record).not.toHaveBeenCalled()
    await engine.stop()
  })

  it('hands the whole transcript to brain even when the transcript of the backchannel settles while it still arrives', async () => {
    const { engine, sockets, beginTurn } = await setup()
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    const socket = sockets[0]
    socket.started()
    await vi.advanceTimersByTimeAsync(0)
    socket.emit({ type: 'session.input_transcript.delta', delta: '明日の', event_id: 'a', start_ms: 0, end_ms: 1 })
    socket.emit({ type: 'session.output_transcript.delta', delta: 'うん、', event_id: 'b', start_ms: 1, end_ms: 2 })
    socket.emit({ type: 'session.delegation.created', event_id: 'd', offset_ms: 1, delegation: { id: 'dlg1', type: 'delegation', target: 'client' } })
    // The input transcript keeps arriving for 1.2 seconds, and the backchannel's settles 1.5 seconds after it began.
    for (const [i, delta] of ['天気', 'を', '教え', 'て'].entries()) {
      await vi.advanceTimersByTimeAsync(300)
      socket.emit({ type: 'session.input_transcript.delta', delta, event_id: `t${i}`, start_ms: 2, end_ms: 3 })
    }
    await vi.advanceTimersByTimeAsync(3000)
    expect(beginTurn).toHaveBeenCalledOnce()
    expect(beginTurn.mock.calls[0][0]).toBe('明日の天気を教えて')
    await engine.stop()
    // The backchannel answered the utterance brain took over, so it is part of brain's turn.
    expect(mocks.record.mock.calls.map((c) => c[0])).toEqual([{ kind: 'assistant', turnId: 42, text: 'うん、' }])
  })

  it('hands the whole utterance to brain when its transcript only begins after the delegation, and closes one line for it', async () => {
    const { engine, sockets, events, beginTurn } = await setup()
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    const socket = sockets[0]
    socket.started()
    await vi.advanceTimersByTimeAsync(0)
    socket.emit({ type: 'session.delegation.created', event_id: 'd', offset_ms: 1, delegation: { id: 'dlg1', type: 'delegation', target: 'client' } })
    await vi.advanceTimersByTimeAsync(500)
    for (const [i, delta] of ['明日の', '天気を', '教えて'].entries()) {
      socket.emit({ type: 'session.input_transcript.delta', delta, event_id: `t${i}`, start_ms: 2, end_ms: 3 })
      await vi.advanceTimersByTimeAsync(150)
    }
    await vi.advanceTimersByTimeAsync(3000)
    expect(beginTurn.mock.calls.map((c) => c[0])).toEqual(['明日の天気を教えて'])
    const finals = events.flatMap((e) => (e.type === 'userTranscript' && e.final ? [[e.turnId, e.text]] : []))
    expect(finals).toEqual([[100, '明日の天気を教えて']])
    // Brain records the utterance it took over, so no part of it is recorded here as a line of its own.
    expect(mocks.record).not.toHaveBeenCalled()
    await engine.stop()
  })

  it('leaves the end of a turn it handed to brain to brain, which ends it once its reply is over', async () => {
    const { engine, sockets, turnEvents } = await setup()
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    const socket = sockets[0]
    socket.started()
    await vi.advanceTimersByTimeAsync(0)
    socket.emit({ type: 'session.input_transcript.delta', delta: '明日の天気は', event_id: 'a', start_ms: 0, end_ms: 1 })
    socket.emit({ type: 'session.delegation.created', event_id: 'd', offset_ms: 1, delegation: { id: 'dlg1', type: 'delegation', target: 'client' } })
    await vi.advanceTimersByTimeAsync(600)
    // The voice reads the first of brain's sentences, and brain is still working on the rest.
    socket.emit({ type: 'session.output_transcript.delta', delta: '調べますね。', event_id: 'b', start_ms: 2, end_ms: 3 })
    await vi.advanceTimersByTimeAsync(1500)
    // A done here would end the turn on screen while brain still opens its panels.
    expect(turnEvents).toEqual([])
    await engine.stop()
    expect(mocks.record).toHaveBeenCalledWith({ kind: 'assistant', turnId: 42, text: '調べますね。' })
    expect(turnEvents).toEqual([])
  })

  it('records the short line and every sentence the voice reads for a delegated turn once, under brain turn, when the next exchange begins', async () => {
    const { engine, sockets, beginTurn, turnEvents } = await setup()
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    const socket = sockets[0]
    socket.started()
    await vi.advanceTimersByTimeAsync(0)
    const input = (delta: string, id: string): void => socket.emit({ type: 'session.input_transcript.delta', delta, event_id: id, start_ms: 0, end_ms: 1 })
    const output = (delta: string, id: string): void => socket.emit({ type: 'session.output_transcript.delta', delta, event_id: id, start_ms: 0, end_ms: 1 })
    input('明日の天気は', 'a')
    socket.emit({ type: 'session.delegation.created', event_id: 'd', offset_ms: 1, delegation: { id: 'dlg1', type: 'delegation', target: 'client' } })
    output('明日の天気ですね、', 'b')
    await vi.advanceTimersByTimeAsync(600)
    expect(beginTurn).toHaveBeenCalledOnce()
    const route = beginTurn.mock.calls[0][2] as { open: (ctx: unknown) => { push: (s: string) => void; drain: () => Promise<void> } }
    const sink = route.open({ turnId: 42, signal: new AbortController().signal, emit: vi.fn() })
    // The voice reads each of brain's sentences as it comes, and its transcript settles between them.
    sink.push('明日は晴れです。')
    await sink.drain()
    output('明日は晴れです。', 'c')
    await vi.advanceTimersByTimeAsync(3000)
    sink.push('最高気温は20度です。')
    await sink.drain()
    output('最高気温は20度です。', 'e')
    await vi.advanceTimersByTimeAsync(3000)
    expect(mocks.record).not.toHaveBeenCalled()
    input('ありがとう', 'f')
    expect(mocks.record.mock.calls.map((c) => c[0])).toEqual([
      { kind: 'assistant', turnId: 42, text: '明日の天気ですね、明日は晴れです。最高気温は20度です。' }
    ])
    await vi.advanceTimersByTimeAsync(1500)
    // The next utterance is an exchange of its own.
    expect(mocks.record.mock.calls.at(-1)?.[0]).toEqual({ kind: 'user', turnId: 101, text: 'ありがとう' })
    expect(turnEvents).toEqual([])
    await engine.stop()
  })

  it('records what the voice reads for a job report under the report turn, and what it read for the turn before under that one', async () => {
    const { engine, sockets, beginTurn } = await setup()
    const sending = engine.sendText('3分タイマー')
    await vi.advanceTimersByTimeAsync(0)
    const socket = sockets[0]
    socket.started()
    await sending
    expect(beginTurn).toHaveBeenCalledOnce()
    const output = (delta: string, id: string): void => socket.emit({ type: 'session.output_transcript.delta', delta, event_id: id, start_ms: 0, end_ms: 1 })
    output('3分のタイマーを始めました。', 'a')
    await vi.advanceTimersByTimeAsync(1500)
    // A job report is a brain turn of its own, whose sentences reach the voice outside any delegation.
    await engine.sayOutsideDelegation('調査が終わりました。', { turnId: 43, signal: new AbortController().signal })
    output('調査が終わりましたよ。', 'b')
    await vi.advanceTimersByTimeAsync(1500)
    await engine.stop()
    expect(mocks.record.mock.calls.map((c) => c[0])).toEqual([
      { kind: 'assistant', turnId: 42, text: '3分のタイマーを始めました。' },
      { kind: 'assistant', turnId: 43, text: '調査が終わりましたよ。' }
    ])
  })

  it('records a delegated turn once the session it was read in closes, so the next session starts from a history that has it', async () => {
    const { engine, sockets } = await setup()
    const sending = engine.sendText('明日の天気')
    await vi.advanceTimersByTimeAsync(0)
    sockets[0].started()
    await sending
    sockets[0].emit({ type: 'session.output_transcript.delta', delta: '晴れです。', event_id: 'a', start_ms: 0, end_ms: 1 })
    await vi.advanceTimersByTimeAsync(1500)
    expect(mocks.record).not.toHaveBeenCalled()
    // The session goes idle and closes.
    await vi.advanceTimersByTimeAsync(31_000)
    expect(sockets[0].closed).toBe(true)
    expect(mocks.record.mock.calls.map((c) => c[0])).toEqual([{ kind: 'assistant', turnId: 42, text: '晴れです。' }])
    await engine.stop()
    expect(mocks.record).toHaveBeenCalledOnce()
  })

  it('records the rest of an utterance whose transcript comes after the delegation took it as an exchange of its own, not as a second input of brain turn', async () => {
    const { engine, sockets, beginTurn } = await setup()
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    const socket = sockets[0]
    socket.started()
    await vi.advanceTimersByTimeAsync(0)
    socket.emit({ type: 'session.input_transcript.delta', delta: '明日の天気', event_id: 'a', start_ms: 0, end_ms: 1 })
    socket.emit({ type: 'session.delegation.created', event_id: 'd', offset_ms: 1, delegation: { id: 'dlg1', type: 'delegation', target: 'client' } })
    await vi.advanceTimersByTimeAsync(600)
    expect(beginTurn.mock.calls.map((c) => c[0])).toEqual(['明日の天気'])
    socket.emit({ type: 'session.input_transcript.delta', delta: 'と明後日の天気', event_id: 'b', start_ms: 1, end_ms: 2 })
    await vi.advanceTimersByTimeAsync(1500)
    expect(mocks.record.mock.calls.map((c) => c[0])).toEqual([{ kind: 'user', turnId: 101, text: 'と明後日の天気' }])
    await engine.stop()
  })

  it('ends a delegation still waiting for its transcript when the engine stops, and carries nothing of it into the next start', async () => {
    const { engine, sockets, beginTurn } = await setup()
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    sockets[0].started()
    await vi.advanceTimersByTimeAsync(0)
    sockets[0].emit({ type: 'session.input_transcript.delta', delta: '明日の天気は', event_id: 'a', start_ms: 0, end_ms: 1 })
    sockets[0].emit({ type: 'session.delegation.created', event_id: 'd', offset_ms: 1, delegation: { id: 'dlg1', type: 'delegation', target: 'client' } })
    await engine.stop()
    await vi.advanceTimersByTimeAsync(3000)
    // What was heard is kept, and no turn starts for an engine that is off.
    expect(mocks.record.mock.calls.map((c) => c[0])).toEqual([{ kind: 'user', turnId: 100, text: '明日の天気は' }])
    expect(beginTurn).not.toHaveBeenCalled()
    // A sentence from a brain turn still running opens no session, which nothing would close.
    await engine.sayOutsideDelegation('晴れです。', { turnId: 42, signal: new AbortController().signal })
    expect(sockets).toHaveLength(1)

    await engine.start()
    const saying = engine.sayOutsideDelegation('お待たせしました。', { turnId: 43, signal: new AbortController().signal })
    await vi.advanceTimersByTimeAsync(0)
    const socket = sockets[1]
    socket.started()
    await saying
    socket.emit({ type: 'session.output_transcript.delta', delta: 'お待たせしました。', event_id: 'b', start_ms: 1, end_ms: 2 })
    await vi.advanceTimersByTimeAsync(1500)
    // Nothing of the delegation before the stop holds back what the user says next.
    socket.emit({ type: 'session.input_transcript.delta', delta: 'はい', event_id: 'c', start_ms: 2, end_ms: 3 })
    await vi.advanceTimersByTimeAsync(1500)
    expect(mocks.record.mock.calls.slice(1).map((c) => [c[0].kind, c[0].turnId, c[0].text])).toEqual([
      ['assistant', 43, 'お待たせしました。'],
      ['user', 101, 'はい']
    ])
    // Nobody has spoken since the start, so a session the provider ends stays closed.
    socket.fire('close', 1000, '')
    await vi.advanceTimersByTimeAsync(0)
    expect(sockets).toHaveLength(2)
    expect(engine.state).toBe('idle')
    await engine.stop()
  })
})
