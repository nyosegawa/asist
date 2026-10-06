import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process'
import readline from 'node:readline'
import { app } from 'electron'
import { errorText } from '@shared/i18n/error-text'
import { watchForAsistEnd } from './asist-end-watcher'
import { childEnv } from './child-env'
import { platformCapabilities } from './platform'

/**
 * The processes the local speech runs in, and the client of speech.cpp's worker protocol 2: one JSON object per
 * line on stdin and on stdout, and nothing else on stdout; the first message is `ready`, with the model's
 * information, or `fatal`; stderr goes to the app log under the worker's name. Quitting the app stops every one
 * of them. A worker reads its requests from stdin and ends by itself once ASIST is gone and the pipe closes,
 * however ASIST ended; a process that reads nothing from ASIST is started through spawnUnattended.
 */

/** The version of speech.cpp's worker protocol this client speaks, which a worker raises when its callers must change. */
export const WORKER_PROTOCOL = 2

/**
 * The series of speech.cpp releases this client is written for, its major and minor version. While speech.cpp is
 * 0.x, a release that a caller must adapt to raises the minor version, so a worker of another series is refused
 * rather than misread.
 */
export const SPEECH_CPP_SERIES = '0.7'

/** The series of a release version such as `0.7.0`, or null for anything else. */
const seriesOf = (version: unknown): string | null =>
  typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version) ? version.slice(0, version.lastIndexOf('.')) : null

/**
 * Loading a model, warming it up and compiling its GPU kernels comes before `ready`. The first start of the
 * Qwen3-TTS worker after a GPU driver update compiled its Vulkan shaders for 12.6 s on an RTX 2080 (2026-09-29).
 */
const WORKER_READY_TIMEOUT_MS = 180_000

const children = new Set<ChildProcess>()
let quitHookRegistered = false

/** Stops `child` when the app quits, unless it has ended by then. */
export function stopOnQuit(child: ChildProcess): void {
  children.add(child)
  child.once('exit', () => children.delete(child))
  if (quitHookRegistered) return
  quitHookRegistered = true
  app.on('will-quit', () => {
    for (const running of [...children]) running.kill('SIGTERM')
  })
}

/** A message of the worker: a JSON object with a string `type`. */
export type WorkerMessage = Record<string, unknown> & { type: string }

/**
 * The `error` member of `error` and `fatal` as speech's command line writes a failure, `code (option): message`.
 * Throws on a member that is not an error object of the protocol.
 */
export function describeWorkerError(error: unknown): string {
  const { code, option, message } = (typeof error === 'object' && error !== null ? error : {}) as Record<string, unknown>
  if (typeof code !== 'string' || typeof message !== 'string') throw new Error(`the worker sent ${JSON.stringify(error)} where an error object belongs`)
  return `${code}${typeof option === 'string' ? ` (${option})` : ''}: ${message}`
}

export interface WorkerOptions {
  /** What the model must do, as its information names it. */
  task: 'synthesis'
  /** The device the model is loaded on, which the worker is given and its `ready` must name. */
  device: string
  /** Every message after `ready` except an `error` that names no request, which fails the worker. */
  onMessage: (message: WorkerMessage) => void
  /** The worker failed to load, broke the protocol, crashed or exited on its own. It is not called after `stop()`. */
  onFailure: (error: Error) => void
}

