import { CornerUpLeft, PenLine } from 'lucide-react'
import { displayName, parseAddress, type MailDraft } from '@shared/mail'
import { listTime } from './format'
import { useT } from '@/i18n'

/** Keeps only the name of an address written as "名前 <addr>", and leaves a half-typed address that cannot be parsed as it is. */
const shortName = (recipient: string): string => {
  try {
    return displayName(parseAddress(recipient))
  } catch {
    return recipient
  }
}

/**
 * The list of drafts, each showing the recipient, or the original sender for a reply, the subject,
 * the beginning of the body and the time of the last edit. Pressing one continues it in the
 * composer.
 */
export function DraftList({ drafts, query, selectedId, now, onSelect }: { drafts: MailDraft[]; query: string; selectedId: string | null; now: number; onSelect: (draft: MailDraft) => void }): React.JSX.Element {
  const t = useT()
  const needle = query.toLowerCase()
  const shown = drafts.filter((draft) => !needle || [draft.subject, draft.body, draft.to.join(' '), draft.reply?.subject ?? '', draft.reply ? displayName(draft.reply.from) : ''].some((text) => text.toLowerCase().includes(needle)))
  if (shown.length === 0) {
    return (
      <div className="ml-notice">
        <p>{query ? t('mail.drafts.noMatches', { query }) : t('mail.drafts.empty')}</p>
        <small>{query ? t('mail.drafts.searchScope') : t('mail.drafts.savedHere')}</small>
      </div>
    )
  }
  return (
    <div className="ml-list">
      <ul className="ml-rows" aria-label={t('mail.boxes.drafts')}>
        {shown.map((draft) => (
          <li key={draft.id} className="ml-row" data-selected={draft.id === selectedId || undefined}>
            <span className="ml-star ml-draft-mark" aria-hidden>
              {draft.reply ? <CornerUpLeft size={14} /> : <PenLine size={14} />}
            </span>
            <button
              type="button"
              className="ml-row-main"
              onClick={() => onSelect(draft)}
              aria-label={
                draft.reply
                  ? t('mail.drafts.openReply', { subject: draft.reply.subject || t('mail.noSubject') })
                  : t('mail.drafts.open', { subject: draft.subject || t('mail.noSubject') })
              }
            >
              <span className="ml-row-from">{draft.reply ? `Re: ${displayName(draft.reply.from)}` : `To: ${draft.to.map(shortName).join(', ') || t('mail.noRecipient')}`}</span>
              <span className="ml-row-text">
                <span className="ml-row-subject">{draft.reply ? `Re: ${draft.reply.subject || t('mail.noSubject')}` : draft.subject || t('mail.noSubject')}</span>
                {draft.body.trim() && <span className="ml-row-snippet"> — {draft.body.replace(/\s+/g, ' ').trim().slice(0, 120)}</span>}
              </span>
              <span className="ml-row-aside">
                {draft.origin === 'agent' && <span className="ml-row-account">{t('mail.drafts.fromVoice')}</span>}
                <time>{listTime(draft.updatedAt, now)}</time>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
