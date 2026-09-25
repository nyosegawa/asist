import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveEvent, TurnEvent } from '@shared/ipc'
import { LIVE_ENGINE_INFO } from '@shared/voice-engine'
import { marker } from '@shared/conversation-markers'
import type { GeminiConnectParams, GeminiServerMessage, GeminiSession } from '../src/main/services/live/gemini-live'

/** These tests drive the Gemini Live engine end to end against a fake session. */

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  nextTurnId: 200,
  conversationLocale: 'ja-JP' as 'ja-JP' | 'en-US'
}))

vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ conversationLocale: mocks.conversationLocale }) }))
vi.mock('../src/main/services/brain/session', () => ({
  record: mocks.record,
  turnScheduler: { allocateTurnId: () => mocks.nextTurnId++ }
}))

class FakeSession implements GeminiSession {
  readonly realtime: unknown[] = []
  readonly contents: unknown[] = []
  readonly toolResponses: unknown[] = []
  closed = false
  constructor(readonly params: GeminiConnectParams) {}
  sendRealtimeInput(params: unknown): void {
    this.realtime.push(params)
  }
  sendClientContent(params: unknown): void {
    this.contents.push(params)
  }
  sendToolResponse(params: { functionResponses: unknown[] }): void {
    this.toolResponses.push(params)
  }
  close(): void {
    this.closed = true
  }
  message(message: GeminiServerMessage): void {
    this.params.callbacks.onmessage(message)
  }
}

async function setup(): Promise<{
  engine: import('../src/main/services/live/gemini-live').GeminiLiveEngine
  sessions: FakeSession[]
  events: LiveEvent[]
  turnEvents: TurnEvent[]
  executeTool: ReturnType<typeof vi.fn>
  memoryInjection: ReturnType<typeof vi.fn>
}> {
  const { GeminiLiveEngine } = await import('../src/main/services/live/gemini-live')
  const sessions: FakeSession[] = []
  const events: LiveEvent[] = []
  const turnEvents: TurnEvent[] = []
  const executeTool = vi.fn(async (name: string) => ({ content: `{"shown":true,"panel":"${name}"}`, isError: false, durationMs: 5, resultLength: 10, truncated: false }))
  const memoryInjection = vi.fn(async (text: string) => (text.includes('いつもの') ? '[記憶] いつもの店は中野のカフェ' : null))
  const engine = new GeminiLiveEngine(LIVE_ENGINE_INFO['gemini-live'], {
    settings: () => ({ liveIdleSeconds: 30, geminiLive: { model: 'gemini-3.8-live', voice: 'Kore' } }) as never,
    apiKey: () => 'key',
    connect: async (params) => {
      const session = new FakeSession(params)
      sessions.push(session)
      return session
    },
    systemInstruction: () => 'SYSTEM',
    functionDeclarations: () => [{ name: 'show_weather', parametersJsonSchema: { type: 'object' }, behavior: 'NON_BLOCKING' }],
    executeTool,
    recordTool: vi.fn(),
    memoryInjection,
    recordUser: (turnId, text) => mocks.record({ kind: 'user', turnId, text }),
    history: () => [{ role: 'user', content: '前の話' }],
    emitTurn: (event) => turnEvents.push(event)
  })
  engine.events.on('event', (event) => events.push(event))
  await engine.start()
  return { engine, sessions, events, turnEvents, executeTool, memoryInjection }
}

async function open(engine: { activity: (a: boolean) => void }, sessions: FakeSession[]): Promise<FakeSession> {
  engine.activity(true)
  await vi.advanceTimersByTimeAsync(0)
  const session = sessions[sessions.length - 1]
  session.message({ setupComplete: {} })
  await vi.advanceTimersByTimeAsync(0)
  return session
}

