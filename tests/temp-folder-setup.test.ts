import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import setup from './setup/temp-folder'

const TEMP_VARIABLE = process.platform === 'win32' ? 'TEMP' : 'TMPDIR'

describe('the temporary folder of a test run', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('removes the folder a killed run left, keeps the folder of a run still going, and removes its own and points back to the temporary folder when the run ends', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'parent-'))
    for (const name of ['TEMP', 'TMP', 'TMPDIR']) vi.stubEnv(name, parent)
    // No process has a pid this large; process.ppid is the Vitest running this test.
    const killed = path.join(parent, 'asist-test-2147483646-AbC123')
    const running = path.join(parent, `asist-test-${process.ppid}-XyZ789`)
    for (const folder of [killed, running]) fs.mkdirSync(path.join(folder, 'repo'), { recursive: true })

    const teardown = setup()
    const run = process.env[TEMP_VARIABLE]!
    expect(path.dirname(run)).toBe(parent)
    expect(os.tmpdir()).toBe(run)
    fs.mkdirSync(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'asist-git-')), 'repo'))
    teardown()

    expect(fs.readdirSync(parent)).toEqual([path.basename(running)])
    // A restart in watch mode sets up the next run in the same place.
    expect(os.tmpdir()).toBe(parent)
  })
})
