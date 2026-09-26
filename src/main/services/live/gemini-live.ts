import type { TurnEvent } from '@shared/ipc'
import type { LiveEngineInfo } from '@shared/voice-engine'
import { geminiLiveCost } from '@shared/voice-engine'
import { errMessage } from '@shared/api-errors'
import { fillPrompt, promptText, type PromptText } from '@shared/conversation-locale'
import { marker } from '@shared/conversation-markers'
import { errorText } from '@shared/i18n/error-text'
import { conversationLocale } from '../conversation-locale'
import { LLM_PROVIDER_INFO } from '@shared/llm-catalog'
import type { ToolExecution, ToolExecutionTask } from '@shared/tool-registry'
import type { ConversationOwner } from '../brain/session'
import type { HistoryMessage } from '../brain/history'
import { LiveEngineBase, type LiveEngineDeps } from './engine'
import { decodeOutput } from './audio'
import type { GeminiFunctionDeclaration } from './gemini-tools'

/**
 * Gemini Live. One model listens, thinks, calls functions and speaks. It does not use brain's runTurn and
 * borrows only the tool registry and execution, the system prompt, memory, the conversation log and the
 * history seed from brain's parts.
 *
 * Functions are declared NON_BLOCKING so that the model keeps talking while one runs, and results come
 * back WHEN_IDLE so that they never cut the sentence being spoken. Tools still execute in the main
 * process, so the approval gate for writes keeps working. A session drops after about ten minutes and is
 * continued with a resumption handle, which is valid for two hours; without one, the history seed is sent
 * instead.
 */

/** The part of the SDK's Session that is used. Tests substitute a fake. */
export interface GeminiSession {
  sendRealtimeInput(params: { audio?: { data: string; mimeType: string }; audioStreamEnd?: boolean }): void
  sendClientContent(params: { turns: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>; turnComplete: boolean }): void
  sendToolResponse(params: { functionResponses: GeminiFunctionResponse[] }): void
  close(): void
}

export interface GeminiFunctionResponse {
  id: string
  name: string
  response: Record<string, unknown>
  scheduling: 'WHEN_IDLE' | 'INTERRUPT' | 'SILENT'
}

/** The part of the SDK's LiveServerMessage that is used. */
export interface GeminiServerMessage {
  setupComplete?: unknown
  serverContent?: {
    modelTurn?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string }; text?: string }> }
    turnComplete?: boolean
    interrupted?: boolean
    generationComplete?: boolean
    inputTranscription?: { text?: string; finished?: boolean }
    outputTranscription?: { text?: string; finished?: boolean }
  }
  toolCall?: { functionCalls?: GeminiFunctionCall[] }
  toolCallCancellation?: { ids?: string[] }
  goAway?: { timeLeft?: string }
  sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean }
}

/** One function call of a toolCall message. */
export interface GeminiFunctionCall {
  id?: string
  name?: string
  args?: Record<string, unknown>
}

export interface GeminiConnectParams {
  model: string
  systemInstruction: string
  voice: string
  functionDeclarations: GeminiFunctionDeclaration[]
  resumptionHandle: string | null
  callbacks: {
    onmessage: (message: GeminiServerMessage) => void
    onerror: (error: Error) => void
    onclose: (reason: string) => void
  }
}

export interface GeminiLiveDeps extends LiveEngineDeps {
  apiKey: () => string | undefined
  connect: (params: GeminiConnectParams) => Promise<GeminiSession>
  systemInstruction: (startedAt: Date) => string
  functionDeclarations: () => GeminiFunctionDeclaration[]
  executeTool: (name: string, input: Record<string, unknown>, ctx: { turnId: number; signal: AbortSignal; emit: (event: TurnEvent) => void }) => ToolExecutionTask
  /** Whether the registry lets the tool run at the same time as other calls, which a writing tool does not. */
  isParallel: (name: string) => boolean
  recordTool: (turnId: number, name: string, input: Record<string, unknown>, execution: ToolExecution) => void
  /** Looks for memories related to the user's utterance and returns a note about them, or null. */
  memoryInjection: (text: string) => Promise<string | null>
  /** Records typed input in the conversation log. A spoken user line is written when its transcript is final. */
  recordUser: (turnId: number, text: string) => void
  history: () => HistoryMessage[]
  emitTurn: (event: TurnEvent) => void
}

/** Wraps a sentence the app wants read out word for word, such as a timer that ran out. */
const READ_ALOUD: PromptText = {
  ja: `{systemNotice} 次の文をそのまま読み上げる: {text}`,
  en: `{systemNotice} Read the following sentence aloud exactly as it is: {text}`
}

