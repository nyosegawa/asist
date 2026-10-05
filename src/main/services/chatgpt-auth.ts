import { createPublicKey, randomUUID, verify, type JsonWebKeyInput } from 'node:crypto'
import { z } from 'zod'
import { CHATGPT_SIGN_IN, type ChatGptSignInResult, type ChatGptStatus } from '@shared/chatgpt'
import { errorText } from '@shared/i18n/error-text'
import { SecretUnreadableError, type EncryptedSecretStore } from './encrypted-secrets'
import { fetchFailure } from './fetch-failure'
import { openLoopback, pkcePair, randomToken, SignInReplaced } from './oauth-loopback'

/**
 * Signing in with ChatGPT so that requests run on the user's ChatGPT plan, as OpenAI describes it for
 * open-source apps that run on the user's computer (developers.openai.com/siwc/token-sharing-open-source).
 * The first sign-in on a computer registers ASIST as an app of that account, which hands back a client ID of
 * its own; later sign-ins to the same account reuse it, so signing out and in again does not add another app
 * to the account. The refresh token, which lasts 30 days and is replaced at every refresh, is kept encrypted
 * on this computer, and the access token, which lasts an hour, only in memory.
 */

/** A public key of OpenAI's, as its JWKS lists it. */
type SigningKey = JsonWebKeyInput['key'] & { kid?: string }

const ISSUER = 'https://auth.openai.com'
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`
export const CHATGPT_TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`
export const CHATGPT_REVOKE_URL = `${ISSUER}/api/accounts/oauth/revoke`
export const CHATGPT_JWKS_URL = `${ISSUER}/.well-known/jwks.json`
/** The API the access token is issued for, which OpenAI asks for both when signing in and when refreshing. */
const RESOURCE = 'https://api.openai.com/v1'
/** The client ID that asks for a new registration; it is never saved or used to exchange a code. */
const NEW_REGISTRATION = 'dynamic_agent_client'
/** The name the registration starts with in the account's list of apps. The user may change it on the consent page. */
const AGENT_NAME = 'ASIST'
/** The scope that lets requests run on the plan. A sign-in without it is of no use to ASIST. */
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct'
const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', PLAN_SCOPE]
/** OpenAI accepts only this path, on any port; `/callback` or `localhost` do not match. */
const CALLBACK_PATH = '/auth/callback'

const SIGN_IN_TIMEOUT_MS = 5 * 60_000
/** An access token this close to its expiry is renewed before a request rather than risk a 401 in the middle of one. */
const EXPIRY_MARGIN_MS = 60_000
/** The waits before each retry of a revocation that failed on the network or the server. */
const REVOKE_RETRY_MS = [500, 1500]

/**
 * What the file keeps. `hostId` names this computer to OpenAI and stays for good. The registration
 * (`clientId`, `subject`, `account`) stays after a sign-out, for the next sign-in to the same account. The
 * session (`refreshToken`, `idToken`) is what a sign-out removes.
 */
export type ChatGptSecretId = 'hostId' | 'clientId' | 'subject' | 'account' | 'refreshToken' | 'idToken'

export interface ChatGptAuthDependencies {
  store: EncryptedSecretStore<ChatGptSecretId>
  fetch: typeof fetch
  openBrowser: (url: string) => Promise<void>
  /** The HTML the browser shows once it comes back, which tells whether the sign-in went through. */
  page: (signedIn: boolean) => string
  now?: () => number
  signInTimeoutMs?: number
}

/** No usable sign-in: none was made, or OpenAI no longer accepts the one that was saved. */
export class ChatGptSignedOut extends Error {
  readonly code = CHATGPT_SIGN_IN
  constructor(key: 'chatgpt.errors.signedOut' | 'chatgpt.errors.sessionEnded' = 'chatgpt.errors.signedOut') {
    super(errorText(key))
  }
}

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
  scope: z.string().optional()
})
type TokenResponse = z.infer<typeof tokenSchema>

const idClaimsSchema = z.object({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  sub: z.string().min(1),
  nonce: z.string().optional(),
  email: z.string().optional()
})
type IdClaims = z.infer<typeof idClaimsSchema>

