import regions from './data/regions.json'
import { CONVERSATION_LOCALES, type PromptText } from '@shared/conversation-locale'
import type { JmaWeatherLocation, WeatherIssue } from '@shared/weather'

/**
 * What the model is told when a place name resolves to no Japanese municipality, or to several. The
 * conversation can be held in any language while the region stays Japan, so each hint carries both
 * prompt languages and show_weather picks the one of the turn.
 */
const HINTS = {
  notFound: {
    ja: '一致する都道府県および市区町村がありません。正式な地域名を指定してください。',
    en: 'No prefecture or municipality of Japan has that name. Give the official name of a prefecture or municipality, written in Japanese or in romaji (for example "Fuchu, Tokyo").'
  },
  ambiguous: {
    ja: '同名の市区町村が複数あります。候補を示してユーザーに確認し、都道府県名を付けて再実行してください。',
    en: 'Several municipalities share that name. Offer the candidates to the user, then call again with the location of the one they choose.'
  },
  unavailable: {
    ja: 'この市区町村に対応する気象庁の予報区域がありません。',
    en: 'The Japan Meteorological Agency has no forecast area for this municipality.'
  }
} as const satisfies Record<string, PromptText>

type Prefecture = (typeof regions.prefectures)[number]
type Municipality = (typeof regions.municipalities)[number]

/** What a name stands for: a prefecture, which is its representative municipality, or municipalities. */
type Named = { prefecture: Prefecture } | { places: Municipality[] }

const japaneseNames = new Map<string, Municipality[]>()
for (const place of regions.municipalities) {
  for (const name of [place.name, place.prefecture + place.name]) {
    japaneseNames.set(name, [...(japaneseNames.get(name) ?? []), place])
  }
}

type Kind = 'prefecture' | 'city' | 'ward' | 'town' | 'village'
/** The words English and romanized Japanese write after a name to say what kind of place it is. */
const KIND_WORDS = new Map<string, Kind>([
  ['prefecture', 'prefecture'], ['metropolis', 'prefecture'], ['ken', 'prefecture'], ['fu', 'prefecture'], ['to', 'prefecture'],
  ['city', 'city'], ['shi', 'city'],
  ['ward', 'ward'], ['ku', 'ward'],
  ['town', 'town'], ['machi', 'town'], ['cho', 'town'],
  ['village', 'village'], ['mura', 'village'], ['son', 'village']
])
const SUFFIX_KINDS = new Map<string, Kind>([['市', 'city'], ['区', 'ward'], ['町', 'town'], ['村', 'village']])

/**
 * A name in Latin letters as the letters of its words run together, so that case, the marks of long
 * vowels ("Tōkyō") and the spaces or hyphens inside a name ("Sanyo-Onoda") do not count, with the kind
 * of place the word after it names.
 */
function romaji(text: string): { base: string; kind?: Kind } {
  const words = text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().split(/[\s\-'’.]+/u).filter(Boolean)
  const kind = words.length > 1 ? KIND_WORDS.get(words.at(-1)!) : undefined
  return { base: (kind ? words.slice(0, -1) : words).join(''), kind }
}

/** Japan as each conversation language names it, which a place name may end with ("Osaka, Japan"). */
const JAPAN = new Set(
  CONVERSATION_LOCALES.map((locale) => romaji(new Intl.DisplayNames([locale], { type: 'region' }).of('JP')!).base)
)

/**
 * The municipalities by their names in romaji, which are the Japan Meteorological Agency's English names
 * without the word for their kind ("Sapporo" of "Sapporo City"). A ward the agency forecasts together
 * with its city has no English name of its own and is reached in Japanese.
 */
const romajiNames = new Map<string, Array<{ place: Municipality; kinds: Set<Kind | undefined> }>>()
for (const place of regions.municipalities) {
  if (!place.enName) continue
  const { base, kind } = romaji(place.enName)
  // A ward of Tokyo is a "City" in the agency's English and a ward, "区", in its Japanese name.
  const kinds = new Set([kind, SUFFIX_KINDS.get(place.name.at(-1)!)])
  romajiNames.set(base, [...(romajiNames.get(base) ?? []), { place, kinds }])
}
const prefectureNamed = ({ base, kind }: ReturnType<typeof romaji>): Prefecture | undefined =>
  kind === undefined || kind === 'prefecture' ? regions.prefectures.find((p) => p.id === base) : undefined

/**
 * A name in romaji, as a conversation in another language writes the places of Japan: a prefecture or a
 * municipality, which a prefecture may follow after a comma and the name of Japan after that ("Fuchu,
 * Tokyo, Japan"). A bare name that is a prefecture's is the prefecture, as "Okinawa" is, while "Okinawa
 * City" is the city.
 */
function namedInRomaji(requested: string): Named {
  const parts = requested.split(',').map(romaji)
  if (parts.length > 1 && JAPAN.has(parts.at(-1)!.base)) parts.pop()
  const [name, within, ...rest] = parts
  const area = within && prefectureNamed(within)
  if (rest.length > 0 || (within && !area)) return { places: [] }
  const prefecture = !within && prefectureNamed(name)
  if (prefecture) return { prefecture }
  const places = (romajiNames.get(name.base) ?? [])
    .filter(({ place, kinds }) => (!area || place.prefectureId === area.id) && (!name.kind || kinds.has(name.kind)))
    .map(({ place }) => place)
  return { places }
}

function namedInJapanese(requested: string): Named {
  const prefecture = regions.prefectures.find((p) => p.name === requested)
  return prefecture ? { prefecture } : { places: japaneseNames.get(requested) ?? [] }
}

/**
 * The municipalities a name stands for. A municipality without a forecast area is listed so that its
 * name is answered with location_unavailable rather than not found, so when it shares its name with
 * one that has an area, as "国後郡泊村" does with "古宇郡泊村" in Hokkaido, the name means the one with the area.
 */
function municipalitiesOf(named: Named): Municipality[] {
  if ('prefecture' in named)
    return regions.municipalities.filter((p) => p.code === named.prefecture.representativeCode)
  const forecast = named.places.filter((p) => p.officeCode)
  return forecast.length ? forecast : named.places
}

export function resolveWeatherLocation(requested: string): JmaWeatherLocation | WeatherIssue {
  // The table's own names are Japanese, so a name in Latin letters is romaji.
  const named = /\p{Script=Latin}/u.test(requested) ? namedInRomaji(requested) : namedInJapanese(requested)
  const matches = municipalitiesOf(named)
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
    usedRepresentative: 'prefecture' in named || !!p.representativeArea
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
