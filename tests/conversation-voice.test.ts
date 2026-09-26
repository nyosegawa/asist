import { beforeEach, describe, expect, it, vi } from 'vitest'
import mitt from 'mitt'

/**
 * The conversation driven by the events of the voice pipeline: the voice controller and the speech
 * player are replaced by emitters, and the stores by plain objects.
 */

const mocks = vi.hoisted(() => {
  const turn = {
    phase: 'idle' as string,
    activeTurnId: -1,
    timings: {},
    setPhase: (phase: string) => {
      turn.phase = phase
    },
    setActiveTurn: (id: number) => {
      turn.activeTurnId = id
    },
    resetTimings: () => {},
    mergeTimings: () => {},
    setPartial: () => {},
    setRouterNote: () => {},
    setMic: () => {}
  }
  const settings: Record<string, unknown> = {}
  return {
    turn,
    settings,
    playing: false,
    readingTurn: -1,
    settingsListener: null as ((state: { settings: unknown }, before: { settings: unknown }) => void) | null,
    player: null as unknown,
    voice: null as unknown,
    live: null as unknown,
    /** The requests the conversation put on the confirmation sheet. */
    confirmOpened: [] as unknown[]
  }
})

const baseSettings = {
  aizuchi: true,
  aizuchiRate: 1,
  ttsEngine: 'voicevox',
  conversationLocale: 'ja-JP',
  voiceEngine: 'cascade',
  micAutoStart: false,
  onboardingVersion: 1,
  safetyNoticeVersion: 1,
  bargeIn: true,
  listeningAizuchi: true,
  partialIntervalMs: 600,
  localAsrEnabled: false,
  nativeMic: true,
  noiseSuppression: true,
  vapEnabled: false,
  hangoverMs: 350,
  liveIdleSeconds: 60,
  gptLive: { model: 'gpt-live', voice: 'alloy' },
  geminiLive: { model: 'gemini-live', voice: 'Puck' }
}

vi.mock('@/voice/VoiceController', async () => {
  const { default: mittFactory } = await import('mitt')
  const voiceController = {
    current: 'listening',
    msSinceBackchannel: Infinity,
    events: mittFactory(),
    handleAsrStatus: () => {},
    recover: async () => {},
    setHangover: () => {},
    enable: vi.fn(async () => {}),
    disable: vi.fn()
  }
  mocks.voice = voiceController
  return { voiceController }
})
vi.mock('@/voice/LiveVoice', async () => {
  const { default: mittFactory } = await import('mitt')
  const liveVoice = { current: 'off', events: mittFactory(), recover: async () => {}, enable: vi.fn(async () => {}), disable: vi.fn() }
  mocks.live = liveVoice
  return { liveVoice }
})
vi.mock('@/voice/SpeechPlayer', async () => {
  const { default: mittFactory } = await import('mitt')
  const speechPlayer = {
    events: mittFactory(),
    get isPlaying() {
      return mocks.playing
    },
    get readingTurn() {
      return mocks.readingTurn
    },
    isStreaming: false,
    playClip: vi.fn(() => {
      mocks.playing = true
    }),
    discardBody: vi.fn(),
    dropWaitingClips: vi.fn(),
    beginTurn: vi.fn(),
    enqueue: vi.fn(),
    interrupt: vi.fn(),
    bodyQueuedAfter: () => false,
    recover: () => {},
    streamPush: () => {},
    streamClear: () => {},
    pushSegmentAudio: () => {}
  }
  mocks.player = speechPlayer
  return { speechPlayer }
})
vi.mock('@/voice/aizuchi-bank', () => ({
  loadAizuchiBank: vi.fn(async () => {}),
  pickAizuchi: vi.fn(() => ({ text: 'はい。', category: 'flow', weight: 1, audio: 'eA==' })),
  pickListeningClip: vi.fn(() => ({ text: 'うん', audio: 'eA==' }))
}))
vi.mock('@/i18n', () => ({ translate: (key: string) => key }))
vi.mock('@/state/confirm', () => ({
  useConfirmStore: { getState: () => ({ open: (request: unknown) => mocks.confirmOpened.push(request), close: () => {} }) }
}))
vi.mock('@/state/view', () => ({
  startMiniAppReports: () => {},
  useViewStore: { getState: () => ({ openApp: () => {}, closeApp: () => {} }) }
}))
vi.mock('@/state/stores', () => {
  const plain = (extra: Record<string, unknown> = {}) => ({
    getState: () => ({
      load: async () => {},
      apply: () => {},
      push: () => {},
      reset: () => {},
      refresh: async () => {},
      loadDrafts: async () => {},
      dismissLoadingOwnedBy: () => {},
      panels: [],
      jobs: [],
      ...extra
    })
  })
  return {
    useTurnStore: { getState: () => mocks.turn },
    useFeedStore: plain({ append: () => 1, update: () => {}, appendToText: () => {}, lines: [] }),
    useJobStore: plain(),
    useLiveStore: plain(),
    usePanelStore: plain(),
    useSettingsStore: {
      getState: () => ({ settings: mocks.settings, load: async () => {} }),
      subscribe: (listener: typeof mocks.settingsListener) => {
        mocks.settingsListener = listener
        return () => {}
      }
    },
    useStatusStore: plain({ status: { asr: true, tts: true } }),
    useToastStore: plain(),
    useTaskStore: plain(),
    useNoteStore: plain(),
    useMailStore: plain()
  }
})

