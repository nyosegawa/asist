/** Formats a local calendar day as YYYY-MM-DD, the form used by conversation log filenames and by the conversation date of a memory's source. */
export function localDateKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Returns the names of the per-day files (`YYYY-MM-DD.<extension>`) whose day is older than the
 * retention period. The day comes from the filename, read as a local calendar day, and a name in any
 * other shape is left alone.
 */
export function expiredDatedFiles(names: readonly string[], today: Date, retentionDays: number, extension: string): string[] {
  const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  cutoff.setDate(cutoff.getDate() - retentionDays)
  return names.filter((name) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})\.([^.]+)$/.exec(name)
    if (!match || match[4] !== extension) return false
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime() < cutoff.getTime()
  })
}
