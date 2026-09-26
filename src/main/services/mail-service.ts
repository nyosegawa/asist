import {
  displayName,
  formatAddress,
  mailAccountInputSchema,
  mailAccountPatchSchema,
  mailChangeSchema,
  mailDraftInputSchema,
  parseAddress,
  parseMailInput,
  parseMessageId,
  quotedBody,
  replyRecipients,
  replySubject,
  type MailAccount,
  type MailAccountStatus,
  type MailAddress,
  type MailChange,
  type MailChangeResult,
  type MailDraft,
  type MailEvent,
  type MailFolders,
  type MailListResult,
  type MailMessage,
  type MailMessageBody,
  type MailProbeResult,
  type MailSettings,
  type MailStatus
} from '@shared/mail'
import { errorText } from '@shared/i18n/error-text'
import { promptLanguage } from '@shared/conversation-locale'
import { conversationLocale } from './conversation-locale'
import { errorMessage, t } from './i18n'
import type { MailCache } from './mail-cache'
import type { MailDraftStore } from './mail-drafts'
import { supportsGmail, type ImapClient, type ImapClientFactory } from './mail-imap'
import type { MailSecretStore } from './mail-secrets'
import { failedBeforeSending, type SmtpSender } from './mail-smtp'
import { MailAccountSync, type MailSyncIntervals } from './mail-sync'
import { getSettings } from './settings'
import { formatLocaleOf } from '@shared/conversation-locale'

/**
 * The centre of the mail integration. It owns one sync per account, answers listings and bodies from the
 * cache, and puts sending, replying, archiving, trashing, marking read and starring through the approval
 * gate before they reach the server.
 *
 * The approval rule: for an operation that leaves the machine, sending or replying, approval is the user
 * pressing the send button after seeing the recipients and the whole body. An Agent that wants to send
 * does not send; it writes a draft and waits for the user to press the button on the card or the screen.
 * Sending from the compose form or from a draft is already approved by that press, so no confirmation
 * dialog is shown. Every other Agent operation (archive, trash, mark read, star) and trashing from the
 * screen goes through the confirmation dialog. A send is attempted exactly once, and a failure whose
 * outcome is unknown is never retried.
 */

export type MailChangeSource = 'agent' | 'screen'

export interface MailServiceDependencies {
  settings: () => MailSettings
  /** Writes the settings file. Validation is the job of the settings module that supplies this. */
  saveSettings: (mail: MailSettings) => void
  secrets: MailSecretStore
  cache: MailCache
  drafts: MailDraftStore
  createClient: ImapClientFactory
  smtp: SmtpSender
  /** `action` names the operation on the button that carries it out, such as "ゴミ箱へ移す". */
  confirm: (detail: string, signal: AbortSignal, action: string, destructive: boolean) => Promise<boolean>
  emit: (event: MailEvent) => void
  now?: () => number
  createId?: () => string
  syncIntervals?: Partial<MailSyncIntervals>
}

const SPECIAL_USE: Record<keyof MailFolders, readonly string[]> = {
  sent: ['\\Sent'],
  // On Gmail the archive lives in "すべてのメール" (All Mail), which reports \All rather than \Archive.
  archive: ['\\Archive', '\\All'],
  trash: ['\\Trash']
}

const CONFIRM_BODY_MAX = 1200
const REJECTED = errorText('mail.errors.change.rejected')

/** The words on the confirmation's button: the operation itself, so that the button says what pressing it does. */
function confirmAction(input: MailChange): string {
  if (input.operation === 'markRead') return t(input.read ? 'mail.confirm.action.markRead' : 'mail.confirm.action.markUnread')
  if (input.operation === 'star') return t(input.starred ? 'mail.confirm.action.star' : 'mail.confirm.action.unstar')
  if (input.operation === 'send') return t('mail.confirm.action.send')
  if (input.operation === 'reply') return t('mail.confirm.action.reply')
  return t(input.operation === 'archive' ? 'mail.confirm.action.archive' : 'mail.confirm.action.trash')
}

export class MailService {
  private readonly syncs = new Map<string, MailAccountSync>()
  private started = false
  /**
   * Only one confirmation dialog may be open at a time. The operations themselves are not guarded here,
   * because the connection queue in mail-sync's run already serializes them.
   */
  private confirming = false

