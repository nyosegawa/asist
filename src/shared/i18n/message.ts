/**
 * The languages the interface is written in. Each tag also names the locale whose plural rules the
 * language follows. Japanese comes first because it is the source the other languages are written from.
 */
export const UI_LOCALES = ['ja-JP', 'en-US', 'fr-FR', 'de-DE', 'hi-IN', 'id-ID', 'it-IT', 'ko-KR', 'pt-BR', 'es-419', 'es-ES'] as const

export type UiLocale = (typeof UI_LOCALES)[number]

/** The name of each language in that language, which is how a language picker lists them. */
export const UI_LOCALE_NAMES: Record<UiLocale, string> = {
  'ja-JP': '日本語',
  'en-US': 'English',
  'fr-FR': 'Français',
  'de-DE': 'Deutsch',
  'hi-IN': 'हिन्दी',
  'id-ID': 'Bahasa Indonesia',
  'it-IT': 'Italiano',
  'ko-KR': '한국어',
  'pt-BR': 'Português (Brasil)',
  'es-419': 'Español (Latinoamérica)',
  'es-ES': 'Español (España)'
}

/** The plural categories of `Intl.PluralRules`. Japanese needs `other` alone. */
export type PluralForms = { readonly other: string } & Partial<Readonly<Record<'zero' | 'one' | 'two' | 'few' | 'many', string>>>

/**
 * One string of the interface in every language. The languages sit side by side so that a change to
 * one of them shows, in the same diff, which of the others it left behind.
 */
export type Message = Readonly<Record<UiLocale, string | PluralForms>>

/** The messages of one screen, grouped as deep as the screen needs. */
export interface Messages {
  readonly [key: string]: Message | Messages
}

/** A message whose Japanese text is known exactly. A named type keeps each message short where the compiler writes the dictionary's type out. */
export type SourceMessage<Japanese extends string | PluralForms> = Message & { readonly 'ja-JP': Japanese }

/** The messages of one file as the rest of the code sees them: the Japanese keeps its exact text, from which the keys' values are typed, and every other language is just a string. */
export type SourceOf<T> = { readonly [K in keyof T]: T[K] extends Message ? SourceMessage<T[K]['ja-JP']> : SourceOf<T[K]> }

/**
 * Declares the messages of one file. Keeping the exact text of all eleven languages in the type made the type
 * of the whole dictionary too large for the compiler to write out, and only the Japanese text is ever read
 * from the type.
 */
export const defineMessages = <const T extends Messages>(messages: T): SourceOf<T> => messages as SourceOf<T>
