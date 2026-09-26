import { z } from 'zod'
import type { JsonSchema, ToolSpec } from './conversation'
import type { PromptLanguage, PromptText } from './conversation-locale'

/**
 * The framework tools are registered in. A tool is one definition carrying its name, description,
 * input schema, run function, whether it may run in parallel, its time limit and the maximum length of
 * its result, and both the tool list sent to the model and the lookup table used at execution time
 * come from the same array. A failure or a timeout comes back as a result with isError rather than as
 * an exception, so the model can choose what to do next. Truncation happens in formatToolResult and
 * nowhere else.
 *
 * Every text the model reads exists in both prompt languages and is picked when the list for a turn is
 * built, never at import. A zod schema has one slot for a description, so both languages are packed
 * into that one string by `bilingual` and unpacked by `resolvePromptTexts` once the JSON Schema has
 * been generated. There is one schema per tool either way, and validation does not depend on the
 * language.
 */

/** The time limit for a fetcher that calls an external service. */
export const FETCHER_TIMEOUT_MS = 8_000
/** The time limit for work that stays local. */
export const LOCAL_TIMEOUT_MS = 2_000

/**
 * Packs both prompt languages into a single string, for the places that hold one string and cannot
 * hold a pair: a zod `.describe()`, a note inside a tool's result, a ToolError message. The character
 * in front is from the Unicode private use area, so no text of either language can be mistaken for it.
 */
const BILINGUAL_PREFIX = '\uE000bilingual:'
export const bilingual = (text: PromptText): string => `${BILINGUAL_PREFIX}${JSON.stringify(text)}`

/** Replaces every packed pair inside a value, however deeply nested, with the text of one language. */
export function resolvePromptTexts<T>(value: T, language: PromptLanguage): T {
  if (typeof value === 'string') {
    if (!value.startsWith(BILINGUAL_PREFIX)) return value
    return (JSON.parse(value.slice(BILINGUAL_PREFIX.length)) as PromptText)[language] as unknown as T
  }
  if (Array.isArray(value)) return value.map((item) => resolvePromptTexts(item, language)) as unknown as T
  // Only a plain object is rebuilt; anything with a prototype of its own, such as a Date, would lose
  // what it is.
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, resolvePromptTexts(item, language)])
    ) as T
  }
  return value
}

/**
 * The JSON Schema of a zod schema for a tool's input, as the model fills it in. zod writes the parsed
 * output by default, where a field with a default is required because parsing always fills it in, so
 * the model would be told to write a value the description says to leave out.
 */
export const inputJsonSchema = (schema: z.ZodType): JsonSchema => z.toJSONSchema(schema, { io: 'input' }) as JsonSchema

export interface ToolDefinition<Ctx = unknown> {
  name: string
  /**
   * The description sent to the model. The preconditions, when not to use the tool, the steps, the
   * postconditions and the shape of the result all belong here, not in the system prompt.
   */
  description: PromptText
  /**
   * The one sentence listed in the system prompt's section on choosing between tools. A tool without
   * one is left out of that section.
   */
  usage?: PromptText
  /**
   * The JSON Schema of the input. Its top level must be an object, because some providers reject a
   * schema that is not. Its descriptions may be packed pairs, which toolSpecs unpacks.
   */
  inputSchema: JsonSchema
  /**
   * Whether the tool is read-only and may run at the same time as the other reads of the same round.
   * A tool that writes anything is false.
   */
  parallel: boolean
  timeoutMs: number
  /** The maximum length of the result in characters. formatToolResult truncates beyond it. */
  maxResultChars: number
  /**
   * Returns a string or anything that can be turned into JSON, and throws on failure; a ToolError's
   * message reaches the model unchanged. The signal combines the caller's abort and the time limit.
   */
  run: (input: Record<string, unknown>, ctx: Ctx, signal: AbortSignal) => Promise<unknown> | unknown
}

/** A failure reported to the model. The message states what failed and how to get it right. */
export class ToolError extends Error {
  constructor(message: PromptText) {
    super(bilingual(message))
    this.name = 'ToolError'
  }
}

export interface ToolExecution {
  content: string
  isError: boolean
  durationMs: number
  /** The length in characters before truncation. */
  resultLength: number
  truncated: boolean
}

/**
 * The promise itself resolves even on a timeout, while `completion` waits until run's own work has
 * finished.
 */
export interface ToolExecutionTask extends Promise<ToolExecution> {
  readonly completion: Promise<void>
}

