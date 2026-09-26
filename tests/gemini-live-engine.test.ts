import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveEvent, TurnEvent } from '@shared/ipc'
import type { ToolExecution, ToolExecutionTask } from '@shared/tool-registry'
import { LIVE_ENGINE_INFO } from '@shared/voice-engine'
import { marker } from '@shared/conversation-markers'
import type { GeminiConnectParams, GeminiServerMessage, GeminiSession } from '../src/main/services/live/gemini-live'

/** These tests drive the Gemini Live engine end to end against a fake session. */

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  nextTurnId: 200,
  conversationLocale: 'ja-JP' as 'ja-JP' | 'en-US',
  /** What connecting waits for before the session arrives, as the socket opening does. */
  connected: Promise.resolve()
}))

vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ conversationLocale: mocks.conversationLocale, uiLocale: 'ja-JP' }) }))
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

type ExecuteTool = (name: string, input: Record<string, unknown>, ctx: { signal: AbortSignal }) => ToolExecutionTask

const result = (content: string): ToolExecution => ({ content, isError: false, durationMs: 1, resultLength: content.length, truncated: false })

/** A tool call whose answer and work have both ended. */
const finished = (content: string): ToolExecutionTask => Object.assign(Promise.resolve(result(content)), { completion: Promise.resolve(), operationStarted: () => {} })

async function setup(execute?: ExecuteTool): Promise<{
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
  const executeTool = vi.fn(execute ?? ((name: string) => finished(`{"shown":true,"panel":"${name}"}`)))
  const memoryInjection = vi.fn(async (text: string) =>
    text.includes('いつもの') ? { text: '[記憶] いつもの店は中野のカフェ', ids: ['m-cafe'] } : null
  )
  const engine = new GeminiLiveEngine(LIVE_ENGINE_INFO['gemini-live'], {
    settings: () => ({ liveIdleSeconds: 30, geminiLive: { model: 'gemini-3.8-live', voice: 'Kore' } }) as never,
    apiKey: () => 'key',
    connect: async (params) => {
      await mocks.connected
      const session = new FakeSession(params)
      sessions.push(session)
      return session
    },
    systemInstruction: () => 'SYSTEM',
    functionDeclarations: () => [{ name: 'show_weather', parametersJsonSchema: { type: 'object' }, behavior: 'NON_BLOCKING' }],
    executeTool: executeTool as never,
    // The show_ tools only read, as in the registry; every other name stands for a tool that writes.
    isParallel: (name) => name.startsWith('show_'),
    recordTool: vi.fn(),
    memoryInjection,
    recordNote: (turnId, text, memoryIds) => mocks.record({ kind: 'note', turnId, text, memoryIds }),
    recordUser: (turnId, text) => mocks.record({ kind: 'user', turnId, text }),
    history: () => [{ role: 'user', content: '前の話' }],
    emitTurn: (event) => turnEvents.push(event)
  })
  engine.events.on('event', (event) => events.push(event))
  await engine.start()
  return { engine, sessions, events, turnEvents, executeTool, memoryInjection }
}

/** A tool call that runs until the test ends it, as one waiting for approval does. `finish` ends its work as well. */
function held(): { task: ToolExecutionTask; answer: (content: string) => void; finish: () => void } {
  let answer!: (content: string) => void
  let finish!: () => void
  const response = new Promise<ToolExecution>((resolve) => (answer = (content) => resolve(result(content))))
  const completion = new Promise<void>((resolve) => (finish = resolve))
  return { task: Object.assign(response, { completion, operationStarted: () => {} }), answer, finish }
}

