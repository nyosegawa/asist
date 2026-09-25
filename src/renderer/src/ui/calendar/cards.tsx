import { useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { AlignLeft, CalendarDays, Clock, Lock, MapPin, Pencil, Repeat, Trash2, Users, X } from 'lucide-react'
import type { Translate } from '@shared/i18n'
import type { CalendarChange, CalendarEvent } from '@shared/calendar'
import { addDays, dayKey, eventsOn, parseDayKey } from '@shared/calendar-layout'
import { useT, useFormatLocale } from '@/i18n'
import { BarChip, TimedChip, type OpenEvent } from './EventChips'
import { dayClasses, fmtDateFull, fmtTime, fmtTimeRange, weekdayNames } from './format'
import { colorOf, type CalendarAccount } from './palette'

/** Where a card is placed, in coordinates relative to the top left corner of the calendar view. */
export interface Anchor {
  left: number
  top: number
  width: number
  height: number
}

export function anchorOf(el: HTMLElement, rect: DOMRect = el.getBoundingClientRect()): Anchor {
  const root = el.closest('.cal-root')?.getBoundingClientRect()
  return {
    left: rect.left - (root?.left ?? 0),
    top: rect.top - (root?.top ?? 0),
    width: rect.width,
    height: rect.height
  }
}

/** Opens to the right of the element it belongs to, to its left when there is no room, and is pulled up or down to stay inside the frame. */
export function Card({
  anchor,
  kind,
  children
}: {
  anchor: Anchor
  kind: 'event' | 'day' | 'editor'
  children: React.ReactNode
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    const root = el?.parentElement
    if (!el || !root) return
    const width = el.offsetWidth
    const height = el.offsetHeight
    let left = anchor.left + anchor.width + 8
    if (left + width > root.clientWidth - 8) left = anchor.left - width - 8
    if (left < 8) left = Math.max(8, Math.min(anchor.left, root.clientWidth - width - 8))
    let top = anchor.top
    if (top + height > root.clientHeight - 8) top = Math.max(8, root.clientHeight - height - 8)
    setPos({ left: Math.round(left), top: Math.round(top) })
  }, [anchor])
  return (
    <div
      ref={ref}
      className={`cal-pop is-${kind}`}
      role="dialog"
      style={{ left: pos?.left ?? anchor.left, top: pos?.top ?? anchor.top, visibility: pos ? 'visible' : 'hidden' }}
    >
      {children}
    </div>
  )
}

function CloseButton({ onClose }: { onClose: () => void }): React.JSX.Element {
  const t = useT()
  return (
    <button aria-label={t('common.close')} onClick={onClose}>
      <X size={18} />
    </button>
  )
}

function whenText(t: Translate, locale: string, event: CalendarEvent): string {
  const start = new Date(event.start)
  const last = new Date(event.end - 1)
  const sameDay = dayKey(start) === dayKey(last)
  if (event.allDay)
    return sameDay
      ? fmtDateFull(locale, start)
      : t('calendar.dateRange', { from: fmtDateFull(locale, start), until: fmtDateFull(locale, last) })
  return sameDay
    ? t('calendar.event.whenSameDay', {
        date: fmtDateFull(locale, start),
        time: fmtTimeRange(locale, event.start, event.end, (start, end) => t('calendar.timeRange', { start, end }))
      })
    : t('calendar.event.whenSpan', {
        from: fmtDateFull(locale, start),
        fromTime: fmtTime(locale, event.start),
        until: fmtDateFull(locale, event.end),
        untilTime: fmtTime(locale, event.end)
      })
}