  constructor(private readonly deps: MailServiceDependencies) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  start(): void {
    this.started = true
    this.applySettings()
  }

  async stop(): Promise<void> {
    this.started = false
    await Promise.all([...this.syncs.values()].map((sync) => sync.stop()))
    this.syncs.clear()
  }

  /** Rebuilds the syncs from the settings. An account whose configuration is unchanged keeps its connection. */
  applySettings(): void {
    if (!this.started) return
    const settings = this.deps.settings()
    const wanted = new Map(settings.enabled ? settings.accounts.map((account) => [account.id, account]) : [])
    for (const [id, sync] of this.syncs) {
      const account = wanted.get(id)
      if (account && JSON.stringify(account) === JSON.stringify(sync.account)) continue
      this.syncs.delete(id)
      void sync.stop()
    }
    for (const [id, account] of wanted) {
      if (this.syncs.has(id)) continue
      const sync = new MailAccountSync({
        account,
        password: () => this.passwordOf(id),
        cache: this.deps.cache,
        createClient: this.deps.createClient,
        syncDays: () => this.deps.settings().syncDays,
        now: () => this.now(),
        intervals: this.deps.syncIntervals,
        onStatus: () => this.emitStatus(),
        onChanged: () => {
          this.deps.emit({ type: 'changed', accountId: id })
          this.emitStatus()
        },
        onArrived: (messages) => this.deps.emit({ type: 'arrived', accountId: id, messages })
      })
      this.syncs.set(id, sync)
      sync.start()
    }
    this.emitStatus()
  }

  private passwordOf(id: string): string {
    const password = this.deps.secrets.get(id)
    if (password === null) throw new Error(errorText('mail.errors.account.passwordMissing'))
    return password
  }

  private emitStatus(): void {
    this.deps.emit({ type: 'status', status: this.status() })
  }

  status(): MailStatus {
    const settings = this.deps.settings()
    const now = this.now()
    const accounts: MailAccountStatus[] = settings.accounts.map((account) => {
      const sync = this.syncs.get(account.id)
      const counts = this.deps.cache.counts(account.id, now)
      return {
        id: account.id,
        label: account.label,
        email: account.email,
        provider: account.provider,
        state: sync?.state ?? 'off',
        error: sync?.error ?? '',
        lastSyncAt: sync?.lastSyncAt ?? null,
        unread: counts.unread,
        unreadRecent: counts.unreadRecent
      }
    })
    return {
      enabled: settings.enabled,
      accounts,
      unread: accounts.reduce((sum, account) => sum + account.unread, 0),
      unreadRecent: accounts.reduce((sum, account) => sum + account.unreadRecent, 0)
    }
  }

  /** Connects and looks up the special folders. A folder the server does not advertise stays null; it is never guessed. */
  async probe(value: unknown): Promise<MailProbeResult> {
    const input = parseMailInput(mailAccountInputSchema, value)
    const client = this.deps.createClient({ email: input.email, imap: input.imap }, input.password)
    try {
      await client.connect()
    } catch (error) {
      client.close()
      throw new Error(errorText('mail.errors.account.connectFailed', { reason: errorMessage(error) }))
    }
    try {
      const folders = await client.list()
      const find = (kinds: readonly string[]): string | null => {
        for (const kind of kinds) {
          const hit = folders.find((folder) => folder.specialUse === kind)
          if (hit) return hit.path
        }
        return null
      }
      return {
        folders: { sent: find(SPECIAL_USE.sent), archive: find(SPECIAL_USE.archive), trash: find(SPECIAL_USE.trash) },
        gmail: supportsGmail(client),
        mailboxes: folders.map((folder) => folder.path)
      }
    } finally {
      try {
        await client.logout()
      } catch {
        client.close()
      }
    }
  }

