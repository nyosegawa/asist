import { isJobTerminal } from '@shared/job-status'
import type { HangoverMode, LiveEvent, TurnEvent, TurnTimings } from '@shared/ipc'
import { isSelfEcho, stripClipEcho } from '@shared/self-echo'
import { conversationFeatures } from '@shared/conversation-locale'
import { isLiveEngine, type VoiceEngine } from '@shared/voice-engine'
import { safetyNoticePending } from '@shared/settings'
import { translate } from '@/i18n'
import { voiceController } from '@/voice/VoiceController'
import { liveVoice } from '@/voice/LiveVoice'
import { speechPlayer } from '@/voice/SpeechPlayer'
import { InterjectPlaybackAcks } from '@/interject-playback'
import { TurnMetrics, type RequestTimings } from '@/turn-metrics'
import { loadAizuchiBank, pickAizuchi, pickListeningClip } from '@/voice/aizuchi-bank'
import { TurnOpening } from '@/voice/opening'
import { BridgePlanner } from '@/voice/bridge-plan'
import { AizuchiClassifierFeed } from '@/voice/aizuchi-classify'
import {
  useFeedStore,
  useJobStore,
  useLiveStore,
  usePanelStore,
  useSettingsStore,
  useStatusStore,
  useToastStore,
  useTurnStore, useTaskStore, useNoteStore, useMailStore } from '@/state/stores'
import { useConfirmStore } from '@/state/confirm'
import { startMiniAppReports, useViewStore } from '@/state/view'
import { displayError } from '@/display-error'

/** The conversation orchestrator, wiring the voice pipeline, brain, panels and feed. It initializes once, when App mounts. */

let initialization: Promise<void> | null = null
let aiLineId: number | null = null
let pendingRequestId: string | null = null
let activeRequestId: string | null = null
const turnMetrics = new TurnMetrics((payload) => window.api.metricsLog(payload))
/**
 * What may sound at the opening of a turn. With the TTS engine set to none neither part is played,
 * and the aizuchi are Japanese while the bridge sentence is spoken in every language.
 */
function openingPolicy(): { aizuchi: boolean; bridge: boolean } {
  const settings = useSettingsStore.getState().settings
  if (!settings || !settings.aizuchi || settings.ttsEngine === 'none') return { aizuchi: false, bridge: false }
  return { aizuchi: conversationFeatures(settings.conversationLocale).aizuchi, bridge: true }
}
/** Reloads the clips for the conversation language, which drops them where that language has no aizuchi. */
function reloadAizuchiBank(): void {
  const settings = useSettingsStore.getState().settings
  if (settings) void loadAizuchiBank(settings.conversationLocale)
}
/** The configured voice engine. A live engine both listens and speaks, so the feed shows its transcript instead of the brain's delta. */
const voiceEngine = (): VoiceEngine => useSettingsStore.getState().settings?.voiceEngine ?? 'cascade'
const liveMode = (): boolean => isLiveEngine(voiceEngine())
/** The feed lines that carry a live transcript, one per turnId. The user transcript is held separately because it can arrive after the reply. */
let liveAiLineId: number | null = null
let liveAiTurnId = -1
let liveUserLineId: number | null = null
let liveUserTurnId = -1

/** The latest assistant utterance, used as context for the look-ahead and to tell whether the user is answering a question. */
function lastAssistantText(): string {
  const lines = useFeedStore.getState().lines
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].role === 'ai' && lines[i].text) return lines[i].text
  }
  return ''
}

/** Look-ahead on a fast model while the user is still speaking, so the bridge sentence is ready before speech ends. */
const planner = new BridgePlanner({
  plan: (input) => window.api.bridgePlan(input),
  onPlan: (plan) => {
    if (plan.bridge) useTurnStore.getState().setRouterNote(translate('hud.router.bridge', { text: plan.bridge }))
  },
  onFailure: (error) => {
    console.warn('bridge plan failed:', error)
    useTurnStore.getState().setRouterNote(translate('hud.router.bridgeFailed'))
  }
})

/** The aizuchi classifier runs on every partial recognition; the latest result at speech end picks the aizuchi. Without the worker no aizuchi sounds. */
const classifier = new AizuchiClassifierFeed({
  classify: (input) => window.api.aizuchiClassify(input),
  onResult: (result) =>
    useTurnStore.getState().setRouterNote(
      translate('hud.router.aizuchi', {
        kind: translate(`hud.aizuchiClass.${result.cls}`),
        percent: Math.round(result.prob * 100)
      })
    ),
  onFailure: (error) => console.warn('aizuchi classify failed:', error)
})

