import { describe, expect, it } from 'vitest'
import type { MemoryUnit } from '@shared/ipc'
import { marker } from '@shared/conversation-markers'
import {
  buildMemoryInjection,
  injectionBodyOf,
  injectionPageOf,
  memoryIdsInToolResult
} from '@shared/memory-injection'
import { createToolRegistry, executeTool, type ToolRegistry } from '@shared/tool-registry'

let seq = 0
const unit = (text: string, extra: Partial<MemoryUnit> = {}): MemoryUnit => ({
  id: `m${++seq}`,
  file: 'pages/松葉軒.md',
  line: 1,
  kind: 'section',
  page: '松葉軒',
  heading: '要約',
  aliases: [],
  text,
  date: '2026-09-01',
  order: 0,
  ...extra
})

describe('injectionPageOf / injectionBodyOf', () => {
  it('renders the page name as a level-one heading and each section as a level-two heading with its body, and heads a journal entry with its date', () => {
    expect(injectionPageOf('ja-JP', unit('x'))).toBe('# 松葉軒')
    expect(injectionBodyOf(unit('本人の行きつけのラーメン屋。'))).toBe('## 要約\n本人の行きつけのラーメン屋。')
    const journal = unit('春は桜を勧めた。', { kind: 'journal', page: '2026-09-07', heading: '四季の話', date: '2026-09-07' })
    expect(injectionPageOf('ja-JP', journal)).toBe('# 2026-09-07の日記')
    expect(injectionBodyOf(journal)).toBe('## 四季の話\n春は桜を勧めた。')
    expect(injectionBodyOf(unit('一行目。\n\n二行目。'))).toBe('## 要約\n一行目。\n\n二行目。')
  })
})

describe('buildMemoryInjection', () => {
  it('groups the matching units by page, keeps them as markdown, and reports the count, the estimated tokens and the ids', () => {
    const injection = buildMemoryInjection([
      unit('行きつけのラーメン屋。', { id: 'a' }),
      unit('辛さは控えめが好みらしい。', { id: 'b', heading: '好み', order: 2 }),
      unit('春は桜を勧めた。', { id: 'j', kind: 'journal', page: '2026-09-07', heading: '四季の話', date: '2026-09-07' })
    ], { locale: 'ja-JP' })!
    expect(injection.count).toBe(3)
    expect(injection.ids).toEqual(['a', 'b', 'j'])
    expect(injection.text).toBe(
      [
        '[記憶]',
        '# 松葉軒',
        '',
        '## 要約',
        '行きつけのラーメン屋。',
        '',
        '## 好み',
        '辛さは控えめが好みらしい。',
        '',
        '# 2026-09-07の日記',
        '',
        '## 四季の話',
        '春は桜を勧めた。'
      ].join('\n')
    )
    expect(marker('ja-JP', 'memory')).toBe('[記憶]')
    expect(injection.tokens).toBeGreaterThan(0)
  })

  it('leaves out what the memory block already carries and what excludeIds lists, and returns null when nothing remains', () => {
    expect(buildMemoryInjection([unit('最寄り駅は中野駅')], { locale: 'ja-JP', memoryBlock: '# 記憶\n最寄り駅は中野駅' })).toBeNull()
    const shown = new Set(['seen'])
    expect(buildMemoryInjection([unit('猫の名前はムギ', { id: 'seen' })], { locale: 'ja-JP', excludeIds: shown })).toBeNull()
    const injection = buildMemoryInjection([unit('猫の名前はムギ', { id: 'seen' }), unit('犬の名前はポチ', { id: 'new' })], {
      locale: 'ja-JP',
      excludeIds: shown
    })!
    expect(injection.ids).toEqual(['new'])
    expect(buildMemoryInjection([], { locale: 'ja-JP' })).toBeNull()
  })

  it('heads the note and a journal page in the language of the conversation, with the marker the prompt explains', () => {
    const journal = unit('Suggested the cherry blossoms.', { id: 'j', kind: 'journal', page: '2026-09-07', heading: 'Seasons', date: '2026-09-07' })
    const injection = buildMemoryInjection([journal], { locale: 'en-US' })!
    expect(injection.text).toBe(['[Memory]', '# Journal of 2026-09-07', '', '## Seasons', 'Suggested the cherry blossoms.'].join('\n'))
    expect(injection.text.startsWith(marker('en-US', 'memory'))).toBe(true)
  })

  it('counts pages and journal entries against separate budgets and cuts at the overall character limit', () => {
    const facts = Array.from({ length: 6 }, (_, i) => unit(`事実${i}`, { id: `f${i}`, heading: `h${i}` }))
    const journal = Array.from({ length: 3 }, (_, i) =>
      unit(`本文${i}`, { id: `j${i}`, kind: 'journal', page: '2026-09-07', heading: `話題${i}`, date: '2026-09-07' })
    )
    const injection = buildMemoryInjection([...journal, ...facts], { locale: 'ja-JP' })!
    expect(injection.ids).toEqual(['j0', 'j1', 'f0', 'f1', 'f2', 'f3'])
    const long = Array.from({ length: 5 }, (_, i) => unit(`${'あ'.repeat(500)}${i}`, { heading: `h${i}` }))
    expect(buildMemoryInjection(long, { locale: 'ja-JP', maxChars: marker('ja-JP', 'memory').length + 560 })!.count).toBe(1)
  })
})

