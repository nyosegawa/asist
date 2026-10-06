import type { ConversationLocale } from './conversation-locale'
import type { PinnedFile } from './pinned-file'
import type { SpeechBackend } from './platform'

/**
 * The speech recognition models the setting can name. Each runs in speech.cpp's worker from the same GGUF file on
 * every machine, so a setting written on one machine means the same model on another.
 */
export const ASR_MODELS = ['auto', 'qwen3-asr-1.7b', 'qwen3-asr-0.6b', 'parakeet-tdt_ctc-0.6b-ja', 'reazonspeech-nemo-v2', 'parakeet-tdt-0.6b-v3'] as const

export type AsrModel = (typeof ASR_MODELS)[number]
export type ResolvedAsrModel = Exclude<AsrModel, 'auto'>

/** A speech recognition model for speech.cpp: its one model file, which holds the whole model. */
export interface AsrModelSpec {
  label: string
  /** The family of speech.cpp that runs the file, the `architecture` of its model information, under which its worker logs. */
  family: 'qwen3-asr' | 'fastconformer'
  model: PinnedFile
  /**
   * The languages the model recognizes, as the BCP 47 tags of the `languages` of the file's model information. The
   * worker refuses a request in any other language.
   */
  languages: readonly string[]
}

/** The languages of both sizes of Qwen3-ASR, which a forced language steers the model toward. */
const QWEN3_ASR_LANGUAGES = ['ar', 'cs', 'da', 'de', 'el', 'en', 'es', 'fa', 'fi', 'fil', 'fr', 'hi', 'hu', 'id', 'it', 'ja', 'ko', 'mk', 'ms', 'nl', 'pl', 'pt', 'ro', 'ru', 'sv', 'th', 'tr', 'vi', 'yue', 'zh']

/**
 * The models in the order the screens list them: Qwen3-ASR in Q8_0, and the FastConformer models in F16, which take
 * a language only to check it. On an Apple M5 with Metal and speech.cpp 0.7.1, through ASIST's worker client with
 * the language forced (2026-10-07), Qwen3-ASR 1.7B took 0.62 to 0.74 s for a FLEURS utterance of 10.5 s and 2.1 to
 * 2.6 s for one of 25.5 s, in 2.5 GB; 0.6B took 0.27 to 0.31 s and 0.87 to 1.01 s, in 1.1 GB. For the first 20 s of
 * the 25.5 s one, the longest utterance ASIST sends, parakeet-tdt_ctc-0.6b-ja took 0.24 s and ReazonSpeech 0.36 to
 * 0.46 s, and parakeet-tdt-0.6b-v3 0.25 s for 20 s of English, each in 1.3 GB after it. On the 4,483 clips of Common
 * Voice 8.0 Japanese, read sentences, the characters each model got wrong, accepted spellings allowed, were 4.5% for
 * Qwen3-ASR 1.7B, 6.9% for 0.6B, 2.8% for parakeet-tdt_ctc-0.6b-ja and 4.3% for ReazonSpeech (speech.cpp 0.7.0, RTX
 * 2080, 2026-10-07).
 */
export const ASR_MODEL_SPECS: Readonly<Record<ResolvedAsrModel, AsrModelSpec>> = {
  'qwen3-asr-1.7b': {
    label: 'Qwen3-ASR 1.7B',
    family: 'qwen3-asr',
    model: {
      repo: 'sakasegawa/Qwen3-ASR-1.7B-GGUF',
      revision: '75edaf1dd34c60409d3190dbcb36dbec70cad5ea',
      file: 'Qwen3-ASR-1.7B-Q8_0.gguf',
      bytes: 2_176_109_216,
      sha256: '5f219b78a1d9c3b9e97da27708b36f8a0bc1bfc1650b541c0a6dbaf87c9a62d0'
    },
    languages: QWEN3_ASR_LANGUAGES
  },
  'qwen3-asr-0.6b': {
    label: 'Qwen3-ASR 0.6B',
    family: 'qwen3-asr',
    model: {
      repo: 'sakasegawa/Qwen3-ASR-0.6B-GGUF',
      revision: 'f397b129caf08f201f79e67bbfafd1c6b59aeb05',
      file: 'Qwen3-ASR-0.6B-Q8_0.gguf',
      bytes: 841_502_336,
      sha256: '416e10c15b4a3d9002bd337d18fc450233fdf68502b6e10d1379d2789838afd0'
    },
    languages: QWEN3_ASR_LANGUAGES
  },
  'parakeet-tdt_ctc-0.6b-ja': {
    label: 'parakeet-tdt_ctc-0.6b-ja',
    family: 'fastconformer',
    model: {
      repo: 'sakasegawa/parakeet-tdt_ctc-0.6b-ja-GGUF',
      revision: '48060c6e292b01c84edac8988db0163fd41d3fe2',
      file: 'parakeet-tdt_ctc-0.6B-ja-F16.gguf',
      bytes: 1_240_656_832,
      sha256: '71ddc10381a9d3b59e18fbc51422059293f1268676b1ca62adb45b791df05497'
    },
    languages: ['ja']
  },
  'reazonspeech-nemo-v2': {
    label: 'ReazonSpeech NeMo v2',
    family: 'fastconformer',
    model: {
      repo: 'sakasegawa/reazonspeech-nemo-v2-GGUF',
      revision: 'cb9e436cf3f9d9563c610cb5318adcfc5c0fe098',
      file: 'reazonspeech-nemo-619M-v2-F16.gguf',
      bytes: 1_240_465_696,
      sha256: '1492147d7d18fbb0503db2cbbb05df4932cb3451e391524c6a2411632e4823bf'
    },
    languages: ['ja']
  },
  'parakeet-tdt-0.6b-v3': {
    label: 'parakeet-tdt-0.6b-v3',
    family: 'fastconformer',
    model: {
      repo: 'sakasegawa/parakeet-tdt-0.6b-v3-GGUF',
      revision: '304eaf83fc16e3087425b61b6652c4eafe003dc4',
      file: 'parakeet-tdt-0.6B-v3-F16.gguf',
      bytes: 1_255_370_688,
      sha256: '7b74de31ac48427934104f0d074613f8d759d7d108777c114476346789d94426'
    },
    languages: ['bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fi', 'fr', 'hr', 'hu', 'it', 'lt', 'lv', 'mt', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'uk']
  }
}

