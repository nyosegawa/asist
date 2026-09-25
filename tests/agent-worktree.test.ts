import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { errorText } from '@shared/i18n/error-text'

const mocks = vi.hoisted(() => ({ root: '', launch: vi.fn() }))
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => path.join(mocks.root, 'data') } }))
vi.mock('../src/main/services/agent-process', () => ({ findCli: () => '/test/agent', launchAgentProcess: mocks.launch }))
vi.mock('../src/main/services/settings', () => ({
  getSettings: () => ({ agentEngine: 'codex', agentMode: 'readonly', agentCwd: mocks.root, uiLocale: 'ja-JP' })
}))
vi.mock('../src/main/services/project-index', () => ({ noteUsed: vi.fn(), recent: () => [] }))

let repo: string
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

beforeEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
  mocks.launch.mockReset()
  mocks.launch.mockImplementation((_job, _args, handlers) => {
    let resolve!: () => void
    const completion = new Promise<void>((done) => { resolve = done })
    const onExit = handlers.onExit
    handlers.onExit = (code: number | null) => { onExit(code); resolve() }
    return { completion, stop: vi.fn() }
  })
  mocks.root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'asist-worktree-test-')))
  repo = path.join(mocks.root, 'repo')
  fs.mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.name', 'ASIST test')
  git(repo, 'config', 'user.email', 'test@localhost')
  git(repo, 'config', 'commit.gpgsign', 'false')
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'initial')
})

afterEach(() => { fs.rmSync(mocks.root, { recursive: true, force: true }) })

it('commits uncommitted tracked and untracked output on restart and merges the diff that was shown', async () => {
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('修正する', { cwd: repo })
  fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'changed\n')
  fs.writeFileSync(path.join(job.cwd, 'untracked.txt'), 'new\n')
  vi.resetModules()
  const restored = await import('../src/main/services/agent')
  const review = restored.diff(job.id)
  expect(review.patch).toContain('+changed')
  expect(review.patch).toContain('+new')
  restored.merge(job.id, review.commit)
  expect(fs.readFileSync(path.join(repo, 'untracked.txt'), 'utf8')).toBe('new\n')
  expect(fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).toBe('changed\n')
  expect(fs.existsSync(job.cwd)).toBe(false)
})

it('refuses to merge and keeps the worktree when uncommitted changes appear after the diff was reviewed', async () => {
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('修正する', { cwd: repo })
  fs.writeFileSync(path.join(job.cwd, 'new.txt'), 'reviewed\n')
  mocks.launch.mock.calls[0][2].onExit(0)
  const review = agent.diff(job.id)
  fs.writeFileSync(path.join(job.cwd, 'late.txt'), 'not reviewed\n')
  expect(() => agent.merge(job.id, review.commit)).toThrow()
  expect(fs.existsSync(path.join(job.cwd, 'late.txt'))).toBe(true)
  expect(fs.existsSync(path.join(repo, 'new.txt'))).toBe(false)
})

it('keeps the worktree on a stop request and commits the output once the process closes', async () => {
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('修正する', { cwd: repo })
  agent.cancel(job.id)
  expect(fs.existsSync(job.cwd)).toBe(true)
  expect(() => agent.diff(job.id)).toThrow()
  fs.writeFileSync(path.join(job.cwd, 'after-signal.txt'), 'cleanup output\n')
  mocks.launch.mock.calls[0][2].onExit(0)
  expect(agent.get(job.id)?.status).toBe('cancelled')
  expect(agent.diff(job.id).patch).toContain('+cleanup output')
})

