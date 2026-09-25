import { describe, expect, it } from 'vitest'
import {
  INSTRUCTION_MAX_CHARS,
  SECTION_MAX_CHARS,
  documentOf,
  parseMemoryPageInput,
  validateDocument,
  classifyFile,
  embeddingTextOf,
  parseFrontmatter,
  parsePage,
  unitId,
  unitsOfJournal,
  unitsOfPage
} from '@shared/memory-page'
import { createTranslator } from '@shared/i18n'
import { errorText } from '@shared/i18n/error-text'

const ja = createTranslator('ja-JP')

const PAGE = `---
aliases: [松葉軒, ラーメン屋]
updated: 2026-09-09
---
# 松葉軒

## 要約
本人の行きつけのラーメン屋。麺類の気分のときにまず名前が出る。

## 行った記録
2026-09-08 に麺類の気分だと話した。
2026-09-09 に行ったと話した。

## 好み
辛さは控えめが好みらしい。
`

/** The same page as PAGE, written by a curation of a conversation held in another language. */
const PAGE_EN = `---
aliases: [Matsubaken, the ramen place]
updated: 2026-09-09
---
# Matsubaken

## Summary
The ramen shop this person keeps going back to. The first name that comes up in the mood for noodles.

## Visits
They said they were in the mood for noodles on 2026-09-08.
They said they had been on 2026-09-09.

## Tastes
They seem to prefer it not too spicy.
`

describe('parsePage', () => {
  it('reads the frontmatter, the title, and every heading with its body', () => {
    const page = parsePage(PAGE, 'fallback')
    expect(page.title).toBe('松葉軒')
    expect(page.titled).toBe(true)
    expect(page.frontmatter).toEqual({ present: true, aliases: ['松葉軒', 'ラーメン屋'], hasAliases: true, updated: '2026-09-09', obsoleteKeys: [] })
    expect(page.issues).toEqual([])
    expect(page.sections.map((s) => [s.line, s.heading, s.text])).toEqual([
      [7, '要約', '本人の行きつけのラーメン屋。麺類の気分のときにまず名前が出る。'],
      [10, '行った記録', '2026-09-08 に麺類の気分だと話した。\n2026-09-09 に行ったと話した。'],
      [14, '好み', '辛さは控えめが好みらしい。']
    ])
  })

  it('reads a body without a heading as the summary section, reports present=false when there is no frontmatter, and titles the page after the file when it has no name', () => {
    const page = parsePage('行きつけの店。\n二行目。\n', 'ichiran')
    expect(page.title).toBe('ichiran')
    expect(page.titled).toBe(false)
    expect(page.frontmatter.present).toBe(false)
    expect(page.sections).toEqual([{ line: 1, heading: '要約', text: '行きつけの店。\n二行目。' }])
  })

  it('reports a heading without a body, an unclosed frontmatter and a malformed updated as things to fix', () => {
    const page = parsePage('---\nupdated: 昨日\n---\n# x\n## 空\n\n## あり\n本文\n', 'x')
    expect(page.issues).toEqual([{ kind: 'updatedNotDate' }, { kind: 'headingWithoutText', line: 5, heading: '空' }])
    expect(page.sections.map((s) => s.heading)).toEqual(['あり'])
    expect(parsePage('---\nupdated: 2026-09-09\n# x\n', 'x').issues).toEqual([{ kind: 'frontmatterUnclosed' }])
  })

  it('reads a page written under the English fixed headings into the same structure as its Japanese twin', () => {
    const japanese = parsePage(PAGE, 'fallback')
    const english = parsePage(PAGE_EN, 'fallback')
    expect(english.issues).toEqual([])
    expect(english.sections.map((s) => s.line)).toEqual(japanese.sections.map((s) => s.line))
    expect(english.sections[0].heading).toBe('Summary')
    expect(english.sections[0].text.split('\n')).toHaveLength(1)
    expect(english.sections[1].text.split('\n')).toHaveLength(2)
    expect(parsePage('The shop they keep going back to.\n', 'matsubaken').sections).toEqual([
      { line: 1, heading: 'Summary', text: 'The shop they keep going back to.' }
    ])
  })

  it('reads a frontmatter list written on one line as well as one written across several', () => {
    const block = parseFrontmatter(['---', 'aliases:', '  - ムギ', '  - "ムギちゃん"', 'updated: 2026-09-09', '---', '# ムギ'])
    expect(block.frontmatter).toEqual({ present: true, aliases: ['ムギ', 'ムギちゃん'], hasAliases: true, updated: '2026-09-09', obsoleteKeys: [] })
    expect(block.bodyStart).toBe(6)
  })

  it('reports kind and links as obsolete keys, and keeps the items of an obsolete list out of the aliases', () => {
    const page = parsePage('---\nkind: place\nlinks:\n  - ユーザー\naliases:\n  - 松葉軒\n---\n# 松葉軒\n## 要約\n行きつけの店。\n', 'x')
    expect(page.frontmatter.aliases).toEqual(['松葉軒'])
    expect(page.issues).toEqual([
      { kind: 'obsoleteKey', key: 'kind' },
      { kind: 'obsoleteKey', key: 'links' }
    ])
  })

  it('reports a section whose body passes the cap, counted without whitespace', () => {
    const atCap = 'あ '.repeat(SECTION_MAX_CHARS / 2) + '\n' + 'い\t'.repeat(SECTION_MAX_CHARS / 2)
    expect(parsePage(`# x\n## 長い\n${atCap}\n`, 'x').issues).toEqual([])
    expect(parsePage(`# x\n## 長い\n${'あ'.repeat(SECTION_MAX_CHARS + 1)}\n`, 'x').issues).toEqual([
      { kind: 'sectionTooLong', line: 2, heading: '長い' }
    ])
  })
})

