import type { PromptLanguage } from '@shared/conversation-locale'
import { ToolError, resolvePromptTexts } from '@shared/tool-registry'
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
 * Any other message can carry text from outside, so it is never read as a packed pair.
 */
export const detail = (err: unknown, language: PromptLanguage): string =>
  err instanceof ToolError ? resolvePromptTexts(err.message, language) : errMessage(err)

/** The reasons a schema rejected the input, as one sentence the model reads. */
export const issueText = (issues: readonly { message: string }[], language: PromptLanguage): string =>
  issues.map((issue) => resolvePromptTexts(errMessage(issue.message), language)).join(language === 'ja' ? '、' : ', ')

/**
 * The error a card shows, which is the error's own message with its key still in it: the screen words
 * it in the language of the interface, which need not be the language the model is told the failure in.
 */
export const cardError = (err: unknown): string => (err instanceof Error ? err.message : String(err))
