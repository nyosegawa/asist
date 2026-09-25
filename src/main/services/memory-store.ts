import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { promptText, type PromptText } from '@shared/conversation-locale'
import { errorText } from '@shared/i18n/error-text'
import type { MemoryDocument, MemoryUnit } from '@shared/ipc'
import { localDateKey } from '@shared/local-date'
import { MEMORY_GITIGNORE } from '@shared/memory-curation'
import {
  DOCUMENT_FILE,
  classifyFile,
  documentKindOf,
  documentOf,
  parseFrontmatter,
  parseMemoryPageInput,
  parsePage,
  unitsOfJournal,
  unitsOfPage,
  validateDocument
} from '@shared/memory-page'
import { conversationLocale } from './conversation-locale'
import * as git from './git'
import { t } from './i18n'

/**
 * The memory directory, userData/memory/. The markdown files are the memory itself and are kept as a git
 * repository. The writes that happen during the day (editing, creating or deleting a document from the
 * memory screen) happen here and each one is committed. Nothing is memorized during a
 * conversation, and the only writers of a page are the curation Agent and the memory screen. The daily
 * curation job cuts its worktree from HEAD, so an uncommitted change is invisible to the Agent. The index
 * in memory-index.ts is built from these files.
 */

export const INSTRUCTION_FILE = 'instruction.md'
export const ME_FILE = 'me.md'
export const USER_FILE = 'user.md'
export const PAGES_DIR = 'pages'
export const JOURNAL_DIR = 'journal'

/**
 * The subjects of the commits ASIST itself makes in the memory. They belong to the memory and follow the
 * language it is written in, not the language of the interface.
 */
const WRITES = {
  created: { ja: 'asist: 記憶の置き場を作る', en: 'asist: create the memory directory' },
  prepared: { ja: 'asist: 置き場を整える', en: 'asist: tidy the memory directory' },
  edited: { ja: 'asist: 手直し {file}', en: 'asist: edit {file}' },
  pageCreated: { ja: 'asist: ページを作る {name}', en: 'asist: create the page {name}' },
  deleted: { ja: 'asist: 消す {file}', en: 'asist: delete {file}' }
} as const satisfies Record<string, PromptText>

const written = (of: keyof typeof WRITES, values: Record<string, string> = {}): string =>
  Object.entries(values).reduce((text, [key, value]) => text.replace(`{${key}}`, value), promptText(conversationLocale(), WRITES[of]))

