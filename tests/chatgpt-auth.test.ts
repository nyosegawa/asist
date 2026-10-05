import { createHash, createSign, generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHATGPT_SIGN_IN } from '../src/shared/chatgpt'
import { errorText } from '../src/shared/i18n/error-text'
import { CHATGPT_JWKS_URL, CHATGPT_REVOKE_URL, CHATGPT_TOKEN_URL, ChatGptAuth, PLAN_SCOPE, type ChatGptSecretId } from '../src/main/services/chatgpt-auth'
import { SecretUnreadableError, type EncryptedSecretStore } from '../src/main/services/encrypted-secrets'

/**
 * Signing in with ChatGPT as OpenAI describes it for open-source apps: a first sign-in registers ASIST and
 * keeps the client ID it is issued, later sign-ins return to it, nothing is saved before the ID token and
 * the plan's permission check out, and a refresh token is replaced at every refresh.
 */

const ISSUER = 'https://auth.openai.com'
const NOW = Date.parse('2026-10-05T12:00:00Z')
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const KID = 'test-key'
const JWKS = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }] }

function idToken(claims: Record<string, unknown>, kid = KID): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey).toString('base64url')
  return `${header}.${payload}.${signature}`
}

/** The secrets file in memory. `unreadable` stands for a file another build encrypted. */
function memoryStore(initial: Partial<Record<ChatGptSecretId, string>> = {}): EncryptedSecretStore<ChatGptSecretId> & { values: Partial<Record<ChatGptSecretId, string>>; unreadable: boolean } {
  const store = {
    values: { ...initial },
    unreadable: false,
    get: (id: ChatGptSecretId) => {
      if (store.unreadable) throw new SecretUnreadableError('unreadable')
      return store.values[id] ?? null
    },
    set: (id: ChatGptSecretId, secret: string) => {
      store.unreadable = false
      store.values[id] = secret
    },
    remove: (id: ChatGptSecretId) => {
      delete store.values[id]
    }
  }
  return store
}

interface Call {
  url: string
  form: URLSearchParams
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** OpenAI's endpoints. `account` is who signs in on the consent page; `scope` what the token response grants. */
function fakeOpenAI(
  options: {
    account?: { sub: string; email: string }
    scope?: string
    refresh?: () => Response
    revoke?: () => Response
    /** Holds the answer to a request until the promise it returns settles. */
    hold?: (url: string, form: URLSearchParams) => Promise<void> | undefined
  } = {}
) {
  const calls: Call[] = []
  let issued = 0
  let nonce = ''
  let clientId = ''
  const account = (): { sub: string; email: string } => options.account ?? { sub: 'user-1', email: 'me@example.com' }
  const fetchMock = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input)
    const form = new URLSearchParams(init.body === undefined ? '' : String(init.body))
    calls.push({ url, form })
    await options.hold?.(url, form)
    if (url === CHATGPT_JWKS_URL) return json(JWKS)
    if (url === CHATGPT_REVOKE_URL) return options.revoke?.() ?? new Response('', { status: 200 })
    if (url === CHATGPT_TOKEN_URL && form.get('grant_type') === 'refresh_token') {
      return options.refresh?.() ?? json({ access_token: `access-${++issued}`, refresh_token: `refresh-${issued}`, expires_in: 3600, scope: options.scope ?? `openid profile email offline_access resource.invoke ${PLAN_SCOPE}` })
    }
    if (url === CHATGPT_TOKEN_URL && form.get('grant_type') === 'authorization_code') {
      issued++
      return json({
        access_token: `access-${issued}`,
        refresh_token: `refresh-${issued}`,
        id_token: idToken({ iss: ISSUER, aud: clientId, exp: NOW / 1000 + 3600, sub: account().sub, email: account().email, nonce }),
        expires_in: 3600,
        scope: options.scope ?? `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`
      })
    }
    throw new Error(`no route for ${url}`)
  })
  /** What the browser does: OpenAI's page, then the redirect to ASIST's loopback with the code and, for a new registration, the client it issued. */
  const browser = (authorize: URL, override: Record<string, string> = {}): string => {
    nonce = authorize.searchParams.get('nonce') ?? ''
    const requested = authorize.searchParams.get('client_id')
    clientId = requested === 'dynamic_agent_client' ? `oaiapp_${account().sub}` : (requested ?? '')
    const back = new URL(authorize.searchParams.get('redirect_uri')!)
    back.searchParams.set('code', 'the-code')
    back.searchParams.set('state', authorize.searchParams.get('state')!)
    if (requested === 'dynamic_agent_client') back.searchParams.set('client_id', clientId)
    for (const [key, value] of Object.entries(override)) back.searchParams.set(key, value)
    return back.href
  }
  return { fetch: fetchMock as unknown as typeof fetch, calls, browser }
}

