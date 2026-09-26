import type { CalendarEvent } from './calendar'

/**
 * Layout for the calendar screen, following Google Calendar: in the month view an all-day event is one
 * bar spanning days within a week row, and in the week view events that overlap in time are split into
 * side-by-side columns. Every date is handled in local time, so the time zone of a displayed event is
 * whatever macOS is set to. A day is found by moving the date, never by adding 24 hours, because the
 * day daylight saving time starts or ends has 23 or 25.
 */

const DAY_MS = 86_400_000
/** The height in pixels of one hour in the week view. */
export const HOUR_PX = 48
/** The height in pixels of the date header at the top of a month-view cell. */
export const MONTH_HEADER_PX = 26
/** The height in pixels of one event lane in a month-view cell. */
export const MONTH_LANE_PX = 22

export const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate())
export const addDays = (d: Date, n: number): Date =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
export const addMonths = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth() + n, 1)
export const firstOfMonth = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), 1)
export const daysInMonth = (d: Date): number => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
/** The week starts on Monday. */
export const mondayOf = (d: Date): Date => addDays(startOfDay(d), -((d.getDay() + 6) % 7))
/** Rounding absorbs the hour a day gains or loses to daylight saving time. */
export const daysBetween = (a: Date, b: Date): number =>
  Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / DAY_MS)
export const sameMonth = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()
export const sameDay = (a: Date, b: Date): boolean => sameMonth(a, b) && a.getDate() === b.getDate()
const pad = (n: number): string => String(n).padStart(2, '0')
export const dayKey = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export function parseDayKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** The Monday of every week in the month view, from the week holding the first day to the week holding the last. */
export function monthWeeks(month: Date): Date[] {
  const first = firstOfMonth(month)
  const rows = Math.ceil((((first.getDay() + 6) % 7) + daysInMonth(first)) / 7)
  const start = mondayOf(first)
  return Array.from({ length: rows }, (_, i) => addDays(start, i * 7))
}

/** The range of events the view needs. `from` is inclusive and `until` is exclusive. */
export function visibleRange(
  view: 'month' | 'week' | 'list',
  cursor: Date,
  selected: Date
): { from: Date; until: Date } {
  if (view === 'week') {
    const from = mondayOf(selected)
    return { from, until: addDays(from, 7) }
  }
  if (view === 'list') {
    const from = firstOfMonth(cursor)
    return { from, until: addDays(from, daysInMonth(from)) }
  }
  const weeks = monthWeeks(cursor)
  return { from: weeks[0], until: addDays(weeks[weeks.length - 1], 7) }
}

/**
 * The instant whose day is the last day an event covers. An end is exclusive, so an event that ends at
 * midnight, as every all-day event does, ends on the day before; an event without length covers the
 * day it starts on.
 */
export const lastInstant = (event: Pick<CalendarEvent, 'start' | 'end'>): number => Math.max(event.start, event.end - 1)

/** The events overlapping that day, all-day ones first and the rest by start time. */
export function eventsOn(events: CalendarEvent[], date: Date): CalendarEvent[] {
  const from = startOfDay(date).getTime()
  const until = addDays(date, 1).getTime()
  return events
    .filter((e) => e.start < until && e.end > from)
    .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start)
}

export interface BarSegment {
  event: CalendarEvent
  /** The first and last column of the bar within the week, where 0 is Monday and 6 is Sunday. */
  c0: number
  c1: number
  /** The event continues from the previous week, or into the next one. */
  contLeft: boolean
  contRight: boolean
  lane: number
}
export interface DayPlan {
  date: Date
  timed: CalendarEvent[]
  covering: BarSegment[]
  /** The first lane free for this day's timed events, below the all-day bars. */
  firstFree: number
}
export interface WeekLayout {
  bars: BarSegment[]
  days: DayPlan[]
  laneCount: number
}

/**
 * Lays out one week of seven days starting on Monday. An all-day event becomes a single bar across the
 * days it covers, and bars take the topmost lane that is still free, longer bars first. Timed events
 * start below the bars that cover their day.
 */
