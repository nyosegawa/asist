import type { MessageKey } from '@shared/i18n'
import { errorText } from '@shared/i18n/error-text'
import type { WeatherIssue } from '@shared/weather'

/** How the screen words each reason a place has no weather card. */
const ISSUE_ERRORS = {
  location_not_found: 'panels.errors.placeNotFound',
  location_ambiguous: 'cardsWeather.errors.placeAmbiguous',
  location_unavailable: 'cardsWeather.errors.noForecastArea'
} as const satisfies Record<WeatherIssue['status'], MessageKey>

/**
 * A place a fetch finds no weather for. Its message is for the card that asked; show_weather answers the
 * model with the issue and its hint instead, as it does for a name the table of Japan settles before any
 * fetch, because the model is to ask the user rather than report a failure.
 */
export class WeatherIssueError extends Error {
  constructor(readonly issue: WeatherIssue) {
    super(errorText(ISSUE_ERRORS[issue.status], { place: issue.requestedLocation }))
  }
}
