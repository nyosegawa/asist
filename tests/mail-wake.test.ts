import type { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { MailSettings } from '@shared/mail'
import { FakeImap } from './helpers/fake-imap'

/** The mail integration as Electron starts it, with the IMAP connection replaced by a fake. */

const mocks = vi.hoisted(() => ({ userData: '', server: null as unknown as ReturnType<FakeImap['reconnectable']> }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    app: { getPath: () => mocks.userData, once: () => undefined },
    BrowserWindow: { getAllWindows: () => [] },
    Notification: { isSupported: () => false },
    powerMonitor: new EventEmitter(),
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (plain: string) => Buffer.from(plain), decryptString: (data: Buffer) => data.toString() },
    shell: { openExternal: async () => undefined }
  }
})
const settings: MailSettings = {
  enabled: true,
  accounts: [
    {
      id: 'a1',
      label: '仕事',
      email: 'me@example.com',
      name: '私',
      provider: 'custom',
      imap: { host: 'imap.example.com', port: 993, secure: true },
      smtp: { host: 'smtp.example.com', port: 465, secure: true },
      folders: { sent: null, archive: null, trash: null }
    }
  ],
  defaultAccountId: 'a1',
  syncDays: 30,
  notifyNewMail: false
}
vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ uiLocale: 'ja-JP', mail: settings }), saveSettings: () => undefined }))
vi.mock('../src/main/services/mail-secrets', () => ({ createMailSecretStore: () => ({ get: () => 'app-password', set: () => undefined, remove: () => undefined }) }))
vi.mock('../src/main/services/mail-imap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/services/mail-imap')>()),
  createImapClient: () => mocks.server.next().asClient()
}))

let mail: typeof import('../src/main/services/mail')
beforeAll(async () => {
  mocks.userData = mkdtempSync(path.join(tmpdir(), 'asist-mail-wake-'))
  mail = await import('../src/main/services/mail')
})
afterAll(() => rmSync(mocks.userData, { recursive: true, force: true }))

it('syncs over a new connection when the machine wakes, instead of waiting on the one it held across sleep', async () => {
  const imap = new FakeImap()
  mocks.server = imap.reconnectable()
  const { powerMonitor } = await import('electron')
  mail.initMail()
  const service = mail.getMailService()
  await vi.waitFor(() => expect(service.status().accounts[0].state).toBe('connected'))
  // The server and the network forgot the connection during sleep, and nothing on this side noticed.
  imap.silent = true
  imap.put('INBOX', { subject: '寝ている間に届いた', from: [{ name: '田中', address: 't@example.com' }], to: [{ name: '', address: 'me@example.com' }], date: new Date(), text: 'x' })
  ;(powerMonitor as unknown as EventEmitter).emit('resume')
  try {
    await vi.waitFor(() => expect(service.list({ view: 'inbox' }).messages.map((message) => message.subject)).toEqual(['寝ている間に届いた']), { timeout: 2_000 })
    expect(service.status().accounts[0].state).toBe('connected')
  } finally {
    for (const instance of mocks.server.instances) instance.close()
    await service.stop()
  }
})
