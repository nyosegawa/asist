import { Paperclip, Reply, Star } from 'lucide-react'
import type { PanelSpec } from '@shared/ipc'
import { displayName, formatAddress, type MailMessage } from '@shared/mail'
import { useMailStore, usePanelStore, useToastStore } from '@/state/stores'
import { useViewStore } from '@/state/view'
import { fullTime, sizeLabel } from '@/ui/mail/format'
import type { CardContext, CardDefinition } from '../shell/card'
import { Action, Actions, Box, Facts, More } from '../primitives/Card'
import './mail-message.css'
import { displayError } from '@/display-error'
import { useT } from '@/i18n'

/**
 * A card for one mail message. main fetches the body through the same path as read_mail, which does not mark
 * the message as read. Only a message in the inbox can be archived, and archiving asks for no confirmation,
 * just as on the mail screen. A reply is written on the mail screen.
 */

const LINES: Record<CardContext['size'], number> = { l: 18, m: 12, s: 6, focus: 0 }
interface MailMessageProps {
  id: string
  message?: MailMessage
  accountLabel?: string
  text?: string
}
const propsOf = (spec: PanelSpec): MailMessageProps => spec.props as unknown as MailMessageProps

function MailMessageBody({ spec, size }: CardContext): React.JSX.Element {
  const { message, accountLabel, text } = propsOf(spec)
  const setFocused = usePanelStore((s) => s.setFocused)
  const openApp = useViewStore((s) => s.openApp)
  const toast = useToastStore((s) => s.push)
  const bump = useMailStore((s) => s.bump)
  const t = useT()
  if (!message) {
    return (
      <div className="card mm" data-size={size}>
        <p className="card-missing">{t('mailCards.message.missing')}</p>
      </div>
    )
  }
  const archive = async (): Promise<void> => {
    try {
      const result = await window.api.mailChange({ operation: 'archive', id: message.id })
      if (result.saved) {
        toast({ kind: 'ok', title: t('mail.done.archive'), body: result.summary })
        bump()
        usePanelStore.getState().apply({ op: 'dismiss', key: spec.key })
      }
    } catch (err) {
      toast({ kind: 'error', title: t('mail.changeFailed.archive'), body: displayError(err) })
    }
  }
  const lines = LINES[size]
  const body = text?.trim() ? text : t('mail.noBody')
  const clipped = lines > 0 && body.split('\n').length > lines
  return (
    <div className="card mm" data-size={size}>
      <div className="card-hero">
        <h3>
          {message.starred && <Star size={14} className="mm-star" aria-label={t('mail.starred')} />}
          {message.subject || t('mail.noSubject')}
        </h3>
        <p>
          <b>{displayName(message.from)}</b>
          {message.from.name && ` <${message.from.address}>`} · {fullTime(message.date)}
          {accountLabel && ` · ${accountLabel}`}
        </p>
      </div>
      {size !== 's' && (
        <Facts
          columns={1}
          items={[
            [t('mail.fields.to'), message.to.map(formatAddress).join(', ') || t('mail.none')],
            ...(message.cc.length ? [['Cc', message.cc.map(formatAddress).join(', ')] as [string, string]] : []),
            ...(message.attachments.length
              ? [
                  [
                    t('mail.fields.attachments'),
                    <span key="attachments" className="mm-attachments">
                      {message.attachments.map((item, index) => (
                        <span key={`${item.filename}-${index}`}>
                          <Paperclip size={11} /> {item.filename || item.contentType} <small>{sizeLabel(item.size)}</small>
                        </span>
                      ))}
                    </span>
                  ] as [string, React.ReactNode]
                ]
              : [])
          ]}
        />
      )}
      <Box title={t('mail.fields.body')} note={message.unread ? t('mailCards.message.stillUnread') : undefined}>
        <div className="mm-body">
          <pre className="mm-text" style={lines ? ({ WebkitLineClamp: lines } as React.CSSProperties) : undefined}>
            {body}
          </pre>
        </div>
        {clipped && (
          <More onClick={() => setFocused(spec.key)} label={t('mailCards.message.moreLabel')}>
            {t('mailCards.message.more')}
          </More>
        )}
      </Box>
      <Actions>
        <Action tone="primary" onClick={() => openApp({ app: 'mail', messageId: message.id })} label={t('mailCards.message.replyLabel')}>
          <Reply size={13} /> {t('mail.reply')}
        </Action>
        {message.folder === 'inbox' && <Action onClick={() => void archive()}>{t('mail.archive')}</Action>}
        <Action onClick={() => openApp({ app: 'mail', messageId: message.id })} label={t('mailCards.openInMail')}>
          {t('mailCards.open')}
        </Action>
      </Actions>
    </div>
  )
}

export const mailMessageCard: CardDefinition = {
  Body: MailMessageBody,
  kicker: 'MAIL',
  className: 'mc-card mm-card'
}