/** Records the outcome of the bridge, including why it did not sound, in the HUD and the turn metrics. */
function noteBridgeOutcome(patch: TurnTimings): void {
  const turn = useTurnStore.getState()
  turn.mergeTimings(patch)
  if (turn.activeTurnId >= 0) turnMetrics.update(turn.activeTurnId, patch)
}

/** The opening of a turn, the aizuchi and the bridge. It sounds at speech end from VAD and is handed to the brain with the final transcript. */
const opening = new TurnOpening({
  pickAizuchi: (classification) => {
    const settings = useSettingsStore.getState().settings
    return pickAizuchi(classification, { enabled: settings?.aizuchi ?? false, rate: settings?.aizuchiRate ?? 0 })
  },
  play: (clip, role) => {
    recordClip(clip.text)
    speechPlayer.playClip(clip.audio, clip.text, { role })
  },
  synthesizeBridge: (text) => window.api.bridgeSynthesize(text),
  bodyQueuedAfter: (time) => speechPlayer.bodyQueuedAfter(time),
  onBridgeOutcome: noteBridgeOutcome
})
const interjectPlayback = new InterjectPlaybackAcks((turnId, status) =>
  window.api.turnPlaybackAck(turnId, status)
)

/** Assistant utterances played recently, kept to recognize what the speaker leaks back into the microphone. */
const recentSpeech: Array<{ text: string; t: number }> = []
const SELF_ECHO_WINDOW_MS = 15_000

function recordSpokenText(text: string): void {
  const now = performance.now()
  recentSpeech.push({ text, t: now })
  while (recentSpeech.length > 0 && now - recentSpeech[0].t > SELF_ECHO_WINDOW_MS) {
    recentSpeech.shift()
  }
}

/** Reports a transcript that is the assistant's own speech coming back through the speaker. This is the last line of defense. */
function isRecentSelfEcho(utterance: string): boolean {
  const now = performance.now()
  const texts = recentSpeech.filter((s) => now - s.t <= SELF_ECHO_WINDOW_MS).map((s) => s.text)
  return isSelfEcho(utterance, texts)
}

/**
 * A record of the aizuchi clips that were played, such as "はい。" or "うん". `isSelfEcho` does not
 * judge short utterances, so that a genuine "はい" answer survives, and the echo of a short clip is
 * removed by time correlation instead: whether the clip actually sounded while the utterance was
 * captured. Listening aizuchi are played through WebAudio and therefore never reach the echo
 * canceller as a reference signal, so they mix into the capture easily.
 */
const recentClips: Array<{ text: string; t: number }> = []
const CLIP_WINDOW_HEAD_MS = 500

function recordClip(text: string): void {
  recentClips.push({ text, t: performance.now() })
  while (recentClips.length > 8) recentClips.shift()
}

/** Strips the clips that sounded inside the capture window, from startedAt minus 500 ms until now, off the ends of the transcript. */
function stripClipsInCaptureWindow(utterance: string, startedAt: number): string {
  const now = performance.now()
  const texts = recentClips
    .filter((c) => c.t >= startedAt - CLIP_WINDOW_HEAD_MS && c.t <= now)
    .map((c) => c.text)
  if (texts.length === 0) return utterance
  return stripClipEcho(utterance, texts)
}

export function initConversation(): Promise<void> {
  if (initialization) return initialization
  const operation = initializeConversation().catch((error) => {
    if (initialization === operation) initialization = null
    throw error
  })
  initialization = operation
  return operation
}