/** The refresh errors after which only a new sign-in helps. */
const SESSION_ENDED = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'])

const failed = (): Error => new Error(errorText('chatgpt.errors.signInFailed'))

interface Registration {
  clientId: string
  subject: string
  account: string | null
}

export class ChatGptAuth {
  private access: { token: string; expiresAt: number } | null = null
  private refreshing: Promise<string | null> | null = null
  private signingIn: AbortController | null = null
  private keys: SigningKey[] | null = null
  /**
   * The number of the session the store holds, raised whenever a sign-in replaces it or a sign-out ends it. A
   * refresh that waited on the network writes nothing once the session it renewed is gone, so it cannot bring
   * back a session signed out meanwhile or overwrite the one a newer sign-in saved.
   */
  private session = 0
  /**
   * A registration whose sign-in left the plan's permission out. It stays in memory only, so the session signed
   * in before, which may be another account's, stays whole; the next sign-in returns to it asking for consent.
   */
  private declined: Registration | null = null
  constructor(private readonly deps: ChatGptAuthDependencies) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** Whether a sign-in is saved. `unreadable` is one another build encrypted, which only a new sign-in or a sign-out replaces. */
  status(): ChatGptStatus {
    try {
      const signedIn = this.deps.store.get('refreshToken') !== null
      return { signIn: signedIn ? 'signedIn' : 'signedOut', account: this.deps.store.get('account') }
    } catch (error) {
      if (error instanceof SecretUnreadableError) return { signIn: 'unreadable', account: null }
      throw error
    }
  }

  /**
   * What tells one sign-in from another without holding its tokens, which change every hour: the registration
   * and the account. Null when signed out. A saved sign-in that cannot be decrypted throws SecretUnreadableError.
   */
  identity(): string | null {
    const { store } = this.deps
    if (store.get('refreshToken') === null) return null
    return `${store.get('clientId')}:${store.get('subject')}`
  }

  /** A valid access token, renewed with the saved refresh token when the one in memory is about to expire. */
  async accessToken(): Promise<string> {
    for (;;) {
      if (this.access && this.access.expiresAt - EXPIRY_MARGIN_MS > this.now()) return this.access.token
      // One refresh at a time: the refresh token is replaced at every refresh, and a second request with the
      // old one is refused as reused.
      this.refreshing ??= this.refresh(this.session).finally(() => {
        this.refreshing = null
      })
      const token = await this.refreshing
      // A refresh whose session ended or was replaced while it waited gives nothing; the next pass reads the current one.
      if (token !== null) return token
    }
  }

  /** Drops an access token OpenAI refused, so that the next request renews it. */
  forgetAccessToken(token: string): void {
    if (this.access?.token === token) this.access = null
  }

  /** Renews the access token of session number `session`, or gives null once that session is no longer the one saved. */
  private async refresh(session: number): Promise<string | null> {
    const { store } = this.deps
    const refreshToken = store.get('refreshToken')
    const clientId = store.get('clientId')
    if (refreshToken === null || clientId === null) throw new ChatGptSignedOut()
    const response = await this.post(CHATGPT_TOKEN_URL, { grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken, resource: RESOURCE })
    if (session !== this.session) return null
    if (!response.ok) {
      const code = await openAiError(response, 'refresh')
      if (session !== this.session) return null
      if (code !== null && SESSION_ENDED.has(code)) {
        this.endSession()
        throw new ChatGptSignedOut('chatgpt.errors.sessionEnded')
      }
      // A registration OpenAI no longer knows cannot be signed in to again, so the next sign-in registers anew.
      if (code === 'invalid_client') {
        this.endSession()
        for (const id of ['clientId', 'subject', 'account'] as const) store.remove(id)
        throw new ChatGptSignedOut('chatgpt.errors.sessionEnded')
      }
      throw new Error(errorText('chatgpt.errors.requestFailed', { status: response.status }))
    }
    const token = await tokenOf(response)
    if (session !== this.session) return null
    if (token.refresh_token) store.set('refreshToken', token.refresh_token)
    if (token.id_token) store.set('idToken', token.id_token)
    this.access = { token: token.access_token, expiresAt: this.now() + token.expires_in * 1000 }
    return token.access_token
  }

