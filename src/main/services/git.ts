import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { promptLanguage } from '@shared/conversation-locale'
import { conversationLocale } from './conversation-locale'
import { childEnv } from './child-env'
import { resourcePath } from './resource-path'

/**
 * The git operations behind worktree isolation. Every call is a synchronous execFile and a failure throws,
 * leaving the decision to the caller. The user's working tree and index are never touched: only the inside
 * of the worktree, and the branch at merge time.
 */

/**
 * The git that ships in resources/git. The one in /usr/bin only asks to install the Command Line Tools
 * when they are missing, and the memory repository is opened at every start.
 */
export function gitPath(): string {
  return resourcePath(path.join('git', 'bin', 'git'))
}

/**
 * The environment git runs with: the child environment without GIT_ variables, and without the system and
 * user configuration. A user's commit.gpgsign would otherwise make every commit wait for a signature, and
 * a filter such as git-lfs names a program that a Finder launch has no PATH to.
 */
export function gitEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = childEnv({}, parent)
  for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name]
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
}

function git(cwd: string, args: string[], maxBuffer = 4 * 1024 * 1024): string {
  return execFileSync(gitPath(), args, { cwd, encoding: 'utf8', maxBuffer, stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv() })
}

/** The top level of the repository dir sits in, or null when it is not inside one. */
export function toplevel(dir: string): string | null {
  try {
    return git(dir, ['rev-parse', '--show-toplevel']).trim() || null
  } catch {
    return null
  }
}

export function headCommit(repo: string, ref = 'HEAD'): string {
  return git(repo, ['rev-parse', '--verify', ref]).trim()
}

/** Makes dir a repository, and does nothing when it already is one. */
export function init(dir: string): void {
  git(dir, ['init', '-q', '-b', 'main'])
}

/** Whether a first commit exists. A worktree is cut from HEAD, so without one it cannot be created. */
export function hasHead(repo: string): boolean {
  try {
    git(repo, ['rev-parse', '--verify', 'HEAD'])
    return true
  } catch {
    return false
  }
}

/** The folder of dir within its repository, such as `packages/web`, or an empty string at the top. */
export function pathInRepo(dir: string): string {
  return git(dir, ['rev-parse', '--show-prefix']).trim().replace(/\/$/, '')
}

/**
 * Cuts a branch for the job from HEAD and creates a worktree on it. When git fails after it has created
 * them, both are removed again before its error is thrown: git keeps the worktree when only its
 * post-checkout hook fails, as the hook of Git LFS does when an app opened from Finder has no git-lfs on
 * its PATH, and it never deletes the branch.
 */
export function worktreeAdd(repo: string, path: string, branch: string): void {
  git(repo, ['branch', branch, 'HEAD'])
  try {
    git(repo, ['worktree', 'add', path, branch])
  } catch (error) {
    try {
      const created = worktreeOn(repo, branch)
      if (created) git(repo, ['worktree', 'remove', '--force', created])
      git(repo, ['branch', '-D', branch])
    } catch (cleanupError) {
      console.error('cannot remove the worktree git left behind:', path, cleanupError)
    }
    throw error
  }
}

/** The path of the worktree that has the branch checked out, or null when none has. */
function worktreeOn(repo: string, branch: string): string | null {
  let path: string | null = null
  for (const line of git(repo, ['worktree', 'list', '--porcelain', '-z']).split('\0')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
    else if (line === `branch refs/heads/${branch}`) return path
  }
  return null
}

/**
 * Removes the worktree and its branch together with whatever the worktree still holds. git refuses to
 * remove a worktree in which a submodule was initialized unless it is forced, so a caller removes one only
 * when nothing in it is left to lose: its changes are merged, there were none, or the user threw them away.
 */
export function worktreeRemove(repo: string, path: string, branch: string): void {
  git(repo, ['worktree', 'remove', '--force', path])
  git(repo, ['branch', '-D', branch])
}

/** Commits every uncommitted change inside the worktree, and returns false when there is nothing to commit. */
export function commitAll(worktree: string, message: string): boolean {
  const status = git(worktree, ['status', '--porcelain']).trim()
  if (!status) return false
  git(worktree, ['add', '-A'])
  git(worktree, [
    '-c',
    'user.name=ASIST',
    '-c',
    'user.email=asist@localhost',
    'commit',
    '-q',
    '-m',
    message,
    '--no-verify'
  ])
  return true
}

