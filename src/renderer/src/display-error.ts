import { readErrorText } from '@shared/i18n/error-text'
import { uiLocale } from '@/i18n'

/**
 * An error thrown in the main process reaches the renderer wrapped by Electron as
 * "Error invoking remote method '<channel>': Error: <message>". The wrapper names an IPC channel, which means
 * nothing to the user, so only the message is kept.
 */
const IPC_WRAPPER = /^Error invoking remote method '[^']+': (?:\w*Error: )?/

/**
 * The message of an error as it was thrown, key and all, for an error that wraps it: `errorText` keeps a
 * wrapped message whole, so the screen words both levels in the language it shows at the time.
 */
export function errorMessageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(IPC_WRAPPER, '')
}

/**
 * The text of an error as the user sees it, in a toast, a card or a screen. Every place that shows an error goes
 * through here, so the wording for the user is decided in one place.
 *
 * An error written for the user carries the key of its message (shared/i18n/error-text.ts) and is shown in the
 * language of the interface. Any other error, such as one from a library, is shown as it is.
 */
export function displayError(error: unknown): string {
  const text = errorMessageOf(error)
  return readErrorText(text, uiLocale()) ?? text
}
