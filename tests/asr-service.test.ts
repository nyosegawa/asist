import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  settings: { asrModel: 'qwen3-asr-1.7b-mlx', uiLocale: 'ja-JP' },
  mlxAvailable: vi.fn(),
  mlxEnsure: vi.fn(),
  mlxTranscribe: vi.fn(),
  mlxPartial: vi.fn(),
  mlxStop: vi.fn(),
  mlxPrepare: vi.fn()
}))

vi.mock('electron', () => ({ app: { getPath: vi.fn(), on: vi.fn() } }))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => mocks.settings }))
vi.mock('../src/main/services/mlx-asr', () => ({
  available: mocks.mlxAvailable,
  ensureServer: mocks.mlxEnsure,
  transcribe: mocks.mlxTranscribe,
  transcribePartial: mocks.mlxPartial,
  cancelTranscription: vi.fn(() => false),
  stop: mocks.mlxStop,
  prepare: mocks.mlxPrepare,
  cancelPreparation: vi.fn(),
  installationStatus: vi.fn(() => ({ runtimeInstalled: true, modelInstalled: true }))
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.settings.asrModel = 'qwen3-asr-1.7b-mlx'
})

describe('ASR service routing', () => {
  it('starts and transcribes through the selected MLX model', async () => {
    const asr = await import('../src/main/services/asr')
    const samples = new Float32Array([0.1])
    mocks.mlxEnsure.mockResolvedValue(true)
    mocks.mlxTranscribe.mockResolvedValue('音声認識のテストです。')

    await expect(asr.ensureServer()).resolves.toBe(true)
    await expect(asr.transcribe(samples, 'request-1')).resolves.toBe('音声認識のテストです。')

    expect(mocks.mlxEnsure).toHaveBeenCalledWith('qwen3-asr-1.7b-mlx')
    expect(mocks.mlxTranscribe).toHaveBeenCalledWith('qwen3-asr-1.7b-mlx', samples, 'request-1')
  })

  it('stops the running worker before starting the newly selected model', async () => {
    const asr = await import('../src/main/services/asr')
    mocks.settings.asrModel = 'whisper-large-v3-turbo-mlx'
    mocks.mlxEnsure.mockResolvedValue(true)

    await expect(asr.switchModel()).resolves.toBe(true)

    expect(mocks.mlxEnsure).toHaveBeenCalledWith('whisper-large-v3-turbo-mlx')
    expect(mocks.mlxStop.mock.invocationCallOrder[0]).toBeLessThan(mocks.mlxEnsure.mock.invocationCallOrder[0])
  })

  it('prepares nothing for a model id it does not know', async () => {
    const asr = await import('../src/main/services/asr')

    const result = await asr.prepareModel('no-such-model' as never, vi.fn())

    expect(result.ok).toBe(false)
    expect(mocks.mlxPrepare).not.toHaveBeenCalled()
  })
})
