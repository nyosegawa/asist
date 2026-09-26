import { useEffect } from 'react'
import { CornerUpLeft, PenLine } from 'lucide-react'
import type { PanelSpec } from '@shared/ipc'
import { displayName, formatAddress } from '@shared/mail'
import { useMailStore, useSettingsStore, useToastStore } from '@/state/stores'
import { useViewStore } from '@/state/view'
import { useDraftEditor } from '@/ui/mail/draft-editor'
import type { CardContext, CardDefinition } from '../shell/card'
import { Action, Actions, Box, Empty } from '../primitives/Card'
import './mail-draft.css'
import { useT } from '@/i18n'

/**
 * Mail draft card. It carries the text an agent wrote through change_mail's send or reply, so that it can be
 * corrected before it goes out. Pressing "送信" is itself the approval, so no confirmation appears. Once the
 * draft has been sent or discarded, main's delivery drops it and the card closes with it. The content comes
 * from main's drafts (useMailStore.drafts) and the props carry only the draftId. A reply's recipients were
 * settled from the message it answers, Reply-To and a reply-all's Cc included, and are shown as the full
 * addresses it is sent to, since the sender's name alone would hide a Reply-To that points elsewhere.
 */

const ROWS: Record<CardContext['size'], number> = { l: 8, m: 6, s: 4, focus: 16 }
const propsOf = (spec: PanelSpec): { draftId: string } => ({ draftId: String(spec.props.draftId ?? '') })

function MailDraftBody({ spec, size }: CardContext): React.JSX.Element {
  const { draftId } = propsOf(spec)
  const draft = useMailStore((s) => s.drafts.find((item) => item.id === draftId) ?? null)
  const loaded = useMailStore((s) => s.draftsLoaded)
  const loadDrafts = useMailStore((s) => s.loadDrafts)
  const accounts = useSettingsStore((s) => s.settings?.mail.accounts)
  const openApp = useViewStore((s) => s.openApp)
  const toast = useToastStore((s) => s.push)
  const editor = useDraftEditor(draft)
  const t = useT()
  useEffect(() => {
    if (!loaded) void loadDrafts()
  }, [loaded, loadDrafts, spec.updatedAt])

  if (!draft) {
    return (
      <div className="card md" data-size={size}>
        <div className="card-hero">
          <h3>{t('mailCards.draft.title')}</h3>
        </div>
        <Empty note={loaded ? t('mailCards.draft.goneNote') : undefined}>{loaded ? t('mailCards.draft.gone') : t('common.loading')}</Empty>
      </div>
    )
  }
  const account = accounts?.find((item) => item.id === draft.accountId)
  const busy = editor.busy === 'send' || editor.busy === 'discard'
  const send = async (): Promise<void> => {
    const summary = await editor.send()
    if (summary) toast({ kind: 'ok', title: draft.reply ? t('mail.done.reply') : t('mail.done.send'), body: summary })
  }
  const replyValues = draft.reply ? { name: displayName(draft.reply.from), subject: draft.reply.subject || t('mail.noSubject') } : null
  return (
    <div className="card md" data-size={size}>
      <div className="card-hero">
        <h3>{draft.reply ? t('mail.composer.replyDraft') : t('mailCards.draft.title')}</h3>
        <p>
          {account ? t('mailCards.draft.from', { label: account.label, email: account.email }) : t('mailCards.draft.noAccount')}
          {draft.origin === 'agent' && ` · ${t('mailCards.draft.fromVoice')}`}
        </p>
      </div>
      <Box title={t('mailCards.draft.content')} note={editor.busy === 'save' ? t('common.saving') : editor.dirty ? t('mail.composer.notSaved') : t('mailCards.draft.editable')}>
        <div className="md-fields">
          {draft.reply && replyValues ? (
            <>
              <p className="md-reply">
                <CornerUpLeft size={13} />
                <span>{draft.reply.replyAll ? t('mailCards.draft.replyToAll', replyValues) : t('mailCards.draft.replyTo', replyValues)}</span>
                <small>{t('mailCards.draft.quoteNote')}</small>
              </p>
              <div className="md-field is-static">
                <span>{t('mail.fields.to')}</span>
                <span className="md-static">{draft.reply.to.map(formatAddress).join(', ')}</span>
              </div>
              {draft.reply.cc.length > 0 && (
                <div className="md-field is-static">
                  <span>Cc</span>
                  <span className="md-static">{draft.reply.cc.map(formatAddress).join(', ')}</span>
                </div>
              )}
            </>
          ) : (
            <>
              <label className="md-field">
                <span>{t('mail.fields.to')}</span>
                <input aria-label={t('mail.fields.to')} value={editor.fields.to} disabled={busy} onChange={(event) => editor.set({ to: event.target.value })} />
              </label>
              {(size !== 's' || editor.fields.cc) && (
                <label className="md-field">
                  <span>Cc</span>
                  <input aria-label="Cc" value={editor.fields.cc} disabled={busy} onChange={(event) => editor.set({ cc: event.target.value })} />
                </label>
              )}
              <label className="md-field">
                <span>{t('mail.fields.subject')}</span>
                <input aria-label={t('mail.fields.subject')} value={editor.fields.subject} disabled={busy} onChange={(event) => editor.set({ subject: event.target.value })} />
              </label>
            </>
          )}
          <textarea
            className="md-body"
            aria-label={t('mail.fields.body')}
            rows={ROWS[size]}
            value={editor.fields.body}
            disabled={busy}
            onChange={(event) => editor.set({ body: event.target.value })}
          />
        </div>
      </Box>
      <Actions>
        <Action tone="primary" disabled={busy || !editor.fields.body.trim()} onClick={() => void send()}>
          {editor.busy === 'send' ? t('mail.sending') : t('mail.send')}
        </Action>
        <Action tone="danger" disabled={busy} onClick={() => void editor.discard()}>
          {t('mail.composer.discard')}
        </Action>
        <Action disabled={busy} onClick={() => openApp({ app: 'mail', draftId: draft.id })} label={t('mailCards.openInMail')}>
          <PenLine size={13} /> {t('mailCards.open')}
        </Action>
      </Actions>
      {editor.error && (
        <p className="card-missing" role="alert">
          {editor.error}
        </p>
      )}
    </div>
  )
}

export const mailDraftCard: CardDefinition = {
  Body: MailDraftBody,
  kicker: 'MAIL · DRAFT',
  className: 'md-card'
}
