import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  conversationLocale: 'ja-JP',
  connect: vi.fn(async () => ({}))
}))

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    readonly live = { connect: mocks.connect }
  },
  Behavior: { NON_BLOCKING: 'NON_BLOCKING' },
  FunctionResponseScheduling: { WHEN_IDLE: 'WHEN_IDLE', INTERRUPT: 'INTERRUPT', SILENT: 'SILENT' },
  Modality: { AUDIO: 'AUDIO' },
  ThinkingLevel: { MINIMAL: 'MINIMAL', LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH' }
}))
vi.mock('../src/main/services/settings', () => ({
  getSettings: () => ({ conversationLocale: mocks.conversationLocale })
}))

const params = {
  model: 'gemini-3.8-live',
  systemInstruction: 'system',
  voice: 'Puck',
  functionDeclarations: [],
  resumptionHandle: null,
  callbacks: { onmessage: vi.fn(), onerror: vi.fn(), onclose: vi.fn() }
}

async function connectedConfig(model = params.model): Promise<{
  speechConfig: { languageCode: string }
  inputAudioTranscription: { languageCodes: string[] }
  outputAudioTranscription: { languageCodes: string[] }
  thinkingConfig?: { thinkingLevel?: string }
}> {
  const { connectGemini } = await import('../src/main/services/live/gemini-connect')
  await connectGemini('key', { ...params, model })
  return mocks.connect.mock.calls.at(-1)![0].config
}

beforeEach(() => {
  vi.resetModules()
  mocks.connect.mockClear()
  mocks.conversationLocale = 'ja-JP'
})

describe('the Gemini Live connection', () => {
  it('pins every language of the session to Japanese while the conversation is Japanese', async () => {
    const config = await connectedConfig()
    expect(config.speechConfig.languageCode).toBe('ja-JP')
    expect(config.inputAudioTranscription.languageCodes).toEqual(['ja-JP'])
    expect(config.outputAudioTranscription.languageCodes).toEqual(['ja-JP'])
  })

  it('pins them to the conversation language, and to a region the speech APIs know', async () => {
    mocks.conversationLocale = 'es-419'
    const config = await connectedConfig()
    expect(config.speechConfig.languageCode).toBe('es-MX')
    expect(config.inputAudioTranscription.languageCodes).toEqual(['es-MX'])
    expect(config.outputAudioTranscription.languageCodes).toEqual(['es-MX'])
  })

  it('opens the extended-thinking model with a thinking level it accepts, since the Live API closes its session at setup without one', async () => {
    const config = await connectedConfig('gemini-3.8-live-extended-thinking')
    // Measured on 2026-10-02: the model refuses no level and MINIMAL, and opens with the others.
    expect(['LOW', 'MEDIUM', 'HIGH']).toContain(config.thinkingConfig?.thinkingLevel)
  })
})
