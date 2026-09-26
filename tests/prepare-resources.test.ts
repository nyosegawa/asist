import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error The build script is plain JavaScript without type declarations.
import { stepsFor } from '../scripts/resources/targets.mjs'
// @ts-expect-error The build script is plain JavaScript without type declarations.
import { UNUSED, matchesUnused, unusedFiles } from '../scripts/resources/git-windows.mjs'
// @ts-expect-error The build script is plain JavaScript without type declarations.
import { stampCurrent, writeStamp } from '../scripts/resources/shared.mjs'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(tmpdir(), 'asist-prepare-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('choosing what to prepare', () => {
  it('stops on a platform the app is not built for instead of preparing nothing', () => {
    for (const [platform, arch] of [['linux', 'x64'], ['darwin', 'x64'], ['win32', 'arm64']]) {
      expect(() => stepsFor('test', platform, arch)).toThrow(`${platform} ${arch}`)
    }
  })

  it('stops on a purpose it does not know', () => {
    expect(() => stepsFor('release', 'darwin', 'arm64')).toThrow(/release/)
  })
})

describe('the parts of MinGit that are removed', () => {
  it('removes the files of a listed folder and of a pattern, and keeps everything else', () => {
    const files = ['mingw64/doc/gcm/README.md', 'mingw64/doc/gcm/LICENSE', 'mingw64/bin/Avalonia.Base.dll', 'mingw64/bin/zlib1.dll', 'mingw64/docs.txt']
    expect(unusedFiles(files, ['mingw64/doc', /^mingw64\/bin\/Avalonia(\..+)?\.dll$/])).toEqual([
      'mingw64/bin/Avalonia.Base.dll',
      'mingw64/doc/gcm/LICENSE',
      'mingw64/doc/gcm/README.md'
    ])
  })

  it('stops when a listed part is missing, so a new MinGit is reviewed before it ships', () => {
    expect(() => unusedFiles(['mingw64/bin/git.exe'], ['mingw64/bin/scalar.exe'])).toThrow('mingw64/bin/scalar.exe')
  })

  it('never removes git, the sh its scripts and hooks run in, the scripts, the libraries git loads or a license', () => {
    const needed = [
      'mingw64/bin/git.exe',
      'mingw64/bin/git-upload-pack.exe',
      'mingw64/bin/git-receive-pack.exe',
      'mingw64/bin/zlib1.dll',
      'mingw64/bin/libiconv-2.dll',
      'mingw64/bin/libintl-8.dll',
      'mingw64/bin/libpcre2-8-0.dll',
      'mingw64/libexec/git-core/git-submodule',
      'mingw64/libexec/git-core/git-sh-setup',
      'mingw64/share/git-core/templates/description',
      'usr/bin/sh.exe',
      'usr/bin/msys-2.0.dll',
      'usr/bin/sed.exe',
      'LICENSE.txt',
      'mingw64/share/licenses/zlib/LICENSE',
      'usr/share/licenses/openssh/LICENCE'
    ]
    for (const file of needed) expect(UNUSED.filter((entry: string | RegExp) => matchesUnused(entry, file)), file).toEqual([])
  })
})

describe('the version stamp of a prepared tool', () => {
  it('is current only for the same version, written after the module that prepares the tool last changed', () => {
    const module = path.join(dir, 'tool.mjs')
    const stamp = path.join(dir, 'VERSION')
    fs.writeFileSync(module, '')
    writeStamp(stamp, '1.2.3')
    fs.utimesSync(module, new Date(1_000_000), new Date(1_000_000))
    fs.utimesSync(stamp, new Date(2_000_000), new Date(2_000_000))
    expect(stampCurrent(stamp, '1.2.3', module)).toBe(true)
    expect(stampCurrent(stamp, '1.2.4', module)).toBe(false)

    fs.utimesSync(module, new Date(3_000_000), new Date(3_000_000))
    expect(stampCurrent(stamp, '1.2.3', module)).toBe(false)
    expect(stampCurrent(path.join(dir, 'missing'), '1.2.3', module)).toBe(false)
  })
})
