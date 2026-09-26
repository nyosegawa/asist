import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { baseName, dirName, isAbsolutePath, pathInside, samePath, trimTrailingSeparator } from '@shared/file-path'

const posixPaths = ['/', '/Users', '/Users/me/repo', '/Users/me/repo/', '/Users/me//repo/a.md', 'rel', 'rel/a.md', 'rel/a/']
const windowsPaths = [
  'C:\\',
  'C:/',
  'C:\\Users',
  'C:\\Users\\me\\repo',
  'C:\\Users\\me\\repo\\',
  'C:/Users/me/repo/a.md',
  'C:\\Users/me\\repo/a.md',
  'C:rel\\a.md',
  '\\\\server\\share\\docs\\a.md',
  'rel\\a.md'
]

describe('file-path', () => {
  it('takes "/", a drive letter with either separator and a UNC path as absolute, and nothing relative to a folder or a drive', () => {
    for (const p of ['/Users/me', 'C:\\Users\\me', 'C:/Users/me', 'c:\\', '\\\\server\\share\\a.md']) expect(isAbsolutePath(p)).toBe(true)
    for (const p of ['rel/a.md', 'rel\\a.md', 'C:rel', '~/a.md', '', './a']) expect(isAbsolutePath(p)).toBe(false)
  })

  it('gives the same name and folder as path.posix for POSIX paths', () => {
    for (const p of posixPaths) {
      expect([p, baseName(p)]).toEqual([p, path.posix.basename(p)])
      expect([p, path.posix.normalize(dirName(p))]).toEqual([p, path.posix.normalize(path.posix.dirname(p))])
    }
  })

  it('gives the same name and folder as path.win32 for Windows paths, whichever separator they use', () => {
    for (const p of windowsPaths) {
      expect([p, baseName(p)]).toEqual([p, path.win32.basename(p)])
      expect([p, path.win32.normalize(dirName(p))]).toEqual([p, path.win32.normalize(path.win32.dirname(p))])
    }
  })

  it('keeps the server and share of a UNC path together as its root', () => {
    expect(dirName('\\\\server\\share\\a.md')).toBe('\\\\server\\share\\')
    expect(dirName('\\\\server\\share\\')).toBe('\\\\server\\share\\')
    expect(baseName('\\\\server\\share\\')).toBe('')
  })

  it('returns the folder as the beginning of the path as written', () => {
    for (const p of [...posixPaths, ...windowsPaths]) {
      const folder = dirName(p)
      if (folder !== '.') expect([p, p.startsWith(folder)]).toEqual([p, true])
    }
  })

  it('trims the separators at the end but keeps a root whole', () => {
    expect(trimTrailingSeparator('/Users/me/repo//')).toBe('/Users/me/repo')
    expect(trimTrailingSeparator('C:\\Users\\me\\')).toBe('C:\\Users\\me')
    expect(trimTrailingSeparator('C:/Users/me/')).toBe('C:/Users/me')
    for (const root of ['/', 'C:\\', 'C:/', '\\\\server\\share\\']) expect(trimTrailingSeparator(root)).toBe(root)
  })

  it('takes a Windows path written with the other separator, letter case or a trailing separator for the same place', () => {
    expect(samePath('C:\\Users\\me\\asist', 'c:/users/me/asist/')).toBe(true)
    expect(samePath('\\\\server\\share\\Docs', '\\\\SERVER\\share\\docs\\')).toBe(true)
    expect(samePath('C:\\Users\\me\\asist', 'C:\\Users\\me\\asist-old')).toBe(false)
  })

  it('gives the part of a path below a folder, in either form, and nothing for a path outside it', () => {
    expect(pathInside('/jobs/j1', '/jobs/j1/notes/a.md')).toBe('notes/a.md')
    expect(pathInside('/jobs/j1/', '/jobs/j1')).toBe('')
    expect(pathInside('/', '/etc/hosts')).toBe('etc/hosts')
    expect(pathInside('/jobs/j1', '/jobs/j1-old/a.md')).toBeNull()
    expect(pathInside('/jobs/j1', '/jobs/J1/a.md')).toBeNull()
    expect(pathInside('C:\\jobs\\j1', 'c:/jobs/j1/notes\\a.md')).toBe('notes\\a.md')
    expect(pathInside('C:\\', 'C:\\jobs')).toBe('jobs')
    expect(pathInside('C:\\jobs\\j1', 'C:\\jobs\\j1-old')).toBeNull()
  })

  it('compares a POSIX path exactly apart from a trailing separator', () => {
    expect(samePath('/Users/me/asist', '/Users/me/asist/')).toBe(true)
    expect(samePath('/Users/me/asist', '/Users/me/Asist')).toBe(false)
  })
})
