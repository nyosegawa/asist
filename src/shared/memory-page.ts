import { z } from 'zod'
import type { PromptText } from './conversation-locale'
import type { Translate } from './i18n'
import { errorText } from './i18n/error-text'
import type { MemoryDocument, MemoryDocumentKind, MemoryPageInput, MemoryUnit, MemoryUnitKind } from './ipc'

/**
 * Reading and writing the memory pages, which are markdown. They live in `userData/memory/`, and the
 * files are the memory itself. How to write them is specified in the references/format.md of the
 * curation skills under resources/skills; the only parts this code depends on are the frontmatter keys
 * aliases and updated, the `# name` line, the `## heading` lines, and the file names under journal/,
 * which holds ASIST's own journal. A heading and the body under it, called a section, is the
 * unit of search and injection, and its id is derived from the file path and the heading, so rewriting
 * the body leaves the unit identical. A page without any `## ` line is read as a single section named
 * "要約" or "Summary".
 */

/**
 * The headings and the page names this code depends on, in the two forms a memory directory can hold.
 * The body of a memory is written in the language of the conversation, but these are fixed: Japanese in
 * a memory written in Japanese, English in every other language, so that reading a page needs no table
 * of headings per language. Both forms are read whatever the language currently is, because the user can
 * change it and the directory then holds pages written under each. The skills in resources/skills write
 * them, one skill per form.
 */
export const FIXED = {
  /** The heading every page opens with, and the one a page without any `## ` line is read as. */
  summary: { ja: '要約', en: 'Summary' },
  /** The heading the curation closes every journal entry with. */
  journalSelf: { ja: '今日の私', en: 'Myself today' },
  /** The heading the curation keeps on every page about a person, a place or a topic for its own view of them. */
  impression: { ja: '私の印象', en: 'My impression' },
  /** The `# name` line of the three pages whose name comes from their role rather than from a person. */
  user: { ja: 'ユーザー', en: 'The user' },
  me: { ja: '私について', en: 'About me' },
  instruction: { ja: 'いつも覚えておくこと', en: 'Always keep in mind' },
  /** The word that stands before a journal entry in the text that gets embedded. */
  journalOf: { ja: '{date}の日記', en: 'Journal of {date}' }
} as const satisfies Record<string, PromptText>

/**
 * Because it stands in every entry, the memory screen leaves this heading out of the entry's preview
 * line, in both the form a Japanese curation writes and the form the other languages write.
 */
export const JOURNAL_SELF_HEADINGS: readonly string[] = [FIXED.journalSelf.ja, FIXED.journalSelf.en]

/**
 * Whether a piece of memory is written in Japanese. Kana decide it: of the eleven languages a
 * conversation can be held in, only Japanese writes them, and Japanese prose always contains them. A
 * heading this code has to supply itself, and the prefix of the text that gets embedded, follow from
 * this, so that a page keeps the form it was written in even after the conversation changed language.
 */
export const writtenInJapanese = (text: string): boolean => /[\u3041-\u30ff]/.test(text)

/** The form of a fixed text that fits the memory it is written into. */
const fixedFor = (text: PromptText, markdown: string): string => text[writtenInJapanese(markdown) ? 'ja' : 'en']

/** Whether a heading is the given fixed one, in either form. */
const isFixed = (text: PromptText, heading: string): boolean => heading === text.ja || heading === text.en

export interface PageFrontmatter {
  present: boolean
  aliases: string[]
  /** Whether the frontmatter has an aliases key at all, even an empty one, which only a page may carry. */
  hasAliases: boolean
  updated: string | null
  /** The keys an earlier form of the memory used, kind and links, which a page may no longer carry. */
  obsoleteKeys: string[]
}

export interface PageSection {
  /** The heading's line number, counted from one. A body without a heading reports its first line. */
  line: number
  heading: string
  text: string
}

/**
 * A way the markdown breaks the rules this code depends on. It stays a value rather than a sentence,
 * because the sentence is written where the page is validated, in the language of the interface.
 */
export type PageIssue =
  | { kind: 'frontmatterUnclosed' }
  | { kind: 'updatedNotDate' }
  | { kind: 'obsoleteKey'; key: string }
  | { kind: 'headingWithoutText'; line: number; heading: string }
  | { kind: 'sectionTooLong'; line: number; heading: string }

