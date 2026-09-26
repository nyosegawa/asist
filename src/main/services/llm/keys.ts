import { LLM_PROVIDER_INFO, type LlmProvider } from '@shared/llm-catalog'
import { errorText } from '@shared/i18n/error-text'
import { saveApiKey, savedApiKey } from '../api-key-secrets'

/**
 * API keys per provider. A key in the environment (the parent process or cwd/.env) wins over the key
 * saved on the settings screen, so a development run keeps its .env keys and never has to decrypt a key
 * that the installed build encrypted with its own Keychain key. Keys are read on every call rather than
 * cached, so a key that changes takes effect immediately and each adapter builds its client from the key
 * it is handed. Keys are read one provider at a time, so that a saved key which cannot be decrypted stops
 * only what needs that provider.
 */

export type ProviderKeys = Partial<Record<LlmProvider, string>>

/** A key that is empty or whitespace counts as absent. A saved key that cannot be decrypted throws SecretUnreadableError. */
export function providerKey(provider: LlmProvider): string | undefined {
  return process.env[LLM_PROVIDER_INFO[provider].envKey]?.trim() || savedApiKey(provider)?.trim() || undefined
}

/** Refuses a key that the environment would hide, so that a save never appears to succeed while another key is used. */
export function saveProviderKey(provider: LlmProvider, key: string): void {
  const envKey = LLM_PROVIDER_INFO[provider].envKey
  if (process.env[envKey]?.trim()) throw new Error(errorText('settingsIntegrations.apiKeys.errors.setInEnvironment', { envKey }))
  saveApiKey(provider, key)
}
