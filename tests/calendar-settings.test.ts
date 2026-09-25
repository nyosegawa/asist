// @vitest-environment happy-dom
import { createTranslator } from '@shared/i18n'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { CalendarSettings } from '../src/renderer/src/ui/settings/CalendarSettings'
import { useSettingsStore } from '../src/renderer/src/state/stores'
import type { AppSettings } from '../src/shared/settings'

let container: HTMLDivElement, root: Root
const status = {
  authorization: 'fullAccess',
  calendars: [
    { id: 'google', source: 'Google', title: '仕事', writable: true },
    { id: 'holidays', source: '購読', title: '祝日', writable: false }
  ]
}
const requestAccess = vi.fn(),
  saveSettings = vi.fn()
const settings = {
  calendar: { enabled: false, readCalendarIds: [], writeCalendarId: null }
} as unknown as AppSettings
function Harness(): React.JSX.Element {
  const current = useSettingsStore((state) => state.settings)!
  return React.createElement(CalendarSettings, { settings: current })
}
beforeEach(() => {
  vi.stubGlobal('React', React)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  requestAccess.mockReset()
  saveSettings.mockReset()
  window.api = {
    calendarStatus: async () => status,
    calendarRequestAccess: requestAccess,
    saveSettings
  } as unknown as typeof window.api
  saveSettings.mockImplementation(async (patch) => ({ ...settings, ...patch }))
  useSettingsStore.setState({ settings })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
it('permission denial does not enable integration and is shown as an error', async () => {
  requestAccess.mockResolvedValue({ authorization: 'denied', calendars: [] })
  await act(async () => root.render(React.createElement(Harness)))
  await act(async () =>
    container
      .querySelector<HTMLInputElement>(
        `[aria-label="${createTranslator('ja-JP')('settingsCalendar.enable')}"]`
      )!
      .click()
  )
  expect(saveSettings).not.toHaveBeenCalled()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    '拒否'
  )
})
it('keeps reading and writing selections separate and excludes read-only destinations', async () => {
  requestAccess.mockResolvedValue(status)
  await act(async () => root.render(React.createElement(Harness)))
  await act(async () =>
    container
      .querySelector<HTMLInputElement>(
        `[aria-label="${createTranslator('ja-JP')('settingsCalendar.enable')}"]`
      )!
      .click()
  )
  expect(saveSettings.mock.calls[0][0].calendar).toEqual({
    enabled: true,
    readCalendarIds: [],
    writeCalendarId: null
  })
  const select = container.querySelector<HTMLSelectElement>('select')!
  expect([...select.options].map((option) => option.value)).toEqual([
    '',
    'google'
  ])
  const read = container.querySelectorAll<HTMLInputElement>('fieldset input')[1]
  await act(async () => read.click())
  expect(saveSettings.mock.calls.at(-1)[0].calendar).toMatchObject({
    readCalendarIds: ['holidays'],
    writeCalendarId: null
  })
})
