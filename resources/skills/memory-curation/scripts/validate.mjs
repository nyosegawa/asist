#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

// Checks a memory directory. Usage: node validate.mjs <memoryDir>
// Every problem is printed on its own line and the exit code is 1; with none it prints OK. The check ASIST
// runs when it merges a curation uses the same rules. The English skill ships the same checks with its
// problems written in English.

const dir = path.resolve(process.argv[2] ?? '.')
const problems = []
const DATE = /^\d{4}-\d{2}-\d{2}$/
// A memory directory can hold pages written before the user changed the language of the conversation, so
// both forms of the fixed heading are accepted whichever language this run writes in.
const SUMMARY = new Set(['要約', 'Summary'])
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
    if (!s.text) problems.push(`${file}:${s.line}: 見出し「${s.heading}」の下に本文がありません${emptyHint}`)
    else if (length(s.text) > SECTION_LIMIT) {
      problems.push(`${file}:${s.line}: 見出し「${s.heading}」の本文が ${length(s.text)} 字あります(${SECTION_LIMIT} 字までにしてください)`)
    }
  }
}

function checkPage(file, { isPage, requireHeadings }) {
  const full = path.join(dir, file)
  if (!fs.existsSync(full)) return null
  const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/)
  const { fm, bodyStart } = frontmatter(lines)
  if (!fm.present) problems.push(`${file}: frontmatter がありません`)
  else if (!fm.closed) problems.push(`${file}: frontmatter が閉じていません(--- が一つしかありません)`)
  for (const key of ['kind', 'links']) {
    if (fm.keys.has(key)) problems.push(`${file}: frontmatter の ${key} は使わないので消してください`)
  }
  if (!isPage && fm.keys.has('aliases')) problems.push(`${file}: aliases は pages/ のページにだけ書きます。消してください`)
  if (fm.updated && !DATE.test(fm.updated)) problems.push(`${file}: updated は YYYY-MM-DD の日付にしてください`)
  if (!lines.slice(bodyStart).some((l) => /^# /.test(l))) problems.push(`${file}: 「# 名前」の見出しがありません`)
  const secs = sections(lines, bodyStart)
  if (requireHeadings && secs.length === 0) problems.push(`${file}: 「## 見出し」が一つもありません`)
  checkSections(file, secs, '(書くことが無い見出しは消してください)')
  return { secs }
}

function checkInstruction() {
  const file = 'instruction.md'
  const full = path.join(dir, file)
  if (!fs.existsSync(full)) {
    problems.push(`${file}: ありません(毎回の会話に載せる要約なので、user.md、me.md、ページから書いてください)`)
    return
  }
  const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/)
  if (lines[0]?.trim() === '---') problems.push(`${file}: frontmatter は要りません。消してください`)
  const title = lines.findIndex((l) => /^# /.test(l))
  if (title < 0) problems.push(`${file}: 「# いつも覚えておくこと」の見出しがありません`)
  const body = lines.slice(title + 1).join('\n')
  if (length(body) > INSTRUCTION_LIMIT) {
    problems.push(`${file}: 本文が ${length(body)} 字あります(${INSTRUCTION_LIMIT} 字までにしてください。詳しいことは user.md、me.md、ページに残します)`)
  }
  const secs = sections(lines, 0)
  if (secs.length === 0) problems.push(`${file}: 「## 見出し」が一つもありません`)
  checkSections(file, secs, '(書くことが無い見出しは消してください)')
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
    problems.push(`${file}: 最初の見出しは「要約」にしてください(名前が会話に出たとき、ここが読まれます)`)
  }
}
for (const file of listMd('journal')) {
  const name = path.basename(file, '.md')
  if (!DATE.test(name)) problems.push(`${file}: ファイル名は YYYY-MM-DD.md にしてください`)
  const lines = fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/)
  const secs = sections(lines, 0)
  if (secs.length === 0) problems.push(`${file}: 「## 見出し」が一つもありません(日記は話題ごとに ## で区切ってください)`)
  checkSections(file, secs, '')
}
if (fs.existsSync(path.join(dir, 'profile.md'))) {
  problems.push('profile.md: 使わないので、中身を instruction.md / user.md に移してから消してください')
}
if (fs.existsSync(path.join(dir, 'forget.jsonl'))) problems.push('forget.jsonl: 使わないので消してください')
for (const stray of fs.readdirSync(dir)) {
  if (/\.md$/.test(stray) && stray !== 'profile.md' && !TOP_LEVEL.includes(stray)) {
    problems.push(`${stray}: 置く場所が違います(人や場所や物事は pages/、記録は journal/ に置いてください)`)
  }
}

if (problems.length > 0) {
  for (const p of problems) console.log(p)
  process.exit(1)
}
console.log('OK')
