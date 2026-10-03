import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTranslator } from '@shared/i18n'
import { errorText } from '@shared/i18n/error-text'
import { git, makeTemplate, mergeThroughTool, startTest, type AgentWorktreeMocks } from './helpers/agent-worktree'
import { longTempFolder } from './helpers/temp'

const ja = createTranslator('ja-JP')

const mocks = vi.hoisted((): AgentWorktreeMocks => ({
  root: '', launch: vi.fn(), requestConfirm: vi.fn(), differentOwner: false, commands: null
}))
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => path.join(mocks.root, 'data') } }))
vi.mock('../src/main/services/agent-process', () => ({ launchAgentProcess: mocks.launch }))
vi.mock('../src/main/services/agent-process/cli-locator', () => ({ requireCli: () => '/test/agent' }))
vi.mock('../src/main/services/settings', () => ({
  getSettings: () => ({ agentEngine: 'codex', agentMode: 'readonly', agentCwd: mocks.root, fileRoots: [], uiLocale: 'ja-JP', conversationLocale: 'ja-JP' })
}))
// git's own switch for taking every repository for another user's, which a git that reads no safe.directory refuses to
// open, and the commands a test collects, each with its folder and the index it reads.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const execFileSync = ((file: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
    mocks.commands?.push([options.cwd, ...args, options.env?.GIT_INDEX_FILE ?? ''].join(' '))
    return actual.execFileSync(file, args, mocks.differentOwner ? { ...options, env: { ...options.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' } } : options)
  }) as typeof actual.execFileSync
  return { ...actual, default: { ...actual, execFileSync }, execFileSync }
})
vi.mock('../src/main/services/project-index', () => ({ noteUsed: vi.fn(), recent: () => [] }))
vi.mock('../src/main/services/confirm', () => ({ requestConfirm: mocks.requestConfirm }))
vi.mock('../src/main/services/memory', () => ({ search: vi.fn() }))

let repo: string
type Agent = typeof import('../src/main/services/agent')
/** A job that touched submodules waits with its worktree, and no merge of it changes the user's branch. */
const expectRefused = (agent: Agent, id: string, submodules: string[], head: string): void => {
  const job = agent.get(id)!
  expect(job.mergeState).toBe('pending')
  const review = agent.diff(id)
  expect(review.submodules).toEqual(submodules)
  expect(() => agent.merge(id, review)).toThrow(
    errorText('jobs.merging.submodules', { paths: submodules.join(', '), branch: job.worktree!.branch, dir: job.worktree!.dir })
  )
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(head)
  expect(fs.existsSync(job.worktree!.dir)).toBe(true)
}

/** The repository each test starts from, copied into the test's own folder. */
let template: string

// The first import of the service transforms its whole module graph, and the imports after vi.resetModules reuse
// that work: the first test took 5.5 s against a median of 3.1 s with the other test files beside it at a load
// average above 70 (Apple M5, 2026-10-02). Importing once here moves that cost into a hook with a timeout of its own.
beforeAll(async () => {
  template = makeTemplate()
  await import('../src/main/services/agent')
}, 30_000)

afterAll(() => { fs.rmSync(template, { recursive: true, force: true }) })

beforeEach(() => { repo = startTest(mocks, template) })

afterEach(() => { fs.rmSync(mocks.root, { recursive: true, force: true }) })