async function initializeConversation(): Promise<void> {

  const turn = useTurnStore.getState()
  const feed = useFeedStore.getState()
  const toasts = useToastStore.getState()

  await useSettingsStore.getState().load()
  const bootStatus = await window.api.getStatus()
  useStatusStore.getState().apply(bootStatus)
  applySettings()
  voiceController.handleAsrStatus(bootStatus.asr)
  useSettingsStore.subscribe(({ settings }, { settings: before }) => {
    applySettings()
    if (settings && before && (
      settings.ttsEngine !== before.ttsEngine ||
      settings.voicevoxSpeaker !== before.voicevoxSpeaker ||
      settings.aivisSpeaker !== before.aivisSpeaker ||
      settings.qwenTtsVoice !== before.qwenTtsVoice ||
      settings.conversationLocale !== before.conversationLocale
    )) reloadAizuchiBank()
    // Changing the voice engine, or the live model or voice, stops a running microphone; main stops
    // its live engine for the same change.
    if (settings && before && (
      settings.voiceEngine !== before.voiceEngine ||
      JSON.stringify(settings.gptLive) !== JSON.stringify(before.gptLive) ||
      JSON.stringify(settings.geminiLive) !== JSON.stringify(before.geminiLive)
    ) && (voiceController.current !== 'off' || liveVoice.current !== 'off')) {
      voiceController.disable()
      liveVoice.disable()
      toasts.push({
        kind: 'info',
        title: translate('voice.engineChanged.title'),
        body: translate('voice.engineChanged.body')
      })
    }
  })

  reloadAizuchiBank()

  // The aizuchi bank is synthesized by the TTS service, so it is loaded again once TTS recovers.
  window.api.onStatusChanged((status) => {
    const prev = useStatusStore.getState().status
    useStatusStore.getState().apply(status)
    voiceController.handleAsrStatus(status.asr)
    if (prev && !prev.tts && status.tts) reloadAizuchiBank()
    if (prev && (prev.asr !== status.asr || prev.tts !== status.tts)) {
      const parts: string[] = []
      if (prev.asr !== status.asr) {
        parts.push(translate(status.asr ? 'voice.services.recognitionBack' : 'voice.services.recognitionStopped'))
      }
      if (prev.tts !== status.tts) {
        parts.push(translate(status.tts ? 'voice.services.speechBack' : 'voice.services.speechStopped'))
      }
      toasts.push({
        kind: status.asr && status.tts ? 'ok' : 'info',
        title: translate('voice.services.title'),
        body: parts.join(' · ')
      })
    }
  })

  // Coming back online, and becoming visible again after something like a sleep and wake, rebuild
  // the capture and audio context that froze and refresh the service status. A short window switch
  // must not disturb the microphone.
  let hiddenAt = 0
  const recoverAfterInterruption = (): void => {
    void useStatusStore.getState().refresh().then(() => {
      const status = useStatusStore.getState().status
      if (status) voiceController.handleAsrStatus(status.asr)
    })
    speechPlayer.recover()
    void voiceController.recover()
    void liveVoice.recover()
  }
  window.addEventListener('online', recoverAfterInterruption)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now()
    } else if (hiddenAt > 0 && Date.now() - hiddenAt >= 10_000) {
      hiddenAt = 0
      recoverAfterInterruption()
    }
  })

  voiceController.events.on('state', (state) => {
    const t = useTurnStore.getState()
    if (state === 'off') t.setMic('off')
    else if (state === 'loading') t.setMic('loading')
    else t.setMic('on')
    if (state === 'capturing') {
      t.setPhase('listen')
      planner.reset()
      classifier.reset()
    }
  })

  voiceController.events.on('progress', (progress) =>
    useTurnStore.getState().setMic('loading', progress)
  )

  voiceController.events.on('partial', (text) => {
    useTurnStore.getState().setPartial(text)
    const policy = openingPolicy()
    if (policy.bridge) planner.observe({ text, lastAssistantText: lastAssistantText() })
    if (policy.aizuchi) classifier.observe({ prev: lastAssistantText(), text })
  })

  voiceController.events.on('bargein', () => {
    // The VoiceController has just dropped the playback queue, so interjections that never played
    // are returned to main.
    interjectPlayback.interruptPending()
    const active = useTurnStore.getState().activeTurnId
    if (active >= 0) {
      turnMetrics.increment(active, 'bargeIns')
      usePanelStore.getState().dismissLoadingOwnedBy(active)
      void window.api.turnAbort(active)
    }
  })

  // A "うん" or "はい" spoken during playback was taken as an aizuchi, so playback keeps going
  // instead of stopping.
  voiceController.events.on('userBackchannel', () => {
    const turn = useTurnStore.getState()
    turn.setRouterNote(translate('hud.router.heardAsBackchannel'))
    if (turn.activeTurnId >= 0) turnMetrics.increment(turn.activeTurnId, 'userBackchannels')
  })

  // Listening aizuchi: a quiet "うん" or "なるほど" at a break in a long user utterance, which does
  // not stop the conversation.
  voiceController.events.on('backchannel', ({ kind }) => {
    const clip = pickListeningClip(kind)
    if (clip?.audio) {
      recordClip(clip.text)
      speechPlayer.playClip(clip.audio, '', { role: 'listening', volume: 0.4 })
    }
  })

  // At speech end, as decided by VAD, the aizuchi sounds without waiting for the final transcript
  // and measurement of this utterance begins.
  voiceController.events.on('speechend', (end) => {
    const policy = openingPolicy()
    const turn = useTurnStore.getState()
    turn.resetTimings()
    turn.mergeTimings({
      vadMs: end.vadMs,
      vadMode: end.vadMode,
      ...(end.listening.length > 0 ? { listening: end.listening } : {})
    })
    opening.begin({
      startedAt: end.startedAt,
      speechEndAt: end.speechEndAt,
      // The aizuchi is chosen from the classification available now and is skipped when there is
      // none, while the bridge waits for the look-ahead in flight.
      classification: policy.aizuchi ? classifier.current() : null,
      plan: policy.bridge
        ? planner.finish({ text: end.partialText, lastAssistantText: lastAssistantText() })
        : Promise.resolve(null),
      sinceListeningMs: voiceController.msSinceBackchannel
    })
  })

  voiceController.events.on('utterance', ({ text, vadMs, vadMode, asrMs, partialText, startedAt, speechEndAt }) => {
    // The echo of the aizuchi clips that sounded during capture is stripped off the ends, and the
    // utterance is dropped when nothing but echo is left.
    const cleaned = stripClipsInCaptureWindow(text, startedAt)
    if (!cleaned) {
      useTurnStore.getState().setRouterNote(translate('hud.router.droppedClipEcho'))
      opening.cancel(startedAt)
      return
    }
    if (isRecentSelfEcho(cleaned)) {
      useTurnStore.getState().setRouterNote(translate('hud.router.droppedSelfEcho'))
      opening.cancel(startedAt)
      return
    }
    void startVoiceTurn(cleaned, { vadMs, vadMode, asrMs, partialText, speechEndAt }, opening.claim(startedAt))
  })

  voiceController.events.on('error', (message) =>
    toasts.push({ kind: 'error', title: translate('voice.micFailed'), body: message })
  )

  liveVoice.events.on('state', (state) => {
    const t = useTurnStore.getState()
    t.setMic(state)
    if (state === 'off') {
      speechPlayer.streamClear()
      t.setPartial('')
      t.setPhase('idle')
      useLiveStore.getState().reset()
    }
  })
  liveVoice.events.on('error', (message) => toasts.push({ kind: 'error', title: translate('voice.micLiveFailed'), body: message }))
  window.api.onLiveEvent((event) => handleLiveEvent(event))
  window.api.onLiveAudio((samples) => {
    speechPlayer.streamPush(samples instanceof Float32Array ? samples : new Float32Array(samples), 24_000)
  })
  speechPlayer.events.on('streamstart', () => useTurnStore.getState().setPhase('speak'))
  speechPlayer.events.on('streamidle', () => {
    const t = useTurnStore.getState()
    if (t.phase === 'speak') t.setPhase(liveVoice.current === 'on' ? 'listen' : 'idle')
  })

  window.api.onTurnEvent((event) => handleTurnEvent(event))
  startMiniAppReports()
  window.api.onTasksChanged((tasks) => useTaskStore.getState().apply(tasks))
  void useTaskStore.getState().load()
  window.api.onNotesChanged((notes) => useNoteStore.getState().apply(notes))
  void useNoteStore.getState().load()
  // Mail status is copied into the store, while a fetch or a change bumps a generation so the views
  // and the cards load again. A draft that was sent or discarded has its card closed.
  window.api.onMailEvent((event) => {
    if (event.type === 'status') useMailStore.getState().apply(event.status)
    else if (event.type === 'drafts') {
      const alive = new Set(event.drafts.map((draft) => `mail-draft:${draft.id}`))
      useMailStore.getState().applyDrafts(event.drafts)
      for (const panel of usePanelStore.getState().panels) {
        if (panel.type === 'mail-draft' && !alive.has(panel.key)) usePanelStore.getState().apply({ op: 'dismiss', key: panel.key })
      }
    } else useMailStore.getState().bump()
  })
  void useMailStore.getState().refresh()
  void useMailStore.getState().loadDrafts()
  // Confirmations that main asks for, on mail and calendar, are answered in the app's own sheet.
  window.api.onConfirmEvent((event) => {
    if (event.type === 'open') useConfirmStore.getState().open(event.request)
    else useConfirmStore.getState().close(event.id)
  })

  window.api.onHotkeyMic(() => {
    if (liveMode()) {
      if (liveVoice.current === 'off') void liveVoice.enable()
    } else if (voiceController.current === 'off') {
      void voiceController.enable()
    }
  })

  window.api.onPanelEvent((event) => {
    usePanelStore.getState().apply(event)
  })

  window.api.onJobEvent((event) => {
    const previousStatus = event.type === 'update'
      ? useJobStore.getState().jobs.find((job) => job.id === event.job.id)?.status
      : undefined
    useJobStore.getState().apply(event)
    if (event.type === 'update' && isJobTerminal(event.job.status) && previousStatus !== event.job.status) {
      const kind = event.job.status === 'done' ? 'ok' : event.job.status === 'error' ? 'error' : 'info'
      useToastStore.getState().push({
        kind,
        title: translate(
          event.job.status === 'done'
            ? 'conversation.job.done'
            : event.job.status === 'error'
              ? 'conversation.job.error'
              : 'conversation.job.cancelled'
        ),
        body: event.job.title
      })
      // The agent-job card reads its body from the store, but it is patched anyway so that the card
      // does not stay on a stale render.
      usePanelStore.getState().apply(
        { op: 'patch', key: `job:${event.job.id}`, props: { jobId: event.job.id } }
      )
    }
  })

  speechPlayer.events.on('segmentstart', ({ segment, durationMs }) => {
    interjectPlayback.markSegmentStarted(segment)
    if (segment.text) recordSpokenText(segment.text)
    const t = useTurnStore.getState()
    if (segment.clip) {
      // An aizuchi is measured at the moment it actually sounds. Before the turn starts the value is
      // only held for the HUD; once the turn is running it is added to the turn's metrics.
      const patch = opening.clipStarted(segment.clip, durationMs, performance.now())
      if (patch) {
        t.mergeTimings(patch)
        if (t.activeTurnId >= 0) turnMetrics.update(t.activeTurnId, patch)
      }
      return
    }
    if (segment.index >= 0) {
      t.setPhase('speak')
      const e2eMs = turnMetrics.playbackStarted(segment.turnId, segment.index)
      if (e2eMs !== undefined && segment.turnId === t.activeTurnId) t.mergeTimings({ e2eMs })
    }
  })

  speechPlayer.events.on('idle', ({ turnId }) => {
    const t = useTurnStore.getState()
    if (t.phase === 'speak') t.setPhase('idle')
    // A turn whose playback has finished is closed after the events counted during playback are
    // appended to it.
    turnMetrics.playbackIdle(turnId)
  })

  void useJobStore.getState().load()
  feed.append({ role: 'sys', text: '', message: { key: 'conversation.start' } })
  startMicAtLaunch()

  turn.setPhase('idle')
}

