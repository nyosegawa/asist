import { vi } from 'vitest'
import type { Message, Messages } from '../../src/shared/i18n/message'

/**
 * Every message reads as its locale and key, such as `‹ja-JP common.save›`, followed by its placeholders and
 * line breaks in their order. A test that writes the words of a message instead of reading it through
 * `createTranslator` then fails at once, in that test, while text that only happens to share a word with
 * a message, such as weather data or the heading of a memory file, is untouched. The mock is in a setup file
 * so that it holds again after `vi.resetModules()`, which many tests call before importing main's services.
 * The tests of the dictionary itself read the real one with `vi.unmock`.
 */
vi.mock('../../src/shared/i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/shared/i18n')>()
  const byKey = (locale: string, name: string, text: string): string =>
    `‹${locale} ${name}›${(text.match(/\{\w+\}|\n/g) ?? []).join('')}`
  const rewrite = (node: Messages, prefix: string): void => {
    for (const [key, value] of Object.entries(node)) {
      if (!('ja-JP' in value)) {
        rewrite(value as Messages, `${prefix}${key}.`)
        continue
      }
      const message = value as Record<string, Message[keyof Message]>
      for (const [locale, form] of Object.entries(message)) {
        message[locale] =
          typeof form === 'string'
            ? byKey(locale, `${prefix}${key}`, form)
            : Object.fromEntries(Object.entries(form).map(([category, text]) => [category, byKey(locale, `${prefix}${key}.${category}`, text as string)]))
      }
    }
  }
  rewrite(real.MESSAGES as unknown as Messages, '')
  return real
})
