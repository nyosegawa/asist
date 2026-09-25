import { describe, expect, it } from 'vitest'
import { LLM_PROVIDERS, LLM_PROVIDER_INFO } from '@shared/llm-catalog'
import { childEnv } from '../src/main/services/child-env'

/** No child process may receive a provider's API key, whether it came from the parent environment or a caller. */

const providerKeys = LLM_PROVIDERS.map((provider) => LLM_PROVIDER_INFO[provider].envKey)

describe('childEnv', () => {
  it('drops every provider key and keeps the rest of the environment and the extra variables', () => {
    const parent = {
      PATH: '/opt/homebrew/bin:/usr/bin:/bin',
      HOME: '/Users/someone',
      LANG: 'ja_JP.UTF-8',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787',
      ...Object.fromEntries(providerKeys.map((name) => [name, `secret-${name}`]))
    }
    const env = childEnv({ PYTHONUNBUFFERED: '1', OPENAI_API_KEY: 'passed-by-a-caller' }, parent)
    for (const name of providerKeys) expect(env).not.toHaveProperty(name)
    expect(env).toEqual({
      PATH: '/opt/homebrew/bin:/usr/bin:/bin',
      HOME: '/Users/someone',
      LANG: 'ja_JP.UTF-8',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787',
      PYTHONUNBUFFERED: '1'
    })
    expect(parent.ANTHROPIC_API_KEY).toBe('secret-ANTHROPIC_API_KEY')
  })
})