it('keeps output whose commit failed instead of offering it for merge, until the commit is retried', async () => {
  const agent = await import('../src/main/services/agent')
  const operations = await import('../src/main/services/git')
  const job = agent.startIsolated('修正する', { cwd: repo })
  fs.writeFileSync(path.join(job.cwd, 'new.txt'), 'preserved\n')
  vi.spyOn(operations, 'commitAll').mockImplementationOnce(() => { throw new Error('disk error') })
  mocks.launch.mock.calls[0][2].onExit(0)
  expect(agent.get(job.id)?.mergeState).toBe('error')
  expect(() => agent.merge(job.id, 'unconfirmed')).toThrow()
  expect(fs.readFileSync(path.join(job.cwd, 'new.txt'), 'utf8')).toBe('preserved\n')
  const review = agent.diff(job.id)
  expect(review.patch).toContain('+preserved')
  agent.merge(job.id, review.commit)
  expect(fs.readFileSync(path.join(repo, 'new.txt'), 'utf8')).toBe('preserved\n')
})

it('does not merge when the commit was replaced after the review', async () => {
  const agent = await import('../src/main/services/agent')
  const operations = await import('../src/main/services/git')
  const job = agent.startIsolated('修正する', { cwd: repo })
  fs.writeFileSync(path.join(job.cwd, 'new.txt'), 'reviewed\n')
  mocks.launch.mock.calls[0][2].onExit(0)
  const review = agent.diff(job.id)
  fs.writeFileSync(path.join(job.cwd, 'new.txt'), 'changed after review\n')
  operations.commitAll(job.cwd, 'changed')
  expect(() => agent.merge(job.id, review.commit)).toThrow(errorText('jobs.worktree.commitChanged'))
  expect(fs.existsSync(path.join(repo, 'new.txt'))).toBe(false)
  expect(fs.readFileSync(path.join(job.cwd, 'new.txt'), 'utf8')).toBe('changed after review\n')
})

it('rewrites artifact paths inside the worktree to the repository on merge and leaves paths outside it alone', async () => {
  const agent = await import('../src/main/services/agent')
  const job = agent.startIsolated('修正する', { cwd: repo })
  fs.mkdirSync(path.join(job.cwd, 'pages'))
  fs.writeFileSync(path.join(job.cwd, 'pages', 'note.md'), 'hello\n')
  const handlers = mocks.launch.mock.calls[0][2]
  handlers.onEvent({ kind: 'file-change', paths: [path.join(job.cwd, 'pages', 'note.md'), '/tmp/elsewhere/report.md'] })
  handlers.onExit(0)
  expect(agent.get(job.id)?.artifacts).toEqual([path.join(job.cwd, 'pages', 'note.md'), '/tmp/elsewhere/report.md'])
  agent.merge(job.id, agent.diff(job.id).commit)
  expect(agent.get(job.id)?.mergeState).toBe('merged')
  expect(agent.get(job.id)?.artifacts).toEqual([path.join(repo, 'pages', 'note.md'), '/tmp/elsewhere/report.md'])
  expect(fs.existsSync(path.join(repo, 'pages', 'note.md'))).toBe(true)
})

it('reports a failure to remove the worktree after a merge, and keeps both the merged state and the worktree', async () => {
  const agent = await import('../src/main/services/agent')
  const operations = await import('../src/main/services/git')
  const job = agent.startIsolated('修正する', { cwd: repo })
  fs.writeFileSync(path.join(job.cwd, 'new.txt'), 'merged\n')
  mocks.launch.mock.calls[0][2].onExit(0)
  const review = agent.diff(job.id)
  vi.spyOn(operations, 'worktreeRemove').mockImplementationOnce(() => { throw new Error('permission denied') })
  expect(() => agent.merge(job.id, review.commit)).toThrow(errorText('jobs.merging.removeFailed', { detail: 'permission denied' }))
  expect(agent.get(job.id)?.mergeState).toBe('merged')
  expect(fs.readFileSync(path.join(repo, 'new.txt'), 'utf8')).toBe('merged\n')
  expect(fs.existsSync(job.cwd)).toBe(true)
})

