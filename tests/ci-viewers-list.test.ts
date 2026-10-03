import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformWithEsbuild } from 'vite'
import { describe, expect, it } from 'vitest'
import { OFFICE_TEMPLATES } from '../scripts/cdp/viewer-files/office.mjs'

/**
 * CI runs the viewer budgets only when a changed file matches the viewers patterns of the changes job in ci.yml. The
 * patterns are written by hand from the files the scene runs, so a module that one of them comes to import is
 * checked here: a change to a file the walk reaches and no pattern matches would skip the budgets.
 */

const root = process.cwd()
const at = (file: string): string => path.join(root, file)
/** A file's name as git gives it, relative to the repository with forward slashes, which the patterns match. */
const named = (file: string): string => path.relative(root, file).split(path.sep).join('/')

/**
 * Where the walk starts: the files card, the card's frame and the preview page with the kinds its import.meta.glob
 * loads; the scene, the cases it loads by listing their folder, the demo's config, and the range parser the demo
 * serves the files with, which demo-server.mjs loads by its path.
 */
const ENTRIES = [
  'src/renderer/src/panels/builtin/files.tsx',
  'src/renderer/src/panels/shell/PanelCard.tsx',
  'src/renderer/src/panels/shell/PanelContent.tsx',
  'src/renderer/src/ui/FocusOverlay.tsx',
  'src/renderer/preview.html',
  'scripts/cdp/scenes/viewer-budgets.mjs',
  ...fs.readdirSync(at('scripts/cdp/scenes/viewer-budgets')).map((name) => `scripts/cdp/scenes/viewer-budgets/${name}`),
  'scripts/vite.demo.config.mts',
  'src/shared/byte-range.ts'
]

/**
 * Listed but not followed: the other cards behind the registry, the store's other modules, and the dictionary's
 * words, which load with the app but do not change the time or the memory a viewer takes.
 */
const STOPS = new Set([
  'src/renderer/src/panels/registry.tsx',
  'src/renderer/src/state/stores.ts',
  'src/renderer/src/i18n.ts',
  'src/shared/i18n/index.ts'
])

/** Read by the scene without an import: the page it measures, the hooks it calls there, and the generators' samples. */
const NAMED = [
  'src/renderer/index.html',
  'src/renderer/src/demo/index.tsx',
  ...Object.values(OFFICE_TEMPLATES).map((url) => named(fileURLToPath(url))),
  '.github/workflows/ci.yml'
]

const ALIASES: Array<[string, string]> = [
  ['@shared/', 'src/shared/'],
  ['@/', 'src/renderer/src/']
]
const EXTENSIONS = ['', '.ts', '.tsx', '.mts', '.mjs', '.js', '/index.ts', '/index.tsx']

/** The file a specifier names from `from`, or null for a package or a built-in module. */
function resolve(specifier: string, from: string): string | null {
  const alias = ALIASES.find(([prefix]) => specifier.startsWith(prefix))
  let base: string
  if (alias) base = at(alias[1] + specifier.slice(alias[0].length))
  else if (specifier.startsWith('.')) base = path.resolve(path.dirname(from), specifier)
  // An HTML page of the demo names its script from Vite's root.
  else if (specifier.startsWith('/') && from.endsWith('.html')) base = at(path.join('src/renderer', specifier))
  else return null
  const found = EXTENSIONS.map((extension) => base + extension).find((file) => fs.existsSync(file) && fs.statSync(file).isFile())
  if (!found) throw new Error(`${named(from)} imports ${specifier}, which names no file`)
  return found
}

/** The files matching an import.meta.glob pattern of one star in the file name, as the preview page uses it. */
function glob(pattern: string, from: string): string[] {
  const folder = path.resolve(path.dirname(from), path.dirname(pattern))
  const [head, tail] = path.basename(pattern).split('*')
  return fs.readdirSync(folder).filter((name) => name.startsWith(head) && name.endsWith(tail)).map((name) => path.join(folder, name))
}

/**
 * The imports of a file as they run, with their queries: a TypeScript file is transformed first, which drops the
 * imports that only bring types.
 */
async function importsOf(file: string): Promise<Array<{ specifier: string; glob: boolean }>> {
  const source = fs.readFileSync(file, 'utf8')
  if (file.endsWith('.html')) return [...source.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => ({ specifier: m[1], glob: false }))
  if (file.endsWith('.css')) return [...source.matchAll(/@import\s+(?:url\()?["']([^"']+)["']/g)].map((m) => ({ specifier: m[1], glob: false }))
  const code = /\.(ts|tsx|mts)$/.test(file) ? (await transformWithEsbuild(source, file, { jsx: 'automatic' })).code : source
  return [
    ...[...code.matchAll(/\bfrom\s*["']([^"']+)["']/g), ...code.matchAll(/\bimport\s*["']([^"']+)["']/g), ...code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map(
      (m) => ({ specifier: m[1], glob: false })
    ),
    ...[...code.matchAll(/import\.meta\.glob(?:<[^>]*>)?\(\s*["']([^"']+)["']/g)].map((m) => ({ specifier: m[1], glob: true }))
  ]
}

/** Every file of the repository the walk reaches from ENTRIES, without following STOPS. */
async function reached(): Promise<string[]> {
  const seen = new Set<string>()
  const queue = ENTRIES.map(at)
  while (queue.length) {
    const file = queue.shift()!
    const name = named(file)
    if (seen.has(name)) continue
    seen.add(name)
    if (STOPS.has(name) || !/\.(tsx?|mts|mjs|js|css|html)$/.test(file)) continue
    for (const { specifier, glob: isGlob } of await importsOf(file)) {
      if (isGlob) {
        queue.push(...glob(specifier, file))
        continue
      }
      const [bare, query] = specifier.split('?')
      const target = resolve(bare, file)
      if (target === null) continue
      // A worker is a module of its own; a file asked for as a URL or as text is read but not run as a module here.
      if (query === undefined || query === 'worker') queue.push(target)
      else seen.add(named(target))
    }
  }
  return [...seen].sort()
}

/** The viewers patterns of the changes job, which ci.yml gives grep -E. */
function viewersPatterns(): RegExp[] {
  const workflow = fs.readFileSync(at('.github/workflows/ci.yml'), 'utf8')
  const block = workflow.split('if grep -qzE').find((part) => part.includes('echo viewers=true'))
  if (!block) throw new Error('ci.yml has no grep that sets viewers')
  const patterns = [...block.split('echo viewers=true')[0].matchAll(/-e '([^']+)'/g)].map((m) => new RegExp(m[1]))
  if (patterns.length === 0) throw new Error('the grep that sets viewers in ci.yml names no pattern')
  return patterns
}

describe('the viewers list of CI', () => {
  it('matches every file the scene runs, as far as the walk follows the imports', async () => {
    const patterns = viewersPatterns()
    const files = [...(await reached()), ...NAMED]
    expect(files).toContain('src/renderer/src/panels/viewers/PdfViewer.tsx')
    expect(files.filter((file) => !patterns.some((pattern) => pattern.test(file)))).toEqual([])
  })
})
