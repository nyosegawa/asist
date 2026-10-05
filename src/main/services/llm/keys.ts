import { API_KEY_INFO, LLM_PROVIDER_INFO, type ApiKeyProvider, type LlmProvider } from '@shared/llm-catalog'
import { errorText } from '@shared/i18n/error-text'
import { saveApiKey, savedApiKey } from '../api-key-secrets'
import { chatgptAuth } from '../chatgpt'
import { apiKeyCredential, type ProviderCredential } from './credential'

export type { ProviderCredential } from './credential'

/**
 * What authenticates each provider's requests. A key in the environment (the parent process or cwd/.env)
 * wins over the key saved on the settings screen, so a development run keeps its .env keys and never has to
 * decrypt a key that the installed build encrypted with its own Keychain key. ChatGPT has no key: its
 * requests carry the access token of the sign-in with ChatGPT, renewed as it expires. Everything is read on
 * every call rather than cached, so a change takes effect immediately, and one provider at a time, so that a
 * saved secret which cannot be decrypted stops only what needs that provider.
 */

/** A key that is empty or whitespace counts as absent. A saved key that cannot be decrypted throws SecretUnreadableError. */
export function providerKey(provider: ApiKeyProvider): string | undefined {
  return process.env[API_KEY_INFO[provider].envKey]?.trim() || savedApiKey(provider)?.trim() || undefined
}

/** Undefined without a key or a sign-in. A saved one that cannot be decrypted throws SecretUnreadableError. */
export function providerCredential(provider: LlmProvider): ProviderCredential | undefined {
  if (provider === 'chatgpt') {
    const auth = chatgptAuth()
    const identity = auth.identity()
    if (identity === null) return undefined
    return { identity, token: () => auth.accessToken(), refused: (token) => auth.forgetAccessToken(token) }
  }
  const key = providerKey(provider)
  return key === undefined ? undefined : apiKeyCredential(key)
}

/** The error for a provider that has neither a key nor a sign-in, saying where to add it. */
export function credentialMissing(provider: LlmProvider): Error {
  if (provider === 'chatgpt') return new Error(errorText('chatgpt.errors.signedOut'))
  return new Error(errorText('llmModels.errors.keyMissing', { provider: LLM_PROVIDER_INFO[provider].label, envKey: API_KEY_INFO[provider].envKey }))
}

export function requireCredential(provider: LlmProvider): ProviderCredential {
  const credential = providerCredential(provider)
  if (!credential) throw credentialMissing(provider)
  return credential
}

/** Refuses a key that the environment would hide, so that a save never appears to succeed while another key is used. */
export function saveProviderKey(provider: ApiKeyProvider, key: string): void {
  const envKey = API_KEY_INFO[provider].envKey
  if (process.env[envKey]?.trim()) throw new Error(errorText('settingsIntegrations.apiKeys.errors.setInEnvironment', { envKey }))
  saveApiKey(provider, key)
}