/** What this file says to the model, in both prompt languages. */
const TEXTS = {
  guideHeading: { ja: '# ツールの使い分け', en: '# Choosing between the tools' },
  cutMiddle: (chars: number): PromptText => ({
    ja: `[元は${chars}文字、途中を省略]`,
    en: `[${chars} characters in all; the middle is left out]`
  }),
  cutString: (chars: number): PromptText => ({ ja: `(元は${chars}文字)`, en: `(${chars} characters in all)` }),
  cutItems: (count: number): PromptText => ({ ja: `…他${count}件を省略`, en: `…${count} more items left out` }),
  cutJson: (chars: number): PromptText => ({
    ja: `[元は${chars}文字、配列の件数と長い文字列を省略]`,
    en: `[${chars} characters in all; arrays are shortened and long strings cut]`
  }),
  tooLarge: (chars: number, maxChars: number): PromptText => ({
    ja: `結果が大きすぎて返せない(${chars}文字、上限${maxChars}文字)。条件を絞って呼び直すこと。`,
    en: `The result is too large to return (${chars} characters, limit ${maxChars}). Narrow the request and call again.`
  }),
  unknownTool: (name: string): PromptText => ({
    ja: `ツール ${name} は存在しない。送られたツール一覧にある名前だけを使うこと。`,
    en: `There is no tool named ${name}. Use only the names in the tool list you were given.`
  }),
  timedOut: (name: string, seconds: number): PromptText => ({
    ja: `${name} は${seconds}秒以内に終わらなかった(時間切れ)。`,
    en: `${name} did not finish within ${seconds} seconds (timed out).`
  }),
  interrupted: (name: string): PromptText => ({
    ja: `${name} は実行中に中断された。`,
    en: `${name} was interrupted while running.`
  }),
  failed: (name: string, reason: string): PromptText => ({
    ja: `${name} の実行に失敗した: ${reason}。入力を見直すか、別の手段を選ぶこと。`,
    en: `${name} failed: ${reason}. Check the input or choose another way.`
  })
} as const

export function toToolSpec(def: ToolDefinition<never>, language: PromptLanguage): ToolSpec {
  return {
    name: def.name,
    description: def.description[language],
    inputSchema: resolvePromptTexts(def.inputSchema, language)
  }
}

export interface ToolGuideEntry {
  name: string
  usage: PromptText
}

/**
 * Builds the system prompt's section on choosing between tools out of the registrations, so adding a
 * tool adds its line and removing one takes its line away. The details of how to use a tool live in
 * that tool's own description; this section carries one sentence about when to reach for it.
 */
export function renderToolGuide(entries: readonly ToolGuideEntry[], language: PromptLanguage): string {
  return [
    TEXTS.guideHeading[language],
    ...entries.map((entry) => `- ${entry.name}: ${entry.usage[language]}`)
  ].join('\n')
}

/**
 * Drops the middle and keeps the beginning and the end, with a first line saying that something was
 * left out.
 */
export function truncateMiddle(
  text: string,
  maxChars: number,
  language: PromptLanguage
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  const header = `${TEXTS.cutMiddle(text.length)[language]}\n`
  const budget = Math.max(0, maxChars - header.length - '\n…\n'.length)
  const head = Math.ceil(budget / 2)
  const tail = Math.floor(budget / 2)
  return {
    text: `${header}${text.slice(0, head)}\n…\n${tail > 0 ? text.slice(text.length - tail) : ''}`,
    truncated: true
  }
}

interface ShrinkLimits {
  /** How many items of an array to keep. */
  arrayItems: number
  /** The maximum length of a string leaf. */
  stringChars: number
}

/**
 * Cuts an array down by count, noting how many items were left out, and cuts the end off a long
 * string leaf. The structure of the JSON stays intact.
 */
function shrink(
  value: unknown,
  limits: ShrinkLimits,
  language: PromptLanguage
): { value: unknown; changed: boolean } {
  if (typeof value === 'string') {
    if (value.length <= limits.stringChars) return { value, changed: false }
    return {
      value: `${value.slice(0, limits.stringChars)}…${TEXTS.cutString(value.length)[language]}`,
      changed: true
    }
  }
  if (Array.isArray(value)) {
    let changed = false
    const kept = value.slice(0, limits.arrayItems).map((item) => {
      const result = shrink(item, limits, language)
      changed ||= result.changed
      return result.value
    })
    if (value.length > limits.arrayItems) {
      kept.push(TEXTS.cutItems(value.length - limits.arrayItems)[language])
      changed = true
    }
    return { value: kept, changed }
  }
  if (value && typeof value === 'object') {
    let changed = false
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const result = shrink(item, limits, language)
      changed ||= result.changed
      out[key] = result.value
    }
    return { value: out, changed }
  }
  return { value, changed: false }
}

const INITIAL_LIMITS: ShrinkLimits = { arrayItems: 20, stringChars: 400 }
const MIN_LIMITS: ShrinkLimits = { arrayItems: 1, stringChars: 24 }

