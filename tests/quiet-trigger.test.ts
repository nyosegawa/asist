import { describe, expect, it } from 'vitest'
import { isQuiet, type QuietState } from '@shared/quiet-trigger'

const MIN = 60_000
const base: QuietState = {
  now: 100 * MIN,
  lastActivityAt: 90 * MIN,
  turnActive: false
}

describe('isQuiet', () => {
  it('reports a gap when quietMs has passed since the last exchange and no turn is running', () => {
    expect(isQuiet(base, { quietMs: 5 * MIN })).toBe(true)
    expect(isQuiet({ ...base, lastActivityAt: 97 * MIN }, { quietMs: 5 * MIN })).toBe(false)
    expect(isQuiet({ ...base, turnActive: true }, { quietMs: 5 * MIN })).toBe(false)
  })

  it('ignores the elapsed time while there has been no conversation yet', () => {
    expect(isQuiet({ ...base, lastActivityAt: null }, { quietMs: 5 * MIN })).toBe(true)
  })
})