/**
 * Turns the microphone on when the user chose to have it on at launch. It stays off while the setup or
 * the notice of the risks covers the app, so that nothing is heard before they are answered.
 */
export function startMicAtLaunch(): void {
  const settings = useSettingsStore.getState().settings
  if (!settings?.micAutoStart || settings.onboardingVersion < 1 || safetyNoticePending(settings)) return
  if (liveMode()) void liveVoice.enable()
  else void voiceController.enable()
}

function handleLiveEvent(event: LiveEvent): void {
  const turn = useTurnStore.getState()
  const feed = useFeedStore.getState()
  const live = useLiveStore.getState()
  switch (event.type) {
    case 'connection': {
      live.setConnection(event.state, event.detail)
      const state = translate(`hud.connection.${event.state}`)
      turn.setRouterNote(
        event.detail
          ? translate('hud.router.liveDetail', { state, detail: event.detail })
          : translate('hud.router.live', { state })
      )
      if (event.state === 'open' && liveVoice.current === 'on') turn.setPhase('listen')
      break
    }
    case 'userTranscript': {
      // The user transcript is inserted before the reply line when the reply of the same turn
      // arrived first.
      if (liveUserLineId === null || liveUserTurnId !== event.turnId) {
        const line = { role: 'user' as const, text: event.text, turnId: event.turnId, streaming: !event.final }
        liveUserLineId = liveAiTurnId === event.turnId && liveAiLineId !== null ? feed.insertBefore(liveAiLineId, line) : feed.append(line)
        liveUserTurnId = event.turnId
      } else {
        feed.update(liveUserLineId, { text: event.text, streaming: !event.final })
      }
      if (!event.final) {
        if (!speechPlayer.isStreaming) turn.setPhase('listen')
        break
      }
      liveUserLineId = null
      liveUserTurnId = -1
      if (!speechPlayer.isStreaming) turn.setPhase('think')
      break
    }
    case 'assistantTranscript': {
      if (liveAiLineId === null || liveAiTurnId !== event.turnId) {
        liveAiLineId = feed.append({ role: 'ai', text: event.text, turnId: event.turnId, streaming: !event.final })
        liveAiTurnId = event.turnId
      } else {
        feed.update(liveAiLineId, { text: event.text, streaming: !event.final })
      }
      if (event.final) {
        liveAiLineId = null
        liveAiTurnId = -1
      }
      break
    }
    case 'interrupted': {
      // Only the queued audio is dropped, and the transcript line is kept, because the final
      // transcript arrives later with the same turn id and rewrites that line.
      speechPlayer.streamClear()
      if (liveAiLineId !== null) feed.update(liveAiLineId, { streaming: false })
      turn.setRouterNote(translate('hud.router.interrupted'))
      break
    }
    case 'latency':
      live.setLatency(event.responseMs > 0 ? event.responseMs : null, event.connectMs)
      break
    case 'usage':
      live.setUsage(event.usage)
      break
    case 'error':
      useToastStore.getState().push({ kind: 'error', title: translate('voice.liveFailed'), body: event.message })
      feed.append({ role: 'sys', text: '', message: { key: 'conversation.error', values: { message: event.message.slice(0, 120) } } })
      break
  }
}

