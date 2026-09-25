// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '@shared/settings'
import type { MailListQuery, MailMessage } from '@shared/mail'
import { createTranslator } from '@shared/i18n'
import { MailView } from '../src/renderer/src/ui/mail/MailView'
import { useMailStore, useSettingsStore, useToastStore } from '../src/renderer/src/state/stores'
import { useViewStore } from '../src/renderer/src/state/view'
import { DEMO_MAIL_ACCOUNTS, DEMO_MAIL_BODIES, DEMO_MAIL_DRAFTS, DEMO_MAIL_MESSAGES, demoMailStatus } from '../src/renderer/src/demo/fixtures/mail'

const t = createTranslator('ja-JP')
const inbox = (): MailMessage[] => DEMO_MAIL_MESSAGES.filter((m) => m.folder === 'inbox').sort((a, b) => b.date - a.date)
const api = {
  mailList: vi.fn(async (query: MailListQuery) => {
    const view = query.view ?? 'inbox'
    const list = DEMO_MAIL_MESSAGES.filter((m) => (view === 'starred' ? m.starred : m.folder === view))
      .filter((m) => !query.accountId || m.accountId === query.accountId)
      .filter((m) => !query.unreadOnly || m.unread)
      .sort((a, b) => b.date - a.date)
    return { messages: list, total: list.length, unread: list.filter((m) => m.unread).length }
  }),
  mailThread: vi.fn(async (accountId: string, threadId: string) => DEMO_MAIL_MESSAGES.filter((m) => m.accountId === accountId && m.threadId === threadId).sort((a, b) => a.date - b.date)),
  mailRead: vi.fn(async (id: string) => ({ message: DEMO_MAIL_MESSAGES.find((m) => m.id === id)!, text: DEMO_MAIL_BODIES.get(id) ?? '' })),
  mailChange: vi.fn(async (change: { operation: string }) => ({ saved: true, operation: change.operation, id: 'x', summary: '済み' })),
  mailStatus: vi.fn(async () => demoMailStatus(DEMO_MAIL_MESSAGES)),
  mailSyncNow: vi.fn(async () => {}),
  mailDraftList: vi.fn(async () => DEMO_MAIL_DRAFTS),
  mailDraftCreate: vi.fn(async () => DEMO_MAIL_DRAFTS[0]),
  mailDraftUpdate: vi.fn(async (id: string, patch: Record<string, unknown>) => ({ ...DEMO_MAIL_DRAFTS.find((d) => d.id === id)!, ...patch })),
  mailDraftRemove: vi.fn(async () => {}),
  mailDraftSend: vi.fn(async () => ({ saved: true, operation: 'send', id: '<x>', summary: t('mail.result.send', { recipients: '田中' }) }))
}
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('React', React)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('window', Object.assign(window, { api }))
  for (const fn of Object.values(api)) fn.mockClear()
  useSettingsStore.setState({
    settings: { mail: { enabled: true, accounts: DEMO_MAIL_ACCOUNTS, defaultAccountId: 'demo-work', syncDays: 30, notifyNewMail: true } } as AppSettings
  })
  useMailStore.setState({ status: demoMailStatus(DEMO_MAIL_MESSAGES), revision: 0, drafts: DEMO_MAIL_DRAFTS, draftsLoaded: true })
  useToastStore.setState({ toasts: [] })
  useViewStore.getState().closeApp()
  useViewStore.getState().openApp({ app: 'mail' })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(): Promise<HTMLElement> {
  await act(async () => root.render(React.createElement(MailView, { open: true })))
  await act(async () => {})
  return container.querySelector<HTMLElement>('[aria-label="MAIL"]')!
}
const setValue = (input: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
const texts = (selector: string): string[] => [...container.querySelectorAll(selector)].map((el) => el.textContent?.trim() ?? '')

describe('the message list', () => {
  it('shows the inbox newest first, marks the unread rows, and filters by folder and by account', async () => {
    const view = await render()
    expect(api.mailList).toHaveBeenCalledWith(expect.objectContaining({ view: 'inbox', accountId: null, query: '' }))
    expect(texts('.ml-row-subject')).toEqual(inbox().map((m) => m.subject))
    expect(view.querySelectorAll('.ml-row[data-unread]')).toHaveLength(inbox().filter((m) => m.unread).length)
    expect(view.querySelector('.ml-count')?.textContent).toBe(t('mail.messageCount', { count: inbox().length }))
    expect(view.querySelector('.ml-view[aria-pressed="true"]')?.textContent).toContain(t('mail.boxes.inbox'))
    await act(async () => [...view.querySelectorAll<HTMLButtonElement>('.ml-view')].find((el) => el.textContent?.includes(t('mail.boxes.sent')))!.click())
    expect(api.mailList).toHaveBeenLastCalledWith(expect.objectContaining({ view: 'sent' }))
    expect(texts('.ml-row-subject')).toEqual(DEMO_MAIL_MESSAGES.filter((m) => m.folder === 'sent').map((m) => m.subject))
    expect(view.querySelector('.ml-row-from')?.textContent).toContain('To: 田中 誠')
    await act(async () => [...view.querySelectorAll<HTMLButtonElement>('.ml-view')].find((el) => el.textContent?.includes(t('mail.boxes.inbox')))!.click())
    await act(async () => view.querySelector<HTMLButtonElement>('.ml-account[data-state]')!.click())
    expect(api.mailList).toHaveBeenLastCalledWith(expect.objectContaining({ view: 'inbox', accountId: 'demo-work' }))
    expect(texts('.ml-row-subject')).toEqual(inbox().filter((m) => m.accountId === 'demo-work').map((m) => m.subject))
  })

  it('flips the star on the click, puts it back when main rejects the change, and reloads the list when the sync reports a change', async () => {
    const view = await render()
    const first = inbox()[0]
    let release!: (value: { saved: boolean }) => void
    api.mailChange.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
    await act(async () => view.querySelector<HTMLButtonElement>('.ml-star')!.click())
    expect(api.mailChange).toHaveBeenCalledWith({ operation: 'star', id: first.id, starred: !first.starred })
    expect(view.querySelector('.ml-star')?.getAttribute('aria-pressed')).toBe(String(!first.starred))
    await act(async () => release({ saved: true }))
    expect(view.querySelector('.ml-star')?.getAttribute('aria-pressed')).toBe(String(!first.starred))
    api.mailChange.mockRejectedValueOnce(new Error('IMAP サーバーが応答しません'))
    await act(async () => view.querySelector<HTMLButtonElement>('.ml-star')!.click())
    expect(api.mailChange).toHaveBeenLastCalledWith({ operation: 'star', id: first.id, starred: first.starred })
    expect(view.querySelector('.ml-star')?.getAttribute('aria-pressed')).toBe(String(!first.starred))
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ kind: 'error', body: 'IMAP サーバーが応答しません' })
    const calls = api.mailList.mock.calls.length
    await act(async () => useMailStore.getState().bump())
    expect(api.mailList.mock.calls.length).toBe(calls + 1)
  })

  it('collects the ids of every unread message matching the filter behind the mark-all-read button, sends them in one call, and clears the rows at once', async () => {
    const view = await render()
    const unread = inbox().filter((m) => m.unread)
    const button = view.querySelector<HTMLButtonElement>('.ml-read-all')!
    expect(button.textContent).toContain(t('mail.list.markAllRead', { count: unread.length }))
    let release!: (value: { saved: boolean }) => void
    api.mailChange.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
    await act(async () => button.click())
    expect(api.mailList).toHaveBeenLastCalledWith(expect.objectContaining({ view: 'inbox', unreadOnly: true, limit: 1000 }))
    expect(api.mailChange).toHaveBeenCalledWith({ operation: 'markRead', ids: unread.map((m) => m.id), read: true })
    expect(view.querySelectorAll('.ml-row[data-unread]')).toHaveLength(0)
    expect(view.querySelector('.ml-read-all')).toBeNull()
    await act(async () => release({ saved: true }))
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ kind: 'ok', title: t('mail.list.markedRead', { count: unread.length }) })
  })

  it('loads no list without an account and points at the settings screen', async () => {
    useSettingsStore.setState({ settings: { mail: { enabled: true, accounts: [], defaultAccountId: null, syncDays: 30, notifyNewMail: true } } as AppSettings })
    const view = await render()
    expect(api.mailList).not.toHaveBeenCalled()
    expect(view.querySelector('.ml-notice')?.textContent).toContain(t('mail.empty.noAccounts'))
    await act(async () => view.querySelector<HTMLButtonElement>('.ml-notice button')!.click())
    expect(useViewStore.getState().open?.app).toBe('settings')
  })
})

