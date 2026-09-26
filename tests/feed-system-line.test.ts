// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTranslator } from '@shared/i18n'
import { errorText } from '@shared/i18n/error-text'
import type { AppSettings } from '@shared/ipc'
import { Feed } from '../src/renderer/src/ui/Feed'
import { useFeedStore, useSettingsStore } from '../src/renderer/src/state/stores'

vi.mock('@/conversation', () => ({ sendTypedMessage: vi.fn() }))
vi.mock('@/voice/SpeechPlayer', () => ({ speechPlayer: { karaoke: () => null } }))

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  useFeedStore.setState({ lines: [] })
})

const withLocale = (uiLocale: string): void => {
  useSettingsStore.setState({ settings: { uiLocale } as unknown as AppSettings })
}

const t = createTranslator('ja-JP')

describe('a system line of the feed', () => {
  it('follows a change of the interface language after it was appended', async () => {
    withLocale('ja-JP')
    useFeedStore.getState().append({ role: 'sys', text: '', message: { key: 'conversation.start' } })
    useFeedStore.getState().append({ role: 'sys', text: '', message: { key: 'conversation.error', values: { message: 'boom' } } })
    const container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
    await act(async () => root!.render(React.createElement(Feed)))
    expect(container.textContent).toContain(t('conversation.start'))
    expect(container.textContent).toContain('boom')
    await act(async () => withLocale('en-US'))
    expect(container.textContent).toContain('Turn the microphone on and start talking')
    expect(container.textContent).not.toContain(t('conversation.start'))
    expect(container.textContent).toContain('boom')
  })

  it('words an error the line holds in the language the interface has when it is drawn', async () => {
    const en = createTranslator('en-US')
    withLocale('ja-JP')
    const message = errorText('speechRecognition.errors.serverTranscribeFailed', { detail: errorText('speechRecognition.errors.transcribeTimeout') })
    useFeedStore.getState().append({ role: 'sys', text: '', message: { key: 'conversation.error', values: { message } } })
    const container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
    await act(async () => root!.render(React.createElement(Feed)))
    expect(container.textContent).toContain(t('speechRecognition.errors.transcribeTimeout'))
    await act(async () => withLocale('en-US'))
    expect(container.textContent).toContain(en('speechRecognition.errors.transcribeTimeout'))
    expect(container.textContent).not.toContain('[asist:')
  })
})