function applySettings(): void {
  const s = useSettingsStore.getState().settings
  if (!s) return
  liveVoice.nativeMicPreferred = s.nativeMic
  liveVoice.noiseSuppression = s.noiseSuppression
  voiceController.bargeIn = s.bargeIn
  voiceController.partialIntervalMs = s.partialIntervalMs
  voiceController.conversationLocale = s.conversationLocale
  voiceController.listeningAizuchi = s.listeningAizuchi && s.ttsEngine !== 'none'
  voiceController.holdProvider =
    s.aizuchi && conversationFeatures(s.conversationLocale).aizuchi ? () => classifier.holding() : null
  voiceController.localFallbackEnabled = s.localAsrEnabled
  voiceController.nativeMicPreferred = s.nativeMic
  voiceController.noiseSuppression = s.noiseSuppression
  voiceController.vapEnabled = s.vapEnabled
  voiceController.setHangover(s.hangoverMs)
}

function beginUserTurnRequest(
  metrics: RequestTimings
): { requestId: string; previousTurnId: number } {
  const turn = useTurnStore.getState()
  const previousTurnId = turn.activeTurnId
  const requestId = crypto.randomUUID()

  // Events of the previous turn stop being accepted from the moment new input arrives.
  pendingRequestId = requestId
  activeRequestId = null
  turn.setActiveTurn(-1)
  if (aiLineId !== null) useFeedStore.getState().update(aiLineId, { streaming: false })
  aiLineId = null
  interjectPlayback.interruptPending()
  // The previous turn's speech stops, but the aizuchi that started at this utterance's speech end
  // keeps playing.
  speechPlayer.discardBody()
  turnMetrics.beginRequest(requestId, metrics)
  if (previousTurnId >= 0) {
    usePanelStore.getState().dismissLoadingOwnedBy(previousTurnId)
    turnMetrics.discard(previousTurnId)
  }
  return { requestId, previousTurnId }
}

