import { describe, expect, it } from 'vitest'
import { diagnoseCacheMiss, fingerprintRequest, hashText, type SystemLayer } from '@shared/cache-diagnosis'

const layers: SystemLayer[] = [
  { name: 'base', text: 'BASE' },
  { name: 'memory', text: 'MEMORY' },
  { name: 'summary', text: 'SUMMARY' }
]
const tools = [{ name: 'show_weather' }]
const messages = [
  { role: 'user', content: [{ type: 'text', text: 'u1' }] },
  { role: 'assistant', content: 'a1' },
  { role: 'user', content: [{ type: 'text', text: 'u2' }] }
]

const fp = (at: number, over: Partial<Parameters<typeof fingerprintRequest>[0]> = {}) =>
  fingerprintRequest({ at, systemLayers: layers, tools, messages, ...over })

describe('hashText', () => {
  it('returns the same hash for the same text and a different hash for different text', () => {
    expect(hashText('abc')).toBe(hashText('abc'))
    expect(hashText('abc')).not.toBe(hashText('abd'))
  })
})

describe('diagnoseCacheMiss', () => {
  it('reports first when there is no previous request and ttl after five minutes', () => {
    expect(diagnoseCacheMiss(null, fp(0), { cacheRead: 0 })).toBe('first')
    expect(diagnoseCacheMiss(fp(0), fp(5 * 60_000), { cacheRead: 0 })).toBe('ttl')
  })

  it('reports tools when the tool list changes, and names the system layer that changed', () => {
    expect(diagnoseCacheMiss(fp(0), fp(1000, { tools: [{ name: 'x' }] }), { cacheRead: 0 })).toBe('tools')
    const memoryChanged = fp(1000, { systemLayers: [layers[0], { name: 'memory', text: 'MEMORY2' }, layers[2]] })
    expect(diagnoseCacheMiss(fp(0), memoryChanged, { cacheRead: 0 })).toBe('system_memory')
    const withoutMemory = fp(0, { systemLayers: [layers[0], layers[2]] })
    expect(diagnoseCacheMiss(withoutMemory, fp(1000), { cacheRead: 0 })).toBe('system_memory')
    const summaryGone = fp(1000, { systemLayers: [layers[0], layers[1]] })
    expect(diagnoseCacheMiss(fp(0), summaryGone, { cacheRead: 0 })).toBe('system_summary')
    const baseChanged = fp(1000, { systemLayers: [{ name: 'base', text: 'BASE2' }, layers[1], layers[2]] })
    expect(diagnoseCacheMiss(fp(0), baseChanged, { cacheRead: 0 })).toBe('system_base')
  })

  it('treats a grown history whose last user message changed as a hit, and an earlier change as messages', () => {
    const grown = fp(1000, {
      messages: [
        messages[0],
        messages[1],
        { role: 'user', content: 'u2 without notes' },
        { role: 'assistant', content: 'a2' },
        { role: 'user', content: 'u3' }
      ]
    })
    expect(diagnoseCacheMiss(fp(0), grown, { cacheRead: 1000 })).toBe('hit')
    const rewritten = fp(1000, { messages: [{ role: 'user', content: 'compacted' }, messages[2]] })
    expect(diagnoseCacheMiss(fp(0), rewritten, { cacheRead: 0 })).toBe('messages')
  })

  it('reports unknown when nothing changed but the server read nothing from the cache', () => {
    expect(diagnoseCacheMiss(fp(0), fp(1000), { cacheRead: 0 })).toBe('unknown')
    expect(diagnoseCacheMiss(fp(0), fp(1000), { cacheRead: 5000 })).toBe('hit')
  })
})
