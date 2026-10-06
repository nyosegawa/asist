import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ASR_MODEL_SPECS, type AsrModel } from '@shared/asr-models'
import type { ConversationLocale } from '@shared/conversation-locale'
import { errorText } from '@shared/i18n/error-text'
import { SPEECH_CPP_SERIES, WORKER_PROTOCOL } from '../src/main/services/speech-worker'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  downloadMissing: vi.fn(),
  settings: { uiLocale: 'en-US', conversationLocale: 'ja-JP' as ConversationLocale, asrModel: 'auto' as AsrModel }
}))
vi.mock('../src/main/services/platform', () => import('./helpers/platform'))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => mocks.settings }))
vi.mock('../src/main/services/pinned-download', () => ({ downloadMissing: mocks.downloadMissing }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/app', getPath: () => '/user-data', on: vi.fn() } }))

const LARGE = ASR_MODEL_SPECS['qwen3-asr-1.7b']
const SMALL = ASR_MODEL_SPECS['qwen3-asr-0.6b']

function fakeChild() {
  const input: Array<Record<string, unknown>> = []
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    killed: false, exitCode: null as number | null, kill: vi.fn(), input
  })
  child.kill.mockImplementation(() => { child.killed = true; return true })
  let buffered = ''
  child.stdin.on('data', (data) => {
    buffered += String(data)
    const lines = buffered.split('\n')
    buffered = lines.pop()!
    for (const line of lines) input.push(JSON.parse(line))
  })
  return child
}
type Child = ReturnType<typeof fakeChild>

const say = (child: Child, message: Record<string, unknown>): void => { child.stdout.write(`${JSON.stringify(message)}\n`) }
/** The `ready` of a 0.7 worker of a recognition model on the GPU the capabilities chose, with the model information in part. */
const ready = (model: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'ready',
  protocol: WORKER_PROTOCOL,
  version: `${SPEECH_CPP_SERIES}.1`,
  model: { name: 'Qwen3-ASR-1.7B', task: 'recognition', sample_rate: 16_000, device: 'MTL0', threads: 0, languages: ['en', 'ja'], ...model }
})
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))
/** The ids of the recognition requests a worker has been sent, in the order of their `transcribe`. */
const transcribed = (child: Child): string[] => child.input.filter((message) => message.type === 'transcribe').map((message) => message.id as string)
/** Answers a recognition request with its text. */
const answer = (child: Child, id: string, text: string): void => say(child, { type: 'end', id, text, stop: 'complete' })

let children: Child[] = []
/** Whether a new worker reports ready on its own, as a loaded model would. */
let loads = true
let asr: typeof import('../src/main/services/local-asr')

beforeEach(async () => {
  vi.resetModules()
  mocks.settings.asrModel = 'auto'
  mocks.settings.conversationLocale = 'ja-JP'
  children = []
  loads = true
  vi.spyOn(fs, 'existsSync').mockReturnValue(true)
  mocks.spawn.mockReset().mockImplementation(() => {
    const child = fakeChild()
    children.push(child)
    if (loads) setTimeout(() => say(child, ready()), 0)
    return child
  })
  asr = await import('../src/main/services/local-asr')
})
afterEach(() => {
  vi.useRealTimers()
  asr.stop()
  vi.restoreAllMocks()
  for (const child of children) {
    child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy()
  }
})

/** Starts a final transcription and resolves, once the worker has its request, to the worker, the id and the outcome. */
async function underWay(id = 'final'): Promise<{ child: Child; id: string; outcome: Promise<string | Error> }> {
  const outcome = asr.transcribe(LARGE, new Float32Array(1600), id).catch((error: Error) => error)
  await vi.waitFor(() => expect(children.at(-1) && transcribed(children.at(-1)!)).toContain(id))
  return { child: children.at(-1)!, id, outcome }
}