function isCurrentUserTurnRequest(requestId: string): boolean {
  return pendingRequestId === requestId || activeRequestId === requestId
}

function activateTurn(
  turnId: number,
  requestId: string | null,
  preservePlayback = false
): void {
  const turn = useTurnStore.getState()
  const alreadyActive = turn.activeTurnId === turnId && activeRequestId === requestId
  turn.setActiveTurn(turnId)
  if (!alreadyActive && requestId !== null) {
    turnMetrics.activate(turnId, requestId, turn.timings)
  }
  activeRequestId = requestId
  pendingRequestId = null
  if (alreadyActive) return
  speechPlayer.beginTurn(turnId, preservePlayback)
  aiLineId = null
}

async function finishUserTurnStart(requestId: string, turnId: number): Promise<boolean> {
  // Responses to invoke can arrive out of order, so anything but the newest request stays dead.
  if (pendingRequestId !== requestId && activeRequestId !== requestId) {
    await window.api.turnAbort(turnId).catch(() => {})
    return false
  }
  activateTurn(turnId, requestId)
  return true
}

function failUserTurnStart(requestId: string, error: unknown): void {
  if (pendingRequestId !== requestId && activeRequestId !== requestId) return
  pendingRequestId = null
  activeRequestId = null
  turnMetrics.discardRequest(requestId)
  aiLineId = null
  const message = displayError(error)
  const turn = useTurnStore.getState()
  turn.setActiveTurn(-1)
  turn.setPhase('idle')
  useToastStore.getState().push({ kind: 'error', title: translate('conversation.replyStartFailed'), body: message })
  useFeedStore.getState().append({ role: 'sys', text: '', message: { key: 'conversation.error', values: { message: message.slice(0, 120) } } })
}

