import { describe, expect, it, vi } from 'vitest'
import { VapAudio } from '../src/renderer/src/voice/VapAudio'

const samples = (length: number, value: number): Float32Array => new Float32Array(length).fill(value)

describe('VapAudio', () => {
  it('packs uneven chunks into 80 ms blocks in order and fills the part with no playback audio with silence', () => {
    const emit = vi.fn()
    const audio = new VapAudio(emit)
    // Less played audio than the microphone's first delivery, so none of it is older than the microphone's.
    audio.pushAssistant(samples(500, 0.5), 16_000)
    audio.pushUser(samples(600, 1))
    audio.pushUser(samples(1960, 2))
    while (emit.mock.calls.length < 2) audio.pushUser(samples(1960, 3))

    const [firstUser, firstAssistant] = emit.mock.calls[0]
    expect([...firstUser]).toEqual([...samples(600, 1), ...samples(680, 2)])
    expect([...firstAssistant]).toEqual([...samples(500, 0.5), ...samples(780, 0)])
    expect([...emit.mock.calls[1][0]]).toEqual([...samples(1280, 2)])
    expect([...emit.mock.calls[1][1]]).toEqual([...samples(1280, 0)])
  })

  /**
   * Plays a ramp of the time each sample plays at through the output tap's 128-sample render quanta at 48 kHz,
   * from a second before the microphone's first audio, as a reply that plays while the microphone starts. The
   * microphone hands its audio over in deliveries of deliverySamples, each 15 ms after its end and up to 3 ms early
   * or late, and cut into pieces of pieceSamples 0.6 ms apart. Returns, over the first two seconds of microphone
   * audio, how many of the played samples paired with it were silent, and the largest distance in milliseconds
   * between when a microphone sample was heard and when the played sample paired with it played.
   */
  function pairingOfTheFirstSeconds(deliverySamples: number, pieceSamples = deliverySamples): { silent: number; worstMs: number } {
    let silent = 0
    let worstMs = 0
    // Every sample carries its time in seconds, shifted so that no sample of either side is 0.
    const audio = new VapAudio((user, assistant) => {
      for (let i = 0; i < user.length; i++) {
        if (user[i] >= 12) return
        if (assistant[i] === 0) silent++
        else worstMs = Math.max(worstMs, Math.abs(assistant[i] - user[i]) * 1000)
      }
    })
    const tapMs = 128 / 48
    const jitterMs = [0, 3, -3, 2, -2, 1]
    const events: Array<{ at: number; tap?: number; user?: { from: number; length: number } }> = []
    for (let i = 0; -1000 + (i + 1) * tapMs < 3_000; i++) events.push({ at: -1000 + (i + 1) * tapMs, tap: i })
    for (let d = 0; ((d + 1) * deliverySamples) / 16 < 3_000; d++) {
      const arrives = ((d + 1) * deliverySamples) / 16 + 15 + jitterMs[d % 6]
      for (let offset = 0, k = 0; offset < deliverySamples; offset += pieceSamples, k++) {
        const length = Math.min(pieceSamples, deliverySamples - offset)
        events.push({ at: arrives + 0.6 * k, user: { from: d * deliverySamples + offset, length } })
      }
    }
    events.sort((a, b) => a.at - b.at)
    for (const { tap, user } of events) {
      if (user) audio.pushUser(Float32Array.from({ length: user.length }, (_, k) => 10 + (user.from + k) / 16_000))
      else audio.pushAssistant(Float32Array.from({ length: 128 }, (_, k) => 9 + (tap! * 128 + k) / 48_000), 48_000)
    }
    return { silent, worstMs }
  }

  // Within one of MaAI's 80 ms frames, the played audio is what played while the microphone heard its frame.
  const FRAME_MS = 80

  it('pairs the first seconds with what plays at the time when DeepFilterNet hands the helper\'s 100 ms over in pieces', () => {
    const { silent, worstMs } = pairingOfTheFirstSeconds(1_600, 171)
    expect(silent).toBe(0)
    expect(worstMs).toBeLessThan(FRAME_MS)
  })

  it('pairs the first seconds with what plays at the time when DeepFilterNet hands 400 ms over in pieces', () => {
    const { silent, worstMs } = pairingOfTheFirstSeconds(6_400, 171)
    expect(silent).toBe(0)
    expect(worstMs).toBeLessThan(FRAME_MS)
  })

  it('pairs the first seconds with what plays at the time when getUserMedia hands over 21 ms at a time', () => {
    const { silent, worstMs } = pairingOfTheFirstSeconds(341)
    expect(silent).toBe(0)
    expect(worstMs).toBeLessThan(FRAME_MS)
  })

  it('pairs the first seconds with what plays at the time when the native helper hands over 100 ms at a time', () => {
    const { silent, worstMs } = pairingOfTheFirstSeconds(1_600)
    expect(silent).toBe(0)
    expect(worstMs).toBeLessThan(FRAME_MS)
  })

  /**
   * Plays a ramp through the output tap's 128-sample render quanta at 48 kHz for ten seconds, hands the
   * microphone over in chunks of the given length, each up to 3 ms early or late and cut into pieces of
   * pieceSamples 0.6 ms apart, and returns where the played audio paired with it breaks off after the first
   * second.
   */
  function breaksInPlayedAudio(chunkSamples: number, pieceSamples = chunkSamples): number[] {
    const paired: number[] = []
    const audio = new VapAudio((_user, assistant) => paired.push(...assistant))
    const tapMs = 128 / 48
    const chunkMs = chunkSamples / 16
    const jitterMs = [0, 3, -3, 2, -2, 1]
    const events: Array<{ at: number; tap: number | null; user?: number }> = []
    for (let i = 0; i * tapMs < 10_000; i++) events.push({ at: i * tapMs, tap: i })
    for (let i = 1; i * chunkMs < 10_000; i++) {
      for (let offset = 0, k = 0; offset < chunkSamples; offset += pieceSamples, k++) {
        const user = Math.min(pieceSamples, chunkSamples - offset)
        events.push({ at: i * chunkMs + 15 + jitterMs[i % 6] + 0.6 * k, tap: null, user })
      }
    }
    events.sort((a, b) => a.at - b.at)
    for (const { tap, user } of events) {
      if (tap === null) audio.pushUser(samples(user!, 0))
      else audio.pushAssistant(Float32Array.from({ length: 128 }, (_, k) => (tap * 128 + k + 48) / 48_000), 48_000)
    }
    const steady = paired.slice(16_000)
    return steady.slice(1).filter((value, index) => Math.abs(value - steady[index] - 1 / 16_000) > 1e-6)
  }

  it('passes the played audio on without gaps or padding when the native helper hands over 100 ms at a time', () => {
    expect(breaksInPlayedAudio(1_600)).toEqual([])
  })

  it('passes the played audio on without gaps or padding when getUserMedia hands over 21 ms at a time', () => {
    expect(breaksInPlayedAudio(341)).toEqual([])
  })

  it('passes the played audio on without gaps or padding when DeepFilterNet hands the helper\'s 100 ms over in pieces', () => {
    // Each 512-sample chunk at 48 kHz comes back from DeepFilterNet's worker on its own, as 171 samples at 16 kHz.
    expect(breaksInPlayedAudio(1_600, 171)).toEqual([])
  })

  it('does not mix in unsent audio or a resampling remainder from before the microphone stopped', () => {
    const emit = vi.fn()
    const audio = new VapAudio(emit)
    audio.pushAssistant(samples(1, 1), 48_000)
    audio.pushUser(samples(500, 1))
    audio.reset()
    audio.pushAssistant(samples(3841, 0.5), 48_000)
    audio.pushUser(samples(1280, 2))
    while (emit.mock.calls.length === 0) audio.pushUser(samples(1280, 3))
    expect([...emit.mock.calls[0][0]]).toEqual([...samples(1280, 2)])
    expect([...emit.mock.calls[0][1]]).toEqual([...samples(1280, 0.5)])
  })
})
