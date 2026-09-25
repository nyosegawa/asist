import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MailDraft } from '@shared/mail'
import { errorText } from '@shared/i18n/error-text'
import { MailDraftStore } from '../src/main/services/mail-drafts'

const dirs: string[] = []
const fileIn = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asist-drafts-'))
  dirs.push(dir)
  return path.join(dir, 'mail-drafts.json')
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
const seed = { accountId: 'a1', to: ['t@example.com'], cc: [], subject: '見積もりの件', body: 'よろしくお願いします。', reply: null, origin: 'agent' as const }

describe('MailDraftStore', () => {
  it('lists drafts newest first, advances updatedAt on an edit, drops a removed draft, and publishes the whole list on every change', () => {
    const file = fileIn()
    const changes: MailDraft[][] = []
    let now = 1_000
    const store = new MailDraftStore({ filePath: file, now: () => now, createId: () => `d${changes.length + 1}`, onChanged: (drafts) => changes.push(drafts) })
    const first = store.create(seed)
    now = 2_000
    const second = store.create({ ...seed, subject: '二つ目' })
    expect(store.list().map((draft) => draft.id)).toEqual([second.id, first.id])
    now = 3_000
    expect(store.update(first.id, { body: '直した' })).toMatchObject({ body: '直した', updatedAt: 3_000, subject: '見積もりの件' })
    expect(() => store.update(first.id, {})).toThrow(errorText('mail.errors.form.noChanges'))
    expect(store.remove(second.id).id).toBe(second.id)
    expect(() => store.remove(second.id)).toThrow(errorText('mail.errors.draft.gone'))
    expect(changes.map((list) => list.length)).toEqual([1, 2, 2, 1])
    expect(new MailDraftStore({ filePath: file }).list()).toEqual([{ ...first, body: '直した', updatedAt: 3_000 }])
  })

  it('accepts edits to the body and the reply-all flag only, for a reply draft', () => {
    const store = new MailDraftStore({ filePath: fileIn() })
    const draft = store.create({ ...seed, to: [], subject: '', reply: { id: 'a1:inbox:1', subject: '見積もりの相談', from: { name: '田中', address: 't@example.com' }, replyAll: false } })
    const updated = store.update(draft.id, { to: ['x@example.com'], subject: 'x', body: 'b', replyAll: true })
    expect(updated).toMatchObject({ to: [], subject: '', body: 'b', reply: { replyAll: true } })
    expect('replyAll' in updated).toBe(false)
  })

  it('refuses a draft beyond the limit, reports an unreadable file, and surfaces a failed write', () => {
    const file = fileIn()
    const store = new MailDraftStore({ filePath: file })
    for (let index = 0; index < 50; index += 1) store.create(seed)
    expect(() => store.create(seed)).toThrow(errorText('mail.errors.draft.tooMany', { count: 50 }))
    fs.writeFileSync(file, '{ broken')
    expect(() => new MailDraftStore({ filePath: file }).list()).toThrow(/mail.errors.draft.fileUnreadable/)
    const spy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    const fresh = new MailDraftStore({ filePath: fileIn() })
    expect(() => fresh.create(seed)).toThrow('disk full')
    expect(fresh.list()).toEqual([])
    spy.mockRestore()
  })
})
