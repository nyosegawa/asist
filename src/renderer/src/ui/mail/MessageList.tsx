import { Paperclip, Star } from 'lucide-react'
import { displayName, type MailMessage } from '@shared/mail'
import { dayGroup, listTime } from './format'
import { useT } from '@/i18n'

/**
 * One message per row, with a separator between days, unread rows in bold and the selected row
 * brighter. The star is toggled on the row itself, and pressing the row opens the message in the
 * reader on the right. When several accounts are shown together, the account name stands in small
 * type beside the time rather than being signalled by a color or a border.
 */
export function MessageList({
  messages,
  total,
  loaded,
  error,
  query,
  selectedId,
  accountLabels,
  showAccount,
  now,
  onSelect,
  onStar,
  onLoadMore,
  onRetry
}: {
  messages: MailMessage[]
  total: number
  loaded: boolean
  error: string
  query: string
  selectedId: string | null
  accountLabels: Map<string, string>
  /** True only while all accounts are being viewed together. */
  showAccount: boolean
  now: number
  onSelect: (message: MailMessage) => void
  onStar: (message: MailMessage) => void
  onLoadMore: () => void
  onRetry: () => void
}): React.JSX.Element {
  const t = useT()
  if (error) {
    return (
      <div className="ml-notice" role="alert">
        <p>{error}</p>
        <button type="button" className="cal-btn" onClick={onRetry}>
          {t('common.retry')}
        </button>
      </div>
    )
  }
  if (!loaded) return <div className="ml-notice">{t('common.loading')}</div>
  if (messages.length === 0) {
    return (
      <div className="ml-notice">
        <p>{query ? t('mail.list.noMatches', { query }) : t('mail.list.empty')}</p>
        <small>{query ? t('mail.list.searchScope') : t('mail.list.arrivesHere')}</small>
      </div>
    )
  }
  const rows: React.ReactNode[] = []
  let lastGroup = ''
  for (const message of messages) {
    const group = dayGroup(message.date, now)
    if (group !== lastGroup) {
      lastGroup = group
      rows.push(
        <li key={`group-${group}`} className="ml-group" aria-hidden>
          {group}
        </li>
      )
    }
    rows.push(
      <li
        key={message.id}
        className="ml-row"
        data-unread={message.unread || undefined}
        data-selected={message.id === selectedId || undefined}
      >
        <button
          type="button"
          className="ml-star"
          aria-label={message.starred ? t('mail.star.remove') : t('mail.star.add')}
          aria-pressed={message.starred}
          onClick={() => onStar(message)}
        >
          <Star size={14} />
        </button>
        <button type="button" className="ml-row-main" onClick={() => onSelect(message)} aria-label={t('mail.openMessage', { subject: message.subject || t('mail.noSubject') })}>
          <span className="ml-row-from">{message.folder === 'sent' ? `To: ${message.to.map(displayName).join(', ') || t('mail.noRecipient')}` : displayName(message.from)}</span>
          <span className="ml-row-text">
            <span className="ml-row-subject">{message.subject || t('mail.noSubject')}</span>
            {message.snippet && <span className="ml-row-snippet"> — {message.snippet}</span>}
          </span>
          <span className="ml-row-aside">
            {message.attachments.length > 0 && <Paperclip size={12} aria-label={t('mail.hasAttachment')} />}
            {showAccount && <span className="ml-row-account">{accountLabels.get(message.accountId) ?? message.accountId}</span>}
            <time>{listTime(message.date, now)}</time>
          </span>
        </button>
      </li>
    )
  }
  return (
    <div className="ml-list">
      <ul className="ml-rows">{rows}</ul>
      {messages.length < total && (
        <button type="button" className="ml-more" onClick={onLoadMore}>
          {t('mail.list.loadMore', { count: total - messages.length })}
        </button>
      )}
    </div>
  )
}
