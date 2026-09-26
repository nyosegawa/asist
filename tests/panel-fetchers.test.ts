import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTranslator } from '@shared/i18n'
import { NEWS_TOP_TOPIC } from '@shared/panel-catalog'

const mocks = vi.hoisted(() => ({ conversationLocale: 'ja-JP', region: 'JP', roots: [] as string[] }))
vi.mock('../src/main/services/settings', () => ({
  getSettings: () => ({ uiLocale: 'ja-JP', conversationLocale: mocks.conversationLocale, region: mocks.region })
}))
vi.mock('electron', () => ({ app: { getVersion: () => '9.9.9' } }))
vi.mock('../src/main/services/agent', () => ({ allowedFileRoots: () => mocks.roots }))

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

describe('the files card (show_files)', () => {
  it('refuses a path whose .. climbs out of a symbolic link, and reads the path it checked', async () => {
    const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'asist-show-files-')))
    const root = path.join(base, 'root')
    mkdirSync(path.join(base, 'outside', 'sub'), { recursive: true })
    mkdirSync(path.join(root, 'docs'), { recursive: true })
    writeFileSync(path.join(base, 'outside', 'secret.txt'), 'outside')
    writeFileSync(path.join(root, 'secret.txt'), 'inside')
    symlinkSync(path.join(base, 'outside', 'sub'), path.join(root, 'link'))
    mocks.roots = [root]
    const { props } = await fetchPanel('files', { paths: [`${root}/link/../secret.txt`, `${root}/docs/../secret.txt`] })
    const items = props.items as Array<{ path: string; text?: string; error?: string }>
    expect(items[0]).toMatchObject({ error: createTranslator('ja-JP')('files.errors.outsideRoots') })
    expect(items[0].text).toBeUndefined()
    expect(items[1]).toMatchObject({ path: path.join(root, 'secret.txt'), text: 'inside' })
  })
})

describe('the news card', () => {
  it('reads an escaped ampersand in a news title as the text the feed wrote, not as a second escape', async () => {
    const item = '<item><title>5 &amp;lt; 6 &amp;amp; Q&amp;A</title><link>https://example.test</link><pubDate>x</pubDate><source>y</source></item>'
    respond(`<rss>${item}</rss>`, [])
    const { props } = await fetchPanel('news', { topic: 'AI' })
    expect((props.items as { title: string }[])[0].title).toBe('5 &lt; 6 &amp; Q&A')
  })
})
