import { describe, expect, it, vi } from 'vitest'
import { VapAudio } from '../src/renderer/src/voice/VapAudio'

const samples = (length: number, value: number): Float32Array => new Float32Array(length).fill(value)

describe('VapAudio', () => {
  it('packs uneven chunks into 80 ms blocks in order and fills the part with no playback audio with silence', () => {
    const emit = vi.fn()
    const audio = new VapAudio(emit)
    audio.pushAssistant(samples(1000, 0.5), 16_000)
    audio.pushUser(samples(600, 1))
    expect(emit).not.toHaveBeenCalled()
    audio.pushUser(samples(1960, 2))
    expect(emit).toHaveBeenCalledTimes(2)
    const [firstUser, firstAssistant] = emit.mock.calls[0]
    expect([...firstUser]).toEqual([...samples(600, 1), ...samples(680, 2)])
    expect([...firstAssistant]).toEqual([...samples(1000, 0.5), ...samples(280, 0)])
    expect([...emit.mock.calls[1][0]]).toEqual([...samples(1280, 2)])
    expect([...emit.mock.calls[1][1]]).toEqual([...samples(1280, 0)])
  })

  it('drops the older playback audio and pairs the newest with the microphone when the microphone lags', () => {
    const emit = vi.fn()
    const audio = new VapAudio(emit)
    audio.pushAssistant(samples(16_000, 1), 16_000)
    audio.pushAssistant(samples(1280, 2), 16_000)
    audio.pushUser(samples(1280, 0))
    expect([...emit.mock.calls[0][1]]).toEqual([...samples(1280, 2)])
  })

  it('pairs the microphone with what is playing now after a whole reply played before its first frame', () => {
    const emit = vi.fn()
    const audio = new VapAudio(emit)
    // The output tap's render quanta at 48 kHz: a second of reply while the microphone is still
    // starting, then 400 ms more.
    for (let i = 0; i < 375; i++) audio.pushAssistant(samples(128, 1), 48_000)
    for (let i = 0; i < 150; i++) audio.pushAssistant(samples(128, 2), 48_000)
    audio.pushUser(samples(1280, 0))
    audio.pushUser(samples(1280, 0))

    for (const [, assistant] of emit.mock.calls) expect([...(assistant as Float32Array)]).toEqual([...samples(1280, 2)])
  })

  it('does not mix in unsent audio or a resampling remainder from before the microphone stopped', () => {
    const emit = vi.fn()
    const audio = new VapAudio(emit)
    audio.pushAssistant(samples(1, 1), 48_000)
    audio.pushUser(samples(500, 1))
    audio.reset()
    audio.pushAssistant(samples(3841, 0.5), 48_000)
    audio.pushUser(samples(1280, 2))
    expect(emit).toHaveBeenCalledOnce()
    expect([...emit.mock.calls[0][0]]).toEqual([...samples(1280, 2)])
    expect([...emit.mock.calls[0][1]]).toEqual([...samples(1280, 0.5)])
  })
})
