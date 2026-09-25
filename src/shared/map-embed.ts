import { z } from 'zod'
import { errorText } from './i18n/error-text'
import type { UiLocale } from './i18n/message'
import { bilingual } from './tool-registry'

/**
 * The input of the map card and the Google URLs built from it.
 *
 * The map is an iframe of the Maps Embed API, which is free and has no request limit, and which
 * resolves a place name passed in `q` inside the iframe, so the app holds no geocoding of its own. The
 * terms and the pricing were checked on 2026-09-21.
 * - The app never receives a Places or Geocoding result, so the terms' 3.2.3 ban on "use Google Maps
 *   Content with text-to-speech services" does not apply.
 * - The attribution may not be altered, per 3.2.2(b), so no CSS filter is applied to the iframe.
 * - An embed smaller than 200px in either dimension is not supported.
 */

export const MAP_MODES = ['place', 'search', 'directions'] as const
export const MAP_TRAVEL_MODES = ['driving', 'walking', 'bicycling', 'transit'] as const

export const mapInputSchema = z
  .object({
    place: z
      .string()
      .trim()
      .min(1)
      .describe(
        bilingual({
          ja: '場所の名前か住所。例: 東京駅, 京都御所。mode が search のときは探す言葉(例: 上野 カフェ)、directions のときは目的地',
          en: 'The name or address of a place, such as "Tokyo Station" or "Kyoto Imperial Palace". With mode search it is what to look for, such as "cafes in Ueno"; with mode directions it is the destination.'
        })
      ),
    mode: z
      .enum(MAP_MODES)
      .default('place')
      .describe(
        bilingual({
          ja: 'place: 場所を1つ示す。search: 周辺の店や施設を探す。directions: origin から place までの経路を出す',
          en: 'place: point at one place. search: look for shops or facilities around it. directions: show the route from origin to place.'
        })
      ),
    origin: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        bilingual({
          ja: '経路の出発地。mode が directions のときは必須',
          en: 'Where the route starts. Required when mode is directions.'
        })
      ),
    travel: z
      .enum(MAP_TRAVEL_MODES)
      .optional()
      .describe(
        bilingual({
          ja: '経路の移動手段。省くと Google が選ぶ',
          en: 'How to travel the route. Leave it out and Google chooses.'
        })
      )
  })
  .refine((input) => input.mode !== 'directions' || input.origin !== undefined, {
    path: ['origin'],
    message: bilingual({
      ja: 'mode が directions のときは origin(出発地)が要る',
      en: 'origin, where the route starts, is required when mode is directions'
    })
  })

export type MapInput = z.infer<typeof mapInputSchema>

/**
 * The card key. For the same place, a place view, a search and directions are separate cards, and
 * directions are separate per origin.
 */
export function mapCardKey(props: Record<string, unknown>): string {
  const place = String(props.place ?? '').trim()
  if (props.mode === 'directions') return `map:${String(props.origin ?? '').trim()}→${place}`
  if (props.mode === 'search') return `map:search:${place}`
  return `map:${place}`
}

const EMBED_BASE = 'https://www.google.com/maps/embed/v1'

/**
 * The iframe's src. The key appears in the URL, so it must be a key restricted to the Maps Embed API.
 * Google names the map's own labels in `language`, which takes a language tag such as `ja` or `en`, not
 * a locale such as `en-US`.
 */
export function mapEmbedUrl(apiKey: string, input: MapInput, locale: UiLocale): string {
  if (!apiKey.trim()) throw new Error(errorText('panels.errors.mapsKeyMissing'))
  const params = new URLSearchParams({ key: apiKey.trim() })
  if (input.mode === 'directions') {
    if (!input.origin) throw new Error(errorText('panels.errors.mapOriginMissing'))
    params.set('origin', input.origin)
    params.set('destination', input.place)
    if (input.travel) params.set('mode', input.travel)
  } else {
    params.set('q', input.place)
  }
  params.set('language', locale.split('-')[0])
  return `${EMBED_BASE}/${input.mode}?${params.toString()}`
}

/** The URL that opens the same thing in Google Maps in a browser. Maps URLs need no API key. */
export function mapExternalUrl(input: MapInput): string {
  if (input.mode === 'directions') {
    if (!input.origin) throw new Error(errorText('panels.errors.mapOriginMissing'))
    const params = new URLSearchParams({ api: '1', origin: input.origin, destination: input.place })
    if (input.travel) params.set('travelmode', input.travel)
    return `https://www.google.com/maps/dir/?${params.toString()}`
  }
  return `https://www.google.com/maps/search/?${new URLSearchParams({ api: '1', query: input.place }).toString()}`
}
