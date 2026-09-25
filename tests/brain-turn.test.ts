import fs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import mitt from 'mitt'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TurnEvent } from '@shared/ipc'
import type { ConversationMessage, ConversationPart, ConversationResult, StopReason } from '@shared/conversation'
import { marker } from '@shared/conversation-markers'
import { createTranslator } from '@shared/i18n'
import { lastRoundNote } from '@shared/tool-round'
import { interruptedBeforeReply, interruptedWhileSpeaking, resumeAfterDisconnectNote } from '@shared/turn-recovery'

const LAST_ROUND_NOTE = lastRoundNote('ja-JP')
const INTERRUPTED_BEFORE_REPLY = interruptedBeforeReply('ja-JP')
const INTERRUPTED_WHILE_SPEAKING = interruptedWhileSpeaking('ja-JP')
const RESUME_AFTER_DISCONNECT_NOTE = resumeAfterDisconnectNote('ja-JP')

/**
 * These tests run a whole brain turn against a fake conversation stream in place of the llm service and a fake TTS,
 * so that resuming after a disconnect, the history after an interruption, the round limit and the conversation log
 * are exercised together.
 */

type Handler = (...args: unknown[]) => void

interface RoundEmitter {
  /** Streams the chunks as deltas and closes the text block. */
  text: (...chunks: string[]) => void
  /** Streams a delta without closing the block, as for a sentence cut off midway. */
  textDelta: (chunk: string) => void
  toolUse: (id: string, name: string, input: Record<string, unknown>) => void
  /** Rejects once the caller aborts the turn, and never resolves otherwise. */
  untilAborted: () => Promise<never>
}

type RoundScript = (round: RoundEmitter) => Promise<{ stop?: StopReason }>

const USAGE = { input: 100, cacheRead: 900, cacheCreation: 0, output: 20 }

class FakeStream {
  private readonly handlers = new Map<string, Handler[]>()
  private readonly parts: ConversationPart[] = []
  private openText = ''
  constructor(
    private readonly script: RoundScript,
    private readonly signal: AbortSignal | undefined
  ) {}

  on(event: string, handler: Handler): this {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
    return this
  }

  private fire(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args)
  }

  snapshot(): ConversationMessage | null {
    const parts = [...this.parts]
    if (this.openText) parts.push({ type: 'text', text: this.openText })
    return parts.length > 0 ? { role: 'assistant', parts } : null
  }

  async final(): Promise<ConversationResult> {
    const emitter: RoundEmitter = {
      text: (...chunks) => {
        for (const chunk of chunks) this.fire('text', chunk)
        this.parts.push({ type: 'text', text: chunks.join('') })
      },
      textDelta: (chunk) => {
        this.openText += chunk
        this.fire('text', chunk)
      },
      toolUse: (id, name, input) => {
        const call = { type: 'tool_call' as const, id, name, input }
        this.parts.push(call)
        this.fire('toolCall', call)
      },
      untilAborted: () =>
        new Promise<never>((_, reject) => {
          const abort = (): void => reject(new DOMException('aborted', 'AbortError'))
          if (this.signal?.aborted) abort()
          else this.signal?.addEventListener('abort', abort, { once: true })
        })
    }
    const partial = await this.script(emitter)
    return { message: { role: 'assistant', parts: [...this.parts] }, stop: partial.stop ?? 'end', usage: USAGE }
  }
}

const mocks = vi.hoisted(() => ({
  userData: '',
  rounds: [] as Array<(round: RoundEmitter) => Promise<{ stop?: StopReason }>>,
  requests: [] as Array<{ messages: ConversationMessage[]; system: Array<{ text: string }> }>,
  fetchPanel: vi.fn(),
  conversationLocale: 'ja-JP' as 'ja-JP' | 'en-US'
}))