/**
 * A turn started from the final transcript. Measurement of the VAD and of this utterance's aizuchi
 * already began at speech end, so only the ASR interval is added here. The opening belongs to the
 * same utterance and is null when nothing sounded.
 */
async function startVoiceTurn(
  text: string,
  measured: {
    vadMs: number
    vadMode: HangoverMode
    asrMs: number
    partialText: string
    speechEndAt: number
  },
  spokenOpening: { aizuchi: string | null; bridge: string | null; bridgePending: boolean } | null
): Promise<void> {
  const turn = useTurnStore.getState()
  const feed = useFeedStore.getState()
  const { requestId, previousTurnId } = beginUserTurnRequest({
    typed: false,
    speechEndAt: measured.speechEndAt
  })
  if (previousTurnId >= 0) await window.api.turnAbort(previousTurnId).catch(() => {})
  // When newer input starts while the abort IPC is still pending, the older request must not be
  // sent to main and interrupt the newest turn.
  if (!isCurrentUserTurnRequest(requestId)) return
  turn.mergeTimings({ vadMs: measured.vadMs, vadMode: measured.vadMode, asrMs: measured.asrMs })
  turn.setPartial('')
  turn.setPhase('think')
  feed.append({ role: 'user', text })

  try {
    const turnId = await window.api.turnStart(text, {
      ...(spokenOpening?.aizuchi ? { aizuchi: spokenOpening.aizuchi } : {}),
      ...(spokenOpening?.bridge ? { bridge: spokenOpening.bridge } : {}),
      ...(spokenOpening?.bridgePending ? { bridgePending: true } : {}),
      clientRequestId: requestId
    })
    await finishUserTurnStart(requestId, turnId)
  } catch (error) {
    failUserTurnStart(requestId, error)
  }
}

/** A turn started from typed text, with no aizuchi and no end-to-end measurement. In live mode the text goes to main's live engine. */
export async function sendTypedMessage(text: string): Promise<void> {
  const trimmed = text.trim()
  if (!trimmed) return
  const turn = useTurnStore.getState()
  if (liveMode()) {
    useFeedStore.getState().append({ role: 'user', text: trimmed })
    turn.setPhase('think')
    try {
      await window.api.liveText(trimmed)
    } catch (error) {
      const message = displayError(error)
      turn.setPhase('idle')
      useToastStore.getState().push({ kind: 'error', title: translate('conversation.sendFailed'), body: message })
    }
    return
  }
  const { requestId, previousTurnId } = beginUserTurnRequest({ typed: true })
  if (previousTurnId >= 0) await window.api.turnAbort(previousTurnId).catch(() => {})
  if (!isCurrentUserTurnRequest(requestId)) return
  turn.resetTimings()
  turn.setPhase('think')
  useFeedStore.getState().append({ role: 'user', text: trimmed })
  try {
    const turnId = await window.api.turnStart(trimmed, { typed: true, clientRequestId: requestId })
    await finishUserTurnStart(requestId, turnId)
  } catch (error) {
    failUserTurnStart(requestId, error)
  }
}

/** What the HUD calls the tool the turn is running. A tool with no name of its own is shown by its own name. */
function toolLabel(name: string, detail?: string): string {
  switch (name) {
    case 'web_search':
      return detail ? translate('hud.tool.webSearchQuery', { query: detail }) : translate('hud.tool.webSearch')
    case 'run_agent_task':
      return translate('hud.tool.runAgent')
    case 'get_agent_job':
      return translate('hud.tool.checkJobs')
    case 'cancel_agent_job':
      return translate('hud.tool.cancelJob')
    case 'recall':
      return translate('hud.tool.recall')
    default:
      return name.startsWith('show_') ? translate('hud.tool.card', { name: name.slice('show_'.length) }) : name
  }
}

