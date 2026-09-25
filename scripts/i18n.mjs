#!/usr/bin/env node
/**
 * Edits the dictionary under src/shared/i18n/messages without hand-writing the nested objects.
 *
 *   node scripts/i18n.mjs get <key>
 *   node scripts/i18n.mjs set <key> <json | @file.json>   a message ({ "ja-JP": …, … }) or a group of them
 *   node scripts/i18n.mjs move <from> <to>                 a message or a whole group, and every quoted use of the key
 *   node scripts/i18n.mjs remove <key>
 *   node scripts/i18n.mjs check                            every message has the eleven languages, in order
 *
 * A key starts with the group, as the code writes it (`notes.errors.notFound`); the group's file is its
 * name in kebab case. A group that does not exist yet gets its file and its entries in index.ts, and a
 * group left empty loses both. The files are edited as text, relying on the layout they are written in
 * (two spaces per level, one entry per block), so comments above an entry move with it. Run
 * `npm run typecheck` and `npm test` afterwards.
 */
import fs from 'node:fs'
import path from 'node:path'

// I18N_ROOT points the script at a copy of the repository, which is how its test runs it.
const ROOT = process.env.I18N_ROOT ?? path.resolve(import.meta.dirname, '..')
const DIR = path.join(ROOT, 'src/shared/i18n/messages')
const INDEX = path.join(ROOT, 'src/shared/i18n/index.ts')
const LOCALES = [...fs.readFileSync(path.join(ROOT, 'src/shared/i18n/message.ts'), 'utf8').match(/UI_LOCALES = \[([^\]]*)\]/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1])

const fail = (message) => {
  console.error(`i18n: ${message}`)
  process.exit(1)
}
const kebab = (group) => group.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
const fileOf = (group) => path.join(DIR, `${kebab(group)}.ts`)
const pad = (depth) => '  '.repeat(depth)

function split(key) {
  const parts = key.split('.')
  if (parts.length < 2 || parts.some((p) => !/^[A-Za-z0-9]+$/.test(p))) fail(`not a key: ${key}`)
  return { group: parts[0], parts: parts.slice(1) }
}

