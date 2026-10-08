// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asrModelSpec, offeredAsrModels, recommendAsrModel } from '@shared/asr-models'
import type { AppSettings, SpeechModelNotice } from '@shared/ipc'
import { createTranslator } from '@shared/i18n'
import { osMessageKey } from '@shared/i18n/os-message'
import { localTtsModel } from '@shared/tts-models'
import { SpeechModelNotices } from '@/ui/SpeechModelNotices'
import { Toasts } from '@/ui/Toasts'
import { useSettingsStore, useToastStore } from '@/state/stores'
import { usePreparationStore } from '@/state/preparation'
import { useViewStore } from '@/state/view'
import { MACOS, setCapabilities } from './helpers/platform'
import { TEST_SPEECH_CATALOG } from './helpers/speech-catalog'

vi.mock('@/platform', () => import('./helpers/platform'))
vi.mock('@/speech-catalog', () => import('./helpers/speech-catalog'))
// motion's animations do not run in happy-dom, and a cancelled one surfaces as an unhandled AbortError.
vi.mock('motion/react', async () => {
  const { createElement, Fragment, forwardRef } = await import('react')
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => createElement(Fragment, null, children),
    motion: {
      div: forwardRef<HTMLDivElement, Record<string, unknown>>(({ initial, animate, exit, ...props }, ref) => createElement('div', { ...props, ref }))
    }
  }
})

const t = createTranslator('en-US')
/** The model the automatic choice of speech recognition stands for on the 32 GB Mac of the fixture, and another. */
const RECOMMENDED = recommendAsrModel('metal', 32).recommendedModel
const OTHER = offeredAsrModels().find((model) => model !== RECOMMENDED)!
const RECOGNITION = asrModelSpec(RECOMMENDED)
const READING: SpeechModelNotice = { target: 'tts', label: localTtsModel('irodori', '0.6b', TEST_SPEECH_CATALOG).label, downloadBytes: 1_885_435_968 }
const LISTENING: SpeechModelNotice = { target: 'asr', label: RECOGNITION.label, downloadBytes: 2_520_744_288 }

type Result = { ok: boolean; message: string }
const api = {
  speechModelNotices: vi.fn(async (): Promise<SpeechModelNotice[]> => [READING]),
  prepareTtsModel: vi.fn((): Promise<Result> => new Promise(() => {})),
  prepareAsrModel: vi.fn((): Promise<Result> => new Promise(() => {})),
  onSetupProgress: vi.fn(() => () => {}),
  getStatus: vi.fn(async () => ({ sequence: 1 }))
}

const launchedWith = (settings: Partial<AppSettings>): void =>
  useSettingsStore.setState({
    settings: {
      uiLocale: 'en-US',
      region: 'US',
      onboardingVersion: 1,
      safetyNoticeVersion: 1,
      localAsrEnabled: false,
      theme: 'future',
      voiceEngine: 'cascade',
      ttsEngine: 'irodori',
      qwenTtsSize: '0.6b',
      asrModel: 'auto',
      ...settings
    } as AppSettings
  })
const change = (patch: Partial<AppSettings>): void => useSettingsStore.setState((state) => ({ settings: { ...state.settings!, ...patch } }))
const titles = (): string[] => useToastStore.getState().toasts.map((toast) => toast.title)
const titleOf = (notice: SpeechModelNotice): string => t('settingsModels.notice.title', { model: notice.label })
/** The button of the toast whose text starts with the title. */
const prepareButton = (notice: SpeechModelNotice): HTMLButtonElement =>
  [...container.querySelectorAll<HTMLElement>('[data-toast]')]
    .find((toast) => toast.textContent?.startsWith(titleOf(notice)))!
    .querySelector<HTMLButtonElement>('[data-tone="primary"]')!

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('React', React)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('api', api)
  setCapabilities(MACOS)
  for (const mock of Object.values(api)) mock.mockClear()
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
        title: titleOf(READING),
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

  it('keeps the other notice, its button not pressable, while one preparation runs, and lets it start once that ends', async () => {
    let finish: (result: Result) => void = () => {}
    api.prepareTtsModel.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    api.speechModelNotices.mockResolvedValueOnce([LISTENING, READING])
    launchedWith({})
    await act(async () => root.render(<><SpeechModelNotices /><Toasts /></>))

    await act(async () => prepareButton(READING).click())
    expect(titles()).toEqual([titleOf(LISTENING)])
    expect(prepareButton(LISTENING).disabled).toBe(true)
    // A press that reaches the action while the other preparation runs is not taken, and the notice stays.
    await act(async () => useToastStore.getState().toasts[0].action!.run())
    expect(api.prepareAsrModel).not.toHaveBeenCalled()
    expect(titles()).toEqual([titleOf(LISTENING)])

    await act(async () => finish({ ok: true, message: '' }))
    expect(prepareButton(LISTENING).disabled).toBe(false)
    await act(async () => prepareButton(LISTENING).click())
    expect(api.prepareAsrModel).toHaveBeenCalledTimes(1)
    expect(titles()).toEqual([])
  })

  it.each<[string, Partial<AppSettings>]>([
    ['another local engine', { ttsEngine: 'qwen3tts' }],
    ['the system voice', { ttsEngine: 'system' }],
    ['a live engine', { voiceEngine: 'gemini-live' }]
  ])('goes away when the settings move to %s, whose preparation its button would not start', async (_name, patch) => {
    launchedWith({})
    await act(async () => root.render(<SpeechModelNotices />))
    await act(async () => change(patch))
    expect(titles()).toEqual([])
  })

  it('stays while a change of the setting leaves its model in use, and goes once it does not', async () => {
    api.speechModelNotices.mockResolvedValueOnce([LISTENING])
    launchedWith({})
    await act(async () => root.render(<SpeechModelNotices />))
    await act(async () => change({ asrModel: RECOMMENDED }))
    expect(titles()).toEqual([titleOf(LISTENING)])
    await act(async () => change({ asrModel: OTHER }))
    expect(titles()).toEqual([])
  })

  it.each([
    [false, 'settingsModels.notice.recognition'],
    [true, 'settingsModels.notice.recognitionWhisper']
  ] as const)('says, for the recognition model with in-browser Whisper %s, what listens until it is prepared', async (whisper, body) => {
    api.speechModelNotices.mockResolvedValueOnce([LISTENING])
    launchedWith({ localAsrEnabled: whisper })
    await act(async () => root.render(<SpeechModelNotices />))
    expect(useToastStore.getState().toasts).toEqual([expect.objectContaining({ body: t(body) })])
  })

  it('asks for nothing in a launch that opened on the first-run setup', async () => {
    launchedWith({ onboardingVersion: 0, safetyNoticeVersion: 0 })
    await act(async () => root.render(<SpeechModelNotices />))
    await act(async () => change({ safetyNoticeVersion: 1 }))
    await act(async () => change({ onboardingVersion: 1 }))
    expect(api.speechModelNotices).not.toHaveBeenCalled()
  })
})
