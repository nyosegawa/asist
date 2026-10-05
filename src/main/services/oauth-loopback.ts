import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * The server on 127.0.0.1 that the system browser comes back to after signing in as an installed app (RFC
 * 8252), and the PKCE (RFC 7636) values that go with it. Google and ChatGPT both sign in this way; each says
 * where the browser returns and words the failures itself.
 */

export const base64url = (bytes: Buffer): string => bytes.toString('base64url')

/** A code verifier of 43 characters and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) }
}

/** The reason a sign-in stops when a newer one or a sign-out takes its place. */
export class SignInReplaced extends Error {}

/** A fresh random value for `state` or `nonce`. */
export const randomToken = (): string => base64url(randomBytes(16))

export interface LoopbackErrors {
  /** The answer was not one this sign-in waits for: another state, an error other than a refusal, or no code. */
  failed: () => Error
  /** The user declined on the provider's page. */
  denied: () => Error
  timedOut: (minutes: number) => Error
}

export interface LoopbackOptions {
  /** Where the browser comes back, which the provider compares with the registered redirect exactly. */
  path: string
  state: string
  /** The HTML the browser shows once it comes back, which tells whether the sign-in went through. */
  page: (signedIn: boolean) => string
  signal: AbortSignal
  timeoutMs: number
  errors: LoopbackErrors
}

export interface Arrival {
  code: string
  /** Everything the provider put on the address, such as ChatGPT's issued client ID. */
  params: URLSearchParams
  answer: (signedIn: boolean) => void
}

export interface Loopback {
  uri: string
  arrival: Promise<Arrival>
  close: () => void
}

/**
 * Opens the server. It takes one answer on its path: a code that carries the state this sign-in sent, or the
 * provider's error. A request with another state is refused and ends the sign-in, since only a page other
 * than the provider's could have sent it.
 */
export async function openLoopback(options: LoopbackOptions): Promise<Loopback> {
  const { path, state, page, signal, timeoutMs, errors } = options
  let settled = false
  let settle!: { resolve: (arrival: Arrival) => void; reject: (error: unknown) => void }
  const arrival = new Promise<Arrival>((resolve, reject) => {
    settle = {
      resolve: (value) => {
        settled = true
        resolve(value)
      },
      reject: (error) => {
        settled = true
        reject(error)
      }
    }
  })
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== path || settled) {
      response.writeHead(404, { connection: 'close' }).end()
      return
    }
    const answer = (signedIn: boolean): void => {
      response.writeHead(signedIn ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', connection: 'close' }).end(page(signedIn))
    }
    const params = url.searchParams
    const code = params.get('code')
    const failure =
      params.get('state') !== state ? errors.failed : params.get('error') === 'access_denied' ? errors.denied : params.get('error') || !code ? errors.failed : null
    if (failure || !code) {
      answer(false)
      settle.reject((failure ?? errors.failed)())
      return
    }
    settle.resolve({ code, params, answer })
  })
  // A sign-in that fails before anyone waits for the browser, as when the browser does not open, would
  // otherwise leave this rejection unhandled; whoever awaits the arrival still sees it.
  arrival.catch(() => undefined)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const timer = setTimeout(() => settle.reject(errors.timedOut(Math.round(timeoutMs / 60_000))), timeoutMs)
  const abort = (): void => settle.reject(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  // A sign-out or a newer sign-in may have come while the server was starting to listen.
  if (signal.aborted) abort()
  const port = (server.address() as AddressInfo).port
  return {
    uri: `http://127.0.0.1:${port}${path === '/' ? '' : path}`,
    arrival,
    close: () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      server.close()
      server.closeIdleConnections()
    }
  }
}
