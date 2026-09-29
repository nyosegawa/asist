import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ASR_MODEL_SPECS } from '@shared/asr-models'
import { errorText } from '@shared/i18n/error-text'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('../src/main/services/platform', () => import('./helpers/platform'))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ uiLocale: 'en-US', conversationLocale: 'ja-JP' }) }))
vi.mock('../src/main/services/conversation-locale', () => ({ conversationLocale: () => 'ja-JP' }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/app', getPath: () => '/user-data', on: vi.fn() } }))

const MODEL = ASR_MODEL_SPECS['qwen3-asr-1.7b']

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stderr: new PassThrough(),
    killed: false,
    exitCode: null as number | null,
    kill: vi.fn()
  })
  child.kill.mockImplementation(() => {
    child.killed = true
    child.exitCode = 0
    child.emit('exit', 0)
    return true
  })
  return child
}

interface Started {
  child: ReturnType<typeof fakeChild>
  args: string[]
}
let started: Started[] = []
let answer: (body: Record<string, unknown>) => Promise<Response> = async () => chat('language Japanese<asr_text>こんにちは。')
const requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = []

const chat = (content: string): Response => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
const argAfter = (args: string[], flag: string): string => args[args.indexOf(flag) + 1]
let asr: typeof import('../src/main/services/llama-asr')

beforeEach(async () => {
  vi.resetModules()
  started = []
  requests.length = 0
  answer = async () => chat('language Japanese<asr_text>こんにちは。')
  vi.spyOn(fs, 'existsSync').mockReturnValue(true)
  mocks.spawn.mockReset().mockImplementation((_command: string, args: string[]) => {
    const child = fakeChild()
    started.push({ child, args })
    return child
  })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/health')) return new Response('{"status":"ok"}', { status: 200 })
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    requests.push({ url, headers: init?.headers as Record<string, string>, body })
    const signal = init?.signal
    return await new Promise<Response>((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      void answer(body).then(resolve, reject)
    })
  }))
  asr = await import('../src/main/services/llama-asr')
})
afterEach(() => {
  asr.stop()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('speech recognition on llama-server', () => {
  it('starts the server on the model and its projector, on the chosen GPU, on the loopback interface with a key of its own', async () => {
    await expect(asr.ensureServer(MODEL)).resolves.toBe(true)
    const { args } = started[0]
    expect(path.basename(argAfter(args, '--model'))).toBe(MODEL.model.file)
    expect(path.basename(argAfter(args, '--mmproj'))).toBe(MODEL.mmproj.file)
    expect(argAfter(args, '--device')).toBe('MTL0')
    expect(argAfter(args, '--host')).toBe('127.0.0.1')
    expect(argAfter(args, '--api-key')).toMatch(/^[0-9a-f]{48}$/)
    expect(args).toContain('--offline')
  })

  it('sends the recording as a 16 kHz mono WAV with the key, fixes the language by the start of the answer, and returns the text alone', async () => {
    const samples = new Float32Array(16_000).fill(0.25)
    await expect(asr.transcribe(MODEL, samples, 'r1')).resolves.toBe('こんにちは。')
    const [request] = requests
    expect(request.headers.authorization).toBe(`Bearer ${argAfter(started[0].args, '--api-key')}`)
    const [user, assistant] = request.body.messages as Array<{ role: string; content: unknown }>
    expect(assistant).toEqual({ role: 'assistant', content: 'language Japanese<asr_text>' })
    const audio = (user.content as Array<{ type: string; input_audio: { data: string; format: string } }>)[0]
    expect(audio.input_audio.format).toBe('wav')
    const wav = Buffer.from(audio.input_audio.data, 'base64')
    expect([wav.toString('ascii', 0, 4), wav.readUInt16LE(22), wav.readUInt32LE(24), wav.readUInt16LE(34)]).toEqual(['RIFF', 1, 16_000, 16])
    expect(wav.length).toBe(44 + samples.length * 2)
  })

  it('skips a partial transcription while another request is open, which it would only delay', async () => {
    let release!: () => void
    answer = () => new Promise((resolve) => { release = () => resolve(chat('language Japanese<asr_text>最後まで。')) })
    const final = asr.transcribe(MODEL, new Float32Array(1600), 'final')
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    await expect(asr.transcribePartial(MODEL, new Float32Array(1600))).resolves.toBe('')
    expect(requests).toHaveLength(1)
    release()
    await expect(final).resolves.toBe('最後まで。')
  })

  it('stops a cancelled request with the reason the user sees', async () => {
    answer = () => new Promise(() => {})
    const pending = asr.transcribe(MODEL, new Float32Array(1600), 'r2')
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    expect(asr.cancelTranscription('r2')).toBe(true)
    await expect(pending).rejects.toThrow(errorText('speechRecognition.errors.stopped'))
  })

  it('starts a new server for the next request after the server exits on its own', async () => {
    await asr.ensureServer(MODEL)
    started[0].child.exitCode = 1
    started[0].child.emit('exit', 1)
    await expect(asr.transcribe(MODEL, new Float32Array(1600), 'r3')).resolves.toBe('こんにちは。')
    expect(started).toHaveLength(2)
  })

  it('starts nothing while a file of the model is missing', async () => {
    vi.mocked(fs.existsSync).mockImplementation((file) => !String(file).endsWith(MODEL.mmproj.file))
    await expect(asr.ensureServer(MODEL)).resolves.toBe(false)
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('fails loudly when the app shipped without llama-server', async () => {
    vi.mocked(fs.existsSync).mockImplementation((file) => !/llama-server(\.exe)?$/.test(String(file)))
    await expect(asr.ensureServer(MODEL)).rejects.toThrow('llama-server is missing')
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
})