const OPEN_TIMEOUT_MS = 15_000
/** How long a resumption handle is reused. The provider allows two hours, and this leaves a margin. */
const RESUMPTION_TTL_MS = 100 * 60_000
const INPUT_MIME = 'audio/pcm;rate=16000'
const OUTPUT_RATE = 24_000

export class GeminiLiveEngine extends LiveEngineBase implements ConversationOwner {
  private session: GeminiSession | null = null
  private resumption: { handle: string; at: number } | null = null
  private inputSeconds = 0
  private outputSeconds = 0
  /** The calls that still owe the model a result, waiting for their turn or running, by the id Gemini gave them. */
  private readonly running = new Map<string, AbortController>()
  /**
   * The calls whose work has not ended, for the read-write lock of a brain tool round (tool-round.ts): a
   * call the registry marks parallel waits for the writing calls before it, and a writing call waits for
   * every call before it, so that two approvals are never asked at once. The lock spans the session
   * rather than one message, because a NON_BLOCKING call can arrive while an earlier one still waits
   * for approval.
   */
  private readonly inFlight = new Set<Promise<void>>()
  private exclusiveTail: Promise<void> = Promise.resolve()

  constructor(
    info: LiveEngineInfo,
    private readonly deps: GeminiLiveDeps
  ) {
    super(info, deps)
  }

