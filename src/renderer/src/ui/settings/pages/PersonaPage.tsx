import { useState } from 'react'
import { defaultPersona } from '@shared/persona'
import { useViewStore } from '@/state/view'
import type { SettingsContext } from '../context'
import { Btn, Group, Link, Page, Row } from '../primitives'
import { useT } from '@/i18n'
import { personaStateKey } from '../persona-state'

/** The persona page, where the persona text is edited. It is saved when the field loses focus. */
export function PersonaPage({ ctx }: { ctx: SettingsContext }): React.JSX.Element {
  const { settings, set } = ctx
  const t = useT()
  const [draft, setDraft] = useState<string | null>(null)
  const value = draft ?? settings.persona
  // Resetting gives the persona of the language the conversation is held in now, not the one the app was installed in.
  const fresh = defaultPersona(settings.conversationLocale)

  return (
    <Page title={t('settingsPersona.title')} lead={t('settingsPersona.lead')}>
      <Group
        title={t('settingsPersona.text.title')}
        description={t('settingsPersona.text.description')}
        action={
          <Btn
            tone="quiet"
            disabled={settings.persona === fresh && draft === null}
            onClick={() => {
              setDraft(null)
              set({ persona: fresh })
            }}
          >
            {t('settingsPersona.text.reset')}
          </Btn>
        }
      >
        <Row label={t(personaStateKey(value))} hint={t('settingsPersona.text.hint')} wide>
          <textarea
            className="st-input"
            aria-label={t('settingsPersona.text.label')}
            value={value}
            placeholder={t('settingsPersona.text.placeholder')}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (draft !== null && draft !== settings.persona) set({ persona: draft })
              setDraft(null)
            }}
          />
        </Row>
      </Group>

      <Group title={t('settingsPersona.me.title')} description={t('settingsPersona.me.description')}>
        <Row label={t('settingsPersona.me.row')} hint={t('settingsPersona.me.hint')}>
          <Link onClick={() => useViewStore.getState().openApp({ app: 'memory' })}>{t('settingsPersona.me.open')}</Link>
        </Row>
      </Group>
    </Page>
  )
}