/** The lines of a group's file, with the line that opens defineMessages and the one that closes it. */
function load(group) {
  const file = fileOf(group)
  if (!fs.existsSync(file)) return null
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const open = lines.findIndex((l) => /^export const \w+ = defineMessages\(\{$/.test(l))
  const close = lines.lastIndexOf('})')
  if (open < 0 || close < open) fail(`${path.relative(ROOT, file)} is not laid out as defineMessages({ … })`)
  return { file, lines, open, close }
}
const save = (doc) => fs.writeFileSync(doc.file, doc.lines.join('\n'))
/** Lines were inserted or removed, so the line that closes defineMessages has moved. */
const refresh = (doc) => {
  doc.close = doc.lines.lastIndexOf('})')
}

/** The entries directly inside lines (from, to), each with its first line including the comment above it. */
function children(lines, from, to, depth) {
  const header = new RegExp(`^${pad(depth)}([A-Za-z0-9]+): \\{`)
  const found = []
  for (let i = from + 1; i < to; i++) {
    const m = header.exec(lines[i])
    if (!m) continue
    const end = lines.findIndex((l, j) => j > i && (l === `${pad(depth)}}` || l === `${pad(depth)}},`))
    if (end < 0 || end >= to) fail(`no end for ${m[1]} at line ${i + 1}`)
    let start = i
    while (start - 1 > from && /^\s*(\/\*\*|\*|\*\/|\/\/)/.test(lines[start - 1])) start--
    found.push({ key: m[1], start, header: i, end })
    i = end
  }
  return found
}

/** Where a key is: its block, and the block of its parent. Missing parts come back as null. */
function locate(doc, parts) {
  let from = doc.open
  let to = doc.close
  let entry = null
  for (let depth = 0; depth < parts.length; depth++) {
    entry = children(doc.lines, from, to, depth + 1).find((c) => c.key === parts[depth]) ?? null
    if (!entry) return { entry: null, parentFrom: from, parentTo: to, depth, found: depth }
    if (depth < parts.length - 1) {
      from = entry.header
      to = entry.end
    }
  }
  return { entry, parentFrom: from, parentTo: to, depth: parts.length - 1, found: parts.length }
}

/** Every entry of a block ends with a comma except the last one. */
function fixCommas(lines, from, to, depth) {
  const list = children(lines, from, to, depth)
  list.forEach((c, i) => {
    const line = lines[c.end].replace(/,$/, '')
    lines[c.end] = i < list.length - 1 ? `${line},` : line
  })
}

const isMessage = (value) => typeof value === 'object' && value !== null && 'ja-JP' in value
function quote(text) {
  if (text.includes("'")) return JSON.stringify(text)
  return `'${text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}'`
}
function checkMessage(key, value) {
  const keys = Object.keys(value)
  const missing = LOCALES.filter((l) => !keys.includes(l))
  const extra = keys.filter((k) => !LOCALES.includes(k))
  if (missing.length || extra.length) fail(`${key}: missing ${missing.join(', ') || 'none'}, unknown ${extra.join(', ') || 'none'}`)
}
function render(key, value, depth, fullKey) {
  if (isMessage(value)) {
    checkMessage(fullKey, value)
    const forms = (v) => (typeof v === 'string' ? quote(v) : `{ ${Object.entries(v).map(([k, x]) => `${k}: ${quote(x)}`).join(', ')} }`)
    return [`${pad(depth)}${key}: {`, ...LOCALES.map((l, i) => `${pad(depth + 1)}'${l}': ${forms(value[l])}${i < LOCALES.length - 1 ? ',' : ''}`), `${pad(depth)}}`]
  }
  const entries = Object.entries(value)
  if (!entries.length) fail(`${fullKey}: an empty group`)
  const body = entries.flatMap(([k, v], i) => {
    const block = render(k, v, depth + 1, `${fullKey}.${k}`)
    if (i < entries.length - 1) block[block.length - 1] += ','
    return block
  })
  return [`${pad(depth)}${key}: {`, ...body, `${pad(depth)}}`]
}

function createGroup(group) {
  const file = fileOf(group)
  fs.writeFileSync(file, `import { defineMessages } from '../message'\n\nexport const ${group} = defineMessages({\n})\n`)
  let index = fs.readFileSync(INDEX, 'utf8')
  const importLine = `import { ${group} } from './messages/${kebab(group)}'`
  index = insertSorted(index, /^import \{ (\w+) \} from '\.\/messages\/[\w-]+'$/, group, importLine)
  index = insertSorted(index, /^  readonly (\w+): typeof \w+$/, group, `  readonly ${group}: typeof ${group}`)
  index = insertSorted(index, /^  (\w+),?$/, group, `  ${group},`, 'MESSAGES')
  fs.writeFileSync(INDEX, index)
  console.log(`created ${path.relative(ROOT, file)} and registered it in index.ts`)
}
function insertSorted(text, pattern, name, line, after) {
  const lines = text.split('\n')
  const start = after ? lines.findIndex((l) => l.includes(`export const ${after}`)) : 0
  const rows = lines.map((l, i) => ({ i, m: i > start ? pattern.exec(l) : null })).filter((r) => r.m)
  const next = rows.find((r) => r.m[1] > name)
  const at = next ? next.i : rows.at(-1).i + 1
  if (!next && after) lines[rows.at(-1).i] = lines[rows.at(-1).i].replace(/,?$/, ',')
  lines.splice(at, 0, next || !after ? line : line.replace(/,$/, ''))
  return lines.join('\n')
}
function deleteGroup(group) {
  fs.rmSync(fileOf(group))
  const lines = fs.readFileSync(INDEX, 'utf8').split('\n')
  const kept = lines.filter(
    (l) => l !== `import { ${group} } from './messages/${kebab(group)}'` && l !== `  readonly ${group}: typeof ${group}` && l.trim().replace(/,$/, '') !== group
  )
  const close = kept.findIndex((l, i) => i > kept.findIndex((x) => x.includes('export const MESSAGES')) && l === '}')
  kept[close - 1] = kept[close - 1].replace(/,$/, '')
  fs.writeFileSync(INDEX, kept.join('\n'))
  console.log(`removed the empty group ${group} and its entries in index.ts`)
}

function getText(key) {
  const { group, parts } = split(key)
  const doc = load(group)
  const at = doc && locate(doc, parts)
  if (!at?.entry) fail(`no such key: ${key}`)
  return { doc, at, text: doc.lines.slice(at.entry.start, at.entry.end + 1) }
}

/** Puts lines (already indented for depth) into the parent block, replacing the key when it is there. */
function put(key, block) {
  const { group, parts } = split(key)
  let doc = load(group)
  if (!doc) {
    createGroup(group)
    doc = load(group)
  }
  let at = locate(doc, parts)
  // Missing parent groups are opened one level at a time.
  while (!at.entry && at.found < parts.length - 1) {
    const depth = at.found + 1
    doc.lines.splice(at.parentTo, 0, `${pad(depth)}${parts[at.found]}: {`, `${pad(depth)}}`)
    fixCommas(doc.lines, at.parentFrom, at.parentTo + 2, depth)
    refresh(doc)
    const before = at.found
    at = locate(doc, parts)
    if (at.found <= before) fail(`could not open the group ${parts.slice(0, before + 1).join('.')}`)
  }
  const depth = parts.length
  if (at.entry) {
    const keepComment = doc.lines.slice(at.entry.start, at.entry.header)
    const hasComment = /^\s*(\/\*\*|\/\/)/.test(block[0])
    doc.lines.splice(at.entry.start, at.entry.end - at.entry.start + 1, ...(hasComment ? block : [...keepComment, ...block]))
  } else {
    doc.lines.splice(at.parentTo, 0, ...block)
  }
  refresh(doc)
  const parent = locate(doc, parts.slice(0, -1).length ? parts.slice(0, -1) : [])
  const [from, to] = parts.length > 1 ? [parent.entry.header, parent.entry.end] : [doc.open, doc.close]
  fixCommas(doc.lines, from, to, depth)
  save(doc)
}

function drop(key) {
  const { group, parts } = split(key)
  const { doc, at } = getText(key)
  doc.lines.splice(at.entry.start, at.entry.end - at.entry.start + 1)
  const parentTo = at.parentTo - (at.entry.end - at.entry.start + 1)
  fixCommas(doc.lines, at.parentFrom, parentTo, parts.length)
  save(doc)
  if (children(doc.lines, at.parentFrom, parentTo, parts.length).length > 0) return
  if (parts.length > 1) drop(`${group}.${parts.slice(0, -1).join('.')}`)
  else deleteGroup(group)
}

const reindent = (lines, delta) => lines.map((l) => (delta >= 0 ? pad(delta) + l : l.replace(new RegExp(`^ {0,${-delta * 2}}`), '')))

/** The source files a key can be used in: src, tests and scripts, without the dictionary itself. */
function sourceFiles() {
  const files = []
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, name.name)
      if (name.isDirectory()) {
        if (name.name !== 'node_modules' && full !== DIR) walk(full)
      } else if (/\.(ts|tsx|mjs)$/.test(name.name)) files.push(full)
    }
  }
  for (const dir of ['src', 'tests', 'scripts']) if (fs.existsSync(path.join(ROOT, dir))) walk(path.join(ROOT, dir))
  return files
}

