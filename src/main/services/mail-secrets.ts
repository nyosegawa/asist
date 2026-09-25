import { errorText } from '@shared/i18n/error-text'
import { createEncryptedSecretStore, type EncryptedSecretStore, type SecretEncryption } from './encrypted-secrets'

/** Mail passwords by account id. They stay out of settings.json and live encrypted in userData/mail-secrets.json. */

export interface MailSecretStoreOptions extends SecretEncryption {
  filePath: string
}

export type MailSecretStore = EncryptedSecretStore

export function createMailSecretStore(options: MailSecretStoreOptions): MailSecretStore {
  return createEncryptedSecretStore({
    ...options,
    errors: {
      encryptionUnavailable: () => errorText('mail.errors.account.encryptionUnavailable'),
      secretUnreadable: () => errorText('mail.errors.account.passwordUnreadable'),
      fileUnreadable: (file, reason) => errorText('mail.errors.account.fileUnreadable', { file, reason }),
      fileBroken: (file) => errorText('mail.errors.account.fileBroken', { file }),
    }
  })
}
