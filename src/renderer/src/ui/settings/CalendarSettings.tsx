import { useEffect, useState } from 'react'
import type { AppSettings } from '@shared/settings'
import type { CalendarStatus } from '@shared/calendar'
import { HoloSwitch } from '@/components/ui/switch'
import { useSettingsStore } from '@/state/stores'
import { Btn, Chip, Group, Row } from './primitives'
import { displayError } from '@/display-error'
import { useT } from '@/i18n'

/** The calendar integration. Turning it on asks macOS for access and saves the setting only once access is granted. */
export function CalendarSettings({ settings }: { settings: AppSettings }): React.JSX.Element {
  const save = useSettingsStore((state) => state.save)
  const t = useT()
  const [status, setStatus] = useState<CalendarStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const calendar = settings.calendar
  useEffect(() => {
    let active = true
    void window.api
      .calendarStatus()
      .then((result) => {
        if (active) setStatus(result)
      })
      .catch((error: unknown) => {
        if (active) setError(displayError(error))
      })
    return () => {
      active = false
    }
  }, [])
  const run = async (operation: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await operation()
    } catch (error) {
      setError(displayError(error))
    } finally {
      setBusy(false)
    }
  }
  const persist = (patch: Partial<AppSettings['calendar']>): Promise<unknown> => save({ calendar: { ...calendar, ...patch } })
  const missing = calendar.readCalendarIds.filter(
    (id) => status?.authorization === 'fullAccess' && !status.calendars.some((item) => item.id === id)
  )
  const missingWrite =
    calendar.writeCalendarId &&
    status?.authorization === 'fullAccess' &&
    !status.calendars.some((item) => item.id === calendar.writeCalendarId && item.writable)
  const granted = status?.authorization === 'fullAccess'

  return (
    <Group
      title={t('settingsCalendar.title')}
      description={t('settingsCalendar.description')}
      action={
        <Btn tone="quiet" disabled={busy} onClick={() => void run(() => window.api.calendarOpenGuide())}>
          {t('settingsCalendar.openGuide')}
        </Btn>
      }
    >
      <Row label={t('settingsCalendar.enable')} hint={status ? t(`settingsCalendar.authorization.${status.authorization}`) : t('settingsCalendar.checkingAccess')}>
        <Chip tone={granted ? 'ok' : status ? 'warn' : 'dim'}>
          {granted ? t('settingsCalendar.granted') : status ? t('settingsCalendar.notGranted') : t('settingsCalendar.checking')}
        </Chip>
        <HoloSwitch
          aria-label={t('settingsCalendar.enable')}
          checked={calendar.enabled}
          disabled={busy}
          onCheckedChange={(enabled) => {
            void run(async () => {
              if (enabled) {
                const result = await window.api.calendarRequestAccess()
                setStatus(result)
                if (result.authorization !== 'fullAccess') throw new Error(t(`settingsCalendar.authorization.${result.authorization}`))
              }
              await persist({ enabled })
            })
          }}
        />
      </Row>
      <Row label={t('settingsCalendar.access')} hint={t('settingsCalendar.accessHint')}>
        <Btn tone="quiet" disabled={busy} onClick={() => void run(async () => setStatus(await window.api.calendarStatus()))}>
          {t('settingsCalendar.refreshList')}
        </Btn>
        <Btn tone="quiet" disabled={busy} onClick={() => void run(() => window.api.calendarOpenPrivacy())}>
          {t('settingsCalendar.openPrivacy')}
        </Btn>
      </Row>
      {granted && (
        <>
          <Row label={t('settingsCalendar.shownCalendars')} hint={status.calendars.length === 0 ? t('settingsCalendar.noCalendars') : undefined} wide>
            <fieldset disabled={busy || !calendar.enabled} className="disabled:opacity-50">
              {status.calendars.map((item) => (
                <label key={item.id} className="st-check">
                  <input
                    type="checkbox"
                    checked={calendar.readCalendarIds.includes(item.id)}
                    onChange={(event) => {
                      const ids = event.target.checked
                        ? [...calendar.readCalendarIds, item.id]
                        : calendar.readCalendarIds.filter((id) => id !== item.id)
                      void run(() => persist({ readCalendarIds: ids }))
                    }}
                  />
                  <span>
                    {item.source} / {item.title}
                  </span>
                  {!item.writable && <small>{t('settingsCalendar.readOnly')}</small>}
                </label>
              ))}
              {missing.length > 0 && (
                <div className="st-check">
                  <small>{t('settingsCalendar.missingCalendars', { count: missing.length })}</small>
                  <Btn
                    tone="quiet"
                    onClick={() => void run(() => persist({ readCalendarIds: calendar.readCalendarIds.filter((id) => !missing.includes(id)) }))}
                  >
                    {t('settingsCalendar.removeMissing')}
                  </Btn>
                </div>
              )}
            </fieldset>
          </Row>
          <Row
            label={t('settingsCalendar.writeCalendar')}
            hint={
              calendar.enabled && calendar.readCalendarIds.length === 0
                ? t('settingsCalendar.writeCalendarNoRead')
                : t('settingsCalendar.writeCalendarHint')
            }
          >
            <select
              aria-label={t('settingsCalendar.writeCalendar')}
              className="st-select"
              style={{ maxWidth: 260 }}
              disabled={busy || !calendar.enabled}
              value={calendar.writeCalendarId ?? ''}
              onChange={(event) => void run(() => persist({ writeCalendarId: event.target.value || null }))}
            >
              <option value="">{t('settingsCalendar.writeCalendarUnset')}</option>
              {missingWrite && <option value={calendar.writeCalendarId!}>{t('settingsCalendar.writeCalendarMissing')}</option>}
              {status.calendars
                .filter((item) => item.writable)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.source} / {item.title}
                  </option>
                ))}
            </select>
          </Row>
        </>
      )}
      {error && (
        <Row label={t('settingsCalendar.error')} hint={<span role="alert" style={{ color: 'var(--ui-tone-red-text)' }}>{error}</span>} />
      )}
    </Group>
  )
}