  async addAccount(value: unknown): Promise<MailAccount> {
    const input = parseMailInput(mailAccountInputSchema, value)
    const settings = this.deps.settings()
    if (settings.accounts.some((account) => account.email.toLowerCase() === input.email.toLowerCase())) {
      throw new Error(errorText('mail.errors.account.duplicate'))
    }
    const probe = await this.probe(input)
    const account: MailAccount = {
      id: this.deps.createId?.() ?? globalThis.crypto.randomUUID(),
      label: input.label,
      email: input.email,
      name: input.name,
      provider: input.provider,
      imap: input.imap,
      smtp: input.smtp,
      folders: probe.folders
    }
    this.deps.secrets.set(account.id, input.password)
    this.deps.saveSettings({
      ...settings,
      enabled: true,
      accounts: [...settings.accounts, account],
      defaultAccountId: settings.defaultAccountId ?? account.id
    })
    this.applySettings()
    return account
  }

  async updateAccount(id: string, patchValue: unknown, password?: string): Promise<MailAccount> {
    const settings = this.deps.settings()
    const current = settings.accounts.find((account) => account.id === id)
    if (!current) throw new Error(errorText('mail.errors.account.notFound'))
    const patch = patchValue === undefined ? {} : parseMailInput(mailAccountPatchSchema, patchValue)
    const next: MailAccount = { ...current, ...patch }
    if (password !== undefined) {
      if (!password) throw new Error(errorText('mail.errors.form.password'))
      // The new password is stored only after a real connection with it has succeeded.
      await this.probe({ label: next.label, email: next.email, name: next.name, provider: next.provider, imap: next.imap, smtp: next.smtp, password })
      this.deps.secrets.set(id, password)
    }
    // The account's sync is rebuilt below. The running one is stopped first, since it holds the old
    // password and could still write the folder it was fetching after the cache is cleared.
    const sync = this.syncs.get(id)
    if (sync) {
      this.syncs.delete(id)
      await sync.stop()
    }
    // The cache files messages under the role of their folder, not its path, and drops them by itself only
    // when UIDVALIDITY changes, which two mailboxes can share. Unless a folder that now points at another
    // mailbox is emptied, the list goes on showing the old messages, and a move to the trash takes the new
    // mailbox's message with the same UID.
    const repointed = (['sent', 'archive'] as const).filter((folder) => next.folders[folder] !== current.folders[folder])
    for (const folder of repointed) this.deps.cache.clearFolder(id, folder)
    this.deps.saveSettings({ ...settings, accounts: settings.accounts.map((account) => (account.id === id ? next : account)) })
    this.applySettings()
    if (repointed.length > 0) this.deps.emit({ type: 'changed', accountId: id })
    return next
  }

  async removeAccount(id: string): Promise<void> {
    const settings = this.deps.settings()
    if (!settings.accounts.some((account) => account.id === id)) throw new Error(errorText('mail.errors.account.notFound'))
    const sync = this.syncs.get(id)
    this.syncs.delete(id)
    if (sync) await sync.stop()
    const accounts = settings.accounts.filter((account) => account.id !== id)
    this.deps.saveSettings({
      ...settings,
      accounts,
      defaultAccountId: settings.defaultAccountId === id ? (accounts[0]?.id ?? null) : settings.defaultAccountId
    })
    this.deps.cache.clearAccount(id)
    this.deps.secrets.remove(id)
    this.applySettings()
    this.deps.emit({ type: 'changed', accountId: id })
  }

  list(query: unknown): MailListResult {
    return this.deps.cache.list(query)
  }

  thread(accountId: string, threadId: string): MailMessage[] {
    return this.deps.cache.thread(accountId, threadId)
  }

  async read(id: string): Promise<MailMessageBody> {
    const { accountId, folder, uid } = parseMessageId(id)
    const message = this.deps.cache.get(id)
    if (!message) throw new Error(errorText('mail.errors.message.notFound'))
    const text = await this.requireSync(accountId).fetchBody(folder, uid)
    return { message: this.deps.cache.get(id) ?? message, text }
  }

  syncNow(): Promise<void> {
    return Promise.all([...this.syncs.values()].map((sync) => sync.syncNow())).then(() => undefined)
  }

  private requireSync(accountId: string): MailAccountSync {
    const sync = this.syncs.get(accountId)
    if (!sync) throw new Error(errorText('mail.errors.account.off'))
    return sync
  }

  private accountOf(id: string): MailAccount {
    const account = this.deps.settings().accounts.find((candidate) => candidate.id === id)
    if (!account) throw new Error(errorText('mail.errors.account.notFound'))
    return account
  }

