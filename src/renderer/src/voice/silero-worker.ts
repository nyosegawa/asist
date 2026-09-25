import * as ort from 'onnxruntime-web'
import ortWasmFactoryUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url'
import ortWasmBinaryUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'
import modelUrl from '../assets/silero_vad.onnx?url'

/**
 * Returns the probability that a 512-sample chunk, 32 ms at 16 kHz, is human voice, from 0 to 1.
 * Sounds that an energy VAD counts as speech, such as typing, an object set down or a door, come
 * out as non-speech, which stops Whisper from hallucinating a word like "はい" out of that noise.
 *
 * The model ships with the app: snakers4/silero-vad v5.1.2 (MIT),
 * sha256 2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f.
 */

function assertSameOriginRuntimeAsset(url: string): void {
  const asset = new URL(url, self.location.href)
  const worker = new URL(self.location.href)
  if (asset.origin !== worker.origin) {
    throw new Error(`ONNX Runtime asset must be bundled with ASIST: ${asset.origin}`)
  }
}

// As in asr-worker, the execution runtime is read from the signed bundle rather than a CDN.
assertSameOriginRuntimeAsset(ortWasmFactoryUrl)
assertSameOriginRuntimeAsset(ortWasmBinaryUrl)
assertSameOriginRuntimeAsset(modelUrl)
ort.env.wasm.wasmPaths = { mjs: ortWasmFactoryUrl, wasm: ortWasmBinaryUrl }
// Threaded WASM needs COOP/COEP headers and so depends on the environment; one thread always works.
ort.env.wasm.numThreads = 1

export interface SileroInitMessage {
  type: 'init'
}

export interface SileroInferMessage {
  type: 'infer'
  id: number
  /** Exactly 512 samples of 16 kHz mono audio. */
  chunk: Float32Array
}

/** Clears the LSTM state when a session restarts. Carrying the state across utterances is fine. */
export interface SileroResetMessage {
  type: 'reset'
}

export type SileroRequest = SileroInitMessage | SileroInferMessage | SileroResetMessage

export type SileroResponse =
  | { type: 'ready' }
  | { type: 'prob'; id: number; prob: number }
  | { type: 'error'; message: string }

const STATE_SHAPE = [2, 1, 128] as const
const freshState = (): ort.Tensor =>
  new ort.Tensor('float32', new Float32Array(2 * 1 * 128), [...STATE_SHAPE])

let session: ort.InferenceSession | null = null
let state = freshState()
const sr = new ort.Tensor('int64', BigInt64Array.from([16000n]), [1])

const post = (message: SileroResponse): void => self.postMessage(message)

async function init(): Promise<void> {
  session = await ort.InferenceSession.create(modelUrl, { executionProviders: ['wasm'] })
  post({ type: 'ready' })
}

async function infer(id: number, chunk: Float32Array): Promise<void> {
  if (!session) {
    post({ type: 'error', message: 'silero vad not initialized' })
    return
  }
  const input = new ort.Tensor('float32', chunk, [1, chunk.length])
  const out = await session.run({ input, state, sr })
  state = out.stateN as ort.Tensor
  const prob = (out.output.data as Float32Array)[0] ?? 0
  post({ type: 'prob', id, prob })
}

self.onmessage = (event: MessageEvent<SileroRequest>): void => {
  const message = event.data
  void (async () => {
    try {
      if (message.type === 'init') await init()
      else if (message.type === 'infer') await infer(message.id, message.chunk)
      else if (message.type === 'reset') state = freshState()
    } catch (err) {
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  })()
}
