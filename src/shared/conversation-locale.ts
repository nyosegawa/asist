import { UI_LOCALES, type UiLocale } from './i18n/message'
import type { TtsEngine } from './ipc'
import { qwenTtsLanguage } from './tts-models'

/**
 * The language the user and the assistant speak, and the region whose weather, news and formats apply.
 * Both are settings of their own beside the language of the interface: someone living in Japan may read
 * the screen in English, talk in English and still want the weather of Japan.
 *
 * Japanese is the language the conversation was built and tuned in: its prompts, backchannels,
 * turn-taking model and two of its speech engines exist for Japanese only. Every other language runs on
 * one common path with none of those, because a backchannel rhythm or a turn-taking model moved over
 * from Japanese sounds wrong in a language it was not measured in.
 */

/** The conversation can be held in the languages the interface is written in. */
export const CONVERSATION_LOCALES = UI_LOCALES
export type ConversationLocale = UiLocale

/** The English name of each language, for a prompt that tells the model which language to speak. */
export const CONVERSATION_LANGUAGE_NAMES: Record<ConversationLocale, string> = {
  'ja-JP': 'Japanese',
  'en-US': 'English',
  'fr-FR': 'French',
  'de-DE': 'German',
  'hi-IN': 'Hindi',
  'id-ID': 'Indonesian',
  'it-IT': 'Italian',
  'ko-KR': 'Korean',
  'pt-BR': 'Brazilian Portuguese',
  'es-419': 'Latin American Spanish',
  'es-ES': 'European Spanish'
}

/**
 * The region a locale stands for, as an ISO 3166-1 alpha-2 code. `es-419` names Latin America as a whole,
 * which no weather or news source takes, so it starts from Mexico, its most populous country.
 */
const DEFAULT_REGIONS: Record<ConversationLocale, string> = {
  'ja-JP': 'JP',
  'en-US': 'US',
  'fr-FR': 'FR',
  'de-DE': 'DE',
  'hi-IN': 'IN',
  'id-ID': 'ID',
  'it-IT': 'IT',
  'ko-KR': 'KR',
  'pt-BR': 'BR',
  'es-419': 'MX',
  'es-ES': 'ES'
}

export const defaultRegion = (locale: ConversationLocale): string => DEFAULT_REGIONS[locale]

/**
 * The countries the region can be set to, as ISO 3166-1 alpha-2 codes. The list is fixed so that every
 * entry can be checked, and it holds the default region of each language. The names are not written
 * here: a picker reads them from `Intl.DisplayNames` in the language of the interface.
 */
export const REGIONS: readonly string[] = [
  'AR', 'AT', 'AU', 'BE', 'BR', 'CA', 'CH', 'CL', 'CN', 'CO', 'CZ', 'DE', 'DK', 'EG', 'ES', 'FI', 'FR',
  'GB', 'GR', 'HK', 'ID', 'IE', 'IL', 'IN', 'IT', 'JP', 'KR', 'MX', 'MY', 'NG', 'NL', 'NO', 'NZ', 'PE',
  'PH', 'PL', 'PT', 'RO', 'SA', 'SE', 'SG', 'TH', 'TR', 'TW', 'UA', 'US', 'VN', 'ZA'
]

/** The ISO 639-1 language of a locale, which is what speech recognition and most web APIs take. */
export const languageOf = (locale: ConversationLocale): string => locale.split('-')[0]

/**
 * A BCP 47 tag that `Intl` and the speech APIs of the system accept for the conversation. `es-419` is
 * valid for `Intl`, but macOS has no voice under it, so speech uses the tag of the default region.
 */
export const speechTag = (locale: ConversationLocale): string => `${languageOf(locale)}-${DEFAULT_REGIONS[locale]}`

/** The prompts exist in Japanese, tuned by hand, and in English, which carries every other language. */
export type PromptLanguage = 'ja' | 'en'
export const promptLanguage = (locale: ConversationLocale): PromptLanguage => (locale === 'ja-JP' ? 'ja' : 'en')

/** One text for the model in both prompt languages, kept side by side like a message of the interface. */
export type PromptText = Readonly<Record<PromptLanguage, string>>
export const promptText = (locale: ConversationLocale, text: PromptText): string => text[promptLanguage(locale)]

