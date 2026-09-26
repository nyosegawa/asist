import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTranslator } from '@shared/i18n'
import { errorText, readErrorText } from '@shared/i18n/error-text'

const mocks = vi.hoisted(() => ({ conversationLocale: 'ja-JP' }))
vi.mock('../src/main/services/settings', () => ({
  getSettings: () => ({ uiLocale: 'en-US', conversationLocale: mocks.conversationLocale })
}))

afterEach(() => {
  mocks.conversationLocale = 'ja-JP'
})

describe('the text of a tool error for the model', () => {
  it('is in the conversation language without the message key, whatever language the interface is in', async () => {
    const { errMessage } = await import('../src/main/services/brain/tool-error-text')
    expect(errMessage(new Error(errorText('settingsModels.preparation.startFailed', { model: 'Qwen3-TTS' })))).toBe(createTranslator('ja-JP')('settingsModels.preparation.startFailed', { model: 'Qwen3-TTS' }))
    expect(errMessage(new Error('ECONNRESET'))).toBe('ECONNRESET')

    mocks.conversationLocale = 'fr-FR'
    expect(errMessage(new Error(errorText('settingsModels.preparation.startFailed', { model: 'Qwen3-TTS' })))).toBe('Impossible de démarrer Qwen3-TTS.')
  })

  it('gives a card a message of the screen for a time limit and for a ToolError, never the model\'s text', async () => {
    const { cardError } = await import('../src/main/services/brain/tool-error-text')
    const { ToolError } = await import('@shared/tool-registry')
    for (const err of [new DOMException('show_news ran past 8000 ms', 'TimeoutError'), new ToolError({ ja: '見つからない', en: 'Not found' })]) {
      expect(readErrorText(cardError(err), 'en-US'), err.name).not.toBeNull()
    }
  })

  it('unpacks the two languages of a ToolError but keeps any other message as it is, however it starts', async () => {
    const { detail } = await import('../src/main/services/brain/tool-error-text')
    const { ToolError } = await import('@shared/tool-registry')
    expect(detail(new ToolError({ ja: '見つからない', en: 'Not found' }), 'en')).toBe('Not found')
    const outside = 'bilingual: 請求書'
    expect(detail(new Error(outside), 'en')).toBe(outside)
  })
})

/**
 * A fixed line the assistant says aloud is part of the conversation, not part of the screen, so the
 * interface here stays English while the conversation moves, which is what tells the two translators
 * apart.
 */
describe('the fixed lines the assistant speaks', () => {
  it('are looked up in the language of the conversation, not in the language of the interface', async () => {
    const { t, tConversation } = await import('../src/main/services/i18n')
    mocks.conversationLocale = 'en-US'
    expect(t('spoken.turnStopped')).toBe(tConversation('spoken.turnStopped'))

    mocks.conversationLocale = 'ko-KR'
    expect(tConversation('spoken.turnStopped')).not.toBe(t('spoken.turnStopped'))
    expect(tConversation('spoken.turnStopped')).toBe(createTranslator('ko-KR')('spoken.turnStopped'))
  })
})
