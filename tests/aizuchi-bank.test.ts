import type { AizuchiClip } from '@shared/ipc'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const load = vi.fn<() => Promise<AizuchiClip[]>>()
const clip = (audio: string): AizuchiClip => ({ text: 'うん', category: 'flow', weight: 1, audio })

beforeEach(() => {
  vi.resetModules()
  load.mockReset()
  vi.stubGlobal('window', { api: { aizuchiBank: load } })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('renderer aizuchi voice changes', () => {
  it('plays no aizuchi of the previous voice while the newly selected voice is loading', async () => {
    const bank = await import('../src/renderer/src/voice/aizuchi-bank')
    load.mockResolvedValueOnce([clip('old')])
    await bank.loadAizuchiBank('ja-JP')
    expect(bank.pickListeningClip()?.audio).toBe('old')

    let resolve!: (clips: AizuchiClip[]) => void
    load.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const pending = bank.loadAizuchiBank('ja-JP')
    expect(bank.pickListeningClip()).toBeNull()
    resolve([clip('selected')])
    await pending
    expect(bank.pickListeningClip()?.audio).toBe('selected')
  })

  it.each(['success', 'error'] as const)('keeps the current voice when a late %s of an older request arrives', async (outcome) => {
    const bank = await import('../src/renderer/src/voice/aizuchi-bank')
    let resolve!: (clips: AizuchiClip[]) => void
    let reject!: (error: Error) => void
    load.mockImplementationOnce(() => new Promise((done, fail) => { resolve = done; reject = fail }))
    const old = bank.loadAizuchiBank('ja-JP')
    load.mockResolvedValueOnce([clip('selected')])
    await bank.loadAizuchiBank('ja-JP')

    if (outcome === 'success') resolve([clip('old')])
    else reject(new Error('old failure'))
    await old
    expect(bank.pickListeningClip()?.audio).toBe('selected')
  })
})

describe('renderer aizuchi bank outside Japanese', () => {
  it('asks the main process for no bank and keeps none to play', async () => {
    const bank = await import('../src/renderer/src/voice/aizuchi-bank')
    await bank.loadAizuchiBank('en-US')
    expect(load).not.toHaveBeenCalled()
    expect(bank.pickListeningClip()).toBeNull()
    expect(bank.pickAizuchi({ cls: 'agree', prob: 1, complete: true }, { enabled: true, rate: 1 })).toBeNull()
  })

  it('drops the clips of the previous language when the conversation moves away from Japanese', async () => {
    const bank = await import('../src/renderer/src/voice/aizuchi-bank')
    load.mockResolvedValueOnce([clip('japanese')])
    await bank.loadAizuchiBank('ja-JP')
    expect(bank.pickListeningClip()?.audio).toBe('japanese')

    await bank.loadAizuchiBank('fr-FR')
    expect(bank.pickListeningClip()).toBeNull()
  })
})
