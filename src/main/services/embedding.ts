import type { SetupProgress } from '@shared/ipc'
import { EMBEDDING_MODEL, parseEmbeddingWorkerLine, type EmbeddingKind } from '@shared/memory-embedding'
import { OnnxWorker } from './onnx-worker'

/**
 * The memory embedding worker (resources/embedding_worker.py, multilingual-e5 small as ONNX int8), which
 * onnx-worker.ts runs in the environment it shares with the aizuchi classifier. Sentences go to the
 * resident worker and come back as vectors.
 *
 * One utterance takes 2 ms, which is short enough to wait for synchronously at the start of a turn.
 * Without the worker, memory is searched by bigram FTS alone in memory.ts, which is a normal mode and not
 * a failure.
 */

const worker = new OnnxWorker<Float32Array[]>({
  name: 'embedding',
  script: 'embedding_worker.py',
  modelsDir: 'embedding/models',
  files: [EMBEDDING_MODEL.model, EMBEDDING_MODEL.tokenizer],
  modelLabel: EMBEDDING_MODEL.label,
  feature: 'settingsModels.features.semanticSearch',
  read: (line) => {
    const message = parseEmbeddingWorkerLine(line)
    // Vectors of another size would be compared over their common prefix and rank at random, so files
    // that do not belong to the pinned model stop the worker instead.
    if (message?.type === 'ready') {
      return {
        type: 'ready',
        refusal: message.dim === EMBEDDING_MODEL.dim
          ? null
          : `the embedding model reports ${message.dim} dimensions, not ${EMBEDDING_MODEL.dim}`
      }
    }
    if (message?.type === 'result') return { type: 'result', id: message.id, answer: message.vectors }
    return message
  },
  requestTimeoutMs: 20_000
})

export function modelInstalled(): boolean {
  return worker.modelInstalled()
}

export function running(): boolean {
  return worker.running()
}

export function installationStatus(): { runtimeInstalled: boolean; modelInstalled: boolean; running: boolean } {
  return worker.status()
}

/** Starts the worker, returning true at once when it already runs and false when the runtime or the model is missing. */
export function ensureStarted(): Promise<boolean> {
  return worker.ensureStarted()
}

/** Turns sentences into vectors. The worker adds the prefix that `kind` selects. It throws when the worker is not running. */
export function embed(texts: readonly string[], kind: EmbeddingKind, signal?: AbortSignal): Promise<Float32Array[]> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  if (texts.length === 0) return Promise.resolve([])
  return worker.request({ kind, texts }, signal)
}

export function stop(): void {
  worker.stop()
}

export function cancelPreparation(): boolean {
  return worker.cancelPreparation()
}

export function prepare(onProgress: (progress: SetupProgress) => void): Promise<{ ok: boolean; message: string }> {
  return worker.prepare(onProgress)
}