describe('memoryIdsInToolResult', () => {
  const registry = (hits: unknown[]): ToolRegistry<null> =>
    createToolRegistry<null>([
      { name: 'recall', description: { ja: '', en: '' }, inputSchema: { type: 'object' }, parallel: true, timeoutMs: 1000, maxResultChars: 3000, run: () => ({ hits, count: hits.length }) },
      { name: 'show_weather', description: { ja: '', en: '' }, inputSchema: { type: 'object' }, parallel: true, timeoutMs: 1000, maxResultChars: 3000, run: () => ({ hits }) },
      { name: 'broken', description: { ja: '', en: '' }, inputSchema: { type: 'object' }, parallel: true, timeoutMs: 1000, maxResultChars: 3000, run: () => { throw new Error('down') } }
    ])
  const run = (tools: ToolRegistry<null>, name: string) => executeTool(tools, name, {}, null, new AbortController().signal, 'ja')

  it('collects the ids from the hits of recall', async () => {
    const tools = registry([{ id: 'm1', text: 'a' }, { id: 'm2' }])
    expect(memoryIdsInToolResult('recall', await run(tools, 'recall'))).toEqual(['m1', 'm2'])
  })

  it('collects the ids of the hits a shortened recall result still shows, although a note goes before its JSON', async () => {
    // Five hits of about 700 characters, as five sections near the 800-character cap return, pass the 3000 of recall.
    const body = '本人の上司で、打ち合わせの前に資料を確かめる人。'.repeat(30)
    const hits = Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, page: '大川俊介', heading: `見出し${i}`, kind: 'section', text: body }))
    const execution = await run(registry(hits), 'recall')
    expect(execution.truncated).toBe(true)
    const shown = hits.map((hit) => hit.id).filter((id) => execution.content.includes(`"${id}"`))
    expect(shown.length).toBeGreaterThan(0)
    expect(memoryIdsInToolResult('recall', execution)).toEqual(shown)
  })

  it('returns nothing for another tool, for a failed run, and for entries without an id', async () => {
    expect(memoryIdsInToolResult('show_weather', await run(registry([{ id: 'm1' }]), 'show_weather'))).toEqual([])
    expect(memoryIdsInToolResult('recall', await run(registry([]), 'broken'))).toEqual([])
    expect(memoryIdsInToolResult('recall', await run(registry([{ text: 'no id' }, { id: 5 }]), 'recall'))).toEqual([])
    expect(memoryIdsInToolResult('recall', { value: { hits: 'nope' } })).toEqual([])
  })
})
