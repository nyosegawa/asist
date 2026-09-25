// @vitest-environment happy-dom
import fs from 'node:fs'
import path from 'node:path'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '@shared/ipc'
import { createTranslator } from '@shared/i18n'
import { openStoredContent } from '@shared/stored-format'
import { SETTINGS_FORMAT, safetyNoticePending } from '@shared/settings'
import { SafetyNotice } from '../src/renderer/src/ui/setup/safety'
import { useSettingsStore } from '../src/renderer/src/state/stores'

/** The risks are acknowledged once: a settings file from before the notice asks again, and an acknowledged one never does. */

const SAMPLES = path.join(__dirname, 'fixtures', 'stored')
const sample = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(SAMPLES, file), 'utf8')) as Record<string, unknown>
const ja = createTranslator('ja-JP')

describe('the acknowledgement of the risks in settings.json', () => {
  it('asks someone who finished the setup before the notice existed', () => {
    const { value } = openStoredContent(SETTINGS_FORMAT, { ...sample('settings.v2.json'), onboardingVersion: 1 })
    expect(value.onboardingVersion).toBe(1)
    expect(value.safetyNoticeVersion).toBe(0)
    expect(safetyNoticePending(value)).toBe(true)
  })

  it('does not ask again once the acknowledgement is saved', () => {
    const { value } = openStoredContent(SETTINGS_FORMAT, sample('settings.v3.json'))
    expect(value.safetyNoticeVersion).toBe(1)
    expect(safetyNoticePending(value)).toBe(false)
  })

  it('leaves the question to the setup while it is unfinished', () => {
    const { value } = openStoredContent(SETTINGS_FORMAT, { ...sample('settings.v2.json'), onboardingVersion: 0 })
    expect(safetyNoticePending(value)).toBe(false)
  })
})

describe('the notice for someone who finished the setup', () => {
  let container: HTMLDivElement
  let root: Root
  let settings: AppSettings
  const api = {
    saveSettings: vi.fn(async (patch: Partial<AppSettings>) => {
      settings = { ...settings, ...patch }
      return settings
    }),
    openExternal: vi.fn(async () => {})
  }
  const onAcknowledged = vi.fn()

  const flush = (): Promise<void> => act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  const render = async (patch: Partial<AppSettings>): Promise<void> => {
    settings = { onboardingVersion: 1, safetyNoticeVersion: 0, uiLocale: 'ja-JP', ...patch } as AppSettings
    useSettingsStore.setState({ settings })
    await act(async () => root.render(React.createElement(SafetyNotice, { onAcknowledged })))
    await flush()
  }
  const continueButton = (): HTMLButtonElement | undefined =>
    [...container.querySelectorAll('button')].find((el) => el.textContent?.includes(ja('setup.safety.continue')))

  beforeEach(() => {
    vi.stubGlobal('React', React)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('window', Object.assign(window, { api }))
    api.saveSettings.mockClear()
    onAcknowledged.mockClear()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('is not shown to someone who has acknowledged the risks, nor during the setup', async () => {
    await render({ safetyNoticeVersion: 1 })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    await render({ onboardingVersion: 0 })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('stays until the box is ticked and the acknowledgement is saved, and then lets the app go on', async () => {
    await render({})
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    expect(continueButton()?.disabled).toBe(true)

    await act(async () => container.querySelector<HTMLInputElement>('.su-ack input')!.click())
    expect(api.saveSettings).not.toHaveBeenCalled()
    await act(async () => continueButton()!.click())
    await flush()

    expect(api.saveSettings).toHaveBeenCalledWith({ safetyNoticeVersion: 1 })
    expect(onAcknowledged).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('keeps the notice and does not let the app go on when the acknowledgement cannot be saved', async () => {
    api.saveSettings.mockRejectedValueOnce(new Error('disk full'))
    await render({})
    await act(async () => container.querySelector<HTMLInputElement>('.su-ack input')!.click())
    await act(async () => continueButton()!.click())
    await flush()

    expect(onAcknowledged).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('disk full')
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
  })
})
