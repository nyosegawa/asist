import { Archive, Inbox, PenLine, Send, Star, FileText } from 'lucide-react'
import { type MailAccount, type MailAccountStatus } from '@shared/mail'
import type { MailBox } from '@shared/mini-apps'
import type { MessageKey, Translate } from '@shared/i18n'
import { useT } from '@/i18n'

/** The compose button, the boxes for inbox, starred, sent, archive and drafts, and the account filter. */

export type { MailBox }

const ICONS = { inbox: Inbox, starred: Star, sent: Send, archive: Archive, drafts: FileText } as const
const BOX_KEY = {
  inbox: 'mail.boxes.inbox',
  starred: 'mail.boxes.starred',
  sent: 'mail.boxes.sent',
  archive: 'mail.boxes.archive',
  drafts: 'mail.boxes.drafts'
} as const satisfies Record<MailBox, MessageKey>
// A connected account needs no word beside its name, so that only the states worth acting on stand out.
const STATE_KEY = {
  off: 'common.off',
  connecting: 'mail.accountState.connecting',
  syncing: 'mail.accountState.syncing',
  connected: null,
  error: 'mail.accountState.error'
} as const satisfies Record<MailAccountStatus['state'], MessageKey | null>

export const mailBoxLabel = (t: Translate, box: MailBox): string => t(BOX_KEY[box])

export function Sidebar({
  view,
  unread,
  drafts,
  accounts,
  statuses,
  accountId,
  onView,
  onAccount,
  onCompose
}: {
  view: MailBox
  unread: number
  /** How many drafts there are. */
  drafts: number
  accounts: MailAccount[]
  statuses: Map<string, MailAccountStatus>
  /** The account the list is filtered to, or null for all of them. */
  accountId: string | null
  onView: (view: MailBox) => void
  onAccount: (accountId: string | null) => void
  onCompose: () => void
}): React.JSX.Element {
  const t = useT()
  return (
    <aside className="ml-side">
      <button type="button" className="cal-create ml-compose" onClick={onCompose} disabled={accounts.length === 0}>
        <PenLine size={18} />
        {t('mail.compose')}
      </button>
      <nav className="ml-views" aria-label={t('mail.mailboxes')}>
        {(Object.keys(ICONS) as MailBox[]).map((key) => {
          const Icon = ICONS[key]
          const count = key === 'inbox' ? unread : key === 'drafts' ? drafts : 0
          return (
            <button key={key} type="button" className="ml-view" aria-pressed={view === key} onClick={() => onView(key)}>
              <Icon size={15} />
              <span>{t(BOX_KEY[key])}</span>
              {count > 0 && <b>{count}</b>}
            </button>
          )
        })}
      </nav>
      {accounts.length > 0 && (
        <div className="cal-side-group ml-accounts">
          <div className="cal-side-title">{t('mail.accounts')}</div>
          {accounts.map((account) => {
            const status = statuses.get(account.id)
            const stateKey = status ? STATE_KEY[status.state] : null
            const note = stateKey ? t(stateKey) : ''
            return (
              <button
                key={account.id}
                type="button"
                className="ml-account"
                aria-pressed={accountId === account.id}
                data-state={status?.state}
                title={status?.error || account.email}
                onClick={() => onAccount(accountId === account.id ? null : account.id)}
              >
                <span className="ml-account-label">{account.label}</span>
                {status && status.unread > 0 && <b>{status.unread}</b>}
                {note && <small>{note}</small>}
              </button>
            )
          })}
          {accountId && (
            <button type="button" className="ml-account is-all" onClick={() => onAccount(null)}>
              <span className="ml-account-label">{t('mail.allAccounts')}</span>
            </button>
          )}
        </div>
      )}
    </aside>
  )
}
