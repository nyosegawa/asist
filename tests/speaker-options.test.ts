import type { SpeakerOption } from '@shared/ipc'
import { describe, expect, it, vi } from 'vitest'
import { requestSpeakerOptions } from '../src/renderer/src/ui/settings/speaker-options'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('settings speaker requests', () => {
  it.each(['success', 'error'] as const)('does not overwrite the current speaker options with a late %s from the previous engine', async (outcome) => {
    const voicevox = deferred<SpeakerOption[]>()
    const aivis = deferred<SpeakerOption[]>()
    const publish = vi.fn()
    const cancel = requestSpeakerOptions('voicevox', () => voicevox.promise, publish)
    cancel()
    requestSpeakerOptions('aivisspeech', () => aivis.promise, publish)
    expect(publish).toHaveBeenLastCalledWith({ engine: 'aivisspeech', status: 'loading', options: [] })

    const options = [{ id: 42, label: 'Aivis' }]
    aivis.resolve(options)
    await Promise.resolve()
    const updates = publish.mock.calls.length
    if (outcome === 'success') voicevox.resolve([{ id: 3, label: 'Voicevox' }])
    else voicevox.reject(new Error('old failure'))
    await Promise.resolve()

    expect(publish).toHaveBeenCalledTimes(updates)
    expect(publish).toHaveBeenLastCalledWith({ engine: 'aivisspeech', status: 'ready', options })
  })

  it('reports the error and drops the previous options when the current request fails', async () => {
    const publish = vi.fn()
    requestSpeakerOptions('voicevox', () => Promise.reject(new Error('connection failed')), publish)
    await Promise.resolve()
    expect(publish).toHaveBeenLastCalledWith({
      engine: 'voicevox', status: 'error', options: [], error: 'connection failed'
    })
  })

  it('ignores a reply that arrives after the settings dialog was closed', async () => {
    const pending = deferred<SpeakerOption[]>()
    const publish = vi.fn()
    const cancel = requestSpeakerOptions('voicevox', () => pending.promise, publish)
    cancel()
    pending.resolve([{ id: 3, label: 'Voicevox' }])
    await Promise.resolve()
    expect(publish.mock.calls).toEqual([[{ engine: 'voicevox', status: 'loading', options: [] }]])
  })
})
