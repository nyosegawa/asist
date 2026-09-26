import {
  CONVERSATION_LANGUAGE_NAMES,
  fillPrompt,
  promptLanguage,
  promptText,
  type ConversationLocale,
  type PromptLanguage,
  type PromptText
} from '@shared/conversation-locale'
import { effortOptions, type ConversationModel } from '@shared/llm-catalog'
import { estimateTokens } from '@shared/token-estimate'
import { completeText } from '../llm'
import { conversationLocale } from '../conversation-locale'
import { getSettings } from '../settings'

/**
 * The summarizer that compacts the history. It runs on the conversation model, not the bridge model,
 * and writes a handover under five headings, as if another conversation were picking the work up. An
 * existing summary is rewritten together with the new conversation rather than appended to, so the
 * length stays bounded, and nothing truncates the result by length.
 */

/**
 * The length the prompt asks the summary to stay under, in the unit of the language it is written in:
 * 5000 Japanese characters and 2500 English words carry about the same amount of a summary like this,
 * and both stay inside SUMMARY_MAX_TOKENS.
 */
export const SUMMARY_BUDGET: Readonly<Record<PromptLanguage, number>> = { ja: 5000, en: 2500 }

/** How long a summary is in the unit of its budget: characters in Japanese, words in the languages the English prompt serves. */
const summaryLength = (language: PromptLanguage, text: string): number =>
  language === 'ja' ? text.length : text.split(/\s+/).filter(Boolean).length

const HANDOFF: PromptText = {
  ja: `あなたは音声アシスタントの会話ログを、別の会話(同じアシスタント)が途中から引き継ぐための要約にする。
次の五つの見出しで、日本語の簡潔な箇条書きにする。該当が無い見出しは「なし」と書く。
1. 話題と進捗
2. 決まったこと
3. ユーザーの好みと制約
4. 未解決と次の一手
5. 約束と具体データ(日付、名前、数値、パス)
引き継ぎに要ることは落とさず、要らないことは書かない。推測を足さず、ログにあることだけを書く。見出し以外の前置きや後書きは書かない。
既存の要約があるときは追記ではなくまとめ直す。済んだ話題や古くなった詳細は短く畳み、全体を {budget} 字以内に収める。要約は会話が続く限り何度も作り直されるので、回を重ねても長くならないようにする。
「(ツール 名前 入力)」の行は、その場でアシスタントが使った道具と入力(パス、id、日付など)で、あとで同じものを指すのに要る値は「約束と具体データ」に残す。`,
  en: `You turn the conversation log of a voice assistant into the summary another conversation, the same assistant, picks the work up from.
Write concise bullet points in {language}, under these five headings. A heading with nothing under it says so in one word.
1. Topics and where they stand
2. What was decided
3. The user's preferences and constraints
4. What is open, and the next move
5. Promises and concrete data (dates, names, numbers, paths)
Leave out nothing the handover needs and write nothing it does not. Add no inference: write only what is in the log. No preamble and no closing remark outside the headings.
When a summary already exists, rewrite it rather than append to it. Fold finished topics and stale detail into a line each, and keep the whole under {budget} words. The summary is rebuilt again and again for as long as the conversation runs, so it must not grow with each pass.
A line reading "(tool name input)" is a tool the assistant used at that point and what it was given (a path, an id, a date). Any value that is needed later to name the same thing again belongs under promises and concrete data.`
}

const HANDOFF_USER: PromptText = {
  ja: `# 既存の要約\n{existing}\n\n# 追加の会話\n{log}\n\n両方を統合した新しい要約だけを出力する。`,
  en: `# The existing summary\n{existing}\n\n# The conversation since\n{log}\n\nOutput only the new summary that merges the two.`
}

const HANDOFF_USER_FIRST: PromptText = {
  ja: `# 会話\n{log}\n\n要約だけを出力する。`,
  en: `# The conversation\n{log}\n\nOutput only the summary.`
}