/**
 * The longest a section may be and the longest instruction.md may be, in characters without whitespace.
 * instruction.md goes whole into the system prompt of every turn, and a section is what one search hit
 * carries into a turn, so both are capped rather than left to grow with each curation. The skills'
 * validate.mjs checks the same numbers.
 */
export const SECTION_MAX_CHARS = 800
export const INSTRUCTION_MAX_CHARS = 2000

/** The length the caps are measured in: characters, with the whitespace left out. */
export const capLength = (text: string): number => Array.from(text.replace(/\s+/gu, '')).length

const OBSOLETE_KEYS = new Set(['kind', 'links'])

export interface ParsedPage {
  title: string
  /** Whether the page has its own `# name` line. */
  titled: boolean
  frontmatter: PageFrontmatter
  sections: PageSection[]
  issues: PageIssue[]
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function parseList(value: string): string[] {
  const inner = value.trim().replace(/^\[/, '').replace(/\]$/, '')
  return inner
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}

/**
 * Reads the frontmatter, the `key: value` lines fenced by `---`, and also reports the line the body
 * starts on. A list is accepted both as `[a, b]` on one line and as `  - a` lines that follow,
 * because the Agent writes both forms.
 */
export function parseFrontmatter(lines: readonly string[]): { frontmatter: PageFrontmatter; bodyStart: number } {
  const frontmatter: PageFrontmatter = { present: false, aliases: [], hasAliases: false, updated: null, obsoleteKeys: [] }
  if (lines[0]?.trim() !== '---') return { frontmatter, bodyStart: 0 }
  frontmatter.present = true
  // The items of a list follow the key on lines of their own; those of an obsolete key are skipped.
  let listKey: 'aliases' | 'skip' | null = null
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i]
    if (raw.trim() === '---') return { frontmatter, bodyStart: i + 1 }
    const item = /^\s+-\s*(.+)$/.exec(raw)
    if (item && listKey) {
      if (listKey === 'aliases') frontmatter.aliases.push(item[1].trim().replace(/^["']|["']$/g, ''))
      continue
    }
    const match = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(raw)
    if (!match) continue
    const [, key, value] = match
    listKey = null
    if (OBSOLETE_KEYS.has(key)) {
      frontmatter.obsoleteKeys.push(key)
      if (!value.trim()) listKey = 'skip'
    } else if (key === 'updated') frontmatter.updated = value.trim() || null
    else if (key === 'aliases') {
      frontmatter.hasAliases = true
      frontmatter.aliases = parseList(value)
      if (!value.trim()) listKey = 'aliases'
    }
  }
  return { frontmatter, bodyStart: lines.length }
}

/** Reads a page, meaning user, pages or me, or a journal entry, one section per heading. */
export function parsePage(markdown: string, fallbackTitle: string): ParsedPage {
  const lines = markdown.split(/\r?\n/)
  const { frontmatter, bodyStart } = parseFrontmatter(lines)
  const issues: PageIssue[] = []
  if (frontmatter.present && bodyStart === lines.length) issues.push({ kind: 'frontmatterUnclosed' })
  if (frontmatter.updated && !DATE_PATTERN.test(frontmatter.updated)) issues.push({ kind: 'updatedNotDate' })
  for (const key of frontmatter.obsoleteKeys) issues.push({ kind: 'obsoleteKey', key })
  let title = fallbackTitle
  let titled = false
  const sections: PageSection[] = []
  let current: PageSection | null = null
  for (let i = bodyStart; i < lines.length; i++) {
    const raw = lines[i]
    if (/^# /.test(raw)) {
      title = raw.slice(2).trim() || fallbackTitle
      titled = true
      continue
    }
    if (/^## /.test(raw)) {
      current = { line: i + 1, heading: raw.slice(3).trim(), text: '' }
      sections.push(current)
      continue
    }
    if (!raw.trim()) continue
    if (!current) {
      // A body with no heading above it, as a short page has, becomes the section "要約" or "Summary".
      current = { line: i + 1, heading: fixedFor(FIXED.summary, markdown), text: '' }
      sections.push(current)
    }
    current.text = current.text ? `${current.text}\n${raw.trimEnd()}` : raw.trimEnd()
  }
  for (const section of sections) {
    if (!section.text.trim()) issues.push({ kind: 'headingWithoutText', line: section.line, heading: section.heading })
    else if (capLength(section.text) > SECTION_MAX_CHARS) issues.push({ kind: 'sectionTooLong', line: section.line, heading: section.heading })
  }
  return { title, titled, frontmatter, sections: sections.filter((s) => s.text.trim()), issues }
}

/**
 * A 16-digit id built from two 32-bit FNV-1a hashes. The same file path and key, which is a heading
 * or a body, always produce the same id.
 */
export function unitId(file: string, key: string): string {
  const input = `${file}\n${key}`
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ ((c << 1) | 1), 0x01000193) >>> 0
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}

export type FileKind = 'user' | 'me' | 'instruction' | 'page' | 'journal' | null

/** Derives the kind and the page's default name from the file path. */
export function classifyFile(file: string): { kind: FileKind; title: string } {
  const base = file.replace(/\\/g, '/').replace(/\.md$/, '')
  const name = base.split('/').pop() ?? base
  // The title is what a page is called when its own `# name` line is missing, so the Japanese form stands.
  if (base === 'user') return { kind: 'user', title: FIXED.user.ja }
  if (base === 'me') return { kind: 'me', title: FIXED.me.ja }
  if (base === 'instruction') return { kind: 'instruction', title: FIXED.instruction.ja }
  if (base.startsWith('journal/')) return { kind: 'journal', title: name }
  if (base.startsWith('pages/')) return { kind: 'page', title: name }
  return { kind: null, title: name }
}

/** Turns the headings of a page, meaning user, me or pages, into units. */
export function unitsOfPage(file: string, page: ParsedPage, pageName: string): MemoryUnit[] {
  const date = page.frontmatter.updated ?? ''
  return page.sections.map((section, order) => ({
    id: unitId(file, section.heading),
    file,
    line: section.line,
    kind: 'section' as MemoryUnitKind,
    page: pageName,
    heading: section.heading,
    aliases: page.frontmatter.aliases,
    text: section.text,
    date,
    order
  }))
}

/** Turns the headings of a journal entry into units, using the date as the page name. */
export function unitsOfJournal(file: string, page: ParsedPage, date: string): MemoryUnit[] {
  return page.sections.map((section, order) => ({
    id: unitId(file, section.heading),
    file,
    line: section.line,
    kind: 'journal' as MemoryUnitKind,
    page: date,
    heading: section.heading,
    aliases: [],
    text: section.text,
    date,
    order
  }))
}

/**
 * The text that gets embedded. A section unit is prefixed with the page name and the heading, which
 * also makes the other headings of the same page reachable. Aliases are not appended in parentheses,
 * because that lowers the scores; they are carried on the bigram side only. A journal unit is prefixed
 * with the date and the heading, in the language the entry is written in, so that changing the language
 * of the conversation does not send every entry written so far back through the embedding worker.
 */
export function embeddingTextOf(unit: Pick<MemoryUnit, 'kind' | 'page' | 'heading' | 'text' | 'date'>): string {
  if (unit.kind !== 'journal') return `${unit.page} ${unit.heading}: ${unit.text}`
  const label = fixedFor(FIXED.journalOf, `${unit.heading}\n${unit.text}`).replace('{date}', unit.date)
  return `${label} ${unit.heading}: ${unit.text}`
}


/**
 * The files the memory screen can open: instruction.md, me.md, user.md, pages/<name>.md and
 * journal/YYYY-MM-DD.md.
 */
export const DOCUMENT_FILE = /^(instruction\.md|me\.md|user\.md|pages\/[^/\\]+\.md|journal\/\d{4}-\d{2}-\d{2}\.md)$/

const MAX_PAGE_NAME_LENGTH = 60

/**
 * The input for a new page. The name becomes the file name, so characters that cannot appear in a
 * path are rejected.
 */
export const memoryPageInputSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1, errorText('memory.errors.nameEmpty'))
    .max(MAX_PAGE_NAME_LENGTH, errorText('memory.errors.nameTooLong', { limit: MAX_PAGE_NAME_LENGTH }))
    .refine((name) => !/[/\\:*?"<>|]/.test(name) && !name.startsWith('.'), errorText('memory.errors.nameCharacters'))
})

