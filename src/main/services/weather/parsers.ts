import { errorText } from '@shared/i18n/error-text'
import type {
  JmaWeatherLocation,
  WeatherCondition,
  WeatherData,
  WeatherDay,
  WeatherIcon
} from '@shared/weather'
import codes from './data/weather-codes.json'
import { weeklyCandidates } from './locations'

export const numeric = (value: unknown): number | null =>
  (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) &&
  Number.isFinite(Number(value))
    ? Number(value)
    : null

/**
 * The icons of a sky the Japan Meteorological Agency writes in words. Fog has no icon of its own and is
 * drawn as cloud, as Open-Meteo's fog is; code 209 is "霧" alone and would otherwise read as no sky at all.
 */
export function condition(label: string): WeatherCondition | null {
  const found: WeatherIcon[] = []
  const pattern = /晴|くもり|曇|霧|雨|雪|雷/g
  for (const match of label.matchAll(pattern)) {
    const icon: WeatherIcon =
      match[0] === '晴'
        ? 'clear'
        : /くもり|曇|霧/.test(match[0])
          ? 'cloudy'
          : match[0] === '雨'
            ? 'rain'
            : match[0] === '雪'
              ? 'snow'
              : 'storm'
    if (!found.includes(icon)) found.push(icon)
  }
  return found.length ? { label, word: null, icons: found, transition: /後|のち/.test(label) } : null
}
const fromCode = (code: string): WeatherCondition | null => {
  const label = (codes as Record<string, string>)[code]
  return label ? condition(label) : null
}
export const emptyDay = (date: string): WeatherDay => ({
  date,
  condition: null,
  min: null,
  max: null,
  percent: null
})

interface Area {
  area: { code: string; name: string }
  weatherCodes?: string[]
  pops?: string[]
  temps?: string[]
  tempsMin?: string[]
  tempsMax?: string[]
}
export interface Forecast {
  reportDatetime: string
  timeSeries: Array<{ timeDefines: string[]; areas: Area[] }>
}

/**
 * The days of the short-term temperatures, read by their layout as JMA's forecast page reads them. The
 * 5:00 and 11:00 releases list their own day's 09:00 and 00:00, then the next day's 00:00 and 09:00; they
 * forecast no minimum for their own day, whose morning has begun, and its 00:00 holds the maximum's
 * value. The 17:00 release lists the next day's 00:00 and 09:00 alone.
 */
