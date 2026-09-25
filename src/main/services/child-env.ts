import { LLM_PROVIDERS, LLM_PROVIDER_INFO } from '@shared/llm-catalog'

/**
 * The environment every child process starts with. No child needs a provider's API key: the Python workers
 * and the native helpers run locally, and an agent CLI signs in on its own. An agent job that a prompt
 * injection reaches could otherwise send its environment anywhere, and claude would bill a key found in
 * ANTHROPIC_API_KEY.
 */

/** Variables that no child receives, even when a caller passes one in `extra`. */
export const WITHHELD_VARIABLES: readonly string[] = LLM_PROVIDERS.map((provider) => LLM_PROVIDER_INFO[provider].envKey)

export function childEnv(extra: NodeJS.ProcessEnv = {}, parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent, ...extra }
  for (const name of WITHHELD_VARIABLES) delete env[name]
  return env
}
