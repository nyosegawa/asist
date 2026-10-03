import { z } from 'zod'
import type { ConversationLocale, PromptText } from './conversation-locale'
import type { Translate } from './i18n'
import { errorText } from './i18n/error-text'
import type { MemoryDocument, MemoryDocumentKind, MemoryPageInput, MemoryUnit, MemoryUnitKind } from './ipc'
import {
  PROMPT_DOCUMENTS,
  SECTION_MAX_CHARS,
  SUMMARY_HEADING,
  documentIssues,
  pageNameIssue,
  parsePage,
  promptBody,
  writtenInJapanese,
  type DocumentIssue,
  type PageNameIssue,
  type ParsedPage,
  type PromptDocumentKind
} from './memory-format'
import { SEARCHED_TEMPLATES } from './memory-templates'

export { PROMPT_DOCUMENTS, parsePage, promptBody, type PromptDocumentKind }

/**
 * Reading and writing the memory pages, which are markdown. They live in `userData/memory/`, and the
 * files are the memory itself. How a document is read and what breaks its rules live in memory-format.ts,
 * which the curation skills' Python answers the same; this file turns what it reads into units and list
 * entries, and its findings into sentences. A heading and the body under it,
 * called a section, is the unit of search and injection for the pages and the journal, and its id is
 * derived from the file path and the heading, so rewriting the body leaves the unit identical.
 */

const templateHeadingsOf = (template: string): string[] => parsePage(template, '').sections.map((section) => section.heading)

const inEveryLanguage = (pick: (templates: (typeof SEARCHED_TEMPLATES)[ConversationLocale]) => string): Readonly<Record<ConversationLocale, string>> =>
  Object.fromEntries(Object.entries(SEARCHED_TEMPLATES).map(([locale, templates]) => [locale, pick(templates)])) as Record<ConversationLocale, string>

/**
 * The headings of the pages and the journal that ASIST reads by name, in every conversation language. The memory
 * is written in the language of the conversation, and the curation copies them from the templates of that language
 * as they stand; the two that only the templates hold are read from there. Every language's are read whatever the
 * language currently is, because the user can change it and the memory then holds pages written under each.
 */
export const FIXED_HEADINGS = {
  /** The heading every page opens with. */
  summary: SUMMARY_HEADING,
  /** The heading every journal entry closes with, the curation's look back on the day. */
  journalSelf: inEveryLanguage(({ journal }) => templateHeadingsOf(journal).at(-1)!),
  /** The heading every page closes with, the curation's own view of the person, the place or the topic. */
  impression: inEveryLanguage(({ page }) => templateHeadingsOf(page).at(-1)!)
} as const

/**
 * The texts ASIST writes itself in the two forms a memory can be told apart by, Japanese and every other
 * language, which kana tell.
 */
export const FIXED = {
  /**
   * The `# name` of user.md and me.md, which a moved instruction.md starts them with when they are missing, and which
   * names its section about the assistant. A missing `# name` line reads as the Japanese one.
   */
  user: { ja: 'ユーザー', en: 'The user' },
  me: { ja: '私について', en: 'About me' },
  /** The word that stands before a journal entry in the text that gets embedded. */
  journalOf: { ja: '{date}の日記', en: 'Journal of {date}' }
} as const satisfies Record<string, PromptText>

/**
 * Because it stands in every entry, the memory screen leaves this heading out of the entry's preview line, in
 * every language a curation writes it in.
 */
export const JOURNAL_SELF_HEADINGS: readonly string[] = Object.values(FIXED_HEADINGS.journalSelf)

/**
 * The form of a fixed text that fits the memory it is written into, told by its kana, so that the prefix of
 * the text that gets embedded keeps the form the entry was written in after the conversation changed
 * language.
 */
const fixedFor = (text: PromptText, markdown: string): string => text[writtenInJapanese(markdown) ? 'ja' : 'en']

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

export type FileKind = 'user' | 'me' | 'page' | 'journal' | null

/** Derives the kind and the page's default name from the file path. */
export function classifyFile(file: string): { kind: FileKind; title: string } {
  const base = file.replace(/\\/g, '/').replace(/\.md$/, '')
  const name = base.split('/').pop() ?? base
  // The title is what a page is called when its own `# name` line is missing, so the Japanese form stands.
  if (base === 'user') return { kind: 'user', title: FIXED.user.ja }
  if (base === 'me') return { kind: 'me', title: FIXED.me.ja }
  if (base.startsWith('journal/')) return { kind: 'journal', title: name }
  if (base.startsWith('pages/')) return { kind: 'page', title: name }
  return { kind: null, title: name }
}

/**
 * The headings the templates write into one of the two kinds of document that are searched, in every conversation
 * language, with the summary in every language, which the text above a journal entry's first heading is read under
 * too.
 */
const templateHeadings = (kind: 'page' | 'journal'): ReadonlySet<string> =>
  new Set([
    ...Object.values(FIXED_HEADINGS.summary),
    ...Object.values(SEARCHED_TEMPLATES).flatMap((templates) => templateHeadingsOf(templates[kind]))
  ])

const TEMPLATE_HEADINGS: Record<'page' | 'journal', ReadonlySet<string>> = { page: templateHeadings('page'), journal: templateHeadings('journal') }

