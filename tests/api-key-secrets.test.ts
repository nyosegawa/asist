import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { errorText } from '@shared/i18n/error-text'
import { LLM_PROVIDERS, LLM_PROVIDER_INFO } from '@shared/llm-catalog'

/**
 * API keys saved on the settings screen: only the encrypted value reaches the file, the key never enters
 * process.env, and nothing is stored where encryption is unavailable.
 */

const reverse = (text: string): string => [...text].reverse().join('')
const electron = vi.hoisted(() => ({ userData: '', available: true, decryptFails: false }))
vi.mock('electron', () => ({
  app: { getPath: () => electron.userData },
  safeStorage: {
    isEncryptionAvailable: () => electron.available,
    encryptString: (plain: string) => Buffer.from(reverse(plain), 'utf8'),
    decryptString: (encrypted: Buffer) => {
      if (electron.decryptFails) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
      return reverse(encrypted.toString('utf8'))
    }
  }
}))

const KEY = 'sk-ant-api03-saved-in-settings'
const file = (): string => path.join(electron.userData, 'api-keys.json')

beforeEach(() => {
  vi.resetModules()
  electron.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'asist-api-keys-'))
  electron.available = true
  electron.decryptFails = false
  for (const provider of LLM_PROVIDERS) vi.stubEnv(LLM_PROVIDER_INFO[provider].envKey, undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(electron.userData, { recursive: true, force: true })
})

describe('saved API keys', () => {
  it('round-trips a key through an owner-only encrypted file and keeps it out of process.env', async () => {
    const keys = await import('../src/main/services/llm/keys')
    keys.saveProviderKey('anthropic', KEY)

    const raw = fs.readFileSync(file(), 'utf8')
    expect(raw).not.toContain(KEY)
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600)
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()

    vi.resetModules()
    const fresh = await import('../src/main/services/llm/keys')
    expect(fresh.providerKey('anthropic')).toBe(KEY)
    expect(fresh.providerKeys()).toEqual({ anthropic: KEY })
    const { revealedApiKeys } = await import('../src/main/services/api-key-secrets')
    expect(revealedApiKeys()).toEqual([KEY])
  })

  it('uses a key from the environment over the saved one and refuses a save the environment would hide', async () => {
    const keys = await import('../src/main/services/llm/keys')
    keys.saveProviderKey('anthropic', KEY)
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-from-dotenv')
    expect(keys.providerKey('anthropic')).toBe('sk-ant-from-dotenv')
    expect(() => keys.saveProviderKey('anthropic', 'sk-ant-other')).toThrow(
      errorText('settingsIntegrations.apiKeys.errors.setInEnvironment', { envKey: 'ANTHROPIC_API_KEY' })
    )
    vi.stubEnv('ANTHROPIC_API_KEY', undefined)
    expect(keys.providerKey('anthropic')).toBe(KEY)
  })

  it('throws instead of storing a key where encryption is unavailable', async () => {
    electron.available = false
    const keys = await import('../src/main/services/llm/keys')
    expect(() => keys.saveProviderKey('openai', 'sk-proj-plain-text-key')).toThrow(
      errorText('settingsIntegrations.apiKeys.errors.encryptionUnavailable')
    )
    expect(fs.existsSync(file())).toBe(false)
    expect(keys.providerKey('openai')).toBeUndefined()
  })

  it('reports a key that this build cannot decrypt instead of treating it as absent', async () => {
    const keys = await import('../src/main/services/llm/keys')
    keys.saveProviderKey('google', 'AIza-saved-google-key')
    electron.decryptFails = true
    expect(() => keys.providerKey('google')).toThrow(errorText('settingsIntegrations.apiKeys.errors.keyUnreadable', { provider: 'Google' }))
  })
})
