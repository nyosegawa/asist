import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ASR_MODEL_SPECS, asrModelFiles } from '@shared/asr-models'
import type { SetupProgress } from '@shared/ipc'
import type { PinnedFile } from '@shared/pinned-file'
import { QWEN_TTS_SIZES, localTtsModel } from '@shared/tts-models'

const mocks = vi.hoisted(() => ({ directory: '' }))
vi.mock('../src/main/services/platform', () => import('./helpers/platform'))
vi.mock('electron', () => ({ app: { getPath: () => mocks.directory, getVersion: () => '0.0.0' } }))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ uiLocale: 'en-US' }) }))

import { t } from '../src/main/services/i18n'
import { modelFilePath, pinnedSpeechModelFiles, prepareModelFiles, removeUnpinnedFiles } from '../src/main/services/speech-models'

const FILE: PinnedFile = { repo: 'owner/model-GGUF', revision: 'abc123', file: 'model.gguf', sha256: '0', bytes: 4 }

beforeEach(() => {
  mocks.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asist-speech-models-'))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  fs.rmSync(mocks.directory, { recursive: true, force: true })
})

const install = (file: PinnedFile): void => {
  fs.mkdirSync(path.dirname(modelFilePath(file)), { recursive: true })
  fs.writeFileSync(modelFilePath(file), 'gguf')
}

describe('preparing the files of a local speech model', () => {
  it('starts the service on files that are already there without fetching anything', async () => {
    install(FILE)
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const progress: SetupProgress[] = []
    const start = vi.fn(async () => true)
    const result = await prepareModelFiles({ files: [FILE], label: 'Model', feature: 'Speech', signal: new AbortController().signal, onProgress: (p) => progress.push(p), selected: () => true, start })
    expect(result).toEqual({ ok: true, message: t('settingsModels.preparation.done', { model: 'Model' }) })
    expect(fetch).not.toHaveBeenCalled()
    expect(start).toHaveBeenCalledOnce()
    expect(progress.at(-1)?.status).toBe('done')
  })

  it('reports a service that does not start on the files by the name of the model', async () => {
    install(FILE)
    const progress: SetupProgress[] = []
    const result = await prepareModelFiles({ files: [FILE], label: 'Model', feature: 'Speech', signal: new AbortController().signal, onProgress: (p) => progress.push(p), selected: () => true, start: async () => false })
    expect(result).toEqual({ ok: false, message: t('settingsModels.preparation.startFailed', { model: 'Model' }) })
    expect(progress.at(-1)?.status).toBe('error')
  })

  it('starts nothing and reports the files prepared when the settings no longer select the model once they are there', async () => {
    install(FILE)
    const progress: SetupProgress[] = []
    const start = vi.fn(async () => true)
    const result = await prepareModelFiles({ files: [FILE], label: 'Model', feature: 'Speech', signal: new AbortController().signal, onProgress: (p) => progress.push(p), selected: () => false, start })
    expect(result.ok).toBe(true)
    expect(start).not.toHaveBeenCalled()
    expect(progress.at(-1)?.status).toBe('done')
  })

  it('does not count a start as failed when the settings turned away from the model while it loaded', async () => {
    install(FILE)
    let selected = true
    const result = await prepareModelFiles({
      files: [FILE],
      label: 'Model',
      feature: 'Speech',
      signal: new AbortController().signal,
      onProgress: () => {},
      selected: () => selected,
      // The change of the setting stops the model that was loading.
      start: async () => {
        selected = false
        return false
      }
    })
    expect(result.ok).toBe(true)
  })

  it('reports a preparation stopped during the download as cancelled and starts nothing', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      controller.abort()
      throw init?.signal?.reason ?? new DOMException('aborted', 'AbortError')
    }))
    const start = vi.fn(async () => true)
    const progress: SetupProgress[] = []
    const result = await prepareModelFiles({ files: [FILE], label: 'Model', feature: 'Speech', signal: controller.signal, onProgress: (p) => progress.push(p), selected: () => true, start })
    expect(result).toEqual({ ok: false, message: t('settingsModels.preparation.cancelled', { feature: 'Speech' }) })
    expect(progress.at(-1)?.status).toBe('cancelled')
    expect(start).not.toHaveBeenCalled()
    expect(fs.existsSync(modelFilePath(FILE))).toBe(false)
  })
})