/**
 * Whether the heading of a section of a page or a journal entry is one its template writes, rather than one the
 * curation or the user chose for what the section says. Such a heading is the same in every memory and in
 * ordinary words, so it is no reason to put the section beside an utterance. Measured on 2026-10-02 over
 * memories written from the templates in each language: 「私の印象では悪くない」 injected the impression section of
 * every page, and in the embedded text "I did not like myself today" brought the close of a journal day to a
 * cosine of 0.868 against the bar of 0.84, and 0.835 without the heading. A heading anyone else writes says what
 * the section holds, and stays a search word.
 */
export function headingFromTemplate(file: string, heading: string): boolean {
  const { kind } = classifyFile(file)
  return (kind === 'page' || kind === 'journal') && TEMPLATE_HEADINGS[kind].has(heading)
}

/** Turns the headings of a page into units. */
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
 * of the conversation does not send every entry written so far back through the embedding worker. A heading
 * its template wrote is left out (headingFromTemplate).
 */
export function embeddingTextOf(unit: Pick<MemoryUnit, 'file' | 'kind' | 'page' | 'heading' | 'text' | 'date'>): string {
  const heading = headingFromTemplate(unit.file, unit.heading) ? '' : ` ${unit.heading}`
  if (unit.kind !== 'journal') return `${unit.page}${heading}: ${unit.text}`
  const label = fixedFor(FIXED.journalOf, `${unit.heading}\n${unit.text}`).replace('{date}', unit.date)
  return `${label}${heading}: ${unit.text}`
}


/** The files the memory screen can open: me.md, user.md, pages/<name>.md and journal/YYYY-MM-DD.md. */
export const DOCUMENT_FILE = /^(me\.md|user\.md|pages\/[^/\\]+\.md|journal\/\d{4}-\d{2}-\d{2}\.md)$/

const MAX_PAGE_NAME_LENGTH = 60

const PAGE_NAME_ERRORS = {
  characters: 'memory.errors.nameCharacters',
  reserved: 'memory.errors.nameReserved'
} as const satisfies Record<PageNameIssue, string>

/** Why a page's name, its file name without .md, cannot be used, or null when it can. */
export function pageNameError(name: string): string | null {
  const issue = pageNameIssue(name)
  return issue ? errorText(PAGE_NAME_ERRORS[issue]) : null
}

/** A page's name as the memory screen takes it, which becomes its file name. */
const pageNameSchema = z
  .string()
  .trim()
  .min(1, errorText('memory.errors.nameEmpty'))
  .max(MAX_PAGE_NAME_LENGTH, errorText('memory.errors.nameTooLong', { limit: MAX_PAGE_NAME_LENGTH }))
  .superRefine((name, context) => {
    const message = pageNameError(name)
    if (message) context.addIssue({ code: 'custom', message })
  })

/** A page the user made on the memory screen, at its first save: its name and the markdown they wrote. */
export const memoryPageInputSchema = z.strictObject({ name: pageNameSchema, markdown: z.string() })

/** The name, trimmed, for a new page, or the reason it cannot be one thrown. */
export function parsePageName(value: unknown): string {
  const result = pageNameSchema.safeParse(value)
  if (!result.success) throw new Error(result.error.issues[0].message)
  return result.data
}

/** Where a page of this name lives in the memory directory. */
export const pageFile = (name: string): string => `pages/${name}.md`

/**
 * What a page made on the memory screen holds until the user writes it: its name and an empty summary. The file
 * is written at its first save, from what the user wrote. A page made from the curation's template held that
 * template's example sentences, which were searched as memory: 「見出しの付け方がわからない」 put a page nobody
 * had written beside the utterance.
 */
export function newPageMarkdown(name: string, locale: ConversationLocale, today: string): string {
  return `---\naliases: []\nupdated: ${today}\n---\n# ${name}\n\n## ${FIXED_HEADINGS.summary[locale]}\n\n`
}

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
 * A finding of documentIssues as a sentence in the language of the interface. A page without its summary is told
 * the summary heading of the conversation's language, the language the memory is written in.
 */
export function documentIssueText(file: string, issue: DocumentIssue, t: Translate, locale: ConversationLocale): string {
  switch (issue.kind) {
    case 'duplicateHeading':
      return t('memory.check.duplicateHeading', { file, line: issue.line, heading: issue.heading, first: issue.first })
    case 'headingWithoutText':
      return t('memory.check.headingWithoutText', { file, line: issue.line, heading: issue.heading })
    case 'sectionTooLong':
      return t('memory.check.sectionTooLong', { file, line: issue.line, heading: issue.heading, limit: SECTION_MAX_CHARS })
    case 'tooManyTokens':
      return t('memory.check.tooManyTokens', { file, tokens: issue.tokens, limit: issue.limit, characters: issue.cut.characters })
    case 'firstHeading':
      return t('memory.check.firstHeading', { file, heading: SUMMARY_HEADING[locale] })
    case 'obsoleteKey':
      return t('memory.check.obsoleteKey', { file, key: issue.key })
    default:
      return t(`memory.check.${issue.kind}`, { file })
  }
}

/**
 * Checks the document against the rules of memory-format.ts and returns what needs fixing, in the
 * language of the interface, or nothing when it is valid. Reading the whole directory and saving from
 * the screen apply the same rules.
 */
export function validateDocument(file: string, markdown: string, t: Translate, locale: ConversationLocale): string[] {
  const kind = documentKindOf(file)
  if (!kind) return [t('memory.check.wrongPlace', { file })]
  return documentIssues(kind, markdown).map((issue) => documentIssueText(file, issue, t, locale))
}

export function parseMemoryPageInput(value: unknown): MemoryPageInput {
  const result = memoryPageInputSchema.safeParse(value)
  if (!result.success) throw new Error(result.error.issues[0].message)
  return result.data
}
