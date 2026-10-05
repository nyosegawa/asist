import { safeStorage, shell } from 'electron'
import { errorText } from '@shared/i18n/error-text'
import { ChatGptAuth, type ChatGptSecretId } from './chatgpt-auth'
import { createEncryptedSecretStore } from './encrypted-secrets'
import { t } from './i18n'
import { signInPage } from './sign-in-page'
import { dataPath } from './store'

let auth: ChatGptAuth | null = null

/** The sign-in with ChatGPT, whose tokens live encrypted in userData/chatgpt.json. */
export function chatgptAuth(): ChatGptAuth {
  if (auth) return auth
  const store = createEncryptedSecretStore<ChatGptSecretId>({
    filePath: dataPath('chatgpt.json'),
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (encrypted) => safeStorage.decryptString(encrypted),
    errors: {
      encryptionUnavailable: () => errorText('chatgpt.errors.tokenEncryptionUnavailable'),
      secretUnreadable: () => errorText('chatgpt.errors.tokenUnreadable'),
      fileUnreadable: (file, reason) => errorText('chatgpt.errors.tokenFileUnreadable', { file, reason }),
      fileBroken: (file) => errorText('chatgpt.errors.tokenFileBroken', { file })
    }
  })
  return (auth = new ChatGptAuth({
    store,
    fetch,
    openBrowser: (url) => shell.openExternal(url),
    page: signInPage((signedIn) => t(signedIn ? 'chatgpt.browser.done' : 'chatgpt.browser.failed'))
  }))
}
