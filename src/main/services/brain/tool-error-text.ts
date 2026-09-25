import type { PromptLanguage } from '@shared/conversation-locale'
import { resolvePromptTexts } from '@shared/tool-registry'
import { conversationLocale } from '../conversation-locale'
import { errorMessageIn } from '../i18n'

/**
 * The text of a caught error as the model reads it inside a tool result. The model converses in the
 * language of the conversation, whatever the language of the interface, so an error that carries a
 * message key is worded in that language and loses the key, which would mean nothing to the model.
 */
export const errMessage = (err: unknown): string => errorMessageIn(conversationLocale(), err)

/**
 * The same, for a tool that words the failure itself and needs the reason as one plain sentence: a
 * message that a ToolError packed into both prompt languages is unpacked into the one being written.
 */
export const detail = (err: unknown, language: PromptLanguage): string =>
  resolvePromptTexts(errMessage(err), language)