describe('a repository with a submodule', () => {
  /** The repository with the submodule added, and the submodule's repository beside it, made once and copied for each test. */
  let withSubmodule: string

  // Adding the submodule clones it: the four git processes took 455 ms of every test at a load average of 24
  // (Apple M5, 2026-10-02).
  beforeAll(() => {
    withSubmodule = longTempFolder('asist-worktree-submodule-')
    const sub = path.join(withSubmodule, 'sub')
    fs.mkdirSync(sub)
    git(sub, 'init', '-q', '-b', 'main')
    git(sub, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 's')
    const prepared = path.join(withSubmodule, 'repo')
    fs.cpSync(template, prepared, { recursive: true })
    git(prepared, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '../sub', 'vendor/sub')
    git(prepared, 'commit', '-qm', 'submodule')
  })

  afterAll(() => { fs.rmSync(withSubmodule, { recursive: true, force: true }) })

  beforeEach(() => {
    fs.rmSync(repo, { recursive: true, force: true })
    fs.cpSync(withSubmodule, mocks.root, { recursive: true })
    // The configuration of the repository and of the submodule's clone hold ../sub resolved to an absolute path,
    // which names the folder the copy was made in.
    const sub = path.join(mocks.root, 'sub')
    git(repo, 'config', 'submodule.vendor/sub.url', sub)
    git(path.join(repo, 'vendor', 'sub'), 'config', 'remote.origin.url', sub)
  })

  it('keeps the worktree of a job whose agent only initialized the submodule, since the commits of its repository may exist nowhere else', async () => {
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('ビルドが通るか確かめる', { cwd: repo })
    git(job.cwd, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init')
    fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'fixed\n')
    mocks.launch.mock.calls[0][2].onExit(0)
    expectRefused(agent, job.id, ['vendor/sub'], head)
  })

  it('does not tell that the branch holds the changes of a job that only initialized the submodule and committed nothing', async () => {
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('ビルドが通るか確かめる', { cwd: repo })
    git(job.cwd, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init')
    mocks.launch.mock.calls[0][2].onExit(0)
    expect(agent.diff(job.id).alreadyMerged).toBe(false)
    expectRefused(agent, job.id, ['vendor/sub'], head)
  })

  it('refuses to merge a job that touched the submodule once the user merged its branch, and keeps its worktree', async () => {
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('ビルドが通るか確かめる', { cwd: repo })
    git(job.cwd, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init')
    fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'fixed\n')
    mocks.launch.mock.calls[0][2].onExit(0)
    git(repo, 'merge', '-q', '--no-edit', agent.get(job.id)!.worktree!.branch)
    expect(agent.diff(job.id).alreadyMerged).toBe(true)
    expectRefused(agent, job.id, ['vendor/sub'], git(repo, 'rev-parse', 'HEAD'))
  })

  it('keeps the worktree of a job that committed inside the submodule and deinitialized it, whose repository outlasts the deinit', async () => {
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    git(job.cwd, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init')
    const inside = path.join(job.cwd, 'vendor', 'sub')
    const pinned = git(inside, 'rev-parse', 'HEAD')
    git(inside, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'agent work')
    const onlyCopy = git(inside, 'rev-parse', '--absolute-git-dir')
    git(inside, 'checkout', '-q', pinned)
    git(job.cwd, 'submodule', 'deinit', '-q', '-f', 'vendor/sub')
    fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'fixed\n')
    mocks.launch.mock.calls[0][2].onExit(0)
    expectRefused(agent, job.id, ['vendor/sub'], head)
    expect(fs.existsSync(onlyCopy)).toBe(true)
  })

  it('warns before discarding a job whose settling failed while its submodule holds a commit', async () => {
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    git(job.cwd, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init')
    const inside = path.join(job.cwd, 'vendor', 'sub')
    git(inside, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'agent work')
    // An empty repository nested in the worktree makes `git add -A` fail, so the job cannot settle.
    git(job.cwd, 'init', '-q', 'scratch')
    fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'fixed\n')
    mocks.launch.mock.calls[0][2].onExit(0)
    expect(agent.get(job.id)?.mergeState).toBe('error')
    expect(agent.discardPreview(job.id).submodules).toEqual(['vendor/sub'])
  })

  it('has nothing to warn about before discarding a job whose worktree folder is gone', async () => {
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    fs.writeFileSync(path.join(job.cwd, 'vendor', 'sub', 'patch.txt'), 'written by the agent\n')
    mocks.launch.mock.calls[0][2].onExit(0)
    expect(agent.discardPreview(job.id).submodules).toEqual(['vendor/sub'])
    fs.rmSync(job.cwd, { recursive: true, force: true })
    expect(agent.discardPreview(job.id).submodules).toEqual([])
    agent.discard(job.id)
    expect(agent.get(job.id)?.mergeState).toBe('discarded')
  })

  it('does not merge a job that wrote into the folder of a submodule that is not initialized, and keeps its worktree', async () => {
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    // In a new worktree the submodule is not initialized, and git does not look inside its empty folder.
    fs.writeFileSync(path.join(job.cwd, 'vendor', 'sub', 'patch.txt'), 'written by the agent\n')
    fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'fixed\n')
    mocks.launch.mock.calls[0][2].onExit(0)
    expectRefused(agent, job.id, ['vendor/sub'], head)
  })

  it('keeps the worktree of a job whose only change is a commit inside a submodule, which has no other copy, and does not merge it', async () => {
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    git(job.cwd, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init')
    const inside = path.join(job.cwd, 'vendor', 'sub')
    fs.writeFileSync(path.join(inside, 'fix.txt'), 'fixed by the agent\n')
    git(inside, 'add', 'fix.txt')
    git(inside, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fix')
    const onlyCopy = git(inside, 'rev-parse', '--absolute-git-dir')
    mocks.launch.mock.calls[0][2].onExit(0)
    expectRefused(agent, job.id, ['vendor/sub'], head)
    expect(fs.existsSync(onlyCopy)).toBe(true)
    expect(agent.discardPreview(job.id).submodules).toEqual(['vendor/sub'])
  })

  it('tells in the log of a job that touched a submodule only that the user merges or discards it, not that it waits to be merged', async () => {
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    fs.writeFileSync(path.join(job.cwd, 'vendor', 'sub', 'patch.txt'), 'written by the agent\n')
    mocks.launch.mock.calls[0][2].onExit(0)
    const { branch, dir } = agent.get(job.id)!.worktree!
    const texts = agent.getLog(job.id).map((line) => ('text' in line.event ? line.event.text : ''))
    expect(texts).toContain(ja('jobs.merging.submodules', { paths: 'vendor/sub', branch, dir }))
    expect(texts).not.toContain(ja('jobs.worktree.committed'))
  })

  it('keeps a submodule bump the user made on main when the agent merged main into its branch, and shows only the agent\'s change', async () => {
    const sub = path.join(mocks.root, 'sub')
    git(sub, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'v2')
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    // The user moves the submodule on main while the job runs.
    git(path.join(repo, 'vendor', 'sub'), '-c', 'protocol.file.allow=always', 'pull', '-q', 'origin', 'main')
    git(repo, 'add', 'vendor/sub')
    git(repo, 'commit', '-qm', 'bump the submodule')
    const bumped = git(repo, 'rev-parse', 'HEAD:vendor/sub')
    // The agent brings main into its branch, as a job resolving a conflict does.
    fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'fixed\n')
    git(job.cwd, 'commit', '-qam', 'agent work')
    git(job.cwd, 'merge', '-q', '--no-edit', 'main')
    mocks.launch.mock.calls[0][2].onExit(0)
    const review = agent.diff(job.id)
    expect(review.patch).not.toContain('Subproject commit')
    expect(review.stat).toContain('tracked.txt')
    expect(review.submodules).toEqual([])
    agent.merge(job.id, review)
    expect(git(repo, 'rev-parse', 'HEAD:vendor/sub')).toBe(bumped)
    expect(fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).toBe('fixed\n')
  })

  it('keeps a submodule the user added on main when the agent rebased its branch onto main', async () => {
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', path.join(mocks.root, 'sub'), 'vendor/added')
    git(repo, 'commit', '-qm', 'add a submodule')
    const gitmodules = fs.readFileSync(path.join(repo, '.gitmodules'), 'utf8')
    fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'fixed\n')
    git(job.cwd, 'commit', '-qam', 'agent work')
    git(job.cwd, 'rebase', '-q', 'main')
    mocks.launch.mock.calls[0][2].onExit(0)
    const review = agent.diff(job.id)
    expect(review.stat).not.toContain('.gitmodules')
    expect(review.submodules).toEqual([])
    agent.merge(job.id, review)
    expect(fs.readFileSync(path.join(repo, '.gitmodules'), 'utf8')).toBe(gitmodules)
    expect(git(repo, 'ls-tree', '--name-only', 'HEAD', 'vendor/added')).toBe('vendor/added')
    expect(fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).toBe('fixed\n')
  })

  it('shows a review as blocked by work that appeared in a submodule of the worktree after the job settled, as the merge refuses it', async () => {
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'fixed\n')
    mocks.launch.mock.calls[0][2].onExit(0)
    expect(agent.diff(job.id).blocked).toBeNull()
    fs.writeFileSync(path.join(job.cwd, 'vendor', 'sub', 'patch.txt'), 'written after the job settled\n')
    expect(agent.diff(job.id).blocked).toBe(
      errorText('jobs.merging.submodules', { paths: 'vendor/sub', branch: job.worktree!.branch, dir: job.worktree!.dir })
    )
    await expect(mergeThroughTool(job.id, agent.diff(job.id).commit)).rejects.toThrow(ja('jobs.merging.submodules', { paths: 'vendor/sub', branch: job.worktree!.branch, dir: job.worktree!.dir }))
    expect(mocks.requestConfirm).not.toHaveBeenCalled()
    expectRefused(agent, job.id, ['vendor/sub'], head)
  })

  it.each(['all', 'dirty', 'untracked'])('does not merge a job that changed a submodule whose ignore setting is %s, and keeps its worktree', async (mode) => {
    const lib = path.join(mocks.root, 'lib')
    fs.mkdirSync(lib)
    git(lib, 'init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(lib, 'lib.txt'), 'lib\n')
    git(lib, 'add', '.')
    git(lib, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'lib')
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'vendor/lib')
    git(repo, 'config', '-f', '.gitmodules', 'submodule.vendor/lib.ignore', mode)
    git(repo, 'add', '.gitmodules')
    git(repo, 'commit', '-qm', 'a submodule whose changes git is told to ignore')
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    git(job.cwd, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init', 'vendor/lib')
    const inside = path.join(job.cwd, 'vendor', 'lib')
    if (mode === 'all') {
      fs.writeFileSync(path.join(inside, 'lib.txt'), 'fixed by the agent\n')
      git(inside, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'fix')
    } else if (mode === 'dirty') {
      fs.writeFileSync(path.join(inside, 'lib.txt'), 'edited, not committed\n')
    } else {
      fs.writeFileSync(path.join(inside, 'new.txt'), 'a new file\n')
    }
    mocks.launch.mock.calls[0][2].onExit(0)
    expectRefused(agent, job.id, ['vendor/lib'], head)
  })

  it('does not merge a job that changed a submodule while diff.ignoreSubmodules hides such changes, and keeps its worktree', async () => {
    git(repo, 'config', 'diff.ignoreSubmodules', 'all')
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    git(job.cwd, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init')
    fs.writeFileSync(path.join(job.cwd, 'vendor', 'sub', 'new.txt'), 'a new file\n')
    mocks.launch.mock.calls[0][2].onExit(0)
    expectRefused(agent, job.id, ['vendor/sub'], head)
  })

  it('does not merge a job that took in another branch which moved a submodule, and leaves the user\'s branch as it was', async () => {
    const sub = path.join(mocks.root, 'sub')
    git(sub, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'v2')
    const v2 = git(sub, 'rev-parse', 'HEAD')
    // A branch the user has not merged, such as an upstream one, moves the submodule.
    git(repo, 'checkout', '-q', '-b', 'upstream')
    git(repo, 'update-index', '--cacheinfo', `160000,${v2},vendor/sub`)
    fs.writeFileSync(path.join(repo, 'up.txt'), 'upstream\n')
    git(repo, 'add', 'up.txt')
    git(repo, 'commit', '-qm', 'upstream moves the submodule')
    git(repo, 'checkout', '-q', 'main')
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'fixed\n')
    git(job.cwd, 'commit', '-qam', 'agent work')
    git(job.cwd, 'merge', '-q', '--no-edit', 'upstream')
    mocks.launch.mock.calls[0][2].onExit(0)
    expectRefused(agent, job.id, ['vendor/sub'], head)
  })

  it('does not merge a job that settled while a branch was checked out against which a submodule moved, even back on the first branch', async () => {
    git(repo, 'branch', 'release')
    const sub = path.join(mocks.root, 'sub')
    git(sub, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'v2')
    git(path.join(repo, 'vendor', 'sub'), '-c', 'protocol.file.allow=always', 'pull', '-q', 'origin', 'main')
    git(repo, 'add', 'vendor/sub')
    git(repo, 'commit', '-qm', 'bump the submodule')
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'fixed\n')
    git(job.cwd, 'commit', '-qam', 'agent work')
    git(repo, 'checkout', '-q', 'release')
    mocks.launch.mock.calls[0][2].onExit(0)
    git(repo, 'checkout', '-q', 'main')
    expectRefused(agent, job.id, ['vendor/sub'], head)
  })

  it('settles again a job that version 3 of the history kept as waiting to be merged, so that work only its worktree holds is not deleted by a merge', async () => {
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    fs.writeFileSync(path.join(job.cwd, 'vendor', 'sub', 'patch.txt'), 'written by the agent\n')
    fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'fixed\n')
    // What the code of version 3 did when the job ended: commit what git shows, and wait for the merge.
    git(job.cwd, 'add', '-A')
    git(job.cwd, 'commit', '-qm', 'asist: 直す')
    const file = path.join(mocks.root, 'data', 'jobs.json')
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as { jobs: Array<Record<string, unknown>> }
    const saved = stored.jobs.find((entry) => entry.id === job.id)!
    Object.assign(saved, { status: 'done', endedAt: Date.now(), mergeState: 'pending' })
    saved.worktree = { ...(saved.worktree as object), commit: git(job.cwd, 'rev-parse', 'HEAD') }
    fs.writeFileSync(file, JSON.stringify({ ...stored, version: 3 }))
    vi.resetModules()
    const restored = await import('../src/main/services/agent')
    expectRefused(restored, job.id, ['vendor/sub'], head)
  })

  it.each(['gitmodules', 'config'])('keeps the worktree of a job that only moved a submodule while an ignore setting in %s hides it from git diff', async (where) => {
    fs.writeFileSync(path.join(mocks.root, 'sub', 'lib.txt'), 'lib\n')
    git(path.join(mocks.root, 'sub'), 'add', '.')
    git(path.join(mocks.root, 'sub'), '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'lib')
    git(path.join(repo, 'vendor', 'sub'), '-c', 'protocol.file.allow=always', 'pull', '-q', 'origin', 'main')
    git(repo, 'add', 'vendor/sub')
    git(repo, 'commit', '-qm', 'the submodule with a file')
    if (where === 'gitmodules') {
      git(repo, 'config', '-f', '.gitmodules', 'submodule.vendor/sub.ignore', 'all')
      git(repo, 'add', '.gitmodules')
      git(repo, 'commit', '-qm', 'ignore the submodule')
    } else {
      git(repo, 'config', 'diff.ignoreSubmodules', 'all')
    }
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    git(job.cwd, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init')
    const inside = path.join(job.cwd, 'vendor', 'sub')
    fs.writeFileSync(path.join(inside, 'lib.txt'), 'fixed by the agent\n')
    git(inside, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'fix')
    git(job.cwd, 'add', '-f', 'vendor/sub')
    git(job.cwd, 'commit', '-qm', 'move the submodule')
    mocks.launch.mock.calls[0][2].onExit(0)
    expectRefused(agent, job.id, ['vendor/sub'], head)
  })

  it('does not merge a job that moved a submodule beside another change while diff.ignoreSubmodules hides the move', async () => {
    git(repo, 'config', 'diff.ignoreSubmodules', 'all')
    const sub = path.join(mocks.root, 'sub')
    git(sub, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'v2')
    const v2 = git(sub, 'rev-parse', 'HEAD')
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    git(job.cwd, 'update-index', '--cacheinfo', `160000,${v2},vendor/sub`)
    fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'fixed\n')
    git(job.cwd, 'commit', '-qam', 'move the submodule and fix')
    mocks.launch.mock.calls[0][2].onExit(0)
    expectRefused(agent, job.id, ['vendor/sub'], head)
    expect(git(repo, 'rev-parse', 'HEAD:vendor/sub')).not.toBe(v2)
  })

  it('does not merge a job that took in a branch which moved a submodule whose ignore setting in .gitmodules is all', async () => {
    git(repo, 'config', '-f', '.gitmodules', 'submodule.vendor/sub.ignore', 'all')
    git(repo, 'add', '.gitmodules')
    git(repo, 'commit', '-qm', 'ignore the submodule')
    const sub = path.join(mocks.root, 'sub')
    git(sub, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'v2')
    const v2 = git(sub, 'rev-parse', 'HEAD')
    git(repo, 'checkout', '-q', '-b', 'upstream')
    git(repo, 'update-index', '--cacheinfo', `160000,${v2},vendor/sub`)
    fs.writeFileSync(path.join(repo, 'up.txt'), 'upstream\n')
    git(repo, 'add', 'up.txt')
    git(repo, 'commit', '-qm', 'upstream moves the submodule')
    git(repo, 'checkout', '-q', 'main')
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'fixed\n')
    git(job.cwd, 'commit', '-qam', 'agent work')
    git(job.cwd, 'merge', '-q', '--no-edit', 'upstream')
    mocks.launch.mock.calls[0][2].onExit(0)
    expectRefused(agent, job.id, ['vendor/sub'], head)
  })

  it.each(['side branch', 'stash'])('keeps the worktree of a job whose submodule holds work its remote lacks on a %s, with the pinned commit checked out again', async (kind) => {
    fs.writeFileSync(path.join(mocks.root, 'sub', 'lib.txt'), 'lib\n')
    git(path.join(mocks.root, 'sub'), 'add', '.')
    git(path.join(mocks.root, 'sub'), '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'lib')
    git(path.join(repo, 'vendor', 'sub'), '-c', 'protocol.file.allow=always', 'pull', '-q', 'origin', 'main')
    git(repo, 'add', 'vendor/sub')
    git(repo, 'commit', '-qm', 'the submodule with a file')
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    git(job.cwd, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init')
    const inside = path.join(job.cwd, 'vendor', 'sub')
    fs.writeFileSync(path.join(inside, 'lib.txt'), 'fixed by the agent\n')
    if (kind === 'side branch') {
      git(inside, 'checkout', '-q', '-b', 'feature')
      git(inside, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'fix')
      git(inside, 'checkout', '-q', '-')
    } else {
      git(inside, '-c', 'user.name=t', '-c', 'user.email=t@t', 'stash', '-q')
    }
    mocks.launch.mock.calls[0][2].onExit(0)
    expect(agent.get(job.id)?.mergeState).toBe('pending')
    expect(agent.get(job.id)?.worktree?.submodules).toEqual(['vendor/sub'])
    expect(fs.existsSync(inside)).toBe(true)
  })

  it('keeps the worktree of a job from version 3 whose branch the user merged by hand, since the commit its submodule points to is only there', async () => {
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    git(job.cwd, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init')
    const inside = path.join(job.cwd, 'vendor', 'sub')
    fs.writeFileSync(path.join(inside, 'fix.txt'), 'fixed by the agent\n')
    git(inside, 'add', 'fix.txt')
    git(inside, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fix')
    const fix = git(inside, 'rev-parse', 'HEAD')
    git(job.cwd, 'add', '-A')
    git(job.cwd, 'commit', '-qm', 'asist: 直す')
    const file = path.join(mocks.root, 'data', 'jobs.json')
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as { jobs: Array<Record<string, unknown>> }
    const saved = stored.jobs.find((entry) => entry.id === job.id)!
    Object.assign(saved, { status: 'done', endedAt: Date.now(), mergeState: 'pending' })
    saved.worktree = { ...(saved.worktree as object), commit: git(job.cwd, 'rev-parse', 'HEAD') }
    fs.writeFileSync(file, JSON.stringify({ ...stored, version: 3 }))
    const branch = (saved.worktree as { branch: string }).branch
    git(repo, 'merge', '-q', '--no-edit', branch)
    vi.resetModules()
    const restored = await import('../src/main/services/agent')
    expect(restored.get(job.id)?.mergeState).toBe('pending')
    expect(git(inside, 'cat-file', '-t', fix)).toBe('commit')
  })

  it.each([false, true])('keeps the worktree of a job that wrote into the folder of a repository its index holds but .gitmodules does not name, beside another change: %s', async (beside) => {
    git(repo, '-c', 'protocol.file.allow=always', 'clone', '-q', path.join(mocks.root, 'sub'), 'tools/dep')
    git(repo, 'add', 'tools/dep')
    git(repo, 'commit', '-qm', 'a repository added without git submodule add')
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    fs.writeFileSync(path.join(job.cwd, 'tools', 'dep', 'patch.txt'), 'written by the agent\n')
    if (beside) fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'fixed\n')
    mocks.launch.mock.calls[0][2].onExit(0)
    expectRefused(agent, job.id, ['tools/dep'], head)
    expect(fs.existsSync(path.join(job.cwd, 'tools', 'dep', 'patch.txt'))).toBe(true)
  })

  it('refuses a merge whose worktree came to hold submodule work after the job settled, since the merge removes the worktree', async () => {
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = await import('../src/main/services/agent')
    const job = agent.startIsolated('直す', { cwd: repo })
    fs.writeFileSync(path.join(job.cwd, 'tracked.txt'), 'fixed\n')
    mocks.launch.mock.calls[0][2].onExit(0)
    const review = agent.diff(job.id)
    expect(review.submodules).toEqual([])
    git(job.cwd, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init')
    const inside = path.join(job.cwd, 'vendor', 'sub')
    git(inside, 'checkout', '-q', '-b', 'later')
    git(inside, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'later work')
    git(inside, 'checkout', '-q', '-')
    const { branch, dir } = agent.get(job.id)!.worktree!
    expect(() => agent.merge(job.id, review)).toThrow(errorText('jobs.merging.submodules', { paths: 'vendor/sub', branch, dir }))
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head)
    expect(fs.existsSync(inside)).toBe(true)
  })
})
