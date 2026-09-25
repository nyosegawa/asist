import { randomUUID } from 'node:crypto'
import nodemailer from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer'
import { formatAddress, type MailAccount, type MailAddress } from '@shared/mail'

/**
 * Sending over SMTP. The message is composed once and the raw bytes are both sent and returned, because
 * outside Gmail the server does not put a sent message in the Sent folder, so the caller has to append
 * exactly those bytes itself.
 */

export interface OutgoingMail {
  from: MailAddress
  to: MailAddress[]
  cc: MailAddress[]
  subject: string
  text: string
  inReplyTo?: string
  references?: string[]
}

export interface SmtpSender {
  send(account: MailAccount, password: string, message: OutgoingMail): Promise<{ messageId: string; raw: Buffer }>
}

const CONNECTION_TIMEOUT_MS = 20_000

export const smtpSender: SmtpSender = {
  async send(account, password, message) {
    const domain = account.email.split('@')[1] || 'asist.local'
    const messageId = `<${randomUUID()}@${domain}>`
    const composer = new MailComposer({
      from: formatAddress(message.from),
      to: message.to.map(formatAddress),
      cc: message.cc.length ? message.cc.map(formatAddress) : undefined,
      subject: message.subject,
      text: message.text,
      messageId,
      inReplyTo: message.inReplyTo,
      references: message.references?.length ? message.references : undefined,
      date: new Date()
    })
    const raw = await composer.compile().build()
    const transport = nodemailer.createTransport({
      host: account.smtp.host,
      port: account.smtp.port,
      secure: account.smtp.secure,
      requireTLS: !account.smtp.secure,
      auth: { user: account.email, pass: password },
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      greetingTimeout: CONNECTION_TIMEOUT_MS
    })
    try {
      await transport.sendMail({
        envelope: { from: account.email, to: [...message.to, ...message.cc].map((address) => address.address) },
        raw
      })
    } finally {
      transport.close()
    }
    return { messageId, raw }
  }
}

/**
 * Whether the SMTP failure provably happened before the message went out. For any other failure it is
 * unknown whether the message was delivered.
 */
export function failedBeforeSending(error: unknown): boolean {
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && ['EAUTH', 'ECONNECTION', 'ESOCKET', 'EDNS', 'ETLS', 'EENVELOPE', 'ETIMEDOUT'].includes(code)
}
