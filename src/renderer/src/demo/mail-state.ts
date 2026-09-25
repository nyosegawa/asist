import type { MailDraft, MailEvent } from '@shared/mail'
import { DEMO_MAIL_DRAFTS } from './fixtures/mail'

/**
 * Mail events and drafts of the demo. Both api.ts, the mock API, and sayings.ts, the replies to typed
 * utterances, use them, so they live here where neither has to depend on the other. In the real app the
 * main process stores the drafts and broadcasts them through the drafts event of onMailEvent.
 */

export const mailListeners = new Set<(e: MailEvent) => void>()
export const emitMail = (event: MailEvent): void => mailListeners.forEach((listener) => listener(event))

let drafts: MailDraft[] = DEMO_MAIL_DRAFTS.map((draft) => ({ ...draft }))
export const demoDrafts = (): MailDraft[] => drafts
export const commitDrafts = (next: MailDraft[]): void => {
  drafts = next
  emitMail({ type: 'drafts', drafts: next.map((draft) => ({ ...draft })) })
}
export const demoDraft = (id: string): MailDraft => {
  const draft = drafts.find((candidate) => candidate.id === id)
  if (!draft) throw new Error('下書きが見つかりません。送ったか、捨てたあとかもしれません')
  return draft
}
/** A send asked for by voice becomes a draft instead. sayings.ts calls this. */
export function createDemoDraft(seed: Omit<MailDraft, 'id' | 'createdAt' | 'updatedAt'>): MailDraft {
  const draft: MailDraft = { ...seed, id: `draft-${Date.now().toString(36)}`, createdAt: Date.now(), updatedAt: Date.now() }
  commitDrafts([draft, ...drafts])
  return draft
}
