import { ExternalLink } from 'lucide-react'
import type { ChatGptStatus } from '@shared/chatgpt'
import { useT } from '@/i18n'
import { Btn, Chip } from '../settings/primitives'

/**
 * What the model step shows in place of the key field when ChatGPT is chosen: the sign-in through the
 * browser, the account it signs in to or returns to, and the way to the page on how the plan is used.
 */
export function ChatGptField({
  status,
  signingIn,
  busy,
  onSignIn
}: {
  /** Null until main has answered. */
  status: ChatGptStatus | null
  /** The browser is open; pressing again starts the sign-in over, since that tab may have been closed. */
  signingIn: boolean
  /** The models are being saved after the sign-in. */
  busy: boolean
  onSignIn: (otherAccount: boolean) => void
}): React.JSX.Element {
  const t = useT()
  const account = status?.account ?? null
  const signedIn = status?.signIn === 'signedIn'
  return (
    <div className="su-field" data-provider-field="chatgpt">
      <span className="su-field-label">{t('chatgpt.signIn.account')}</span>
      {status?.signIn === 'unreadable' && <p className="su-warn">{t('chatgpt.errors.tokenUnreadable')}</p>}
      <div className="su-inline">
        <Btn tone="primary" disabled={busy} onClick={() => onSignIn(false)}>
          {t('chatgpt.signIn.continue')}
        </Btn>
        {signedIn && <Chip tone="ok">{t('chatgpt.signIn.signedIn')}</Chip>}
        {account && (
          <button type="button" className="su-link" disabled={busy} onClick={() => onSignIn(true)}>
            {t('chatgpt.signIn.otherAccount')}
          </button>
        )}
      </div>
      <p className="su-hint">
        {signingIn
          ? t('chatgpt.signIn.waiting')
          : account
            ? t(signedIn ? 'chatgpt.signIn.usesAccount' : 'chatgpt.signIn.nextAccount', { account })
            : t('chatgpt.signIn.browserNote')}
        <span className="su-gap"> </span>
        <button type="button" className="su-link" onClick={() => void window.api.chatgptOpenGuide()}>
          {t('chatgpt.signIn.guide')}
          <ExternalLink size={12} aria-hidden />
        </button>
      </p>
    </div>
  )
}
