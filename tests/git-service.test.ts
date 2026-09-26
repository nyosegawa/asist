import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ conversationLocale: 'ja-JP' }) }))

import * as git from '../src/main/services/git'

let root = ''
let repo = ''

const run = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'asist-git-'))
  repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  run(repo, ['init', '-q', '-b', 'main'])
  run(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'])
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n')
  run(repo, ['add', 'a.txt'])
  run(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'a'])
})

describe('git service with an isolated worktree', () => {
  it('returns the repository top inside a repository and null outside one', () => {
    fs.mkdirSync(path.join(repo, 'sub'))
    expect(fs.realpathSync(git.toplevel(path.join(repo, 'sub'))!)).toBe(fs.realpathSync(repo))
    expect(git.toplevel(root)).toBeNull()
  })

  it('commits changes in the worktree, shows the diff, and on merge lands them on the user branch and drops the worktree', () => {
    const base = git.headCommit(repo)
    const wt = path.join(root, 'asist-jobs', '20260908-job')
    fs.mkdirSync(path.dirname(wt), { recursive: true })
    git.worktreeAdd(repo, wt, 'asist/20260908-job')
    fs.writeFileSync(path.join(wt, 'a.txt'), 'hello\nworld\n')
    fs.writeFileSync(path.join(wt, 'b.txt'), 'new\n')
    // The user's own working tree is untouched by the work in the worktree.
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('hello\n')
    expect(git.commitAll(wt, 'asist: job')).toBe(true)
    expect(git.commitAll(wt, 'asist: job')).toBe(false)
    const stat = git.diffStat(repo, base, 'asist/20260908-job')
    expect(stat).toContain('a.txt')
    expect(stat).toContain('b.txt')
    expect(git.diffPatch(repo, base, 'asist/20260908-job')).toContain('+world')
    expect(git.isClean(repo)).toBe(true)
    expect(git.mergeNoFf(repo, 'asist/20260908-job', 'asist: job')).toEqual({ ok: true })
    expect(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8')).toBe('new\n')
    git.worktreeRemove(repo, wt, 'asist/20260908-job')
    expect(fs.existsSync(wt)).toBe(false)
    expect(run(repo, ['branch', '--list', 'asist/*'])).toBe('')
  })

  it('reports a conflict and leaves the working tree as it was', () => {
    const wt = path.join(root, 'wt')
    git.worktreeAdd(repo, wt, 'asist/conflict')
    fs.writeFileSync(path.join(wt, 'a.txt'), 'from job\n')
    git.commitAll(wt, 'job')
    fs.writeFileSync(path.join(repo, 'a.txt'), 'from user\n')
    run(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-am', 'user'])
    const outcome = git.mergeNoFf(repo, 'asist/conflict', 'merge')
    expect(outcome).toMatchObject({ ok: false, conflict: true })
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('from user\n')
    expect(git.isClean(repo)).toBe(true)
    git.worktreeRemove(repo, wt, 'asist/conflict')
  })

  it('makes the merge commit without running the hooks of the user that can stop a merge half done', () => {
    const before = git.headCommit(repo)
    const wt = path.join(root, 'wt')
    git.worktreeAdd(repo, wt, 'asist/hooked')
    fs.writeFileSync(path.join(wt, 'b.txt'), 'from job\n')
    git.commitAll(wt, 'job')
    // A commitlint hook rejects the "asist: ..." message, and a hook that calls npx fails on the PATH of an
    // app opened from Finder. git merge would stop with MERGE_HEAD set and the job's changes staged.
    for (const hook of ['pre-merge-commit', 'prepare-commit-msg', 'commit-msg']) {
      fs.writeFileSync(path.join(repo, '.git', 'hooks', hook), '#!/bin/sh\necho rejected >&2\nexit 1\n', { mode: 0o755 })
    }
    expect(git.mergeNoFf(repo, 'asist/hooked', 'asist: job (1)')).toEqual({ ok: true })
    expect(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8')).toBe('from job\n')
    expect(git.isClean(repo)).toBe(true)
    expect(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(run(repo, ['log', '-1', '--format=%P%n%s']).split('\n')).toEqual([`${before} ${git.headCommit(wt)}`, 'asist: job (1)'])
  })

  it('cuts a diff larger than the output buffer of git at the limit instead of failing', () => {
    const base = git.headCommit(repo)
    const wt = path.join(root, 'wt')
    git.worktreeAdd(repo, wt, 'asist/lockfile')
    // A regenerated lockfile of 5 MB, more than the 4 MB that git's output is otherwise read into.
    fs.writeFileSync(path.join(wt, 'package-lock.json'), `${'x'.repeat(99)}\n`.repeat(50_000))
    git.commitAll(wt, 'job')
    const patch = git.diffPatch(repo, base, 'asist/lockfile')
    expect(patch.startsWith('diff --git a/package-lock.json')).toBe(true)
    expect(patch.length).toBeLessThan(61_000)
  })

  it('removes the worktree and the branch again when git fails after creating them in a post-checkout hook', () => {
    // The hook Git LFS installs exits 2 when an app opened from Finder has no git-lfs on its PATH.
    fs.writeFileSync(path.join(repo, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\nexit 2\n', { mode: 0o755 })
    const wt = path.join(root, 'wt')
    expect(() => git.worktreeAdd(repo, wt, 'asist/lfs')).toThrow()
    expect(fs.existsSync(wt)).toBe(false)
    expect(run(repo, ['worktree', 'list', '--porcelain'])).not.toContain('asist/lfs')
    expect(run(repo, ['branch', '--list', 'asist/*'])).toBe('')
  })

  it('removes a worktree in which a submodule was initialized', () => {
    const sub = path.join(root, 'sub')
    fs.mkdirSync(sub)
    run(sub, ['init', '-q', '-b', 'main'])
    run(sub, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 's'])
    run(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub'])
    run(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'sub'])
    const wt = path.join(root, 'wt')
    git.worktreeAdd(repo, wt, 'asist/sub')
    run(wt, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init'])
    git.worktreeRemove(repo, wt, 'asist/sub')
    expect(fs.existsSync(wt)).toBe(false)
    expect(run(repo, ['branch', '--list', 'asist/*'])).toBe('')
  })

  it('reports a dirty working tree before a merge', () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'dirty\n')
    expect(git.isClean(repo)).toBe(false)
  })

  it('commits without reading the user configuration, which could require a signature', () => {
    const home = path.join(root, 'home')
    fs.mkdirSync(home)
    fs.writeFileSync(path.join(home, '.gitconfig'), '[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = false\n')
    const saved = { HOME: process.env.HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL }
    process.env.HOME = home
    process.env.GIT_CONFIG_GLOBAL = path.join(home, '.gitconfig')
    try {
      fs.writeFileSync(path.join(repo, 'c.txt'), 'signed?\n')
      expect(git.commitAll(repo, 'unsigned')).toBe(true)
      expect(git.isClean(repo)).toBe(true)
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })
})
