import OpenAI from 'openai'
import { effortFor } from '@shared/llm-catalog'
import type { JsonRequest, ProviderAdapter } from './adapter'
import { streamEvents } from './openai-stream'
import { ResponsesStream, roundUsage, type ResponsesDialect } from './responses'

/** OpenAI's API with an API key, over HTTP. */

export const OPENAI_DIALECT: ResponsesDialect = { provider: 'openai', label: 'OpenAI', toolNamespace: null, capsOutput: true, cacheKey: null }

let cached: { key: string; client: OpenAI } | null = null
function clientFor(key: string): OpenAI {
  if (cached?.key !== key) cached = { key, client: new OpenAI({ apiKey: key, maxRetries: 0 }) }
  return cached.client
}

export const openaiAdapter: ProviderAdapter = {
  stream: (request, credential) =>
    new ResponsesStream(
      OPENAI_DIALECT,
      credential.token().then((key) => async (params, signal) => streamEvents('OpenAI', await clientFor(key).responses.create(params, { signal }))),
      request
    ),

  async completeJson(request: JsonRequest, credential) {
    const effort = effortFor(request.model)
    const response = await clientFor(await credential.token()).responses.create(
      {
        model: request.model.id,
        instructions: request.system,
        input: request.user,
        ...(effort ? { reasoning: { effort } } : {}),
        text: { format: { type: 'json_schema', name: 'result', schema: request.schema, strict: true } },
        max_output_tokens: request.maxTokens,
        store: false
      },
      { signal: request.signal }
    )
    return {
      usage: roundUsage(response.usage, response.output),
      value: () => {
        if (response.status !== 'completed') {
          throw new Error(`OpenAI: the JSON response did not complete (${response.incomplete_details?.reason ?? response.error?.message ?? response.status})`)
        }
        return JSON.parse(response.output_text)
      }
    }
  },

  async retrieveModel(id, credential, signal) {
    await new OpenAI({ apiKey: await credential.token(), maxRetries: 0 }).models.retrieve(id, { signal })
  },

  async listModels(credential, signal) {
    await new OpenAI({ apiKey: await credential.token(), maxRetries: 0 }).models.list({ signal })
  }
}