describe('reading', () => {
  it('opens the thread on a row click, loads the body, marks an unread message read, and hands the reply body to main', async () => {
    const view = await render()
    const first = inbox()[0]
    await act(async () => view.querySelector<HTMLButtonElement>('.ml-row-main')!.click())
    await act(async () => {})
    expect(api.mailRead).toHaveBeenCalledWith(first.id)
    expect(api.mailThread).toHaveBeenCalledWith(first.accountId, first.threadId)
    expect(api.mailChange).toHaveBeenCalledWith({ operation: 'markRead', ids: [first.id], read: true })
    const reader = view.querySelector('.ml-reader')!
    expect(reader.querySelector('h2')?.textContent).toBe(first.subject)
    // The thread holds two received messages and one sent message.
    expect(reader.querySelectorAll('.ml-message')).toHaveLength(3)
    expect(reader.querySelector('.ml-message[data-open] .ml-text')?.textContent).toContain('火曜 14時か水曜 10時')
    await act(async () => [...reader.querySelectorAll<HTMLButtonElement>('.ml-actions .cal-btn')].find((el) => el.textContent?.includes(t('mail.reply')))!.click())
    const form = reader.querySelector<HTMLFormElement>('.ml-reply')!
    await act(async () => setValue(form.querySelector('textarea')!, '火曜 14時でお願いします。'))
    await act(async () => form.requestSubmit())
    expect(api.mailChange).toHaveBeenCalledWith({ operation: 'reply', id: first.id, body: '火曜 14時でお願いします。', replyAll: false })
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ kind: 'ok', title: t('mail.done.reply') })
    expect(reader.querySelector('.ml-reply')).toBeNull()
  })

  it('closes the reader after an archive and keeps it open when the confirmation is cancelled', async () => {
    const view = await render()
    await act(async () => view.querySelector<HTMLButtonElement>('.ml-row-main')!.click())
    await act(async () => {})
    api.mailChange.mockResolvedValueOnce({ cancelled: true, saved: false })
    await act(async () => [...view.querySelectorAll<HTMLButtonElement>('.ml-actions .cal-btn')].find((el) => el.textContent?.includes(t('mail.trash')))!.click())
    expect(view.querySelector('.ml-reader')).not.toBeNull()
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ kind: 'info', title: t('mail.change.cancelled') })
    await act(async () => [...view.querySelectorAll<HTMLButtonElement>('.ml-actions .cal-btn')].find((el) => el.textContent?.includes(t('mail.archive')))!.click())
    expect(api.mailChange).toHaveBeenLastCalledWith({ operation: 'archive', id: inbox()[0].id })
    expect(view.querySelector('.ml-reader')).toBeNull()
  })
})

