import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { gitSourceOf, withFileDigest } from '../scripts/release.mjs'

const REPO = path.resolve(__dirname, '..')

describe('scripts/release.mjs', () => {
  it('offers the source of the same git that scripts/build-git.sh compiles', () => {
    const script = readFileSync(path.join(REPO, 'scripts/build-git.sh'), 'utf8')
    const version = /^version="(.+)"$/m.exec(script)![1]
    const sha256 = /^sha256="(.+)"$/m.exec(script)![1]
    expect(gitSourceOf(script)).toEqual({
      version,
      sha256,
      file: `git-${version}.tar.xz`,
      url: `https://www.kernel.org/pub/software/scm/git/git-${version}.tar.xz`
    })
  })

  it('rewrites the digest of the stapled dmg and leaves the zip that electron-updater installs as it is', () => {
    const yml = [
      'version: 0.1.0',
      'files:',
      '  - url: ASIST-0.1.0-arm64-mac.zip',
      '    sha512: zipDigest==',
      '    size: 316374268',
      '  - url: ASIST-0.1.0-arm64.dmg',
      '    sha512: dmgBefore==',
      '    size: 317852614',
      'path: ASIST-0.1.0-arm64-mac.zip',
      'sha512: zipDigest==',
      "releaseDate: '2026-09-25T06:12:56.053Z'",
      ''
    ].join('\n')
    expect(withFileDigest(yml, 'ASIST-0.1.0-arm64.dmg', 'dmgAfter==', 317860000)).toBe(
      yml.replace('dmgBefore==', 'dmgAfter==').replace('317852614', '317860000')
    )
  })

  it('refuses a feed that does not list the file', () => {
    expect(() => withFileDigest('version: 0.1.0\nfiles: []\n', 'ASIST-0.1.0-arm64.dmg', 'x', 1)).toThrow()
  })
})
