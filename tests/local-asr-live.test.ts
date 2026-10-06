import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ASR_MODEL_SPECS, type ResolvedAsrModel } from '@shared/asr-models'
import type { ConversationLocale } from '@shared/conversation-locale'

/**
 * The local speech recognition through ASIST's own worker client and the bundled speech (node
 * scripts/prepare-resources.mjs dev), on model files laid out as the app lays them out under
 * <folder>/speech-models, and on recordings whose texts the official Qwen3-ASR wrote:
 *
 *   SPEECH_LIVE_USER_DATA=<folder> ASR_LIVE_CLIPS=<clips> npx vitest run tests/local-asr-live.test.ts --silent=false --reporter=verbose
 *
 * <clips> holds WAVE files, 16-bit PCM or 32-bit float at 16 kHz, and requests.json, a list of
 * { model, input, kind, language, official } where `kind` "forced" names the text the official implementation wrote
 * with the language forced. It prints how long each worker took to become ready and each recording to its text.
 */

const userData = process.env.SPEECH_LIVE_USER_DATA
const clips = process.env.ASR_LIVE_CLIPS

const mocks = vi.hoisted(() => ({
  settings: { uiLocale: 'ja-JP', conversationLocale: 'ja-JP' as ConversationLocale }
}))
vi.mock('../src/main/services/platform', () => import('./helpers/platform'))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => mocks.settings }))
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => path.resolve('.'), getPath: () => process.env.SPEECH_LIVE_USER_DATA, on: vi.fn() }
}))

/** The mono samples of a 16 kHz WAVE file of 16-bit PCM or 32-bit float. */
function readWave(file: string): Float32Array {
  const wav = fs.readFileSync(file)
  let offset = 12
  let format = 0
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    if (id === 'fmt ') {
      format = wav.readUInt16LE(offset + 8)
      if (wav.readUInt16LE(offset + 10) !== 1 || wav.readUInt32LE(offset + 12) !== 16_000) throw new Error(`${file} is not 16 kHz mono`)
    }
    if (id === 'data') {
      const data = wav.subarray(offset + 8, offset + 8 + size)
      if (format === 3) return new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length))
      if (format === 1) return Float32Array.from({ length: data.length / 2 }, (_, index) => data.readInt16LE(index * 2) / 32_768)
      throw new Error(`${file} has format ${format}`)
    }
    offset += 8 + size
  }
  throw new Error(`${file} has no data`)
}

/** The edit distance between two texts, by code point, over the length of the second. */
function errorRate(text: string, reference: string): number {
  const a = [...text]
  const b = [...reference]
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    previous = current
  }
  return previous[b.length] / Math.max(1, b.length)
}

interface Request { model: string; input: string; kind: string; language: string | null; official: string }

const LOCALES: Record<string, ConversationLocale> = { ja: 'ja-JP', en: 'en-US' }
const SIZES: Array<[ResolvedAsrModel, string]> = [['qwen3-asr-1.7b', 'Qwen3-ASR-1.7B'], ['qwen3-asr-0.6b', 'Qwen3-ASR-0.6B']]

describe.skipIf(!userData || !clips)('the local speech recognition on the real speech worker', () => {
  let local: typeof import('../src/main/services/local-asr')
  const requests = (): Request[] => (JSON.parse(fs.readFileSync(path.join(clips!, 'requests.json'), 'utf8')) as Request[])
    .filter((request) => request.kind === 'forced' && request.language !== null && request.language in LOCALES)

  beforeAll(async () => {
    const { HOST, setCapabilities } = await import('./helpers/platform')
    setCapabilities(HOST)
    local = await import('../src/main/services/local-asr')
  })
  afterAll(() => local.stop())

  describe.each(SIZES)('%s', (size, name) => {
    const spec = ASR_MODEL_SPECS[size]

    it('loads', async () => {
      const started = performance.now()
      await expect(local.ensureWorker(spec)).resolves.toBe(true)
      console.log(`${spec.label}: ready after ${((performance.now() - started) / 1000).toFixed(2)} s`)
    }, 240_000)

    it('writes the official text of each recording, with its language forced', async () => {
      const rows = requests().filter((request) => request.model === name)
      expect(rows.length).toBeGreaterThan(0)
      const rates: number[] = []
      for (const request of rows) {
        mocks.settings.conversationLocale = LOCALES[request.language!]
        const samples = readWave(path.join(clips!, `${request.input}.wav`))
        const started = performance.now()
        const text = await local.transcribe(spec, samples)
        const seconds = (performance.now() - started) / 1000
        const rate = errorRate(text, request.official)
        rates.push(rate)
        console.log(`${spec.label} ${request.input} (${(samples.length / 16_000).toFixed(2)} s of audio, ${request.language}): ${seconds.toFixed(3)} s, ${text === request.official ? 'the official text' : `${(rate * 100).toFixed(1)}% from the official text`}\n  ours:     ${text}\n  official: ${request.official}`)
      }
      // Q8_0 on a GPU may take another word where the official model's margin between two is within its error.
      expect(rates.filter((rate) => rate === 0).length).toBeGreaterThanOrEqual(rows.length / 2)
    }, 240_000)

    it('writes a partial text of the last five seconds of a recording', async () => {
      mocks.settings.conversationLocale = 'ja-JP'
      const [request] = requests().filter((row) => row.model === name && row.input === 'ja_jp-2630315561484880103')
      const samples = readWave(path.join(clips!, `${request.input}.wav`))
      const started = performance.now()
      const text = await local.transcribePartial(spec, samples.slice(-5 * 16_000))
      console.log(`${spec.label} partial of the last 5 s of ${request.input}: ${((performance.now() - started) / 1000).toFixed(3)} s\n  ${text}\n  of: ${request.official}`)
      expect(text).not.toBe('')
    }, 60_000)
  })
})
