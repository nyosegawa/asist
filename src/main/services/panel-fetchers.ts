import { errorText } from '@shared/i18n/error-text'
import { languageOf } from '@shared/conversation-locale'
import { conversationLocale, region } from './conversation-locale'
import { weatherPanelProps } from './weather'
import { withTimeoutSignal } from '@shared/abort'
import { includesNextWeek, resolveCalendarRange, summarizeCalendarEvents, type CalendarRange } from '@shared/calendar'
import { addDays } from '@shared/calendar-layout'
import { NEWS_TOP_TOPIC } from '@shared/panel-catalog'
import { searchCalendar } from './calendar'
import { getMailService } from './mail'
import { isPathAllowed, readFileItem } from './file-preview'
import { fileUrl } from '../file-protocol'
import type { FileItem } from '@shared/files'
import { allowedFileRoots } from './agent'
import { userAgent } from './user-agent'
import { t } from './i18n'

/**
 * The data fetchers of the built-in panels, which run in the main process and build, from external APIs
 * and local data, the props the renderer's Body receives. A failure is thrown, and the caller turns it
 * into the panel's error state.
 */

type Props = Record<string, unknown>
/** props is what the card renders. data is what goes back to the LLM, and props is sent as it is when data is omitted. */
type Fetched = { props: Props; source?: string; data?: unknown }
type Fetcher = (props: Props, signal: AbortSignal) => Promise<Fetched>

const request = async (url: string, signal: AbortSignal): Promise<Response> => {
  const res = await fetch(url, { signal, headers: { 'user-agent': userAgent() } })
  if (!res.ok) throw new Error(errorText('panels.errors.fetchFailed', { host: new URL(url).hostname, status: res.status }))
  return res
}

const json = async <T>(url: string, signal: AbortSignal): Promise<T> => (await (await request(url, signal)).json()) as T

interface GeoResult {
  name: string
  latitude: number
  longitude: number
  timezone: string
  country?: string
  admin1?: string
}

/** Open-Meteo's geocoding only resolves English or local names, so a Japanese place name is translated first. */
const JP_PLACES: Record<string, string> = {
  東京: 'Tokyo', 大阪: 'Osaka', 京都: 'Kyoto', 名古屋: 'Nagoya', 札幌: 'Sapporo',
  福岡: 'Fukuoka', 仙台: 'Sendai', 広島: 'Hiroshima', 横浜: 'Yokohama', 神戸: 'Kobe',
  那覇: 'Naha', 沖縄: 'Naha', 金沢: 'Kanazawa', 新潟: 'Niigata', 静岡: 'Shizuoka',
  岡山: 'Okayama', 熊本: 'Kumamoto', 鹿児島: 'Kagoshima', 長野: 'Nagano', 松本: 'Matsumoto',
  ニューヨーク: 'New York', ロサンゼルス: 'Los Angeles', サンフランシスコ: 'San Francisco',
  ロンドン: 'London', パリ: 'Paris', ベルリン: 'Berlin', ローマ: 'Rome',
  シンガポール: 'Singapore', ソウル: 'Seoul', 北京: 'Beijing', 上海: 'Shanghai',
  台北: 'Taipei', 香港: 'Hong Kong', バンコク: 'Bangkok', シドニー: 'Sydney',
  ドバイ: 'Dubai', ホノルル: 'Honolulu', バンクーバー: 'Vancouver'
}