export function EventCard({
  event,
  account,
  color,
  onEdit,
  onDelete,
  onClose
}: {
  event: CalendarEvent
  account?: CalendarAccount
  color: string
  onEdit: () => void
  onDelete: () => void
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const locale = useFormatLocale()
  const writable = account?.writable ?? event.writable
  const locked = !writable || event.recurring || event.hasAttendees
  const hint = !writable
    ? t('calendar.event.readOnlyHint')
    : locked
      ? t('calendar.event.lockedHint')
      : t('calendar.event.approvalHint')
  return (
    <>
      <div className="cal-pop-tools">
        <button aria-label={t('calendar.event.edit')} disabled={locked} onClick={onEdit}>
          <Pencil size={16} />
        </button>
        <button aria-label={t('common.delete')} disabled={locked} onClick={onDelete}>
          <Trash2 size={16} />
        </button>
        <CloseButton onClose={onClose} />
      </div>
      <div className="cal-pop-title">
        <i className="cal-pop-swatch" style={{ '--c': color } as CSSProperties} />
        <h4>{event.title}</h4>
      </div>
      <div className="cal-pop-when">{whenText(t, locale, event)}</div>
      {event.location && (
        <div className="cal-pop-row">
          <MapPin size={16} />
          <span>{event.location}</span>
        </div>
      )}
      {event.notes && (
        <div className="cal-pop-row">
          <AlignLeft size={16} />
          <span>{event.notes}</span>
        </div>
      )}
      <div className="cal-pop-row">
        <CalendarDays size={16} />
        <span>{account ? `${account.source} / ${account.title}` : event.calendarTitle}</span>
      </div>
      {(event.recurring || event.hasAttendees || !writable) && (
        <div className="cal-pop-flags">
          {event.recurring && (
            <span>
              <Repeat size={11} />
              {t('calendar.event.recurring')}
            </span>
          )}
          {event.hasAttendees && (
            <span>
              <Users size={11} />
              {t('calendar.event.hasAttendees')}
            </span>
          )}
          {!writable && (
            <span>
              <Lock size={11} />
              {t('calendar.event.readOnly')}
            </span>
          )}
        </div>
      )}
      <p className="cal-pop-hint">{hint}</p>
    </>
  )
}

export function DayCard({
  day,
  events,
  today,
  colors,
  onOpenEvent,
  onCreate,
  onClose
}: {
  day: string
  events: CalendarEvent[]
  today: Date
  colors: Map<string, string>
  onOpenEvent: OpenEvent
  onCreate: (day: string) => void
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const locale = useFormatLocale()
  const date = parseDayKey(day)
  const list = eventsOn(events, date)
  return (
    <>
      <div className="cal-pop-tools">
        <CloseButton onClose={onClose} />
      </div>
      <div className={`cal-pop-day${dayClasses(date, today)}`}>
        <span className="wd">{weekdayNames(locale, 'short')[date.getDay()]}</span>
        <button className="cal-pop-num" title={t('calendar.day.create')} onClick={() => onCreate(day)}>
          {date.getDate()}
        </button>
      </div>
      <div className="cal-pop-list">
        {list.length === 0 && <div className="cal-empty">{t('calendar.day.empty')}</div>}
        {list.map((event) =>
          event.allDay ? (
            <BarChip
              key={event.id}
              bar={{ event, c0: 0, c1: 0, contLeft: false, contRight: false, lane: 0 }}
              color={colorOf(colors, event.calendarId)}
              onOpen={onOpenEvent}
            />
          ) : (
            <TimedChip key={event.id} event={event} color={colorOf(colors, event.calendarId)} onOpen={onOpenEvent} />
          )
        )}
      </div>
    </>
  )
}

/** The input of the create and edit card. The date and the times are held as local-time strings. */
export interface Draft {
  eventId?: string
  title: string
  date: string
  start: string
  end: string
  allDay: boolean
  location: string
  notes: string
  timeZone: string
}

export function newDraft(day: string, patch: Partial<Draft> = {}): Draft {
  return {
    title: '',
    date: day,
    start: '10:00',
    end: '11:00',
    allDay: false,
    location: '',
    notes: '',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...patch
  }
}

/** The value of an `input[type=time]`, which is always 24-hour `HH:mm` whatever the language is. */
function timeValue(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function draftFromEvent(event: CalendarEvent): Draft {
  return {
    eventId: event.id,
    title: event.title,
    date: dayKey(new Date(event.start)),
    start: timeValue(event.start),
    end: timeValue(event.allDay ? event.start : event.end),
    allDay: event.allDay,
    location: event.location,
    notes: event.notes,
    timeZone: event.timeZone
  }
}

function localDate(date: string, time: string): Date {
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  return new Date(y, m - 1, d, hh, mm)
}

export function changeFromDraft(draft: Draft): CalendarChange | null {
  const title = draft.title.trim()
  if (!title) return null
  const day = parseDayKey(draft.date)
  const start = draft.allDay ? day : localDate(draft.date, draft.start)
  const end = draft.allDay ? addDays(day, 1) : localDate(draft.date, draft.end)
  if (end <= start) return null
  const event = {
    title,
    start: start.toISOString(),
    end: end.toISOString(),
    allDay: draft.allDay,
    timeZone: draft.timeZone,
    location: draft.location.trim(),
    notes: draft.notes
  }
  return draft.eventId ? { operation: 'update', eventId: draft.eventId, event } : { operation: 'create', event }
}

export function EditorCard({
  initial,
  calendarLabel,
  onSubmit,
  onClose
}: {
  initial: Draft
  /** The calendar to save into; null means none is configured and nothing can be saved. */
  calendarLabel: string | null
  onSubmit: (draft: Draft) => void
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const [draft, setDraft] = useState(initial)
  const update = (patch: Partial<Draft>): void => setDraft((d) => ({ ...d, ...patch }))
  const invalid = changeFromDraft(draft) === null
  const submit = (e: FormEvent): void => {
    e.preventDefault()
    if (!invalid && calendarLabel) onSubmit(draft)
  }
  return (
    <>
      <div className="cal-pop-tools">
        <CloseButton onClose={onClose} />
      </div>
      <form className="cal-create-form" onSubmit={submit}>
        <input
          className="cal-title-input"
          placeholder={t('calendar.editor.title')}
          autoComplete="off"
          autoFocus
          value={draft.title}
          onChange={(e) => update({ title: e.target.value })}
        />
        <div className="cal-pop-row">
          <Clock size={16} />
          <span className="cal-fields">
            <input className="cal-field" type="date" value={draft.date} onChange={(e) => update({ date: e.target.value })} />
            <input
              className="cal-field"
              type="time"
              value={draft.start}
              disabled={draft.allDay}
              onChange={(e) => update({ start: e.target.value })}
            />
            <span className="cal-dash">–</span>
            <input
              className="cal-field"
              type="time"
              value={draft.end}
              disabled={draft.allDay}
              onChange={(e) => update({ end: e.target.value })}
            />
          </span>
        </div>
        <label className="cal-pop-row cal-allday">
          <input type="checkbox" checked={draft.allDay} onChange={(e) => update({ allDay: e.target.checked })} />
          <span>{t('calendar.allDay')}</span>
        </label>
        <div className="cal-pop-row">
          <MapPin size={16} />
          <input
            className="cal-field is-wide"
            placeholder={t('calendar.editor.location')}
            value={draft.location}
            onChange={(e) => update({ location: e.target.value })}
          />
        </div>
        <div className="cal-pop-row">
          <CalendarDays size={16} />
          <span>{calendarLabel ?? t('calendar.editor.noWriteCalendar')}</span>
        </div>
        <div className="cal-pop-actions">
          <span className="cal-pop-hint">{t('calendar.editor.confirmHint')}</span>
          <button className="cal-primary" type="submit" disabled={invalid || !calendarLabel}>
            {t('common.save')}
          </button>
        </div>
      </form>
    </>
  )
}