function authWith(openai: ReturnType<typeof fakeOpenAI>, store = memoryStore(), now = (): number => NOW) {
  const opened: URL[] = []
  let returned: Promise<Response> | null = null
  let override: Record<string, string> = {}
  const auth = new ChatGptAuth({
    store,
    fetch: openai.fetch,
    openBrowser: async (url) => {
      opened.push(new URL(url))
      // The browser comes back to the loopback server, which is on this computer.
      returned = globalThis.fetch(openai.browser(new URL(url), override))
    },
    page: (signedIn) => (signedIn ? 'done' : 'failed'),
    now
  })
  const signIn = async (otherAccount = false, answer: Record<string, string> = {}) => {
    override = answer
    const result = await auth.signIn(otherAccount).then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error: error as Error })
    )
    const page = await returned!
    return { ...result, page, authorize: opened.at(-1)! }
  }
  return { auth, store, opened, signIn }
}

afterEach(() => vi.restoreAllMocks())

describe('the first sign-in with ChatGPT', () => {
  it('registers ASIST for this computer with the plan among the scopes, and keeps the client it is issued', async () => {
    const openai = fakeOpenAI()
    const { signIn, store, auth } = authWith(openai)
    const { value, error, authorize, page } = await signIn()
    expect(error).toBeNull()
    expect(authorize.origin + authorize.pathname).toBe(`${ISSUER}/api/accounts/authorize`)
    expect(authorize.searchParams.get('client_id')).toBe('dynamic_agent_client')
    expect(authorize.searchParams.get('agent_name_hint')).toBe('ASIST')
    expect(authorize.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:[0-9a-f-]{36}$/)
    expect(authorize.searchParams.get('scope')!.split(' ')).toContain(PLAN_SCOPE)
    expect(authorize.searchParams.get('resource')).toBe('https://api.openai.com/v1')
    const redirect = new URL(authorize.searchParams.get('redirect_uri')!)
    expect([redirect.hostname, redirect.pathname]).toEqual(['127.0.0.1', '/auth/callback'])
    const exchange = openai.calls.find((call) => call.form.get('grant_type') === 'authorization_code')!.form
    expect(exchange.get('client_id')).toBe('oaiapp_user-1')
    expect(createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url')).toBe(authorize.searchParams.get('code_challenge'))
    expect(exchange.get('redirect_uri')).toBe(authorize.searchParams.get('redirect_uri'))
    expect(value).toEqual({ status: { signIn: 'signedIn', account: 'me@example.com' }, first: true })
    expect(store.values).toMatchObject({ clientId: 'oaiapp_user-1', subject: 'user-1', account: 'me@example.com', refreshToken: 'refresh-1' })
    expect(page.status).toBe(200)
    expect(await auth.accessToken()).toBe('access-1')
  })

  /** A sign-in whose code exchange answers with the ID token `forge` makes instead of OpenAI's. */
  async function signInWithIdToken(forge: () => string) {
    const openai = fakeOpenAI()
    const original = openai.fetch
    const tampered = (async (input: string | URL, init?: RequestInit) => {
      const response = await original(input, init)
      if (String(input) !== CHATGPT_TOKEN_URL) return response
      return json({ ...((await response.json()) as Record<string, unknown>), id_token: forge() })
    }) as typeof fetch
    const context = authWith({ ...openai, fetch: tampered })
    return { ...context, ...(await context.signIn()) }
  }

  it('saves nothing when the ID token was issued for another sign-in', async () => {
    const { error, store, page } = await signInWithIdToken(() =>
      idToken({ iss: ISSUER, aud: 'oaiapp_user-1', exp: NOW / 1000 + 3600, sub: 'user-1', nonce: 'from-another-sign-in' })
    )
    expect(error?.message).toBe(errorText('chatgpt.errors.signInFailed'))
    expect(store.values.refreshToken).toBeUndefined()
    expect(page.status).toBe(400)
  })

  it('saves nothing when the ID token was not signed by OpenAI', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    const { error, store } = await signInWithIdToken(() => {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: KID })).toString('base64url')
      const payload = Buffer.from(JSON.stringify({ iss: ISSUER, aud: 'oaiapp_user-1', exp: NOW / 1000 + 3600, sub: 'user-1' })).toString('base64url')
      return `${header}.${payload}.${createSign('RSA-SHA256').update(`${header}.${payload}`).sign(other).toString('base64url')}`
    })
    expect(error?.message).toBe(errorText('chatgpt.errors.signInFailed'))
    expect(store.values.refreshToken).toBeUndefined()
  })

  it('saves nothing when the plan was left out, revokes the grant, and returns to that registration asking for consent', async () => {
    const options: { scope?: string } = { scope: 'openid profile email offline_access' }
    const openai = fakeOpenAI(options)
    const { signIn, store } = authWith(openai)
    const { error } = await signIn()
    expect(error?.message).toBe(errorText('chatgpt.errors.planNotGranted'))
    expect(openai.calls.find((call) => call.url === CHATGPT_REVOKE_URL)?.form.get('token')).toBe('refresh-1')
    expect(store.values.refreshToken).toBeUndefined()
    expect(store.values.clientId).toBeUndefined()
    options.scope = undefined
    const retry = await signIn()
    expect(retry.authorize.searchParams.get('prompt')).toBe('consent')
    expect(retry.authorize.searchParams.get('client_id')).toBe('oaiapp_user-1')
    // The plan was never used before this sign-in, so the notice that it is in use is still due.
    expect(retry.value?.first).toBe(true)
  })

  it('saves nothing of a sign-in that a sign-out overtook while OpenAI\'s keys were being fetched', async () => {
    let release!: () => void
    const keysAsked = new Promise<void>((resolve) => {
      release = resolve
    })
    let keysRequested!: () => void
    const requested = new Promise<void>((resolve) => (keysRequested = resolve))
    const openai = fakeOpenAI({
      hold: (url) => {
        if (url !== CHATGPT_JWKS_URL) return undefined
        keysRequested()
        return keysAsked
      }
    })
    const { auth, signIn, store } = authWith(openai)
    const signingIn = signIn()
    await requested
    await auth.signOut()
    release()
    const { error } = await signingIn
    expect(error).not.toBeNull()
    expect(store.values.refreshToken).toBeUndefined()
    expect(auth.status().signIn).toBe('signedOut')
    expect(openai.calls.filter((call) => call.url === CHATGPT_REVOKE_URL).map((call) => call.form.get('token'))).toEqual(['refresh-1'])
  })
})