  /**
   * Signs in through the browser and saves the session. It returns to the account signed in last unless
   * `otherAccount` asks for a new registration. A sign-in started while another waits takes its place, since
   * the browser tab of the first may have been closed; the first then fails with SignInReplaced.
   */
  async signIn(otherAccount: boolean): Promise<ChatGptSignInResult> {
    this.signingIn?.abort(new SignInReplaced())
    const controller = new AbortController()
    this.signingIn = controller
    const registration = otherAccount ? null : (this.declined ?? this.registration())
    const hostId = this.hostId()
    const { verifier, challenge } = pkcePair()
    const state = randomToken()
    const nonce = randomToken()
    const loopback = await openLoopback({
      path: CALLBACK_PATH,
      state,
      page: this.deps.page,
      signal: controller.signal,
      timeoutMs: this.deps.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS,
      errors: {
        failed,
        denied: () => new Error(errorText('chatgpt.errors.signInDenied')),
        timedOut: (minutes) => new Error(errorText('chatgpt.errors.signInTimedOut', { minutes }))
      }
    })
    try {
      const query: Record<string, string> = {
        client_id: registration?.clientId ?? NEW_REGISTRATION,
        ext_agent_host_id: hostId,
        response_type: 'code',
        redirect_uri: loopback.uri,
        scope: SCOPES.join(' '),
        resource: RESOURCE,
        state,
        nonce,
        code_challenge_method: 'S256',
        code_challenge: challenge
      }
      if (registration === null) query.agent_name_hint = AGENT_NAME
      else if (registration.account) query.login_hint = registration.account
      if (registration !== null && registration === this.declined) query.prompt = 'consent'
      const url = new URL(AUTHORIZE_URL)
      url.search = new URLSearchParams(query).toString()
      controller.signal.throwIfAborted()
      await this.deps.openBrowser(url.href)
      const { code, params, answer } = await loopback.arrival
      try {
        // A new registration comes back with the client ID it issued. A returning sign-in may leave it out,
        // but one that names another client belongs to some other registration.
        const issued = params.get('client_id')
        const clientId = registration ? registration.clientId : issued
        if (!clientId || clientId === NEW_REGISTRATION || (registration && issued !== null && issued !== registration.clientId)) throw failed()
        const first = await this.exchange({ code, verifier, redirectUri: loopback.uri, clientId, nonce, registration, controller })
        answer(true)
        return { status: this.status(), first }
      } catch (error) {
        answer(false)
        throw error
      }
    } finally {
      loopback.close()
      if (this.signingIn === controller) this.signingIn = null
    }
  }