function shortTermTemperatures(
  timeDefines: string[],
  temps: string[]
): Array<Pick<WeatherDay, 'date' | 'min' | 'max'>> {
  const day = (i: number): string => timeDefines[i].slice(0, 10)
  const layout = timeDefines.map((at) => at.slice(11, 16)).join(' ')
  if (temps.length === timeDefines.length) {
    if (layout === '09:00 00:00 00:00 09:00' && day(0) === day(1) && day(1) < day(2) && day(2) === day(3))
      return [
        { date: day(0), min: null, max: numeric(temps[0]) },
        { date: day(2), min: numeric(temps[2]), max: numeric(temps[3]) }
      ]
    if (layout === '00:00 09:00' && day(0) === day(1))
      return [{ date: day(0), min: numeric(temps[0]), max: numeric(temps[1]) }]
  }
  throw new Error(errorText('cardsWeather.errors.badData'))
}
export function parseForecast(
  data: Forecast[],
  location: JmaWeatherLocation,
  target: string
): Pick<WeatherData, 'day' | 'daily' | 'precipitationPeriods'> {
  const short = data[0]
  if (!short?.timeSeries) throw new Error(errorText('cardsWeather.errors.badData'))
  const day = emptyDay(target)
  const precipitationPeriods: WeatherData['precipitationPeriods'] = []
  for (const series of short.timeSeries) {
    const area = series.areas.find((a) => a.area.code === location.forecastAreaCode)
    if (area?.weatherCodes) {
      const i = series.timeDefines.findIndex((t) => t.slice(0, 10) === target)
      if (i >= 0) day.condition = fromCode(area.weatherCodes[i])
    }
    if (area?.pops)
      series.timeDefines.forEach((from, i) => {
        if (from.slice(0, 10) === target)
          precipitationPeriods.push({
            from,
            to: new Date(Date.parse(from) + 6 * 3600_000).toISOString(),
            percent: numeric(area.pops![i])
          })
      })
    const point = series.areas.find((a) => a.area.code === location.stationId)
    const temperatures = point?.temps && shortTermTemperatures(series.timeDefines, point.temps)
    const found = temperatures?.find((d) => d.date === target)
    if (found) {
      day.min = found.min
      day.max = found.max
    }
  }
  const daily: WeatherDay[] = []
  const week = data[1]
  if (week) {
    const weather = week.timeSeries.find((s) => s.areas.some((a) => a.weatherCodes))
    const candidate = weeklyCandidates(location).find((c) =>
      weather?.areas.some((a) => a.area.code === c.week)
    )
    const area = weather?.areas.find((a) => a.area.code === candidate?.week)
    const temp = week.timeSeries.find((s) => s.areas.some((a) => a.tempsMin))
    const point = temp?.areas.find((a) => a.area.code === candidate?.amedas)
    if (weather && area)
      weather.timeDefines.forEach((at, i) => {
        const d = emptyDay(at.slice(0, 10))
        d.condition = fromCode(area.weatherCodes?.[i] ?? '')
        d.percent = numeric(area.pops?.[i])
        const ti = temp?.timeDefines.findIndex((t) => t.slice(0, 10) === d.date) ?? -1
        if (ti >= 0) {
          d.min = numeric(point?.tempsMin?.[ti])
          d.max = numeric(point?.tempsMax?.[ti])
        }
        daily.push(d)
      })
  }
  const selected = daily.find((d) => d.date === target)
  if (selected) {
    if (day.min === null) day.min = selected.min
    if (day.max === null) day.max = selected.max
    day.percent = selected.percent
  }
  return { day, daily, precipitationPeriods }
}
interface Time {
  dateTime: string
  duration?: string
}
export interface HourlyForecast {
  reportDateTime: string
  areaTimeSeries: { timeDefines: Time[]; weather: string[] }
  pointTimeSeries: { pointNameJP: string; timeDefines: Time[]; temperature: Array<number | string> }
}
export function parseHourly(
  data: HourlyForecast,
  target: string
): Pick<WeatherData, 'hourly' | 'temperaturePoint'> {
  const area = data.areaTimeSeries
  const point = data.pointTimeSeries
  if (!area?.timeDefines || !point?.timeDefines) throw new Error(errorText('cardsWeather.errors.badData'))
  const hourly = area.timeDefines.flatMap((time, i) => {
    if (time.dateTime.slice(0, 10) !== target) return []
    // The card lays the hours out in columns of three, so another interval is data it cannot read.
    if (time.duration !== 'PT3H') throw new Error(errorText('cardsWeather.errors.badData'))
    const ti = point.timeDefines.findIndex(
      (p) => Date.parse(p.dateTime) === Date.parse(time.dateTime)
    )
    return [
      {
        at: time.dateTime,
        until: new Date(Date.parse(time.dateTime) + 3 * 3600_000).toISOString(),
        temperature: ti < 0 ? null : numeric(point.temperature[ti]),
        condition: condition(area.weather[i] ?? '')
      }
    ]
  })
  return { hourly, temperaturePoint: point.pointNameJP }
}
export function observationBlock(at: string): string {
  const local = new Date(Date.parse(at) + 9 * 3600_000).toISOString()
  return (
    local.slice(0, 10).replaceAll('-', '') +
    '_' +
    String(Math.floor(Number(local.slice(11, 13)) / 3) * 3).padStart(2, '0')
  )
}
export function parseObservation(
  data: Record<string, { temp?: unknown[]; humidity?: unknown[] }>,
  latest: string,
  station: string
): WeatherData['observation'] {
  const keys = Object.keys(data)
    .filter((k) => /^\d{14}$/.test(k))
    .sort()
    .reverse()
  const latestMs = Date.parse(latest)
  for (const key of keys) {
    const at = `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}T${key.slice(8, 10)}:${key.slice(10, 12)}:${key.slice(12, 14)}+09:00`
    if (Date.parse(at) > latestMs || latestMs - Date.parse(at) > 30 * 60_000) continue
    const sample = data[key]
    const temperature = sample.temp?.[1] === 0 ? numeric(sample.temp[0]) : null
    const humidity = sample.humidity?.[1] === 0 ? numeric(sample.humidity[0]) : null
    if (temperature !== null || humidity !== null)
      return { at, station, temperature, humidity, wind: null }
  }
  return null
}
