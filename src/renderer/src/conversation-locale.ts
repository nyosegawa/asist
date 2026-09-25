import type { ConversationLocale } from '@shared/conversation-locale'
import { useSettingsStore } from '@/state/stores'

/**
 * The language the user and the assistant speak, for the parts of the conversation the renderer owns:
 * the in-browser speech recognition and the system voice. It is read at each use, so a change of the
 * setting applies to the next utterance.
 *
 * Nothing is heard or spoken before the settings have loaded, so the value below is what the browser
 * demo, which has no main process, renders with.
 */
const INITIAL_LOCALE: ConversationLocale = 'ja-JP'

export const conversationLocale = (): ConversationLocale =>
  useSettingsStore.getState().settings?.conversationLocale ?? INITIAL_LOCALE