describe('signing in again', () => {
  const registered = (): ReturnType<typeof memoryStore> =>
    memoryStore({ hostId: 'urn:uuid:00000000-0000-4000-8000-000000000000', clientId: 'oaiapp_user-1', subject: 'user-1', account: 'me@example.com' })

  it('returns to the saved registration on the same host, without registering ASIST again', async () => {
    const openai = fakeOpenAI()
    const { signIn } = authWith(openai, registered())
    const { value, error, authorize } = await signIn()
    expect(error).toBeNull()
    expect(authorize.searchParams.get('client_id')).toBe('oaiapp_user-1')
    expect(authorize.searchParams.has('agent_name_hint')).toBe(false)
    expect(authorize.searchParams.get('login_hint')).toBe('me@example.com')
    expect(authorize.searchParams.get('ext_agent_host_id')).toBe('urn:uuid:00000000-0000-4000-8000-000000000000')
    expect(value?.first).toBe(false)
  })

  it('refuses the tokens of another account chosen on the consent page and revokes them', async () => {
    const openai = fakeOpenAI({ account: { sub: 'user-2', email: 'other@example.com' } })
    const { signIn, store } = authWith(openai, registered())
    const { error } = await signIn()
    expect(error?.message).toBe(errorText('chatgpt.errors.accountMismatch'))
    expect(openai.calls.some((call) => call.url === CHATGPT_REVOKE_URL)).toBe(true)
    expect(store.values).toMatchObject({ clientId: 'oaiapp_user-1', subject: 'user-1', account: 'me@example.com' })
    expect(store.values.refreshToken).toBeUndefined()
  })

  it('refuses a return that names a client other than the saved one', async () => {
    const { signIn, store } = authWith(fakeOpenAI(), registered())
    const { error } = await signIn(false, { client_id: 'oaiapp_someone-else' })
    expect(error?.message).toBe(errorText('chatgpt.errors.signInFailed'))
    expect(store.values.refreshToken).toBeUndefined()
  })

  it('leaves the signed-in account as it was when another account leaves the plan out', async () => {
    const store = registered()
    store.values.refreshToken = 'refresh-of-user-1'
    const openai = fakeOpenAI({ account: { sub: 'user-2', email: 'other@example.com' }, scope: 'openid profile email offline_access' })
    const { auth, signIn } = authWith(openai, store)
    const { error } = await signIn(true)
    expect(error?.message).toBe(errorText('chatgpt.errors.planNotGranted'))
    expect(store.values).toMatchObject({ clientId: 'oaiapp_user-1', subject: 'user-1', account: 'me@example.com', refreshToken: 'refresh-of-user-1' })
    expect(auth.identity()).toBe('oaiapp_user-1:user-1')
  })

  it('registers another account on request and ends the session of the account it replaces', async () => {
    const store = registered()
    store.values.refreshToken = 'refresh-of-user-1'
    const openai = fakeOpenAI({ account: { sub: 'user-2', email: 'other@example.com' } })
    const { signIn } = authWith(openai, store)
    const { value, error, authorize } = await signIn(true)
    expect(error).toBeNull()
    expect(authorize.searchParams.get('client_id')).toBe('dynamic_agent_client')
    expect(value).toEqual({ status: { signIn: 'signedIn', account: 'other@example.com' }, first: true })
    const revoked = openai.calls.find((call) => call.url === CHATGPT_REVOKE_URL)!.form
    expect([revoked.get('token'), revoked.get('client_id')]).toEqual(['refresh-of-user-1', 'oaiapp_user-1'])
    expect(store.values).toMatchObject({ clientId: 'oaiapp_user-2', subject: 'user-2' })
  })

  it('replaces a saved sign-in this build cannot read, which the status shows as unreadable', async () => {
    const store = registered()
    store.unreadable = true
    const { auth, signIn } = authWith(fakeOpenAI(), store)
    expect(auth.status()).toEqual({ signIn: 'unreadable', account: null })
    const { error, authorize } = await signIn()
    expect(error).toBeNull()
    expect(authorize.searchParams.get('client_id')).toBe('dynamic_agent_client')
    expect(auth.status().signIn).toBe('signedIn')
  })
})