export function weekLayout(weekStart: Date, events: CalendarEvent[]): WeekLayout {
  const from = weekStart.getTime()
  const until = addDays(weekStart, 7).getTime()
  const bars: BarSegment[] = events
    .filter((e) => e.allDay && e.start < until && e.end > from)
    .map((event) => ({
      event,
      c0: Math.max(0, daysBetween(weekStart, new Date(event.start))),
      c1: Math.min(6, daysBetween(weekStart, new Date(lastInstant(event)))),
      contLeft: event.start < from,
      contRight: event.end > until,
      lane: 0
    }))
    .sort((a, b) => a.c0 - b.c0 || b.c1 - b.c0 - (a.c1 - a.c0) || a.event.start - b.event.start)
  const lanes: BarSegment[][] = []
  for (const bar of bars) {
    let lane = 0
    while (lanes[lane]?.some((b) => b.c0 <= bar.c1 && b.c1 >= bar.c0)) lane++
    bar.lane = lane
    ;(lanes[lane] ??= []).push(bar)
  }
  const days: DayPlan[] = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(weekStart, i)
    const dayFrom = date.getTime()
    const dayUntil = addDays(date, 1).getTime()
    const timed = events
      .filter((e) => !e.allDay && e.start < dayUntil && e.end > dayFrom)
      .sort((a, b) => a.start - b.start)
    const covering = bars.filter((b) => b.c0 <= i && i <= b.c1)
    const firstFree = covering.length ? Math.max(...covering.map((b) => b.lane)) + 1 : 0
    return { date, timed, covering, firstFree }
  })
  return { bars, days, laneCount: lanes.length }
}

export interface CellPlan {
  /** The timed events that fit in the cell. */
  shown: CalendarEvent[]
  /** How many events the "他 N 件" line stands for, counting hidden bars. Zero hides the line. */
  more: number
  /** The lane the "他 N 件" line goes in, or null when no lane is left for it. */
  moreLane: number | null
}

/** Decides what a month-view cell shows and what goes into "他 N 件", given how many lanes fit in it. */
export function cellPlan(day: DayPlan, lanes: number): CellPlan {
  const hiddenBars = day.covering.filter((b) => b.lane >= lanes).length
  const room = lanes - day.firstFree
  if (day.timed.length <= room && hiddenBars === 0) return { shown: day.timed, more: 0, moreLane: null }
  const shown = day.timed.slice(0, Math.max(0, room - 1))
  const more = day.timed.length - shown.length + hiddenBars
  const lane = day.firstFree + shown.length
  return { shown, more, moreLane: lane < lanes ? lane : null }
}

export function lanesForHeight(cellHeight: number): number {
  return Math.max(1, Math.floor((cellHeight - MONTH_HEADER_PX - 2) / MONTH_LANE_PX))
}

export interface Block {
  event: CalendarEvent
  /** Minutes from midnight of that day. An event crossing days is clipped to the day. */
  startMin: number
  endMin: number
  col: number
  cols: number
}

/**
 * Lays out one day of the week view, splitting events that overlap in time into columns. The number
 * of columns is decided per cluster of overlapping events.
 */
export function layoutBlocks(events: CalendarEvent[], date: Date): Block[] {
  const dayFrom = startOfDay(date).getTime()
  const dayUntil = addDays(date, 1).getTime()
  // The grid is a clock face of 24 hours, so a time is placed by the clock rather than by the time
  // elapsed since midnight, which is an hour off on the day daylight saving time starts or ends.
  const clockMinute = (at: number): number => new Date(at).getHours() * 60 + new Date(at).getMinutes()
  const items: Block[] = events
    .filter((e) => !e.allDay)
    .sort((a, b) => a.start - b.start)
    .map((event) => ({
      event,
      startMin: event.start <= dayFrom ? 0 : clockMinute(event.start),
      endMin: event.end >= dayUntil ? 1440 : clockMinute(event.end),
      col: 0,
      cols: 1
    }))
  const out: Block[] = []
  let cluster: Block[] = []
  let clusterEnd = -1
  const flush = (): void => {
    const cols: Block[][] = []
    for (const it of cluster) {
      let col = 0
      while (cols[col]?.some((o) => o.startMin < it.endMin && it.startMin < o.endMin)) col++
      it.col = col
      ;(cols[col] ??= []).push(it)
    }
    for (const it of cluster) {
      it.cols = cols.length
      out.push(it)
    }
    cluster = []
  }
  for (const it of items) {
    if (it.startMin >= clusterEnd) flush()
    cluster.push(it)
    clusterEnd = Math.max(clusterEnd, it.endMin)
  }
  flush()
  return out
}