/**
 * Turns a tool's result into the string that goes into tool_result. A string is used as it is, with
 * the middle dropped when it exceeds the limit. An object becomes JSON, and when that exceeds the
 * limit the array counts and string lengths are shrunk step by step until it fits, so the JSON is
 * never cut off mid-structure.
 */
export function formatToolResult(
  value: unknown,
  maxChars: number,
  language: PromptLanguage
): { content: string; truncated: boolean; resultLength: number } {
  if (typeof value === 'string') {
    const result = truncateMiddle(value, maxChars, language)
    return { content: result.text, truncated: result.truncated, resultLength: value.length }
  }
  if (value === undefined) return { content: '', truncated: false, resultLength: 0 }
  const full = JSON.stringify(value)
  if (full.length <= maxChars) return { content: full, truncated: false, resultLength: full.length }
  let limits = { ...INITIAL_LIMITS }
  for (;;) {
    const shrunk = shrink(value, limits, language)
    const text = JSON.stringify(shrunk.value)
    if (text.length <= maxChars) {
      return {
        content: `${TEXTS.cutJson(full.length)[language]}\n${text}`,
        truncated: true,
        resultLength: full.length
      }
    }
    if (limits.arrayItems <= MIN_LIMITS.arrayItems && limits.stringChars <= MIN_LIMITS.stringChars) {
      throw new ToolError(TEXTS.tooLarge(full.length, maxChars))
    }
    limits = {
      arrayItems: Math.max(MIN_LIMITS.arrayItems, Math.floor(limits.arrayItems / 2)),
      stringChars: Math.max(MIN_LIMITS.stringChars, Math.floor(limits.stringChars / 2))
    }
  }
}

export interface ToolRegistry<Ctx> {
  definitions: ReadonlyArray<ToolDefinition<Ctx>>
  find(name: string): ToolDefinition<Ctx> | undefined
  /** The tool list sent to the model, built from the same array that execution looks names up in. */
  toolSpecs(language: PromptLanguage): ToolSpec[]
}

export function createToolRegistry<Ctx>(definitions: ReadonlyArray<ToolDefinition<Ctx>>): ToolRegistry<Ctx> {
  const byName = new Map<string, ToolDefinition<Ctx>>()
  for (const def of definitions) {
    if (byName.has(def.name)) throw new Error(`duplicate tool definition: ${def.name}`)
    byName.set(def.name, def)
  }
  return {
    definitions,
    find: (name) => byName.get(name),
    toolSpecs: (language) => definitions.map((def) => toToolSpec(def as ToolDefinition<never>, language))
  }
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Runs one tool and produces the content for its tool_result. An exception or a timeout becomes a
 * result with isError rather than failing the turn, and a stop caused by the caller's signal comes
 * back as a result saying the tool was interrupted.
 */
export function executeTool<Ctx>(
  registry: ToolRegistry<Ctx>,
  name: string,
  input: Record<string, unknown>,
  ctx: Ctx,
  signal: AbortSignal,
  language: PromptLanguage,
  now: () => number = Date.now
): ToolExecutionTask {
  const startedAt = now()
  const failure = (message: string): ToolExecution => ({
    content: message,
    isError: true,
    durationMs: now() - startedAt,
    resultLength: message.length,
    truncated: false
  })
  const def = registry.find(name)
  if (!def) {
    return Object.assign(Promise.resolve(failure(TEXTS.unknownTool(name)[language])), {
      completion: Promise.resolve()
    })
  }

  const timeout = new AbortController()
  const combined = AbortSignal.any([signal, timeout.signal])
  const timer = setTimeout(
    () => timeout.abort(new ToolError(TEXTS.timedOut(def.name, def.timeoutMs / 1000))),
    def.timeoutMs
  )
  let rejectAbort!: (reason: unknown) => void
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject })
  const onAbort = (): void => rejectAbort(combined.reason)
  combined.addEventListener('abort', onAbort, { once: true })
  if (combined.aborted) onAbort()
  const operation = Promise.resolve().then(() => {
    combined.throwIfAborted()
    return def.run(input, ctx, combined)
  })
  const completion = operation.then(() => undefined, () => undefined)
  const response = Promise.race([operation, aborted])
    .then((value): ToolExecution => ({
      ...formatToolResult(resolvePromptTexts(value, language), def.maxResultChars, language),
      isError: false,
      durationMs: now() - startedAt
    }))
    .catch((err): ToolExecution => {
      if (signal.aborted) return failure(TEXTS.interrupted(def.name)[language])
      if (err instanceof ToolError) return failure(resolvePromptTexts(err.message, language))
      return failure(TEXTS.failed(def.name, resolvePromptTexts(errMessage(err), language))[language])
    })
    .finally(() => {
      clearTimeout(timer)
      combined.removeEventListener('abort', onAbort)
    })
  return Object.assign(response, { completion })
}