export interface ReadResult {
  units: MemoryUnit[]
  pages: number
  /** Problems that should stop a curation from being merged, such as a missing instruction.md or a heading with no body. */
  errors: string[]
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
/** The files an earlier form of the memory kept: profile.md, which instruction.md replaced, and forget.jsonl. */
const OBSOLETE_FILES = ['profile.md', 'forget.jsonl']

export function memoryDir(): string {
  return path.join(app.getPath('userData'), 'memory')
}

/** Prepares the directory and the git repository, creating .gitignore and placing the first commit on the first run. */
export function ensureRepo(dir = memoryDir()): void {
  fs.mkdirSync(dir, { recursive: true })
  for (const sub of [PAGES_DIR, JOURNAL_DIR]) fs.mkdirSync(path.join(dir, sub), { recursive: true })
  const gitignore = path.join(dir, '.gitignore')
  if (!fs.existsSync(gitignore) || fs.readFileSync(gitignore, 'utf8') !== MEMORY_GITIGNORE) {
    fs.writeFileSync(gitignore, MEMORY_GITIGNORE, { mode: 0o600 })
  }
  if (git.toplevel(dir) !== dir) git.init(dir)
  git.commitAll(dir, written(git.hasHead(dir) ? 'prepared' : 'created'))
}

function listMarkdown(dir: string, sub: string): string[] {
  const target = path.join(dir, sub)
  if (!fs.existsSync(target)) return []
  return fs
    .readdirSync(target)
    .filter((name) => name.endsWith('.md') && !name.startsWith('.'))
    .sort()
    .map((name) => `${sub}/${name}`)
}

/**
 * Turns user.md, me.md, the pages and the journal into units. instruction.md goes whole into the system
 * prompt, so it is only validated and never indexed. The files an earlier form of the memory used are
 * reported, so that a curation removes them.
 */
export function readAll(dir = memoryDir()): ReadResult {
  const units: MemoryUnit[] = []
  const errors: string[] = []
  let pages = 0
  const read = (file: string): string | null => {
    const full = path.join(dir, file)
    return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null
  }

  const user = read(USER_FILE)
  if (user !== null) {
    const page = parsePage(user, classifyFile(USER_FILE).title)
    errors.push(...validateDocument(USER_FILE, user, t))
    // The user page carries its name in its own `# ` line, which is Japanese or English by the language
    // the curation wrote it in, and that name stands before every unit of the page in the search index.
    units.push(...unitsOfPage(USER_FILE, page, page.title))
    pages++
  }
  for (const file of listMarkdown(dir, PAGES_DIR)) {
    const markdown = read(file) ?? ''
    const page = parsePage(markdown, classifyFile(file).title)
    errors.push(...validateDocument(file, markdown, t))
    units.push(...unitsOfPage(file, page, page.title))
    pages++
  }
  for (const file of listMarkdown(dir, JOURNAL_DIR)) {
    const date = classifyFile(file).title
    const markdown = read(file) ?? ''
    if (!DAY_PATTERN.test(date)) errors.push(t('memory.check.fileName', { file }))
    else errors.push(...validateDocument(file, markdown, t))
    const page = parsePage(markdown, date)
    units.push(...unitsOfJournal(file, page, date))
    pages++
  }
  const me = read(ME_FILE)
  if (me !== null) {
    const page = parsePage(me, classifyFile(ME_FILE).title)
    errors.push(...validateDocument(ME_FILE, me, t))
    units.push(...unitsOfPage(ME_FILE, page, page.title))
    pages++
  }
  const instruction = read(INSTRUCTION_FILE)
  if (instruction === null) errors.push(t('memory.check.instructionMissing', { file: INSTRUCTION_FILE }))
  else errors.push(...validateDocument(INSTRUCTION_FILE, instruction, t))
  for (const file of OBSOLETE_FILES) if (fs.existsSync(path.join(dir, file))) errors.push(t('memory.check.obsoleteFile', { file }))
  return { units, pages, errors }
}

/** The documents in the order the screen shows them: instruction.md, me.md, user.md, the pages by name, then the journal with the newest day first. */
export function listDocuments(dir = memoryDir()): MemoryDocument[] {
  const files = [INSTRUCTION_FILE, ME_FILE, USER_FILE].filter((file) => fs.existsSync(path.join(dir, file)))
  files.push(...listMarkdown(dir, PAGES_DIR), ...listMarkdown(dir, JOURNAL_DIR).reverse())
  return files.filter((file) => DOCUMENT_FILE.test(file)).map((file) => documentOf(file, fs.readFileSync(path.join(dir, file), 'utf8')))
}

function documentPath(dir: string, file: string): string {
  if (!DOCUMENT_FILE.test(file)) throw new Error(errorText('memory.errors.notADocument', { file }))
  return path.join(dir, file)
}

export function readDocument(file: string, dir = memoryDir()): string | null {
  const full = documentPath(dir, file)
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null
}

/**
 * Replaces a whole document and commits it, on the user's own action from the memory screen. A document
 * that breaks the rules is not written and the reason is thrown.
 */
export function writeDocument(file: string, markdown: string, dir = memoryDir()): MemoryDocument {
  const full = documentPath(dir, file)
  const errors = validateDocument(file, markdown, t)
  if (errors.length > 0) throw new Error(errors.join(' / '))
  const text = markdown.endsWith('\n') ? markdown : `${markdown}\n`
  fs.writeFileSync(full, text, { mode: 0o600 })
  commit(dir, written('edited', { file }))
  return documentOf(file, text)
}

/** Creates a page from the template and commits it. A name that already exists is refused rather than overwritten. */
export function createPage(name: string, template: string, dir = memoryDir()): MemoryDocument {
  const input = parseMemoryPageInput({ name })
  const file = `${PAGES_DIR}/${input.name}.md`
  const full = documentPath(dir, file)
  if (fs.existsSync(full)) throw new Error(errorText('memory.errors.pageExists', { name: input.name }))
  const markdown = template
    .replace(/^updated: .*$/m, `updated: ${localDateKey(new Date())}`)
    .replace(/^# .*$/m, `# ${input.name}`)
  const errors = validateDocument(file, markdown, t)
  if (errors.length > 0) throw new Error(errorText('memory.errors.templateInvalid', { errors: errors.join(' / ') }))
  fs.writeFileSync(full, markdown, { mode: 0o600 })
  commit(dir, written('pageCreated', { name: input.name }))
  return documentOf(file, markdown)
}

/**
 * Deletes a page or a journal day, on the user's own action from the memory screen. A page that is
 * talked about on a day not curated yet can be written again by the next curation.
 */
export function deleteDocument(file: string, dir = memoryDir()): void {
  const kind = documentKindOf(file)
  if (kind !== 'page' && kind !== 'journal') throw new Error(errorText('memory.errors.deleteKind'))
  const full = documentPath(dir, file)
  if (!fs.existsSync(full)) throw new Error(errorText('memory.errors.notFound', { file }))
  fs.rmSync(full)
  commit(dir, written('deleted', { file }))
}

function readText(dir: string, file: string): string | null {
  const full = path.join(dir, file)
  if (!fs.existsSync(full)) return null
  const text = fs.readFileSync(full, 'utf8').trim()
  return text || null
}

/** The body with the frontmatter and the top-level "# " headings removed. */
function bodyOf(text: string | null): string | null {
  if (!text) return null
  const lines = text.split('\n')
  const { bodyStart } = parseFrontmatter(lines)
  const body = lines
    .slice(bodyStart)
    .filter((line) => !/^# /.test(line))
    .join('\n')
    .trim()
  return body || null
}

/** The body of instruction.md, which goes whole into the system prompt, or null when it is missing or empty. */
export function readInstruction(dir = memoryDir()): string | null {
  return bodyOf(readText(dir, INSTRUCTION_FILE))
}

function commit(dir: string, message: string): void {
  git.commitAll(dir, message)
}

/** Whether the working tree has no uncommitted change, which the curation job checks before it starts. */
export function isClean(dir = memoryDir()): boolean {
  return git.isClean(dir)
}
