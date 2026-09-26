import type { ReactNode } from 'react'
import { isExternalLink } from '@shared/external-link'
import { openLink } from '@/open-link'

/**
 * A small renderer for reading the memory markdown. It covers only what the diary and the pages use,
 * namely frontmatter, headings, paragraphs, bullet lists, bold text and links,
 * and prints any other notation as plain characters.
 */

type Block = { kind: 'heading'; level: number; text: string } | { kind: 'paragraph'; text: string } | { kind: 'list'; items: string[] }

export function parseBlocks(markdown: string): Block[] {
  const lines = markdown.split(/\r?\n/)
  let start = 0
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((line, i) => i > 0 && line.trim() === '---')
    start = close >= 0 ? close + 1 : lines.length
  }
  const blocks: Block[] = []
  let paragraph: string[] = []
  let list: string[] = []
  const flush = (): void => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', text: paragraph.join('\n') })
    if (list.length) blocks.push({ kind: 'list', items: list })
    paragraph = []
    list = []
  }
  for (const raw of lines.slice(start)) {
    const heading = /^(#{1,3}) (.+)$/.exec(raw)
    if (heading) {
      flush()
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() })
      continue
    }
    const item = /^\s*[-*] (.+)$/.exec(raw)
    if (item) {
      if (paragraph.length) flush()
      list.push(item[1].trim())
      continue
    }
    if (!raw.trim()) {
      flush()
      continue
    }
    if (list.length) flush()
    paragraph.push(raw.trim())
  }
  flush()
  return blocks
}

/** Turns bold text and [text](URL) links into elements. A link the app does not open keeps only its text. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const pattern = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g
  let last = 0
  let match: RegExpExecArray | null
  let key = 0
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index))
    const url = match[3]
    if (match[1] !== undefined) out.push(<strong key={key++}>{match[1]}</strong>)
    else if (!isExternalLink(url)) out.push(match[2])
    else out.push(
      <button key={key++} type="button" className="my-link" onClick={() => openLink(url)}>
        {match[2]}
      </button>
    )
    last = match.index + match[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function Markdown({ text, skipTitle }: { text: string; skipTitle?: boolean }): React.JSX.Element {
  const blocks = parseBlocks(text).filter((block) => !(skipTitle && block.kind === 'heading' && block.level === 1))
  return (
    <div className="my-markdown">
      {blocks.map((block, i) => {
        if (block.kind === 'heading') {
          const Tag = (block.level === 1 ? 'h2' : block.level === 2 ? 'h3' : 'h4') as 'h2' | 'h3' | 'h4'
          return <Tag key={i}>{inline(block.text)}</Tag>
        }
        if (block.kind === 'list') {
          return (
            <ul key={i}>
              {block.items.map((item, j) => (
                <li key={j}>{inline(item)}</li>
              ))}
            </ul>
          )
        }
        return (
          <p key={i}>
            {block.text.split('\n').map((line, j) => (
              <span key={j}>
                {j > 0 && <br />}
                {inline(line)}
              </span>
            ))}
          </p>
        )
      })}
    </div>
  )
}
