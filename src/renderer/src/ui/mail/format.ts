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

/**
 * Splits the recipient field on commas, semicolons, the Japanese comma "、" and newlines. A separator ends
 * an entry only once the entry holds an address, and never inside quotes or angle brackets, so that a
 * name such as "Tanaka, Taro" in `Tanaka, Taro <taro@example.com>` stays with its address and the field
 * a draft's recipients are joined into splits back into the same entries.
 */
export function splitRecipients(text: string): string[] {
  const entries: string[] = []
  let entry = ''
  let quoted = false
  let angled = false
  let addressed = false
  for (const char of text) {
    if (char === '"') quoted = !quoted
    if (!quoted) {
      if (char === '<') angled = true
      else if (char === '>') angled = false
      else if (char === '@') addressed = true
      else if (!angled && /[,;、\n]/.test(char)) {
        if (addressed) {
          entries.push(entry.trim())
          entry = ''
          addressed = false
          continue
        }
        if (!entry.trim()) continue
      }
    }
    entry += char
  }
  if (entry.trim()) entries.push(entry.trim())
  return entries
}
