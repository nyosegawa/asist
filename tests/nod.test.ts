import { describe, expect, it } from 'vitest'
import { shouldNod, type NodInput } from '@shared/nod'

const base: NodInput = {
  userSpeaking: true,
  assistantSpeaking: false,
  nod: { short: 0.1, long: 0.1 },
  msSinceLast: 10_000
}

describe('shouldNod', () => {
  it('returns long when the probability of a long nod reaches the threshold', () => {
    expect(shouldNod({ ...base, nod: { short: 0.1, long: 0.6 } })).toBe('long')
  })

  it('returns short when only the short nod is above its threshold', () => {
    expect(shouldNod({ ...base, nod: { short: 0.45, long: 0.2 } })).toBe('short')
  })

  it('prefers long when both are above their threshold', () => {
    expect(shouldNod({ ...base, nod: { short: 0.9, long: 0.9 } })).toBe('long')
  })

  it('does not nod when neither reaches its threshold', () => {
    expect(shouldNod(base)).toBeNull()
  })

  it('does not nod while the assistant is not the listener, that is while the user is silent or the assistant speaks', () => {
    const hot = { short: 0.9, long: 0.9 }
    expect(shouldNod({ ...base, nod: hot, userSpeaking: false })).toBeNull()
    expect(shouldNod({ ...base, nod: hot, assistantSpeaking: true })).toBeNull()
  })

  it('does not nod again inside the minimum interval', () => {
    expect(shouldNod({ ...base, nod: { short: 0.9, long: 0.9 }, msSinceLast: 800 })).toBeNull()
  })

  it('does not nod while the model is not ready', () => {
    expect(shouldNod({ ...base, nod: null })).toBeNull()
  })
})
