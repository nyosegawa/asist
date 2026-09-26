import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { app } from 'electron'
import type { SetupProgress } from '@shared/ipc'
import { errorText } from '@shared/i18n/error-text'
import {
  EMBEDDING_MODEL,
  parseEmbeddingWorkerLine,
  type EmbeddingFile,
  type EmbeddingKind
} from '@shared/memory-embedding'
import {
  downloadMissing,
  ensureRuntime,
  pythonPath,
  runtimeInstalled,
  supportedPlatform
} from './onnx-runtime'
import { errorMessage, t } from './i18n'
import { childEnv } from './child-env'
import { resourcePath } from './resource-path'

/**
 * The lifecycle of the memory embedding worker (resources/embedding_worker.py, multilingual-e5 small as ONNX int8).
 *
 * The Python environment (userData/embedding-runtime, holding only onnxruntime and tokenizers) is shared
 * with the aizuchi classifier through onnx-runtime.ts. The model and the tokenizer are fetched from
 * Hugging Face at a pinned commit, verified by sha256 and kept in userData/embedding/models; sentences
 * then go to the resident worker and come back as vectors. A fetch happens only on an explicit prepare
 * from the settings screen, and the worker reads nothing but local files.
 *
 * It runs on one thread for the same reason as the VAP worker: with two or more, spin-waiting delays the
 * renderer's VAD. One utterance takes 2 ms, which is short enough to wait for synchronously at the start
 * of a turn. Without the worker, memory is searched by bigram FTS alone in memory.ts, which is a normal
 * mode and not a failure.
 */

const WORKER_READY_TIMEOUT_MS = 120_000
const REQUEST_TIMEOUT_MS = 20_000
const WORKER_THREADS = 1

interface PendingRequest {
  resolve: (vectors: Float32Array[]) => void
  reject: (error: unknown) => void
  timer: NodeJS.Timeout
  removeAbortListener: () => void
}

let child: ChildProcessWithoutNullStreams | null = null
let workerReady = false
let ensureInFlight: Promise<boolean> | null = null
let prepareInFlight: Promise<{ ok: boolean; message: string }> | null = null
let prepareController: AbortController | null = null
let quitHookRegistered = false
const pending = new Map<string, PendingRequest>()

function modelsDir(): string {
  return path.join(app.getPath('userData'), 'embedding', 'models')
}

/** The file name carries the variant and the commit, so that changing the model lands on a different file. */
function filePath(file: EmbeddingFile): string {
  return path.join(modelsDir(), `${file.revision.slice(0, 7)}-${path.basename(file.file)}`)
}

const FILES: EmbeddingFile[] = [EMBEDDING_MODEL.model, EMBEDDING_MODEL.tokenizer]

function missingFiles(): EmbeddingFile[] {
  return FILES.filter((file) => !fs.existsSync(filePath(file)))
}

export function modelInstalled(): boolean {
  return missingFiles().length === 0
}

export function running(): boolean {
  return Boolean(child && workerReady && child.exitCode === null)
}

export function installationStatus(): { runtimeInstalled: boolean; modelInstalled: boolean; running: boolean } {
  return { runtimeInstalled: runtimeInstalled(), modelInstalled: modelInstalled(), running: running() }
}

function registerQuitHook(): void {
  if (quitHookRegistered) return
  quitHookRegistered = true
  app.on('will-quit', () => {
    stop()
  })
}

function takeRequest(id: string): PendingRequest | null {
  const request = pending.get(id)
  if (!request) return null
  pending.delete(id)
  clearTimeout(request.timer)
  request.removeAbortListener()
  return request
}

function failAll(error: Error): void {
  for (const id of [...pending.keys()]) takeRequest(id)?.reject(error)
}

function handleStdoutLine(line: string): void {
  const message = parseEmbeddingWorkerLine(line)
  if (message === null) {
    if (line.trim()) console.log(`embedding: ${line}`)
    return
  }
  if (message.type === 'ready') {
    // Vectors of another size would be compared over their common prefix and rank at random, so files that do
    // not belong to the pinned model stop the worker instead.
    if (message.dim !== EMBEDDING_MODEL.dim) {
      const error = `the embedding model reports ${message.dim} dimensions, not ${EMBEDDING_MODEL.dim}`
      console.warn(`embedding: ${error}`)
      failAll(new Error(error))
      stop()
      return
    }
    workerReady = true
    console.log(`embedding: worker ready (${EMBEDDING_MODEL.label} ${EMBEDDING_MODEL.variant}, dim ${message.dim})`)
    return
  }
  if (message.type === 'fatal') {
    console.warn(`embedding: worker fatal: ${message.error}`)
    failAll(new Error(message.error))
    stop()
    return
  }
  const request = takeRequest(message.id)
  if (!request) return
  if (message.type === 'result') request.resolve(message.vectors)
  else request.reject(new Error(message.error))
}

