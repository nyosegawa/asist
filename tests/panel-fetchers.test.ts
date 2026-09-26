import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NEWS_TOP_TOPIC } from '@shared/panel-catalog'
import { formatMessage } from '@shared/i18n'
import { readErrorText } from '@shared/i18n/error-text'

const mocks = vi.hoisted(() => ({
  conversationLocale: 'ja-JP',
  region: 'JP',
  searchCalendar: vi.fn(async (_query: { start: string; end: string }) => ({ events: [] }))
}))
vi.mock('../src/main/services/settings', () => ({
  getSettings: () => ({ uiLocale: 'ja-JP', conversationLocale: mocks.conversationLocale, region: mocks.region })
}))
vi.mock('../src/main/services/calendar', () => ({ searchCalendar: mocks.searchCalendar }))
vi.mock('../src/main/services/agent', () => ({ allowedFileRoots: () => ['/allowed'] }))
vi.mock('electron', () => ({ app: { getVersion: () => '9.9.9' } }))

type Fetch = ReturnType<typeof vi.fn>

function respond(body: unknown, urls: string[]): Fetch {
  const fetch = vi.fn(async (url: string) => {
    urls.push(String(url))
    return typeof body === 'string' ? new Response(body) : Response.json(body)
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

async function fetchPanel(type: string, props: Record<string, unknown>) {
  const { fetchPanel: run } = await import('../src/main/services/panel-fetchers')
  return run(type, props)
}

beforeEach(() => {
  vi.resetModules()
  mocks.conversationLocale = 'ja-JP'
  mocks.region = 'JP'
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the requests a card makes for the conversation language and the region', () => {
  it('asks Open-Meteo for place names in the conversation language', async () => {
    const urls: string[] = []
    respond({ results: [{ name: 'Berlin', latitude: 52.5, longitude: 13.4, timezone: 'Europe/Berlin', country: 'Deutschland' }] }, urls)
    mocks.conversationLocale = 'de-DE'
    await fetchPanel('clock', { city: 'Berlin' })
    expect(urls[0]).toContain('language=de')
  })

  it('looks a Japanese city up under its English name, with or without the suffix of a prefecture or a city', async () => {
    const urls: string[] = []
    respond({ results: [{ name: '京都市', latitude: 35, longitude: 135.7, timezone: 'Asia/Tokyo', country: '日本' }] }, urls)
    for (const city of ['京都', '京都府', '京都市']) await fetchPanel('clock', { city })
    expect(urls.map((url) => new URL(url).searchParams.get('name'))).toEqual(['Kyoto', 'Kyoto', 'Kyoto'])
  })

  it('looks up a city whose name is also a member of every object under that name', async () => {
    const urls: string[] = []
    respond({ results: [{ name: 'X', latitude: 0, longitude: 0, timezone: 'UTC' }] }, urls)
    for (const city of ['constructor', 'toString']) await fetchPanel('clock', { city })
    expect(urls.map((url) => new URL(url).searchParams.get('name'))).toEqual(['constructor', 'toString'])
  })

  it('keeps the Japanese request of the clock card unchanged', async () => {
    const urls: string[] = []
    respond({ results: [{ name: '東京都', latitude: 35.6, longitude: 139.6, timezone: 'Asia/Tokyo', country: '日本' }] }, urls)
    await fetchPanel('clock', { city: '東京都' })
    expect(urls).toEqual(['https://geocoding-api.open-meteo.com/v1/search?name=Tokyo&count=1&language=ja'])
  })

  it('takes the Google News edition from the language and the region', async () => {
    const urls: string[] = []
    const item = '<item><title>Titel</title><link>https://example.test</link><pubDate>x</pubDate><source>y</source></item>'
    respond(`<rss>${item}</rss>`, urls)
    mocks.conversationLocale = 'de-DE'
    mocks.region = 'AT'
    await fetchPanel('news', { topic: 'KI' })
    expect(urls[0]).toBe('https://news.google.com/rss/search?q=KI&hl=de&gl=AT&ceid=AT:de')
  })

  it('keeps the Japanese news request unchanged, including the one for the top stories', async () => {
    const urls: string[] = []
    const item = '<item><title>見出し</title><link>https://example.test</link><pubDate>x</pubDate><source>y</source></item>'
    respond(`<rss>${item}</rss>`, urls)
    await fetchPanel('news', { topic: NEWS_TOP_TOPIC })
    await fetchPanel('news', { topic: 'AI' })
    expect(urls).toEqual([
      'https://news.google.com/rss?hl=ja&gl=JP&ceid=JP:ja',
      'https://news.google.com/rss/search?q=AI&hl=ja&gl=JP&ceid=JP:ja'
    ])
  })

  it('quotes an exchange rate against the currency of the region', async () => {
    const urls: string[] = []
    respond({ result: 'success', rates: { JPY: 150, BRL: 5.2 }, time_last_update_utc: 'now' }, urls)
    expect((await fetchPanel('fx', { base: 'USD' })).props).toMatchObject({ quote: 'JPY', rate: 150 })
    mocks.region = 'BR'
    expect((await fetchPanel('fx', { base: 'USD' })).props).toMatchObject({ quote: 'BRL', rate: 5.2 })
  })

  it('says it does not know the currency of a region rather than quoting the rate against the yen', async () => {
    const urls: string[] = []
    respond({ result: 'success', rates: { JPY: 150 }, time_last_update_utc: 'now' }, urls)
    mocks.region = 'AT'
    await expect(fetchPanel('fx', { base: 'USD' })).rejects.toThrow('[asist:panels.errors.currencyUnknown {"region":"AT"}]')
    // A currency the user named is still quoted, whatever the region is.
    expect((await fetchPanel('fx', { base: 'USD', quote: 'JPY' })).props).toMatchObject({ quote: 'JPY' })
  })
})

describe('a card that cannot be filled', () => {
  it('names the service and the status of a failed request in a message the screen words', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('busy', { status: 503 })))
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['clock', { city: 'Berlin' }, 'geocoding-api.open-meteo.com'],
      ['fx', { base: 'USD', quote: 'EUR' }, 'open.er-api.com'],
      ['news', { topic: 'AI' }, 'news.google.com']
    ]
    for (const [type, props, host] of cases) {
      const error = (await fetchPanel(type, props).catch((err: unknown) => err)) as Error
      const known = readErrorText(error.message)
      expect(known, type).not.toBeNull()
      const text = formatMessage(known!.message, 'en-US', known!.values)
      expect(text).toContain(host)
      expect(text).toContain('503')
    }
  })

  it('refuses a clock without a city in a message the screen words', async () => {
    respond({ results: [] }, [])
    await expect(fetchPanel('clock', { city: ' ' })).rejects.toSatisfy((err: Error) => readErrorText(err.message) !== null)
  })

  it('names the files it could not show in a message the screen words', async () => {
    const error = (await fetchPanel('files', { paths: ['/elsewhere/report.pdf'] }).catch((err: unknown) => err)) as Error
    const known = readErrorText(error.message)
    expect(known).not.toBeNull()
    expect(formatMessage(known!.message, 'en-US', known!.values)).toContain('report.pdf')
  })

  it('words a place the table of Japan does not resolve for the weather card, naming the place', async () => {
    for (const location of ['東京タワー', '府中市']) {
      const error = (await fetchPanel('weather', { location }).catch((err: unknown) => err)) as Error
      const known = readErrorText(error.message)
      expect(known, location).not.toBeNull()
      expect(formatMessage(known!.message, 'en-US', known!.values)).toContain(location)
    }
  })
})