describe('the access token', () => {
  const signedIn = (): ReturnType<typeof memoryStore> =>
    memoryStore({ hostId: 'urn:uuid:x', clientId: 'oaiapp_user-1', subject: 'user-1', account: 'me@example.com', refreshToken: 'refresh-0' })

  it('is renewed once for callers that ask together, with the client and resource of the registration, keeping the replaced refresh token', async () => {
    const openai = fakeOpenAI()
    const { auth, store } = authWith(openai, signedIn())
    const tokens = await Promise.all([auth.accessToken(), auth.accessToken(), auth.accessToken()])
    expect(tokens).toEqual(['access-1', 'access-1', 'access-1'])
    const refreshes = openai.calls.filter((call) => call.form.get('grant_type') === 'refresh_token')
    expect(refreshes).toHaveLength(1)
    expect([refreshes[0].form.get('client_id'), refreshes[0].form.get('refresh_token'), refreshes[0].form.get('resource')]).toEqual([
      'oaiapp_user-1',
      'refresh-0',
      'https://api.openai.com/v1'
    ])
    expect(store.values.refreshToken).toBe('refresh-1')
  })

  it('is renewed shortly before it expires, and a refused one is not sent again', async () => {
    let now = NOW
    const openai = fakeOpenAI()
    const { auth } = authWith(openai, signedIn(), () => now)
    expect(await auth.accessToken()).toBe('access-1')
    now += 3600_000 - 30_000
    expect(await auth.accessToken()).toBe('access-2')
    auth.forgetAccessToken('access-2')
    expect(await auth.accessToken()).toBe('access-3')
  })

  it('signs out, keeping the registration, when OpenAI no longer accepts the refresh token', async () => {
    const openai = fakeOpenAI({ refresh: () => json({ error: 'invalid_grant' }, 400) })
    const { auth, store } = authWith(openai, signedIn())
    const error = await auth.accessToken().catch((caught: unknown) => caught as Error & { code?: string })
    expect(error.message).toBe(errorText('chatgpt.errors.sessionEnded'))
    expect(error.code).toBe(CHATGPT_SIGN_IN)
    expect(store.values.refreshToken).toBeUndefined()
    expect(auth.status()).toEqual({ signIn: 'signedOut', account: 'me@example.com' })
  })

  it('writes nothing back from a refresh that was still waiting when the user signed out', async () => {
    let release!: () => void
    const answered = new Promise<void>((resolve) => (release = resolve))
    let asked!: () => void
    const refreshAsked = new Promise<void>((resolve) => (asked = resolve))
    const openai = fakeOpenAI({
      hold: (_url, form) => {
        if (form.get('grant_type') !== 'refresh_token') return undefined
        asked()
        return answered
      }
    })
    const { auth, store } = authWith(openai, signedIn())
    const renewing = auth.accessToken().catch((caught: unknown) => caught as Error)
    await refreshAsked
    await auth.signOut()
    release()
    expect(await renewing).toBeInstanceOf(Error)
    expect(store.values.refreshToken).toBeUndefined()
    expect(auth.status().signIn).toBe('signedOut')
  })

  it('keeps the sign-in through a refresh that failed on the server', async () => {
    const openai = fakeOpenAI({ refresh: () => json({ error: 'server_error' }, 503) })
    const { auth, store } = authWith(openai, signedIn())
    await expect(auth.accessToken()).rejects.toThrow(errorText('chatgpt.errors.requestFailed', { status: 503 }))
    expect(store.values.refreshToken).toBe('refresh-0')
  })
})

