import { useState } from 'react'
import { ExternalLink, KeyRound, LogIn } from 'lucide-react'
import { API_KEY_INFO, LLM_PROVIDERS, LLM_PROVIDER_INFO, isApiKeyProvider, type ApiKeyProvider } from '@shared/llm-catalog'
import type { ChatGptStatus } from '@shared/chatgpt'
import { LIVE_ENGINE_INFO } from '@shared/voice-engine'
import type { MessageKey } from '@shared/i18n'
import { keyReadable, type ApiKeyState } from '@shared/ipc'
import { useStatusStore, useToastStore } from '@/state/stores'
import { openChatGptUsage, useChatGptSignIn } from '@/chatgpt'
import type { SettingsContext } from '../context'
import { keyProviders } from '../pending'
import { Btn, Chip, Group, Page, type ChipTone } from '../primitives'
import { ChatGptPlanNotice } from '../../ChatGptPlanNotice'
import { displayError } from '@/display-error'
import { useT } from '@/i18n'

/** The API key of each provider and the sign-in with ChatGPT, on a page of their own. */
export function ApiKeysPage({ ctx }: { ctx: SettingsContext }): React.JSX.Element {
  const t = useT()
  return (
    <Page title={t('settings.pages.apiKeys')} lead={t('settingsIntegrations.apiKeys.description')}>
      <ApiKeys ctx={ctx} />
    </Page>
  )
}

const KEY_STATE_CHIP = {
  verified: { tone: 'ok', label: 'settingsIntegrations.apiKeys.verified' },
  saved: { tone: 'cyan', label: 'settingsIntegrations.apiKeys.saved' },
  unreadable: { tone: 'warn', label: 'settingsIntegrations.apiKeys.unreadable' },
  missing: { tone: 'dim', label: 'settingsIntegrations.apiKeys.notSet' }
} as const satisfies Record<ApiKeyState, { tone: ChipTone; label: MessageKey }>

const SIGN_IN_CHIP = {
  signedIn: { tone: 'ok', label: 'chatgpt.signIn.signedIn' },
  unreadable: { tone: 'warn', label: 'settingsIntegrations.apiKeys.unreadable' },
  signedOut: { tone: 'dim', label: 'chatgpt.signIn.signedOut' }
} as const satisfies Record<ChatGptStatus['signIn'], { tone: ChipTone; label: MessageKey }>

/**
 * The API key of each provider, and the sign-in with ChatGPT in the place of its key. The list shows only the
 * state, and the input field opens just for registering a key. Before the key is saved it is checked against
 * that provider's API, querying the conversation model itself when it belongs to that provider.
 */
function ApiKeys({ ctx }: { ctx: SettingsContext }): React.JSX.Element {
  const { settings, status } = ctx
  const t = useT()
  const [opened, setOpened] = useState<ApiKeyProvider | null>(null)
  const inUse = keyProviders(settings)
  return (
    <Group>
      {LLM_PROVIDERS.map((provider) => {
        if (!isApiKeyProvider(provider)) return <ChatGptRow key={provider} inUse={inUse.includes(provider)} />
        const info = { ...LLM_PROVIDER_INFO[provider], ...API_KEY_INFO[provider] }
        const state = status?.llmKeys[provider] ?? 'missing'
        const saved = keyReadable(state)
        const engineOfProvider = Object.values(LIVE_ENGINE_INFO).find((engine) => engine.provider === provider)?.label ?? null
        return (
          <div key={provider} className="st-key" data-provider={provider}>
            <div className="st-key-name">
              <KeyRound size={14} className="st-key-icon" />
              {info.label}
              <code>{info.envKey}</code>
              <Chip tone={KEY_STATE_CHIP[state].tone}>{t(KEY_STATE_CHIP[state].label)}</Chip>
              {inUse.includes(provider) && <Chip tone="cyan">{t('settingsIntegrations.apiKeys.inUse')}</Chip>}
            </div>
            <Btn tone={saved ? 'quiet' : undefined} onClick={() => setOpened(opened === provider ? null : provider)}>
              {opened === provider
                ? t('common.close')
                : saved
                  ? t('settingsIntegrations.apiKeys.change')
                  : t('settingsIntegrations.apiKeys.register')}
            </Btn>
            <span className="st-key-hint">
              {engineOfProvider
                ? t('settingsIntegrations.apiKeys.hintWithLiveEngine', { engine: engineOfProvider })
                : t('settingsIntegrations.apiKeys.hint', { provider: info.label })}
            </span>
            {opened === provider && <KeyForm provider={provider} onDone={() => setOpened(null)} />}
          </div>
        )
      })}
    </Group>
  )
}

