import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { errorText } from '@shared/i18n/error-text'
import { openStoredContent, storedContent, type StoredFormat } from '@shared/stored-format'
import { backupPath, openStoredFileSync } from '../src/main/services/stored-file'

/** A file whose first form was a bare list of names, then an object, then an object with a colour. */
interface Palette {
  names: string[]
  colour: string
}

const PALETTE: StoredFormat<Palette> = {
  name: 'palette.json',
  version: 3,
  upgrades: {
    1: (content) => ({ names: content }),
    2: (content) => ({ ...(content as object), colour: 'blue' })
  },
  parse: (content) => {
    const value = content as Partial<Palette>
    if (!Array.isArray(value.names) || typeof value.colour !== 'string') throw new Error('not a palette')
    return { names: value.names, colour: value.colour }
  },
  serialize: (value) => ({ names: value.names, colour: value.colour })
}

describe('opening the content of a versioned file', () => {
  it('reads a file without a version as version 1 and applies every upgrade in order', () => {
    expect(openStoredContent(PALETTE, ['a', 'b'])).toEqual({ value: { names: ['a', 'b'], colour: 'blue' }, storedVersion: 1 })
    expect(openStoredContent(PALETTE, { version: 2, names: ['c'] })).toEqual({ value: { names: ['c'], colour: 'blue' }, storedVersion: 2 })
  })

  it('reads the current version as it is and writes the version back in front of the content', () => {
    const opened = openStoredContent(PALETTE, { version: 3, names: ['d'], colour: 'red' })
    expect(opened).toEqual({ value: { names: ['d'], colour: 'red' }, storedVersion: 3 })
    expect(storedContent(PALETTE, opened.value)).toEqual({ version: 3, names: ['d'], colour: 'red' })
  })

  it('refuses a version newer than the app knows instead of dropping what it does not understand', () => {
    expect(() => openStoredContent(PALETTE, { version: 4, names: [], colour: 'red', shade: 'dark' })).toThrow(
      errorText('app.storage.versionTooNew', { file: 'palette.json', version: 4, supported: 3 })
    )
  })

  it('refuses a version it has no upgrade from, and a version that is not a positive whole number', () => {
    const withoutFirst: StoredFormat<Palette> = { ...PALETTE, upgrades: { 2: PALETTE.upgrades[2] } }
    expect(() => openStoredContent(withoutFirst, ['a'])).toThrow(errorText('app.storage.upgradeMissing', { file: 'palette.json', version: 1 }))
    expect(() => openStoredContent(PALETTE, { version: '3', names: [], colour: 'red' })).toThrow(
      errorText('app.storage.versionInvalid', { file: 'palette.json', version: '3' })
    )
  })
})

describe('opening a versioned file on disk', () => {
  let root = ''
  let file = ''
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'asist-stored-'))
    file = path.join(root, 'palette.json')
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('keeps the original beside the file, writes the upgraded content, and does not upgrade again', () => {
    const original = '["a","b"]\n'
    fs.writeFileSync(file, original)
    const read = (): Palette => openStoredFileSync(file, JSON.parse(fs.readFileSync(file, 'utf8')), PALETTE)
    expect(read()).toEqual({ names: ['a', 'b'], colour: 'blue' })
    expect(fs.readFileSync(backupPath(file, 1), 'utf8')).toBe(original)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 3, names: ['a', 'b'], colour: 'blue' })
    fs.rmSync(backupPath(file, 1))
    expect(read()).toEqual({ names: ['a', 'b'], colour: 'blue' })
    expect(fs.existsSync(backupPath(file, 1))).toBe(false)
  })

  it('leaves a file of a newer version untouched', () => {
    const newer = '{"version":9,"names":[],"colour":"red"}'
    fs.writeFileSync(file, newer)
    expect(() => openStoredFileSync(file, JSON.parse(newer), PALETTE)).toThrow()
    expect(fs.readFileSync(file, 'utf8')).toBe(newer)
    expect(fs.readdirSync(root)).toEqual(['palette.json'])
  })
})
