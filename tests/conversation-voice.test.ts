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
    live: null as unknown
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
vi.mock('@/state/confirm', () => ({ useConfirmStore: { getState: () => ({ open: () => {}, close: () => {} }) } }))
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
