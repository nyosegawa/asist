import type { MessageKey } from '@shared/i18n'
import { isDefaultPersona } from '@shared/persona'

/** How the persona reads on the conversation page and on the persona page, which say the same thing. */
export function personaStateKey(persona: string): Extract<MessageKey, `settingsPersona.state.${string}`> {
  if (isDefaultPersona(persona)) return 'settingsPersona.state.default'
  return persona.trim() ? 'settingsPersona.state.edited' : 'settingsPersona.state.empty'
}
