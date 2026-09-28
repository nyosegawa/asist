import { describe, expect, it, vi } from 'vitest'
import { createTranslator } from '@shared/i18n'
import { errorText, readErrorText } from '@shared/i18n/error-text'

vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ uiLocale: 'en-US', conversationLocale: 'ko-KR' }) }))

describe('the text of a tool error for the model', () => {
  it('is in the conversation language it is given without the message key, whatever language the interface is in', async () => {
    const { detail } = await import('../src/main/services/brain/tool-error-text')
    const failed = new Error(errorText('settingsModels.preparation.startFailed', { model: 'Qwen3-TTS' }))
    expect(detail(failed, 'ja-JP')).toBe(createTranslator('ja-JP')('settingsModels.preparation.startFailed', { model: 'Qwen3-TTS' }))
    expect(detail(failed, 'fr-FR')).toBe(createTranslator('fr-FR')('settingsModels.preparation.startFailed', { model: 'Qwen3-TTS' }))
    expect(detail(new Error('ECONNRESET'), 'ja-JP')).toBe('ECONNRESET')
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
    expect(detail(new ToolError({ ja: '見つからない', en: 'Not found' }), 'en-US')).toBe('Not found')
    const outside = 'bilingual: 請求書'
    expect(detail(new Error(outside), 'en-US')).toBe(outside)
  })
})
