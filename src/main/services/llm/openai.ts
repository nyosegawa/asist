import OpenAI from 'openai'
import type {
  FunctionTool,
  Response,
  ResponseCreateParamsStreaming,
  ResponseInputItem,
  ResponseOutputItem,
  Tool
} from 'openai/resources/responses/responses'
import type { ConversationMessage, ConversationRequest, ConversationResult, SearchSource, StopReason } from '@shared/conversation'
import type { RoundUsage } from '@shared/ipc'
import type { ConversationLocale } from '@shared/conversation-locale'
import { effortFor } from '@shared/llm-catalog'
import { AdapterStream, parseToolArguments, statusError, toolResultText, withoutSchemaKeys, type JsonRequest, type ProviderAdapter } from './adapter'

/**
 * OpenAI, through the Responses API, because chat completions does not accept function tools and a
 * reasoning effort at the same time.
 *
 * - No conversation state is kept on the server (store: false), so the whole history goes into `input`
 *   on every request.
 * - The output items of a response (reasoning, message, function_call, web_search_call) are kept in
 *   `native` in order. A reasoning item holds the encrypted reasoning, and unless it is sent back
 *   across tool round trips and across turns the reasoning is lost and the prompt cache misses. It is
 *   sent back only to the same model, because another model cannot reuse it.
 * - A function call's arguments are complete when its item completes, so a tool can start before the
 *   response ends.
 * - Text produced with web search carries citations inline in the form `([title](URL))`. They are
 *   stripped because the text is spoken aloud; the sources reach the UI through the search event
 *   instead, and `native` keeps the text as it arrived.
 */

const PROVIDER = 'openai'

let cached: { key: string; client: OpenAI } | null = null
function clientFor(key: string): OpenAI {
  if (cached?.key !== key) cached = { key, client: new OpenAI({ apiKey: key, maxRetries: 0 }) }
  return cached.client
}

export function toResponsesInput(messages: readonly ConversationMessage[], model: string, locale: ConversationLocale): ResponseInputItem[] {
  const input: ResponseInputItem[] = []
  for (const message of messages) {
    if (message.role === 'assistant') {
      if (message.native?.provider === PROVIDER && message.native.model === model) {
        input.push(...(message.native.payload as ResponseInputItem[]))
        continue
      }
      for (const part of message.parts) {
        if (part.type === 'text') input.push({ role: 'assistant', content: part.text })
        else if (part.type === 'tool_call') {
          input.push({ type: 'function_call', call_id: part.id, name: part.name, arguments: JSON.stringify(part.input) })
        }
      }
      continue
    }
    // Function results go right after their calls, and the text of the same user message follows them.
    const texts: string[] = []
    for (const part of message.parts) {
      if (part.type === 'tool_result') input.push({ type: 'function_call_output', call_id: part.callId, output: toolResultText(locale, part) })
      else if (part.type === 'text') texts.push(part.text)
    }
    if (texts.length > 0) input.push({ role: 'user', content: texts.join('\n\n') })
  }
  return input
}

/**
 * `strict` is set to false on purpose: ASIST's schemas have optional properties and do not meet the
 * conditions for strict mode, and leaving the flag out makes the API attempt strict mode and then drop
 * it silently.
 */
export function toResponsesTools(request: Pick<ConversationRequest, 'tools' | 'webSearch'>): Tool[] {
  const functions: FunctionTool[] = request.tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: withoutSchemaKeys(tool.inputSchema, ['$schema']),
    strict: false
  }))
  return request.webSearch ? [...functions, { type: 'web_search', search_context_size: 'low' }] : functions
}

const CITATION = /[ \t]*\(?\[[^\]\n]*\]\(https?:\/\/[^)\s]*\)\)?/g
/** How many characters may be held back while it is still undecided whether they are a citation; beyond that they are emitted as text. */
const CITATION_HOLD_MAX = 600

/** Removes citation links from the text deltas, holding back a partial link until it closes. */
export class CitationFilter {
  private pending = ''

