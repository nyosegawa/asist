import { describe, expect, it } from 'vitest'
import { mapEmbedUrl, mapExternalUrl, mapInputSchema } from '@shared/map-embed'
import { catalogByType } from '@shared/panel-catalog'

describe('map card input', () => {
  it('rejects a directions request that has no origin', () => {
    expect(mapInputSchema.safeParse({ place: '東京タワー', mode: 'directions' }).success).toBe(false)
    expect(mapInputSchema.safeParse({ place: '東京タワー', mode: 'directions', origin: '  ' }).success).toBe(false)
    expect(mapInputSchema.safeParse({ place: '東京タワー', mode: 'directions', origin: '浜松町駅' }).success).toBe(true)
  })

  it('gives one place a separate card for place, for search and for each directions origin', () => {
    const map = catalogByType.get('map')!
    const place = mapInputSchema.parse({ place: '東京駅' })
    const keys = [
      map.key(place),
      map.key(mapInputSchema.parse({ place: '東京駅', mode: 'search' })),
      map.key(mapInputSchema.parse({ place: '東京駅', mode: 'directions', origin: '新宿駅' })),
      map.key(mapInputSchema.parse({ place: '東京駅', mode: 'directions', origin: '品川駅' }))
    ]
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('the Google URLs', () => {
  it('passes the place name to q unchanged, including Japanese text and spaces', () => {
    const url = new URL(mapEmbedUrl('KEY', mapInputSchema.parse({ place: '上野 カフェ & バー', mode: 'search' }), 'ja-JP'))
    expect(url.origin + url.pathname).toBe('https://www.google.com/maps/embed/v1/search')
    expect(url.searchParams.get('q')).toBe('上野 カフェ & バー')
    expect(url.searchParams.get('key')).toBe('KEY')
  })

  it('names the map in the interface language, which Google takes without the region', () => {
    const place = mapInputSchema.parse({ place: '東京駅' })
    expect(new URL(mapEmbedUrl('KEY', place, 'ja-JP')).searchParams.get('language')).toBe('ja')
    expect(new URL(mapEmbedUrl('KEY', place, 'en-US')).searchParams.get('language')).toBe('en')
  })

  it('passes origin, destination and travel mode for directions, and adds no q', () => {
    const input = mapInputSchema.parse({ place: '東京タワー', mode: 'directions', origin: '浜松町駅', travel: 'walking' })
    const embed = new URL(mapEmbedUrl('KEY', input, 'ja-JP'))
    expect(embed.pathname).toBe('/maps/embed/v1/directions')
    expect(Object.fromEntries(embed.searchParams)).toMatchObject({ origin: '浜松町駅', destination: '東京タワー', mode: 'walking' })
    expect(embed.searchParams.has('q')).toBe(false)

    const external = new URL(mapExternalUrl(input))
    expect(external.pathname).toBe('/maps/dir/')
    expect(Object.fromEntries(external.searchParams)).toMatchObject({ origin: '浜松町駅', destination: '東京タワー', travelmode: 'walking' })
  })

  it('throws instead of building a URL when the key is empty', () => {
    expect(() => mapEmbedUrl('  ', mapInputSchema.parse({ place: '東京駅' }), 'ja-JP')).toThrow()
  })
})