  private senderAccount(accountId: string | null): MailAccount {
    const settings = this.deps.settings()
    if (accountId) return this.accountOf(accountId)
    const account = settings.accounts.find((candidate) => candidate.id === settings.defaultAccountId) ?? settings.accounts[0]
    if (!account) throw new Error(errorText('mail.errors.account.none'))
    return account
  }

  async change(value: unknown, signal: AbortSignal, source: MailChangeSource): Promise<MailChangeResult> {
    const input: MailChange = parseMailInput(mailChangeSchema, value)
    signal.throwIfAborted()
    if (!this.deps.settings().enabled) throw new Error(errorText('mail.errors.disabled'))
    if (source === 'agent' && (input.operation === 'send' || input.operation === 'reply')) {
      const draft = this.draftCreate(
        input.operation === 'send'
          ? { accountId: input.accountId, to: input.to, cc: input.cc, subject: input.subject, body: input.body }
          : { replyToId: input.id, body: input.body, replyAll: input.replyAll },
        'agent'
      )
      return { drafted: true, saved: false, draftId: draft.id, summary: draftSummary(draft) }
    }
    const plan = await this.plan(input)
    const needsConfirm = source === 'agent' || input.operation === 'trash'
    if (needsConfirm) {
      if (this.confirming) throw new Error(errorText('mail.errors.change.confirmBusy'))
      this.confirming = true
      try {
        const configuration = JSON.stringify(this.deps.settings())
        signal.throwIfAborted()
        if (!(await this.deps.confirm(plan.detail, signal, confirmAction(input), input.operation === 'trash'))) return { cancelled: true, saved: false }
        signal.throwIfAborted()
        if (JSON.stringify(this.deps.settings()) !== configuration) {
          throw new Error(errorText('mail.errors.change.settingsChanged'))
        }
      } finally {
        this.confirming = false
      }
    }
    return plan.perform()
  }

  draftList(): MailDraft[] {
    return this.deps.drafts.list()
  }

  /**
   * Checks the sender account and, for a reply, the message being answered before storing anything. A
   * reply draft keeps its own copy of the original subject and sender, so it still renders after the
   * message has left the cache.
   */
  draftCreate(value: unknown, origin: MailDraft['origin']): MailDraft {
    const input = parseMailInput(mailDraftInputSchema, value)
    if (!this.deps.settings().enabled) throw new Error(errorText('mail.errors.disabled'))
    if (input.replyToId) {
      const original = this.requireMessage(input.replyToId)
      const account = this.accountOf(original.accountId)
      return this.deps.drafts.create({
        accountId: account.id,
        to: [],
        cc: [],
        subject: '',
        body: input.body,
        reply: { id: original.id, subject: original.subject, from: original.from, replyAll: input.replyAll },
        origin
      })
    }
    const account = this.senderAccount(input.accountId)
    for (const recipient of [...input.to, ...input.cc]) parseAddress(recipient)
    return this.deps.drafts.create({ accountId: account.id, to: input.to, cc: input.cc, subject: input.subject, body: input.body, reply: null, origin })
  }

  draftUpdate(id: string, patch: unknown): MailDraft {
    const draft = this.deps.drafts.update(id, patch)
    for (const recipient of [...draft.to, ...draft.cc]) parseAddress(recipient)
    this.accountOf(draft.accountId)
    return draft
  }

  draftRemove(id: string): void {
    this.deps.drafts.remove(id)
  }

  /** Sends a draft. The user's press is the approval, so no confirmation is shown, and the draft is removed once the send succeeds. */
  async draftSend(id: string, signal: AbortSignal): Promise<MailChangeResult> {
    const draft = this.deps.drafts.require(id)
    signal.throwIfAborted()
    if (!this.deps.settings().enabled) throw new Error(errorText('mail.errors.disabled'))
    const change: MailChange = draft.reply
      ? { operation: 'reply', id: draft.reply.id, body: draft.body, replyAll: draft.reply.replyAll }
      : { operation: 'send', accountId: draft.accountId, to: draft.to, cc: draft.cc, subject: draft.subject, body: draft.body }
    if (!draft.body.trim()) throw new Error(errorText('mail.errors.draft.emptyBody'))
    const plan = await this.plan(change)
    signal.throwIfAborted()
    const result = await plan.perform()
    this.deps.drafts.remove(id)
    return result
  }