describe('the news card', () => {
  it('reads an escaped ampersand in a news title as the text the feed wrote, not as a second escape', async () => {
    const item = '<item><title>5 &amp;lt; 6 &amp;amp; Q&amp;A</title><link>https://example.test</link><pubDate>x</pubDate><source>y</source></item>'
    respond(`<rss>${item}</rss>`, [])
    const { props } = await fetchPanel('news', { topic: 'AI' })
    expect((props.items as { title: string }[])[0].title).toBe('5 &lt; 6 &amp; Q&A')
  })

  it('reads the publisher of an item from a source element that carries its url', async () => {
    const item =
      '<item><title>見出し - NHK</title><link>https://news.google.com/rss/articles/x</link>' +
      '<pubDate>Fri, 25 Sep 2026 01:00:00 GMT</pubDate><source url="https://www3.nhk.or.jp">NHK</source></item>'
    respond(`<rss><channel>${item}</channel></rss>`, [])
    const { props } = await fetchPanel('news', { topic: 'AI' })
    expect((props.items as { source: string }[])[0].source).toBe('NHK')
  })
})

describe('the calendar card', () => {
  // In New York, 2026-11-01 has 25 hours, so the week after 2026-10-26 lasts 7 days and one hour.
  let zone: string | undefined
  beforeEach(() => {
    zone = process.env.TZ
    process.env.TZ = 'America/New_York'
  })
  afterEach(() => {
    vi.useRealTimers()
    if (zone === undefined) delete process.env.TZ
    else process.env.TZ = zone
  })

  it('searches next week up to its last midnight when this week is asked for at the weekend, across a change of the clocks', async () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 24, 12), toFake: ['Date'] })
    await fetchPanel('calendar', { range: 'week' })
    expect(mocks.searchCalendar).toHaveBeenLastCalledWith(
      { start: new Date(2026, 9, 19).toISOString(), end: new Date(2026, 10, 2).toISOString() },
      expect.any(AbortSignal)
    )
  })
})
