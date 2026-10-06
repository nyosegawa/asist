// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, SpeechModelNotice } from '@shared/ipc'
import { createTranslator } from '@shared/i18n'
import { osMessageKey } from '@shared/i18n/os-message'
import { SpeechModelNotices } from '@/ui/SpeechModelNotices'
import { useSettingsStore, useToastStore } from '@/state/stores'
import { usePreparationStore } from '@/state/preparation'
import { useViewStore } from '@/state/view'
import { MACOS, setCapabilities } from './helpers/platform'

vi.mock('@/platform', () => import('./helpers/platform'))

const t = createTranslator('en-US')
const NOTICE: SpeechModelNotice = { target: 'tts', label: 'Irodori-TTS', downloadBytes: 1_885_435_968 }

const api = {
  speechModelNotices: vi.fn(async (): Promise<SpeechModelNotice[]> => [NOTICE]),
  prepareTtsModel: vi.fn(() => new Promise<{ ok: boolean; message: string }>(() => {})),
  onSetupProgress: vi.fn(() => () => {})
}

const launchedWith = (settings: Partial<AppSettings>): void =>
  useSettingsStore.setState({
    settings: { uiLocale: 'en-US', region: 'US', onboardingVersion: 1, safetyNoticeVersion: 1, localAsrEnabled: false, theme: 'future', ...settings } as AppSettings
  })
const change = (patch: Partial<AppSettings>): void => useSettingsStore.setState((state) => ({ settings: { ...state.settings!, ...patch } }))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('React', React)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('api', api)
  setCapabilities(MACOS)
  api.speechModelNotices.mockClear()
  api.prepareTtsModel.mockClear()
  useToastStore.setState({ toasts: [] })
  useViewStore.setState({ open: null })
  usePreparationStore.setState({ running: null })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useToastStore.setState({ toasts: [] })
  vi.unstubAllGlobals()
})

describe('the notice at launch of a local speech model that needs preparing', () => {
  it('waits for the notice of the risks, asks once, and stays up naming the model and what preparing it downloads', async () => {
    launchedWith({ safetyNoticeVersion: 0 })
    await act(async () => root.render(<SpeechModelNotices />))
    expect(api.speechModelNotices).not.toHaveBeenCalled()

    await act(async () => change({ safetyNoticeVersion: 1 }))
    await act(async () => change({ theme: 'pop' }))
    expect(api.speechModelNotices).toHaveBeenCalledTimes(1)
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({
        persistent: true,
        title: t('settingsModels.notice.title', { model: 'Irodori-TTS' }),
        body: t(osMessageKey('settingsModels.notice.speech', 'macos')),
        action: expect.objectContaining({ label: t('settingsModels.notice.prepare', { sizeGb: '1.9' }) })
      })
    ])
  })

  it('prepares the model as the settings do and opens the voice page, where the progress shows', async () => {
    launchedWith({})
    await act(async () => root.render(<SpeechModelNotices />))
    await act(async () => useToastStore.getState().toasts[0].action!.run())
    expect(api.prepareTtsModel).toHaveBeenCalledTimes(1)
    expect(usePreparationStore.getState().running?.target).toBe('tts')
    expect(useViewStore.getState().open).toEqual(expect.objectContaining({ app: 'settings', page: 'voice' }))
  })

  it('asks for nothing in a launch that opened on the first-run setup', async () => {
    launchedWith({ onboardingVersion: 0, safetyNoticeVersion: 0 })
    await act(async () => root.render(<SpeechModelNotices />))
    await act(async () => change({ safetyNoticeVersion: 1 }))
    await act(async () => change({ onboardingVersion: 1 }))
    expect(api.speechModelNotices).not.toHaveBeenCalled()
  })
})
