import { describe, expect, it, vi } from 'vitest'
import {
  ApiKeyValidationError,
  validateConfiguredApiModels
} from '@shared/api-key-validation'
import { createTranslator } from '@shared/i18n'
import { errorText } from '@shared/i18n/error-text'

const t = createTranslator('ja-JP')

const models = [
  { label: t('llmModels.targets.conversationModel'), provider: 'anthropic' as const, id: 'claude-main' },
  { label: t('llmModels.targets.bridgeModel'), provider: 'anthropic' as const, id: 'claude-fast' }
]

describe('validateConfiguredApiModels', () => {
  it('queries the real API for the configured conversation model and the aizuchi planning model', async () => {
    const retrieve = vi.fn(async () => ({ type: 'model' }))

    await validateConfiguredApiModels(models, retrieve)

    expect(retrieve.mock.calls.map(([model]) => model.id)).toEqual(['claude-main', 'claude-fast'])
  })

  it('queries the same model ID only once', async () => {
    const retrieve = vi.fn(async () => ({ type: 'model' }))

    await validateConfiguredApiModels(
      [
        { label: t('llmModels.targets.conversationModel'), provider: 'anthropic', id: ' claude-shared ' },
        { label: t('llmModels.targets.bridgeModel'), provider: 'anthropic', id: 'claude-shared' }
      ],
      retrieve
    )

    expect(retrieve).toHaveBeenCalledTimes(1)
    expect(retrieve.mock.calls[0][0]).toMatchObject({ id: 'claude-shared' })
  })

  it.each([
    [401, 'authentication'],
    [403, 'permission'],
    [404, 'model-unavailable'],
    [402, 'billing'],
    [429, 'rate-limit'],
    [503, 'service'],
    [400, 'request']
  ] as const)('reports HTTP %s as %s', async (status, code) => {
    const retrieve = vi.fn().mockRejectedValue({ status })

    const result = validateConfiguredApiModels(models, retrieve)

    await expect(result).rejects.toMatchObject<ApiKeyValidationError>({ code })
  })

  it('queries the same model ID separately per provider and names that provider in the message', async () => {
    const retrieve = vi.fn().mockRejectedValue({ status: 404 })
    const result = validateConfiguredApiModels(
      [
        { label: t('llmModels.targets.conversationModel'), provider: 'openai', id: 'shared' },
        { label: t('llmModels.targets.bridgeModel'), provider: 'anthropic', id: 'shared' }
      ],
      retrieve
    )
    await expect(result).rejects.toThrow(errorText('llmModels.errors.modelUnavailable', { target: `${t('llmModels.targets.conversationModel')} (shared)` }))
    expect(retrieve.mock.calls.map(([model]) => model.provider)).toEqual(['openai'])
    await expect(
      validateConfiguredApiModels([{ label: 'APIキー', provider: 'google', id: 'x' }], async () => {
        throw { status: 401 }
      })
    ).rejects.toThrow(errorText('llmModels.errors.authentication', { provider: 'Google' }))
  })

  it('reports a transport failure without an HTTP response as connection', async () => {
    const result = validateConfiguredApiModels(models, async () => {
      throw new Error('fetch failed')
    })

    await expect(result).rejects.toMatchObject<ApiKeyValidationError>({ code: 'connection' })
  })

  it('rejects an empty model setting as model-unavailable without querying the API', async () => {
    const retrieve = vi.fn(async () => ({ type: 'model' }))
    const result = validateConfiguredApiModels([{ label: t('llmModels.targets.conversationModel'), provider: 'anthropic', id: '  ' }], retrieve)

    await expect(result).rejects.toMatchObject<ApiKeyValidationError>({
      code: 'model-unavailable'
    })
    expect(retrieve).not.toHaveBeenCalled()
  })
})
