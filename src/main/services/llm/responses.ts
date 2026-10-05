import type OpenAI from 'openai'
import type {
  FunctionTool,
  Response,
  ResponseCreateParamsStreaming,
  ResponseInputItem,
  ResponseOutputItem,
  ResponseStreamEvent,
  Tool
} from 'openai/resources/responses/responses'
import type { ConversationMessage, ConversationRequest, ConversationResult, SearchSource, StopReason } from '@shared/conversation'
import type { RoundUsage } from '@shared/ipc'
import { promptText, type ConversationLocale, type PromptText } from '@shared/conversation-locale'
import { effortFor } from '@shared/llm-catalog'
import { AdapterStream, parseToolArguments, streamCutOff, toolResultText, withoutSchemaKeys } from './adapter'
import { streamFailure } from './openai-stream'

/**
 * OpenAI's Responses API, which both the OpenAI and the ChatGPT adapters speak. Chat completions is not used
 * because it does not accept function tools and a reasoning effort at the same time.
 *
 * - No conversation state is kept on the server (store: false), so the whole history goes into `input`
 *   on every request.
 * - The output items of a response (reasoning, message, function_call, web_search_call) are kept in
 *   `native` in order. A reasoning item holds the encrypted reasoning, and unless it is sent back
 *   across tool round trips and across turns the reasoning is lost and the prompt cache misses. It is
 *   sent back only to the same model of the same provider, because another cannot reuse it.
 * - A function call's arguments are complete when its item completes, so a tool can start before the
 *   response ends.
 * - Text produced with web search carries citations inline in the form `([title](URL))`. They are
 *   stripped because the text is spoken aloud; the sources reach the UI through the search event
 *   instead, and `native` keeps the text as it arrived.
 */

/** How one provider's Responses API differs from the other's. */
export interface ResponsesDialect {
  provider: 'openai' | 'chatgpt'
  /** The name that prefixes the provider's errors in the log. */
  label: string
  /** The namespace function tools are grouped in, or null to list them at the top level. */
  toolNamespace: string | null
  /** Whether a request may cap its output with max_output_tokens. */
  capsOutput: boolean
  /** The prompt_cache_key that keeps requests together on the cache, or null to send none. */
  cacheKey: string | null
}

/** Where the events of a request come from. It throws for a request refused before any event. */
export type ResponsesSource = (params: ResponseCreateParamsStreaming, signal: AbortSignal) => Promise<AsyncIterable<ResponseStreamEvent>>

const TOOL_NAMESPACE_DESCRIPTION: PromptText = {
  ja: 'このコンピュータにいる音声アシスタント ASIST のツール。',
  en: 'The tools of ASIST, the voice assistant on this computer.'
}

/**
 * The output items of a response that can go back to the model. The API refuses a reasoning item unless
 * the item that followed it in its response comes right after it, recognized by that item's id (400,
 * "provided without its required following item"). A response cut off by a broken stream or the output
 * limit keeps reasoning whose item never completed, or the text cut off after it without an id, so such
 * reasoning is left out however the response was stored.
 */
function withPairedReasoning(items: readonly ResponseInputItem[]): ResponseInputItem[] {
  const kept: ResponseInputItem[] = []
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]
    const next = kept[0] as { id?: unknown } | undefined
    if (item.type === 'reasoning' && typeof next?.id !== 'string') continue
    kept.unshift(item)
  }
  return kept
}

export function toResponsesInput(
  messages: readonly ConversationMessage[],
  model: string,
  locale: ConversationLocale,
  dialect: ResponsesDialect
): ResponseInputItem[] {
  const input: ResponseInputItem[] = []
  for (const message of messages) {
    if (message.role === 'assistant') {
      if (message.native?.provider === dialect.provider && message.native.model === model) {
        input.push(...withPairedReasoning(message.native.payload as ResponseInputItem[]))
        continue
      }
      for (const part of message.parts) {
        if (part.type === 'text') input.push({ role: 'assistant', content: part.text })
        else if (part.type === 'tool_call') {
          input.push({
            type: 'function_call',
            call_id: part.id,
            name: part.name,
            ...(dialect.toolNamespace ? { namespace: dialect.toolNamespace } : {}),
            arguments: JSON.stringify(part.input)
          })
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
export function toResponsesTools(request: Pick<ConversationRequest, 'tools' | 'webSearch' | 'locale'>, dialect: ResponsesDialect): Tool[] {
  const functions: FunctionTool[] = request.tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: withoutSchemaKeys(tool.inputSchema, ['$schema']),
    strict: false
  }))
  const grouped: Tool[] =
    dialect.toolNamespace && functions.length > 0
      ? [{ type: 'namespace', name: dialect.toolNamespace, description: promptText(request.locale, TOOL_NAMESPACE_DESCRIPTION), tools: functions }]
      : functions
  return request.webSearch ? [...grouped, { type: 'web_search', search_context_size: 'low' }] : grouped
}

const CITATION = /[ \t]*\(?\[[^\]\n]*\]\(https?:\/\/[^)\s]*\)\)?/g
/**
 * The start of a citation that is still being written at the end of the text: an opening parenthesis, a
 * title in brackets followed by as much of `(https://…` as has arrived, or a whole link inside an opening
 * parenthesis whose closing one has not arrived yet. Brackets that closed without `(` after them, or `(`
 * without the scheme, can no longer become a citation and do not match.
 */
const PARTIAL_CITATION =
  /[ \t]*(?:\(|\(\[[^\]\n]*\]\(https?:\/\/[^)\s]*\)|\(?\[[^\]\n]*(?:\](?:\((?:h(?:t(?:t(?:p(?:s?(?::(?:\/(?:\/[^)\s]*)?)?)?)?)?)?)?)?)?)?)$/