  /**
   * Settles what the operation will do before it runs, and returns the text for the confirmation dialog
   * together with the function that performs it. Nothing here changes state on the server, so a plan the
   * user rejects leaves no trace.
   */
  private async plan(input: MailChange): Promise<{ detail: string; perform: () => Promise<MailChangeResult> }> {
    if (input.operation === 'send') {
      const account = this.senderAccount(input.accountId)
      const to = input.to.map(parseAddress)
      const cc = input.cc.map(parseAddress)
      if (!to.length) throw new Error(errorText('mail.errors.form.recipientRequired'))
      const detail = [
        t('mail.confirm.send', { label: account.label, email: account.email }),
        t('mail.confirm.to', { addresses: to.map(formatAddress).join(', ') }),
        cc.length ? t('mail.confirm.cc', { addresses: cc.map(formatAddress).join(', ') }) : '',
        t('mail.confirm.subject', { subject: input.subject || t('mail.noSubject') }),
        t('mail.confirm.body', { body: clip(input.body) })
      ]
        .filter(Boolean)
        .join('\n\n')
      return {
        detail,
        perform: () => this.send(account, { from: { name: account.name, address: account.email }, to, cc, subject: input.subject, text: input.body }, null)
      }
    }
    if (input.operation === 'reply') {
      const message = this.requireMessage(input.id)
      const account = this.accountOf(message.accountId)
      const original = await this.requireSync(account.id).fetchBody(message.folder, message.uid)
      const { to, cc } = replyRecipients(message, account.email, input.replyAll)
      const subject = replySubject(message.subject)
      const text = quotedBody(input.body, { date: message.date, from: message.from, text: original })
      const detail = [
        t('mail.confirm.reply', { label: account.label, email: account.email, ...describe(message) }),
        t('mail.confirm.to', { addresses: to.map(formatAddress).join(', ') }),
        cc.length ? t('mail.confirm.cc', { addresses: cc.map(formatAddress).join(', ') }) : '',
        t('mail.confirm.subject', { subject }),
        t('mail.confirm.bodyQuoted', { body: clip(input.body) })
      ]
        .filter(Boolean)
        .join('\n\n')
      return {
        detail,
        perform: () =>
          this.send(
            account,
            { from: { name: account.name, address: account.email }, to, cc, subject, text, inReplyTo: message.messageId || undefined, references: message.messageId ? [message.messageId] : [] },
            message
          )
      }
    }
    if (input.operation === 'markRead') return this.planMarkRead(input.ids, input.read)
    const message = this.requireMessage(input.id)
    const account = this.accountOf(message.accountId)
    const sync = this.requireSync(account.id)
    const head = { label: account.label, ...describe(message) }
    const path = folderPath(account, message.folder)
    if (input.operation === 'archive') {
      if (message.folder !== 'inbox') throw new Error(errorText('mail.errors.change.notInInbox'))
      const destination = account.folders.archive
      if (!destination) throw new Error(errorText('mail.errors.folder.archiveMissing'))
      return {
        detail: t('mail.confirm.archive', { ...head, folder: destination }),
        perform: async () => {
          await sync.run(async (client) => {
            const lock = await client.getMailboxLock(path)
            try {
              if (!(await client.messageMove(message.uid, destination, { uid: true }))) throw new Error(REJECTED)
            } finally {
              lock.release()
            }
          })
          this.deps.cache.remove(message.id)
          this.afterChange(account.id)
          return { saved: true, operation: input.operation, id: message.id, summary: t('mail.result.archive', { subject: head.subject }) }
        }
      }
    }
    if (input.operation === 'trash') {
      const destination = account.folders.trash
      if (!destination) throw new Error(errorText('mail.errors.folder.trashMissing'))
      return {
        detail: t('mail.confirm.trash', { ...head, folder: destination }),
        perform: async () => {
          await sync.run(async (client) => {
            const lock = await client.getMailboxLock(path)
            try {
              if (!(await client.messageMove(message.uid, destination, { uid: true }))) throw new Error(REJECTED)
            } finally {
              lock.release()
            }
          })
          this.deps.cache.remove(message.id)
          this.afterChange(account.id)
          return { saved: true, operation: input.operation, id: message.id, summary: t('mail.result.trash', { subject: head.subject }) }
        }
      }
    }
    return {
      detail: t(input.starred ? 'mail.confirm.star' : 'mail.confirm.unstar', head),
      perform: async () => {
        await sync.run((client) => storeFlag(client, path, [message.uid], '\\Flagged', input.starred))
        this.deps.cache.setFlags(message.id, { starred: input.starred })
        this.afterChange(account.id)
        return {
          saved: true,
          operation: input.operation,
          id: message.id,
          summary: t(input.starred ? 'mail.result.star' : 'mail.result.unstar', { subject: head.subject })
        }
      }
    }
  }

