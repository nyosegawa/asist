import type { ConversationLocale } from './conversation-locale'
import type { PinnedFile } from './pinned-file'
import type { SpeechBackend } from './platform'

/**
 * The speech recognition models the setting can name. Both run in speech.cpp's worker from the same GGUF file on
 * every machine, so a setting written on one machine means the same model on another.
 */
export const ASR_MODELS = ['auto', 'qwen3-asr-1.7b', 'qwen3-asr-0.6b'] as const

export type AsrModel = (typeof ASR_MODELS)[number]
export type ResolvedAsrModel = Exclude<AsrModel, 'auto'>

/** A Qwen3-ASR model for speech.cpp: its one model file, which holds the audio encoder and the decoder. */
export interface AsrModelSpec {
  label: string
  model: PinnedFile
}

/**
 * The models in the order the screens list them, in Q8_0. On an Apple M5 with Metal and speech.cpp 0.7.1, through
 * ASIST's worker client with the language forced (2026-10-07), 1.7B took 0.62 to 0.74 s for a FLEURS utterance of
 * 10.5 s and 2.1 to 2.6 s for one of 25.5 s, in 2.5 GB; 0.6B took 0.27 to 0.31 s and 0.87 to 1.01 s, in 1.1 GB. On
 * the 4,483 clips of Common Voice 8.0 Japanese, 1.7B got 4.5% of the characters wrong and 0.6B 6.9%, accepted
 * spellings allowed (speech.cpp 0.7.0, RTX 2080, 2026-10-07).
 */
export const ASR_MODEL_SPECS: Readonly<Record<ResolvedAsrModel, AsrModelSpec>> = {
  'qwen3-asr-1.7b': {
    label: 'Qwen3-ASR 1.7B',
    model: {
      repo: 'sakasegawa/Qwen3-ASR-1.7B-GGUF',
      revision: '75edaf1dd34c60409d3190dbcb36dbec70cad5ea',
      file: 'Qwen3-ASR-1.7B-Q8_0.gguf',
      bytes: 2_176_109_216,
      sha256: '5f219b78a1d9c3b9e97da27708b36f8a0bc1bfc1650b541c0a6dbaf87c9a62d0'
    }
  },
  'qwen3-asr-0.6b': {
    label: 'Qwen3-ASR 0.6B',
    model: {
      repo: 'sakasegawa/Qwen3-ASR-0.6B-GGUF',
      revision: 'f397b129caf08f201f79e67bbfafd1c6b59aeb05',
      file: 'Qwen3-ASR-0.6B-Q8_0.gguf',
      bytes: 841_502_336,
      sha256: '416e10c15b4a3d9002bd337d18fc450233fdf68502b6e10d1379d2789838afd0'
    }
  }
}

/** The files a model needs. */
export const asrModelFiles = (spec: AsrModelSpec): PinnedFile[] => [spec.model]

/** Which of the two models is recommended, the larger one or the one that fits less memory. */
export type AsrRecommendationSize = 'larger' | 'smaller'

/**
 * The memory from which 1.7B is recommended, in GB as the capabilities give it. On a Mac the models share
 * the memory with every other app, so 1.7B waits for 16 GB; on Windows it is the GPU's own, which 1.7B
 * fits from 6 GB beside the desktop.
 */
const LARGER_FROM_GB: Readonly<Record<SpeechBackend, number>> = { metal: 16, vulkan: 6 }

/** What preparing a model downloads, in GB of 10^9 bytes: nothing once it is installed. */
export function asrDownloadGb(spec: AsrModelSpec, modelInstalled: boolean): number {
  if (modelInstalled) return 0
  return Math.round(asrModelFiles(spec).reduce((sum, file) => sum + file.bytes, 0) / 1e7) / 100
}

export interface AsrHardwareRecommendation {
  totalMemoryGb: number
  recommendedModel: ResolvedAsrModel
}

export function isAsrModel(value: unknown): value is AsrModel {
  return typeof value === 'string' && (ASR_MODELS as readonly string[]).includes(value)
}

export const offeredAsrModels = (): ResolvedAsrModel[] => Object.keys(ASR_MODEL_SPECS) as ResolvedAsrModel[]

export const asrModelSpec = (model: ResolvedAsrModel): AsrModelSpec => ASR_MODEL_SPECS[model]

/** Which model a backend recommends for this much memory: the Mac's for metal, the GPU's for vulkan. */
export const asrRecommendationSize = (backend: SpeechBackend, totalMemoryGb: number): AsrRecommendationSize =>
  totalMemoryGb >= LARGER_FROM_GB[backend] ? 'larger' : 'smaller'

/** The model for a machine whose local speech has this much memory. */
export function recommendAsrModel(backend: SpeechBackend, totalMemoryGb: number): AsrHardwareRecommendation {
  const size = asrRecommendationSize(backend, totalMemoryGb)
  return { totalMemoryGb, recommendedModel: size === 'larger' ? 'qwen3-asr-1.7b' : 'qwen3-asr-0.6b' }
}

/** The model a setting stands for: `auto` is the recommendation, any other value that model. */
export function resolveAsrModel(selected: AsrModel, recommendation: AsrHardwareRecommendation): ResolvedAsrModel {
  return selected === 'auto' ? recommendation.recommendedModel : selected
}

/** A model the screens let the user choose. */
export interface AsrModelChoice {
  id: ResolvedAsrModel
  label: string
}

export function asrModelChoices(): AsrModelChoice[] {
  return offeredAsrModels().map((id) => ({ id, label: ASR_MODEL_SPECS[id].label }))
}

/** The English name of the conversation language, which Whisper in the browser takes in lower case. */
const WHISPER_LANGUAGE_NAMES: Record<ConversationLocale, string> = {
  'ja-JP': 'Japanese',
  'en-US': 'English',
  'fr-FR': 'French',
  'de-DE': 'German',
  'hi-IN': 'Hindi',
  'id-ID': 'Indonesian',
  'it-IT': 'Italian',
  'ko-KR': 'Korean',
  'pt-BR': 'Portuguese',
  'es-419': 'Spanish',
  'es-ES': 'Spanish'
}

/** Transformers.js takes the language of a Whisper transcription as the English name in lower case. */
export const whisperLanguageName = (locale: ConversationLocale): string => WHISPER_LANGUAGE_NAMES[locale].toLowerCase()

/**
 * The language Qwen3-ASR is told to transcribe in, as the BCP 47 tag of speech.cpp's `language` option: the
 * language of the locale without its region, as the model's languages list it. speech.cpp turns it into the start
 * of the model's answer, as the official implementation does, which steers the model toward that language.
 */
export const asrLanguage = (locale: ConversationLocale): string => new Intl.Locale(locale).language
