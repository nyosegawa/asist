import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AsrRequest, AsrResponse } from '../src/renderer/src/voice/asr-worker'

const pipeline = vi.hoisted(() => vi.fn())
vi.mock('@huggingface/transformers', () => ({ env: { backends: { onnx: { wasm: {} } } }, pipeline }))
vi.mock('onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url', () => ({ default: '/assets/ort.mjs' }))
vi.mock('onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url', () => ({ default: '/assets/ort.wasm' }))

interface LoadOptions {
  device: string
  dtype: string
  progress_callback?: (info: { status: string; file: string; loaded: number; total: number }) => void
}

/** The worker's global scope: the module answers through postMessage and takes requests through onmessage. */
const scope = {
  location: { href: 'http://localhost/assets/asr-worker.js' },
  posted: [] as AsrResponse[],
  postMessage(message: AsrResponse): void {
    scope.posted.push(message)
  },
  onmessage: null as ((event: MessageEvent<AsrRequest>) => void) | null
}

let adapterFeatures: string[] | null = null
let webGpuSessionFails = false

/**
 * Loads as transformers.js does: the configuration first, then the check that WebGPU can run the fp16
 * weights, which throws before the weights are fetched, then the weights.
 */
async function load(_task: string, _model: string, options: LoadOptions): Promise<unknown> {
  const progress = options.progress_callback ?? ((): void => {})
  progress({ status: 'progress', file: 'config.json', loaded: 2_000, total: 2_000 })
  if (options.device === 'webgpu' && options.dtype === 'fp16' && !adapterFeatures?.includes('shader-f16')) {
    throw new Error('The device (webgpu) does not support fp16.')
  }
  const weights = options.dtype === 'fp16' ? 'onnx/encoder_model_fp16.onnx' : 'onnx/encoder_model_quantized.onnx'
  progress({ status: 'progress', file: weights, loaded: 40_000_000, total: 90_000_000 })
  progress({ status: 'progress', file: weights, loaded: 90_000_000, total: 90_000_000 })
  if (options.device === 'webgpu' && webGpuSessionFails) throw new Error('webgpu session failed')
  return vi.fn()
}

async function initialize(): Promise<AsrResponse> {
  scope.onmessage?.({ data: { type: 'init', model: 'onnx-community/whisper-small', revision: 'abc' } } as MessageEvent<AsrRequest>)
  await vi.waitFor(() => expect(scope.posted.some((m) => m.type === 'ready' || m.type === 'error')).toBe(true))
  return scope.posted.find((m) => m.type === 'ready' || m.type === 'error')!
}

const weightProgress = (): AsrResponse[] =>
  scope.posted.filter((m) => m.type === 'progress' && m.file.startsWith('onnx/'))

beforeEach(async () => {
  vi.resetModules()
  pipeline.mockReset()
  pipeline.mockImplementation(load)
  scope.posted = []
  scope.onmessage = null
  adapterFeatures = null
  webGpuSessionFails = false
  vi.stubGlobal('self', scope)
  vi.stubGlobal('navigator', {
    gpu: { requestAdapter: async () => (adapterFeatures ? { features: new Set(adapterFeatures) } : null) }
  })
  await import('../src/renderer/src/voice/asr-worker')
})

describe('asr-worker loading the model', () => {
  it('fetches the weights once, with their progress, where WebGPU cannot run the fp16 weights', async () => {
    adapterFeatures = []

    expect(await initialize()).toEqual({ type: 'ready', device: 'wasm' })
    expect(weightProgress().length).toBeGreaterThan(0)
    expect(pipeline).toHaveBeenCalledOnce()
  })

  it('fetches the weights once, with their progress, where there is no WebGPU adapter', async () => {
    adapterFeatures = null

    expect(await initialize()).toEqual({ type: 'ready', device: 'wasm' })
    expect(weightProgress().length).toBeGreaterThan(0)
    expect(pipeline).toHaveBeenCalledOnce()
  })

  it('runs the fp16 weights on WebGPU where the adapter has shader-f16', async () => {
    adapterFeatures = ['shader-f16']

    expect(await initialize()).toEqual({ type: 'ready', device: 'webgpu' })
    expect(pipeline.mock.calls[0][2]).toMatchObject({ device: 'webgpu', dtype: 'fp16' })
  })

  it('reports a WebGPU load that fails instead of fetching the model again for WASM', async () => {
    adapterFeatures = ['shader-f16']
    webGpuSessionFails = true

    expect(await initialize()).toEqual({ type: 'error', message: 'webgpu session failed' })
    expect(pipeline).toHaveBeenCalledOnce()
  })
})