async function geocodeOnce(name: string, signal: AbortSignal): Promise<GeoResult | null> {
  const data = await json<{ results?: GeoResult[] }>(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=${languageOf(conversationLocale())}`,
    signal
  )
  return data.results?.[0] ?? null
}

async function geocode(place: string, signal: AbortSignal): Promise<GeoResult> {
  const name = place.trim()
  // The suffix is dropped only after the name as given misses the table, or "京都" would be looked up as "京".
  const bare = name.replace(/(都|府|県|市)$/, '')
  const result = await geocodeOnce(JP_PLACES[name] ?? JP_PLACES[bare] ?? bare, signal)
  if (result) return result
  throw new Error(errorText('panels.errors.placeNotFound', { place }))
}

const weather: Fetcher = weatherPanelProps

const clock: Fetcher = async (props, signal) => {
  const city = String(props.city ?? '').trim()
  if (!city) throw new Error(errorText('panels.errors.cityMissing'))
  const geo = await geocode(city, signal)
  return {
    props: { city: geo.name, timezone: geo.timezone, country: geo.country ?? '' },
    source: geo.timezone
  }
}

/**
 * The currency a rate is quoted in when the user names only the other side, for the regions a
 * conversation language starts from. A region outside the table has no obvious currency, so the card
 * says so rather than quoting a rate against a country the user never chose.
 */
const REGION_CURRENCIES: Record<string, string> = {
  JP: 'JPY', US: 'USD', FR: 'EUR', DE: 'EUR', IN: 'INR', ID: 'IDR',
  IT: 'EUR', KR: 'KRW', BR: 'BRL', MX: 'MXN', ES: 'EUR'
}

const fx: Fetcher = async (props, signal) => {
  const base = String(props.base ?? 'USD').toUpperCase()
  const home = region()
  const currency = REGION_CURRENCIES[home]
  if (props.quote == null && !currency) {
    throw new Error(errorText('panels.errors.currencyUnknown', { region: home }))
  }
  const quote = String(props.quote ?? currency).toUpperCase()
  const data = await json<{ result: string; rates: Record<string, number>; time_last_update_utc: string }>(
    `https://open.er-api.com/v6/latest/${base}`,
    signal
  )
  if (data.result !== 'success' || !data.rates[quote]) throw new Error(errorText('panels.errors.rateUnavailable', { base, quote }))
  return {
    props: {
      base,
      quote,
      rate: data.rates[quote],
      amount: props.amount ?? null,
      asOf: data.time_last_update_utc
    },
    source: 'open.er-api.com'
  }
}

