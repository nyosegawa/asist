import { formatLocaleOf } from '@shared/conversation-locale'
import { createTranslator, type Translate, type UiLocale } from '@shared/i18n'
import { useSettingsStore } from '@/state/stores'

/** Before the settings have loaded, which is the boot screen, the interface is in the source language. */
const INITIAL_LOCALE: UiLocale = 'ja-JP'

const translators = new Map<UiLocale, Translate>()

function translatorFor(locale: UiLocale): Translate {
  let translator = translators.get(locale)
  if (!translator) {
    translator = createTranslator(locale)
    translators.set(locale, translator)
  }
  return translator
}

/** The translator of the chosen interface language. A component that calls it renders again when the language changes. */
export function useT(): Translate {
  return translatorFor(useSettingsStore((state) => state.settings?.uiLocale ?? INITIAL_LOCALE))
}

/** For code outside React, such as the conversation feed and the stores. */
export const translate: Translate = (key, ...values) =>
  translatorFor(useSettingsStore.getState().settings?.uiLocale ?? INITIAL_LOCALE)(key, ...values)

/**
 * The same dictionary in the language of the conversation, for text the assistant reads or receives
 * rather than text the screen shows: the utterance a card's button sends in the user's name. Someone
 * can read the screen in one language and talk in another.
 */
export const tConversation: Translate = (key, ...values) =>
  translatorFor(useSettingsStore.getState().settings?.conversationLocale ?? INITIAL_LOCALE)(key, ...values)

/** The language of the interface in a component, for text. Dates and numbers take `useFormatLocale`. */
export function useUiLocale(): UiLocale {
  return useSettingsStore((state) => state.settings?.uiLocale ?? INITIAL_LOCALE)
}

/** The same, for code outside React. */
export const uiLocale = (): UiLocale => useSettingsStore.getState().settings?.uiLocale ?? INITIAL_LOCALE

/** Before the settings have loaded, the formats are those of the initial interface language. */
const INITIAL_REGION = 'JP'

/** The locale for `Intl` formatting of dates and numbers in a component: the interface language with the region's conventions. */
export function useFormatLocale(): string {
  return useSettingsStore((state) => formatLocaleOf(state.settings?.uiLocale ?? INITIAL_LOCALE, state.settings?.region ?? INITIAL_REGION))
}

/** The same, for code outside React. */
export const formatLocale = (): string => {
  const settings = useSettingsStore.getState().settings
  return formatLocaleOf(settings?.uiLocale ?? INITIAL_LOCALE, settings?.region ?? INITIAL_REGION)
}
