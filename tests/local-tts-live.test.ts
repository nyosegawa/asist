import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { IRODORI_TTS_VOICE_IDS, type QwenTtsSize } from '@shared/tts-models'
import type { TtsEngine } from '@shared/ipc'

/**
 * The local speech synthesis through ASIST's own worker client and the bundled speech (node
 * scripts/prepare-resources.mjs dev), on model files laid out as the app lays them out under
 * <folder>/speech-models:
 *
 *   SPEECH_LIVE_USER_DATA=<folder> npx vitest run tests/local-tts-live.test.ts --silent=false --reporter=verbose
 *
 * It prints how long each worker took to become ready and each sentence to its first audio.
 */

const userData = process.env.SPEECH_LIVE_USER_DATA

const mocks = vi.hoisted(() => ({
  settings: { uiLocale: 'ja-JP', ttsEngine: 'irodori' as TtsEngine, qwenTtsSize: '0.6b' as QwenTtsSize }
}))
vi.mock('../src/main/services/platform', () => import('./helpers/platform'))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => mocks.settings }))
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => path.resolve('.'), getPath: () => process.env.SPEECH_LIVE_USER_DATA, on: vi.fn() }
}))

const SENTENCE = '明日の東京は晴れのち曇りで、夕方から少し風が強くなるでしょう。'

describe.skipIf(!userData)('the local speech synthesis on the real speech worker', () => {
  let local: typeof import('../src/main/services/local-tts')

  beforeAll(async () => {
    const { HOST, setCapabilities } = await import('./helpers/platform')
    setCapabilities(HOST)
    local = await import('../src/main/services/local-tts')
  })
  afterAll(() => local.stop())

  /** Reads the sentence and returns the seconds to the first piece, the seconds of speech and the rate. */
  async function read(engine: 'irodori' | 'qwen3tts', voice: string): Promise<{ first: number; seconds: number }> {
    const started = performance.now()
    let first = 0
    let samples = 0
    for await (const piece of local.stream(engine, { text: SENTENCE, voice, language: 'ja' })) {
      first ||= (performance.now() - started) / 1000
      samples += piece.length
    }
    return { first, seconds: samples / local.sampleRate() }
  }

  async function load(engine: 'irodori' | 'qwen3tts'): Promise<void> {
    const started = performance.now()
    await expect(local.ensureWorker(engine)).resolves.toBe(true)
    console.log(`${engine}: ready after ${((performance.now() - started) / 1000).toFixed(2)} s`)
  }

  it.each(IRODORI_TTS_VOICE_IDS)('reads a Japanese sentence with Irodori-TTS in the voice %s', async (voice) => {
    mocks.settings.ttsEngine = 'irodori'
    if (!local.available('irodori')) await load('irodori')
    const { first, seconds } = await read('irodori', voice)
    console.log(`irodori ${voice}: first audio ${first.toFixed(3)} s, ${seconds.toFixed(2)} s of speech at ${local.sampleRate()} Hz`)
    // A natural reading of the sentence takes about four seconds.
    expect(seconds).toBeGreaterThan(2)
    expect(seconds).toBeLessThan(10)
  }, 240_000)

  it('reads a Japanese sentence with Qwen3-TTS 0.6B', async () => {
    mocks.settings.ttsEngine = 'qwen3tts'
    mocks.settings.qwenTtsSize = '0.6b'
    await load('qwen3tts')
    const { first, seconds } = await read('qwen3tts', 'ono_anna')
    console.log(`qwen3tts 0.6b ono_anna: first audio ${first.toFixed(3)} s, ${seconds.toFixed(2)} s of speech at ${local.sampleRate()} Hz`)
    expect(seconds).toBeGreaterThan(2)
    expect(seconds).toBeLessThan(10)
  }, 240_000)
})
