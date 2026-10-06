import type { AppSettings } from '@shared/ipc'
import { isLocalTtsEngine } from '@shared/tts-models'
import * as aizuchiClassifier from './aizuchi-classifier'
import { turnScheduler } from './brain/session'
import * as localTts from './local-tts'
import { windowAway } from './window-presence'

/**
 * What needs the local speech models loaded now. Speech recognition, MaAI and the aizuchi classifier serve the
 * microphone of the voice engine alone, and are wanted while it is on. Speech synthesis also reads typed
 * replies, job reports, timers and previews with the microphone off, which load a local engine when they
 * need it; a local engine is kept up only for the microphone, and one that is loaded is kept until
 * TTS_IDLE_MS have passed both since the microphone turned off and since it last loaded or read something.
 * With the window away there is nothing to type into and the job reports wait for it, so the engine is
 * kept only until the reply under way has ended.
 *
 * Loading a model again is short: from spawn to ready with the files in the OS cache, Qwen3-ASR 1.7B took
 * 0.56 to 0.67 s and 0.6B 0.37 to 0.42 s in speech.cpp 0.7.1 on an Apple M5 (2026-10-07), and Qwen3-TTS 0.6B
 * 2.2 to 2.5 s there and 2.1 s on an RTX 2080; read from disk, up to 5.3 s on the RTX 2080 (2026-10-05).
 */

/**
 * How long a local speech synthesis model stays loaded with the microphone off after it was last needed.
 * Unloading it after every reply would make each typed reply wait for it to load again.
 */
export const TTS_IDLE_MS = 5 * 60_000

let microphone = false
let microphoneOffAt = -Infinity

/** The renderer's microphone of the voice engine turned on or off. */
export function setMicrophone(on: boolean): void {
  if (microphone && !on) microphoneOffAt = Date.now()
  microphone = on
}

export const microphoneOn = (): boolean => microphone

export const asrWanted = (): boolean => microphone

/**
 * Whether the chosen engine is to be up, which the watchdog starts again when it is down: an engine of another
 * app or the speech of the OS always, a local engine while the microphone is on.
 */
export const ttsWanted = (settings: AppSettings): boolean => !isLocalTtsEngine(settings.ttsEngine) || microphone

/**
 * Whether a local engine that is loaded stays loaded. Keeping it is not wanting it: one let go is not loaded
 * again until something is to be read or the microphone turns on.
 */
export function ttsKept(settings: AppSettings): boolean {
  if (ttsWanted(settings)) return true
  const idleSince = localTts.idleSince()
  if (idleSince === null) return true
  if (windowAway()) return turnScheduler.activeTurnId !== null
  return Date.now() - Math.max(idleSince, microphoneOffAt) < TTS_IDLE_MS
}

export const classifierWanted = (settings: AppSettings): boolean => microphone && aizuchiClassifier.wanted(settings)
