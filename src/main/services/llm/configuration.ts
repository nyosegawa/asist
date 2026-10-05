import { withTimeoutSignal } from '@shared/abort'
import {
  ApiKeyValidationError,
  classifyApiKeyValidationError,
  validateConfiguredApiModels,
  type ConfiguredApiModel
} from '@shared/api-key-validation'
import type { JsonSchema } from '@shared/conversation'
import { LLM_PROVIDERS, type ApiKeyProvider, type LlmProvider } from '@shared/llm-catalog'
import { errorText } from '@shared/i18n/error-text'
import type { ApiKeyState, AppSettings } from '@shared/ipc'
import { modelsInUse, type ModelSetting } from '@shared/settings'
import { t } from '../i18n'
import { SecretUnreadableError } from '../encrypted-secrets'
import { getSettings } from '../settings'
import { apiKeyCredential, type ProviderCredential } from './credential'
import { credentialMissing, providerCredential } from './keys'
import { ADAPTERS, completeJson } from './call'

/**
 * Validation of the models in use, plus the lightweight one-shot JSON call on the bridge model. A
 * configuration is only persisted once each model in use has been fetched from the real API with that
 * provider's key or sign-in, so a configuration that cannot run is never stored.
 */

export { credentialMissing, providerCredential, providerKey, saveProviderKey } from './keys'

type ProviderCredentials = Partial<Record<LlmProvider, ProviderCredential>>

let validatedConfiguration: string | null = null
const validationFlights = new Map<string, Promise<void>>()
/** The identity of the credential that authenticated against the real API in this process, per provider. */
const verifiedIdentities = new Map<LlmProvider, string>()

function forgetIfUnauthenticated(error: unknown, provider: LlmProvider, identity: string): void {
  if (error instanceof ApiKeyValidationError && error.code === 'authentication' && verifiedIdentities.get(provider) === identity) {
    verifiedIdentities.delete(provider)
  }
}

function keyState(provider: LlmProvider): ApiKeyState {
  let credential: ProviderCredential | undefined
  try {
    credential = providerCredential(provider)
  } catch (error) {
    if (error instanceof SecretUnreadableError) return 'unreadable'
    throw error
  }
  return credential === undefined ? 'missing' : verifiedIdentities.get(provider) === credential.identity ? 'verified' : 'saved'
}

/**
 * A provider counts as verified only while its key or sign-in is still the one that was verified. A saved
 * one that cannot be decrypted is reported for its own provider, so the status still shows the others and
 * the screen can ask for that one again.
 */
export function llmKeyStates(): Record<LlmProvider, ApiKeyState> {
  return Object.fromEntries(LLM_PROVIDERS.map((provider) => [provider, keyState(provider)])) as Record<LlmProvider, ApiKeyState>
}

/** The models in use, as the checks against the real API name them. */
export function configuredModels(
  settings: Pick<AppSettings, ModelSetting | 'bridgePhrase'> = getSettings()
): ConfiguredApiModel[] {
  return modelsInUse(settings).map(({ setting, model }) => ({ label: t(`llmModels.targets.${setting}`), provider: model.provider, id: model.id }))
}

/** The keys and sign-ins of the providers the models use. No other provider's is read. */
function credentialsOf(models: readonly ConfiguredApiModel[]): ProviderCredentials {
  const credentials: ProviderCredentials = {}
  for (const { provider } of models) {
    const credential = providerCredential(provider)
    if (credential) credentials[provider] = credential
  }
  return credentials
}

function validationFingerprint(credentials: ProviderCredentials, models: readonly ConfiguredApiModel[]): string {
  return JSON.stringify(models.map(({ provider, id }) => [provider, id.trim(), credentials[provider]?.identity ?? '']))
}

/** Whether the current combination of keys, sign-ins and models was verified against the real API in this process. */
export function configuredApiKeyVerified(): boolean {
  const models = configuredModels()
  return validatedConfiguration === validationFingerprint(credentialsOf(models), models)
}

const RETRIEVE_TIMEOUT_MS = 15_000

