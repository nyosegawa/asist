import { summarizeNote, type NoteSummary } from '@shared/notes'

/** The notes the demo starts with, long enough that the card fills up and the screen has something to render. */

const HOUR = 3_600_000
const now = Date.now()

export interface DemoNote {
  id: string
  markdown: string
  updatedAt: number
}

export const DEMO_NOTES: DemoNote[] = [
  {
    id: '20260923-091500-3f2a',
    updatedAt: now - 0.4 * HOUR,
    markdown: `# 歓迎会の段取り

- 人数は8人、予算は1人5,000円まで
- 場所は恵比寿で、駅から歩いて5分以内
- 候補
  1. 炉端焼きの店(個室あり)
  2. イタリアン(貸切は10人から)

**金曜までに**予約する。
`
  },
  {
    id: '20260922-181030-b71c',
    updatedAt: now - 20 * HOUR,
    markdown: `# 提案書の構成

結論を最初のページに置く。数字は表にまとめる。

| 章 | 内容 |
| --- | --- |
| 1 | 結論と費用 |
| 2 | 現状の課題 |
| 3 | 進め方と日程 |

- [x] 現状の数字を集める
- [ ] 日程の案を2つ作る
`
  },
  {
    id: '20260920-073000-0c9e',
    updatedAt: now - 70 * HOUR,
    markdown: `# 読みたい本

- 『エンジニアのための文章術』
- 積読の3冊を先に片付ける
`
  },
  {
    id: '20260918-220512-5d41',
    updatedAt: now - 5 * 24 * HOUR,
    markdown: `# 旅行の持ち物

充電器、変換プラグ、折りたたみ傘。
`
  }
]

export const demoNoteSummary = (note: DemoNote): NoteSummary => summarizeNote(note.id, note.markdown, note.updatedAt)
