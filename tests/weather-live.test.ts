import { describe, expect, it } from 'vitest'
import { fetchWeather } from '../src/main/services/weather'
import { resolveWeatherLocation } from '../src/main/services/weather/locations'
import regions from '../src/main/services/weather/data/regions.json'

describe.skipIf(process.env.WEATHER_LIVE !== '1')('live connection to the Japan Meteorological Agency', () => {
  it('resolves the short-term and three-hourly forecasts for the representative point of every prefecture', async () => {
    let next = 0
    const results: Array<{ name: string; forecast: string; hourly: string; weekly: number }> = []
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (next < regions.prefectures.length) {
          const p = regions.prefectures[next++]
          const location = resolveWeatherLocation(p.name)
          if ('status' in location) throw new Error(location.status)
          const w = await fetchWeather(location, 'tomorrow', AbortSignal.timeout(30000))
          results.push({
            name: p.name,
            forecast: w.sources.find((s) => s.product === 'forecast')!.status,
            hourly: w.sources.find((s) => s.product === 'hourly')!.status,
            weekly: w.daily.length
          })
        }
      })
    )
    expect(
      results.filter((r) => r.forecast !== 'ready' || r.hourly !== 'ready' || r.weekly < 6)
    ).toEqual([])
  }, 180000)
})
