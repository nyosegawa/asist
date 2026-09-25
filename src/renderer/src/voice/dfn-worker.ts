import * as ort from 'onnxruntime-web'
// The plain build, not the asyncify build that silero and asr use, measures about twice as fast.
// This audio path runs on a 10.7 ms cycle, so the headroom matters.
import ortWasmFactoryUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url'
import ortWasmBinaryUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'
import modelUrl from '../assets/dfn3_denoiser.onnx?url'

/**
 * Takes a frame of 512 samples, about 10.7 ms at 48 kHz, and returns a frame of the same length
 * with non-speech noise such as typing, air conditioning or objects knocked about suppressed. The
 * streaming export of grazder/DeepFilterNet torchDF keeps STFT, ERB and deep filtering inside the
 * ONNX graph, so this worker only has to hold the state tensors and carry them to the next frame.
 *
 * The model ships with the app: grazder/DeepFilterNet torchDF_main, DeepFilterNet3 finetuned to a
 * hop of 512, MIT/Apache-2.0,
 * sha256 b758c49d6708a5b7979e3de185705a8a4915076c862fb17b1b304d9a72b75cdc.
 * One frame measures about 0.6 ms on an Apple M5 with single-threaded WASM, against a budget of
 * 10.7 ms.
 */

function assertSameOriginRuntimeAsset(url: string): void {
  const asset = new URL(url, self.location.href)
  const worker = new URL(self.location.href)
  if (asset.origin !== worker.origin) {
    throw new Error(`ONNX Runtime asset must be bundled with ASIST: ${asset.origin}`)
  }
}

// As in silero-worker, the execution runtime is read from the signed bundle rather than a CDN.
assertSameOriginRuntimeAsset(ortWasmFactoryUrl)
assertSameOriginRuntimeAsset(ortWasmBinaryUrl)
assertSameOriginRuntimeAsset(modelUrl)
ort.env.wasm.wasmPaths = { mjs: ortWasmFactoryUrl, wasm: ortWasmBinaryUrl }
// Threaded WASM needs COOP/COEP headers and so depends on the environment; one thread always works.
ort.env.wasm.numThreads = 1

/** The model's unit of work at 48 kHz. DfnDenoiser's chunk size has to match it. */
export const DFN_FRAME_SIZE = 512

export interface DfnInitMessage {
  type: 'init'
}

export interface DfnInferMessage {
  type: 'infer'
  id: number
  /** Exactly DFN_FRAME_SIZE samples of 48 kHz mono audio. */
  chunk: Float32Array
}

/** Clears the state tensors when the microphone restarts. */
export interface DfnResetMessage {
  type: 'reset'
}

export type DfnRequest = DfnInitMessage | DfnInferMessage | DfnResetMessage

export type DfnResponse =
  | { type: 'ready' }
  | { type: 'enhanced'; id: number; chunk: Float32Array }
  | { type: 'error'; message: string }

const linspace = (from: number, to: number, count: number): Float32Array =>
  Float32Array.from({ length: count }, (_, i) => from + ((to - from) * i) / (count - 1))

const zeros = (dims: number[]): ort.Tensor =>
  new ort.Tensor('float32', new Float32Array(dims.reduce((a, b) => a * b, 1)), dims)

/** The initial state of the torchDF streaming implementation: the erb and band norms are a linspace and the rest are zero. */
function freshStates(): Record<string, ort.Tensor> {
  return {
    erb_norm_state: new ort.Tensor('float32', linspace(-60, -90, 32), [32]),
    band_unit_norm_state: new ort.Tensor('float32', linspace(0.001, 0.0001, 96), [1, 96, 1]),
    analysis_mem: zeros([512]),
    synthesis_mem: zeros([512]),
    rolling_erb_buf: zeros([1, 1, 3, 32]),
    rolling_feat_spec_buf: zeros([1, 2, 3, 96]),
    rolling_c0_buf: zeros([1, 64, 5, 96]),
    rolling_spec_buf_x: zeros([5, 513, 2]),
    rolling_spec_buf_y: zeros([7, 513, 2]),
    enc_hidden: zeros([1, 1, 256]),
    erb_dec_hidden: zeros([2, 1, 256]),
    df_dec_hidden: zeros([2, 1, 256])
  }
}

let session: ort.InferenceSession | null = null
let states = freshStates()

const post = (message: DfnResponse, transfer?: Transferable[]): void =>
  transfer ? self.postMessage(message, { transfer }) : self.postMessage(message)

async function init(): Promise<void> {
  session = await ort.InferenceSession.create(modelUrl, { executionProviders: ['wasm'] })
  // Kernel initialization makes the first inference take up to a few hundred milliseconds. Paying
  // that on real audio backs the input up and can shut noise suppression down, so the warm-up runs
  // before ready goes out.
  const warm = freshStates()
  for (let i = 0; i < 3; i++) {
    await session.run({
      input_frame: new ort.Tensor('float32', new Float32Array(DFN_FRAME_SIZE), [DFN_FRAME_SIZE]),
      ...warm
    })
  }
  states = freshStates()
  post({ type: 'ready' })
}

async function infer(id: number, chunk: Float32Array): Promise<void> {
  if (!session) {
    post({ type: 'error', message: 'dfn not initialized' })
    return
  }
  if (chunk.length !== DFN_FRAME_SIZE) {
    post({ type: 'error', message: `dfn frame must be ${DFN_FRAME_SIZE} samples` })
    return
  }
  const out = await session.run({
    input_frame: new ort.Tensor('float32', chunk, [DFN_FRAME_SIZE]),
    ...states
  })
  const next: Record<string, ort.Tensor> = {}
  for (const [name, tensor] of Object.entries(out)) {
    if (name.startsWith('new_')) next[name.slice(4)] = tensor as ort.Tensor
  }
  states = next
  const enhanced = (out.enhanced_audio_frame.data as Float32Array).slice(0)
  post({ type: 'enhanced', id, chunk: enhanced }, [enhanced.buffer])
}

self.onmessage = (event: MessageEvent<DfnRequest>): void => {
  const message = event.data
  void (async () => {
    try {
      if (message.type === 'init') await init()
      else if (message.type === 'infer') await infer(message.id, message.chunk)
      else if (message.type === 'reset') states = freshStates()
    } catch (err) {
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  })()
}
