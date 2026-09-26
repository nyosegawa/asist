import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import forecast from './fixtures/weather/tokyo-forecast.json'
import hourly from './fixtures/weather/tokyo-hourly.json'
import { resolveWeatherLocation } from '../src/main/services/weather/locations'

const mocks = vi.hoisted(() => ({ settings: { region: 'JP', conversationLocale: 'ja-JP' } }))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => mocks.settings }))
vi.mock('electron', () => ({ app: { getVersion: () => '9.9.9' } }))

const location = resolveWeatherLocation('東京都')
if ('status' in location) throw new Error(location.status)
const resolved = location
beforeEach(() => {
  vi.resetModules()
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-15T17:25:00+09:00'))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function request(fail?: string) {
  const fetch = vi.fn(async (url: string) => {
    if (fail && url.includes(fail)) return new Response('', { status: 503 })
    if (url.endsWith('/latest_time.txt')) return new Response('2026-09-15T17:20:00+09:00')
    if (url.includes('/point/'))
      return Response.json({ '20260915172000': { temp: [25.5, 0], humidity: [81, 0] } })
    return Response.json(url.includes('/VPFD/') ? hourly : forecast)
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}
describe('weather fetch service', () => {
  it('separates the observation time from the forecast time and fetches the block of the station it needs', async () => {
    const fetch = request()
    const { fetchWeather } = await import('../src/main/services/weather')
    const w = await fetchWeather(resolved, 'today', new AbortController().signal)
    expect(w.observation).toMatchObject({
      temperature: 25.5,
      humidity: 81,
      at: '2026-09-15T17:20:00+09:00',
      station: '東京'
    })
    expect(w.sources.find((s) => s.product === 'forecast')?.issuedAt).toBe(
      forecast[0].reportDatetime
    )
    expect(fetch.mock.calls.map((c) => c[0])).toContain(
      'https://www.jma.go.jp/bosai/amedas/data/point/44132/20260915_15.json'
    )
  })
  it('fetches no observation for tomorrow and covers only the forecast for that day', async () => {
    const fetch = request()
    const { fetchWeather } = await import('../src/main/services/weather')
    const w = await fetchWeather(resolved, 'tomorrow', new AbortController().signal)
    expect(w.targetDate).toBe('2026-09-16')
    expect(w.observation).toBeNull()
    expect(fetch.mock.calls.some((c) => c[0].includes('/amedas/'))).toBe(false)
    expect(w.hourly.every((h) => h.at.startsWith(w.targetDate))).toBe(true)
  })
  it('marks the part of the fetch that failed and keeps the rest of the data', async () => {
    request('/VPFD/')
    const { fetchWeather } = await import('../src/main/services/weather')
    const w = await fetchWeather(resolved, 'tomorrow', new AbortController().signal)
    expect(w.sources.find((s) => s.product === 'hourly')?.status).toBe('error')
    expect(w.hourly).toEqual([])
    expect(w.day.condition).not.toBeNull()
  })
  it('does not invent card data when every fetch fails', async () => {
    request('https://')
    const { fetchWeather } = await import('../src/main/services/weather')
    await expect(fetchWeather(resolved, 'today', new AbortController().signal)).rejects.toThrow('[asist:cardsWeather.errors.unavailable]')
  })
  it('does not overwrite a card whose target date has changed with values from another day', async () => {
    const fetch = request()
    const { weatherPanelProps } = await import('../src/main/services/weather')
    await expect(
      weatherPanelProps(
        { location: '東京都', date: 'today', weather: { targetDate: '2026-09-14' } },
        new AbortController().signal
      )
    ).rejects.toThrow('[asist:cardsWeather.errors.dayChanged]')
    expect(fetch).not.toHaveBeenCalled()
  })
})