describe('units', () => {
  it('derives the id from the file and the heading, so that rewriting the body leaves it unchanged', () => {
    expect(unitId('pages/松葉軒.md', '要約')).toBe(unitId('pages/松葉軒.md', '要約'))
    expect(unitId('pages/松葉軒.md', '要約')).not.toBe(unitId('pages/松葉軒.md', '好み'))
    expect(unitId('pages/松葉軒.md', '要約')).not.toBe(unitId('pages/田中.md', '要約'))
    expect(unitId('x', 'y')).toMatch(/^[0-9a-f]{16}$/)
  })

  it('makes a unit of every heading of a page and of a journal entry', () => {
    const units = unitsOfPage('pages/松葉軒.md', parsePage(PAGE, '松葉軒'), '松葉軒')
    expect(units[0]).toMatchObject({ file: 'pages/松葉軒.md', line: 7, kind: 'section', page: '松葉軒', heading: '要約', aliases: ['松葉軒', 'ラーメン屋'], date: '2026-09-09', order: 0 })
    expect(units[2]).toMatchObject({ heading: '好み', order: 2 })
    const journal = unitsOfJournal('journal/2026-09-07.md', parsePage('# 2026-09-07\n## 四季の話\n春は桜。', '2026-09-07'), '2026-09-07')
    expect(journal[0]).toMatchObject({ kind: 'journal', page: '2026-09-07', heading: '四季の話', text: '春は桜。', date: '2026-09-07' })
  })

  it('decides the kind from the file path, with fixed names for user.md and me.md, journal/ for entries and pages/ for pages', () => {
    expect(classifyFile('user.md')).toEqual({ kind: 'user', title: 'ユーザー' })
    expect(classifyFile('me.md')).toEqual({ kind: 'me', title: '私について' })
    expect(classifyFile('instruction.md')).toEqual({ kind: 'instruction', title: 'いつも覚えておくこと' })
    expect(classifyFile('profile.md').kind).toBeNull()
    expect(classifyFile('pages/田中部長.md')).toEqual({ kind: 'page', title: '田中部長' })
    expect(classifyFile('journal/2026-09-07.md')).toEqual({ kind: 'journal', title: '2026-09-07' })
    expect(classifyFile('README.md').kind).toBeNull()
  })

  it('prefixes the embedded text with the page name and the heading, and a journal entry with its date', () => {
    expect(embeddingTextOf({ kind: 'section', page: '松葉軒', heading: '要約', text: '行きつけの店', date: '' })).toBe('松葉軒 要約: 行きつけの店')
    expect(embeddingTextOf({ kind: 'journal', page: '2026-09-07', heading: '四季', text: '春は桜', date: '2026-09-07' })).toBe('2026-09-07の日記 四季: 春は桜')
  })

  it('names the journal in English in an entry written in another language, and leaves a Japanese entry as it was', () => {
    expect(embeddingTextOf({ kind: 'journal', page: '2026-09-07', heading: 'Seasons', text: 'Cherry blossoms in spring', date: '2026-09-07' })).toBe(
      'Journal of 2026-09-07 Seasons: Cherry blossoms in spring'
    )
    // The prefix follows the entry, not the language of the conversation, so changing the language sends
    // nothing already written back through the embedding worker.
    expect(embeddingTextOf({ kind: 'journal', page: '2026-09-07', heading: '四季', text: '春は桜', date: '2026-09-07' })).toContain('の日記')
    expect(embeddingTextOf({ kind: 'section', page: 'Matsubaken', heading: 'Summary', text: 'A ramen shop', date: '' })).toBe('Matsubaken Summary: A ramen shop')
  })
})

