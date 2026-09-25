import { errorText } from '@shared/i18n/error-text'
import { languageOf, usesJmaWeather } from '@shared/conversation-locale'
import {
  japanDate,
  placeCardId,
  weatherInputSchema,
  type WeatherData,
  type WeatherIssue
} from '@shared/weather'
import { conversationLocale, region } from '../conversation-locale'
import { resolveWeatherLocation } from './locations'
import { fetchGlobalWeather } from './open-meteo'
import { fetchWeather } from './jma'

/**
 * Which source answers is decided by the region setting on every call: Japan is the Japan
 * Meteorological Agency, with its table of municipalities and its own words for the sky, and every
 * other region is Open-Meteo, which resolves the place by geocoding it.
 */

export { fetchWeather }

/**
 * Which card a place name stands for, or why it names no place, without fetching anything. The table of
 * Japan answers both here; elsewhere the name itself identifies the card, because a call that replaces a
 * card names the place it replaces and must not have to geocode it again, and whether the place exists is
 * answered by the geocoding during the fetch.
 */
export function resolveWeatherCard(requested: string): { cardId: string } | WeatherIssue {
  if (!usesJmaWeather(region())) return { cardId: placeCardId(requested) }
  return resolveWeatherLocation(requested)
}

export async function weatherPanelProps(
  input: Record<string, unknown>,
  signal: AbortSignal
): Promise<{ props: Record<string, unknown> }> {
  const { location: name, date } = weatherInputSchema.parse(input)
  const previous = input.weather as WeatherData | undefined
  // A card whose day has passed while it stood there would otherwise take the values of another day.
  const refuseOtherDay = (targetDate: string): void => {
    if (previous && previous.targetDate !== targetDate)
      throw new Error(errorText('cardsWeather.errors.dayChanged'))
  }
  if (usesJmaWeather(region())) {
    refuseOtherDay(japanDate(Date.now() + (date === 'tomorrow' ? 86400_000 : 0)))
    const location = resolveWeatherLocation(name)
    if ('status' in location) throw new Error(location.hint)
    return { props: { location: name, date, weather: await fetchWeather(location, date, signal) } }
  }
  // Which day it is where the place stands is known only once its zone is, which the geocoding answers.
  const weather = await fetchGlobalWeather(
    { place: name, date, language: languageOf(conversationLocale()), region: region() },
    signal
  )
  refuseOtherDay(weather.targetDate)
  return { props: { location: name, date, weather } }
}
