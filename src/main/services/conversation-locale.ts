import { conversationFeatures, type ConversationFeatures, type ConversationLocale } from '@shared/conversation-locale'
import { getSettings } from './settings'

/** The conversation language and the region of the saved settings, read on every call so that a change applies to the next turn. */
export const conversationLocale = (): ConversationLocale => getSettings().conversationLocale
export const region = (): string => getSettings().region
export const features = (): ConversationFeatures => conversationFeatures(conversationLocale())