describe('the speech recognition worker', () => {
  it('runs speech worker on the model file of the size, on the GPU the capabilities chose', async () => {
    await expect(asr.ensureWorker(LARGE)).resolves.toBe(true)
    const [command, args] = mocks.spawn.mock.calls[0] as [string, string[]]
    expect(path.basename(command)).toMatch(/^speech(\.exe)?$/)
    expect(args.map((arg) => (arg.endsWith('.gguf') ? path.basename(arg) : arg))).toEqual(['worker', LARGE.model.file, '--device', 'MTL0'])
    expect(asr.available(LARGE)).toBe(true)
  })

  it('sends an utterance as its 16-bit samples and a transcribe in the conversation language, and returns the text of the end', async () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25])
    const outcome = asr.transcribe(LARGE, samples, 'r1')
    await vi.waitFor(() => expect(transcribed(children[0])).toEqual(['r1']))
    const [chunk, transcribe] = children[0].input
    expect(chunk).toEqual({ type: 'chunk', id: 'r1', seq: 0, pcm: expect.any(String) })
    const bytes = Buffer.from(chunk.pcm as string, 'base64')
    expect(Array.from(new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2))).toEqual([0, 16_384, -16_384, 32_767, -32_768, 8_192])
    // Nothing else rides along: the worker refuses a member a request does not have.
    expect(transcribe).toEqual({ type: 'transcribe', id: 'r1', sample_rate: 16_000, language: 'ja' })
    answer(children[0], 'r1', ' こんにちは。 ')
    await expect(outcome).resolves.toBe('こんにちは。')
  })

  it('reads the conversation language for each utterance, so that a change applies without loading the model again', async () => {
    const first = await underWay('first')
    answer(first.child, first.id, 'はい。')
    await first.outcome
    mocks.settings.conversationLocale = 'es-419'
    const second = await underWay('second')
    expect(second.child.input.find((message) => message.type === 'transcribe' && message.id === 'second')).toMatchObject({ language: 'es' })
    expect(children).toHaveLength(1)
  })

  it('returns the text written up to the limit of a recognition that reached the most tokens the model writes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { child, id, outcome } = await underWay()
    say(child, { type: 'end', id, text: 'とても長い', stop: 'model_limit' })
    await expect(outcome).resolves.toBe('とても長い')
    expect(warn).toHaveBeenCalled()
  })

  it('sends the transcriptions that waited for the worker to load in the order they were asked for', async () => {
    loads = false
    const first = asr.transcribe(LARGE, new Float32Array(1600), 'first')
    const second = asr.transcribe(LARGE, new Float32Array(1600), 'second')
    await vi.waitFor(() => expect(children).toHaveLength(1))
    say(children[0], ready())
    await vi.waitFor(() => expect(transcribed(children[0])).toEqual(['first', 'second']))
    answer(children[0], 'first', '一つ目。')
    answer(children[0], 'second', '二つ目。')
    await expect(Promise.all([first, second])).resolves.toEqual(['一つ目。', '二つ目。'])
    expect(children).toHaveLength(1)
  })

  it('fails a transcription the worker refuses with the worker\'s reason, and keeps the worker for the next one', async () => {
    const { child, id, outcome } = await underWay()
    say(child, { type: 'error', id, error: { code: 'out_of_range', option: 'language', message: 'not a language of the model' } })
    expect(((await outcome) as Error).message).toBe('out_of_range (language): not a language of the model')
    expect(child.kill).not.toHaveBeenCalled()
    expect(asr.available(LARGE)).toBe(true)
  })

  it('fails the transcription under way when the worker exits, and starts a new worker for the next one', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { child, outcome } = await underWay()
    child.exitCode = 1
    child.emit('exit', 1)
    expect(((await outcome) as Error).message).toContain('exited')
    const next = await underWay('next')
    expect(next.child).not.toBe(child)
    answer(next.child, 'next', 'はい。')
    await expect(next.outcome).resolves.toBe('はい。')
  })

  it.each([
    ['an end without its text', (id: string) => ({ type: 'end', id, stop: 'complete' })],
    ['an end with a stop a recognition does not have', (id: string) => ({ type: 'end', id, text: 'はい。', stop: 'max_seconds' })],
    ['a chunk of audio, which only a synthesis has', (id: string) => ({ type: 'chunk', id, seq: 0, pcm: '' })],
    ['a cancel ASIST did not ask for', (id: string) => ({ type: 'cancelled', id })]
  ])('stops the worker and fails the transcription when the worker answers with %s', async (_case, message) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { child, id, outcome } = await underWay()
    say(child, message(id))
    expect(await outcome).toBeInstanceOf(Error)
    expect(child.kill).toHaveBeenCalled()
    expect(asr.available(LARGE)).toBe(false)
  })

  it('keeps a transcription the worker reports progress on', async () => {
    const { child, id, outcome } = await underWay()
    say(child, { type: 'progress', id, done: 0.5 })
    answer(child, id, 'はい。')
    await expect(outcome).resolves.toBe('はい。')
  })

  it('stops a cancelled transcription with the reason the user sees, cancels it in the worker, and keeps the worker', async () => {
    const { child, id, outcome } = await underWay()
    expect(asr.cancelTranscription(id)).toBe(true)
    expect(((await outcome) as Error).message).toBe(errorText('speechRecognition.errors.stopped'))
    await vi.waitFor(() => expect(child.input).toContainEqual({ type: 'cancel', id }))
    say(child, { type: 'cancelled', id })
    await settle()
    expect(child.kill).not.toHaveBeenCalled()
    expect(asr.available(LARGE)).toBe(true)
  })

  it('stops the worker when a transcription goes unanswered for a minute, with the reason the user sees', async () => {
    vi.useFakeTimers()
    const outcome = asr.transcribe(LARGE, new Float32Array(1600), 'hung').catch((error: Error) => error)
    await vi.advanceTimersByTimeAsync(10)
    expect(transcribed(children[0])).toEqual(['hung'])
    await vi.advanceTimersByTimeAsync(59_000)
    expect(children[0].kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(((await outcome) as Error).message).toBe(errorText('speechRecognition.errors.timedOut'))
    expect(children[0].kill).toHaveBeenCalled()
  })

  it('gives a transcription its full time even when the worker took longer than that to load', async () => {
    vi.useFakeTimers()
    loads = false
    const outcome = asr.transcribe(LARGE, new Float32Array(1600), 'slow-start')
    await vi.advanceTimersByTimeAsync(90_000)
    say(children[0], ready())
    await vi.advanceTimersByTimeAsync(10)
    answer(children[0], 'slow-start', 'はい。')
    await expect(outcome).resolves.toBe('はい。')
    expect(children).toHaveLength(1)
    expect(children[0].kill).not.toHaveBeenCalled()
  })

  it('fails a transcription that waits for the worker to load with the reason the user sees when the microphone stops it', async () => {
    loads = false
    const outcome = asr.transcribe(LARGE, new Float32Array(1600), 'waiting').catch((error: Error) => error)
    await vi.waitFor(() => expect(children).toHaveLength(1))
    asr.stop()
    expect(((await outcome) as Error).message).toBe(errorText('speechRecognition.errors.stopped'))
    expect(children[0].kill).toHaveBeenCalled()
  })

  it('answers whether the worker is ready without waiting for one that is still loading', async () => {
    loads = false
    const starting = asr.ensureWorker(LARGE)
    await vi.waitFor(() => expect(children).toHaveLength(1))
    expect(asr.available(LARGE)).toBe(false)
    expect(asr.isStarting(LARGE)).toBe(true)
    say(children[0], ready())
    await expect(starting).resolves.toBe(true)
    expect(asr.available(LARGE)).toBe(true)
    expect(asr.isStarting(LARGE)).toBe(false)
  })

  it('stops a worker still loading one model and starts the other when the model changes', async () => {
    loads = false
    const first = asr.ensureWorker(LARGE)
    await vi.waitFor(() => expect(children).toHaveLength(1))
    const second = asr.ensureWorker(SMALL)
    await expect(first).resolves.toBe(false)
    expect(children[0].kill).toHaveBeenCalled()
    say(children[1], ready({ name: 'Qwen3-ASR-0.6B' }))
    await expect(second).resolves.toBe(true)
    expect(path.basename((mocks.spawn.mock.calls[1] as [string, string[]])[1][1])).toBe(SMALL.model.file)
    expect(asr.available(SMALL)).toBe(true)
  })

  it.each([
    ['a model for another task', ready({ task: 'synthesis', sample_rate: 24_000 })],
    ['a model on another device than the one asked for', ready({ device: 'CPU' })],
    ['a release of another series', { ...ready(), version: '0.6.2' }],
    ['fatal instead of ready', { type: 'fatal', error: { code: 'model_file', option: null, message: 'no speech.layout' } }]
  ])('starts nothing to recognize with when the worker reports %s', async (_case, first) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    loads = false
    const starting = asr.ensureWorker(LARGE)
    await vi.waitFor(() => expect(children).toHaveLength(1))
    say(children[0], first)
    await expect(starting).resolves.toBe(false)
    expect(children[0].kill).toHaveBeenCalled()
    expect(asr.available(LARGE)).toBe(false)
  })

  it('starts nothing while the file of the model is missing', async () => {
    vi.mocked(fs.existsSync).mockImplementation((file) => !String(file).endsWith(LARGE.model.file))
    await expect(asr.ensureWorker(LARGE)).resolves.toBe(false)
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('fails loudly when the app shipped without speech', async () => {
    vi.mocked(fs.existsSync).mockImplementation((file) => !/speech(\.exe)?$/.test(String(file)))
    await expect(asr.ensureWorker(LARGE)).rejects.toThrow()
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
})

describe('a partial transcription', () => {
  it('is recognized and returned while nothing else is in flight', async () => {
    await asr.ensureWorker(LARGE)
    const partial = asr.transcribePartial(LARGE, new Float32Array(1600))
    await vi.waitFor(() => expect(transcribed(children[0])).toHaveLength(1))
    answer(children[0], transcribed(children[0])[0], '途中まで')
    await expect(partial).resolves.toBe('途中まで')
  })

  it('is skipped while a final transcription is in flight, which it would only delay', async () => {
    const { child, id, outcome } = await underWay()
    await expect(asr.transcribePartial(LARGE, new Float32Array(1600))).resolves.toBe('')
    expect(transcribed(child)).toEqual([id])
    answer(child, id, '最後まで。')
    await expect(outcome).resolves.toBe('最後まで。')
  })

  it('is given up after four seconds and cancelled in the worker, and the next is skipped until the worker has answered the cancel', async () => {
    vi.useFakeTimers()
    const started = asr.ensureWorker(LARGE)
    await vi.advanceTimersByTimeAsync(10)
    await started
    const partial = asr.transcribePartial(LARGE, new Float32Array(1600))
    await vi.advanceTimersByTimeAsync(10)
    const [id] = transcribed(children[0])
    await vi.advanceTimersByTimeAsync(4_000)
    await expect(partial).resolves.toBe('')
    expect(children[0].input).toContainEqual({ type: 'cancel', id })
    await expect(asr.transcribePartial(LARGE, new Float32Array(1600))).resolves.toBe('')
    expect(transcribed(children[0])).toHaveLength(1)
    say(children[0], { type: 'cancelled', id })
    await vi.advanceTimersByTimeAsync(10)
    const next = asr.transcribePartial(LARGE, new Float32Array(1600))
    await vi.advanceTimersByTimeAsync(10)
    expect(transcribed(children[0])).toHaveLength(2)
    answer(children[0], transcribed(children[0])[1], '次')
    await expect(next).resolves.toBe('次')
  })

  it('returns nothing when the worker refuses it, rather than failing the conversation', async () => {
    await asr.ensureWorker(LARGE)
    const partial = asr.transcribePartial(LARGE, new Float32Array(1600))
    await vi.waitFor(() => expect(transcribed(children[0])).toHaveLength(1))
    say(children[0], { type: 'error', id: transcribed(children[0])[0], error: { code: 'internal', option: null, message: 'failed' } })
    await expect(partial).resolves.toBe('')
  })
})

describe('the model the setting stands for', () => {
  let service: typeof import('../src/main/services/asr')
  /** Ends the download of the prepared model's file, which takes minutes in the app. */
  let finishDownload: () => void
  const modelOf = (call: unknown[]): string => path.basename((call[1] as string[])[1])

  beforeEach(async () => {
    service = await import('../src/main/services/asr')
    // Qwen3-ASR 0.6B is installed and 1.7B is not, until its download ends.
    let largeInstalled = false
    vi.mocked(fs.existsSync).mockImplementation((file) => largeInstalled || path.basename(String(file)) !== LARGE.model.file)
    mocks.downloadMissing.mockReset().mockImplementation((_files: unknown, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        finishDownload = () => {
          largeInstalled = true
          resolve()
        }
      }))
  })

  it('keeps the worker and the transcription under way when the setting moves from auto to the model auto stands for', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    // Auto stands for 1.7B on the fixture's 32 GB Mac.
    await expect(service.ensureWorker()).resolves.toBe(true)
    const transcription = service.transcribe(new Float32Array(1600), 'under-way')
    await vi.waitFor(() => expect(transcribed(children[0])).toEqual(['under-way']))

    mocks.settings.asrModel = 'qwen3-asr-1.7b'
    await expect(service.switchModel('auto')).resolves.toBe(true)
    answer(children[0], 'under-way', 'はい。')

    await expect(transcription).resolves.toBe('はい。')
    expect(children).toHaveLength(1)
    expect(children[0].kill).not.toHaveBeenCalled()
  })

  it('stops the worker, and the transcription under way with the reason the user sees, when the setting moves to another model', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    await service.ensureWorker()
    const transcription = service.transcribe(new Float32Array(1600), 'under-way').catch((error: Error) => error)
    await vi.waitFor(() => expect(transcribed(children[0])).toEqual(['under-way']))

    mocks.settings.asrModel = 'qwen3-asr-0.6b'
    await expect(service.switchModel('auto')).resolves.toBe(true)

    expect(((await transcription) as Error).message).toBe(errorText('speechRecognition.errors.stopped'))
    expect(children[0].kill).toHaveBeenCalled()
    expect(mocks.spawn.mock.calls.map(modelOf)).toEqual([LARGE.model.file, SMALL.model.file])
  })

  it('keeps the worker of the model the setting names when a preparation of another model ends after the user turned back', async () => {
    mocks.settings.asrModel = 'qwen3-asr-0.6b'
    await service.ensureWorker()
    mocks.settings.asrModel = 'qwen3-asr-1.7b'
    await expect(service.switchModel('qwen3-asr-0.6b')).resolves.toBe(false)
    const preparation = service.prepareModel('qwen3-asr-1.7b', () => {})
    await vi.waitFor(() => expect(mocks.downloadMissing).toHaveBeenCalled())

    // The download is slow, and the user goes back to 0.6B.
    mocks.settings.asrModel = 'qwen3-asr-0.6b'
    await expect(service.switchModel('qwen3-asr-1.7b')).resolves.toBe(true)
    const selected = children.at(-1)!
    finishDownload()

    expect((await preparation).ok).toBe(true)
    expect(mocks.spawn.mock.calls.map(modelOf)).toEqual([SMALL.model.file, SMALL.model.file])
    expect(selected.kill).not.toHaveBeenCalled()
    await expect(service.available()).resolves.toBe(true)
  })

  it('keeps the worker of the model the setting names when the user cancels the preparation of a model they turned away from', async () => {
    mocks.settings.asrModel = 'qwen3-asr-1.7b'
    const preparation = service.prepareModel('qwen3-asr-1.7b', () => {})
    await vi.waitFor(() => expect(mocks.downloadMissing).toHaveBeenCalled())
    mocks.settings.asrModel = 'qwen3-asr-0.6b'
    await expect(service.switchModel('qwen3-asr-1.7b')).resolves.toBe(true)

    expect(service.cancelPreparation()).toBe(true)
    expect((await preparation).ok).toBe(false)
    expect(children[0].kill).not.toHaveBeenCalled()
    await expect(service.available()).resolves.toBe(true)
  })
})
