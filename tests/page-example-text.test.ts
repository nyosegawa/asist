import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTranslator } from '@shared/i18n'
import { validateDocument } from '@shared/memory-page'
import { withoutExampleText } from '@shared/page-example-text'

const ja = createTranslator('ja-JP')

/** A page as the memory screen made it from the template of the skill before it opened new pages empty. */
const madeFrom = (locale: string, name: string): string =>
  fs
    .readFileSync(path.join(process.cwd(), 'resources', 'skills', 'memory-templates', locale, 'page.md'), 'utf8')
    .replace(/^updated: .*$/m, 'updated: 2026-09-20')
    .replace(/^# .*$/m, `# ${name}`)
const JA = madeFrom('ja-JP', '田中さん')
const EN = madeFrom('en-US', 'Tanaka')
const JA_SUMMARY = 'これが何(誰、どこ)で、本人とどう関わるか。一〜三文。'
const EN_SUMMARY = 'What (who, where) this is and how it touches the user. One to three sentences.'

describe('removing the page template example text', () => {
  it('removes the sections a user who wrote only the summary left as the template had them, and keeps the summary as written', () => {
    const page = JA.replace(JA_SUMMARY, '本人の上司。毎週木曜に打ち合わせをする。')
    expect(withoutExampleText(page)).toBe('---\naliases: []\nupdated: 2026-09-20\n---\n# 田中さん\n\n## 要約\n本人の上司。毎週木曜に打ち合わせをする。\n')
    const english = EN.replace(EN_SUMMARY, 'Their manager at work.')
    expect(withoutExampleText(english)).toBe('---\naliases: []\nupdated: 2026-09-20\n---\n# Tanaka\n\n## Summary\nTheir manager at work.\n')
    expect(validateDocument('pages/田中さん.md', withoutExampleText(page)!, ja, 'ja-JP')).toEqual([])
  })

  it('keeps a section whose example the user edited, or whose heading they renamed, word for word', () => {
    const edited = JA.replace(JA_SUMMARY, '本人の上司。')
      .replace('私から見てこれがどういう存在か、', '頼りになる人らしい。私から見てこれがどういう存在か、')
      .replace('## 見出しは中身に合わせて付ける', '## 仕事')
    expect(withoutExampleText(edited)).toBe(edited)
  })

  it('removes an example between sections the user wrote, and leaves the lines around it as they were', () => {
    const page = EN.replace(EN_SUMMARY, 'Their manager at work.').replace('## My impression', '## Meetings\nEvery Thursday at ten.\n\n## My impression')
    const kept = withoutExampleText(page)!
    expect(kept).toBe('---\naliases: []\nupdated: 2026-09-20\n---\n# Tanaka\n\n## Summary\nTheir manager at work.\n\n## Meetings\nEvery Thursday at ten.\n')
    expect(withoutExampleText(kept)).toBe(kept)
  })

  it('leaves nothing of a page the user never wrote in, and keeps its line endings in a page it changes', () => {
    expect(withoutExampleText(JA)).toBeNull()
    expect(withoutExampleText(EN)).toBeNull()
    const windows = JA.replace(JA_SUMMARY, '本人の上司。').replace(/\n/g, '\r\n')
    expect(withoutExampleText(windows)).toBe('---\r\naliases: []\r\nupdated: 2026-09-20\r\n---\r\n# 田中さん\r\n\r\n## 要約\r\n本人の上司。\r\n')
  })

  it('returns a page with no example text as it is', () => {
    const page = '---\naliases: [松葉軒]\nupdated: 2026-09-09\n---\n# 松葉軒\n\n## 要約\n行きつけの店。\n\n## 私の印象\n疲れた日に名前が出る。\n'
    expect(withoutExampleText(page)).toBe(page)
  })
})
