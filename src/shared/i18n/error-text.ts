import { MESSAGES, formatMessage, type MessageKey, type MessageValues } from '.'
import type { Message } from './message'

/**
 * The text of an error that is meant for the user. Electron carries only an error's message from the
 * main process to the renderer, so the message has to hold everything: the English sentence, which
 * is what the log keeps, followed by the key of the message and its values, from which the renderer
 * writes the sentence again in the language of the interface.
 */

const MARKER = /\s\[asist:([\w.]+)(?: (\{.*\}))?\]/

type Arguments<Key extends MessageKey> = keyof MessageValues<Key> extends never ? [] : [values: MessageValues<Key>]

function find(key: string): Message | undefined {
  let node: unknown = MESSAGES
  for (const part of key.split('.')) node = (node as Record<string, unknown> | undefined)?.[part]
  return node && typeof node === 'object' && 'en-US' in node ? (node as Message) : undefined
}

/** The message of an `Error` or of a zod issue: `throw new Error(errorText('errorsMail.notConnected', { account }))`. */
export function errorText<Key extends MessageKey>(key: Key, ...values: Arguments<Key>): string {
  const given = values[0] as Record<string, string | number> | undefined
  return `${formatMessage(find(key)!, 'en-US', given)} [asist:${key}${given ? ` ${JSON.stringify(given)}` : ''}]`
}

/**
 * The key and values inside an error's message, or null for an error that was not written for the user,
 * such as one from a library. The marker can sit anywhere, because other code wraps messages.
 */
export function readErrorText(message: string): { message: Message; values?: Record<string, string | number> } | null {
  const match = MARKER.exec(message)
  const found = match && find(match[1])
  if (!match || !found) return null
  return { message: found, values: match[2] ? (JSON.parse(match[2]) as Record<string, string | number>) : undefined }
}
