/**
 * The local speech synthesis model. Measured on 2026-09-20 with mlx-audio 0.4.7, one Japanese
 * sentence at a time: on an M5 the first audio arrives 0.19 s after the request and one second of
 * speech takes 0.37 s to generate; on a 16 GB M2 it is 0.30 s and 0.58 s. The worker holds about
 * 2.1 GB, which is why the model is recommended only from 16 GB of memory.
 */
export const QWEN_TTS_MODEL = Object.freeze({
  id: 'mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit',
  revision: '049ef77fe8816b536193c0c25f9a214d17921282',
  label: 'Qwen3-TTS 0.6B 8-bit MLX',
  files: [
    '.gitattributes', 'README.md', 'config.json', 'generation_config.json', 'merges.txt', 'model.safetensors',
    'model.safetensors.index.json', 'preprocessor_config.json', 'speech_tokenizer/config.json',
    'speech_tokenizer/configuration.json', 'speech_tokenizer/model.safetensors',
    'speech_tokenizer/preprocessor_config.json', 'tokenizer_config.json', 'vocab.json'
  ],
  weightSizeGb: 1.9,
  residentMemoryGb: 2.1
})

export const QWEN_TTS_MIN_RECOMMENDED_MEMORY_GB = 16

/**
 * The preset voices of the pinned model. Every voice can speak every language the model supports;
 * `native` is the language the voice was recorded in, where it sounds most natural.
 */
export const QWEN_TTS_VOICES = [
  { id: 'ono_anna', name: 'Ono Anna', gender: 'female', native: 'japanese' },
  { id: 'ryan', name: 'Ryan', gender: 'male', native: 'english' },
  { id: 'aiden', name: 'Aiden', gender: 'male', native: 'english' },
  { id: 'sohee', name: 'Sohee', gender: 'female', native: 'korean' },
  { id: 'vivian', name: 'Vivian', gender: 'female', native: 'chinese' },
  { id: 'serena', name: 'Serena', gender: 'female', native: 'chinese' },
  { id: 'uncle_fu', name: 'Uncle Fu', gender: 'male', native: 'chinese' },
  { id: 'dylan', name: 'Dylan', gender: 'male', native: 'chinese' },
  { id: 'eric', name: 'Eric', gender: 'male', native: 'chinese' }
] as const

export type QwenTtsVoice = (typeof QWEN_TTS_VOICES)[number]['id']

export const QWEN_TTS_VOICE_IDS = QWEN_TTS_VOICES.map((voice) => voice.id) as [QwenTtsVoice, ...QwenTtsVoice[]]

/** The language names the model takes, by the language subtag of a locale. Hindi and Indonesian are not among them. */
const QWEN_TTS_LANGUAGES: Record<string, string> = {
  ja: 'japanese',
  en: 'english',
  ko: 'korean',
  zh: 'chinese',
  fr: 'french',
  de: 'german',
  it: 'italian',
  pt: 'portuguese',
  es: 'spanish',
  ru: 'russian'
}

/** The model's name for the language of a locale such as `ja-JP`, or null when the model cannot speak it. */
export function qwenTtsLanguage(locale: string): string | null {
  return QWEN_TTS_LANGUAGES[locale.split('-')[0].toLowerCase()] ?? null
}

export function recommendQwenTts(totalMemoryBytes: number, platform: NodeJS.Platform, arch: string): boolean {
  return platform === 'darwin' && arch === 'arm64' && Math.round(totalMemoryBytes / 1024 ** 3) >= QWEN_TTS_MIN_RECOMMENDED_MEMORY_GB
}