  /**
   * Marking read or unread. It takes several ids and changes the ones that share an account and a folder
   * in a single STORE. The confirmation names the subject for a single message and the counts otherwise.
   */
  private planMarkRead(ids: readonly string[], read: boolean): { detail: string; perform: () => Promise<MailChangeResult> } {
    const messages = [...new Set(ids)].map((id) => this.requireMessage(id))
    const groups = new Map<string, { account: MailAccount; sync: MailAccountSync; path: string; messages: MailMessage[] }>()
    for (const message of messages) {
      const key = `${message.accountId}:${message.folder}`
      let group = groups.get(key)
      if (!group) {
        const account = this.accountOf(message.accountId)
        group = { account, sync: this.requireSync(account.id), path: folderPath(account, message.folder), messages: [] }
        groups.set(key, group)
      }
      group.messages.push(message)
    }
    const single = messages.length === 1 ? messages[0] : null
    const detail = single
      ? t(read ? 'mail.confirm.markRead' : 'mail.confirm.markUnread', { label: this.accountOf(single.accountId).label, ...describe(single) })
      : [
          t(read ? 'mail.confirm.markReadMany' : 'mail.confirm.markUnreadMany'),
          ...[...groups.values()].map((group) =>
            t('mail.confirm.group', { label: group.account.label, box: t(`mail.boxes.${group.messages[0].folder}`), count: group.messages.length })
          )
        ].join('\n')
    return {
      detail,
      perform: async () => {
        for (const group of groups.values()) {
          await group.sync.run((client) => storeFlag(client, group.path, group.messages.map((message) => message.uid), '\\Seen', read))
          for (const message of group.messages) this.deps.cache.setFlags(message.id, { unread: !read })
          this.afterChange(group.account.id)
        }
        return {
          saved: true,
          operation: 'markRead',
          id: messages[0].id,
          summary: single
            ? t(read ? 'mail.result.markRead' : 'mail.result.markUnread', { subject: single.subject || t('mail.noSubject') })
            : t(read ? 'mail.result.markReadCount' : 'mail.result.markUnreadCount', { count: messages.length })
        }
      }
    }
  }

  private requireMessage(id: string): MailMessage {
    parseMessageId(id)
    const message = this.deps.cache.get(id)
    if (!message) throw new Error(errorText('mail.errors.message.notFound'))
    return message
  }

  private afterChange(accountId: string): void {
    this.deps.emit({ type: 'changed', accountId })
    this.emitStatus()
  }