export function handleTurnEvent(event: TurnEvent): void {
  const turn = useTurnStore.getState()
  const feed = useFeedStore.getState()

  if (event.type === 'started') {
    if (event.origin === 'live') {
      // A turn the live engine started, through GPT-Live delegation or Gemini function calling.
      // There is no renderer request to match it against, so it is always accepted.
      activateTurn(event.turnId, null, true)
      return
    }
    if (event.origin === 'user') {
      // The start event from main and the invoke response can arrive in either order, so the
      // requestId matches them to the same start request.
      if (event.requestId !== pendingRequestId && event.requestId !== activeRequestId) return
      activateTurn(event.turnId, event.requestId ?? null)
      return
    }
    // An interjection such as a job completion report is accepted only while no user turn runs.
    if (turn.activeTurnId === event.turnId) return
    if (pendingRequestId !== null || turn.activeTurnId >= 0) {
      // Main can observe idle just as a user turn starts in the renderer. Dropping the started
      // event alone would leave main waiting for its three-minute timeout, so the interjection that
      // will not be played is returned right away.
      interjectPlayback.rejectStarted(event.turnId)
      return
    }
    // Idle in main means TTS synthesis finished, which is earlier than the end of playback in the
    // renderer, so a system report is queued behind the current speech and the rest of the queue.
    interjectPlayback.track(event.turnId)
    activateTurn(event.turnId, null, true)
    return
  }

  // Every event, panel and done included, is accepted only for the turnId that is active now.
  if (event.turnId !== turn.activeTurnId) return

  switch (event.type) {
    case 'delta': {
      // In live mode the feed shows the transcript of what was actually spoken, because the live
      // voice rephrases the brain's sentences.
      if (liveMode()) break
      if (aiLineId === null) {
        aiLineId = feed.append({ role: 'ai', text: '', turnId: event.turnId, streaming: true })
      }
      feed.appendToText(aiLineId, event.text)
      break
    }
    case 'segment': {
      if (aiLineId === null && event.segment.text) {
        aiLineId = feed.append({
          role: 'ai',
          text: event.segment.text,
          turnId: event.turnId,
          streaming: true
        })
      }
      interjectPlayback.markSegmentQueued(event.segment)
      speechPlayer.enqueue(event.segment)
      break
    }
    case 'segmentAudio':
      speechPlayer.pushSegmentAudio(event.turnId, event.index, event.samples, event.last)
      break
    case 'tool': {
      turn.setRouterNote(
        translate('hud.router.tool', {
          tool: toolLabel(event.name, event.detail),
          status: translate(`hud.toolStatus.${event.status}`)
        })
      )
      break
    }
    case 'panel': {
      usePanelStore.getState().apply(event.event, { ownerTurnId: event.turnId })
      break
    }
    case 'app': {
      if (event.open) useViewStore.getState().openApp(event.open)
      else useViewStore.getState().closeApp()
      break
    }
    case 'metrics': {
      // Metrics of an interjection must not mix into the HUD values or the statistics of the user
      // turn before it.
      if (turnMetrics.update(event.turnId, event.timings)) turn.mergeTimings(event.timings)
      break
    }
    case 'done': {
      interjectPlayback.finishTurn(event.turnId)
      usePanelStore.getState().dismissLoadingOwnedBy(event.turnId)
      if (aiLineId !== null) feed.update(aiLineId, { streaming: false })
      if (!speechPlayer.isPlaying && !speechPlayer.isStreaming) turn.setPhase(liveVoice.current === 'on' ? 'listen' : 'idle')
      turnMetrics.finish(event.turnId)
      turn.setActiveTurn(-1)
      activeRequestId = null
      aiLineId = null
      break
    }
    case 'error': {
      interjectPlayback.finishTurn(event.turnId)
      useToastStore.getState().push({ kind: 'error', title: translate('conversation.replyFailed'), body: event.message })
      feed.append({ role: 'sys', text: '', message: { key: 'conversation.error', values: { message: event.message.slice(0, 120) } } })
      break
    }
  }
}

/** Toggles the microphone from the UI, switching the cascade capture or the live capture according to the configured voice engine. */
export async function toggleMic(): Promise<void> {
  if (liveMode()) {
    if (liveVoice.current === 'off') await liveVoice.enable()
    else liveVoice.disable()
    return
  }
  if (voiceController.current === 'off') await voiceController.enable()
  else voiceController.disable()
}