/** One running worker. `ready` settles once: true on the worker's `ready` message, false when it fails or is stopped first. */
export class SpeechWorker {
  readonly ready: Promise<boolean>
  /** The rate of the audio the model makes, from the model information of `ready`; 0 until then. */
  sampleRate = 0
  private stopped = false
  private settleReady!: (ready: boolean) => void
  private isReady = false

  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    private readonly logName: string,
    private readonly options: WorkerOptions
  ) {
    this.ready = new Promise<boolean>((resolve) => { this.settleReady = resolve })
    const timeout = setTimeout(() => this.fail(new Error(`${logName} worker did not become ready`)), WORKER_READY_TIMEOUT_MS)
    void this.ready.then(() => clearTimeout(timeout))
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.handleLine(line))
    // Protocol 2 carries every failure as a message on stdout, which fail() logs as an error. stderr is the
    // worker's own log, such as the device the model loaded on and its `ready`, so it goes to the app log as
    // information.
    readline.createInterface({ input: child.stderr }).on('line', (line) => {
      if (line.trim()) console.log(`${logName}: ${line}`)
    })
    child.on('error', (error) => this.fail(error))
    child.on('exit', (code) => this.fail(new Error(`${logName} worker exited (${code ?? 'signal'})`)))
    // A write between the worker's death and its exit event fails with EPIPE, which becomes an uncaught
    // exception unless the stream has a listener.
    child.stdin.on('error', (error) => this.fail(error))
  }

  get alive(): boolean {
    return !this.stopped && this.child.exitCode === null && !this.child.killed
  }

  send(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.settleReady(false)
    if (this.child.exitCode === null && !this.child.killed) this.child.kill('SIGTERM')
  }

  private fail(error: Error): void {
    if (this.stopped) return
    console.error(`${this.logName}: ${error.message}`)
    this.stop()
    this.options.onFailure(error)
  }

  private handleLine(line: string): void {
    if (this.stopped) return
    let message: WorkerMessage
    try {
      message = this.read(line)
    } catch (error) {
      this.fail(error as Error)
      return
    }
    if (message.type === 'ready') {
      this.isReady = true
      this.settleReady(true)
    } else {
      this.options.onMessage(message)
    }
  }

  /** The message of a line, after the checks of the protocol that concern no request. Throws on a line that breaks it. */
  private read(line: string): WorkerMessage {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      throw new Error(`${this.logName} worker wrote a line on stdout that is not JSON: ${line.slice(0, 200)}`)
    }
    if (typeof message !== 'object' || message === null || Array.isArray(message) || typeof (message as { type?: unknown }).type !== 'string') {
      throw new Error(`${this.logName} worker wrote a line on stdout that is not a message: ${line.slice(0, 200)}`)
    }
    const read = message as WorkerMessage
    if (read.type === 'fatal') throw new Error(`${this.logName} worker could not start: ${describeWorkerError(read.error)}`)
    if (read.type === 'ready') {
      if (this.isReady) throw new Error(`${this.logName} worker reported ready a second time`)
      this.sampleRate = this.checkReady(read)
    }
    if (read.type === 'error') {
      const reason = describeWorkerError(read.error)
      // The worker answers a line it cannot place with an error without an id. ASIST writes every line it
      // sends, so this is ASIST's own defect.
      if (typeof read.id !== 'string') throw new Error(`${this.logName} worker could not take a line ASIST sent: ${reason}`)
    }
    return read
  }

  /** Checks that `ready` comes from a worker this client can speak to, running the model as asked, and returns the model's sample rate. */
  private checkReady(ready: WorkerMessage): number {
    const name = this.logName
    if (ready.protocol !== WORKER_PROTOCOL) throw new Error(`${name} worker speaks protocol ${JSON.stringify(ready.protocol)}, and ASIST speaks protocol ${WORKER_PROTOCOL}`)
    if (seriesOf(ready.version) !== SPEECH_CPP_SERIES) throw new Error(`${name} worker is speech.cpp ${JSON.stringify(ready.version)}, and ASIST is written for ${SPEECH_CPP_SERIES}.x`)
    const model = (typeof ready.model === 'object' && ready.model !== null ? ready.model : {}) as Record<string, unknown>
    if (model.task !== this.options.task) throw new Error(`${name} worker runs a model for ${JSON.stringify(model.task)}, not for ${this.options.task}`)
    if (model.device !== this.options.device) throw new Error(`${name} worker runs on ${JSON.stringify(model.device)}, not on ${this.options.device}`)
    if (typeof model.sample_rate !== 'number' || model.sample_rate <= 0) throw new Error(`${name} worker gives no sample rate in its model information`)
    return model.sample_rate
  }
}

/**
 * Starts a process of the local speech that reads nothing from ASIST, such as llama-server or the engine of
 * another app, so that it ends with ASIST however ASIST ends. Killed with ASIST on an Apple M5, llama-server ran
 * on for more than two days with launchd as its parent, while the workers that read stdin ended (2026-10-05).
 * On macOS it leads a process group of its own that a watcher stops when ASIST ends, and it is not started when
 * the watcher cannot be, with `engine` named in the error. On Windows it ended with a killed ASIST already, in
 * the job object libuv puts it into (RTX 2080, 2026-10-05).
 */
export function spawnUnattended(command: string, args: string[], options: SpawnOptions & { env: NodeJS.ProcessEnv }, engine: string): ChildProcess {
  const macos = platformCapabilities().os === 'macos'
  const child = spawn(command, args, { ...options, detached: macos, windowsHide: true })
  stopOnQuit(child)
  if (macos && child.pid !== undefined && !watchForAsistEnd(child, options.env, 'asist-speech-watcher')) {
    child.kill('SIGKILL')
    throw new Error(errorText('voice.speech.watcherUnavailable', { engine }))
  }
  return child
}

/** Starts `speech worker` at `command` on the model file, with the further arguments `args` and the device of the options. */
export function startSpeechWorker(command: string, model: string, args: string[], logName: string, options: WorkerOptions): SpeechWorker {
  const child = spawn(command, ['worker', model, ...args, '--device', options.device], { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv(), windowsHide: true })
  stopOnQuit(child)
  return new SpeechWorker(child, logName, options)
}