it('blocks worktree operations on the parent while a continuation runs, and refuses a second continuation', async () => {
  const agent = await import('../src/main/services/agent')
  const parent = agent.startIsolated('修正する', { cwd: repo })
  fs.writeFileSync(path.join(parent.cwd, 'parent.txt'), 'parent\n')
  const handlers = mocks.launch.mock.calls[0][2]
  handlers.onEvent({ kind: 'init', model: 'codex', sessionId: 'session' })
  handlers.onExit(0)
  const review = agent.diff(parent.id)
  const child = await agent.continueJob(parent.id, 'テストも足す')
  fs.writeFileSync(path.join(child.cwd, 'child.txt'), 'child\n')
  expect(() => agent.discard(parent.id)).toThrow()
  expect(() => agent.merge(parent.id, review.commit)).toThrow()
  await expect(agent.continueJob(parent.id, 'もう一つ')).rejects.toThrow()
  expect(fs.readFileSync(path.join(child.cwd, 'child.txt'), 'utf8')).toBe('child\n')
  mocks.launch.mock.calls[1][2].onExit(0)
  const childReview = agent.diff(child.id)
  agent.merge(child.id, childReview.commit)
  expect(fs.readFileSync(path.join(repo, 'parent.txt'), 'utf8')).toBe('parent\n')
  expect(fs.readFileSync(path.join(repo, 'child.txt'), 'utf8')).toBe('child\n')
})

it('hands the output of a conflicting worktree to the continuation', async () => {
  const agent = await import('../src/main/services/agent')
  const parent = agent.startIsolated('修正する', { cwd: repo })
  fs.writeFileSync(path.join(parent.cwd, 'tracked.txt'), 'agent changes\n')
  const handlers = mocks.launch.mock.calls[0][2]
  handlers.onEvent({ kind: 'init', model: 'codex', sessionId: 'session' })
  handlers.onExit(0)
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'user changes\n')
  git(repo, 'commit', '-qam', 'user edit')
  agent.merge(parent.id, agent.diff(parent.id).commit)
  expect(agent.get(parent.id)?.mergeState).toBe('conflict')
  const child = await agent.continueJob(parent.id, '衝突を解決する')
  expect(fs.readFileSync(path.join(child.cwd, 'tracked.txt'), 'utf8')).toBe('agent changes\n')
  expect(child.cwd).toBe(parent.cwd)
})

it('persists the transfer of ownership so parent and child do not both hold the worktree after a restart', async () => {
  const agent = await import('../src/main/services/agent')
  const parent = agent.startIsolated('修正する', { cwd: repo })
  fs.writeFileSync(path.join(parent.cwd, 'parent.txt'), 'parent\n')
  mocks.launch.mock.calls[0][2].onEvent({ kind: 'init', model: 'codex', sessionId: 'session' })
  mocks.launch.mock.calls[0][2].onExit(0)
  const child = await agent.continueJob(parent.id, 'テストも足す')
  fs.writeFileSync(path.join(child.cwd, 'child.txt'), 'child\n')
  vi.resetModules()
  const restored = await import('../src/main/services/agent')
  expect(restored.get(parent.id)?.worktree).toBeUndefined()
  expect(restored.diff(child.id).patch).toContain('+child')
  expect(() => restored.discard(parent.id)).toThrow()
  expect(fs.existsSync(child.cwd)).toBe(true)
})

it('returns ownership to the parent and starts no continuation process when the transfer cannot be saved', async () => {
  const agent = await import('../src/main/services/agent')
  const parent = agent.startIsolated('修正する', { cwd: repo })
  fs.writeFileSync(path.join(parent.cwd, 'parent.txt'), 'parent\n')
  mocks.launch.mock.calls[0][2].onEvent({ kind: 'init', model: 'codex', sessionId: 'session' })
  mocks.launch.mock.calls[0][2].onExit(0)
  vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk full') })
  await expect(agent.continueJob(parent.id, 'テストも足す')).rejects.toThrow('disk full')
  expect(mocks.launch).toHaveBeenCalledOnce()
  expect(agent.list()).toHaveLength(1)
  expect(agent.diff(parent.id).patch).toContain('+parent')
})
