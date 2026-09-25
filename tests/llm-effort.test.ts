import { describe, expect, it } from 'vitest'
import { CONVERSATION_MODELS, effortFor, effortOptions } from '../src/shared/llm-catalog'
import { errorText } from '@shared/i18n/error-text'

describe('how the reasoning effort is decided', () => {
  it('gives every catalog model a default effort and null to a model that accepts none', () => {
    expect(effortFor({ provider: 'anthropic', id: 'claude-sonnet-5' })).toBe('low')
    expect(effortFor({ provider: 'anthropic', id: 'claude-opus-5' })).toBe('low')
    expect(effortFor({ provider: 'anthropic', id: 'claude-haiku-4-5' })).toBeNull()
    expect(effortFor({ provider: 'openai', id: 'gpt-5.6-sol' })).toBe('low')
    for (const model of CONVERSATION_MODELS) {
      expect(model.defaultEffort === null).toBe(model.efforts.length === 0)
      if (model.defaultEffort) expect(model.efforts).toContain(model.defaultEffort)
    }
  })
  it('uses the effort from the settings only when the model accepts it, and throws instead of dropping it silently', () => {
    expect(effortFor({ provider: 'anthropic', id: 'claude-sonnet-5', effort: 'xhigh' })).toBe('xhigh')
    expect(effortFor({ provider: 'openai', id: 'gpt-5.6-luna', effort: 'high' })).toBe('high')
    expect(() => effortFor({ provider: 'openai', id: 'gpt-5.6-luna', effort: 'max' })).toThrow(
      errorText('llmModels.errors.effortUnsupported', { model: 'OpenAI · GPT-5.6 Luna' })
    )
    expect(() => effortFor({ provider: 'anthropic', id: 'claude-haiku-4-5', effort: 'low' })).toThrow(
      errorText('llmModels.errors.effortUnsupported', { model: 'Anthropic · Claude Haiku 4.5' })
    )
  })
  it('decides the effort of an id that is not in the catalog from the rules of the provider', () => {
    expect(effortOptions({ provider: 'anthropic', id: 'claude-opus-4-8' })).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(effortFor({ provider: 'anthropic', id: 'claude-opus-4-8' })).toBe('low')
    expect(effortOptions({ provider: 'anthropic', id: 'claude-haiku-4-5-20251001' })).toEqual([])
    expect(effortOptions({ provider: 'anthropic', id: 'claude-sonnet-4-5' })).toEqual([])
    expect(effortOptions({ provider: 'cerebras', id: 'llama-x' })).toEqual(['low', 'medium', 'high'])
  })
})
