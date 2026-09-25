import { describe, expect, it } from 'vitest'
import { createTranslator } from '@shared/i18n'
import { errorText, readErrorText } from '@shared/i18n/error-text'
import { useSettingsStore } from '../src/renderer/src/state/stores'
import { displayError } from '../src/renderer/src/display-error'

const t = createTranslator('ja-JP')

describe('displayError', () => {
  it('drops the wrapper Electron puts around an error thrown in the main process, whatever the error class', () => {
    // The wrapper names an IPC channel, which means nothing to the user.
    expect(displayError(new Error("Error invoking remote method 'settings-save': Error: 保存日数は 1 以上にしてください"))).toBe('保存日数は 1 以上にしてください')
    expect(displayError(new Error("Error invoking remote method 'mail-probe': TypeError: fetch failed"))).toBe('fetch failed')
  })

  it('keeps a message that only mentions the wrapper text later on, and turns a thrown non-error into text', () => {
    expect(displayError(new Error("開けませんでした: Error invoking remote method 'x': Error: y"))).toBe("開けませんでした: Error invoking remote method 'x': Error: y")
    expect(displayError('接続が切れました')).toBe('接続が切れました')
    expect(displayError({ code: 1 })).toBe('[object Object]')
  })

  it('writes an error that carries a message key in the language of the interface, while the message itself stays English for the log', () => {
    const message = errorText('settingsModels.preparation.startFailed', { model: 'Qwen3-TTS' })
    expect(message.startsWith("Couldn't start Qwen3-TTS.")).toBe(true)
    // The settings have not loaded, so the interface is in the source language.
    expect(displayError(new Error(`Error invoking remote method 'tts-prepare': Error: ${message}`))).toBe(t('settingsModels.preparation.startFailed', { model: 'Qwen3-TTS' }))
    useSettingsStore.setState({ settings: { uiLocale: 'en-US' } as never })
    expect(displayError(new Error(message))).toBe("Couldn't start Qwen3-TTS.")
    useSettingsStore.setState({ settings: null })
  })

  it('finds the key when other code has wrapped the message, and leaves an unknown key as plain text', () => {
    const wrapped = `settings: ${errorText('settingsModels.preparation.stopped')} (while saving)`
    expect(displayError(new Error(wrapped))).toContain(t('settingsModels.preparation.stopped'))
    expect(readErrorText('Something failed [asist:no.such.key]')).toBeNull()
    expect(displayError(new Error('Something failed [asist:no.such.key]'))).toBe('Something failed [asist:no.such.key]')
  })
})
