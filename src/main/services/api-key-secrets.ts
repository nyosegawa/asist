import { safeStorage } from 'electron'
import { LLM_PROVIDER_INFO, type LlmProvider } from '@shared/llm-catalog'
import { errorText } from '@shared/i18n/error-text'
import { createEncryptedSecretStore, type EncryptedSecretStore, type SecretEncryption } from './encrypted-secrets'
import { dataPath } from './store'

/**
 * The API keys saved on the settings screen, encrypted in userData/api-keys.json. A saved key is never
 * put into process.env, so no child process can inherit it; each SDK client is handed its key instead.
 */

export type ApiKeySecretStore = EncryptedSecretStore<LlmProvider>

export function createApiKeySecretStore(options: SecretEncryption & { filePath: string }): ApiKeySecretStore {
  return createEncryptedSecretStore<LlmProvider>({
    ...options,
    errors: {
      encryptionUnavailable: () => errorText('settingsIntegrations.apiKeys.errors.encryptionUnavailable'),
      secretUnreadable: (provider) => errorText('settingsIntegrations.apiKeys.errors.keyUnreadable', { provider: LLM_PROVIDER_INFO[provider].label }),
      fileUnreadable: (file, reason) => errorText('settingsIntegrations.apiKeys.errors.fileUnreadable', { file, reason }),
      fileBroken: (file) => errorText('settingsIntegrations.apiKeys.errors.fileBroken', { file }),
    }
  })
}

let shared: ApiKeySecretStore | null = null

/** Created on first use so that the userData path is resolved only after app ready. */
function store(): ApiKeySecretStore {
  return (shared ??= createApiKeySecretStore({
    filePath: dataPath('api-keys.json'),
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (encrypted) => safeStorage.decryptString(encrypted)
  }))
}

const revealed = new Set<string>()

export function savedApiKey(provider: LlmProvider): string | null {
  const key = store().get(provider)
  if (key) revealed.add(key)
  return key
}

export function saveApiKey(provider: LlmProvider, key: string): void {
  store().set(provider, key)
  revealed.add(key)
}

/**
 * The saved keys this process has decrypted or saved, for the log to redact. A key that was never
 * decrypted cannot appear in the log, so the log needs no decryption of its own.
 */
export const revealedApiKeys = (): string[] => [...revealed]