export function documentKindOf(file: string): MemoryDocumentKind | null {
  if (!DOCUMENT_FILE.test(file)) return null
  return classifyFile(file).kind as MemoryDocumentKind
}

/** The first sentence, at most 80 characters, used as the gist shown in the list. */
function firstSentence(text: string): string {
  const line = (text.split('\n').find((candidate) => candidate.trim()) ?? '').replace(/^\s*[-*]\s+/, '')
  const match = /^(.{0,80}?[。.!?！？])/.exec(line)
  return (match ? match[1] : line.slice(0, 80)).trim()
}

/**
 * What the list shows about a document: its frontmatter, its name, its headings, and the first
 * sentence of its summary.
 */
export function documentOf(file: string, markdown: string): MemoryDocument {
  const kind = documentKindOf(file)
  if (!kind) throw new Error(errorText('memory.errors.notADocument', { file }))
  const { title } = classifyFile(file)
  const page = parsePage(markdown, title)
  const first = page.sections[0]
  return {
    file,
    kind,
    title: kind === 'page' ? page.title : title,
    aliases: page.frontmatter.aliases,
    updated: kind === 'journal' ? title : page.frontmatter.updated,
    headings: page.sections.map((section) => section.heading),
    summary: first ? firstSentence(first.text) : ''
  }
}