describe('removing the files no pin names at start', () => {
  const MMPROJ: PinnedFile = { ...FILE, file: 'mmproj.gguf' }
  const CODEC: PinnedFile = { repo: 'owner/voice-GGUF', revision: 'def456', file: 'codec.gguf', sha256: '0', bytes: 4 }
  const root = (): string => path.join(mocks.directory, 'speech-models')
  const put = (...parts: string[]): void => {
    const target = path.join(root(), ...parts)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'gguf')
  }
  /** Every file and folder under speech-models, as paths relative to it. */
  const tree = (): string[] =>
    fs.readdirSync(root(), { recursive: true, withFileTypes: true }).map((entry) => path.relative(root(), path.join(entry.parentPath, entry.name))).sort()

  /** The pins of a model and their leftovers: an older revision, an older file and a download that never finished, an older repository, and things of another form. */
  const fillWithLeftovers = (): void => {
    for (const file of [FILE, MMPROJ, CODEC]) install(file)
    put('owner--model-GGUF', 'abc123', 'model.gguf.0123456789ab.tmp')
    put('owner--model-GGUF', 'abc123', 'model-q4_0.gguf')
    put('owner--model-GGUF', 'old789', 'model.gguf')
    put('owner--voice-GGUF', 'old789', 'codec.gguf.ba9876543210.tmp')
    put('former--model-GGUF', 'abc123', 'model.gguf')
    put('notes.txt')
    put('mine', 'model.gguf')
  }

  it('keeps the pinned files and what is not a repository folder, and removes every other revision, repository and file', async () => {
    fillWithLeftovers()
    await removeUnpinnedFiles([FILE, MMPROJ, CODEC])
    expect(tree()).toEqual(
      [
        'mine',
        path.join('mine', 'model.gguf'),
        'notes.txt',
        'owner--model-GGUF',
        path.join('owner--model-GGUF', 'abc123'),
        path.join('owner--model-GGUF', 'abc123', 'mmproj.gguf'),
        path.join('owner--model-GGUF', 'abc123', 'model.gguf'),
        'owner--voice-GGUF',
        path.join('owner--voice-GGUF', 'def456'),
        path.join('owner--voice-GGUF', 'def456', 'codec.gguf')
      ].sort()
    )
  })

  it('keeps the files of a pin whose repository is written in another case, which macOS and Windows find under either', async () => {
    install(FILE)
    await removeUnpinnedFiles([{ ...FILE, repo: 'OWNER/Model-gguf' }])
    expect(fs.existsSync(modelFilePath(FILE))).toBe(true)
  })

  it('keeps every file that preparing a model the settings can name fetches', async () => {
    const needed = [
      ...(['irodori', 'qwen3tts'] as const).flatMap((engine) => QWEN_TTS_SIZES.flatMap((size) => localTtsModel(engine, size).files)),
      ...Object.values(ASR_MODEL_SPECS).flatMap(asrModelFiles)
    ]
    for (const file of needed) install(file)
    const before = tree()
    await removeUnpinnedFiles(pinnedSpeechModelFiles())
    expect(tree()).toEqual(before)
  })

  it('logs a folder it cannot remove and goes on with the others', async () => {
    fillWithLeftovers()
    const remove = fs.promises.rm
    vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, options) => {
      if (path.basename(String(target)) === 'former--model-GGUF') throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      return remove(target, options)
    })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await removeUnpinnedFiles([FILE, MMPROJ, CODEC])
    expect(fs.existsSync(path.join(root(), 'former--model-GGUF'))).toBe(true)
    expect(fs.existsSync(path.join(root(), 'owner--model-GGUF', 'old789'))).toBe(false)
    expect(fs.existsSync(path.join(root(), 'owner--voice-GGUF', 'old789'))).toBe(false)
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('former--model-GGUF'), expect.any(Error))
  })
})
