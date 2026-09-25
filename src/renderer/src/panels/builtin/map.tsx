import type { Translate } from '@shared/i18n'
import { errorText } from '@shared/i18n/error-text'
import { mapEmbedUrl, mapExternalUrl, mapInputSchema, type MapInput } from '@shared/map-embed'
import { useT, useUiLocale } from '@/i18n'
import type { CardContext, CardDefinition } from '../shell/card'
import { Action, Actions } from '../primitives/Card'
import './map.css'

/**
 * Map card. It shows Google's Maps Embed API in an iframe.
 * - The map is 420px tall at l, 340px at m, 260px at s and 480px in focus. The Embed API does not support
 *   anything below 200px in either direction, so even s keeps 260px; the dock's columns are 260 to 330px
 *   wide, so the width stays above 200px too.
 * - The attribution may not be altered, so the iframe carries no filter and nothing is drawn over it, and
 *   the colors stay as Google renders them.
 * - The shell scrolls this card (scroll: true), so that Google's attribution at the bottom of the iframe is
 *   not cut off when another card shares the dock and shrinks the box.
 */

const TRAVEL_KEY = {
  driving: 'cardsInfo.map.travel.driving',
  walking: 'cardsInfo.map.travel.walking',
  bicycling: 'cardsInfo.map.travel.bicycling',
  transit: 'cardsInfo.map.travel.transit'
} as const satisfies Record<NonNullable<MapInput['travel']>, string>

/** The key is embedded from .env at build time, and it is restricted to the Maps Embed API. */
function embedKey(): string {
  const key = import.meta.env.RENDERER_VITE_GOOGLE_MAPS_EMBED_KEY?.trim()
  if (!key) throw new Error(errorText('panels.errors.mapsKeyMissing'))
  return key
}

function subtitle(t: Translate, input: MapInput): string {
  if (input.mode === 'directions') {
    const origin = input.origin
    if (origin === undefined) throw new Error(errorText('panels.errors.mapOriginMissing'))
    return input.travel
      ? t('cardsInfo.map.fromByTravel', { origin, travel: t(TRAVEL_KEY[input.travel]) })
      : t('cardsInfo.map.from', { origin })
  }
  return input.mode === 'search' ? t('cardsInfo.map.nearby') : t('cardsInfo.map.place')
}

function MapBody({ spec, size }: CardContext): React.JSX.Element {
  const input = mapInputSchema.parse(spec.props)
  const t = useT()
  const locale = useUiLocale()
  return (
    <div className="card mp" data-size={size}>
      <div className="card-hero">
        <h3>{input.place}</h3>
        <p>{subtitle(t, input)}</p>
      </div>
      <iframe
        className="mp-frame"
        title={t('cardsInfo.map.frame', { place: input.place })}
        src={mapEmbedUrl(embedKey(), input, locale)}
        referrerPolicy="strict-origin-when-cross-origin"
        sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        allowFullScreen
      />
      <Actions>
        <Action leadsTo="outside" onClick={() => void window.api.openExternal(mapExternalUrl(input))}>{t('cardsInfo.map.openGoogleMaps')}</Action>
      </Actions>
    </div>
  )
}

export const mapCard: CardDefinition = { Body: MapBody, kicker: 'MAP', className: 'mp-card', scroll: true }
