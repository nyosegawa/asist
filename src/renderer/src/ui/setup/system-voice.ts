import { useEffect, useState } from 'react'
import { languageOf, type ConversationLocale } from '@shared/conversation-locale'

/**
 * Whether macOS has a voice for the conversation language. The voices are per language and several of
 * them have to be downloaded in System Settings, so a language the Mac has no voice for reads nothing
 * aloud even though the macOS speech synthesis itself works.
 */
export type SystemVoiceState = 'unknown' | 'available' | 'missing'

/**
 * A voice can read a language when its tag names that language; the country may differ, as the voice
 * of a Mexican Spanish speaker reads `es-419` and a Portuguese one reads `pt-BR`.
 */
export const hasVoiceFor = (tags: readonly string[], locale: ConversationLocale): boolean =>
  tags.some((tag) => tag.split(/[-_]/)[0].toLowerCase() === languageOf(locale))

/**
 * The state of the macOS voice for a language. `getVoices()` returns an empty list until the browser
 * has loaded the voices of the system and then fires `voiceschanged`, so an empty list is not an
 * answer and the state stays unknown until one arrives.
 */
export function useSystemVoice(locale: ConversationLocale): SystemVoiceState {
  const [state, setState] = useState<SystemVoiceState>('unknown')
  useEffect(() => {
    const synthesis = window.speechSynthesis
    if (!synthesis) return
    const read = (): void => {
      const tags = synthesis.getVoices().map((voice) => voice.lang)
      if (tags.length === 0) return
      setState(hasVoiceFor(tags, locale) ? 'available' : 'missing')
    }
    read()
    synthesis.addEventListener('voiceschanged', read)
    return () => synthesis.removeEventListener('voiceschanged', read)
  }, [locale])
  return state
}
