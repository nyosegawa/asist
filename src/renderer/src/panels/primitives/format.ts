import { translate, formatLocale } from '@/i18n'

/** Display formatting shared by the cards. Times are rendered in the device's time zone. */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * The hour and the minute of a clock time. A language that reads the hour on a 12-hour clock takes no leading
 * zero, which would be wrong there; on a 24-hour clock the zero keeps a column of times aligned.
 */
export function timeFields(locale: string): Intl.DateTimeFormatOptions {
  const twelveHour = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hour12 === true
  return { hour: twelveHour ? 'numeric' : '2-digit', minute: '2-digit' }
}

/** How long ago, named in words up to a week old; anything older becomes a date. */
export function relativeTime(at: number, now = Date.now()): string {
  const diff = now - at
  if (diff < MINUTE) return translate('cardsTime.justNow')
  if (diff < HOUR) return translate('cardsTime.minutesAgo', { count: Math.floor(diff / MINUTE) })
  if (diff < DAY) return translate('cardsTime.hoursAgo', { count: Math.floor(diff / HOUR) })
  if (diff < 7 * DAY) return translate('cardsTime.daysAgo', { count: Math.floor(diff / DAY) })
  return new Date(at).toLocaleDateString(formatLocale(), { month: 'numeric', day: 'numeric' })
}

export function clockTime(at: number): string {
  const locale = formatLocale()
  return new Date(at).toLocaleTimeString(locale, timeFields(locale))
}

/** A date with the month written out and the weekday abbreviated. */
export function dayLabel(at: number | Date): string {
  return new Date(at).toLocaleDateString(formatLocale(), { month: 'long', day: 'numeric', weekday: 'short' })
}

/** A date with the month as a number and the weekday abbreviated. */
export function shortDayLabel(at: number | Date): string {
  return new Date(at).toLocaleDateString(formatLocale(), { month: 'numeric', day: 'numeric', weekday: 'short' })
}

/** The day seen from today, naming the two days on either side of it and counting the rest. */
export function relativeDayLabel(at: number | Date, now: number | Date = Date.now()): string {
  const startOfDay = (value: number | Date): number => new Date(value).setHours(0, 0, 0, 0)
  // Rounding keeps the day count right where daylight saving makes a day 23 or 25 hours long.
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY)
  const named = {
    '0': 'cardsTime.today',
    '1': 'cardsTime.tomorrow',
    '2': 'cardsTime.dayAfterTomorrow',
    '-1': 'cardsTime.yesterday',
    '-2': 'cardsTime.dayBeforeYesterday'
  } as const
  const key = named[String(days) as keyof typeof named]
  if (key) return translate(key)
  return days > 0 ? translate('cardsTime.inDays', { count: days }) : translate('cardsTime.daysAgo', { count: -days })
}

/** A length of time, down to seconds below an hour and to minutes above one. */
export function durationLabel(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  if (hours && minutes) return translate('cardsTime.duration.hoursMinutes', { hours, minutes })
  if (hours) return translate('cardsTime.duration.hours', { hours })
  if (minutes && rest) return translate('cardsTime.duration.minutesSeconds', { minutes, seconds: rest })
  if (minutes) return translate('cardsTime.duration.minutes', { minutes })
  return translate('cardsTime.duration.seconds', { seconds: rest })
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}
