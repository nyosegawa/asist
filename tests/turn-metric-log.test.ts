import { describe, expect, it } from 'vitest'
import { parseTurnMetricLog } from '@shared/turn-metric-log'

const base = { id: 'request-1', revision: 1, occurredAt: 1_700_000_000_000 }

describe('parseTurnMetricLog validates one line of metrics.jsonl', () => {
  it('keeps the fields it knows and drops unknown keys and undefined values', () => {
    const entry = parseTurnMetricLog({
      ...base,
      vadMs: 300,
      vadMode: 'extended',
      aizuchiClipMs: 640,
      bridge: 'played',
      bridgeMs: 900,
      listening: [{ kind: 'continuer', source: 'both', atMs: 3000, continued: true }],
      cacheMissReason: 'ttl',
      bogus: 'ignored'
    })
    expect(entry).toEqual({
      ...base,
      vadMs: 300,
      vadMode: 'extended',
      aizuchiClipMs: 640,
      bridge: 'played',
      bridgeMs: 900,
      listening: [{ kind: 'continuer', source: 'both', atMs: 3000, continued: true }],
      cacheMissReason: 'ttl'
    })
    expect(Object.keys(entry)).not.toContain('bogus')
  })

  it('rejects a line without an id, a revision or a timestamp, and a duration that is negative or infinite', () => {
    expect(() => parseTurnMetricLog({ revision: 1, occurredAt: 1 })).toThrow()
    expect(() => parseTurnMetricLog({ ...base, revision: 0 })).toThrow()
    expect(() => parseTurnMetricLog({ ...base, e2eMs: -1 })).toThrow()
    expect(() => parseTurnMetricLog({ ...base, ttftMs: Number.POSITIVE_INFINITY })).toThrow()
    expect(() => parseTurnMetricLog({ ...base, vadMode: 'sometimes' })).toThrow()
    expect(() => parseTurnMetricLog({ ...base, bridge: 'maybe' })).toThrow()
    expect(() =>
      parseTurnMetricLog({ ...base, listening: [{ kind: 'continuer', source: 'guess', atMs: 1, continued: true }] })
    ).toThrow()
    expect(() => parseTurnMetricLog({ ...base, cacheMissReason: 'bogus' })).toThrow()
  })
})