/**
 * The weekday names a date written for the model carries, spelled out here rather than read from
 * `Intl`, so that the same day always reads the same whatever data the machine happens to hold.
 */
const WEEKDAY_NAMES: Readonly<Record<PromptLanguage, readonly string[]>> = {
  ja: ['日', '月', '火', '水', '木', '金', '土'],
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
}

export const weekdayName = (locale: ConversationLocale, date: Date): string =>
  WEEKDAY_NAMES[promptLanguage(locale)][date.getDay()]

/**
 * Fills the `{name}` placeholders of a prompt text. A name with no value throws instead of reaching the
 * model as braces: what they stand for is the name of the language or a marker the model has to
 * recognize, and a prompt that explains a marker it never shows is worse than no prompt at all.
 */
export function fillPrompt(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = values[name]
    if (value === undefined) throw new Error(`prompt placeholder {${name}} has no value`)
    return value
  })
}

export interface ConversationFeatures {
  /** Backchannels of the assistant: the classifier, the clips, and the ones said while the user speaks. */
  aizuchi: boolean
  /** MaAI turn-taking, whose four models are trained on Japanese conversation. */
  maai: boolean
  /** VOICEVOX and AivisSpeech, which speak Japanese only. */
  japaneseTts: boolean
  /** Qwen3-TTS, which does not speak Hindi or Indonesian. */
  qwenTts: boolean
  /** The list of phrases Whisper hallucinates from silence, which was collected in Japanese. */
  hallucinationList: boolean
}

/** What the conversation can use in a language. A setting that is on stays on but has no effect where this is false. */
export function conversationFeatures(locale: ConversationLocale): ConversationFeatures {
  const japanese = locale === 'ja-JP'
  return {
    aizuchi: japanese,
    maai: japanese,
    japaneseTts: japanese,
    qwenTts: qwenTtsLanguage(locale) !== null,
    hallucinationList: japanese
  }
}

/**
 * Whether a speech engine can read a language aloud. VOICEVOX and AivisSpeech speak Japanese only, and
 * Qwen3-TTS has no Hindi or Indonesian. The macOS voice and the engine that reads nothing fit every
 * language, so a conversation whose engine cannot speak it moves to `system`.
 */
export function ttsEngineSpeaks(locale: ConversationLocale, engine: TtsEngine): boolean {
  const features = conversationFeatures(locale)
  if (engine === 'voicevox' || engine === 'aivisspeech') return features.japaneseTts
  if (engine === 'qwen3tts') return features.qwenTts
  return true
}

/** The weather of Japan comes from the Japan Meteorological Agency; everywhere else from a worldwide source. */
export const usesJmaWeather = (region: string): boolean => region === 'JP'

/**
 * The locale to start from, out of the languages the system prefers, most preferred first. A language
 * matches whatever its region, except that Spanish and Portuguese keep the variant the region points at.
 * English is the start when nothing matches, as the language most people can read.
 */
export function pickInitialLocale(systemLocales: readonly string[]): ConversationLocale {
  for (const tag of systemLocales) {
    const [language, ...rest] = tag.split(/[-_]/)
    const region = rest.find((part) => /^([A-Z]{2}|\d{3})$/.test(part))
    const exact = CONVERSATION_LOCALES.find((locale) => locale === `${language}-${region}`)
    if (exact) return exact
    if (language === 'es') return region === 'ES' ? 'es-ES' : 'es-419'
    const sameLanguage = CONVERSATION_LOCALES.find((locale) => languageOf(locale) === language)
    if (sameLanguage) return sameLanguage
  }
  return 'en-US'
}

/**
 * The locale dates, times and numbers are written in: the language of the interface with the conventions of
 * the region, so that English in Germany writes 18:05 and 22/09/2026 where English in the United States
 * writes 6:05 PM and 9/22/26. `Intl` accepts any pairing; a pairing CLDR has no data for, such as English
 * in Japan, is written as the language alone would be.
 */
export const formatLocaleOf = (uiLocale: ConversationLocale, region: string): string =>
  new Intl.Locale(uiLocale, { region }).toString()
