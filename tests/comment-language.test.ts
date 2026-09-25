import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'
import { describe, expect, it } from 'vitest'

/**
 * Comments and test titles are written in English (AGENTS.md, "Comments"). This test reads every source file
 * in the repository, tracked or not yet added, so a new directory or file type cannot slip past it. Japanese
 * inside quotes or backticks within a comment is allowed, because a comment may quote data verbatim.
 */

const ROOT = path.resolve(import.meta.dirname, '..')
const JAPANESE = /[\u3040-\u30ff\u4e00-\u9fff]/

/** Places where Japanese prose is correct, each with its reason. Everything else is checked. */
const EXCLUDED: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^resources\/skills\//, reason: 'the skill the app runs to curate the user\'s Japanese memory' },
  { pattern: /\.md$/, reason: 'documents, not code; the README is Japanese' }
]

type Finding = { file: string; line: number; kind: string; text: string }

const lineAt = (text: string, index: number): number => text.slice(0, index).split('\n').length
const withoutQuoted = (text: string): string => text.replace(/`[^`]*`|"[^"]*"|'[^']*'|\u300c[^\u300d]*\u300d/g, '')
const isJapanese = (comment: string): boolean => JAPANESE.test(withoutQuoted(comment))

function scriptFindings(file: string, text: string): Finding[] {
  const ast = parse(text, { sourceType: 'module', plugins: ['typescript', 'jsx', 'importAttributes'] })
  const found: Finding[] = (ast.comments ?? [])
    .filter((comment) => isJapanese(comment.value))
    .map((comment) => ({ file, line: comment.loc?.start.line ?? 0, kind: 'comment', text: comment.value }))
  if (!file.startsWith('tests/')) return found

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit)
    if (!node || typeof node !== 'object') return
    const current = node as { type?: string; callee?: unknown; arguments?: Array<{ type: string; value?: string; quasis?: Array<{ value: { raw: string } }>; loc?: { start: { line: number } } }> }
    if (current.type === 'CallExpression' && current.arguments && current.arguments.length > 0) {
      // `it.each(rows)('title', …)` and `describe.skip('title', …)` still lead back to it / describe / test.
      let callee = current.callee as { type?: string; object?: unknown; callee?: unknown; name?: string } | undefined
      while (callee && (callee.type === 'MemberExpression' || callee.type === 'CallExpression')) {
        callee = (callee.type === 'MemberExpression' ? callee.object : callee.callee) as typeof callee
      }
      const first = current.arguments[0]
      if (callee?.type === 'Identifier' && ['describe', 'it', 'test'].includes(callee.name ?? '')) {
        const title = first.type === 'StringLiteral' ? (first.value ?? '') : first.type === 'TemplateLiteral' ? (first.quasis ?? []).map((quasi) => quasi.value.raw).join('') : ''
        if (JAPANESE.test(title)) found.push({ file, line: first.loc?.start.line ?? 0, kind: 'test title', text: title })
      }
    }
    for (const [key, value] of Object.entries(current)) if (key !== 'loc' && !key.endsWith('Comments')) visit(value)
  }
  visit(ast.program)
  return found
}

/** Comments matched by a pattern: block comments in CSS, `<!-- -->` in markup. */
function patternFindings(file: string, text: string, pattern: RegExp): Finding[] {
  return [...text.matchAll(pattern)].filter((match) => isJapanese(match[0])).map((match) => ({ file, line: lineAt(text, match.index), kind: 'comment', text: match[0] }))
}

/** `#` comments. A `#` counts only at the start of a line or after whitespace, and not inside a quoted string on that line. */
function hashFindings(file: string, text: string): Finding[] {
  const found: Finding[] = []
  text.split('\n').forEach((line, index) => {
    const comment = /(^|\s)#(?!!)(.*)$/.exec(withoutQuoted(line))
    if (comment && JAPANESE.test(comment[2])) found.push({ file, line: index + 1, kind: 'comment', text: comment[2] })
  })
  return found
}

/** Python docstrings: a triple-quoted string that starts a line. A triple-quoted value assigned to a name does not start one. */
function docstringFindings(file: string, text: string): Finding[] {
  return [...text.matchAll(/^[ \t]*[rRbBuU]{0,2}("""[\s\S]*?"""|'''[\s\S]*?''')/gm)]
    .filter((match) => isJapanese(match[1].slice(3, -3)))
    .map((match) => ({ file, line: lineAt(text, match.index), kind: 'docstring', text: match[1] }))
}

/** `//` and block comments in Swift, after blanking string literals so a URL inside one is not read as a comment. */
function swiftFindings(file: string, text: string): Finding[] {
  const blanked = text.replace(/"(?:[^"\\\n]|\\.)*"/g, (literal) => '"' + ' '.repeat(literal.length - 2) + '"')
  return [...blanked.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g)]
    .map((match) => ({ match, original: text.slice(match.index, match.index + match[0].length) }))
    .filter(({ original }) => isJapanese(original))
    .map(({ match, original }) => ({ file, line: lineAt(text, match.index), kind: 'comment', text: original }))
}

const CHECKS: Array<{ files: RegExp; find: (file: string, text: string) => Finding[] }> = [
  { files: /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/, find: scriptFindings },
  { files: /\.css$/, find: (file, text) => patternFindings(file, text, /\/\*[\s\S]*?\*\//g) },
  { files: /\.(html|xml|plist|svg)$/, find: (file, text) => patternFindings(file, text, /<!--[\s\S]*?-->/g) },
  { files: /\.py$/, find: (file, text) => [...hashFindings(file, text), ...docstringFindings(file, text)] },
  { files: /(\.(sh|ya?ml|toml)|(^|\/)\.gitignore|(^|\/)\.env\.example)$/, find: hashFindings },
  { files: /\.swift$/, find: swiftFindings }
]

function sourceFiles(): string[] {
  const list = (args: string[]): string[] => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean)
  const files = new Set([...list(['ls-files']), ...list(['ls-files', '--others', '--exclude-standard'])])
  return [...files].filter((file) => !EXCLUDED.some(({ pattern }) => pattern.test(file))).sort()
}

describe('the language of comments and test titles', () => {
  // Parsing every source file took 408 ms when this file ran alone, but 6914 ms when `npm test` ran while
  // `npm run demo:fit` kept three headless Chromes busy (10-core Mac, 2026-09-24), past vitest's default of
  // 5000 ms. The explicit timeout keeps a busy machine from failing a test whose assertion holds.
  it('finds no Japanese outside quoted data in any comment, docstring or test title', { timeout: 30_000 }, () => {
    const findings: Finding[] = []
    for (const file of sourceFiles()) {
      const check = CHECKS.find(({ files }) => files.test(file))
      if (!check) continue
      let text: string
      try {
        text = readFileSync(path.join(ROOT, file), 'utf8')
      } catch (error) {
        // A tracked file that was deleted in the working tree is still listed by git.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      findings.push(...check.find(file, text))
    }
    const report = findings.map(({ file, line, kind, text }) => `${file}:${line}: ${kind}: ${text.trim().replace(/\s+/g, ' ').slice(0, 100)}`)
    expect(report).toEqual([])
  })
})
