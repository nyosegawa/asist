import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as LiveAPI from 'openai/resources/live/live'
import type { LiveEvent } from '@shared/ipc'
import { LIVE_ENGINE_INFO } from '@shared/voice-engine'
import type { ConversationRecord, ConversationRecordInput } from '../src/main/services/brain/conversation-log'
import type { ConversationHistory } from '../src/main/services/brain/history'
import type { SpeechRoute } from '../src/main/services/brain/speech-route'

/**
 * What GPT-Live leaves in the conversation log, read back through the history brain builds its next
 * request from, while the user, the voice and brain's turns overlap.
 */

const mocks = vi.hoisted(() => ({
  log: [] as ConversationRecord[],
  history: null as ConversationHistory | null,
  nextTurnId: 100,
  t: 0
}))

vi.mock('../src/main/services/brain/session', () => ({
  record: (input: ConversationRecordInput) => {
    const full = { t: 1_790_000_000_000 + mocks.t++ * 1000, ...input } as ConversationRecord
    mocks.log.push(full)
    mocks.history?.apply(full)
    return full
  },
  turnScheduler: { allocateTurnId: () => mocks.nextTurnId++ }
}))
vi.mock('../src/main/services/tts', () => ({ synthesize: vi.fn() }))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ conversationLocale: 'ja-JP', uiLocale: 'ja-JP' }) }))

type Handler = (...args: unknown[]) => void

class FakeSocket {
  readonly sent: LiveAPI.ClientEvent[] = []
  readonly handlers = new Map<string, Handler[]>()
  readonly socket = { readyState: 1 }
  send(event: LiveAPI.ClientEvent): void {
    this.sent.push(event)
  }
  close(): void {}
  on(event: string, listener: Handler): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener])
    return this
  }
  emit(event: LiveAPI.ServerEvent): void {
    for (const handler of this.handlers.get('event') ?? []) handler(event)
  }
  input(delta: string): void {
    this.emit({ type: 'session.input_transcript.delta', delta, event_id: delta, start_ms: 0, end_ms: 1 })
  }
  output(delta: string): void {
    this.emit({ type: 'session.output_transcript.delta', delta, event_id: delta, start_ms: 0, end_ms: 1 })
  }
  delegate(id: string): void {
    this.emit({ type: 'session.delegation.created', event_id: id, offset_ms: 0, delegation: { id, type: 'delegation', target: 'client' } })
  }
}

async function setup() {
  const { GptLiveEngine } = await import('../src/main/services/live/gpt-live')
  const { ConversationHistory } = await import('../src/main/services/brain/history')
  const { liveRoute } = await import('../src/main/services/brain/speech-route')
  const history = new ConversationHistory({
    recentTurns: 30,
    compressAtTokens: 1e9,
    limitTokens: 1e9,
    hardLimitTokens: 1e9,
    load: () => [],
    saveCheckpoint: () => {},
    summarize: async () => '',
    locale: () => 'ja-JP'
  })
  history.ensureLoaded()
  mocks.history = history
  const sockets: FakeSocket[] = []
  let nextBrainTurn = 42
  const beginTurn = vi.fn((_text: string, _typed: boolean, _route: SpeechRoute) => ({
    turnId: nextBrainTurn++,
    signal: new AbortController().signal,
    completion: Promise.resolve()
  }))
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
    emitTurn: () => {},
    instructions: () => '',
    history: () => []
  })
  const events: LiveEvent[] = []
  engine.events.on('event', (event) => events.push(event))
  await engine.start()
  engine.activity(true)
  await vi.advanceTimersByTimeAsync(0)
  const socket = sockets[0]
  socket.emit({ type: 'session.started', event_id: 's', session: { id: 's', expires_at: 0, model: 'gpt-live-1', status: 'active' } })
  await vi.advanceTimersByTimeAsync(0)
  const { record } = await import('../src/main/services/brain/session')
  /** A sentence of a brain turn handed to the voice through the route brain was given. */
  const speak = async (route: SpeechRoute, turnId: number, sentence: string): Promise<void> => {
    const sink = route.open({ turnId, signal: new AbortController().signal, emit: vi.fn() })
    sink.push(sentence)
    await sink.drain()
  }
  const reportRoute = liveRoute((sentence, turn) => engine.sayOutsideDelegation(sentence, turn))
  return { engine, socket, beginTurn, history, events, record, speak, reportRoute }
}

const logOf = (): Array<[string, number, string]> =>
  mocks.log.map((record) => [record.kind, 'turnId' in record ? record.turnId : -1, 'text' in record ? record.text : ''])

