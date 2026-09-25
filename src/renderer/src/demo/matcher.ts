/**
 * Rules that turn a typed utterance into the type and props of a card. The demo has no LLM, so these
 * rules stand in for one. The app itself does not use them: there, only the LLM's show_ tools open a
 * card (2026-09-21). Matching on whether a word appears is too coarse for the app, because an utterance
 * such as "予定通り進んでる" ("it is going as planned") opened today's calendar and "田中さんにメール送って"
 * ("send Tanaka a mail") opened the inbox, and a card matched on a finalized utterance never went away.
 */

export interface PanelMatch {
  type: string
  props: Record<string, unknown>
  note: string
}

const FX_PAIRS: Array<[RegExp, string, string]> = [
  [/ドル円|ドルいくら|ドルのレート/, 'USD', 'JPY'],
  [/ユーロ円|ユーロのレート/, 'EUR', 'JPY'],
  [/ポンド円/, 'GBP', 'JPY'],
  [/為替/, 'USD', 'JPY']
]

export function matchPanels(text: string): PanelMatch[] {
  const out: PanelMatch[] = []

  for (const [pattern, base, quote] of FX_PAIRS) {
    if (pattern.test(text)) {
      out.push({ type: 'fx', props: { base, quote }, note: `fx:${base}${quote}` })
      break
    }
  }

  if (/ニュース/.test(text)) {
    const topic = text.match(/([^。、\s]{1,10}?)の(?:最新)?ニュース/)?.[1] ?? 'トップ'
    out.push({ type: 'news', props: { topic }, note: `news:${topic}` })
  }

  const clockMatch = text.match(/([^。、\s]{2,12}?)(?:は|って)?今何時/)
  if (clockMatch) {
    out.push({ type: 'clock', props: { city: clockMatch[1] }, note: `clock:${clockMatch[1]}` })
  }

  if (/メール|未読/.test(text)) {
    const unreadOnly = /未読/.test(text)
    out.push({ type: 'mail', props: { unreadOnly }, note: unreadOnly ? 'mail:unread' : 'mail' })
  }

  // These rules only resolve today, this week and next week.
  if (/予定|カレンダー|スケジュール/.test(text) && !/先週|再来週|来月|先月|明日|明後日|昨日|一昨日|[0-9０-９一二三四五六七八九十]+(月|日)/.test(text)) {
    const range = /来週/.test(text) ? 'next-week' : /今週|週間|一週間/.test(text) ? 'week' : 'today'
    out.push({ type: 'calendar', props: { range }, note: `calendar:${range}` })
  }

  return out
}
