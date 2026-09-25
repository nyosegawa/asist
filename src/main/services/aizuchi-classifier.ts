import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { app } from 'electron'
import type { AizuchiClassifierStatus, AppSettings, SetupProgress } from '@shared/ipc'
import { errorText } from '@shared/i18n/error-text'
import { conversationFeatures } from '@shared/conversation-locale'
import { isLiveEngine } from '@shared/voice-engine'
import {
  AIZUCHI_MODEL,
  normalizeForClassifier,
  parseAizuchiWorkerLine,
  type AizuchiClassification,
  type AizuchiModelFile
} from '@shared/aizuchi-classifier'
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
 * The lifecycle of the aizuchi classifier worker (resources/aizuchi_worker.py, a fine-tune of
 * ModernBERT-ja 70m as ONNX int8).
 *
 * The Python environment is shared with the memory embedding through onnx-runtime.ts, and the model and
 * the tokenizer are fetched from Hugging Face at a pinned commit and verified by sha256 into
 * userData/aizuchi-classifier/models. A fetch happens only on an explicit prepare from the settings
 * screen, and the worker reads nothing but local files. An aizuchi at the head of a turn plays only while
 * this worker runs; there is no rule-based fallback on the text.
 *
 * One sentence is classified per partial recognition update, in 1.7 ms. Requests go one at a time and the
 * renderer keeps only the newest input. It runs on one thread for the same reason as the embedding: with
 * two or more, spin-waiting delays the renderer's VAD.
 */

const WORKER_READY_TIMEOUT_MS = 120_000
const REQUEST_TIMEOUT_MS = 5_000
const WORKER_THREADS = 1

interface PendingRequest {
  resolve: (result: AizuchiClassification) => void
  reject: (error: unknown) => void
  timer: NodeJS.Timeout
}

let child: ChildProcessWithoutNullStreams | null = null
let workerReady = false
let ensureInFlight: Promise<boolean> | null = null
let prepareInFlight: Promise<{ ok: boolean; message: string }> | null = null
let prepareController: AbortController | null = null
let quitHookRegistered = false
const pending = new Map<string, PendingRequest>()

function modelsDir(): string {
  return path.join(app.getPath('userData'), 'aizuchi-classifier', 'models')
}

/** The file name carries the commit, so that changing the model lands on a different file. */
function filePath(file: AizuchiModelFile): string {
  return path.join(modelsDir(), `${file.revision.slice(0, 7)}-${path.basename(file.file)}`)
}

const FILES: AizuchiModelFile[] = [AIZUCHI_MODEL.model, AIZUCHI_MODEL.tokenizer]

export function modelInstalled(): boolean {
  return FILES.every((file) => fs.existsSync(filePath(file)))
}

/**
 * Whether the worker should stay resident: aizuchi are on, the conversation is held in a language
 * that has them, and the voice engine is not a live one, which makes its own aizuchi and sends no
 * partial recognition here.
 */
export function wanted(settings: AppSettings): boolean {
  return (
    settings.aizuchi &&
    conversationFeatures(settings.conversationLocale).aizuchi &&
    !isLiveEngine(settings.voiceEngine)
  )
}

export function running(): boolean {
  return Boolean(child && workerReady && child.exitCode === null)
}

export function status(): AizuchiClassifierStatus {
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
  return request
}

function failAll(error: Error): void {
  for (const id of [...pending.keys()]) takeRequest(id)?.reject(error)
}