const responseIds = (session: FakeSession): string[] =>
  session.toolResponses.map((response) => (response as { functionResponses: Array<{ id: string }> }).functionResponses[0].id)

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
    mocks.connected = Promise.resolve()
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
    // The note is recorded on the utterance's turn, which keeps its memories from being injected again.
    expect(mocks.record).toHaveBeenLastCalledWith({ kind: 'note', turnId: 200, text: '[記憶] いつもの店は中野のカフェ', memoryIds: ['m-cafe'] })
    await engine.stop()
  })

  it('records no memory note when the session closed before the note was ready, since no model read it', async () => {
    const { engine, sessions, memoryInjection } = await setup()
    let ready!: (injection: { text: string; ids: string[] }) => void
    memoryInjection.mockImplementationOnce(() => new Promise((resolve) => (ready = resolve)))
    const session = await open(engine, sessions)
    session.message({ serverContent: { inputTranscription: { text: 'いつもの店を教えて', finished: true } } })
    await engine.stop()
    ready({ text: '[記憶] いつもの店は中野のカフェ', ids: ['m-cafe'] })
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.record.mock.calls.map((c) => c[0].kind)).toEqual(['user'])
    expect(session.contents.some((content) => JSON.stringify(content).includes('[記憶]'))).toBe(false)
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

  it('answers a timed-out write at once, and holds a write from a later message until the earlier one has stopped working', async () => {
    const first = held()
    const { engine, sessions, executeTool } = await setup((name) => (name === 'run_agent_task' ? first.task : finished('archived')))
    const session = await open(engine, sessions)
    session.message({ toolCall: { functionCalls: [{ id: 'a', name: 'run_agent_task', args: {} }] } })
    await vi.advanceTimersByTimeAsync(0)
    first.answer('run_agent_task timed out')
    // A NON_BLOCKING call can arrive while an earlier write is still working.
    session.message({ toolCall: { functionCalls: [{ id: 'b', name: 'change_mail', args: {} }] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(responseIds(session)).toEqual(['a'])
    expect(executeTool).toHaveBeenCalledTimes(1)
    first.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(executeTool).toHaveBeenLastCalledWith('change_mail', {}, expect.anything())
    expect(responseIds(session)).toEqual(['a', 'b'])
    await engine.stop()
  })

  it('answers the model with an error and marks the tool failed when the tool throws before it returns its task', async () => {
    const { engine, sessions, turnEvents } = await setup(() => {
      throw new Error('settings unreadable')
    })
    const session = await open(engine, sessions)
    session.message({ toolCall: { functionCalls: [{ id: 'a', name: 'run_agent_task', args: {} }] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(session.toolResponses).toEqual([
      { functionResponses: [{ id: 'a', name: 'run_agent_task', response: { error: 'settings unreadable' }, scheduling: 'WHEN_IDLE' }] }
    ])
    expect(turnEvents.filter((event) => event.type === 'tool').map((event) => event.type === 'tool' && event.status)).toEqual(['start', 'error'])
    await engine.stop()
  })

  it('does not run a call that Gemini cancels while it waits for its turn', async () => {
    const first = held()
    const { engine, sessions, executeTool } = await setup(() => first.task)
    const session = await open(engine, sessions)
    session.message({
      toolCall: {
        functionCalls: [
          { id: 'a', name: 'run_agent_task', args: {} },
          { id: 'b', name: 'change_mail', args: {} }
        ]
      }
    })
    session.message({ toolCallCancellation: { ids: ['b'] } })
    first.answer('started')
    first.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(executeTool).toHaveBeenCalledTimes(1)
    expect(responseIds(session)).toEqual(['a'])
    await engine.stop()
  })

  it('keeps the session open while a function call waits for approval, and closes it once the result is back and the conversation is quiet', async () => {
    const call = held()
    let signal: AbortSignal | null = null
    const { engine, sessions } = await setup((_name, _input, ctx) => {
      signal = ctx.signal
      return call.task
    })
    const session = await open(engine, sessions)
    session.message({ toolCall: { functionCalls: [{ id: 'a', name: 'run_agent_task', args: {} }] } })
    // The idle close is 30 seconds in this setup, and a confirmation may wait for five minutes.
    await vi.advanceTimersByTimeAsync(120_000)
    expect(session.closed).toBe(false)
    expect(signal!.aborted).toBe(false)
    call.answer('approved')
    call.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(responseIds(session)).toEqual(['a'])
    await vi.advanceTimersByTimeAsync(31_000)
    expect(session.closed).toBe(true)
    await engine.stop()
  })

  it('closes a session whose setup did not complete in time, and plays nothing it sends afterwards', async () => {
    const { engine, sessions } = await setup()
    const audio: Float32Array[] = []
    engine.events.on('audio', (samples) => audio.push(samples))
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(15_001)
    expect(engine.state).toBe('error')
    expect(sessions[0].closed).toBe(true)
    sessions[0].message({ setupComplete: {} })
    sessions[0].message({ serverContent: { modelTurn: { parts: [{ inlineData: { data: Buffer.from([0, 64]).toString('base64'), mimeType: 'audio/pcm' } }] } } })
    expect(audio).toHaveLength(0)
    await engine.stop()
  })

  it('closes a session that arrives only after its opening already failed', async () => {
    let connect!: () => void
    mocks.connected = new Promise((resolve) => (connect = resolve))
    const { engine, sessions } = await setup()
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(15_001)
    expect(engine.state).toBe('error')
    connect()
    await vi.advanceTimersByTimeAsync(0)
    expect(sessions[0].closed).toBe(true)
    await engine.stop()
  })

  it('opens a new session at once when the provider ends one while the user is speaking, and waits for the next speech when the user is silent', async () => {
    const { engine, sessions } = await setup()
    const first = await open(engine, sessions)
    first.message({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } })
    first.params.callbacks.onclose('session time limit')
    // What the user says meanwhile goes into the pre-roll and is sent first once the next session is set up.
    engine.pushAudio(new Float32Array(1600))
    await vi.advanceTimersByTimeAsync(0)
    expect(sessions).toHaveLength(2)
    const second = sessions[1]
    expect(second.params.resumptionHandle).toBe('h1')
    second.message({ setupComplete: {} })
    await vi.advanceTimersByTimeAsync(0)
    expect(engine.state).toBe('open')
    expect(second.realtime).toHaveLength(1)
    engine.activity(false)
    second.params.callbacks.onclose('session time limit')
    await vi.advanceTimersByTimeAsync(0)
    expect(sessions).toHaveLength(2)
    expect(engine.state).toBe('idle')
    await engine.stop()
  })

  it('reports an error once: as the failure to connect before the setup, and as an error after it', async () => {
    const { t } = await import('../src/main/services/i18n')
    const { engine, sessions, events } = await setup()
    const errors = (): string[] => events.flatMap((e) => (e.type === 'error' ? [e.message] : []))
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    sessions[0].params.callbacks.onerror(new Error('quota exceeded'))
    await vi.advanceTimersByTimeAsync(0)
    expect(errors()).toEqual([t('voice.live.connectFailed', { detail: 'quota exceeded' })])
    const session = await open(engine, sessions)
    session.params.callbacks.onerror(new Error('quota exceeded'))
    expect(errors().slice(1)).toEqual(['quota exceeded'])
    await engine.stop()
  })

  it('aborts the calls still running when the provider ends the session, and answers none of them to the next one', async () => {
    const call = held()
    let signal: AbortSignal | null = null
    const { engine, sessions } = await setup((_name, _input, ctx) => {
      signal = ctx.signal
      return call.task
    })
    const first = await open(engine, sessions)
    first.message({ toolCall: { functionCalls: [{ id: 'a', name: 'run_agent_task', args: {} }] } })
    await vi.advanceTimersByTimeAsync(0)
    first.params.callbacks.onclose('session time limit')
    expect(signal!.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    const second = sessions[1]
    second.message({ setupComplete: {} })
    await vi.advanceTimersByTimeAsync(0)
    call.answer('approved')
    call.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(second.toolResponses).toEqual([])
    await engine.stop()
  })

  it('reopens a session the provider ends only once per start of speech, so a provider that ends each one at once cannot make it reconnect in a loop', async () => {
    const { engine, sessions } = await setup()
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 5; i++) {
      const session = sessions[sessions.length - 1]
      session.message({ setupComplete: {} })
      await vi.advanceTimersByTimeAsync(0)
      engine.pushAudio(new Float32Array(1600))
      session.params.callbacks.onclose('code 1007')
      await vi.advanceTimersByTimeAsync(0)
    }
    // Each session costs money and is sent the pre-roll again.
    expect(sessions).toHaveLength(2)
    engine.activity(false)
    engine.activity(true)
    await vi.advanceTimersByTimeAsync(0)
    sessions[2].message({ setupComplete: {} })
    await vi.advanceTimersByTimeAsync(0)
    sessions[2].params.callbacks.onclose('session time limit')
    await vi.advanceTimersByTimeAsync(0)
    expect(sessions).toHaveLength(4)
    sessions[3].message({ setupComplete: {} })
    await engine.stop()
  })

  it('sends nothing but the history to a session before its setup completes, so a memory note that settles meanwhile is neither sent nor recorded', async () => {
    const { engine, sessions, memoryInjection } = await setup()
    let ready!: (injection: { text: string; ids: string[] }) => void
    memoryInjection.mockImplementationOnce(() => new Promise((resolve) => (ready = resolve)))
    const first = await open(engine, sessions)
    first.message({ serverContent: { inputTranscription: { text: 'いつもの店を教えて', finished: true } } })
    first.params.callbacks.onclose('session time limit')
    await vi.advanceTimersByTimeAsync(0)
    const second = sessions[1]
    ready({ text: '[記憶] いつもの店は中野のカフェ', ids: ['m-cafe'] })
    await vi.advanceTimersByTimeAsync(0)
    expect(second.contents).toEqual([])
    second.message({ setupComplete: {} })
    await vi.advanceTimersByTimeAsync(0)
    expect(second.contents).toEqual([{ turns: [{ role: 'user', parts: [{ text: '前の話' }] }], turnComplete: false }])
    expect(mocks.record.mock.calls.map((c) => c[0].kind)).toEqual(['user'])
    await engine.stop()
  })
})
