import { useEffect, useState } from 'react'
import { Paperclip, Star } from 'lucide-react'
import type { PanelSpec } from '@shared/ipc'
import { displayName, type MailMessage, type MailView } from '@shared/mail'
import { useMailStore, usePanelStore } from '@/state/stores'
import { useViewStore } from '@/state/view'
import { mailBoxLabel } from '@/ui/mail/Sidebar'
import type { CardContext, CardDefinition } from '../shell/card'
import { Action, Actions, Box, Empty, More } from '../primitives/Card'
import { clockTime, shortDayLabel } from '../primitives/format'
import './mail.css'
import { displayError } from '@/display-error'
import { useT, useFormatLocale } from '@/i18n'

/**
 * Mail card. Unread messages of the inbox, or of the chosen mailbox or search, come first, newest first. The
 * listing is read again whenever a fetch or a change arrives, which useMailStore reports as a new revision.
 * A row with an excerpt is about 72px tall, so six rows fit l (720px) and four fit m (625px), measured in the
 * demo on 2026-09-16.
 */

interface CardAccount {
  id: string
  label: string
  unread: number
  state?: string
}
interface MailCardProps {
  unreadOnly?: boolean
  view?: MailView
  query?: string
  /** The number of messages matching the filter, which is not the number of rows the card shows. */
  total?: number
  unread?: number
  accounts?: CardAccount[]
  messages?: MailMessage[]
}

const LIMIT: Record<CardContext['size'], number> = { l: 6, m: 4, s: 4, focus: Infinity }
const propsOf = (spec: PanelSpec): MailCardProps => spec.props as unknown as MailCardProps

/** The time for a message from today, and the date for an older one. */
export function mailTime(date: number, now = Date.now()): string {
  return new Date(date).toDateString() === new Date(now).toDateString() ? clockTime(date) : shortDayLabel(date)
}

function MailBody({ spec, size }: CardContext): React.JSX.Element {
  const initial = propsOf(spec)
  const unreadOnly = initial.unreadOnly === true
  const view: MailView = initial.view ?? 'inbox'
  const query = initial.query ?? ''
  const searching = query !== '' || view !== 'inbox'
  const revision = useMailStore((s) => s.revision)
  const t = useT()
  const locale = useFormatLocale()
  const setFocused = usePanelStore((s) => s.setFocused)
  const openApp = useViewStore((s) => s.openApp)
  const [messages, setMessages] = useState<MailMessage[]>(initial.messages ?? [])
  const [unread, setUnread] = useState(initial.unread ?? 0)
  const [total, setTotal] = useState(initial.total ?? initial.messages?.length ?? 0)
  const [error, setError] = useState('')

  // Takes in the fetches and changes that arrive after the card is shown. The first listing is the one main
  // put into the props.
  useEffect(() => {
    setMessages(initial.messages ?? [])
    setUnread(initial.unread ?? 0)
    setTotal(initial.total ?? initial.messages?.length ?? 0)
  }, [spec.updatedAt]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (revision === 0) return
    let active = true
    Promise.all([window.api.mailList({ view, query, unreadOnly, limit: 200 }), window.api.mailStatus()])
      .then(([list, status]) => {
        if (!active) return
        setMessages([...list.messages].sort((a, b) => Number(b.unread) - Number(a.unread) || b.date - a.date).slice(0, 12))
        setTotal(list.total)
        setUnread(status.unread)
        setError('')
      })
      .catch((err: unknown) => active && setError(displayError(err)))
    return () => {
      active = false
    }
  }, [revision, unreadOnly, view, query])

  const accounts = initial.accounts ?? []
  const labels = new Map(accounts.map((account) => [account.id, account.label]))
  const shown = messages.slice(0, LIMIT[size])
  const rest = messages.length - shown.length
  const perAccount = accounts.filter((account) => account.unread > 0).map((account) => `${account.label} ${account.unread}`)
  const trouble = accounts.filter((account) => account.state === 'error')
  return (
    <div className="card mc" data-size={size}>
      <div className="card-hero">
        <h3>{query ? t('mailCards.list.searchTitle', { query }) : unreadOnly ? t('mailCards.list.unreadTitle') : mailBoxLabel(t, view)}</h3>
        <p>
          {searching
            ? unreadOnly
              ? t('mailCards.list.countUnreadOnly', { count: total })
              : t('mailCards.list.count', { count: total })
            : unread
              ? t('mailCards.list.unreadCount', { count: unread })
              : t('mailCards.list.noUnread')}
        </p>
        {(perAccount.length > 0 || trouble.length > 0) && (
          <p className="card-note">
            {perAccount.join(' · ')}
            {trouble.length > 0 &&
              `${perAccount.length ? ' · ' : ''}${t('mail.accountsDisconnected', { accounts: new Intl.ListFormat(locale).format(trouble.map((account) => account.label)) })}`}
          </p>
        )}
      </div>
      <Box
        title={unreadOnly ? t('mailCards.list.boxUnread') : searching ? t('mailCards.list.boxFrom', { box: mailBoxLabel(t, view) }) : t('mailCards.list.boxNewest')}
        note={messages.length ? t('mailCards.list.openHint') : undefined}
      >
        {shown.length === 0 ? (
          <Empty note={query ? t('mailCards.list.searchedScope') : t('mailCards.list.arrivesHere')}>
            {query ? t('mail.list.noMatches', { query }) : unreadOnly ? t('mailCards.list.noUnreadMail') : t('mail.list.empty')}
          </Empty>
        ) : (
          <ul className="card-rows">
            {shown.map((message) => (
              <li key={message.id} className="card-row mc-item" data-unread={message.unread || undefined}>
                <button
                  type="button"
                  className="mc-open"
                  onClick={() => openApp({ app: 'mail', messageId: message.id })}
                  aria-label={t('mail.openMessage', { subject: message.subject || t('mail.noSubject') })}
                >
                  <span className="mc-line">
                    <span className="mc-from">{displayName(message.from)}</span>
                    {accounts.length > 1 && <span className="mc-account">{labels.get(message.accountId)}</span>}
                    <time className="mc-time">{mailTime(message.date)}</time>
                  </span>
                  <span className="mc-subject">
                    {message.starred && <Star size={11} className="mc-star" aria-label={t('mail.starred')} />}
                    {message.attachments.length > 0 && <Paperclip size={11} className="mc-clip" aria-label={t('mail.hasAttachment')} />}
                    <span className="card-row-title">{message.subject || t('mail.noSubject')}</span>
                  </span>
                  {size !== 's' && message.snippet && <span className="mc-snippet">{message.snippet}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {rest > 0 && (
          <More onClick={() => setFocused(spec.key)} label={t('mailCards.list.moreLabel')}>
            {t('common.more', { count: rest })}
          </More>
        )}
      </Box>
      <Actions>
        <Action leadsTo="screen" onClick={() => openApp({ app: 'mail' })}>{t('mailCards.list.readInMail')}</Action>
      </Actions>
      {error && (
        <p className="card-missing" role="alert">
          {t('mailCards.list.reloadFailed', { reason: error })}
        </p>
      )}
    </div>
  )
}

export const mailCard: CardDefinition = {
  Body: MailBody,
  kicker: 'MAIL',
  className: 'mc-card'
}
