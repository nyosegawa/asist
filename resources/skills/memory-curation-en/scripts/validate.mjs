#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

// Checks a memory directory. Usage: node validate.mjs <memoryDir>
// Every problem is printed on its own line and the exit code is 1; with none it prints OK. The check ASIST
// runs when it merges a curation uses the same rules. The Japanese skill ships the same checks with its
// problems written in Japanese.

const dir = path.resolve(process.argv[2] ?? '.')
const problems = []
const DATE = /^\d{4}-\d{2}-\d{2}$/
// A memory directory can hold pages written before the user changed the language of the conversation, so
// both forms of the fixed heading are accepted whichever language this run writes in.
const SUMMARY = new Set(['Summary', '要約'])
// Lengths are counted in characters with whitespace removed, so that Japanese and English prose, and a
// section wrapped over many lines, are measured alike.
const SECTION_LIMIT = 800
const INSTRUCTION_LIMIT = 2000
const TOP_LEVEL = ['user.md', 'me.md', 'instruction.md', 'AGENTS.md']

const length = (text) => [...text.replace(/\s/g, '')].length

function frontmatter(lines) {
  const out = { keys: new Set(), updated: null, present: false, closed: true }
  if (lines[0]?.trim() !== '---') return { fm: out, bodyStart: 0 }
  out.present = true
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i]
    if (raw.trim() === '---') return { fm: out, bodyStart: i + 1 }
    const kv = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(raw)
    if (!kv) continue
    out.keys.add(kv[1])
    if (kv[1] === 'updated') out.updated = kv[2].trim() || null
  }
  out.closed = false
  return { fm: out, bodyStart: lines.length }
}

function sections(lines, bodyStart) {
  const out = []
  let current = null
  for (let i = bodyStart; i < lines.length; i++) {
    const raw = lines[i]
    if (/^# /.test(raw)) continue
    if (/^## /.test(raw)) {
      current = { line: i + 1, heading: raw.slice(3).trim(), text: '' }
      out.push(current)
      continue
    }
    if (!raw.trim()) continue
    if (current) current.text += raw.trim()
  }
  return out
}

function checkSections(file, secs, emptyHint) {
  for (const s of secs) {
    if (!s.text) problems.push(`${file}:${s.line}: there is nothing under the heading "${s.heading}"${emptyHint}`)
    else if (length(s.text) > SECTION_LIMIT) {
      problems.push(`${file}:${s.line}: the heading "${s.heading}" holds ${length(s.text)} characters (keep it to ${SECTION_LIMIT})`)
    }
  }
}

function checkPage(file, { isPage, requireHeadings }) {
  const full = path.join(dir, file)
  if (!fs.existsSync(full)) return null
  const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/)
  const { fm, bodyStart } = frontmatter(lines)
  if (!fm.present) problems.push(`${file}: there is no frontmatter`)
  else if (!fm.closed) problems.push(`${file}: the frontmatter is not closed (there is only one ---)`)
  for (const key of ['kind', 'links']) {
    if (fm.keys.has(key)) problems.push(`${file}: ${key} in the frontmatter is no longer used; delete it`)
  }
  if (!isPage && fm.keys.has('aliases')) problems.push(`${file}: aliases belong only on the pages under pages/; delete it`)
  if (fm.updated && !DATE.test(fm.updated)) problems.push(`${file}: updated must be a date in the form YYYY-MM-DD`)
  if (!lines.slice(bodyStart).some((l) => /^# /.test(l))) problems.push(`${file}: there is no "# name" line`)
  const secs = sections(lines, bodyStart)
  if (requireHeadings && secs.length === 0) problems.push(`${file}: there is not one "## heading"`)
  checkSections(file, secs, ' (delete a heading you have nothing to write under)')
  return { secs }
}

function checkInstruction() {
  const file = 'instruction.md'
  const full = path.join(dir, file)
  if (!fs.existsSync(full)) {
    problems.push(`${file}: it is missing (it is the summary that goes into every conversation; write it from user.md, me.md and the pages)`)
    return
  }
  const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/)
  if (lines[0]?.trim() === '---') problems.push(`${file}: it takes no frontmatter; delete it`)
  const title = lines.findIndex((l) => /^# /.test(l))
  if (title < 0) problems.push(`${file}: there is no "# Always keep in mind" line`)
  const body = lines.slice(title + 1).join('\n')
  if (length(body) > INSTRUCTION_LIMIT) {
    problems.push(`${file}: the body holds ${length(body)} characters (keep it to ${INSTRUCTION_LIMIT}; the details stay in user.md, me.md and the pages)`)
  }
  const secs = sections(lines, 0)
  if (secs.length === 0) problems.push(`${file}: there is not one "## heading"`)
  checkSections(file, secs, ' (delete a heading you have nothing to write under)')
}

function listMd(sub) {
  const target = path.join(dir, sub)
  if (!fs.existsSync(target)) return []
  return fs.readdirSync(target).filter((n) => n.endsWith('.md') && !n.startsWith('.')).sort().map((n) => `${sub}/${n}`)
}

checkPage('user.md', { isPage: false, requireHeadings: true })
checkPage('me.md', { isPage: false, requireHeadings: false })
checkInstruction()
for (const file of listMd('pages')) {
  const page = checkPage(file, { isPage: true, requireHeadings: true })
  if (page && page.secs.length > 0 && !SUMMARY.has(page.secs[0].heading)) {
    problems.push(`${file}: make the first heading "Summary" (it is what gets read when the name comes up in the conversation)`)
  }
}
for (const file of listMd('journal')) {
  const name = path.basename(file, '.md')
  if (!DATE.test(name)) problems.push(`${file}: the file name must be YYYY-MM-DD.md`)
  const lines = fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/)
  const secs = sections(lines, 0)
  if (secs.length === 0) problems.push(`${file}: there is not one "## heading" (a journal entry is divided by ## into its subjects)`)
  checkSections(file, secs, '')
}
if (fs.existsSync(path.join(dir, 'profile.md'))) {
  problems.push('profile.md: it is no longer used; move what it holds into instruction.md / user.md, then delete it')
}
if (fs.existsSync(path.join(dir, 'forget.jsonl'))) problems.push('forget.jsonl: it is no longer used; delete it')
for (const stray of fs.readdirSync(dir)) {
  if (/\.md$/.test(stray) && stray !== 'profile.md' && !TOP_LEVEL.includes(stray)) {
    problems.push(`${stray}: this is in the wrong place (a person, a place or a subject belongs in pages/, a record in journal/)`)
  }
}

if (problems.length > 0) {
  for (const p of problems) console.log(p)
  process.exit(1)
}
console.log('OK')