  protected async openSession(): Promise<void> {
    const key = this.deps.apiKey()
    if (!key) {
      const info = LLM_PROVIDER_INFO.google
      throw new Error(errorText('llmModels.errors.keyMissing', { provider: info.label, envKey: info.envKey }))
    }
    const settings = this.settings().geminiLive
    const resume = this.resumption && this.now() - this.resumption.at < RESUMPTION_TTL_MS ? this.resumption.handle : null
    let session: GeminiSession | null = null
    const setup = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(errorText('voice.live.openTimeout', { engine: this.info.label }))), OPEN_TIMEOUT_MS)
      this.deps
        .connect({
          model: settings.model,
          voice: settings.voice,
          systemInstruction: this.deps.systemInstruction(new Date(this.now())),
          functionDeclarations: this.deps.functionDeclarations(),
          resumptionHandle: resume,
          callbacks: {
            onmessage: (message) => {
              if (message.setupComplete !== undefined) {
                clearTimeout(timer)
                resolve()
              }
              this.onMessage(message)
            },
            onerror: (error) => {
              clearTimeout(timer)
              console.error('gemini-live error:', errMessage(error))
              this.events.emit('event', { type: 'error', message: errMessage(error) })
              reject(error)
            },
            onclose: (reason) => {
              clearTimeout(timer)
              if (this.session === session) this.onClosed(reason)
              reject(new Error(errorText('voice.live.closed', { engine: this.info.label, reason })))
            }
          }
        })
        .then((opened) => {
          session = opened
          this.session = opened
        })
        .catch((error: unknown) => {
          clearTimeout(timer)
          reject(error instanceof Error ? error : new Error(String(error)))
        })
    })
    await setup
    // A session that could not be resumed opens blank, so the recent history is sent as its context.
    if (!resume) this.seedHistory()
  }

  protected async closeSession(): Promise<void> {
    const session = this.session
    this.session = null
    for (const controller of this.running.values()) controller.abort()
    this.running.clear()
    if (!session) return
    try {
      session.sendRealtimeInput({ audioStreamEnd: true })
    } catch {
      // The session is already closed.
    }
    session.close()
  }

  protected transmitAudio(base64: string, seconds: number): void {
    if (!this.session) return
    this.session.sendRealtimeInput({ audio: { data: base64, mimeType: INPUT_MIME } })
    this.inputSeconds += seconds
  }

  private onClosed(reason: string): void {
    this.session = null
    this.policy.closed()
    if (this.enabled) {
      console.warn(`gemini-live: connection closed (${reason})`)
      this.setConnection('idle')
    }
  }

  private seedHistory(): void {
    const messages = this.deps.history().slice(-30)
    if (messages.length === 0 || !this.session) return
    this.session.sendClientContent({
      turns: messages.map((message) => ({ role: message.role === 'user' ? 'user' : 'model', parts: [{ text: message.content }] })),
      turnComplete: false
    })
  }

  private onMessage(message: GeminiServerMessage): void {
    const content = message.serverContent
    if (content) {
      if (content.inputTranscription?.text) this.pushTranscript('user', content.inputTranscription.text)
      if (content.inputTranscription?.finished) this.transcripts.flush('user')
      if (content.outputTranscription?.text) this.pushTranscript('assistant', content.outputTranscription.text)
      for (const part of content.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) {
          const samples = decodeOutput(part.inlineData.data)
          this.outputSeconds += samples.length / OUTPUT_RATE
          this.emitAudio(samples)
        }
      }
      if (content.interrupted) {
        // The transcript of what was spoken is finalized before the interruption is announced. In the
        // other order the final text reaches the renderer after it closed the line, and the same sentence
        // appears twice.
        this.transcripts.flush('assistant')
        this.events.emit('event', { type: 'interrupted' })
      }
      if (content.turnComplete) {
        this.transcripts.flush('assistant')
        this.emitUsage({ sessionSeconds: Math.round(this.inputSeconds), costUsd: geminiLiveCost(this.inputSeconds, this.outputSeconds) })
      }
    }
    for (const call of message.toolCall?.functionCalls ?? []) this.submitTool(call)
    for (const id of message.toolCallCancellation?.ids ?? []) {
      this.running.get(id)?.abort()
      this.running.delete(id)
    }
    if (message.sessionResumptionUpdate?.resumable && message.sessionResumptionUpdate.newHandle) {
      this.resumption = { handle: message.sessionResumptionUpdate.newHandle, at: this.now() }
    }
    if (message.goAway) console.warn(`gemini-live: GoAway (${message.goAway.timeLeft ?? '?'})`)
  }

  /** A call belongs to the exchange it arrived in, and it runs once the calls it waits for have ended. */
  private submitTool(call: GeminiFunctionCall): void {
    const turnId = this.ensureTurnStarted((event) => this.deps.emitTurn(event))
    const controller = new AbortController()
    this.running.set(call.id ?? '', controller)
    this.touch()
    const parallel = this.deps.isParallel(call.name ?? '')
    const gate = parallel ? this.exclusiveTail : Promise.allSettled([...this.inFlight]).then(() => undefined)
    const done = gate
      .then(() => this.runTool(call, turnId, controller))
      .catch((err: unknown) => console.error('gemini-live function call failed:', errMessage(err)))
    this.inFlight.add(done)
    void done.then(() => this.inFlight.delete(done))
    if (!parallel) this.exclusiveTail = done
  }

  private async runTool(call: GeminiFunctionCall, turnId: number, controller: AbortController): Promise<void> {
    if (controller.signal.aborted) return
    const id = call.id ?? ''
    const name = call.name ?? ''
    const emit = (event: TurnEvent): void => this.deps.emitTurn(event)
    emit({ type: 'tool', turnId, name, status: 'start' })
    let execution: ToolExecution
    let completion: Promise<void> = Promise.resolve()
    try {
      const task = this.deps.executeTool(name, call.args ?? {}, { turnId, signal: controller.signal, emit })
      completion = task.completion
      execution = await task
    } catch (err) {
      const content = errMessage(err)
      execution = { content, isError: true, durationMs: 0, resultLength: content.length, truncated: false }
    }
    if (this.running.get(id) === controller) this.running.delete(id)
    if (!controller.signal.aborted) {
      emit({ type: 'tool', turnId, name, status: execution.isError ? 'error' : 'done' })
      this.deps.recordTool(turnId, name, call.args ?? {}, execution)
      this.touch()
      this.session?.sendToolResponse({
        functionResponses: [
          {
            id,
            name,
            response: execution.isError ? { error: execution.content } : { result: execution.content },
            scheduling: 'WHEN_IDLE'
          }
        ]
      })
    }
    // A timed-out tool has answered but may still be working, so the lock is held until its work ends.
    await completion
  }

  private sendUserText(text: string): void {
    this.session?.sendClientContent({ turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true })
    this.touch()
  }

  /** Typed input. No transcript event is emitted, because the renderer already shows the typed text in the feed. */
  async sendText(text: string): Promise<void> {
    await this.ensureOpen()
    const turnId = this.exchange()
    this.deps.recordUser(turnId, text)
    this.sendUserText(`${marker(conversationLocale(), 'typedInput')} ${text}`)
  }

  async notify(text: string): Promise<void> {
    await this.ensureOpen()
    this.sendUserText(text)
  }

  async say(text: string): Promise<void> {
    await this.ensureOpen()
    const locale = conversationLocale()
    this.sendUserText(fillPrompt(promptText(locale, READ_ALOUD), { systemNotice: marker(locale, 'systemNotice'), text }))
  }

  /** A user utterance is final. Any related memory is added to the context silently, without asking for a reply. */
  protected override onUserUtterance(_turnId: number, text: string): void {
    void this.deps
      .memoryInjection(text)
      .then((injection) => {
        if (!injection || !this.session) return
        this.session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: injection }] }], turnComplete: false })
      })
      .catch((err) => console.error('gemini-live memory injection failed:', errMessage(err)))
  }

  protected emitTurn(event: TurnEvent): void {
    this.deps.emitTurn(event)
  }
}