/** How many characters may be held back while it is still undecided whether they are a citation; beyond that they are emitted as text. */
const CITATION_HOLD_MAX = 600

/** Removes citation links from the text deltas, holding back a partial link until it closes. */
export class CitationFilter {
  private pending = ''

  push(delta: string): string {
    this.pending += delta
    const open = this.pending.search(PARTIAL_CITATION)
    if (open === -1 || this.pending.length - open > CITATION_HOLD_MAX) return this.flush()
    const ready = this.pending.slice(0, open)
    this.pending = this.pending.slice(open)
    return ready.replace(CITATION, '')
  }

  flush(): string {
    const rest = this.pending
    this.pending = ''
    return rest.replace(CITATION, '')
  }
}

const uniqueSources = (sources: SearchSource[]): SearchSource[] => [...new Map(sources.map((source) => [source.url, source])).values()]

/**
 * One response read from its events, whichever way they arrive: the HTTP stream of OpenAI's API or the
 * WebSocket that ChatGPT's plan answers on.
 */
export class ResponsesStream extends AdapterStream {
  private readonly items: ResponseOutputItem[] = []

  constructor(
    private readonly dialect: ResponsesDialect,
    source: Promise<ResponsesSource>,
    private readonly request: ConversationRequest
  ) {
    super()
    this.start(() => source.then((ready) => this.run(ready)))
  }

  protected nativeSnapshot(openText: string): ConversationMessage['native'] {
    // Text cut off mid-stream never became an item, so it is appended as assistant text to keep what was already spoken.
    const payload: unknown[] = [...this.items]
    if (openText) payload.push({ role: 'assistant', content: openText })
    return payload.length > 0 ? { provider: this.dialect.provider, model: this.request.model.id, payload } : undefined
  }

  private async run(source: ResponsesSource): Promise<ConversationResult> {
    const { request, dialect } = this
    const effort = effortFor(request.model)
    const tools = toResponsesTools(request, dialect)
    const params: ResponseCreateParamsStreaming = {
      model: request.model.id,
      instructions: request.system.map((layer) => layer.text).join('\n\n'),
      input: toResponsesInput(request.messages, request.model.id, request.locale, dialect),
      ...(tools.length > 0 ? { tools } : {}),
      ...(effort ? { reasoning: { effort } } : {}),
      include: ['reasoning.encrypted_content', 'web_search_call.action.sources'],
      ...(dialect.capsOutput ? { max_output_tokens: request.maxTokens } : {}),
      ...(dialect.cacheKey ? { prompt_cache_key: dialect.cacheKey } : {}),
      store: false,
      stream: true
    }
    const stream = await source(params, request.signal)

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
          // A function call the output limit cut off ends incomplete with its arguments cut short. It is
          // neither run nor sent back, since a call without its result is refused, and the response ends
          // on max_tokens.
          if (item.type === 'function_call' && item.status === 'incomplete') break
          if (item.type === 'function_call') {
            // The arguments are read before the call joins the output: one that fails to parse is never
            // handed to the turn, which so has no result for it, and a call sent back without its result
            // is refused.
            const input = parseToolArguments(item.name, item.arguments)
            this.items.push(item)
            this.emitToolCall({ type: 'tool_call', id: item.call_id, name: item.name, input })
            break
          }
          this.items.push(item)
          if (item.type === 'message') {
            if (citations) this.emitText(citations.flush())
            this.closeText()
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
        case 'response.failed':
          // The stream closes normally on a failure, so the failure has to be raised here.
          throw streamFailure(dialect.label, event.response.error?.code, event.response.error?.message)
        case 'error':
          throw streamFailure(dialect.label, event.code, event.message)
      }
    }
    if (!response) streamCutOff(request.signal, dialect.label)
    if (citations) this.emitText(citations.flush())
    this.closeText()
    if (this.items.some((item) => item.type === 'web_search_call')) {
      // Citations carry a title; without any citation the URLs the search returned are listed instead.
      this.emitSearch({ phase: 'done', query: queries[0] ?? '', sources: uniqueSources(cited.length > 0 ? cited : listed) })
    }

    const hasToolCall = this.parts.some((part) => part.type === 'tool_call')
    const incomplete = response.status === 'incomplete' ? response.incomplete_details?.reason : undefined
    const stop: StopReason = incomplete === 'max_output_tokens' ? 'max_tokens' : hasToolCall ? 'tool_calls' : incomplete === 'content_filter' || refused ? 'refusal' : 'end'
    if (incomplete && stop === 'end') throw new Error(`${dialect.label}: the response was cut short (${incomplete})`)

    return {
      message: { role: 'assistant', parts: [...this.parts], native: { provider: dialect.provider, model: request.model.id, payload: [...this.items] } },
      stop,
      usage: roundUsage(response.usage, this.items)
    }
  }
}

/** The input tokens count the ones read from and written to the cache as well. Every web_search_call item of the output is one billed search. */
export function roundUsage(usage: OpenAI.Responses.ResponseUsage | undefined, output: readonly OpenAI.Responses.ResponseOutputItem[]): RoundUsage {
  const cachedTokens = usage?.input_tokens_details?.cached_tokens ?? 0
  const writtenTokens = usage?.input_tokens_details?.cache_write_tokens ?? 0
  return {
    input: Math.max((usage?.input_tokens ?? 0) - cachedTokens - writtenTokens, 0),
    cacheRead: cachedTokens,
    cacheCreation: writtenTokens,
    output: usage?.output_tokens ?? 0,
    webSearches: output.filter((item) => item.type === 'web_search_call').length
  }
}