  /**
   * Trades the code for tokens and checks them before anything is saved: the ID token's signature and claims,
   * the same account as the registration it returned to, and the plan's permission. The requests are not
   * aborted halfway, since OpenAI may already have granted the tokens; a sign-in stopped meanwhile saves
   * nothing and revokes what it was given. It resolves to whether this is the account's first sign-in on this
   * computer, after which OpenAI asks apps to say once that the plan is in use.
   */
  private async exchange(attempt: {
    code: string
    verifier: string
    redirectUri: string
    clientId: string
    nonce: string
    registration: Registration | null
    controller: AbortController
  }): Promise<boolean> {
    const { clientId, registration, controller } = attempt
    const response = await this.post(CHATGPT_TOKEN_URL, {
      grant_type: 'authorization_code',
      client_id: clientId,
      code: attempt.code,
      code_verifier: attempt.verifier,
      redirect_uri: attempt.redirectUri,
      resource: RESOURCE
    })
    if (!response.ok) {
      await openAiError(response, 'code exchange')
      throw failed()
    }
    const token = await tokenOf(response)
    if (!token.refresh_token || !token.id_token) throw failed()
    const refused = async (error: Error): Promise<never> => {
      await this.revoke(token.refresh_token as string, clientId).catch((cause: unknown) => console.warn('ChatGPT: a refused sign-in could not be revoked:', cause))
      throw error
    }
    const claims = await this.verifiedIdToken(token.id_token, clientId, attempt.nonce)
    // Nothing is awaited from here until the store is written, so a sign-out or a newer sign-in that came while
    // the requests above waited is seen here and never overwritten.
    if (controller.signal.aborted) return refused(controller.signal.reason as Error)
    if (registration && claims.sub !== registration.subject) return refused(new Error(errorText('chatgpt.errors.accountMismatch')))
    const signedIn: Registration = { clientId, subject: claims.sub, account: claims.email ?? null }
    if (!(token.scope ?? '').split(' ').includes(PLAN_SCOPE)) {
      this.declined = signedIn
      return refused(new Error(errorText('chatgpt.errors.planNotGranted')))
    }
    const { store } = this.deps
    const before = this.registration()
    const previous = { refreshToken: this.readable('refreshToken'), clientId: this.readable('clientId'), subject: this.readable('subject') }
    this.declined = null
    this.saveRegistration(signedIn)
    store.set('refreshToken', token.refresh_token)
    store.set('idToken', token.id_token)
    this.session++
    this.access = { token: token.access_token, expiresAt: this.now() + token.expires_in * 1000 }
    // Only one account is signed in at a time, so the session of the account left behind ends at OpenAI too
    // instead of staying valid for the rest of its 30 days.
    if (previous.refreshToken !== null && previous.clientId !== null && (previous.clientId !== clientId || previous.subject !== claims.sub)) {
      await this.revoke(previous.refreshToken, previous.clientId).catch((cause: unknown) => console.warn('ChatGPT: the session of the previous account could not be revoked:', cause))
    }
    return before === null || before.subject !== claims.sub
  }

  /**
   * Ends the session at OpenAI and forgets its tokens here, keeping the registration for the next sign-in. A
   * revocation OpenAI does not confirm still signs out here, and the error says that the app can be
   * disconnected in ChatGPT's settings, which is the only other way to end it.
   */
  async signOut(): Promise<ChatGptStatus> {
    this.signingIn?.abort(new SignInReplaced())
    this.declined = null
    const { store } = this.deps
    let refreshToken: string | null
    let clientId: string | null
    try {
      refreshToken = store.get('refreshToken')
      clientId = store.get('clientId')
    } catch (error) {
      if (!(error instanceof SecretUnreadableError)) throw error
      this.endSession()
      throw new Error(errorText('chatgpt.errors.revokeUnconfirmed'), { cause: error })
    }
    // The session ends for requests at once; a refresh still waiting writes nothing back, and a sign-in that
    // completes during the revocation below keeps the session it saved.
    const ending = ++this.session
    this.access = null
    const end = (): void => {
      if (this.session === ending) this.endSession()
    }
    if (refreshToken !== null && clientId !== null) {
      try {
        await this.revoke(refreshToken, clientId)
      } catch (error) {
        end()
        throw new Error(errorText('chatgpt.errors.revokeUnconfirmed'), { cause: error })
      }
    }
    end()
    return this.status()
  }

