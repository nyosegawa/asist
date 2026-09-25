import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createImapClient } from '../src/main/services/mail-imap'

/**
 * A server on a plain port that does not offer STARTTLS, which is what a client sees when someone on the
 * network strips the offer from the greeting. It answers every command and records what it was sent.
 */
function plainServer(): Promise<{ port: number; received: string[]; close: () => void }> {
  const received: string[] = []
  const server = net.createServer((socket) => {
    socket.write('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] ready\r\n')
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      let end
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        received.push(line)
        socket.write(`${line.split(' ')[0]} OK done\r\n`)
      }
    })
    socket.on('error', () => undefined)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo
      resolve({ port, received, close: () => server.close() })
    })
  })
}

describe('createImapClient on a plain port', () => {
  let close = (): void => undefined
  afterEach(() => close())

  it('refuses to log in when the server does not offer STARTTLS, so the password never travels in clear text', async () => {
    const server = await plainServer()
    close = server.close
    const endpoint = { host: '127.0.0.1', port: server.port, secure: false }
    const client = createImapClient({ email: 'me@example.com', imap: endpoint }, 'secret-password')
    await expect(client.connect()).rejects.toThrow()
    expect(server.received.join('\n')).not.toContain('secret-password')
    expect(server.received.some((line) => /\b(LOGIN|AUTHENTICATE)\b/i.test(line))).toBe(false)
  })
})
