import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentJob } from '@shared/ipc'
import { errorText } from '@shared/i18n/error-text'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jobLogFile, readJobHistory, writeJobHistory } from '../src/main/services/job-history'

const locations = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({ app: { getPath: () => locations.root, getPreferredSystemLanguages: () => ['ja-JP'] } }))

beforeEach(() => {
  locations.root = fs.mkdtempSync(path.join(os.tmpdir(), 'asist-job-history-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(locations.root, { recursive: true, force: true })
})

function job(id: string, startedAt: number, patch: Partial<AgentJob> = {}): AgentJob {
  return { id, startedAt, title: id, prompt: id, cwd: path.join(locations.root, id), readonly: true, engine: 'codex', status: 'done', ...patch }
}

const completed = (): AgentJob[] => Array.from({ length: 51 }, (_, index) => job(`done-${index}`, index + 100))

describe('job history retention', () => {
  it('keeps every running job and unprocessed worktree, and trims only the finished ones to the latest fifty', () => {
    const protectedJobs = [
      job('running', 1, { status: 'running' }),
      job('stopping', 2, { status: 'stopping' }),
      job('curation-index-pending', 3, {
        mergeState: 'merged', memoryCuration: { through: '2026-09-11', applied: false }
      }),
      ...(['pending', 'conflict', 'error', undefined] as const).map((mergeState, index) =>
        job(`worktree-${index}`, index + 4, { mergeState, worktree: { repo: '/repo', branch: 'branch', base: 'base' } })
      )
    ]
    fs.mkdirSync(path.join(locations.root, 'joblogs'))
    for (const saved of [...protectedJobs, ...completed()]) {
      fs.writeFileSync(path.join(locations.root, jobLogFile(saved.id)), `${saved.id}\n`)
    }

    expect(writeJobHistory([...protectedJobs, ...completed()])).toEqual(['done-0'])
    const stored = readJobHistory()
    expect(stored).toHaveLength(50 + protectedJobs.length)
    for (const saved of protectedJobs) {
      expect(stored.find((entry) => entry.id === saved.id)).toEqual(saved)
      expect(fs.readFileSync(path.join(locations.root, jobLogFile(saved.id)), 'utf8')).toBe(`${saved.id}\n`)
    }
    expect(fs.existsSync(path.join(locations.root, jobLogFile('done-0')))).toBe(false)
    expect(fs.existsSync(path.join(locations.root, jobLogFile('done-1')))).toBe(true)
  })

  it('keeps a finished worktree job until its directory is confirmed to be gone', () => {
    const worktrees = (['merged', 'discarded', 'unchanged'] as const).flatMap((mergeState, index) => [
      job(`${mergeState}-present`, index, { mergeState, worktree: { repo: '/repo', branch: 'branch', base: 'base' } }),
      job(`${mergeState}-removed`, index, { mergeState, worktree: { repo: '/repo', branch: 'branch', base: 'base' } })
    ])
    for (const saved of worktrees.filter((entry) => entry.id.endsWith('-present'))) fs.mkdirSync(saved.cwd)
    const removed = writeJobHistory([...worktrees, ...completed()])
    for (const saved of worktrees) {
      expect(removed.includes(saved.id)).toBe(saved.id.endsWith('-removed'))
    }
  })

  it('keeps the result of a job that just finished even when it started long ago', () => {
    const recent = job('long-running', 0, { endedAt: 200 })
    writeJobHistory([...completed(), recent])
    expect(readJobHistory().some((saved) => saved.id === recent.id)).toBe(true)
    expect(readJobHistory()).toHaveLength(50)
  })

  it('leaves the stored history and the logs in place when the write fails', () => {
    const file = path.join(locations.root, 'jobs.json')
    const source = JSON.stringify([job('before', 0)])
    fs.writeFileSync(file, source)
    const log = path.join(locations.root, jobLogFile('done-0'))
    fs.mkdirSync(path.dirname(log))
    fs.writeFileSync(log, 'retained log')
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk full') })

    expect(() => writeJobHistory(completed())).toThrow('disk full')
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
    expect(fs.readFileSync(log, 'utf8')).toBe('retained log')
  })

  it('does not treat a failure to delete a log as a failure to save the history', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(fs, 'rmSync').mockImplementationOnce(() => { throw new Error('permission denied') })
    expect(writeJobHistory(completed())).toEqual(['done-0'])
    expect(readJobHistory().map((entry) => entry.id)).not.toContain('done-0')
    expect(error).toHaveBeenCalledWith(expect.stringContaining(jobLogFile('done-0')), expect.any(Error))
  })
})

describe('job history reads', () => {
  it('reads an empty history only when the file is missing, and throws on any other read error', () => {
    expect(readJobHistory()).toEqual([])
    vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }) })
    expect(() => readJobHistory()).toThrow(
      errorText('jobs.history.unreadable', { file: path.join(locations.root, 'jobs.json'), detail: 'permission denied' })
    )
  })

  it.each([
    () => '{broken',
    () => JSON.stringify({ jobs: [] }),
    () => JSON.stringify([job('invalid', 1, { status: 'unknown' as never })]),
    () => JSON.stringify([job('same', 1), job('same', 2)])
  ])('throws instead of reading an empty history for broken JSON, a wrong shape, or a duplicate id', (sourceFor) => {
    const file = path.join(locations.root, 'jobs.json')
    const source = sourceFor()
    fs.writeFileSync(file, source)
    expect(() => readJobHistory()).toThrow(file)
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })
})