type Emitter = ReturnType<typeof mitt>
type Mock = ReturnType<typeof vi.fn>

const voice = (): { events: Emitter; enable: Mock; disable: Mock; current: string } =>
  mocks.voice as { events: Emitter; enable: Mock; disable: Mock; current: string }
const player = (): { events: Emitter; playClip: Mock; beginTurn: Mock } =>
  mocks.player as { events: Emitter; playClip: Mock; beginTurn: Mock }

function api(overrides: Record<string, unknown>): unknown {
  return new Proxy(overrides, {
    get(target, key: string) {
      if (key in target) return target[key]
      if (key.startsWith('on')) return () => () => {}
      if (key === 'getStatus') return async () => ({ asr: true, tts: true })
      if (key === 'confirmPending') return async () => []
      return async () => undefined
    }
  })
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** The speech end the VAD decides, 350 ms of hangover after the voice stopped. */
function speechEnd(startedAt: number, partialText = ''): { startedAt: number; speechEndAt: number; vadMs: number } {
  const now = performance.now()
  voice().events.emit('speechend', {
    startedAt,
    speechEndAt: now - 350,
    vadMs: 350,
    vadMode: 'fixed',
    partialText,
    utteranceMs: now - 350 - startedAt,
    listening: []
  })
  return { startedAt, speechEndAt: now - 350, vadMs: 350 }
}

function utterance(end: { startedAt: number; speechEndAt: number; vadMs: number }, text: string): void {
  voice().events.emit('utterance', { text, vadMode: 'fixed', asrMs: 400, partialText: '', ...end })
}

/** A whole utterance: speech end, which plays the opening "はい。", then the final transcript. */
function speak(text: string): void {
  utterance(speechEnd(performance.now() - 2500), text)
}

async function start(overrides: Record<string, unknown>): Promise<typeof import('@/conversation')> {
  vi.stubGlobal('window', { addEventListener: () => {}, api: api(overrides) })
  const conversation = await import('@/conversation')
  await conversation.initConversation()
  return conversation
}

beforeEach(() => {
  vi.resetModules()
  mocks.playing = false
  mocks.readingTurn = -1
  mocks.turn.phase = 'idle'
  mocks.turn.activeTurnId = -1
  mocks.turn.timings = {}
  mocks.confirmOpened = []
  for (const key of Object.keys(mocks.settings)) delete mocks.settings[key]
  Object.assign(mocks.settings, structuredClone(baseSettings))
  // The mocked modules survive resetModules, so the listeners of the previous test's conversation go.
  ;(mocks.voice as { events: Emitter } | null)?.events.all.clear()
  ;(mocks.player as { events: Emitter } | null)?.events.all.clear()
  vi.clearAllMocks()
  vi.stubGlobal('document', { addEventListener: () => {}, visibilityState: 'visible' })
})

describe('the opening of a speech that never becomes a turn', () => {
  it('does not play the bridge once the speech is reported dropped', async () => {
    let synthesized!: (clip: { text: string; audio: string }) => void
    await start({
      aizuchiClassify: vi.fn(async () => ({ cls: 'understand', prob: 0.9, complete: 0.9 })),
      bridgePlan: vi.fn(async () => ({ bridge: '会議の件ですね。' })),
      bridgeSynthesize: vi.fn(() => new Promise((resolve) => (synthesized = resolve)))
    })

    voice().events.emit('state', 'capturing')
    voice().events.emit('partial', '昨日の会議の件なんですけど')
    await flush()
    const { startedAt } = speechEnd(performance.now() - 3000, '昨日の会議の件なんですけど')
    await flush()
    // The final transcription fails while the bridge is being synthesized.
    voice().events.emit('speechdropped', { startedAt })
    synthesized({ text: '会議の件ですね。', audio: 'eA==' })
    await flush()

    const roles = player().playClip.mock.calls.map((call) => ((call as unknown[])[2] as { role: string }).role)
    expect(roles).toContain('aizuchi')
    expect(roles).not.toContain('bridge')
  })
})

describe('the opening of a turn that fails at once', () => {
  it('does not play the bridge whose synthesis finishes after the turn reported its error', async () => {
    let synthesized!: (clip: { text: string; audio: string }) => void
    const conversation = await start({
      aizuchiClassify: vi.fn(async () => ({ cls: 'understand', prob: 0.9, complete: 0.9 })),
      bridgePlan: vi.fn(async () => ({ bridge: '会議の件ですね。' })),
      bridgeSynthesize: vi.fn(() => new Promise((resolve) => (synthesized = resolve))),
      turnStart: vi.fn(async () => 42)
    })

    voice().events.emit('state', 'capturing')
    voice().events.emit('partial', '昨日の会議の件なんですけど')
    await flush()
    const end = speechEnd(performance.now() - 3000, '昨日の会議の件なんですけど')
    await flush()
    utterance(end, '昨日の会議の件なんですけど')
    await flush()
    // Brain fails before it says anything, for instance while it prepares the request.
    conversation.handleTurnEvent({ type: 'error', turnId: 42, message: 'no key' })
    conversation.handleTurnEvent({ type: 'done', turnId: 42, fullText: '' })
    synthesized({ text: '会議の件ですね。', audio: 'eA==' })
    await flush()

    const roles = player().playClip.mock.calls.map((call) => ((call as unknown[])[2] as { role: string }).role)
    expect(roles).toContain('aizuchi')
    expect(roles).not.toContain('bridge')
  })
})

describe('echo of what the speaker played', () => {
  const question = { turnId: 5, index: 0, text: 'クラシックとジャズ、どちらを再生しますか？', audio: 'eA==', phonemes: null }
  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  it('lets the user answer with one of the options once the question has finished', async () => {
    const turnStart = vi.fn(async () => 9)
    await start({ turnStart })
    player().events.emit('segmentstart', { segment: question, durationMs: 2500 })
    player().events.emit('idle', { turnId: 5 })
    // The user starts speaking after the echo of the question has died away.
    await wait(300)
    const startedAt = performance.now()
    await wait(30)
    utterance(speechEnd(startedAt), 'クラシック')
    await flush()

    expect(turnStart).toHaveBeenCalledOnce()
    expect((turnStart.mock.calls[0] as unknown[])[0]).toBe('クラシック')
  })

  it('drops the same words when they were captured while the question was playing', async () => {
    const turnStart = vi.fn(async () => 9)
    await start({ turnStart })
    const startedAt = performance.now()
    player().events.emit('segmentstart', { segment: question, durationMs: 2500 })
    await wait(30)
    utterance(speechEnd(startedAt), 'クラシック')
    await flush()

    expect(turnStart).not.toHaveBeenCalled()
  })

  it('keeps a word the user said when the only aizuchi clip saying it started after the capture ended', async () => {
    const turnStart = vi.fn(async () => 7)
    await start({ turnStart })
    const end = speechEnd(performance.now() - 2500)
    // The opening aizuchi that speech end queued starts sounding once it is decoded.
    await wait(5)
    player().events.emit('segmentstart', {
      segment: { turnId: -1, index: -1, text: 'はい。', audio: 'eA==', phonemes: null, clip: 'aizuchi' },
      durationMs: 400
    })
    utterance(end, 'はい、それでお願いします。')
    await flush()

    expect((turnStart.mock.calls[0] as unknown[])[0]).toBe('はい、それでお願いします。')
  })

  it('strips a listening aizuchi that sounded during the capture off the end of the transcript', async () => {
    const turnStart = vi.fn(async () => 7)
    await start({ turnStart })
    const startedAt = performance.now()
    voice().events.emit('backchannel', { kind: 'continuer', source: 'text' })
    const [audio, text] = player().playClip.mock.calls[0] as [string, string]
    player().events.emit('segmentstart', {
      segment: { turnId: -1, index: -1, text, audio, phonemes: null, clip: 'listening' },
      durationMs: 300
    })
    await wait(5)
    utterance(speechEnd(startedAt), '昨日の資料なんですけど、うん。')
    await flush()

    expect((turnStart.mock.calls[0] as unknown[])[0]).toBe('昨日の資料なんですけど')
  })
})

describe('a barge-in', () => {
  it('aborts the turn whose request was still waiting for its id instead of reading its reply', async () => {
    let answer!: (turnId: number) => void
    const turnStart = vi.fn(() => new Promise<number>((resolve) => (answer = resolve)))
    const turnAbort = vi.fn(async () => {})
    await start({ turnStart, turnAbort })

    speak('明日の天気を教えて')
    await flush()
    // The user carries on over the opening "はい。", and the voice controller confirms a barge-in.
    voice().events.emit('bargein', undefined)
    answer(42)
    await flush()

    expect(turnAbort).toHaveBeenCalledWith(42)
    expect(player().beginTurn).not.toHaveBeenCalledWith(42, expect.anything())
    expect(mocks.turn.activeTurnId).toBe(-1)
  })

  it('is counted against a reply that is still being read after brain reported it done', async () => {
    const metricsLog = vi.fn(async (_payload: Record<string, unknown>) => {})
    const conversation = await start({ turnStart: vi.fn(async () => 42), metricsLog })
    mocks.turn.timings = { vadMs: 350 }
    speak('明日の天気を教えて')
    await flush()
    mocks.playing = true
    mocks.readingTurn = 42
    player().events.emit('segmentstart', {
      segment: { turnId: 42, index: 0, text: '明日は晴れです。', audio: 'eA==', phonemes: null },
      durationMs: 3000
    })
    conversation.handleTurnEvent({ type: 'done', turnId: 42, fullText: '明日は晴れです。' })

    // The voice controller reports the barge-in, then the player stops and reports the turn it stopped.
    voice().events.emit('bargein', undefined)
    mocks.playing = false
    mocks.readingTurn = -1
    player().events.emit('idle', { turnId: 42 })
    await flush()

    const payloads = metricsLog.mock.calls.map((call) => call[0])
    expect(payloads.at(-1)).toMatchObject({ bargeIns: 1 })
  })
})

describe('the phase shown after a turn', () => {
  it('leaves think once the opening clip of a turn that already ended finishes', async () => {
    const conversation = await start({ turnStart: vi.fn(async () => 42) })
    speak('明日の予定を登録して')
    await flush()
    expect(mocks.turn.phase).toBe('think')

    // The turn fails at once, for instance without an API key, while "はい。" still sounds.
    conversation.handleTurnEvent({ type: 'error', turnId: 42, message: 'no key' })
    conversation.handleTurnEvent({ type: 'done', turnId: 42, fullText: '' })
    mocks.playing = false
    player().events.emit('idle', { turnId: 42 })

    expect(mocks.turn.phase).toBe('idle')
  })

  it('stays on think while the turn is still under way after its opening clip ends', async () => {
    await start({ turnStart: vi.fn(async () => 42) })
    speak('明日の予定を登録して')
    await flush()
    mocks.playing = false
    player().events.emit('idle', { turnId: 42 })

    expect(mocks.turn.phase).toBe('think')
  })
})

describe('the global shortcut and the tray item that turn the microphone on', () => {
  async function pressShortcut(): Promise<void> {
    let hotkey!: () => void
    await start({
      onHotkeyMic: (callback: () => void) => {
        hotkey = callback
        return () => {}
      }
    })
    voice().current = 'off'
    hotkey()
    await flush()
    voice().current = 'listening'
  }

  it('leave the microphone off during the first-run setup', async () => {
    Object.assign(mocks.settings, { onboardingVersion: 0, safetyNoticeVersion: 0 })
    await pressShortcut()
    expect(voice().enable).not.toHaveBeenCalled()
  })

  it('leave the microphone off while the notice of the risks is unanswered', async () => {
    Object.assign(mocks.settings, { onboardingVersion: 1, safetyNoticeVersion: 0 })
    await pressShortcut()
    expect(voice().enable).not.toHaveBeenCalled()
  })

  it('turn the microphone on once both are answered', async () => {
    await pressShortcut()
    expect(voice().enable).toHaveBeenCalledOnce()
  })
})

describe('a change of how long a quiet live session stays open', () => {
  it('turns the microphone off, since main stops the live engine for it', async () => {
    Object.assign(mocks.settings, { voiceEngine: 'gpt-live' })
    await start({})
    const live = mocks.live as { current: string; disable: Mock }
    live.current = 'on'
    const before = structuredClone(mocks.settings)
    const after = { ...before, liveIdleSeconds: 120 }

    mocks.settingsListener!({ settings: after }, { settings: before })

    expect(live.disable).toHaveBeenCalled()
    live.current = 'off'
  })
})

describe('a page that loads while main waits for the answer to a confirmation', () => {
  it('puts every request main is waiting on onto the sheet, asking for them only once it listens for new ones', async () => {
    const request = { id: 'c1', title: 't', message: 'm', detail: 'd', confirmLabel: 'ok', destructive: false, holdsConversation: true }
    const calls: string[] = []
    await start({
      onConfirmEvent: () => {
        calls.push('listen')
        return () => {}
      },
      confirmPending: async () => {
        calls.push('ask')
        return [request]
      }
    })
    expect(calls).toEqual(['listen', 'ask'])
    expect(mocks.confirmOpened).toEqual([request])
  })
})