/**
 * Checks the document against the rules this code depends on and returns what needs fixing, in the
 * language of the interface, or nothing when it is valid. Reading the whole directory and saving from
 * the screen apply the same rules.
 */
export function validateDocument(file: string, markdown: string, t: Translate): string[] {
  const kind = documentKindOf(file)
  if (!kind) return [t('memory.check.wrongPlace', { file })]
  const { title } = classifyFile(file)
  const page = parsePage(markdown, title)
  // parsePage reads a body with no heading above it as the summary section, so the sections alone cannot
  // tell whether the document has a `## ` line, which the skills' validate.mjs requires.
  const headed = /^## /m.test(markdown)
  const errors = page.issues.map((issue) => {
    switch (issue.kind) {
      case 'headingWithoutText':
        return t('memory.check.headingWithoutText', { file, line: issue.line, heading: issue.heading })
      case 'sectionTooLong':
        return t('memory.check.sectionTooLong', { file, line: issue.line, heading: issue.heading, limit: SECTION_MAX_CHARS })
      case 'obsoleteKey':
        return t('memory.check.obsoleteKey', { file, key: issue.key })
      default:
        return t(`memory.check.${issue.kind}`, { file })
    }
  })
  if (kind === 'journal') {
    if (!headed) errors.push(t('memory.check.noHeadings', { file }))
    return errors
  }
  if (!page.titled) errors.push(t('memory.check.titleMissing', { file }))
  if (kind === 'instruction') {
    if (page.frontmatter.present) errors.push(t('memory.check.frontmatterNotAllowed', { file }))
    if (!headed) errors.push(t('memory.check.noHeadings', { file }))
    const body = page.sections.map((section) => section.heading + section.text).join('')
    if (capLength(body) > INSTRUCTION_MAX_CHARS) errors.push(t('memory.check.instructionTooLong', { file, limit: INSTRUCTION_MAX_CHARS }))
    return errors
  }
  if (!page.frontmatter.present) errors.push(t('memory.check.frontmatterMissing', { file }))
  else if (kind !== 'page' && page.frontmatter.hasAliases) errors.push(t('memory.check.aliasesOnlyOnPages', { file }))
  if (kind !== 'me' && !headed) errors.push(t('memory.check.noHeadings', { file }))
  if (kind === 'page' && page.sections.length > 0 && !isFixed(FIXED.summary, page.sections[0].heading))
    errors.push(t('memory.check.firstHeading', { file, heading: fixedFor(FIXED.summary, markdown) }))
  return errors
}

export function parseMemoryPageInput(value: unknown): MemoryPageInput {
  const result = memoryPageInputSchema.safeParse(value)
  if (!result.success) throw new Error(result.error.issues[0].message)
  return result.data
}