const news: Fetcher = async (props, signal) => {
  const topic = String(props.topic ?? NEWS_TOP_TOPIC).trim()
  // hl is the language of the edition, gl the country whose news it is, and ceid names both again.
  const language = languageOf(conversationLocale())
  const country = region()
  const edition = `hl=${language}&gl=${country}&ceid=${country}:${language}`
  const url =
    topic === NEWS_TOP_TOPIC
      ? `https://news.google.com/rss?${edition}`
      : `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&${edition}`
  const xml = await (await request(url, signal)).text()
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 6).map((m) => {
    const block = m[1]
    const pick = (tag: string): string => {
      // Google News writes the publisher as <source url="…">, so an element may carry attributes.
      const raw = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`))?.[1] ?? ''
      return raw
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        // Last, or the text "&lt;" that the feed escapes as "&amp;lt;" would be read as "<".
        .replace(/&amp;/g, '&')
        .trim()
    }
    return { title: pick('title'), url: pick('link'), date: pick('pubDate'), source: pick('source') }
  })
  if (items.length === 0) throw new Error(errorText('panels.errors.newsMissing', { topic }))
  return { props: { topic, items }, source: 'Google News' }
}

const calendar: Fetcher = async (props, signal) => {
  const now = new Date()
  const window = resolveCalendarRange(
    {
      range: typeof props.range === 'string' ? (props.range as CalendarRange) : undefined,
      from: typeof props.from === 'string' ? props.from : undefined,
      to: typeof props.to === 'string' ? props.to : undefined
    },
    now
  )
  const query = typeof props.query === 'string' && props.query.trim() ? props.query.trim() : undefined
  // Asked for "this week" on a weekend, the search reaches into next week in one call, while the card
  // still shows only the events inside this week.
  const searchUntilMs = includesNextWeek(now, window.range) ? addDays(new Date(window.untilMs), 7).getTime() : window.untilMs
  const result = await searchCalendar(
    { start: new Date(window.fromMs).toISOString(), end: new Date(searchUntilMs).toISOString(), ...(query ? { query } : {}) },
    signal
  )
  const events = result.events.filter((event) => event.start < window.untilMs)
  return {
    props: {
      range: window.range,
      fromMs: window.fromMs,
      untilMs: window.untilMs,
      ...(query ? { query } : {}),
      events: events.map((event) => ({ ...event, ongoing: event.start < window.fromMs }))
    },
    source: t('calendar.card.source'),
    data: summarizeCalendarEvents(conversationLocale(), result.events, now, window)
  }
}

/** How many messages the card shows, unread ones first and newest first within each group. */
const MAIL_CARD_LIMIT = 12

const mail: Fetcher = async (props) => {
  const service = getMailService()
  const status = service.status()
  if (!status.enabled || status.accounts.length === 0) throw new Error(errorText('panels.errors.mailOff'))
  const unreadOnly = props.unreadOnly === true
  const view = typeof props.view === 'string' ? props.view : 'inbox'
  const query = typeof props.query === 'string' ? props.query.trim() : ''
  const { messages, total } = service.list({ view, query, unreadOnly, limit: 200 })
  const sorted = [...messages].sort((a, b) => Number(b.unread) - Number(a.unread) || b.date - a.date).slice(0, MAIL_CARD_LIMIT)
  return {
    props: {
      unreadOnly,
      view,
      query,
      total,
      unread: status.unread,
      accounts: status.accounts.map((account) => ({ id: account.id, label: account.label, unread: account.unread, state: account.state })),
      messages: sorted
    },
    source: `IMAP · ${status.accounts.map((account) => account.label).join(' / ')}`
  }
}

/** The body limit for a single-message card. The rest is not shown even when the card is enlarged; the mail screen has it. */
const MAIL_MESSAGE_TEXT_MAX = 6_000

const mailMessage: Fetcher = async (props) => {
  const service = getMailService()
  const { message, text } = await service.read(String(props.id ?? ''))
  const label = service.status().accounts.find((account) => account.id === message.accountId)?.label ?? message.accountId
  return {
    props: { id: message.id, message, accountLabel: label, text: text.length > MAIL_MESSAGE_TEXT_MAX ? `${text.slice(0, MAIL_MESSAGE_TEXT_MAX)}\n${t('mailCards.message.textClipped')}` : text },
    source: `IMAP · ${label}`
  }
}

const files: Fetcher = async (props) => {
  const paths = Array.isArray(props.paths) ? props.paths.map(String) : []
  if (paths.length === 0) throw new Error(errorText('panels.errors.noPaths'))
  const roots = allowedFileRoots()
  const items: FileItem[] = paths.map((target) =>
    isPathAllowed(target, roots)
      ? readFileItem(target, fileUrl)
      : { path: target, name: target.slice(target.lastIndexOf('/') + 1), kind: 'binary', sizeBytes: 0, error: t('files.errors.outsideRoots') }
  )
  if (items.every((item) => item.error)) throw new Error(items.map((item) => `${item.name}: ${item.error}`).join(' / '))
  return { props: { ...props, paths, items }, source: items.length === 1 ? items[0].kind : t('files.source', { count: items.length }) }
}

export const FETCHERS: Record<string, Fetcher> = {
  calendar,
  mail,
  'mail-message': mailMessage,
  files,
  weather,
  clock,
  fx,
  news
}

/** Fetches a panel's data. A panel type with no fetcher passes its props straight through. */
export async function fetchPanel(
  type: string,
  props: Props,
  signal?: AbortSignal
): Promise<Fetched> {
  const fetcher = FETCHERS[type]
  if (!fetcher) return { props }
  return fetcher(props, withTimeoutSignal(signal, 12_000))
}