describe('signing out', () => {
  it('revokes the refresh token with its client and forgets the session, keeping the account for the next sign-in', async () => {
    const openai = fakeOpenAI()
    const store = memoryStore({ hostId: 'urn:uuid:x', clientId: 'oaiapp_user-1', subject: 'user-1', account: 'me@example.com', refreshToken: 'refresh-0', idToken: 'id' })
    const { auth } = authWith(openai, store)
    expect(await auth.signOut()).toEqual({ signIn: 'signedOut', account: 'me@example.com' })
    const revoked = openai.calls.find((call) => call.url === CHATGPT_REVOKE_URL)!.form
    expect([revoked.get('token'), revoked.get('token_type_hint'), revoked.get('client_id')]).toEqual(['refresh-0', 'refresh_token', 'oaiapp_user-1'])
    expect(store.values).toEqual({ hostId: 'urn:uuid:x', clientId: 'oaiapp_user-1', subject: 'user-1', account: 'me@example.com' })
  })

  it('still signs out here when OpenAI does not confirm the revocation, and says so', { timeout: 10_000 }, async () => {
    const openai = fakeOpenAI({ revoke: () => new Response('', { status: 503 }) })
    const store = memoryStore({ clientId: 'oaiapp_user-1', subject: 'user-1', refreshToken: 'refresh-0' })
    const { auth } = authWith(openai, store)
    await expect(auth.signOut()).rejects.toThrow(errorText('chatgpt.errors.revokeUnconfirmed'))
    expect(openai.calls.filter((call) => call.url === CHATGPT_REVOKE_URL)).toHaveLength(3)
    expect(store.values.refreshToken).toBeUndefined()
  })
})