vi.mock('../src/main/services/store', () => ({
  dataPath: (...parts: string[]) => path.join(mocks.userData, ...parts)
}))
vi.mock('../src/main/services/llm', () => ({
  providerKey: () => 'test-key',
  quickText: vi.fn(async () => ''),
  streamConversation: (request: { messages: ConversationMessage[]; system: Array<{ text: string }>; signal?: AbortSignal }) => {
    mocks.requests.push({ messages: structuredClone(request.messages), system: request.system })
    const script = mocks.rounds.shift()
    if (!script) throw new Error('no scripted round left')
    return new FakeStream(script, request.signal)
  }
}))
vi.mock('../src/main/services/settings', () => ({
  getSettings: () => ({
    uiLocale: 'ja-JP',
    conversationLocale: mocks.conversationLocale,
    region: 'JP',
    persona: '',
    conversationModel: { provider: 'anthropic', id: 'claude-sonnet-5' },
    bridgeModel: { provider: 'anthropic', id: 'claude-haiku-4-5-20251001' },
    conversationLogRetentionDays: 30,
    agentMode: 'readonly'
  })
}))
vi.mock('../src/main/services/tts', () => ({
  synthesizeSentence: async () => ({ kind: 'whole', audio: null, phonemes: null })
}))
vi.mock('../src/main/services/agent', () => ({
  events: mitt(),
  contextBlock: () => null,
  findActive: () => undefined,
  start: vi.fn(),
  get: () => undefined,
  list: () => [],
  getLog: () => [],
  cancel: vi.fn(),
  continueJob: vi.fn(),
  isGitRepo: () => false,
  startIsolated: vi.fn(),
  merge: vi.fn(),
  discard: vi.fn()
}))
vi.mock('../src/main/services/aizuchi', () => ({ randomClip: async () => null }))
vi.mock('../src/main/services/memory', () => ({
  promptBlock: () => null,
  list: () => [{ id: 'm1', file: 'pages/中野.md', line: 3, kind: 'section', page: '中野', heading: '要約', aliases: [], text: '最寄り駅は中野', date: '2026-09-01', order: 0 }],
  search: vi.fn(() => [])
}))
vi.mock('../src/main/services/panel-fetchers', () => ({ fetchPanel: mocks.fetchPanel }))
vi.mock('../src/main/services/user-local-data', () => ({ getLocalDataService: () => ({}) }))
vi.mock('../src/main/services/user-tasks', () => ({ getTaskService: () => ({}) }))
vi.mock('../src/main/services/timers', () => ({ create: vi.fn() }))

type Brain = typeof import('../src/main/services/brain')

async function loadBrain(): Promise<{ brain: Brain; events: TurnEvent[] }> {
  const brain = await import('../src/main/services/brain')
  const events: TurnEvent[] = []
  brain.events.on('event', (event) => events.push(event))
  return { brain, events }
}

/** The history derived from the conversation log, which is the messages sent with the next request. */
async function historyMessages(): Promise<ConversationMessage[]> {
  const { history } = await import('../src/main/services/brain/session')
  return history.toMessages()
}

const textOf = (message: ConversationMessage): string => message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('')
const said = (text: string): ConversationMessage => ({ role: 'assistant', parts: [{ type: 'text', text }] })

function runToDone(brain: Brain, text: string): Promise<number> {
  return new Promise((resolve) => {
    brain.events.on('event', (event) => {
      if (event.type === 'done' && event.turnId === turnId) resolve(turnId)
    })
    const turnId = brain.startTurn(text)
  })
}