  /**
   * Sends. Once the message has been handed to SMTP it is never sent again, even when the outcome is
   * unknown. Outside Gmail the same bytes are appended to the Sent folder, and a reply also puts the
   * \Answered flag on the message it answers.
   */
  private async send(account: MailAccount, outgoing: Parameters<SmtpSender['send']>[2], original: MailMessage | null): Promise<MailChangeResult> {
    const password = this.passwordOf(account.id)
    let sent: { messageId: string; raw: Buffer }
    try {
      sent = await this.deps.smtp.send(account, password, outgoing)
    } catch (error) {
      const reason = errorMessage(error)
      if (failedBeforeSending(error)) throw new Error(errorText(original ? 'mail.errors.send.replyFailed' : 'mail.errors.send.sendFailed', { reason }))
      throw new Error(errorText(original ? 'mail.errors.send.replyUnknown' : 'mail.errors.send.sendUnknown', { reason }))
    }
    const notes: string[] = []
    const sync = this.syncs.get(account.id)
    if (sync && account.provider !== 'gmail' && account.folders.sent) {
      const sentFolder = account.folders.sent
      try {
        await sync.run((client) => client.append(sentFolder, sent.raw, ['\\Seen'], new Date(this.now())))
      } catch (error) {
        notes.push(t('mail.result.sentFolderFailed', { reason: errorMessage(error) }))
      }
    }
    if (sync && original) {
      try {
        await sync.run(async (client) => {
          const lock = await client.getMailboxLock(folderPath(account, original.folder))
          try {
            await client.messageFlagsAdd(original.uid, ['\\Answered'], { uid: true })
          } finally {
            lock.release()
          }
        })
        this.deps.cache.setFlags(original.id, { answered: true })
      } catch (error) {
        notes.push(t('mail.result.answeredFailed', { reason: errorMessage(error) }))
      }
    }
    if (sync) void sync.syncNow().catch(() => undefined)
    this.afterChange(account.id)
    const recipients = outgoing.to.map(displayName).join(', ')
    return {
      saved: true,
      operation: original ? 'reply' : 'send',
      id: sent.messageId,
      summary: [t(original ? 'mail.result.reply' : 'mail.result.send', { recipients }), ...notes].join('\n')
    }
  }
}

/** The values that name a message in the confirmation: its subject, its sender and when it was sent. */
const describe = (message: MailMessage): { subject: string; name: string; date: string } => ({
  subject: message.subject || t('mail.noSubject'),
  name: displayName(message.from),
  date: stamp(message.date)
})

/**
 * What the Agent's send or reply returns to the model instead of sending. It is read by the model, never
 * shown on a screen, so it is written in the language of the conversation and tells the model that the
 * user's press on the card is what sends the mail.
 */
const draftSummary = (draft: MailDraft): string => {
  const language = promptLanguage(conversationLocale())
  const noSubject = { ja: '(件名なし)', en: '(no subject)' }[language]
  return draft.reply
    ? {
        ja: `「${draft.reply.subject || noSubject}」(${displayName(draft.reply.from)})への返信を下書きにしました。ユーザーがカードの「送信」を押すと送ります`,
        en: `Drafted a reply to "${draft.reply.subject || noSubject}" from ${displayName(draft.reply.from)}. It is sent when the user presses send on the card.`
      }[language]
    : {
        ja: `${draft.to.join(', ')} 宛「${draft.subject || noSubject}」を下書きにしました。ユーザーがカードの「送信」を押すと送ります`,
        en: `Drafted "${draft.subject || noSubject}" to ${draft.to.join(', ')}. It is sent when the user presses send on the card.`
      }[language]
}

/**
 * Adds or removes a flag. imapflow returns false instead of throwing when the flag is not permitted or
 * no mailbox is selected, so the false is turned into an error rather than passing silently.
 */
async function storeFlag(client: ImapClient, path: string, uids: number[], flag: string, add: boolean): Promise<void> {
  const lock = await client.getMailboxLock(path)
  try {
    const ok = add ? await client.messageFlagsAdd(uids, [flag], { uid: true }) : await client.messageFlagsRemove(uids, [flag], { uid: true })
    if (!ok) throw new Error(REJECTED)
  } finally {
    lock.release()
  }
}

function folderPath(account: MailAccount, folder: MailMessage['folder']): string {
  if (folder === 'inbox') return 'INBOX'
  const path = account.folders[folder]
  if (!path) throw new Error(errorText('mail.errors.folder.notSet', { folder: t(`mail.boxes.${folder}`) }))
  return path
}

const clip = (text: string): string =>
  text.length > CONFIRM_BODY_MAX
    ? `${text.slice(0, CONFIRM_BODY_MAX)}\n${t('mail.confirm.clipped', { count: text.length - CONFIRM_BODY_MAX })}`
    : text
const stamp = (date: number): string => new Intl.DateTimeFormat(formatLocaleOf(getSettings().uiLocale, getSettings().region), { dateStyle: 'medium', timeStyle: 'short' }).format(date)

export type { MailAddress }