function retrieveModel(model: ConfiguredApiModel, credential: ProviderCredential): Promise<void> {
  return ADAPTERS[model.provider].retrieveModel(model.id, credential, withTimeoutSignal(undefined, RETRIEVE_TIMEOUT_MS))
}

function listModels(provider: LlmProvider, credential: ProviderCredential): Promise<void> {
  return ADAPTERS[provider].listModels(credential, withTimeoutSignal(undefined, RETRIEVE_TIMEOUT_MS))
}

/**
 * Checks that each configured model can be fetched from the real API with its provider's key or sign-in. A
 * provider without either counts as an authentication failure, and only one validation of the same
 * configuration runs at a time.
 */
export async function validateConfiguration(
  models: readonly ConfiguredApiModel[] = configuredModels(),
  credentials: ProviderCredentials = credentialsOf(models)
): Promise<void> {
  const fingerprint = validationFingerprint(credentials, models)
  const existing = validationFlights.get(fingerprint)
  if (existing) return existing

  const operation = (async () => {
    try {
      await validateConfiguredApiModels(models, (model) => {
        const credential = credentials[model.provider]
        if (!credential) throw new ApiKeyValidationError('authentication', credentialMissing(model.provider).message, model)
        return retrieveModel(model, credential).then(() => verifiedIdentities.set(model.provider, credential.identity))
      })
      validatedConfiguration = fingerprint
    } catch (error) {
      // An explicit revalidation that failed must not leave the same configuration usable through the earlier success.
      if (validatedConfiguration === fingerprint) validatedConfiguration = null
      if (error instanceof ApiKeyValidationError && error.model) {
        forgetIfUnauthenticated(error, error.model.provider, credentials[error.model.provider]?.identity ?? '')
      }
      throw error
    }
  })().finally(() => {
    if (validationFlights.get(fingerprint) === operation) validationFlights.delete(fingerprint)
  })
  validationFlights.set(fingerprint, operation)
  return operation
}

/**
 * Checks a candidate key for a provider before it is saved. If a configured model uses that provider
 * the model itself is fetched; otherwise listing the models checks only that the key authenticates.
 * No saved key is read, so entering a key again replaces one that can no longer be decrypted.
 */
export async function validateProviderKey(
  provider: ApiKeyProvider,
  rawKey: string,
  models: readonly ConfiguredApiModel[] = configuredModels()
): Promise<void> {
  const key = rawKey.trim()
  if (!key || /[\r\n]/.test(key)) throw new Error(errorText('llmModels.errors.keyEmpty'))
  return validateCredential(provider, apiKeyCredential(key), models)
}

/**
 * Checks a provider's key or sign-in as validateProviderKey does, for one already held: a key saved in an
 * earlier session or set in the environment, or a sign-in with ChatGPT that just completed.
 */
export async function validateCredential(
  provider: LlmProvider,
  credential: ProviderCredential,
  models: readonly ConfiguredApiModel[] = configuredModels()
): Promise<void> {
  const own = models.filter((model) => model.provider === provider)
  if (own.length > 0) return validateConfiguration(own, { [provider]: credential })
  try {
    await listModels(provider, credential)
    verifiedIdentities.set(provider, credential.identity)
  } catch (error) {
    const classified = classifyApiKeyValidationError(error, { label: t('llmModels.targets.apiKey'), provider, id: '' })
    forgetIfUnauthenticated(classified, provider, credential.identity)
    throw classified
  }
}

/** First-run setup needs the current key to authenticate, not merely to be present, so a stored key alone is not enough. */
export async function configuredApiKeyAvailable(): Promise<boolean> {
  try {
    if (!configuredApiKeyVerified()) await validateConfiguration()
    return true
  } catch {
    return false
  }
}

/**
 * A one-shot call on the bridge model that returns JSON matching the schema. The provider's
 * structured output guarantees the shape, so no JSON is dug out of free text here.
 */
export function quickJson(system: string, user: string, schema: JsonSchema, signal?: AbortSignal): Promise<unknown> {
  return completeJson(getSettings().bridgeModel, system, user, schema, 1024, withTimeoutSignal(signal, 30_000), 'bridge')
}