/**
 * The sign-in with ChatGPT. Signed out, it offers the sign-in, and another account once one is known; signed
 * in, the account, its usage and signing out; a sign-in this build cannot read, signing in again or out.
 */
function ChatGptRow({ inUse }: { inUse: boolean }): React.JSX.Element {
  const t = useT()
  const { status, signingIn, signingOut, error, noticeOpen, closeNotice, signIn, signOut } = useChatGptSignIn(true)
  const account = status?.account ?? null
  const signedIn = status?.signIn === 'signedIn'
  const chip = status ? SIGN_IN_CHIP[status.signIn] : { tone: 'dim' as const, label: 'settingsModels.checking' as const }
  const hint = signingIn
    ? t('chatgpt.signIn.waiting')
    : status?.signIn === 'unreadable'
      ? t('chatgpt.errors.tokenUnreadable')
      : account
        ? t(signedIn ? 'chatgpt.signIn.usesAccount' : 'chatgpt.signIn.nextAccount', { account })
        : t('chatgpt.signIn.hint')
  return (
    <div className="st-key" data-provider="chatgpt">
      <div className="st-key-name">
        <LogIn size={14} className="st-key-icon" />
        {LLM_PROVIDER_INFO.chatgpt.label}
        <Chip tone={chip.tone}>{t(chip.label)}</Chip>
        {inUse && <Chip tone="cyan">{t('settingsIntegrations.apiKeys.inUse')}</Chip>}
      </div>
      <div className="st-key-actions">
        {status && !signedIn && (
          <Btn tone="primary" disabled={signingOut} onClick={() => void signIn(false)}>
            {t('chatgpt.signIn.continue')}
          </Btn>
        )}
        {status?.signIn === 'signedOut' && account && (
          <Btn tone="quiet" disabled={signingOut} onClick={() => void signIn(true)}>
            {t('chatgpt.signIn.otherAccount')}
          </Btn>
        )}
        {signedIn && (
          <Btn tone="quiet" onClick={openChatGptUsage}>
            <ExternalLink size={12} aria-hidden />
            {t('chatgpt.plan.manageUsage')}
          </Btn>
        )}
        {status && status.signIn !== 'signedOut' && (
          <Btn tone="quiet" disabled={signingOut} onClick={signOut}>
            {t('chatgpt.signIn.signOut')}
          </Btn>
        )}
      </div>
      <span className="st-key-hint is-wide">
        {hint}
        <span className="su-gap"> </span>
        <button type="button" className="st-link" onClick={() => void window.api.chatgptOpenGuide()}>
          {t('chatgpt.signIn.guide')}
          <ExternalLink size={11} aria-hidden />
        </button>
      </span>
      {error && (
        <span className="st-key-error" role="alert">
          {error}
        </span>
      )}
      <ChatGptPlanNotice open={noticeOpen} onClose={closeNotice} />
    </div>
  )
}

function KeyForm({ provider, onDone }: { provider: ApiKeyProvider; onDone: () => void }): React.JSX.Element {
  const refreshStatus = useStatusStore((s) => s.refresh)
  const toast = useToastStore((s) => s.push)
  const t = useT()
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const info = { ...LLM_PROVIDER_INFO[provider], ...API_KEY_INFO[provider] }
  const submit = (): void => {
    setSaving(true)
    void window.api
      .saveApiKey(provider, key)
      .then(() => {
        toast({ kind: 'ok', title: t('settingsIntegrations.apiKeys.keySaved', { provider: info.label }) })
        onDone()
        return refreshStatus()
      })
      .catch((err: unknown) =>
        toast({ kind: 'error', title: t('settingsIntegrations.apiKeys.keySaveFailed', { provider: info.label }), body: displayError(err) })
      )
      .finally(() => setSaving(false))
  }
  return (
    <form
      className="st-key-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (key.trim() && !saving) submit()
      }}
    >
      <input
        type="password"
        autoComplete="off"
        autoFocus
        className="st-input is-mono"
        aria-label={info.envKey}
        placeholder={info.keyPlaceholder}
        value={key}
        onChange={(e) => setKey(e.target.value)}
      />
      <Btn tone="primary" type="submit" disabled={saving || !key.trim()}>
        {saving ? t('settingsIntegrations.apiKeys.keyChecking') : t('settingsIntegrations.apiKeys.keySave')}
      </Btn>
      <Btn tone="quiet" onClick={() => void window.api.openExternal(info.console)}>
        {t('settingsIntegrations.apiKeys.openConsole')}
      </Btn>
    </form>
  )
}