async function waitUntilReady(spawned: ChildProcessWithoutNullStreams): Promise<boolean> {
  const deadline = Date.now() + WORKER_READY_TIMEOUT_MS
  while (child === spawned && Date.now() < deadline) {
    if (workerReady) return true
    if (spawned.exitCode !== null || spawned.killed) return false
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return workerReady && child === spawned
}

async function startWorker(): Promise<boolean> {
  if (running()) return true
  stop()
  if (!runtimeInstalled() || !modelInstalled()) return false
  const script = resourcePath('embedding_worker.py')
  if (!fs.existsSync(script)) return false

  const spawned = spawn(
    pythonPath(),
    [script, filePath(EMBEDDING_MODEL.model), filePath(EMBEDDING_MODEL.tokenizer), String(WORKER_THREADS)],
    { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv({ PYTHONUNBUFFERED: '1' }) }
  )
  child = spawned
  workerReady = false
  registerQuitHook()
  readline.createInterface({ input: spawned.stdout }).on('line', handleStdoutLine)
  readline.createInterface({ input: spawned.stderr }).on('line', (line) => {
    if (line.trim()) console.log(`embedding: ${line}`)
  })
  const detach = (reason: string): void => {
    if (child === spawned) {
      child = null
      workerReady = false
      failAll(new Error(reason))
    }
  }
  spawned.on('error', (error) => detach(`embedding worker error: ${error.message}`))
  spawned.on('exit', (code) => detach(`embedding worker exited (${code ?? 'signal'})`))
  // A write between the worker's death and its exit event fails with EPIPE, which becomes an uncaught
  // exception unless the stream has a listener. The request that wrote gets the error through its callback.
  spawned.stdin.on('error', (error) => {
    console.warn(`embedding: worker input failed: ${error.message}`)
    if (child === spawned) stop()
  })

  const ready = await waitUntilReady(spawned)
  if (!ready && child === spawned) stop()
  return ready
}

/** Starts the worker, returning true at once when it already runs and false when the runtime or the model is missing. */
export function ensureStarted(): Promise<boolean> {
  if (running()) return Promise.resolve(true)
  if (ensureInFlight) return ensureInFlight
  const operation = startWorker().finally(() => {
    if (ensureInFlight === operation) ensureInFlight = null
  })
  ensureInFlight = operation
  return operation
}

/** Turns sentences into vectors. The worker adds the prefix that `kind` selects. It throws when the worker is not running. */
export function embed(texts: readonly string[], kind: EmbeddingKind, signal?: AbortSignal): Promise<Float32Array[]> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  if (texts.length === 0) return Promise.resolve([])
  if (!running() || !child?.stdin.writable) {
    return Promise.reject(new Error('the embedding worker is not running'))
  }
  const id = randomUUID()
  return new Promise<Float32Array[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      takeRequest(id)?.reject(new Error('the embedding did not finish within 20 seconds'))
      stop()
    }, REQUEST_TIMEOUT_MS)
    timer.unref?.()
    // The computation on the Python side runs to the end on the shared worker: the request and its timeout
    // are dropped and a late result is discarded. Killing the worker would also interrupt the memory index
    // update running beside it.
    const abort = (): void => { takeRequest(id)?.reject(signal?.reason) }
    pending.set(id, {
      resolve, reject, timer,
      removeAbortListener: () => signal?.removeEventListener('abort', abort)
    })
    signal?.addEventListener('abort', abort, { once: true })
    child?.stdin.write(`${JSON.stringify({ id, kind, texts })}\n`, (error) => {
      if (error) takeRequest(id)?.reject(error)
    })
  })
}

export function stop(): void {
  const stale = child
  child = null
  workerReady = false
  if (stale && stale.exitCode === null && !stale.killed) {
    try {
      stale.stdin.end()
    } catch {
      // The stream is already closed.
    }
    const killTimer = setTimeout(() => {
      if (stale.exitCode === null && !stale.killed) stale.kill('SIGTERM')
    }, 1_000)
    killTimer.unref?.()
  }
  failAll(new Error('embedding worker stopped'))
}

export function cancelPreparation(): boolean {
  if (!prepareController) return false
  prepareController.abort()
  stop()
  return true
}

export function prepare(
  onProgress: (progress: SetupProgress) => void
): Promise<{ ok: boolean; message: string }> {
  if (prepareInFlight) return prepareInFlight
  const operation = prepareOnce(onProgress).finally(() => {
    if (prepareInFlight === operation) prepareInFlight = null
    prepareController = null
  })
  prepareInFlight = operation
  return operation
}

async function prepareOnce(
  onProgress: (progress: SetupProgress) => void
): Promise<{ ok: boolean; message: string }> {
  if (!supportedPlatform()) {
    return { ok: false, message: t('settingsModels.preparation.unsupported', { feature: t('settingsModels.features.semanticSearch') }) }
  }
  const controller = new AbortController()
  prepareController = controller
  const progress = (message: string): void =>
    onProgress({ status: 'downloading', pct: 0, downloadedMb: 0, totalMb: 0, message })
  try {
    await ensureRuntime(controller.signal, progress, t('settingsModels.features.semanticSearch'))
    await downloadMissing(
      FILES.map((file) => ({ file, target: filePath(file) })),
      controller.signal,
      ({ pct, downloadedMb, totalMb, file }) =>
        onProgress({
          status: 'downloading',
          pct,
          downloadedMb,
          totalMb,
          message: t('settingsModels.preparation.modelFile', { model: EMBEDDING_MODEL.label, file })
        })
    )
    progress(t('settingsModels.preparation.loading', { model: EMBEDDING_MODEL.label }))
    const ready = await ensureStarted()
    if (!ready) throw new Error(errorText('settingsModels.preparation.startFailed', { model: EMBEDDING_MODEL.label }))
    onProgress({ status: 'done', pct: 100, downloadedMb: 0, totalMb: 0 })
    return {
      ok: true,
      message: t('settingsModels.preparation.ready', {
        feature: t('settingsModels.features.semanticSearch'),
        model: EMBEDDING_MODEL.label
      })
    }
  } catch (error) {
    const cancelled =
      controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')
    const message = cancelled
      ? t('settingsModels.preparation.cancelled', { feature: t('settingsModels.features.semanticSearch') })
      : errorMessage(error)
    onProgress({ status: cancelled ? 'cancelled' : 'error', pct: 0, downloadedMb: 0, totalMb: 0, message })
    return { ok: false, message }
  }
}