/** The files a model needs. */
export const asrModelFiles = (spec: AsrModelSpec): PinnedFile[] => [spec.model]

/** Which of the two models is recommended, the larger one or the one that fits less memory. */
export type AsrRecommendationSize = 'larger' | 'smaller'

/** The model `auto` stands for at each size of the recommendation. */
const AUTOMATIC_MODELS: Readonly<Record<AsrRecommendationSize, ResolvedAsrModel>> = { larger: 'qwen3-asr-1.7b', smaller: 'qwen3-asr-0.6b' }

/**
 * The memory from which 1.7B is recommended, in GB as the capabilities give it. On a Mac the models share
 * the memory with every other app, so 1.7B waits for 16 GB; on Windows it is the GPU's own, which 1.7B
 * fits from 6 GB beside the desktop.
 */
const LARGER_FROM_GB: Readonly<Record<SpeechBackend, number>> = { metal: 16, vulkan: 6 }

/** The model's files together, in GB of 10^9 bytes. */
export const asrModelSizeGb = (spec: AsrModelSpec): number =>
  Math.round(asrModelFiles(spec).reduce((sum, file) => sum + file.bytes, 0) / 1e7) / 100

/** What preparing a model downloads, in GB of 10^9 bytes: nothing once it is installed. */
export function asrDownloadGb(spec: AsrModelSpec, modelInstalled: boolean): number {
  return modelInstalled ? 0 : asrModelSizeGb(spec)
}

export interface AsrHardwareRecommendation {
  totalMemoryGb: number
  recommendedModel: ResolvedAsrModel
}

export function isAsrModel(value: unknown): value is AsrModel {
  return typeof value === 'string' && (ASR_MODELS as readonly string[]).includes(value)
}

/** Every model the setting can name, whatever the conversation language, in the order the screens list them. */
export const offeredAsrModels = (): ResolvedAsrModel[] => Object.keys(ASR_MODEL_SPECS) as ResolvedAsrModel[]

export const asrModelSpec = (model: ResolvedAsrModel): AsrModelSpec => ASR_MODEL_SPECS[model]

/**
 * Whether the model a setting names recognizes the conversation language, as its `languages` list it. `auto`
 * recognizes a language when every model it can stand for does.
 */
export function asrModelRecognizes(locale: ConversationLocale, model: AsrModel): boolean {
  const models = model === 'auto' ? Object.values(AUTOMATIC_MODELS) : [model]
  return models.every((one) => ASR_MODEL_SPECS[one].languages.includes(asrLanguage(locale)))
}

/** Which model a backend recommends for this much memory: the Mac's for metal, the GPU's for vulkan. */
export const asrRecommendationSize = (backend: SpeechBackend, totalMemoryGb: number): AsrRecommendationSize =>
  totalMemoryGb >= LARGER_FROM_GB[backend] ? 'larger' : 'smaller'

/** The model for a machine whose local speech has this much memory. */
export function recommendAsrModel(backend: SpeechBackend, totalMemoryGb: number): AsrHardwareRecommendation {
  return { totalMemoryGb, recommendedModel: AUTOMATIC_MODELS[asrRecommendationSize(backend, totalMemoryGb)] }
}

/** The model a setting stands for: `auto` is the recommendation, any other value that model. */
export function resolveAsrModel(selected: AsrModel, recommendation: AsrHardwareRecommendation): ResolvedAsrModel {
  return selected === 'auto' ? recommendation.recommendedModel : selected
}

/** A model the screens let the user choose, with what preparing it downloads. */
export interface AsrModelChoice {
  id: ResolvedAsrModel
  label: string
  sizeGb: number
}

/** The models to choose from for a conversation language: those that recognize it. */
export function asrModelChoices(locale: ConversationLocale): AsrModelChoice[] {
  return offeredAsrModels()
    .filter((id) => asrModelRecognizes(locale, id))
    .map((id) => ({ id, label: ASR_MODEL_SPECS[id].label, sizeGb: asrModelSizeGb(ASR_MODEL_SPECS[id]) }))
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
 * The language a model is told to transcribe in, as the BCP 47 tag of speech.cpp's `language` option: the language
 * of the locale without its region, as the models' languages list it. speech.cpp turns it into the start of Qwen3-ASR's
 * answer, as the official implementation does, which steers the model toward that language. The FastConformer
 * models have no input for a language, and the worker only checks it against theirs.
 */
export const asrLanguage = (locale: ConversationLocale): string => new Intl.Locale(locale).language
