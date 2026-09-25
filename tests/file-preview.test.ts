import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'

// readFileItem writes the reason a file could not be read in the language of the interface.
const mocks = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => mocks.userData, getPreferredSystemLanguages: () => ['ja-JP'] } }))
beforeAll(() => {
  mocks.userData = mkdtempSync(path.join(tmpdir(), 'asist-file-preview-'))
})

import { createTranslator } from '@shared/i18n'
import { classifyFile, isPathAllowed, listDirectory, readFileItem } from '../src/main/services/file-preview'
import { filesLayout, formatBytes, isHtmlPage, MAX_TEXT_BYTES } from '../src/shared/files'

describe('isHtmlPage', () => {
  it('takes .html and .htm in any case as a page, and nothing else', () => {
    expect(['/a/report.html', '/a/INDEX.HTM', '/a/b.c/page.htm'].every(isHtmlPage)).toBe(true)
    expect(['/a/page.xhtml', '/a/html', '/a/report.html.md', '/a/html.d/notes.txt'].some(isHtmlPage)).toBe(false)
  })
})

describe('classifyFile', () => {
  it('decides the kind of a file from its extension', () => {
    expect(classifyFile('/a/report.md')).toBe('markdown')
    expect(classifyFile('/a/chart.PNG')).toBe('image')
    expect(classifyFile('/a/data.json')).toBe('data')
    expect(classifyFile('/a/rows.csv')).toBe('table')
    expect(classifyFile('/a/script.py')).toBe('code')
    expect(classifyFile('/a/Dockerfile')).toBe('code')
    expect(classifyFile('/a/deck.pptx')).toBe('pptx')
    expect(classifyFile('/a/clip.mov')).toBe('video')
    expect(classifyFile('/a/note.ipynb')).toBe('notebook')
    expect(classifyFile('/a/binary.wasm')).toBe('binary')
    expect(classifyFile('/a/noext')).toBe('binary')
  })
})

describe('isPathAllowed, the path check of show_files', () => {
  const roots = ['/Users/x/asist-jobs', '/Users/x/repo']

  it('allows only paths under an allowed root', () => {
    expect(isPathAllowed('/Users/x/asist-jobs/20260718-job/report.md', roots)).toBe(true)
    expect(isPathAllowed('/Users/x/repo/src/index.ts', roots)).toBe(true)
    expect(isPathAllowed('/Users/x/repo', roots)).toBe(true)
  })

  it('rejects paths outside the roots and sensitive paths', () => {
    expect(isPathAllowed('/Users/x/.ssh/id_rsa', roots)).toBe(false)
    expect(isPathAllowed('/etc/passwd', roots)).toBe(false)
  })

  it('rejects traversal through `..`', () => {
    expect(isPathAllowed('/Users/x/asist-jobs/../.ssh/id_rsa', roots)).toBe(false)
    expect(isPathAllowed('/Users/x/repo/../../etc/passwd', roots)).toBe(false)
  })

  it('rejects a directory whose name merely starts with an allowed root', () => {
    expect(isPathAllowed('/Users/x/repo-evil/secret.txt', roots)).toBe(false)
  })

  it('rejects a relative path and an empty root', () => {
    expect(isPathAllowed('report.md', roots)).toBe(false)
    expect(isPathAllowed('/Users/x/repo/a.ts', [''])).toBe(false)
  })

  it('refuses a symbolic link inside a root that points outside it', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'asist-roots-'))
    mkdirSync(path.join(base, 'root'))
    mkdirSync(path.join(base, 'secret'))
    writeFileSync(path.join(base, 'secret', 'id_rsa'), 'key')
    symlinkSync(path.join(base, 'secret'), path.join(base, 'root', 'link'))
    expect(isPathAllowed(path.join(base, 'root', 'link', 'id_rsa'), [path.join(base, 'root')])).toBe(false)
  })

  it('allows a path under a root that is itself reached through a symbolic link', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'asist-roots-'))
    mkdirSync(path.join(base, 'real'))
    writeFileSync(path.join(base, 'real', 'report.md'), '# report')
    symlinkSync(path.join(base, 'real'), path.join(base, 'alias'))
    expect(isPathAllowed(path.join(base, 'real', 'report.md'), [path.join(base, 'alias')])).toBe(true)
    expect(isPathAllowed(path.join(base, 'alias', 'not-yet.md'), [path.join(base, 'real')])).toBe(true)
  })
})