/** A summary of the changes from base to the branch. An empty string means nothing changed. */
export function diffStat(repo: string, base: string, branch: string): string {
  return git(repo, ['diff', '--stat', `${base}..${branch}`]).trim()
}

export interface DiffEntry {
  path: string
  /** The git file mode after the change, such as 100644, 120000 for a symbolic link, or 000000 for a deletion. */
  mode: string
}

/** Every path the changes from base to the branch touch, with its mode afterwards. Renames count as a deletion and an addition. */
export function diffEntries(repo: string, base: string, branch: string): DiffEntry[] {
  const fields = git(repo, ['diff', '--raw', '-z', '--no-renames', `${base}..${branch}`]).split('\0')
  const entries: DiffEntry[] = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [, mode] = fields[i].slice(1).split(' ')
    entries.push({ path: fields[i + 1], mode })
  }
  return entries
}

/**
 * The diff from base to the branch, cut at the limit. git is stopped once its output passes four bytes
 * for each character kept, so a diff of any size is read only that far; a character takes at most three
 * bytes of UTF-8, so what was read always reaches past the limit. The note on the cut is part of the
 * patch, which the merge view shows and the LLM reads in get_agent_job, so it is written in the language
 * of the conversation.
 */
export function diffPatch(repo: string, base: string, branch: string, maxChars = 60_000): string {
  let patch: string
  try {
    patch = git(repo, ['diff', `${base}..${branch}`], maxChars * 4)
  } catch (error) {
    // Node ends git with ENOBUFS at the buffer's size and hands over the output read until then.
    const cut = error as NodeJS.ErrnoException & { stdout?: unknown }
    if (cut.code !== 'ENOBUFS' || typeof cut.stdout !== 'string') throw error
    patch = cut.stdout
  }
  if (patch.length <= maxChars) return patch
  const note = {
    ja: '(以下省略。全文は worktree のブランチにある)',
    en: '(cut here; the whole patch is on the branch in the worktree)'
  }[promptLanguage(conversationLocale())]
  return `${patch.slice(0, maxChars)}\n…${note}`
}

export type MergeOutcome = { ok: true } | { ok: false; conflict: boolean; message: string }

const firstLines = (text: string): string => text.trim().split('\n').slice(0, 5).join('\n')

/**
 * Merges the branch into the user's repository as a merge commit. The commit is made by merge-tree and
 * commit-tree, which touch neither the working tree nor the index, and the working tree then moves to it
 * only by a fast-forward. git merge would stop half done in them on a conflict or when a hook of the
 * user's, such as a commit-msg hook that rejects the message, fails, and a later git commit of the user's
 * would then commit changes nobody reviewed.
 */
export function mergeNoFf(repo: string, branch: string, message: string): MergeOutcome {
  const head = headCommit(repo)
  const incoming = headCommit(repo, branch)
  let tree: string
  try {
    tree = git(repo, ['merge-tree', '--write-tree', '--name-only', head, incoming]).split('\n')[0]
  } catch (error) {
    // Status 1 with a tree is a conflict. The lines after the blank one are git's messages about it.
    const failure = error as { status?: number; stdout?: unknown }
    if (failure.status !== 1 || typeof failure.stdout !== 'string' || !failure.stdout) throw error
    return { ok: false, conflict: true, message: firstLines(failure.stdout.split('\n\n')[1] ?? '') }
  }
  const commit = git(repo, [
    '-c', 'user.name=ASIST', '-c', 'user.email=asist@localhost', 'commit-tree', tree, '-p', head, '-p', incoming, '-m', message
  ]).trim()
  try {
    git(repo, ['merge', '--ff-only', '-q', commit])
  } catch (error) {
    const failure = error as { message?: string; stderr?: string }
    return { ok: false, conflict: false, message: firstLines(failure.stderr || String(failure.message)) }
  }
  return { ok: true }
}

/** Whether the working tree has no uncommitted change, which a merge requires. */
export function isClean(repo: string): boolean {
  return git(repo, ['status', '--porcelain']).trim() === ''
}
