import { addUsage, usageItemKey, type UsageDay, type UsageItem, type UsageKind } from './api-usage'

/**
 * What the costs page draws from the record: one stacked bar per day and the lines of the table.
 * Nothing here knows words; the page names each series.
 */

export type UsageGrouping = 'kind' | 'model'

/**
 * The number of series the chart colors on its own. A series that first appeared after that many
 * others is summed into OTHER_SERIES, which takes the last color.
 */
export const MAX_SERIES = 7
export const OTHER_SERIES = 'other'

export interface UsageSeries {
  /** A kind, a model's series id from `modelSeriesId`, or OTHER_SERIES. */
  id: string
  /** The place of the series in the color order. It follows the series, not its size, so a range change does not repaint it. */
  slot: number
  values: number[]
  total: number
}

export interface UsageReport {
  dates: string[]
  series: UsageSeries[]
  /** The items of the range summed across its days, largest cost first. */
  lines: UsageItem[]
  /** Calls of models the price list does not have are in `lines` but in no total. */
  totalUsd: number
}

export const USAGE_KINDS: readonly UsageKind[] = ['llm', 'live', 'agent']

/** The series an item belongs to when the chart is split by model. */
export function modelSeriesId(item: UsageItem): string {
  switch (item.kind) {
    case 'llm':
      return `llm:${item.provider}:${item.model}`
    case 'live':
      return `live:${item.engine}:${item.model}`
    case 'agent':
      return `agent:${item.engine}`
  }
}

const seriesOf = (grouping: UsageGrouping, item: UsageItem): string => (grouping === 'kind' ? item.kind : modelSeriesId(item))

/** The dates from `dayCount - 1` days before `end` through `end`, as YYYY-MM-DD. */
export function dateRange(end: string, dayCount: number): string[] {
  const [year, month, day] = end.split('-').map(Number)
  return Array.from({ length: dayCount }, (_, i) => {
    const date = new Date(Date.UTC(year, month - 1, day - (dayCount - 1 - i)))
    return date.toISOString().slice(0, 10)
  })
}

export function usageReport(days: readonly UsageDay[], end: string, dayCount: number, grouping: UsageGrouping): UsageReport {
  const dates = dateRange(end, dayCount)
  // The color order is the order in which series first appear in the whole record, so it stays the
  // same whatever range is shown.
  const order: string[] = grouping === 'kind' ? [...USAGE_KINDS] : []
  for (const day of days) for (const item of day.items) {
    const id = seriesOf(grouping, item)
    if (!order.includes(id)) order.push(id)
  }

  const byDate = new Map(days.map((day) => [day.date, day]))
  const values = new Map<string, number[]>()
  let merged: UsageDay[] = []
  dates.forEach((date, index) => {
    for (const item of byDate.get(date)?.items ?? []) {
      merged = addUsage(merged, end, item)
      if (item.costUsd === null) continue
      const id = seriesOf(grouping, item)
      const row = values.get(id) ?? dates.map(() => 0)
      row[index] += item.costUsd
      values.set(id, row)
    }
  })

  const all = [...values.entries()]
    .map(([id, row]) => ({ id, slot: order.indexOf(id), values: row, total: row.reduce((a, b) => a + b, 0) }))
    .filter((s) => s.total > 0)
  const series: UsageSeries[] = all.filter((s) => s.slot < MAX_SERIES).sort((a, b) => a.slot - b.slot)
  const folded = all.filter((s) => s.slot >= MAX_SERIES)
  if (folded.length > 0) {
    const other = dates.map((_, i) => folded.reduce((sum, s) => sum + s.values[i], 0))
    series.push({ id: OTHER_SERIES, slot: MAX_SERIES, values: other, total: other.reduce((a, b) => a + b, 0) })
  }

  const lines = [...(merged[0]?.items ?? [])].sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || usageItemKey(a).localeCompare(usageItemKey(b)))
  return { dates, series, lines, totalUsd: series.reduce((sum, s) => sum + s.total, 0) }
}
