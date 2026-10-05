import OpenAI from 'openai'
import type { ResponseCreateParamsStreaming, ResponseStreamEvent, Response } from 'openai/resources/responses/responses'
import { ResponsesWS } from 'openai/resources/responses/ws'
import { CHATGPT_SIGN_IN } from '@shared/chatgpt'
import { effortFor } from '@shared/llm-catalog'
import { statusError, streamCutOff, type JsonRequest, type ProviderAdapter } from './adapter'
import type { ProviderCredential } from './credential'
import { streamFailure } from './openai-stream'
import { ResponsesStream, roundUsage, type ResponsesDialect, type ResponsesSource } from './responses'
import { ResponsesSocketPool } from './responses-socket'

/**
 * OpenAI's models on the user's ChatGPT plan, with the access token of the sign-in with ChatGPT. The plan's
 * route takes the public Responses API with these differences, measured on 2026-10-05: store must be false
 * and the response streamed; function tools go in a namespace and max_output_tokens is left out, as OpenAI's
 * documentation of the preview requires, although the route accepted both then; and prompt_cache_key makes
 * the cache hold, where without it the cached tokens came and went between identical requests.
 */

const PROVIDER_LABEL = 'ChatGPT'
const CHATGPT: ResponsesDialect = { provider: 'chatgpt', label: PROVIDER_LABEL, toolNamespace: 'asist', capsOutput: false, cacheKey: 'asist' }
const MODELS_URL = 'https://api.openai.com/v1/models'

const pool = new ResponsesSocketPool({
  provider: PROVIDER_LABEL,
  open: (token) => new ResponsesWS(new OpenAI({ apiKey: token, maxRetries: 0 }))
})

/** Closes the connections that wait for a next response. */
export const closeChatGptConnections = (): void => pool.closeAll()

const refusedStatus = (error: unknown): boolean => (error as { status?: unknown } | null)?.status === 401

/** A refusal of the sign-in, which the conversation words as a request to sign in again. */
const signInError = (error: unknown): Error => Object.assign(new Error(`${PROVIDER_LABEL}: the access token was refused`, { cause: error }), { status: 401, code: CHATGPT_SIGN_IN })

/**
 * The events of a request, sent with the current access token. A token OpenAI refuses before any event is
 * forgotten and the request is sent once more with a renewed one, since the access token may have been
 * revoked or expired between the check of its expiry and the request.
 */
function sourceFor(credential: ProviderCredential): ResponsesSource {
  return async (params, signal) => {
    for (let attempt = 0; ; attempt++) {
      const token = await credential.token()
      const events = pool.events(token, params, signal)
      let first: IteratorResult<ResponseStreamEvent>
      try {
        first = await events.next()
      } catch (error) {
        if (!refusedStatus(error)) throw error
        credential.refused(token)
        if (attempt === 0) continue
        throw signInError(error)
      }
      return (async function* () {
        if (first.done) return
        yield first.value
        yield* events
      })()
    }
  }
}

/** The models the signed-in account may use, by the slugs the API takes. */
async function listedModels(credential: ProviderCredential, signal: AbortSignal): Promise<string[]> {
  const token = await credential.token()
  const response = await fetch(MODELS_URL, { headers: { authorization: `Bearer ${token}` }, signal })
  if (response.status === 401) {
    credential.refused(token)
    throw signInError(statusError(401, `${PROVIDER_LABEL}: the model list refused the access token`))
  }
  if (!response.ok) throw statusError(response.status, `${PROVIDER_LABEL}: the model list failed (HTTP ${response.status})`)
  const body = (await response.json().catch(() => null)) as { models?: Array<{ slug?: unknown; visibility?: unknown }> } | null
  if (!Array.isArray(body?.models)) throw new Error(`${PROVIDER_LABEL}: the model list has no models`)
  return body.models.filter((model) => model.visibility === 'list' && typeof model.slug === 'string').map((model) => model.slug as string)
}

export const chatgptAdapter: ProviderAdapter = {
  stream: (request, credential) => new ResponsesStream(CHATGPT, Promise.resolve(sourceFor(credential)), request),

  async completeJson(request: JsonRequest, credential) {
    const effort = effortFor(request.model)
    const params: ResponseCreateParamsStreaming = {
      model: request.model.id,
      instructions: request.system,
      input: [{ role: 'user', content: request.user }],
      ...(effort ? { reasoning: { effort } } : {}),
      text: { format: { type: 'json_schema', name: 'result', schema: request.schema, strict: true } },
      prompt_cache_key: CHATGPT.cacheKey ?? undefined,
      store: false,
      stream: true
    }
    let text = ''
    let response: Response | null = null
    for await (const event of await sourceFor(credential)(params, request.signal)) {
      if (event.type === 'response.output_text.delta') text += event.delta
      else if (event.type === 'response.completed' || event.type === 'response.incomplete') response = event.response
      else if (event.type === 'response.failed') throw streamFailure(PROVIDER_LABEL, event.response.error?.code, event.response.error?.message)
      else if (event.type === 'error') throw streamFailure(PROVIDER_LABEL, event.code, event.message)
    }
    if (!response) streamCutOff(request.signal, PROVIDER_LABEL)
    const done = response
    return {
      usage: roundUsage(done.usage, done.output),
      value: () => {
        if (done.status !== 'completed') throw new Error(`${PROVIDER_LABEL}: the JSON response did not complete (${done.incomplete_details?.reason ?? done.status})`)
        return JSON.parse(text)
      }
    }
  },

  async retrieveModel(id, credential, signal) {
    if (!(await listedModels(credential, signal)).includes(id)) throw statusError(404, `${PROVIDER_LABEL}: ${id} is not among the account's models`)
  },

  async listModels(credential, signal) {
    await listedModels(credential, signal)
  }
}
