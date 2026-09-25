#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'

/**
 * Moves the UI messages between the dictionary (src/shared/i18n/messages/*.ts) and one JSON file per
 * group, which is the form a translator works on. The dictionary keeps every language of a message side
 * by side, so several people writing different languages at once would all edit the same lines; with this
 * each of them writes a folder of their own and the texts are put in afterwards.
 *
 *   node scripts/i18n/locale-files.mjs export <dir>            writes <dir>/source/<group>.json as { key: { ja, en } }
 *   node scripts/i18n/locale-files.mjs merge <dir> <locale>    reads <dir>/<locale>/<group>.json as { key: text } and
 *                                                              writes that language into the dictionary
 *
 * A text is a string, or plural forms such as { "one": "…", "other": "…" }. Merging a locale again replaces
 * what the dictionary holds for it. Comments and the order of the messages are kept.
 */

const ROOT = path.resolve(import.meta.dirname, '../..')
const MESSAGES = path.join(ROOT, 'src/shared/i18n/messages')
const SOURCE = 'ja-JP'
/** The order in which the languages of a message are written. */
const ORDER = ['ja-JP', 'en-US', 'fr-FR', 'de-DE', 'hi-IN', 'id-ID', 'it-IT', 'ko-KR', 'pt-BR', 'es-419', 'es-ES']

const camel = (name) => name.replace(/-(\w)/g, (_match, letter) => letter.toUpperCase())
const keyName = (property) => (property.key.type === 'Identifier' ? property.key.name : property.key.value)

/** Every message of one file: its key, the object literal that holds its languages, and the column it is indented to. */
function messagesOf(file) {
  const code = readFileSync(path.join(MESSAGES, file), 'utf8')
  const ast = parse(code, { sourceType: 'module', plugins: ['typescript'] })
  const found = []
  const visit = (node, prefix) => {
    for (const property of node.properties) {
      const key = `${prefix}${keyName(property)}`
      const value = property.value
      if (value.properties.some((inner) => keyName(inner) === SOURCE)) found.push({ key, node: value, indent: property.loc.start.column })
      else visit(value, `${key}.`)
    }
  }
  for (const statement of ast.program.body) {
    const declaration = statement.declaration?.declarations?.[0]
    if (!declaration) continue
    let init = declaration.init
    if (init.type !== 'CallExpression') continue
    init = init.arguments[0]
    visit(init, `${declaration.id.name}.`)
  }
  return { code, found }
}

const evaluate = (code, node) => Function(`return (${code.slice(node.start, node.end)})`)()

function quote(text) {
  if (!text.includes("'") && !text.includes('\\') && !text.includes('\n')) return `'${text}'`
  return JSON.stringify(text)
}

function literal(value) {
  if (typeof value === 'string') return quote(value)
  return `{ ${Object.entries(value).map(([category, text]) => `${category}: ${quote(text)}`).join(', ')} }`
}

function exportSource(dir) {
  mkdirSync(path.join(dir, 'source'), { recursive: true })
  let total = 0
  for (const file of readdirSync(MESSAGES).filter((name) => name.endsWith('.ts'))) {
    const { code, found } = messagesOf(file)
    const rows = {}
    for (const { key, node } of found) {
      const value = evaluate(code, node)
      rows[key] = { ja: value['ja-JP'], en: value['en-US'] }
    }
    total += found.length
    writeFileSync(path.join(dir, 'source', `${camel(file.slice(0, -3))}.json`), `${JSON.stringify(rows, null, 1)}\n`)
  }
  console.log(`${total} messages`)
}

function merge(dir, locale) {
  if (!ORDER.includes(locale)) throw new Error(`${locale} is not one of ${ORDER.join(', ')}`)
  let total = 0
  for (const file of readdirSync(MESSAGES).filter((name) => name.endsWith('.ts'))) {
    const translated = JSON.parse(readFileSync(path.join(dir, locale, `${camel(file.slice(0, -3))}.json`), 'utf8'))
    let { code, found } = messagesOf(file)
    // Later messages are rewritten first, so that the positions of the earlier ones stay valid.
    for (const { key, node, indent } of found.reverse()) {
      if (!(key in translated)) throw new Error(`${locale} has no text for ${key}`)
      const texts = Object.fromEntries(node.properties.map((property) => [keyName(property), code.slice(property.value.start, property.value.end)]))
      texts[locale] = literal(translated[key])
      const pad = ' '.repeat(indent + 2)
      const lines = ORDER.filter((one) => one in texts).map((one) => `${pad}'${one}': ${texts[one]}`)
      code = `${code.slice(0, node.start)}{\n${lines.join(',\n')}\n${' '.repeat(indent)}}${code.slice(node.end)}`
      total += 1
    }
    writeFileSync(path.join(MESSAGES, file), code)
  }
  console.log(`${locale}: ${total} messages written`)
}

const [command, dir, locale] = process.argv.slice(2)
if (command === 'export' && dir) exportSource(path.resolve(dir))
else if (command === 'merge' && dir && locale) merge(path.resolve(dir), locale)
else {
  console.error('usage: node scripts/i18n/locale-files.mjs export <dir> | merge <dir> <locale>')
  process.exit(2)
}