describe('composing and Escape', () => {
  it('splits the recipients of a composed message and closes the form once it is sent', async () => {
    const view = await render()
    await act(async () => view.querySelector<HTMLButtonElement>('.ml-compose')!.click())
    const form = view.querySelector<HTMLFormElement>('.ml-composer')!
    await act(async () => setValue(form.querySelector(`[aria-label="${t('mail.fields.to')}"]`)!, '田中 <t@example.co.jp>, hana@example.co.jp'))
    await act(async () => setValue(form.querySelector(`[aria-label="${t('mail.fields.subject')}"]`)!, '候補日'))
    await act(async () => setValue(form.querySelector(`[aria-label="${t('mail.fields.body')}"]`)!, '火曜でお願いします。'))
    await act(async () => form.requestSubmit())
    expect(api.mailChange).toHaveBeenCalledWith({
      operation: 'send',
      accountId: 'demo-work',
      to: ['田中 <t@example.co.jp>', 'hana@example.co.jp'],
      cc: [],
      subject: '候補日',
      body: '火曜でお願いします。'
    })
    expect(view.querySelector('.ml-composer')).toBeNull()
  })

  it('creates the draft in main and closes the composer when the save-as-draft button is pressed', async () => {
    const view = await render()
    await act(async () => view.querySelector<HTMLButtonElement>('.ml-compose')!.click())
    const form = view.querySelector<HTMLFormElement>('.ml-composer')!
    await act(async () => setValue(form.querySelector(`[aria-label="${t('mail.fields.to')}"]`)!, 't@example.co.jp'))
    await act(async () => setValue(form.querySelector(`[aria-label="${t('mail.fields.body')}"]`)!, '書きかけ'))
    await act(async () => [...form.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent?.includes(t('mail.composer.saveDraft')))!.click())
    expect(api.mailDraftCreate).toHaveBeenCalledWith({ accountId: 'demo-work', to: ['t@example.co.jp'], cc: [], subject: '', body: '書きかけ' })
    expect(api.mailChange).not.toHaveBeenCalled()
    expect(view.querySelector('.ml-composer')).toBeNull()
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ kind: 'ok', title: t('mail.composer.draftSaved') })
  })

  it('lists the drafts held by main, reopens the one that is clicked in the composer, and asks main to send that draft', async () => {
    const view = await render()
    await act(async () => [...view.querySelectorAll<HTMLButtonElement>('.ml-view')].find((el) => el.textContent?.includes(t('mail.boxes.drafts')))!.click())
    expect(view.querySelector('.ml-view[aria-pressed="true"]')?.textContent).toContain(`${t('mail.boxes.drafts')}${DEMO_MAIL_DRAFTS.length}`)
    expect(texts('.ml-row-subject')).toEqual(['季節のご挨拶', 'Re: 来週の打合せの候補日'])
    await act(async () => view.querySelector<HTMLButtonElement>('.ml-row-main')!.click())
    const form = view.querySelector<HTMLFormElement>('.ml-composer')!
    expect(form.querySelector<HTMLInputElement>(`[aria-label="${t('mail.fields.subject')}"]`)?.value).toBe('季節のご挨拶')
    await act(async () => form.requestSubmit())
    expect(api.mailDraftSend).toHaveBeenCalledWith(DEMO_MAIL_DRAFTS[0].id)
    expect(api.mailChange).not.toHaveBeenCalled()
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ kind: 'ok', title: t('mail.done.send') })
    expect(view.querySelector('.ml-composer')).toBeNull()
    // Opening the screen from a draft card opens the composer on that draft.
    await act(async () => useViewStore.getState().openApp({ app: 'mail', draftId: DEMO_MAIL_DRAFTS[1].id }))
    expect(view.querySelector('.ml-composer h2')?.textContent).toBe(t('mail.composer.replyDraft'))
    expect(view.querySelector('.ml-composer .ml-reply-to')?.textContent).toContain(t('mail.composer.replyTo', { name: '田中 誠', subject: '来週の打合せの候補日' }))
  })

  it('closes the reader on the first Escape and the screen on the second', async () => {
    const view = await render()
    await act(async () => view.querySelector<HTMLButtonElement>('.ml-row-main')!.click())
    await act(async () => {})
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(view.querySelector('.ml-reader')).toBeNull()
    expect(useViewStore.getState().open?.app).toBe('mail')
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(useViewStore.getState().open?.app).not.toBe('mail')
  })
})
