import { formatMessage } from '@shared/i18n'
import { readErrorText } from '@shared/i18n/error-text'
import { uiLocale } from '@/i18n'

/**
 * The text of an error as the user sees it, in a toast, a card or a screen. Every place that shows an error goes
 * through here, so the wording for the user is decided in one place.
 *
 * An error written for the user carries the key of its message (shared/i18n/error-text.ts) and is shown in the
 * language of the interface. Any other error, such as one from a library, is shown as it is.
 *
 * An error thrown in the main process reaches the renderer wrapped by Electron as
 * "Error invoking remote method '<channel>': Error: <message>". The wrapper names an IPC channel, which means
 * nothing to the user, so only the message is kept.
 */
const IPC_WRAPPER = /^Error invoking remote method '[^']+': (?:\w*Error: )?/

export function displayError(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).replace(IPC_WRAPPER, '')
  const known = readErrorText(text)
  return known ? formatMessage(known.message, uiLocale(), known.values) : text
}
