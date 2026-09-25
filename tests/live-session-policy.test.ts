import { describe, expect, it } from 'vitest'
import { LiveSessionPolicy } from '../src/shared/live-session-policy'

const policy = (): LiveSessionPolicy => new LiveSessionPolicy({ idleMs: 5000, preRollMs: 1000, sampleRate: 16_000 })

describe('LiveSessionPolicy', () => {
  it('opens on user speech while it is closed and keeps the session while it is open', () => {
    const p = policy()
    expect(p.onUserSpeech(0)).toBe('open')
    p.opened(100)
    expect(p.onUserSpeech(200)).toBe('keep')
  })

  it('closes after idleMs without activity and pushes the deadline back on speech or model activity', () => {
    const p = policy()
    p.opened(0)
    expect(p.tick(4999)).toBe('keep')
    p.activity(4000)
    expect(p.tick(8999)).toBe('keep')
    expect(p.tick(9000)).toBe('close')
    p.closed()
    expect(p.tick(20000)).toBe('keep')
  })

  it('keeps preRollMs of audio while closed and hands it back in order once the session opens', () => {
    const p = policy()
    for (let i = 0; i < 10; i++) p.buffer(new Float32Array(4000).fill(i))
    const frames = p.takePreRoll()
    // One second is 16000 samples, which is four frames of 4000; beyond that the oldest frames are dropped.
    expect(frames.length).toBe(4)
    expect(frames.map((f) => f[0])).toEqual([6, 7, 8, 9])
    expect(p.takePreRoll()).toEqual([])
  })

  it('buffers nothing while the session is open', () => {
    const p = policy()
    p.opened(0)
    p.buffer(new Float32Array(100))
    expect(p.takePreRoll()).toEqual([])
  })
})
