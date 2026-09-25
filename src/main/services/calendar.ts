import { app } from 'electron'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { errorText } from '@shared/i18n/error-text'
import { getSettings } from './settings'
import { CalendarService } from './calendar-service'
import { requestConfirm } from './confirm'
import { t } from './i18n'
import { childEnv } from './child-env'

export function runCalendarNative(
  input: Record<string, unknown>,
  signal?: AbortSignal
): Promise<unknown> {
  if (process.platform !== 'darwin')
    return Promise.reject(new Error(errorText('calendar.errors.macOnly')))
  const executable = app.isPackaged
    ? path.join(process.resourcesPath, 'asist-calendar')
    : path.join(app.getAppPath(), 'resources/native/asist-calendar')
  return new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      [],
      {
        timeout: input.operation === 'requestAccess' ? 120_000 : 15_000,
        maxBuffer: 4 * 1024 * 1024,
        signal,
        env: childEnv()
      },
      (error, stdout) => {
        if (error) {
          reject(new Error(errorText('calendar.errors.helperFailed')))
          return
        }
        try {
          const result = JSON.parse(stdout)
          if (result.ok !== true)
            throw new Error(
              typeof result.error === 'string'
                ? result.error
                : errorText('calendar.errors.helperBadResponse')
            )
          resolve(result.data)
        } catch (error) {
          reject(error)
        }
      }
    )
    child.stdin?.on('error', () => {
      /* execFile callback reports process failure. */
    })
    child.stdin?.end(JSON.stringify(input))
  })
}

const service = new CalendarService({
  settings: () => getSettings().calendar,
  native: runCalendarNative,
  confirm: (detail, signal, destructive) =>
    requestConfirm(
      {
        title: t('calendar.confirm.title'),
        message: t('calendar.confirm.message'),
        detail,
        confirmLabel: t('calendar.confirm.action'),
        destructive
      },
      signal
    )
})
export const calendarStatus = (): ReturnType<CalendarService['status']> =>
  service.status()
export const requestCalendarAccess = (): ReturnType<
  CalendarService['status']
> => service.status(true)
export const searchCalendar = (
  input: unknown,
  signal?: AbortSignal
): ReturnType<CalendarService['search']> => service.search(input, signal)
export const listCalendar = (
  input: unknown,
  signal?: AbortSignal
): ReturnType<CalendarService['list']> => service.list(input, signal)
export const changeCalendar = (
  input: unknown,
  signal: AbortSignal
): ReturnType<CalendarService['change']> => service.change(input, signal)

