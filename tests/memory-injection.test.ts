import { describe, expect, it } from 'vitest'
import type { MemoryUnit } from '@shared/ipc'
import { marker } from '@shared/conversation-markers'
import {
  buildMemoryInjection,
  injectionBodyOf,
  injectionPageOf,
  memoryIdsInToolResult
} from '@shared/memory-injection'

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
  it('collects the ids from the hits of recall', () => {
    expect(memoryIdsInToolResult('recall', '{"hits":[{"id":"m1","text":"a"},{"id":"m2"}],"count":2}')).toEqual(['m1', 'm2'])
  })

  it('returns nothing for another tool, for a result that is not JSON, and for entries without an id', () => {
    expect(memoryIdsInToolResult('show_weather', '{"hits":[{"id":"m1"}]}')).toEqual([])
    expect(memoryIdsInToolResult('recall', 'recall の実行に失敗した')).toEqual([])
    expect(memoryIdsInToolResult('recall', '{"hits":[{"text":"no id"},{"id":5}]}')).toEqual([])
    expect(memoryIdsInToolResult('recall', '{"hits":"nope"}')).toEqual([])
  })
})
