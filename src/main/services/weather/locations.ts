import regions from './data/regions.json'
import type { PromptText } from '@shared/conversation-locale'
import type { JmaWeatherLocation, WeatherIssue } from '@shared/weather'

/**
 * What the model is told when a place name resolves to no Japanese municipality, or to several. The
 * conversation can be held in any language while the region stays Japan, so each hint carries both
 * prompt languages and show_weather picks the one of the turn.
 */
const HINTS = {
  notFound: {
    ja: '一致する都道府県および市区町村がありません。正式な地域名を指定してください。',
    en: 'No prefecture or municipality of Japan has that name. Give the official name of the place.'
  },
  ambiguous: {
    ja: '同名の市区町村が複数あります。候補を示してユーザーに確認し、都道府県名を付けて再実行してください。',
    en: 'Several municipalities share that name. Offer the candidates to the user, then call again with the prefecture in front of the name.'
  },
  unavailable: {
    ja: 'この市区町村に対応する気象庁の予報区域がありません。',
    en: 'The Japan Meteorological Agency has no forecast area for this municipality.'
  }
} as const satisfies Record<string, PromptText>

type Municipality = (typeof regions.municipalities)[number]
const names = new Map<string, Municipality[]>()
for (const place of regions.municipalities) {
  for (const name of [place.name, place.prefecture + place.name]) {
    names.set(name, [...(names.get(name) ?? []), place])
  }
}
/**
 * The municipalities a name stands for. A municipality without a forecast area is listed so that its
 * name is answered with location_unavailable rather than not found, so when it shares its name with
 * one that has an area, as "国後郡泊村" does with "古宇郡泊村" in Hokkaido, the name means the one with the area.
 */
function named(requested: string): Municipality[] {
  const all = names.get(requested) ?? []
  const forecast = all.filter((p) => p.officeCode)
  return forecast.length ? forecast : all
}

export function resolveWeatherLocation(requested: string): JmaWeatherLocation | WeatherIssue {
  const prefecture = regions.prefectures.find((p) => p.name === requested)
  const matches = prefecture
    ? regions.municipalities.filter((p) => p.code === prefecture.representativeCode)
    : named(requested)
  if (matches.length === 0)
    return {
      status: 'location_not_found',
      requestedLocation: requested,
      hint: HINTS.notFound
    }
  if (matches.length > 1)
    return {
      status: 'location_ambiguous',
      requestedLocation: requested,
      candidates: matches.map((p) => ({
        location: p.prefecture + p.name,
        municipalityCode: p.code
      })),
      hint: HINTS.ambiguous
    }
  const p = matches[0]
  if (!p.officeCode)
    return { status: 'location_unavailable', requestedLocation: requested, hint: HINTS.unavailable }
  return {
    source: 'jma',
    requested,
    // The municipality is what a card stands for: a prefecture and its representative municipality are one card.
    cardId: p.code,
    timeZone: 'Asia/Tokyo',
    municipalityCode: p.code,
    name: p.name,
    prefecture: p.prefecture,
    prefectureId: p.prefectureId,
    forecastAreaCode: p.forecastAreaCode!,
    forecastAreaName: p.forecastAreaName!,
    officeCode: p.officeCode,
    stationId: p.stationId!,
    stationName: p.stationName!,
    usedRepresentative: !!prefecture || !!p.representativeArea
  }
}
export function weeklyCandidates(
  location: JmaWeatherLocation
): Array<{ week: string; amedas: string }> {
  const week = regions.weekly as Record<string, Array<{ week: string; amedas: string }>>
  const codes = (regions.weekly05 as Record<string, string[]>)[location.forecastAreaCode]
  return week[location.officeCode].filter((p) => codes.includes(p.week))
}
export function forecastOffice(code: string): string {
  return code === '014030' ? '014100' : code === '460040' ? '460100' : code
}
