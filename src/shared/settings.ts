import { z } from 'zod'
import { calendarSettingsSchema } from './calendar'
import { mailSettingsSchema } from './mail'
import { ASR_MODELS } from './asr-models'
import { dockOrderSchema } from './dock'
import { conversationModelSchema } from './llm-catalog'
import { QWEN_TTS_VOICE_IDS } from './tts-models'
import { CONVERSATION_LOCALES } from './conversation-locale'
import { UI_LOCALES } from './i18n'
import { THEMES } from './themes'
import { errorText } from './i18n/error-text'
import type { StoredFormat } from './stored-format'
import { VOICE_ENGINES, liveModelSettingSchema } from './voice-engine'

/** Every setting, without a default: a patch that names one field must leave the others as they are. */
const fields = {
  onboardingVersion: z.union([z.literal(0), z.literal(1)]),
  conversationModel: conversationModelSchema,
  /**
   * The provider and model for the aizuchi lookahead, which picks the kind of aizuchi and prepares a
   * short bridging phrase while the user is still speaking.
   */
  bridgeModel: conversationModelSchema,
  voiceEngine: z.enum(VOICE_ENGINES),
  gptLive: liveModelSettingSchema,
  geminiLive: liveModelSettingSchema,
  /**
   * How many seconds a live session stays open after the conversation stops. An open session is
   * billed.
   */
  liveIdleSeconds: z.number().int().min(10).max(900),
  /** The language of the interface. The language of the conversation is a separate matter. */
  uiLocale: z.enum(UI_LOCALES),
  /** The look of the whole interface: its colours, surfaces, background picture and the type of card headings. */
  theme: z.enum(THEMES),
  /** The language the user and the assistant speak: prompts, speech recognition and speech follow it. */
  conversationLocale: z.enum(CONVERSATION_LOCALES),
  /** The ISO 3166-1 alpha-2 country whose weather, news, currency and formats apply. */
  region: z.string().regex(/^[A-Z]{2}$/),
  persona: z.string(),
  conversationLogRetentionDays: z.number().int().positive(),
  ttsEngine: z.enum(['voicevox', 'aivisspeech', 'qwen3tts', 'system', 'none']),
  voicevoxSpeaker: z.number().int().nonnegative(),
  aivisSpeaker: z.number().int().nonnegative().nullable(),
  qwenTtsVoice: z.enum(QWEN_TTS_VOICE_IDS),
  bargeIn: z.boolean(),
  aizuchi: z.boolean(),
  aizuchiRate: z.number().min(0).max(1),
  listeningAizuchi: z.boolean(),
  /** The VAD's silence duration, chosen in the settings screen. */
  hangoverMs: z.number().int().min(200).max(900),
  /** How often partial recognition runs. Zero disables it. */
  partialIntervalMs: z.number().int().min(0).max(1500),
  calendar: calendarSettingsSchema,
  mail: mailSettingsSchema,
  agentCwd: z.string(),
  agentEngine: z.enum(['codex', 'claude']),
  agentMode: z.enum(['readonly', 'auto']),
  /**
   * The folders the files card, show_files, may display. A job's working directory and the memory
   * directory can always be shown as well.
   */
  fileRoots: z.array(z.string()),
  micAutoStart: z.boolean(),
  localAsrEnabled: z.boolean(),
  nativeMic: z.boolean(),
  noiseSuppression: z.boolean(),
  vapEnabled: z.boolean(),
  memoryEmbeddingEnabled: z.boolean(),
  asrModel: z.enum(ASR_MODELS),
  globalHotkey: z.boolean(),
  /** The order of the bottom navigation, excluding ASIST itself. Dragging an icon changes it. */
  dockOrder: dockOrderSchema
}

/**
 * The settings contract, shared by the saved file and IPC. The defaults are what a settings file written
 * before the field existed is read with. They belong to the file alone: on the patch schema zod would fill
 * them into every save, and saving any one setting put the interface back into Japanese and emptied the
 * folders of the file viewer.
 */
export const appSettingsSchema = z.strictObject({
  ...fields,
  uiLocale: fields.uiLocale.default('ja-JP'),
  conversationLocale: fields.conversationLocale.default('ja-JP'),
  region: fields.region.default('JP'),
  qwenTtsVoice: fields.qwenTtsVoice.default('ono_anna'),
  fileRoots: fields.fileRoots.default([])
})

export type AppSettings = z.infer<typeof appSettingsSchema>
const patchSchema = z.strictObject(fields).partial()

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    const details = result.error.issues.map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    throw new Error(errorText('settings.errors.invalid', { details: details.join(' / ') }))
  }
  return result.data
}

export const parseAppSettings = (value: unknown): AppSettings => parse(appSettingsSchema, value)
export const parseSettingsPatch = (value: unknown): Partial<AppSettings> => parse(patchSchema, value)

export const SETTINGS_FORMAT: StoredFormat<AppSettings> = {
  name: 'settings.json',
  version: 2,
  upgrades: {
    // Version 2 adds the theme. Everything written before it was drawn in future.
    1: (content) => ({ ...(content as Record<string, unknown>), theme: 'future' })
  },
  parse: parseAppSettings,
  serialize: (settings) => ({ ...settings })
}