describe('documents', () => {
  const MATSUBAKEN = '---\naliases: [松葉軒, ラーメン屋]\nupdated: 2026-09-09\n---\n# 松葉軒\n\n## 要約\n本人の行きつけのラーメン屋。麺類の気分のときにまず名前が出る。\n\n## 好み\n辛さは控えめ。\n'

  it('builds the list entry of a document from its path and markdown, with kind, title, aliases, updated date, headings and the first sentence of the summary', () => {
    expect(documentOf('pages/松葉軒.md', MATSUBAKEN)).toEqual({
      file: 'pages/松葉軒.md',
      kind: 'page',
      title: '松葉軒',
      aliases: ['松葉軒', 'ラーメン屋'],
      updated: '2026-09-09',
      headings: ['要約', '好み'],
      summary: '本人の行きつけのラーメン屋。'
    })
    expect(documentOf('journal/2026-09-07.md', '# 2026-09-07\n## 四季の話\n春は桜を勧めた。\n')).toMatchObject({ kind: 'journal', title: '2026-09-07', updated: '2026-09-07', headings: ['四季の話'] })
    expect(documentOf('me.md', '---\nupdated: 2026-09-09\n---\n# 私について\n\n## 私は誰か\n落ち着いた声で話す。\n')).toMatchObject({ kind: 'me', title: '私について' })
    expect(documentOf('instruction.md', '# いつも覚えておくこと\n\n## この人について\n東京に住む。\n')).toMatchObject({ kind: 'instruction', title: 'いつも覚えておくこと' })
    expect(() => documentOf('notes.md', '')).toThrow(errorText('memory.errors.notADocument', { file: 'notes.md' }))
  })

  it('reports what to fix in a page that breaks the rules', () => {
    expect(validateDocument('pages/壊れ.md', '# 壊れ\n\n## 経緯\n本文\n', ja)).toEqual([
      ja('memory.check.frontmatterMissing', { file: 'pages/壊れ.md' }),
      ja('memory.check.firstHeading', { file: 'pages/壊れ.md', heading: '要約' })
    ])
    expect(validateDocument('pages/松葉軒.md', MATSUBAKEN, ja)).toEqual([])
    expect(validateDocument('journal/2026-09-07.md', '# 2026-09-07\n## 四季の話\n春は桜を勧めた。\n', ja)).toEqual([])
    expect(validateDocument('../me.md', '', ja)).toEqual([ja('memory.check.wrongPlace', { file: '../me.md' })])
    expect(validateDocument('profile.md', '# 要点\n## 要点\n本文\n', ja)).toEqual([ja('memory.check.wrongPlace', { file: 'profile.md' })])
  })

  it('refuses the obsolete frontmatter keys kind and links', () => {
    expect(validateDocument('pages/松葉軒.md', '---\nkind: place\nlinks: [ユーザー]\nupdated: 2026-09-09\n---\n# 松葉軒\n## 要約\n行きつけの店。\n', ja)).toEqual([
      ja('memory.check.obsoleteKey', { file: 'pages/松葉軒.md', key: 'kind' }),
      ja('memory.check.obsoleteKey', { file: 'pages/松葉軒.md', key: 'links' })
    ])
  })

  it('refuses a section whose body is longer than the cap', () => {
    const markdown = `---\nupdated: 2026-09-09\n---\n# 松葉軒\n## 要約\n${'あ'.repeat(SECTION_MAX_CHARS + 1)}\n`
    expect(validateDocument('pages/松葉軒.md', markdown, ja)).toEqual([
      ja('memory.check.sectionTooLong', { file: 'pages/松葉軒.md', line: 5, heading: '要約', limit: SECTION_MAX_CHARS })
    ])
  })

  it('asks every page, user.md and me.md for its # name line, and every one but me.md for a ## heading', () => {
    expect(validateDocument('user.md', '---\nupdated: 2026-09-09\n---\n## 好み\n辛さは控えめ。\n', ja)).toEqual([
      ja('memory.check.titleMissing', { file: 'user.md' })
    ])
    expect(validateDocument('user.md', '---\nupdated: 2026-09-09\n---\n# ユーザー\n東京に住む。\n', ja)).toEqual([
      ja('memory.check.noHeadings', { file: 'user.md' })
    ])
    expect(validateDocument('pages/松葉軒.md', '---\nupdated: 2026-09-09\n---\n# 松葉軒\n行きつけの店。\n', ja)).toEqual([
      ja('memory.check.noHeadings', { file: 'pages/松葉軒.md' })
    ])
    expect(validateDocument('me.md', '---\nupdated: 2026-09-09\n---\n# 私について\n落ち着いた声で話す。\n', ja)).toEqual([])
    expect(validateDocument('me.md', '# 私について\n## 私は誰か\n落ち着いた声で話す。\n', ja)).toEqual([
      ja('memory.check.frontmatterMissing', { file: 'me.md' })
    ])
  })

  it('asks a journal entry for a ## heading but not for frontmatter or a # line', () => {
    expect(validateDocument('journal/2026-09-07.md', '## 四季の話\n春は桜を勧めた。\n', ja)).toEqual([])
    expect(validateDocument('journal/2026-09-07.md', '# 2026-09-07\n春は桜を勧めた。\n', ja)).toEqual([
      ja('memory.check.noHeadings', { file: 'journal/2026-09-07.md' })
    ])
  })

  it('allows aliases only on the pages under pages/', () => {
    expect(validateDocument('user.md', '---\naliases: [本人]\nupdated: 2026-09-09\n---\n# ユーザー\n## 好み\n辛さは控えめ。\n', ja)).toEqual([
      ja('memory.check.aliasesOnlyOnPages', { file: 'user.md' })
    ])
    expect(validateDocument('me.md', '---\naliases: [アシスト]\n---\n# 私について\n## 私は誰か\n落ち着いた声で話す。\n', ja)).toEqual([
      ja('memory.check.aliasesOnlyOnPages', { file: 'me.md' })
    ])    // An empty list is refused too, as validate.mjs refuses it, so a page the Agent passes is never refused at the merge.
    expect(validateDocument('user.md', '---\naliases: []\nupdated: 2026-09-09\n---\n# ユーザー\n## 好み\n辛さは控えめ。\n', ja)).toEqual([
      ja('memory.check.aliasesOnlyOnPages', { file: 'user.md' })
    ])
  })

  it('accepts instruction.md with a # line and headings, and refuses one with frontmatter, without a # line or without headings', () => {
    const valid = '# いつも覚えておくこと\n\n## この人について\n東京に住む。\n\n## 頼まれていること\n朝は短く話す。\n'
    expect(validateDocument('instruction.md', valid, ja)).toEqual([])
    expect(validateDocument('instruction.md', `---\nupdated: 2026-09-09\n---\n${valid}`, ja)).toEqual([
      ja('memory.check.frontmatterNotAllowed', { file: 'instruction.md' })
    ])
    expect(validateDocument('instruction.md', '## この人について\n東京に住む。\n', ja)).toEqual([
      ja('memory.check.titleMissing', { file: 'instruction.md' })
    ])
    expect(validateDocument('instruction.md', '# いつも覚えておくこと\n東京に住む。\n', ja)).toEqual([
      ja('memory.check.noHeadings', { file: 'instruction.md' })
    ])
  })

  it('caps instruction.md as a whole, counting the headings and leaving out whitespace', () => {
    const sections = (bodyLength: number): string =>
      Array.from({ length: 4 }, (_, i) => `## 見出し${i}\n${'あ'.repeat(bodyLength)}\n\n`).join('')
    // Each heading "見出しN" is 4 characters, so four sections of 496 characters come to exactly the cap.
    const atCap = sections(INSTRUCTION_MAX_CHARS / 4 - 4)
    expect(validateDocument('instruction.md', `# いつも覚えておくこと\n\n${atCap}`, ja)).toEqual([])
    expect(validateDocument('instruction.md', `# いつも覚えておくこと\n\n${atCap}## 追加\nあ\n`, ja)).toEqual([
      ja('memory.check.instructionTooLong', { file: 'instruction.md', limit: INSTRUCTION_MAX_CHARS })
    ])
  })

  it('accepts a page under either fixed heading, and names the English one to a page written in English', () => {
    expect(validateDocument('pages/Matsubaken.md', PAGE_EN, ja)).toEqual([])
    expect(validateDocument('pages/松葉軒.md', MATSUBAKEN, ja)).toEqual([])
    expect(validateDocument('pages/Matsubaken.md', '---\nupdated: 2026-09-09\n---\n# Matsubaken\n\n## Tastes\nNot too spicy.\n', ja)).toEqual([
      ja('memory.check.firstHeading', { file: 'pages/Matsubaken.md', heading: 'Summary' })
    ])
    expect(validateDocument('pages/松葉軒.md', '---\nupdated: 2026-09-09\n---\n# 松葉軒\n\n## 好み\n辛さは控えめ。\n', ja)).toEqual([
      ja('memory.check.firstHeading', { file: 'pages/松葉軒.md', heading: '要約' })
    ])
  })

  it('accepts only a name that works in a path when a page is created', () => {
    expect(parseMemoryPageInput({ name: ' 田中さん ' })).toEqual({ name: '田中さん' })
    expect(() => parseMemoryPageInput({ name: 'a/b' })).toThrow(errorText('memory.errors.nameCharacters'))
    expect(() => parseMemoryPageInput({ name: '' })).toThrow(errorText('memory.errors.nameEmpty'))
    expect(() => parseMemoryPageInput({ kind: 'person', name: 'x' })).toThrow()
  })
})