/** The transcript lines the renderer would leave streaming: one that another turn's line replaced before its final. */
function linesLeftStreaming(events: LiveEvent[]): Array<[string, number]> {
  const left: Array<[string, number]> = []
  const current = new Map<string, { turnId: number; final: boolean }>()
  for (const event of events) {
    if (event.type !== 'userTranscript' && event.type !== 'assistantTranscript') continue
    const line = current.get(event.type)
    if (line && !line.final && line.turnId !== event.turnId) left.push([event.type, line.turnId])
    current.set(event.type, { turnId: event.turnId, final: event.final })
  }
  return left
}

describe('what GPT-Live records while the user, the voice and brain overlap', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    mocks.log.length = 0
    mocks.history = null
    mocks.nextTurnId = 100
    mocks.t = 0
  })
  afterEach(() => vi.useRealTimers())

  it('keeps the short line and every sentence the voice reads for a delegated turn with that turn, so brain never reads the reply twice', async () => {
    const { socket, beginTurn, history, record, speak } = await setup()
    socket.input('明日の天気は')
    socket.delegate('dlg1')
    socket.output('明日の天気ですね、')
    await vi.advanceTimersByTimeAsync(600)
    expect(beginTurn.mock.calls.map((c) => c[0])).toEqual(['明日の天気は'])
    const route = beginTurn.mock.calls[0][2]
    // Brain records the utterance once its preparation is done, which is after the delegation took it.
    record({ kind: 'user', turnId: 42, text: '明日の天気は' })
    await speak(route, 42, '明日は晴れです。')
    socket.output('明日は晴れです。')
    await vi.advanceTimersByTimeAsync(3000)
    await speak(route, 42, '最高気温は20度です。')
    socket.output('最高気温は20度です。')
    await vi.advanceTimersByTimeAsync(3000)
    record({ kind: 'message', turnId: 42, role: 'assistant', parts: [{ type: 'text', text: '明日は晴れです。最高気温は20度です。' }] })
    expect(logOf().filter(([kind]) => kind === 'assistant').map(([, turnId]) => turnId)).toEqual([42, 42, 42])
    expect(history.toTranscript()).toEqual([
      { role: 'user', content: '明日の天気は' },
      { role: 'assistant', content: '明日の天気ですね、明日は晴れです。最高気温は20度です。' }
    ])
    expect(history.toMessages().filter((message) => message.role === 'assistant')).toHaveLength(1)
  })

  it('records each stretch of a reply as soon as its transcript settles, so quitting without a stop keeps it', async () => {
    const { socket, beginTurn, record, speak } = await setup()
    socket.input('明日の天気は')
    socket.delegate('dlg1')
    await vi.advanceTimersByTimeAsync(600)
    record({ kind: 'user', turnId: 42, text: '明日の天気は' })
    await speak(beginTurn.mock.calls[0][2], 42, '明日は晴れです。')
    socket.output('明日は晴れです。')
    await vi.advanceTimersByTimeAsync(1500)
    expect(logOf().at(-1)).toEqual(['assistant', 42, '明日は晴れです。'])
  })

  it('keeps a delegated reply with its turn when a job report begins before the voice has finished reading it', async () => {
    const { socket, beginTurn, history, record, speak, reportRoute } = await setup()
    socket.input('明日の天気は')
    socket.delegate('dlg1')
    await vi.advanceTimersByTimeAsync(600)
    record({ kind: 'user', turnId: 42, text: '明日の天気は' })
    record({ kind: 'message', turnId: 42, role: 'assistant', parts: [{ type: 'text', text: '晴れです。' }] })
    await speak(beginTurn.mock.calls[0][2], 42, '晴れです。')
    socket.output('明日は晴れですよ。')
    // A job report records its notice while the voice is still reading, then hands its first sentence over.
    record({ kind: 'notice', turnId: 43, notice: 'job-done', text: '[システム通知] ジョブが完了した' })
    await speak(reportRoute, 43, 'ジョブが終わりました。')
    await vi.advanceTimersByTimeAsync(1500)
    socket.output('調査のジョブが終わりました。')
    await vi.advanceTimersByTimeAsync(1500)
    expect(logOf().slice(2)).toEqual([
      ['notice', 43, '[システム通知] ジョブが完了した'],
      ['assistant', 42, '明日は晴れですよ。'],
      ['assistant', 43, '調査のジョブが終わりました。']
    ])
    expect(history.toTranscript()).toEqual([
      { role: 'user', content: '明日の天気は' },
      { role: 'assistant', content: '明日は晴れですよ。' },
      { role: 'user', content: '[システム通知] ジョブが完了した' },
      { role: 'assistant', content: '調査のジョブが終わりました。' }
    ])
    expect(history.toMessages().map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
  })

  it('hands brain the whole of an utterance the user goes on with while the voice is handed the first sentence of the reply before it', async () => {
    const { socket, beginTurn, speak } = await setup()
    socket.input('明日の天気は')
    socket.delegate('dlg1')
    await vi.advanceTimersByTimeAsync(600)
    socket.input('あと、大阪の')
    await vi.advanceTimersByTimeAsync(200)
    await speak(beginTurn.mock.calls[0][2], 42, '東京は晴れです。')
    socket.input('天気も')
    socket.delegate('dlg2')
    await vi.advanceTimersByTimeAsync(600)
    expect(beginTurn.mock.calls.map((c) => c[0])).toEqual(['明日の天気は', 'あと、大阪の天気も'])
    expect(logOf().filter(([kind]) => kind === 'user')).toEqual([])
  })

  it('hands brain the whole of an utterance a timer interjection arrives in the middle of, and records the interjection under its turn', async () => {
    const { socket, beginTurn, speak, reportRoute } = await setup()
    socket.input('明日の午後三時に')
    await vi.advanceTimersByTimeAsync(300)
    await speak(reportRoute, 7, 'タイマーが終わりました。')
    socket.output('タイマーが終わりました。')
    socket.input('会議を入れて')
    socket.delegate('dlg1')
    await vi.advanceTimersByTimeAsync(600)
    expect(beginTurn.mock.calls.map((c) => c[0])).toEqual(['明日の午後三時に会議を入れて'])
    await vi.advanceTimersByTimeAsync(1500)
    expect(logOf()).toEqual([['assistant', 7, 'タイマーが終わりました。']])
  })

  it('keeps the short line of a delegation with its turn when a sentence of the turn still running arrives while it waits, and leaves no line streaming', async () => {
    const { socket, beginTurn, history, events, record, speak } = await setup()
    socket.input('予定を調べて')
    socket.delegate('dlg1')
    await vi.advanceTimersByTimeAsync(600)
    record({ kind: 'user', turnId: 42, text: '予定を調べて' })
    const route42 = beginTurn.mock.calls[0][2]
    await speak(route42, 42, '調べますね。')
    socket.output('調べますね。')
    await vi.advanceTimersByTimeAsync(1500)
    // The user asks for something else while turn 42 runs its tool, and the voice delegates again.
    socket.input('あと天気も')
    socket.delegate('dlg2')
    socket.output('天気ですね。')
    await vi.advanceTimersByTimeAsync(100)
    // Turn 42's tool finishes, and its next sentence reaches the voice during the wait.
    await speak(route42, 42, '明日は会議が一つあります。')
    await vi.advanceTimersByTimeAsync(600)
    expect(beginTurn.mock.calls.map((c) => c[0])).toEqual(['予定を調べて', 'あと天気も'])
    record({ kind: 'user', turnId: 43, text: 'あと天気も' })
    socket.output('明日は会議が一つあります。')
    await vi.advanceTimersByTimeAsync(1500)
    expect(logOf().filter(([kind]) => kind === 'assistant')).toEqual([
      ['assistant', 42, '調べますね。'],
      ['assistant', 43, '天気ですね。'],
      ['assistant', 42, '明日は会議が一つあります。']
    ])
    expect(history.toTranscript()).toEqual([
      { role: 'user', content: '予定を調べて' },
      { role: 'assistant', content: '調べますね。明日は会議が一つあります。' },
      { role: 'user', content: 'あと天気も' },
      { role: 'assistant', content: '天気ですね。' }
    ])
    expect(linesLeftStreaming(events)).toEqual([])
  })

  it('records what the voice says on its own after a delegated reply under the utterance it answers', async () => {
    const { socket, beginTurn, history, record, speak } = await setup()
    socket.input('明日の天気は')
    socket.delegate('dlg1')
    await vi.advanceTimersByTimeAsync(600)
    record({ kind: 'user', turnId: 42, text: '明日の天気は' })
    await speak(beginTurn.mock.calls[0][2], 42, '晴れです。')
    socket.output('晴れです。')
    await vi.advanceTimersByTimeAsync(1500)
    // The voice answers a thank-you itself, and the input transcript comes after its reply began.
    socket.output('どういたしまして。')
    await vi.advanceTimersByTimeAsync(200)
    socket.input('ありがとう')
    await vi.advanceTimersByTimeAsync(1500)
    expect(logOf().slice(1)).toEqual([
      ['assistant', 42, '晴れです。'],
      ['user', 101, 'ありがとう'],
      ['assistant', 101, 'どういたしまして。']
    ])
    expect(history.toTranscript().slice(2)).toEqual([
      { role: 'user', content: 'ありがとう' },
      { role: 'assistant', content: 'どういたしまして。' }
    ])
  })
})
