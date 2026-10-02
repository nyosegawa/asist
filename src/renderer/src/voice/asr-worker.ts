import {
  env,
  pipeline,
  type AutomaticSpeechRecognitionPipeline
} from '@huggingface/transformers'
import ortWasmFactoryUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url'
import ortWasmBinaryUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'

/**
 * Runs the Whisper pipeline of @huggingface/transformers inside a Web Worker so that transcription
 * never blocks the UI thread. It uses WebGPU where the platform has it and WASM otherwise.
 */

function assertSameOriginRuntimeAsset(url: string): void {
  const asset = new URL(url, self.location.href)
  const worker = new URL(self.location.href)
  if (asset.origin !== worker.origin) {
    throw new Error(`ONNX Runtime asset must be bundled with ASIST: ${asset.origin}`)
  }
}

// Transformers.js defaults to jsDelivr for these runtime files. Keep the
// execution runtime in the signed application bundle so ASR startup does not
// depend on a mutable CDN (and continues to work offline after model download).
assertSameOriginRuntimeAsset(ortWasmFactoryUrl)
assertSameOriginRuntimeAsset(ortWasmBinaryUrl)
env.backends.onnx.wasm!.wasmPaths = {
  mjs: ortWasmFactoryUrl,
  wasm: ortWasmBinaryUrl
}

export interface AsrInitMessage {
  type: 'init'
  model: string
  /** An immutable Hugging Face commit SHA. A branch or tag name is not allowed. */
  revision: string
}

export interface AsrTranscribeMessage {
  type: 'transcribe'
  id: number
  audio: Float32Array
  /** The English name of the language in lower case, which is what the pipeline takes. */
  language: string
}

export type AsrRequest = AsrInitMessage | AsrTranscribeMessage

export type AsrResponse =
  | { type: 'progress'; file: string; loaded: number; total: number }
  | { type: 'ready'; device: string }
  | { type: 'result'; id: number; text: string }
  | { type: 'error'; id?: number; message: string }

let transcriber: AutomaticSpeechRecognitionPipeline | null = null

const post = (message: AsrResponse): void => self.postMessage(message)

/**
 * Chooses where the model runs before anything is fetched. Whisper's fp16 weights run on WebGPU only where the
 * adapter has shader-f16, which transformers.js checks once the configuration has been fetched; falling back to
 * WASM after its refusal would fetch the model a second time, with no progress and inside the same time limit.
 */
async function chooseDevice(): Promise<{ device: 'webgpu' | 'wasm'; dtype: 'fp16' | 'q8' }> {
  const adapter = 'gpu' in navigator ? await navigator.gpu.requestAdapter() : null
  return adapter?.features.has('shader-f16') ? { device: 'webgpu', dtype: 'fp16' } : { device: 'wasm', dtype: 'q8' }
}

async function init(model: string, revision: string): Promise<void> {
  const { device, dtype } = await chooseDevice()
  transcriber = await pipeline('automatic-speech-recognition', model, {
    device,
    dtype,
    revision,
    progress_callback: (info: {
      status?: string
      file?: string
      loaded?: number
      total?: number
    }) => {
      // The per-file progress goes out untouched and AsrEngine adds it up. Several files
      // download at once, so passing each file's percentage straight through makes the
      // displayed number jump around.
      if (info.status === 'progress' && typeof info.loaded === 'number' && info.total) {
        post({ type: 'progress', file: info.file ?? '', loaded: info.loaded, total: info.total })
      }
    }
  })
  post({ type: 'ready', device })
}

async function transcribe(id: number, audio: Float32Array, language: string): Promise<void> {
  if (!transcriber) {
    post({ type: 'error', id, message: 'ASR engine not initialized' })
    return
  }
  const output = await transcriber(audio, { language, task: 'transcribe' })
  const text = (Array.isArray(output) ? output[0]?.text : output.text) ?? ''
  post({ type: 'result', id, text: text.trim() })
}

self.onmessage = (event: MessageEvent<AsrRequest>): void => {
  const message = event.data
  void (async () => {
    try {
      if (message.type === 'init') await init(message.model, message.revision)
      else if (message.type === 'transcribe') await transcribe(message.id, message.audio, message.language)
    } catch (err) {
      post({
        type: 'error',
        id: message.type === 'transcribe' ? message.id : undefined,
        message: err instanceof Error ? err.message : String(err)
      })
    }
  })()
}