describe('GeminiLiveEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    mocks.record.mockClear()
    mocks.nextTurnId = 200
    mocks.conversationLocale = 'ja-JP'
  })
  afterEach(() => vi.useRealTimers())

  it('feeds the recent history into a new session as context and sends audio as 16 kHz PCM', async () => {
    const { engine, sessions } = await setup()
    const session = await open(engine, sessions)
    expect(session.params).toMatchObject({ model: 'gemini-3.8-live', voice: 'Kore', systemInstruction: 'SYSTEM', resumptionHandle: null })
    expect(session.contents[0]).toEqual({ turns: [{ role: 'user', parts: [{ text: '前の話' }] }], turnComplete: false })
    engine.pushAudio(new Float32Array(160))
    expect(session.realtime[0]).toMatchObject({ audio: { mimeType: 'audio/pcm;rate=16000' } })
    await engine.stop()
    expect(session.realtime.at(-1)).toEqual({ audioStreamEnd: true })
    expect(session.closed).toBe(true)
  })

  it('starts a turn for a function call, runs the tool, answers with WHEN_IDLE, and closes the turn on turnComplete', async () => {
    const { engine, sessions, turnEvents, executeTool } = await setup()
    const session = await open(engine, sessions)
    session.message({ toolCall: { functionCalls: [{ id: 'c1', name: 'show_weather', args: { location: '大阪' } }] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(executeTool).toHaveBeenCalledWith('show_weather', { location: '大阪' }, expect.objectContaining({ turnId: 200 }))
    expect(session.toolResponses).toEqual([
      { functionResponses: [{ id: 'c1', name: 'show_weather', response: { result: '{"shown":true,"panel":"show_weather"}' }, scheduling: 'WHEN_IDLE' }] }
    ])
    expect(turnEvents.map((e) => e.type)).toEqual(['started', 'tool', 'tool'])
    expect(turnEvents[0]).toEqual({ type: 'started', turnId: 200, origin: 'live' })
    session.message({ serverContent: { outputTranscription: { text: '大阪は快晴です。' } } })
    session.message({ serverContent: { turnComplete: true } })
    expect(mocks.record).toHaveBeenCalledWith({ kind: 'assistant', turnId: 200, text: '大阪は快晴です。' })
    expect(turnEvents.at(-1)).toEqual({ type: 'done', turnId: 200, fullText: '大阪は快晴です。' })
    await engine.stop()
  })

  it('records the user transcript once it is finished and adds the related memory without asking for a reply', async () => {
    const { engine, sessions, events, memoryInjection } = await setup()
    const session = await open(engine, sessions)
    session.message({ serverContent: { inputTranscription: { text: 'いつもの' } } })
    session.message({ serverContent: { inputTranscription: { text: '店を教えて', finished: true } } })
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.record).toHaveBeenCalledWith({ kind: 'user', turnId: 200, text: 'いつもの店を教えて' })
    expect(events.at(-1)).toMatchObject({ type: 'userTranscript', text: 'いつもの店を教えて', final: true })
    expect(memoryInjection).toHaveBeenCalledWith('いつもの店を教えて')
    expect(session.contents.at(-1)).toEqual({ turns: [{ role: 'user', parts: [{ text: '[記憶] いつもの店は中野のカフェ' }] }], turnComplete: false })
    await engine.stop()
  })

  it('tells the renderer about an interruption, keeps what was spoken, and sends typed text and notices as text turns', async () => {
    const { engine, sessions, events } = await setup()
    const session = await open(engine, sessions)
    session.message({ serverContent: { outputTranscription: { text: '長い説明を' } } })
    const mark = events.length
    session.message({ serverContent: { interrupted: true } })
    expect(events.filter((e) => e.type === 'interrupted')).toHaveLength(1)
    expect(mocks.record).toHaveBeenCalledWith({ kind: 'assistant', turnId: 200, text: '長い説明を' })
    // The final transcript comes before the interrupted event: if it arrived after the renderer had
    // closed the line, the same sentence would be shown twice.
    expect(events.slice(mark).map((e) => e.type)).toEqual(['assistantTranscript', 'interrupted'])
    const before = events.length
    await engine.sendText('こんにちは')
    expect(mocks.record).toHaveBeenCalledWith({ kind: 'user', turnId: 201, text: 'こんにちは' })
    // The renderer already shows what was typed, so no transcript event repeats it.
    expect(events.slice(before).some((e) => e.type === 'userTranscript')).toBe(false)
    expect(session.contents.at(-1)).toEqual({ turns: [{ role: 'user', parts: [{ text: '[文字入力] こんにちは' }] }], turnComplete: true })
    await engine.notify('[システム通知] ジョブが完了した')
    expect(session.contents.at(-1)).toEqual({ turns: [{ role: 'user', parts: [{ text: '[システム通知] ジョブが完了した' }] }], turnComplete: true })
    await engine.stop()
  })

  it('marks typed text and a sentence to read out with the markers of the conversation language', async () => {
    mocks.conversationLocale = 'en-US'
    const { engine, sessions } = await setup()
    const session = await open(engine, sessions)
    await engine.sendText('hello')
    expect(session.contents.at(-1)).toEqual({
      turns: [{ role: 'user', parts: [{ text: `${marker('en-US', 'typedInput')} hello` }] }],
      turnComplete: true
    })
    await engine.say('Three minutes are up.')
    const spoken = (session.contents.at(-1) as { turns: Array<{ parts: Array<{ text: string }> }> }).turns[0].parts[0].text
    expect(spoken.startsWith(marker('en-US', 'systemNotice'))).toBe(true)
    expect(spoken).toContain('Three minutes are up.')
    expect(spoken).not.toMatch(/[぀-ヿ一-鿿]/)
    await engine.stop()
  })

  it('passes a resumption handle when it reopens the session and feeds no history then', async () => {
    const { engine, sessions } = await setup()
    const first = await open(engine, sessions)
    first.message({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } })
    await vi.advanceTimersByTimeAsync(31_000)
    expect(first.closed).toBe(true)
    const second = await open(engine, sessions)
    expect(second.params.resumptionHandle).toBe('h1')
    expect(second.contents).toHaveLength(0)
    await engine.stop()
  })

  it('keeps the conversation log in user then assistant order even when the input transcript arrives late', async () => {
    const { engine, sessions, events } = await setup()
    const session = await open(engine, sessions)
    session.message({ serverContent: { outputTranscription: { text: '今日は雨だよ。' } } })
    session.message({ serverContent: { inputTranscription: { text: '今日の天気' } } })
    session.message({ serverContent: { turnComplete: true } })
    expect(mocks.record.mock.calls.map((c) => c[0])).toEqual([
      { kind: 'user', turnId: 200, text: '今日の天気' },
      { kind: 'assistant', turnId: 200, text: '今日は雨だよ。' }
    ])
    expect(events.filter((e) => e.type === 'userTranscript').map((e) => e.type === 'userTranscript' && [e.turnId, e.final])).toEqual([[200, false], [200, true]])
    await engine.stop()
  })

})
