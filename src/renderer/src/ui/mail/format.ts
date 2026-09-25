import { clockTime, shortDayLabel } from '@/panels/primitives/format'
import { translate, formatLocale } from '@/i18n'

const DAY = 86_400_000

const startOfDay = (at: number): number => new Date(new Date(at).setHours(0, 0, 0, 0)).getTime()

/** The right edge of a list row: a time for today, a date otherwise. */
export function listTime(date: number, now = Date.now()): string {
  return startOfDay(date) === startOfDay(now) ? clockTime(date) : shortDayLabel(date)
}

/** The separator in the list: today, yesterday, a weekday within this week, and a date before that. */
export function dayGroup(date: number, now = Date.now()): string {
  const today = startOfDay(now)
  const day = startOfDay(date)
  const diff = Math.round((today - day) / DAY)
  if (diff <= 0) return translate('mail.day.today')
  if (diff === 1) return translate('mail.day.yesterday')
  if (diff < 7) return new Intl.DateTimeFormat(formatLocale(), { weekday: 'long' }).format(day)
  return new Intl.DateTimeFormat(formatLocale(), { year: day < startOfDay(now) - 300 * DAY ? 'numeric' : undefined, month: 'long', day: 'numeric' }).format(day)
}

/** The date and time shown in the reader. */
export function fullTime(date: number): string {
  return new Intl.DateTimeFormat(formatLocale(), { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(date)
}

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Splits the recipient field on commas, semicolons, the Japanese comma "、" and newlines. */
export function splitRecipients(text: string): string[] {
  return text
    .split(/[,;、\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
}
