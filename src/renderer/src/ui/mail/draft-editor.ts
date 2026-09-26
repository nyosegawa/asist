import { useEffect, useRef, useState } from 'react'
import { errorText } from '@shared/i18n/error-text'
import type { MailDraft } from '@shared/mail'
import { splitRecipients } from './format'
import { displayError } from '@/display-error'

/**
 * Editing a draft, which behaves the same in the card and in the composer of the mail view. Input is
 * saved to main a short while after the typing, so that nothing travels while the user types, and
 * sending saves first. What the Agent changed through update_mail_draft is taken over here as long
 * as nothing is half typed on this side.
 */

export interface DraftFields {
  to: string
  cc: string
  subject: string
  body: string
}

const SAVE_DELAY_MS = 600

export const fieldsOf = (draft: MailDraft): DraftFields => ({ to: draft.to.join(', '), cc: draft.cc.join(', '), subject: draft.subject, body: draft.body })

export function useDraftEditor(draft: MailDraft | null): {
  fields: DraftFields
  set: (patch: Partial<DraftFields>) => void
  dirty: boolean
  busy: 'save' | 'send' | 'discard' | null
  error: string
  /** The summary once the draft has been sent, or null on failure, with the reason in `error`. */
  send: () => Promise<string | null>
  discard: () => Promise<boolean>
} {
  const [fields, setFields] = useState<DraftFields>(() => (draft ? fieldsOf(draft) : { to: '', cc: '', subject: '', body: '' }))
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<'save' | 'send' | 'discard' | null>(null)
  const [error, setError] = useState('')
  const latest = useRef(fields)
  latest.current = fields
  const id = draft?.id ?? null
  const updatedAt = draft?.updatedAt ?? 0

  // A draft changed from outside, by the Agent, is taken over unless something is half typed here.
  useEffect(() => {
    if (draft && !dirty) setFields(fieldsOf(draft))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, updatedAt])

  const save = async (): Promise<void> => {
    if (!id) return
    const current = latest.current
    await window.api.mailDraftUpdate(id, { to: splitRecipients(current.to), cc: splitRecipients(current.cc), subject: current.subject, body: current.body })
    if (latest.current === current) setDirty(false)
  }

  useEffect(() => {
    if (!dirty || !id) return
    const timer = setTimeout(() => {
      setBusy((current) => current ?? 'save')
      void save()
        .then(() => setError(''))
        .catch((err: unknown) => setError(displayError(err)))
        .finally(() => setBusy((current) => (current === 'save' ? null : current)))
    }, SAVE_DELAY_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields, dirty, id])

  const set = (patch: Partial<DraftFields>): void => {
    setFields((current) => ({ ...current, ...patch }))
    setDirty(true)
  }

  const send = async (): Promise<string | null> => {
    if (!id || busy === 'send' || busy === 'discard') return null
    setBusy('send')
    try {
      if (dirty) await save()
      const result = await window.api.mailDraftSend(id)
      if (!result.saved) throw new Error(errorText('mail.composer.notSent'))
      setError('')
      return result.summary
    } catch (err) {
      setError(displayError(err))
      return null
    } finally {
      setBusy(null)
    }
  }

  const discard = async (): Promise<boolean> => {
    if (!id || busy === 'send') return false
    setBusy('discard')
    try {
      await window.api.mailDraftRemove(id)
      return true
    } catch (err) {
      setError(displayError(err))
      return false
    } finally {
      setBusy(null)
    }
  }

  return { fields, set, dirty, busy, error, send, discard }
}