const readLog = (): Array<Record<string, unknown>> => {
  const dir = path.join(mocks.userData, 'conversations')
  const [file] = fs.readdirSync(dir)
  return fs
    .readFileSync(path.join(dir, file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

const lastUserParts = (request: { messages: ConversationMessage[] }): ConversationPart[] => request.messages.at(-1)!.parts

describe('brain turn', () => {
  // The first import of the brain transforms its whole module graph, and the imports after vi.resetModules
  // reuse that work. It took 399 ms alone but 5762 ms while `npm run demo:fit` kept three headless
  // Chromes busy (10-core Mac, 2026-09-24), which timed out whichever test came first. Importing once here moves
  // that cost into a hook with a timeout of its own.
  beforeAll(async () => {
    await import('../src/main/services/brain')
  }, 30_000)

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    // clearAllMocks keeps implementations, so fetchPanel is reset explicitly: an implementation that only settles on
    // abort would otherwise block the next test.
    mocks.fetchPanel.mockReset()
    mocks.userData = mkdtempSync(path.join(tmpdir(), 'asist-brain-'))
    mocks.rounds = []
    mocks.requests = []
    mocks.conversationLocale = 'ja-JP'
  })

  it('speaks the reply of a normal turn, keeps it in the history and the conversation log, and reports usage in metrics', async () => {
    mocks.rounds.push(async (round) => {
      round.text('明日は', '晴天です。')
      return {}
    })
    const { brain, events } = await loadBrain()
    await runToDone(brain, '明日の天気は')

    expect(events.filter((e) => e.type === 'segment').map((e) => e.type === 'segment' && e.segment.text)).toEqual(['明日は晴天です。'])
    const messages = await historyMessages()
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    const today = new Date()
    const weekday = '日月火水木金土'[today.getDay()]
    expect(textOf(messages[0])).toMatch(
      new RegExp(`^\\[${today.getFullYear()}/${today.getMonth() + 1}/${today.getDate()}\\(${weekday}\\) \\d\\d:\\d\\d\\] 明日の天気は$`)
    )
    // The history keeps exactly the shape that was sent to the API.
    expect(messages[1]).toEqual(said('明日は晴天です。'))
    const usage = events.find((e) => e.type === 'metrics' && 'inputTokens' in e.timings)
    expect(usage).toMatchObject({ timings: { inputTokens: 100, cacheReadTokens: 900, contextTokens: 1000, rounds: 1, toolCalls: 0 } })
    expect(readLog().map((r) => [r.kind, r.text])).toEqual([
      ['user', '明日の天気は'],
      ['message', undefined],
      ['assistant', '明日は晴天です。']
    ])
    expect(readLog()[1]).toMatchObject({ kind: 'message', role: 'assistant', parts: [{ type: 'text', text: '明日は晴天です。' }] })
  })

  it('resumes exactly once after a disconnect that happens mid-reply, carrying the confirmed text and the tool results', async () => {
    mocks.fetchPanel.mockResolvedValue({ props: { location: '東京都', weather: { targetDate: '2026-09-16', summary: '晴天' } }, source: 'open-meteo' })
    mocks.rounds.push(async (round) => {
      round.text('調べますね。')
      round.toolUse('t1', 'show_weather', { location: '東京都' })
      round.textDelta('少々')
      throw new Error('fetch failed')
    })
    mocks.rounds.push(async (round) => {
      round.text('明日は晴天です。')
      return {}
    })
    const { brain, events } = await loadBrain()
    await runToDone(brain, '明日の天気は')

    expect(mocks.requests).toHaveLength(2)
    const resumed = mocks.requests[1].messages.slice(-2)
    expect(resumed[0]).toEqual({
      role: 'assistant',
      parts: [
        { type: 'text', text: '調べますね。' },
        { type: 'tool_call', id: 't1', name: 'show_weather', input: { location: '東京都' } },
        { type: 'text', text: '少々' }
      ]
    })
    expect(resumed[1].role).toBe('user')
    expect(resumed[1].parts[0]).toMatchObject({ type: 'tool_result', callId: 't1', name: 'show_weather' })
    expect(resumed[1].parts.at(-1)).toMatchObject({ type: 'text', text: RESUME_AFTER_DISCONNECT_NOTE })
    // No apology is spoken; only the continuation is.
    expect(events.some((e) => e.type === 'error')).toBe(false)
    // The messages added for the resume stay in the history, and the continuation comes last.
    const carried = await historyMessages()
    expect(carried.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(textOf(carried[1])).toContain('調べますね。')
    expect(textOf(carried[2])).toContain(RESUME_AFTER_DISCONNECT_NOTE)
    expect(carried.at(-1)).toEqual(said('明日は晴天です。'))
    expect(events.find((e) => e.type === 'metrics' && 'resumed' in e.timings)).toMatchObject({ timings: { resumed: true, rounds: 1 } })
  })

  it('does not resume a second disconnect and reports it as an API failure', async () => {
    mocks.rounds.push(async (round) => {
      round.text('一回目。')
      throw new Error('fetch failed')
    })
    mocks.rounds.push(async (round) => {
      round.text('二回目。')
      throw new Error('fetch failed')
    })
    const { brain, events } = await loadBrain()
    await runToDone(brain, 'x')
    expect(mocks.requests).toHaveLength(2)
    expect(events.some((e) => e.type === 'error')).toBe(true)
    // The first reply was already sent as part of the resume, so only the second one, which was never sent, is kept
    // together with the failure marker.
    const carried = await historyMessages()
    expect(textOf(carried[1])).toContain('一回目。')
    expect(carried.at(-1)).toEqual(said('二回目。(応答が途中で失敗した)'))
  })

  it.each(['non-transient', 'resumed'] as const)('stops tools that have not started on a %s failure and closes the turn after the running one finishes', async (failure) => {
    let finishFetch!: () => void
    let fetchSignal: AbortSignal | undefined
    mocks.fetchPanel.mockImplementation((_type, _props, signal: AbortSignal) => {
      fetchSignal = signal
      return new Promise((resolve) => {
        finishFetch = () => resolve({ props: { location: '東京都', weather: { targetDate: '2026-09-16', summary: '晴天' } }, source: 'test' })
      })
    })
    if (failure === 'resumed') {
      mocks.rounds.push(async (round) => {
        round.text('調べます。')
        throw new Error('fetch failed')
      })
    }
    mocks.rounds.push(async (round) => {
      round.toolUse('weather', 'show_weather', { location: '東京都' })
      round.toolUse('agent', 'run_agent_task', { prompt: '調査を始める' })
      await vi.waitFor(() => expect(fetchSignal).toBeDefined())
      throw failure === 'resumed' ? new Error('fetch failed') : Object.assign(new Error('bad request'), { status: 400 })
    })
    const { brain, events } = await loadBrain()
    const handle = brain.beginTurn({ text: '天気を調べて、調査も始めて' }, {}, 'user', false)!
    try {
      await vi.waitFor(() => expect(fetchSignal?.aborted).toBe(true))
      expect(events.some((event) => event.type === 'done')).toBe(false)
    } finally {
      finishFetch?.()
      await handle.completion
    }
    const agent = await import('../src/main/services/agent')
    expect(agent.start).not.toHaveBeenCalled()
    const doneIndex = events.findIndex((event) => event.type === 'done')
    expect(doneIndex).toBeGreaterThan(-1)
    expect(events.slice(doneIndex + 1)).toEqual([])
    expect(events.some((event) => event.type === 'panel' && event.event.op === 'patch' && event.event.state === 'ready')).toBe(false)
  })

  it('marks the text that was already spoken when the turn is interrupted mid-reply and keeps it in the history', async () => {
    mocks.rounds.push(async (round) => {
      round.text('明日は晴天で、')
      return round.untilAborted()
    })
    const { brain, events } = await loadBrain()
    const done = new Promise<void>((resolve) => {
      brain.events.on('event', (e) => e.type === 'done' && resolve())
    })
    const turnId = brain.startTurn('明日の天気は')
    await vi.waitFor(() => expect(events.some((e) => e.type === 'delta')).toBe(true))
    brain.abortTurn(turnId)
    await done

    const carried = await historyMessages()
    expect(carried.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(textOf(carried[0])).toContain('明日の天気は')
    expect(carried[1]).toEqual(said(`明日は晴天で、${INTERRUPTED_WHILE_SPEAKING}`))
    expect(readLog().at(-1)).toMatchObject({ kind: 'assistant', text: '明日は晴天で、', interrupted: 'while-speaking' })
  })

  it('keeps the user utterance and marks the assistant side when the interruption comes before any reply', async () => {
    mocks.rounds.push(async (round) => round.untilAborted())
    const { brain, events } = await loadBrain()
    const done = new Promise<void>((resolve) => {
      brain.events.on('event', (e) => e.type === 'done' && resolve())
    })
    const turnId = brain.startTurn('明日の天気は')
    await vi.waitFor(() => expect(mocks.requests).toHaveLength(1))
    brain.abortTurn(turnId)
    await done

    const carried = await historyMessages()
    expect(carried.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(textOf(carried[0])).toContain('明日の天気は')
    expect(carried[1]).toEqual(said(INTERRUPTED_BEFORE_REPLY))
    expect(readLog().at(-1)).toMatchObject({ kind: 'assistant', text: '', interrupted: 'before-reply' })
    expect(events.some((e) => e.type === 'error')).toBe(false)
  })

  it.each(['result', 'error'] as const)('moves on without waiting for the earlier memory search when the user rephrases, and keeps a late %s out of the history', async (late) => {
    const memory = await import('../src/main/services/memory')
    let finishSearch!: (hits: Awaited<ReturnType<typeof memory.search>>) => void
    let failSearch!: (error: Error) => void
    const heldSearch = new Promise<Awaited<ReturnType<typeof memory.search>>>((resolve, reject) => {
      finishSearch = resolve
      failSearch = reject
    })
    vi.mocked(memory.search).mockReturnValueOnce(heldSearch)
    mocks.rounds.push(async (round) => { round.text('明後日ですね。'); return {} })
    const { brain, events } = await loadBrain()
    const first = brain.beginTurn({ text: '明日の天気は' }, {}, 'user', false)!
    await vi.waitFor(() => expect(memory.search).toHaveBeenCalledOnce())
    const second = brain.beginTurn({ text: 'あ、明後日で' }, {}, 'user', false)!
    let complete = false
    void second.completion.then(() => { complete = true })
    try {
      await vi.waitFor(() => expect(complete).toBe(true), { timeout: 300 })
      expect(memory.search).toHaveBeenNthCalledWith(1, '明日の天気は', { limit: 8, mode: 'utterance' }, first.signal)
      expect(first.signal.aborted).toBe(true)
      expect(mocks.requests).toHaveLength(1)
      expect(JSON.stringify(mocks.requests[0])).toContain(INTERRUPTED_BEFORE_REPLY)
      expect(readLog().filter((r) => r.kind !== 'message').map((r) => [r.kind, r.turnId, r.text])).toEqual([
        ['user', first.turnId, '明日の天気は'],
        ['assistant', first.turnId, ''],
        ['user', second.turnId, 'あ、明後日で'],
        ['assistant', second.turnId, '明後日ですね。']
      ])
      const before = readLog()
      if (late === 'result') finishSearch([{ record: memory.list()[0], score: 1, exact: true, via: 'lexical' }])
      else failSearch(new Error('old search failed'))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(readLog()).toEqual(before)
      expect((await historyMessages()).map(textOf)).toEqual([
        expect.stringContaining('明日の天気は'), INTERRUPTED_BEFORE_REPLY,
        expect.stringContaining('あ、明後日で'), '明後日ですね。'
      ])
      expect(events.filter((e) => e.type === 'done').map((e) => e.turnId)).toEqual([first.turnId, second.turnId])
      expect(events.some((e) => e.type === 'error')).toBe(false)
    } finally {
      finishSearch([])
      await Promise.all([first.completion, second.completion])
    }
  })

  it('records the input and the failure of a turn that fails while preparing, and closes it with done', async () => {
    const { brain, events } = await loadBrain()
    const { history } = await import('../src/main/services/brain/session')
    vi.spyOn(history, 'needsCompaction').mockImplementationOnce(() => { throw new Error('preparation failed') })
    await runToDone(brain, '予定を教えて')
    expect(mocks.requests).toEqual([])
    expect(readLog()).toMatchObject([
      { kind: 'user', text: '予定を教えて' },
      { kind: 'assistant', text: '', failed: true }
    ])
    expect(events.some((e) => e.type === 'error')).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it.each(['user', 'notice'] as const)('lets a %s turn proceed over the limit without waiting for compaction, which folds only the turns up to its start', async (kind) => {
    const { brain, events } = await loadBrain()
    const { history, record, LIMIT_TOKENS } = await import('../src/main/services/brain/session')
    const { quickText } = await import('../src/main/services/llm')
    history.ensureLoaded()
    // The 30 most recent turns are kept, so more than that are recorded here.
    for (let i = 0; i < 50; i++) {
      record({ kind: 'user', turnId: 100 + i, text: `以前の質問${i}` })
      record({ kind: 'assistant', turnId: 100 + i, text: `以前の回答${i}` })
    }
    history.noteContextTokens(LIMIT_TOKENS + 1)
    let finishSummary!: (text: string) => void
    const heldSummary = new Promise<string>((resolve) => { finishSummary = resolve })
    vi.mocked(quickText).mockReturnValueOnce(heldSummary)
    const input = kind === 'notice'
      ? { text: '作業が完了しました', notice: 'job-done' as const }
      : { text: '明日の天気は' }
    mocks.rounds.push(async (round) => { round.text('はい、進めます。'); return {} })
    const first = brain.beginTurn(input, {}, 'user', false)!
    try {
      // Compaction starts, but the turn sends its request with the current history instead of waiting for the summary.
      await vi.waitFor(() => expect(events.some((e) => e.type === 'done' && e.turnId === first.turnId)).toBe(true), { timeout: 1000 })
      expect(quickText).toHaveBeenCalledOnce()
      expect(mocks.requests).toHaveLength(1)
      expect(mocks.requests[0].messages.length).toBe(101)
      expect(history.summary).toBe('')
    } finally {
      finishSummary('以前の会話の引き継ぎ')
      await Promise.all([first.completion, history.compact('quiet')])
    }
    // The 30 turns that were most recent at the start (20 to 49) and the turns recorded afterwards stay as they are,
    // while turns 0 to 19 become the summary.
    expect(history.summary).toBe('以前の会話の引き継ぎ')
    const log = vi.mocked(quickText).mock.calls[0][1]
    expect(log).toContain('ユーザー: 以前の質問19')
    expect(log).not.toContain('以前の質問20')
    const contents = (await historyMessages()).map(textOf)
    expect(contents).toHaveLength(62)
    expect(contents[0]).toContain('以前の質問20')
    expect(contents.slice(-2)).toEqual([expect.stringContaining(input.text), 'はい、進めます。'])
    const checkpoint = readLog().findLast((r) => r.kind === 'checkpoint')!
    expect(checkpoint.summary).toBe('以前の会話の引き継ぎ')
    expect((checkpoint.records as Array<{ kind: string; turnId: number }>).slice(-3).map((r) => [r.kind, r.turnId])).toEqual([
      [kind, first.turnId], ['message', first.turnId], ['assistant', first.turnId]
    ])
    // The next turn carries the summary in system and rebuilds the history from what stayed.
    mocks.rounds.push(async (round) => { round.text('了解です。'); return {} })
    await runToDone(brain, '続けて')
    expect(mocks.requests[1].messages.length).toBe(63)
    expect(mocks.requests[1].system.some((block) => block.text.includes('以前の会話の引き継ぎ'))).toBe(true)
  })

  it('returns tool results in the order of the calls, marks a failure with isError, and logs each tool name and result length', async () => {
    mocks.fetchPanel.mockRejectedValueOnce(new Error('HTTP 503'))
    mocks.rounds.push(async (round) => {
      round.text('見てみますね。')
      round.toolUse('t1', 'show_weather', { location: '東京都' })
      round.toolUse('t2', 'recall', { query: '中野' })
      return { stop: 'tool_calls' }
    })
    mocks.rounds.push(async (round) => {
      round.text('天気は取れませんでした。')
      return {}
    })
    const { brain, events } = await loadBrain()
    await runToDone(brain, '天気と記憶')

    const results = lastUserParts(mocks.requests[1]) as Array<Extract<ConversationPart, { type: 'tool_result' }>>
    expect(results.map((r) => [r.callId, r.name])).toEqual([['t1', 'show_weather'], ['t2', 'recall']])
    expect(results[0]).toMatchObject({ isError: true })
    expect(results[0].content).toContain('HTTP 503')
    expect(results[1].isError).toBeUndefined()
    expect(JSON.parse(results[1].content)).toMatchObject({ count: 0 })
    expect(events.filter((e) => e.type === 'tool').map((e) => e.type === 'tool' && `${e.name}:${e.status}`)).toEqual(
      expect.arrayContaining(['show_weather:start', 'show_weather:error', 'recall:start', 'recall:done'])
    )
    const toolRecords = readLog().filter((r) => r.kind === 'tool')
    expect(toolRecords.map((r) => r.name).sort()).toEqual(['recall', 'show_weather'])
    expect(toolRecords.find((r) => r.name === 'show_weather')).toMatchObject({ isError: true, input: '{"location":"東京都"}' })
    expect(toolRecords.find((r) => r.name === 'recall')!.resultLength).toBeGreaterThan(10)
    expect(events.find((e) => e.type === 'metrics' && 'toolCalls' in e.timings)).toMatchObject({ timings: { toolCalls: 2, rounds: 2 } })
  })

  it('keeps the tool call and its result from the previous turn in the next request and only appends to the history', async () => {
    mocks.fetchPanel.mockResolvedValueOnce({ props: { location: '東京都', weather: { targetDate: '2026-09-16', temp: 28, forecast: 'x'.repeat(500) } }, source: 'open-meteo' })
    mocks.rounds.push(async (round) => {
      round.toolUse('t1', 'show_weather', { location: '東京都' })
      return { stop: 'tool_calls' }
    })
    mocks.rounds.push(async (round) => {
      round.text('晴天です。')
      return {}
    })
    mocks.rounds.push(async (round) => {
      round.text('はい。')
      return {}
    })
    const { brain } = await loadBrain()
    await runToDone(brain, '東京の天気')
    await runToDone(brain, 'ありがとう')
    const messages = mocks.requests[2].messages
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user'])
    expect(messages[1].parts).toEqual([{ type: 'tool_call', id: 't1', name: 'show_weather', input: { location: '東京都' } }])
    expect(JSON.stringify(messages[2].parts)).toContain('x'.repeat(500))
    expect(messages[3]).toEqual(said('晴天です。'))
    // The messages sent in the previous turn become the prefix of the next request unchanged.
    expect(messages.slice(0, 4)).toEqual([...mocks.requests[1].messages.slice(0, 3), said('晴天です。')])
  })

  it('appends an injected memory to the last user message, keeps it on the user record and in the history, and does not inject it again while it is still in the raw window', async () => {
    const { search } = await import('../src/main/services/memory')
    const hit = { via: 'lexical', exact: true, record: { id: 'm1', file: 'pages/中野.md', line: 3, kind: 'section', page: '中野', heading: '要約', aliases: [], text: '最寄り駅', date: '2026-09-01', order: 0 } }
    ;(search as unknown as ReturnType<typeof vi.fn>).mockReturnValue([hit])
    mocks.rounds.push(async (round) => {
      round.text('中野ですね。')
      return {}
    })
    mocks.rounds.push(async (round) => {
      round.text('十分くらいです。')
      return {}
    })
    const { brain, events } = await loadBrain()
    await runToDone(brain, '最寄り駅どこだっけ')
    const sent = textOf(mocks.requests[0].messages.at(-1)!)
    expect(sent).toContain('最寄り駅どこだっけ')
    expect(sent.endsWith('\n\n[記憶]\n# 中野\n\n## 要約\n最寄り駅')).toBe(true)
    // The note and the memory id stay on the user record of the conversation log and do not mix into the text.
    const logged = readLog().find((r) => r.kind === 'user')
    expect(logged).toMatchObject({ text: '最寄り駅どこだっけ', memoryIds: ['m1'] })
    expect(String(logged?.notes)).toBe('[記憶]\n# 中野\n\n## 要約\n最寄り駅')
    // In the history the note follows the text as well, so it matches what the model read.
    expect(textOf((await historyMessages())[0])).toContain('最寄り駅どこだっけ\n\n[記憶]\n# 中野\n\n## 要約\n最寄り駅')

    await runToDone(brain, '駅まで歩いて何分')
    expect(textOf(mocks.requests[1].messages.at(-1)!)).not.toContain('[記憶]')
    // The note of the previous turn is still sent as part of the history.
    expect(JSON.stringify(mocks.requests[1].messages[0])).toContain('# 中野')
    const injected = events
      .filter((e): e is Extract<TurnEvent, { type: 'metrics' }> => e.type === 'metrics' && 'injectedMemories' in e.timings)
      .map((e) => e.timings.injectedMemories)
    expect(injected).toEqual([1, 0])
  })

  it('appends the typed-input note to the last user message and keeps it in the same shape, so the prefix does not change', async () => {
    mocks.rounds.push(async (round) => {
      round.text('はい。')
      return {}
    })
    const { brain } = await loadBrain()
    await new Promise<void>((resolve) => {
      brain.events.on('event', (e) => e.type === 'done' && resolve())
      brain.startTurn('テスト', { typed: true })
    })
    const sent = textOf(mocks.requests[0].messages.at(-1)!)
    expect(sent).toContain('[注: 文字入力]')
    expect(textOf((await historyMessages())[0])).toBe(sent)
  })

  it('stamps and annotates the utterance in the conversation language, and says nothing about a backchannel where none plays', async () => {
    mocks.conversationLocale = 'en-US'
    mocks.rounds.push(async (round) => {
      round.text('Sure.')
      return {}
    })
    const { brain } = await loadBrain()
    await new Promise<void>((resolve) => {
      brain.events.on('event', (e) => e.type === 'done' && resolve())
      // The renderer sends no aizuchi outside Japanese, but it does send the bridge it has already played.
      brain.startTurn('what is the weather', { typed: true, bridge: 'The weather, right.' })
    })
    const sent = textOf(mocks.requests[0].messages.at(-1)!)
    expect(sent).toMatch(/^\[\w{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}\] what is the weather/)
    expect(sent).toContain(marker('en-US', 'typedInputNote'))
    expect(sent).toContain('the short line "The weather, right."')
    expect(textOf((await historyMessages())[0])).toBe(sent)
  })

  it('attaches the open mini app to the utterance with the id of what it shows, and keeps it in the history', async () => {
    mocks.rounds.push(async (round) => {
      round.text('はい。')
      return {}
    })
    const { brain } = await loadBrain()
    const { reportOpenMiniApp } = await import('../src/main/services/mini-app-view')
    reportOpenMiniApp({ app: 'mail', box: 'inbox', accountId: null, query: '', pane: { kind: 'message', id: 'acct:INBOX:42' } })
    await new Promise<void>((resolve) => {
      brain.events.on('event', (e) => e.type === 'done' && resolve())
      brain.startTurn('これに返信して')
    })
    const sent = textOf(mocks.requests[0].messages.at(-1)!)
    expect(sent).toContain(marker('ja-JP', 'openApp'))
    expect(sent).toContain('acct:INBOX:42')
    expect(textOf((await historyMessages())[0])).toBe(sent)
  })

  it('says nothing about the screen while only the conversation is open', async () => {
    mocks.rounds.push(async (round) => {
      round.text('はい。')
      return {}
    })
    const { brain } = await loadBrain()
    const { reportOpenMiniApp } = await import('../src/main/services/mini-app-view')
    reportOpenMiniApp(null)
    await new Promise<void>((resolve) => {
      brain.events.on('event', (e) => e.type === 'done' && resolve())
      brain.startTurn('こんにちは')
    })
    expect(textOf(mocks.requests[0].messages.at(-1)!)).not.toContain(marker('ja-JP', 'openApp'))
  })

  it('reports the cache miss reason as first on the initial turn and as hit on the next one, which only appended history', async () => {
    mocks.rounds.push(async (round) => {
      round.text('一。')
      return {}
    })
    mocks.rounds.push(async (round) => {
      round.text('二。')
      return {}
    })
    const { brain, events } = await loadBrain()
    await runToDone(brain, 'a')
    await runToDone(brain, 'b')
    const reasons = events
      .filter((e) => e.type === 'metrics' && 'cacheMissReason' in e.timings)
      .map((e) => (e.type === 'metrics' ? e.timings.cacheMissReason : null))
    expect(reasons).toEqual(['first', 'hit'])
  })

  it('adds the note to finish on the next round one round before the limit, and stops with a fixed sentence at the limit', async () => {
    for (let i = 0; i < 6; i++) {
      mocks.rounds.push(async (round) => {
        round.toolUse(`t${i}`, 'recall', { query: '中野' })
        return { stop: 'tool_calls' }
      })
    }
    const { brain, events } = await loadBrain()
    await runToDone(brain, '延々と')

    expect(mocks.requests).toHaveLength(6)
    expect(lastUserParts(mocks.requests[5]).at(-1)).toMatchObject({ type: 'text', text: LAST_ROUND_NOTE })
    expect(lastUserParts(mocks.requests[4]).every((part) => part.type === 'tool_result')).toBe(true)
    const error = events.find((e) => e.type === 'error')
    expect(error).toMatchObject({ message: createTranslator('ja-JP')('spoken.turnStopped') })
  })

  /**
   * The sentence is spoken aloud, so it follows the language of the conversation. The interface stays
   * Japanese here, which is what tells a lookup in the wrong dictionary from a right one.
   */
  it('speaks the sentence that ends a turn at the round limit in the language of the conversation', async () => {
    mocks.conversationLocale = 'en-US'
    for (let i = 0; i < 6; i++) {
      mocks.rounds.push(async (round) => {
        round.toolUse(`t${i}`, 'recall', { query: '中野' })
        return { stop: 'tool_calls' }
      })
    }
    const { brain, events } = await loadBrain()
    await runToDone(brain, 'on and on')
    const spoken = createTranslator('en-US')('spoken.turnStopped')
    expect(events.find((e) => e.type === 'error')).toMatchObject({ message: spoken })
    // What was said is what was sent to the speaker, not only to the screen.
    const segments = events.flatMap((e) => (e.type === 'segment' ? [e.segment.text] : []))
    expect(segments).toContain(spoken)
  })

  it('records an interjected sentence as the assistant in the conversation log', async () => {
    mocks.rounds.push(async (round) => {
      round.text('終わりましたよ。')
      return {}
    })
    const { brain } = await loadBrain()
    // A job completion report starts from an agent event, a path this test cannot drive directly.
    const { interject } = await import('../src/main/services/brain/interject')
    await interject('タイマーが終わりました。')
    expect(readLog().at(-1)).toMatchObject({ kind: 'assistant', text: 'タイマーが終わりました。' })
  })

  it('hands each sentence to the voice route, adds no aizuchi note, puts the division of roles in system, and records no assistant entry', async () => {
    mocks.rounds.push(async (round) => {
      round.text('明日は', '晴天です。')
      return {}
    })
    const { brain, events } = await loadBrain()
    const spoken: string[] = []
    const route = { kind: 'live' as const, open: () => ({ push: (sentence: string) => void spoken.push(sentence), drain: async () => {} }) }
    const handle = brain.beginTurn({ text: '明日の天気は' }, { aizuchi: 'はい。', bridgePending: true }, 'live', false, { route })!
    await handle.completion

    expect(spoken).toEqual(['明日は晴天です。'])
    expect(events[0]).toMatchObject({ type: 'started', turnId: handle.turnId, origin: 'live' })
    expect(events.some((e) => e.type === 'segment')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'done', fullText: '明日は晴天です。' })
    const request = mocks.requests[0]
    expect(JSON.stringify(lastUserParts(request))).not.toContain('相槌')
    expect(request.system[0].text).toContain('# 声の担当との分担')
    expect(request.system[0].text).not.toContain('# つなぎ文')
    // The live engine records what was actually spoken from its output transcript, so brain keeps only the user turn
    // and the shape sent to the API.
    expect(readLog().map((r) => r.kind)).toEqual(['user', 'message'])
  })

})