  push(delta: string): string {
    this.pending = (this.pending + delta).replace(CITATION, '')
    const open = this.pending.search(/[ \t]*\(?\[|[ \t]*\($/)
    if (open === -1 || this.pending.length - open > CITATION_HOLD_MAX) return this.flush()
    const ready = this.pending.slice(0, open)
    this.pending = this.pending.slice(open)
    return ready
  }

  flush(): string {
    const rest = this.pending
    this.pending = ''
    return rest
  }
}

const uniqueSources = (sources: SearchSource[]): SearchSource[] => [...new Map(sources.map((source) => [source.url, source])).values()]

class OpenAIStream extends AdapterStream {
  private readonly items: ResponseOutputItem[] = []

  constructor(
    client: OpenAI,
    private readonly request: ConversationRequest
  ) {
    super()
    this.start(() => this.run(client))
  }

  protected nativeSnapshot(openText: string): ConversationMessage['native'] {
    // Text cut off mid-stream never became an item, so it is appended as assistant text to keep what was already spoken.
    const payload: unknown[] = [...this.items]
    if (openText) payload.push({ role: 'assistant', content: openText })
    return payload.length > 0 ? { provider: PROVIDER, model: this.request.model.id, payload } : undefined
  }

  private async run(client: OpenAI): Promise<ConversationResult> {
    const { request } = this
    const effort = effortFor(request.model)
    const tools = toResponsesTools(request)
    const params: ResponseCreateParamsStreaming = {
      model: request.model.id,
      instructions: request.system.map((layer) => layer.text).join('\n\n'),
      input: toResponsesInput(request.messages, request.model.id, request.locale),
      ...(tools.length > 0 ? { tools } : {}),
      ...(effort ? { reasoning: { effort } } : {}),
      include: ['reasoning.encrypted_content', 'web_search_call.action.sources'],
      max_output_tokens: request.maxTokens,
      store: false,
      stream: true
    }
    const stream = await client.responses.create(params, { signal: request.signal })

    const citations = request.webSearch ? new CitationFilter() : null
    const queries: string[] = []
    const cited: SearchSource[] = []
    const listed: SearchSource[] = []
    let refused = false
    let response: Response | null = null
    for await (const event of stream) {
      switch (event.type) {
        case 'response.output_text.delta':
          this.emitText(citations ? citations.push(event.delta) : event.delta)
          break
        case 'response.output_item.added':
          if (event.item.type === 'web_search_call') this.emitSearch({ phase: 'start' })
          break
        case 'response.output_text.annotation.added': {
          const annotation = event.annotation as { type?: string; url?: string; title?: string }
          if (annotation.type === 'url_citation' && annotation.url) cited.push({ url: annotation.url, title: annotation.title || annotation.url, cited: true })
          break
        }
        case 'response.refusal.done':
          refused = true
          break
        case 'response.output_item.done': {
          const item = event.item
          this.items.push(item)
          if (item.type === 'message') {
            if (citations) this.emitText(citations.flush())
            this.closeText()
          }
          else if (item.type === 'function_call') {
            this.emitToolCall({ type: 'tool_call', id: item.call_id, name: item.name, input: parseToolArguments(item.name, item.arguments) })
          } else if (item.type === 'web_search_call' && item.action.type === 'search') {
            const action = item.action as { query?: string; queries?: string[]; sources?: Array<{ url: string }> }
            queries.push(...(action.queries ?? (action.query ? [action.query] : [])))
            listed.push(...(action.sources ?? []).map((source) => ({ url: source.url, title: source.url })))
          }
          break
        }
        case 'response.completed':
        case 'response.incomplete':
          response = event.response
          break
        case 'response.failed': {
          // The stream closes normally on a failure, so the failure has to be raised here.
          const error = event.response.error
          const status = error?.code === 'rate_limit_exceeded' ? 429 : error?.code === 'server_error' ? 500 : 400
          throw statusError(status, `OpenAI: ${error?.code ?? 'failed'}: ${error?.message ?? 'the response failed'}`)
        }
        case 'error':
          throw new Error(`OpenAI: ${event.code ?? 'error'}: ${event.message}`)
      }
    }
    if (!response) throw new Error('OpenAI: the stream ended without a completion event')
    if (citations) this.emitText(citations.flush())
    this.closeText()
    if (this.items.some((item) => item.type === 'web_search_call')) {
      // Citations carry a title; without any citation the URLs the search returned are listed instead.
      this.emitSearch({ phase: 'done', query: queries[0] ?? '', sources: uniqueSources(cited.length > 0 ? cited : listed) })
    }

    const hasToolCall = this.parts.some((part) => part.type === 'tool_call')
    const incomplete = response.status === 'incomplete' ? response.incomplete_details?.reason : undefined
    const stop: StopReason = hasToolCall ? 'tool_calls' : incomplete === 'max_output_tokens' ? 'max_tokens' : incomplete === 'content_filter' || refused ? 'refusal' : 'end'
    if (incomplete && stop === 'end') throw new Error(`OpenAI: the response was cut short (${incomplete})`)

    return {
      message: { role: 'assistant', parts: [...this.parts], native: { provider: PROVIDER, model: request.model.id, payload: [...this.items] } },
      stop,
      usage: roundUsage(response.usage, this.items)
    }
  }
}

/** Every web_search_call item of the output is one billed search. */
function roundUsage(usage: OpenAI.Responses.ResponseUsage | undefined, output: readonly OpenAI.Responses.ResponseOutputItem[]): RoundUsage {
  const cachedTokens = usage?.input_tokens_details?.cached_tokens ?? 0
  return {
    input: Math.max((usage?.input_tokens ?? 0) - cachedTokens, 0),
    cacheRead: cachedTokens,
    cacheCreation: (usage?.input_tokens_details as { cache_write_tokens?: number } | undefined)?.cache_write_tokens ?? 0,
    output: usage?.output_tokens ?? 0,
    webSearches: output.filter((item) => item.type === 'web_search_call').length
  }
}

export const openaiAdapter: ProviderAdapter = {
  stream: (request, key) => new OpenAIStream(clientFor(key), request),

  async completeJson(request: JsonRequest, key: string) {
    const effort = effortFor(request.model)
    const response = await clientFor(key).responses.create(
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
    if (response.status !== 'completed') {
      throw new Error(`OpenAI: the JSON response did not complete (${response.incomplete_details?.reason ?? response.error?.message ?? response.status})`)
    }
    return { value: JSON.parse(response.output_text), usage: roundUsage(response.usage, response.output) }
  },

  async retrieveModel(id, key, signal) {
    await new OpenAI({ apiKey: key, maxRetries: 0 }).models.retrieve(id, { signal })
  },

  async listModels(key, signal) {
    await new OpenAI({ apiKey: key, maxRetries: 0 }).models.list({ signal })
  }
}