  private async revoke(refreshToken: string, clientId: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      let response: Response | null = null
      try {
        response = await this.post(CHATGPT_REVOKE_URL, { token: refreshToken, token_type_hint: 'refresh_token', client_id: clientId })
      } catch (error) {
        if (attempt >= REVOKE_RETRY_MS.length) throw error
      }
      // OpenAI answers an empty 200 for a token it revoked and for one that was invalid already.
      if (response?.ok) return
      if (response && response.status < 500) throw new Error(errorText('chatgpt.errors.requestFailed', { status: response.status }))
      if (attempt >= REVOKE_RETRY_MS.length) throw new Error(errorText('chatgpt.errors.requestFailed', { status: response?.status ?? 0 }))
      await new Promise((resolve) => setTimeout(resolve, REVOKE_RETRY_MS[attempt]))
    }
  }

  /**
   * A secret, or null when it is missing or another build encrypted it. A sign-in replaces what it cannot read
   * rather than fail on it, which is how such a file is mended.
   */
  private readable(id: ChatGptSecretId): string | null {
    try {
      return this.deps.store.get(id)
    } catch (error) {
      if (error instanceof SecretUnreadableError) return null
      throw error
    }
  }

  private registration(): Registration | null {
    const clientId = this.readable('clientId')
    const subject = this.readable('subject')
    return clientId && subject ? { clientId, subject, account: this.readable('account') } : null
  }

  private saveRegistration(registration: Registration): void {
    const { store } = this.deps
    store.set('clientId', registration.clientId)
    store.set('subject', registration.subject)
    if (registration.account) store.set('account', registration.account)
    else store.remove('account')
  }

  /** The identifier OpenAI keeps this computer's use under. It is opaque, made once, and kept through sign-outs. */
  private hostId(): string {
    const saved = this.readable('hostId')
    if (saved) return saved
    const created = `urn:uuid:${randomUUID()}`
    this.deps.store.set('hostId', created)
    return created
  }

  private endSession(): void {
    this.deps.store.remove('refreshToken')
    this.deps.store.remove('idToken')
    this.access = null
    this.session++
  }

  /** Checks the ID token's RS256 signature against OpenAI's published keys, then its issuer, audience, expiry and nonce. */
  private async verifiedIdToken(idToken: string, clientId: string, nonce: string): Promise<IdClaims> {
    const [header64, payload64, signature64] = idToken.split('.')
    if (!header64 || !payload64 || !signature64) throw failed()
    const header = decodeSegment(header64) as { alg?: unknown; kid?: unknown }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw failed()
    const jwk = await this.signingKey(header.kid)
    const signed = verify('RSA-SHA256', Buffer.from(`${header64}.${payload64}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(signature64, 'base64url'))
    if (!signed) throw failed()
    const claims = idClaimsSchema.safeParse(decodeSegment(payload64))
    if (!claims.success) throw failed()
    const audience = Array.isArray(claims.data.aud) ? claims.data.aud : [claims.data.aud]
    if (claims.data.iss !== ISSUER || !audience.includes(clientId) || claims.data.exp * 1000 <= this.now() || claims.data.nonce !== nonce) throw failed()
    return claims.data
  }

  /** OpenAI's key of that id. The keys are fetched again once for an id not among those held, since OpenAI rotates them. */
  private async signingKey(kid: string): Promise<SigningKey> {
    const held = this.keys?.find((key) => key.kid === kid)
    if (held) return held
    const response = await this.request(CHATGPT_JWKS_URL, {})
    if (!response.ok) throw new Error(errorText('chatgpt.errors.requestFailed', { status: response.status }))
    const body = (await response.json().catch(() => null)) as { keys?: unknown } | null
    if (!Array.isArray(body?.keys)) throw new Error(errorText('chatgpt.errors.badResponse'))
    this.keys = body.keys as SigningKey[]
    const key = this.keys.find((candidate) => candidate.kid === kid)
    if (!key) throw failed()
    return key
  }

  private post(url: string, form: Record<string, string>): Promise<Response> {
    return this.request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) })
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.deps.fetch(url, init)
    } catch (error) {
      throw fetchFailure(url, error)
    }
  }
}

function decodeSegment(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
  } catch {
    throw failed()
  }
}

/** The error code of a failed token request, which is also logged. The body never carries a token. */
async function openAiError(response: Response, request: string): Promise<string | null> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null
  const error = body?.error
  // OAuth errors name the code in `error`; OpenAI's API errors nest it as `error.code`.
  const code = typeof error === 'string' ? error : typeof (error as { code?: unknown } | undefined)?.code === 'string' ? (error as { code: string }).code : null
  console.warn(`ChatGPT token ${request} failed: HTTP ${response.status} ${code ?? '(no error code)'}`)
  return code
}

async function tokenOf(response: Response): Promise<TokenResponse> {
  const token = tokenSchema.safeParse(await response.json().catch(() => null))
  if (!token.success) throw new Error(errorText('chatgpt.errors.badResponse'), { cause: token.error })
  return token.data
}
