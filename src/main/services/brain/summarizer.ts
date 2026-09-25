import {
  CONVERSATION_LANGUAGE_NAMES,
  fillPrompt,
  promptText,
  type ConversationLocale,
  type PromptText
} from '@shared/conversation-locale'
import { quickText } from '../llm'
import { conversationLocale } from '../conversation-locale'
import { getSettings } from '../settings'

/**
 * The summarizer that compacts the history. It runs on the conversation model, not the bridge model,
 * and writes a handover under five headings, as if another conversation were picking the work up. An
 * existing summary is rewritten together with the new conversation rather than appended to, so the
 * length stays bounded, and nothing truncates the result by length.
 *
 * The budget the prompt asks for is a length of the language it is written in: 5000 Japanese
 * characters and 2500 English words carry about the same amount of a summary like this, and both stay
 * inside SUMMARY_MAX_TOKENS.
 */

const HANDOFF: PromptText = {
  ja: `あなたは音声アシスタントの会話ログを、別の会話(同じアシスタント)が途中から引き継ぐための要約にする。
次の五つの見出しで、日本語の簡潔な箇条書きにする。該当が無い見出しは「なし」と書く。
1. 話題と進捗
2. 決まったこと
3. ユーザーの好みと制約
4. 未解決と次の一手
5. 約束と具体データ(日付、名前、数値、パス)
引き継ぎに要ることは落とさず、要らないことは書かない。推測を足さず、ログにあることだけを書く。見出し以外の前置きや後書きは書かない。
既存の要約があるときは追記ではなくまとめ直す。済んだ話題や古くなった詳細は短く畳み、全体を 5000 字以内に収める。要約は会話が続く限り何度も作り直されるので、回を重ねても長くならないようにする。
「(ツール 名前 入力)」の行は、その場でアシスタントが使った道具と入力(パス、id、日付など)で、あとで同じものを指すのに要る値は「約束と具体データ」に残す。`,
  en: `You turn the conversation log of a voice assistant into the summary another conversation, the same assistant, picks the work up from.
Write concise bullet points in {language}, under these five headings. A heading with nothing under it says so in one word.
1. Topics and where they stand
2. What was decided
3. The user's preferences and constraints
4. What is open, and the next move
5. Promises and concrete data (dates, names, numbers, paths)
Leave out nothing the handover needs and write nothing it does not. Add no inference: write only what is in the log. No preamble and no closing remark outside the headings.
When a summary already exists, rewrite it rather than append to it. Fold finished topics and stale detail into a line each, and keep the whole under 2500 words. The summary is rebuilt again and again for as long as the conversation runs, so it must not grow with each pass.
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
  fillPrompt(promptText(locale, HANDOFF), { language: CONVERSATION_LANGUAGE_NAMES[locale] })

/**
 * The output limit in tokens, with enough room that the length the prompt asks for is not cut off. The
 * text itself is never truncated: a summary that comes back too long is skipped by history instead.
 */
export const SUMMARY_MAX_TOKENS = 8192

/** Merges an existing summary and the newer log into one handover summary, on the conversation model. */
export async function summarizeHandoff(existingSummary: string, log: string): Promise<string> {
  const locale = conversationLocale()
  const template = promptText(locale, existingSummary ? HANDOFF_USER : HANDOFF_USER_FIRST)
  const user = fillPrompt(template, { existing: existingSummary, log })
  const summary = (await quickText(handoffSystem(locale), user, SUMMARY_MAX_TOKENS, undefined, getSettings().conversationModel, 'summary')).trim()
  if (!summary) throw new Error('summary is empty')
  return summary
}
