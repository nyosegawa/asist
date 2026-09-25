import { errorText } from '@shared/i18n/error-text'
import { WeatherCache } from './cache'
import { japanDate, type JmaWeatherLocation, type WeatherData, type WeatherSource } from '@shared/weather'
import { forecastOffice } from './locations'
import {
  emptyDay,
  observationBlock,
  parseForecast,
  parseHourly,
  parseObservation,
  type Forecast,
  type HourlyForecast
} from './parsers'

/** The weather of Japan, read from the public JSON of the Japan Meteorological Agency. */

const base = 'https://www.jma.go.jp/bosai/'
const cache = new WeatherCache()
const object = (text: string): Record<string, unknown> => {
  const data = JSON.parse(text)
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error(errorText('cardsWeather.errors.badData'))
  return data
}

export async function fetchWeather(
  location: JmaWeatherLocation,
  date: 'today' | 'tomorrow',
  signal: AbortSignal
): Promise<WeatherData> {
  const now = Date.now()
  const fetchedAt = new Date(now).toISOString()
  const targetDate = japanDate(now + (date === 'tomorrow' ? 86400_000 : 0))
  const result: WeatherData = {
    location,
    date,
    targetDate,
    fetchedAt,
    units: { temperature: '°C', wind: null },
    observation: null,
    hourly: [],
    temperaturePoint: null,
    precipitationPeriods: [],
    day: emptyDay(targetDate),
    daily: [],
    sources: []
  }
  const collect = async (
    product: WeatherSource['product'],
    url: string,
    read: () => Promise<{ issuedAt: string | null; available: boolean }>
  ): Promise<WeatherSource> => {
    try {
      const { issuedAt, available } = await read()
      return { product, url, fetchedAt, issuedAt, status: available ? 'ready' : 'missing' }
    } catch (error) {
      signal.throwIfAborted()
      return {
        product,
        url,
        fetchedAt,
        issuedAt: null,
        status: 'error',
        message: error instanceof Error ? error.message : String(error)
      }
    }
  }
  const forecastUrl = `${base}forecast/data/forecast/${forecastOffice(location.officeCode)}.json`
  const hourlyUrl = `${base}jmatile/data/wdist/VPFD/${location.forecastAreaCode}.json`
  const jobs = [
    collect('forecast', forecastUrl, async () => {
      const data = await cache.read(forecastUrl, 5 * 60_000, signal, (text) => {
        const value: Forecast[] = JSON.parse(text)
        if (!Array.isArray(value) || !value[0]?.reportDatetime || !value[0]?.timeSeries)
          throw new Error(errorText('cardsWeather.errors.badData'))
        parseForecast(value, location, targetDate)
        return value
      })
      const parsed = parseForecast(data, location, targetDate)
      Object.assign(result, parsed)
      return {
        issuedAt: data[0].reportDatetime,
        available: parsed.day.condition !== null || parsed.daily.length > 0
      }
    }),
    collect('hourly', hourlyUrl, async () => {
      const data = await cache.read(hourlyUrl, 5 * 60_000, signal, (text) => {
        const value = object(text) as unknown as HourlyForecast
        parseHourly(value, targetDate)
        return value
      })
      const parsed = parseHourly(data, targetDate)
      Object.assign(result, parsed)
      return { issuedAt: data.reportDateTime, available: parsed.hourly.length > 0 }
    })
  ]
  if (date === 'today')
    jobs.push(
      collect('observation', `${base}amedas/`, async () => {
        const latest = await cache.read(
          `${base}amedas/data/latest_time.txt`,
          60_000,
          signal,
          (text) => {
            const at = text.trim()
            if (!Number.isFinite(Date.parse(at))) throw new Error(errorText('cardsWeather.errors.badData'))
            return at
          }
        )
        if (now - Date.parse(latest) > 30 * 60_000)
          throw new Error(errorText('cardsWeather.errors.stale'))
        const url = `${base}amedas/data/point/${location.stationId}/${observationBlock(latest)}.json`
        const data = await cache.read(url, 60_000, signal, object)
        result.observation = parseObservation(
          data as Parameters<typeof parseObservation>[0],
          latest,
          location.stationName
        )
        return {
          issuedAt: result.observation?.at ?? latest,
          available: result.observation !== null
        }
      })
    )
  result.sources = await Promise.all(jobs)
  signal.throwIfAborted()
  if (result.sources.every((s) => s.status === 'error' || s.status === 'missing'))
    throw new Error(errorText('cardsWeather.errors.unavailable'))
  return result
}