/** The system prompt of the handover summary, in the language the conversation is held in. */
export const handoffSystem = (locale: ConversationLocale): string =>
  fillPrompt(promptText(locale, HANDOFF), {
    language: CONVERSATION_LANGUAGE_NAMES[locale],
    budget: String(SUMMARY_BUDGET[promptLanguage(locale)])
  })

/**
 * The output limit in tokens. Every provider counts thinking against it, so it has to hold the longest
 * summary accepted, twice the budget, and the thinking before it, or a summary within its budget could
 * be cut off and refused every time. Twice the Japanese budget is about 9,700 tokens on Claude's
 * tokenizer, the one that spends the most tokens on a Japanese character of those measured (1.028
 * characters a token; Legalscape, September 2026). That leaves over 6,600 tokens for thinking at the
 * shallowest depth, where the summary runs, more than six times the thousand tokens Claude 5 thought
 * before a voice reply at its default depth, which is high (measured on 2026-09-20).
 */
export const SUMMARY_MAX_TOKENS = 16_384

/**
 * How long a summary of an input of this size may take. No turn waits for it, so the limit only has
 * to end a call that hangs, and must never cut one that is still working. The time goes into reading
 * the input and writing up to the output limit, thinking included, so both are counted:
 *
 * - Reading takes at most 0.324 seconds per 10,000 tokens, GPT-5.6 Sol's cost near 1M tokens; Claude
 *   Opus 5 takes 0.218 at every length (Epoch AI, September 2026). estimateTokens counts Japanese about
 *   a quarter lower than Claude's tokenizer does, which the gap between those two costs covers.
 * - Writing goes at three quarters of 59.6 tokens a second, the median of the slowest model, Claude
 *   Opus 5 at low effort, the depth the summary runs at (Artificial Analysis, over 72 hours, checked
 *   2026-09-26), because half of the calls run slower than a median. A summary at its Japanese budget, about 4,900 tokens on Claude,
 *   takes 85 seconds at the median itself.
 * - 3 seconds go before the first token, where that model takes 2.8 on a short input.
 *
 * A limit on the time between tokens would be no tighter: the adapters pass on no text while a model
 * thinks, so the first gap would need the whole allowance for thinking, which only the output limit
 * bounds.
 */
export function summaryTimeoutMs(inputTokens: number): number {
  return Math.ceil(3 + (inputTokens / 10_000) * 0.324 + SUMMARY_MAX_TOKENS / (0.75 * 59.6)) * 1000
}

/**
 * Merges an existing summary and the newer log into one handover summary, on the conversation model.
 * A summary that did not end on its own, such as one cut off by the output limit before its last
 * headings, or one more than twice as long as its budget, means the rewrite failed. It is refused, and
 * the history keeps both the previous summary and the turns.
 */
export async function summarizeHandoff(existingSummary: string, log: string): Promise<string> {
  const locale = conversationLocale()
  const template = promptText(locale, existingSummary ? HANDOFF_USER : HANDOFF_USER_FIRST)
  const user = fillPrompt(template, { existing: existingSummary, log })
  const system = handoffSystem(locale)
  const signal = AbortSignal.timeout(summaryTimeoutMs(estimateTokens(system + user)))
  const configured = getSettings().conversationModel
  // The summary thinks at the shallowest depth the model takes, the first of its options, whatever the
  // conversation uses: deep thinking could spend the output limit before the summary is written.
  const model: ConversationModel = { ...configured, effort: effortOptions(configured).at(0) }
  const { text, stop } = await completeText(model, locale, system, user, SUMMARY_MAX_TOKENS, signal, 'summary')
  if (stop !== 'end') throw new Error(`summary did not end on its own: ${stop}`)
  const summary = text.trim()
  if (!summary) throw new Error('summary is empty')
  const language = promptLanguage(locale)
  const length = summaryLength(language, summary)
  if (length > 2 * SUMMARY_BUDGET[language]) {
    throw new Error(`summary too long: ${length} ${language === 'ja' ? 'characters' : 'words'}`)
  }
  return summary
}