function handleStdoutLine(line: string): void {
  const message = parseAizuchiWorkerLine(line)
  if (message === null) {
    if (line.trim()) console.log(`aizuchi-classifier: ${line}`)
    return
  }
  if (message.type === 'ready') {
    workerReady = true
    console.log(`aizuchi-classifier: worker ready (${AIZUCHI_MODEL.label})`)
    return
  }
  if (message.type === 'fatal') {
    console.warn(`aizuchi-classifier: worker fatal: ${message.error}`)
    failAll(new Error(message.error))
    stop()
    return
  }
  const request = takeRequest(message.id)
  if (!request) return
  if (message.type === 'result') {
    request.resolve({ cls: message.cls, prob: message.prob, complete: message.complete })
  } else {
    request.reject(new Error(message.error))
  }
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
  const script = resourcePath('aizuchi_worker.py')
  if (!fs.existsSync(script)) return false

  const spawned = spawn(
    pythonPath(),
    [script, filePath(AIZUCHI_MODEL.model), filePath(AIZUCHI_MODEL.tokenizer), String(WORKER_THREADS)],
    { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv({ PYTHONUNBUFFERED: '1' }) }
  )
  child = spawned
  workerReady = false
  registerQuitHook()
  readline.createInterface({ input: spawned.stdout }).on('line', handleStdoutLine)
  readline.createInterface({ input: spawned.stderr }).on('line', (line) => {
    if (line.trim()) console.log(`aizuchi-classifier: ${line}`)
  })
  const detach = (reason: string): void => {
    if (child === spawned) {
      child = null
      workerReady = false
      failAll(new Error(reason))
    }
  }
  spawned.on('error', (error) => detach(`aizuchi classifier worker error: ${error.message}`))
  spawned.on('exit', (code) => detach(`aizuchi classifier worker exited (${code ?? 'signal'})`))

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

/**
 * Classifies one sentence. Normalization, which drops punctuation and whitespace, happens here, and an
 * input that becomes empty throws. It also throws when the worker is not running, and the caller then
 * plays no aizuchi.
 */
export function classify(input: { prev: string; text: string }): Promise<AizuchiClassification> {
  const text = normalizeForClassifier(input.text)
  const prev = normalizeForClassifier(input.prev)
  if (!text) return Promise.reject(new Error('the utterance to classify is empty'))
  if (!running() || !child?.stdin.writable) {
    return Promise.reject(new Error('the aizuchi classifier worker is not running'))
  }
  const id = randomUUID()
  return new Promise<AizuchiClassification>((resolve, reject) => {
    const timer = setTimeout(() => {
      takeRequest(id)?.reject(new Error('the classification did not finish within 5 seconds'))
      stop()
    }, REQUEST_TIMEOUT_MS)
    timer.unref?.()
    pending.set(id, { resolve, reject, timer })
    child?.stdin.write(`${JSON.stringify({ id, prev, text })}\n`, (error) => {
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
  failAll(new Error('aizuchi classifier worker stopped'))
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
    return { ok: false, message: t('settingsModels.preparation.unsupported', { feature: t('settingsModels.features.backchannelClassifier') }) }
  }
  const controller = new AbortController()
  prepareController = controller
  const progress = (message: string): void =>
    onProgress({ status: 'downloading', pct: 0, downloadedMb: 0, totalMb: 0, message })
  try {
    await ensureRuntime(controller.signal, progress, t('settingsModels.features.backchannelClassifier'))
    await downloadMissing(
      FILES.map((file) => ({ file, target: filePath(file) })),
      controller.signal,
      ({ pct, downloadedMb, totalMb, file }) =>
        onProgress({
          status: 'downloading',
          pct,
          downloadedMb,
          totalMb,
          message: t('settingsModels.preparation.modelFile', { model: AIZUCHI_MODEL.label, file })
        })
    )
    progress(t('settingsModels.preparation.loading', { model: AIZUCHI_MODEL.label }))
    const ready = await startWorker()
    if (!ready) throw new Error(errorText('settingsModels.preparation.startFailed', { model: AIZUCHI_MODEL.label }))
    onProgress({ status: 'done', pct: 100, downloadedMb: 0, totalMb: 0 })
    return {
      ok: true,
      message: t('settingsModels.preparation.ready', {
        feature: t('settingsModels.features.backchannelClassifier'),
        model: AIZUCHI_MODEL.label
      })
    }
  } catch (error) {
    const cancelled =
      controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')
    const message = cancelled
      ? t('settingsModels.preparation.cancelled', { feature: t('settingsModels.features.backchannelClassifier') })
      : errorMessage(error)
    onProgress({ status: cancelled ? 'cancelled' : 'error', pct: 0, downloadedMb: 0, totalMb: 0, message })
    return { ok: false, message }
  }
}