/**
 * The places the old key still appears after the quoted uses were rewritten: a key inside a longer string
 * (`'[asist:mail.x'`) or a regular expression (`/mail\.x/`). These are not rewritten, because the same
 * text outside a string can be ordinary code, so they are listed for a person or an agent to fix.
 */
function leftovers(from) {
  const pattern = new RegExp(`(?<![A-Za-z0-9_$.])${from.split('.').join('\\\\?\\.')}(?![A-Za-z0-9_$])`)
  const found = []
  for (const file of sourceFiles()) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (pattern.test(line)) found.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 120)}`)
    })
  }
  return found
}

function rewriteUses(from, to) {
  const changed = []
  const quoted = new RegExp(`(['"\`])${from.replace(/\./g, '\\.')}(?=[.'"\`])`, 'g')
  for (const file of sourceFiles()) {
    const text = fs.readFileSync(file, 'utf8')
    const next = text.replace(quoted, `$1${to}`)
    if (next !== text) {
      fs.writeFileSync(file, next)
      changed.push(path.relative(ROOT, file))
    }
  }
  return changed
}

function check() {
  let problems = 0
  for (const name of fs.readdirSync(DIR).filter((n) => n.endsWith('.ts'))) {
    const lines = fs.readFileSync(path.join(DIR, name), 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (!/^\s*'ja-JP': /.test(line)) return
      const indent = line.match(/^\s*/)[0]
      const seen = []
      for (let j = i; j < lines.length && lines[j].startsWith(indent) && /^\s*'[\w-]+': /.test(lines[j]); j++) seen.push(lines[j].trim().match(/^'([\w-]+)'/)[1])
      if (seen.join() !== LOCALES.join()) {
        problems++
        console.log(`${name}:${i + 1} has ${seen.join(', ')}`)
      }
    })
  }
  if (problems) fail(`${problems} messages do not list the eleven languages in order`)
  console.log('every message lists the eleven languages in order')
}

const [command, a, b] = process.argv.slice(2)
if (command === 'get') {
  console.log(getText(a).text.join('\n'))
} else if (command === 'set') {
  if (!a || !b) fail('set <key> <json | @file.json>')
  const value = JSON.parse(b.startsWith('@') ? fs.readFileSync(b.slice(1), 'utf8') : b)
  const parts = a.split('.')
  put(a, render(parts.at(-1), value, parts.length - 1, a))
  console.log(`set ${a}`)
} else if (command === 'move') {
  if (!a || !b) fail('move <from> <to>')
  const { text } = getText(a)
  if (load(split(b).group) && locate(load(split(b).group), split(b).parts).entry) fail(`${b} exists already`)
  const fromDepth = a.split('.').length - 1
  const toDepth = b.split('.').length - 1
  const block = reindent(text, toDepth - fromDepth)
  const header = block.findIndex((l) => new RegExp(`^\\s*${a.split('.').at(-1)}: \\{`).test(l))
  block[header] = block[header].replace(/^(\s*)\w+:/, `$1${b.split('.').at(-1)}:`)
  block[block.length - 1] = block[block.length - 1].replace(/,$/, '')
  drop(a)
  put(b, block)
  const uses = rewriteUses(a, b)
  console.log(`moved ${a} to ${b}; rewrote the key in ${uses.length ? uses.join(', ') : 'no file'}`)
  const left = leftovers(a)
  if (left.length) {
    console.error(`${a} still appears where it was not rewritten; change these by hand:`)
    for (const line of left) console.error(`  ${line}`)
    process.exitCode = 1
  }
} else if (command === 'remove') {
  drop(a)
  console.log(`removed ${a}`)
} else if (command === 'check') {
  check()
} else {
  fail('commands: get, set, move, remove, check')
}
