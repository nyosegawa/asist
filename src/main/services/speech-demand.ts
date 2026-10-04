import type { AppSettings } from '@shared/ipc'
import { isLocalTtsEngine } from '@shared/tts-models'
import * as aizuchiClassifier from './aizuchi-classifier'
import * as localTts from './local-tts'

/**
 * What needs the local speech models loaded now. Speech recognition, MaAI and the aizuchi classifier serve the
 * microphone of the voice engine alone, and are wanted while it is on. Speech synthesis also reads typed
 * replies, job reports, timers and previews with the microphone off, so a local engine stays wanted until
 * TTS_IDLE_MS have passed both since the microphone turned off and since it last loaded or read something.
 *
 * Loading a model again is short: from spawn to ready with the files in the OS cache, Qwen3-ASR 1.7B took
 * 0.8 to 0.9 s and Qwen3-TTS 0.6B 2.2 to 2.5 s on an Apple M5, and Qwen3-ASR 0.6B 1.7 s and Qwen3-TTS 0.6B
 * 2.1 s on an RTX 2080; read from disk, up to 5.3 s on the RTX 2080 (2026-10-05).
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

export function ttsWanted(settings: AppSettings): boolean {
  if (!isLocalTtsEngine(settings.ttsEngine) || microphone) return true
  const idleSince = localTts.idleSince()
  return idleSince === null || Date.now() - Math.max(idleSince, microphoneOffAt) < TTS_IDLE_MS
}

export const classifierWanted = (settings: AppSettings): boolean => microphone && aizuchiClassifier.wanted(settings)