describe('readFileItem', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'asist-files-'))
  const toUrl = (p: string): string => `asist-file://${p}`

  it('includes the text of a text file and, beyond the limit, keeps only the beginning and sets truncated', () => {
    const file = path.join(dir, 'long.md')
    writeFileSync(file, 'x'.repeat(MAX_TEXT_BYTES + 10))
    const item = readFileItem(file, toUrl)
    expect(item.kind).toBe('markdown')
    expect(item.truncated).toBe(true)
    expect(item.text).toHaveLength(MAX_TEXT_BYTES)
    expect(item.url).toBeUndefined()
  })

  it('keeps a short text as is and reports its size and modification time', () => {
    const file = path.join(dir, 'short.txt')
    writeFileSync(file, 'hello\nworld')
    const item = readFileItem(file, toUrl)
    expect(item).toMatchObject({ kind: 'text', text: 'hello\nworld', sizeBytes: 11, truncated: false })
    expect(item.modifiedAt).toBeGreaterThan(0)
  })

  it('passes images, documents, audio, video and archives by URL instead of by text', () => {
    const file = path.join(dir, 'dot.png')
    writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'))
    const item = readFileItem(file, toUrl)
    expect(item).toMatchObject({ kind: 'image', url: `asist-file://${file}`, sizeBytes: 8 })
    expect(item.text).toBeUndefined()
  })

  it('passes an HTML page both as its source text and by URL, and other code by text alone', () => {
    const page = path.join(dir, 'report.HTML')
    writeFileSync(page, '<h1>レポート</h1>')
    expect(readFileItem(page, toUrl)).toMatchObject({ text: '<h1>レポート</h1>', url: `asist-file://${page}` })
    const script = path.join(dir, 'chart.js')
    writeFileSync(script, 'draw()')
    const item = readFileItem(script, toUrl)
    expect(item.text).toBe('draw()')
    expect(item.url).toBeUndefined()
  })

  it('lists the contents of a folder with directories first and hidden files left out', () => {
    const folder = path.join(dir, 'folder')
    mkdirSync(path.join(folder, 'sub'), { recursive: true })
    writeFileSync(path.join(folder, 'b.csv'), 'a,b')
    writeFileSync(path.join(folder, 'a.md'), '# a')
    writeFileSync(path.join(folder, '.hidden'), '')
    const item = readFileItem(folder, toUrl)
    expect(item.kind).toBe('directory')
    expect(item.entries?.map((entry) => `${entry.kind}:${entry.name}`)).toEqual(['directory:sub', 'markdown:a.md', 'table:b.csv'])
    expect(listDirectory(folder)).toHaveLength(3)
  })

  it('returns an item carrying an error for a missing path instead of throwing', () => {
    const item = readFileItem(path.join(dir, 'missing.txt'), toUrl)
    expect(item).toMatchObject({ name: 'missing.txt', error: createTranslator('ja-JP')('files.errors.missing') })
  })
})

describe('the pure logic of files', () => {
  it('lays out one file as single, several images as gallery, and a mixture as list', () => {
    const image = { path: '/a.png', name: 'a.png', kind: 'image' as const, sizeBytes: 1 }
    const md = { path: '/a.md', name: 'a.md', kind: 'markdown' as const, sizeBytes: 1 }
    expect(filesLayout([md])).toBe('single')
    expect(filesLayout([image, { ...image, path: '/b.png' }])).toBe('gallery')
    expect(filesLayout([image, md])).toBe('list')
    // An item that could not be read does not count when deciding on the gallery layout.
    expect(filesLayout([image, { ...image, path: '/b.png' }, { ...md, error: 'x' }])).toBe('gallery')
  })

  it('formats a size in bytes, kilobytes and megabytes', () => {
    expect(formatBytes(120)).toBe('120B')
    expect(formatBytes(48 * 1024)).toBe('48KB')
    expect(formatBytes(2.3 * 1024 * 1024)).toBe('2.3MB')
  })
})
