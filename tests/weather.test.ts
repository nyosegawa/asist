import { describe, expect, it } from 'vitest'
import { errorText } from '../src/shared/i18n/error-text'
import { WMO_WEATHER, weatherCardKey, weatherInputSchema, wmoCondition } from '../src/shared/weather'
import { resolveWeatherLocation, weeklyCandidates } from '../src/main/services/weather/locations'
import {
  numeric,
  parseForecast,
  parseHourly,
  parseObservation,
  observationBlock
} from '../src/main/services/weather/parsers'
import regions from '../src/main/services/weather/data/regions.json'
import forecast from './fixtures/weather/tokyo-forecast.json'
import hourly from './fixtures/weather/tokyo-hourly.json'

const resolve = (name: string) => {
  const result = resolveWeatherLocation(name)
  if ('status' in result) throw new Error(result.hint)
  return result
}
describe('resolving a weather location', () => {
  it('maps a prefecture to the same card as its representative municipality and names the point', () => {
    const prefecture = resolve('東京都')
    const city = resolve('千代田区')
    expect(prefecture.usedRepresentative).toBe(true)
    expect(prefecture.name).toBe('千代田区')
    expect(weatherCardKey(prefecture, '2026-09-16')).toBe(weatherCardKey(city, '2026-09-16'))
    expect(weatherCardKey(city, '2026-09-17')).not.toBe(weatherCardKey(city, '2026-09-16'))
  })
  it('returns the candidates for municipalities that share a name and tells them apart by prefecture', () => {
    const issue = resolveWeatherLocation('府中市')
    expect(issue).toMatchObject({
      status: 'location_ambiguous',
      candidates: expect.arrayContaining([
        { location: '東京都府中市', municipalityCode: '13206' },
        { location: '広島県府中市', municipalityCode: '34208' }
      ])
    })
    expect(resolve('広島県府中市').prefectureId).toBe('hiroshima')
    expect(resolve('東京都府中市').prefectureId).toBe('tokyo')
  })
  it('does not resolve a nickname or an empty name to some other place', () => {
    expect(resolveWeatherLocation('東京')).toMatchObject({ status: 'location_not_found' })
    expect(weatherInputSchema.safeParse({}).success).toBe(false)
    expect(weatherInputSchema.safeParse({ location: '' }).success).toBe(false)
  })
  it('connects the representative point of every prefecture to a forecast area and a weekly candidate', () => {
    for (const p of regions.prefectures) {
      const loc = resolve(p.name)
      expect(loc.prefectureId).toBe(p.id)
      expect(weeklyCandidates(loc).length, p.name).toBeGreaterThan(0)
    }
  })
  it('resolves a ward of a designated city and a city that is split across areas', () => {
    expect(resolve('札幌市中央区').prefectureId).toBe('hokkaido')
    expect(resolve('神戸市').prefectureId).toBe('hyogo')
    expect(resolve('釧路市').usedRepresentative).toBe(true)
  })
  it('gives no two municipalities the same code', () => {
    const codes = regions.municipalities.map((place) => place.code)
    expect(codes.filter((code, i) => codes.indexOf(code) !== i)).toEqual([])
  })
  it('resolves a municipality listed once, and a name shared with a place without a forecast to the place with one', () => {
    expect(resolve('宮城県富谷市').municipalityCode).toBe('04216')
    // "国後郡泊村" has no forecast area, so "泊村" is "古宇郡泊村".
    expect(resolve('北海道泊村').municipalityCode).toBe('01403')
    expect(resolve('泊村').municipalityCode).toBe('01403')
    expect(resolveWeatherLocation('色丹村')).toMatchObject({ status: 'location_unavailable' })
  })
})
describe('weather codes', () => {
  it('has a word and icons of the existing set for every code, and treats an unknown code as missing', () => {
    const icons = ['clear', 'cloudy', 'rain', 'snow', 'storm']
    for (const [code, entry] of Object.entries(WMO_WEATHER)) {
      expect(entry.icons.length, code).toBeGreaterThan(0)
      expect(entry.icons.every((icon) => icons.includes(icon)), code).toBe(true)
      expect(wmoCondition(Number(code))).toEqual({ ...entry, label: null, transition: false })
    }
    expect(wmoCondition(4)).toBeNull()
    expect(wmoCondition(undefined)).toBeNull()
  })
})
describe('Japan Meteorological Agency data', () => {
  it('does not turn a blank into 0 and takes only an explicit 0', () => {
    expect([numeric(''), numeric(null), numeric(undefined), numeric('NaN')]).toEqual([
      null,
      null,
      null,
      null
    ])
    expect([numeric(0), numeric('0')]).toEqual([0, 0])
  })
  it('keeps each six-hour precipitation probability as its own period', () => {
    const w = parseForecast(forecast, resolve('東京都'), '2026-09-16')
    expect(w.precipitationPeriods).toHaveLength(4)
    expect(
      w.precipitationPeriods.every((p) => Date.parse(p.to) - Date.parse(p.from) === 21600000)
    ).toBe(true)
    expect(w.day.condition?.icons).toContain('rain')
    expect(w.day.min).toBe(21)
    expect(w.daily[0].percent).toBeNull()
  })
  it('reads fog as a sky of its own rather than as a missing one', () => {
    const location = resolve('東京都')
    const fog = structuredClone(forecast)
    const series = fog[0].timeSeries.find((s) => s.areas.some((a) => 'weatherCodes' in a))!
    const area = series.areas.find((a) => a.area.code === location.forecastAreaCode) as { weatherCodes: string[] }
    area.weatherCodes = area.weatherCodes.map(() => '209')
    expect(parseForecast(fog, location, '2026-09-16').day.condition).toMatchObject({ label: '霧', icons: ['cloudy'] })
  })
  it('reports data it cannot read as such, in the language of whoever reads it', () => {
    expect(() => parseForecast([] as never, resolve('東京都'), '2026-09-16')).toThrow(errorText('cardsWeather.errors.badData'))
    const odd = structuredClone(hourly)
    odd.areaTimeSeries.timeDefines = odd.areaTimeSeries.timeDefines.map((time) => ({ ...time, duration: 'PT1H' }))
    expect(() => parseHourly(odd, '2026-09-15')).toThrow(errorText('cardsWeather.errors.badData'))
  })
  it('matches the condition to the temperature by time rather than by position in the array', () => {
    const shifted = structuredClone(hourly)
    shifted.pointTimeSeries.timeDefines.shift()
    shifted.pointTimeSeries.temperature.shift()
    const w = parseHourly(shifted, '2026-09-15')
    expect(w.hourly[0].temperature).toBeNull()
    expect(w.hourly[1].temperature).toBe(hourly.pointTimeSeries.temperature[1])
    expect(w.hourly[0].condition?.icons).toEqual(['cloudy'])
  })
  it('checks the observation quality flag and the time, and never invents a missing humidity', () => {
    const data = {
      '20260915172000': { temp: [25, 0], humidity: [0, 1] },
      '20260915171000': { temp: [24, 0], humidity: [80, 0] }
    }
    expect(parseObservation(data, '2026-09-15T17:20:00+09:00', '大阪')).toMatchObject({
      temperature: 25,
      humidity: null
    })
    expect(parseObservation(data, '2026-09-15T18:00:00+09:00', '大阪')).toBeNull()
    expect(observationBlock('2026-09-15T17:20:00+09:00')).toBe('20260915_15')
  })
})
