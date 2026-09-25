import { createTranslator, formatMessage, type Translate, type UiLocale } from '@shared/i18n'
import { readErrorText } from '@shared/i18n/error-text'
import { getSettings } from './settings'

/**
 * The interface language for the text the main process writes itself: menus, notifications, confirmation
 * windows, and the progress and results of preparations. Errors are not written here; they carry a key
 * (shared/i18n/error-text.ts) and the renderer writes them.
 */

const translators = new Map<UiLocale, Translate>()

/** Reads the language on every call, so a change of the setting shows in the next text. */
export const t: Translate = (key, ...values) => {
  const locale = getSettings().uiLocale
  let translator = translators.get(locale)
  if (!translator) {
    translator = createTranslator(locale)
    translators.set(locale, translator)
  }
  return translator(key, ...values)
}

/**
 * The same dictionary in the language of the conversation, for text that belongs to the conversation
 * rather than to the screen: a fixed line the assistant says aloud, and a word a tool result carries
 * to the model. Someone can read the screen in one language and talk in another, so these two
 * translators are never interchangeable.
 */
export const tConversation: Translate = (key, ...values) => {
  const locale = getSettings().conversationLocale
  let translator = translators.get(locale)
  if (!translator) {
    translator = createTranslator(locale)
    translators.set(locale, translator)
  }
  return translator(key, ...values)
}

/** An error as text in the given language. An error that was not written for the user is returned as it is. */
export function errorMessageIn(locale: UiLocale, error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const known = readErrorText(text)
  return known ? formatMessage(known.message, locale, known.values) : text
}

/**
 * An error as text in the interface language, for a result the screen shows as plain text instead of as an
 * error, such as `{ ok: false, message }`.
 */
export const errorMessage = (error: unknown): string => errorMessageIn(getSettings().uiLocale, error)
