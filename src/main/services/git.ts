import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { errorText } from '@shared/i18n/error-text'
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

/** Cuts a branch for the job from HEAD and creates a worktree on it. */
export function worktreeAdd(repo: string, path: string, branch: string): void {
  git(repo, ['worktree', 'add', '-b', branch, path, 'HEAD'])
}

/** Removes the worktree and its branch, after a merge or after the changes are thrown away. */
export function worktreeRemove(repo: string, path: string, branch: string, discardChanges = false): void {
  git(repo, ['worktree', 'remove', ...(discardChanges ? ['--force'] : []), path])
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
 * The full diff from base to the branch, truncated at the limit. The note on the cut is part of the
 * patch, which the merge view shows and the LLM reads in get_agent_job, so it is written in the
 * language of the conversation.
 */
export function diffPatch(repo: string, base: string, branch: string, maxChars = 60_000): string {
  const patch = git(repo, ['diff', `${base}..${branch}`])
  if (patch.length <= maxChars) return patch
  const note = {
    ja: '(以下省略。全文は worktree のブランチにある)',
    en: '(cut here; the whole patch is on the branch in the worktree)'
  }[promptLanguage(conversationLocale())]
  return `${patch.slice(0, maxChars)}\n…${note}`
}

export type MergeOutcome = { ok: true } | { ok: false; conflict: boolean; message: string }

/** Merges the branch into the user's repository with --no-ff. A conflict aborts and restores the working tree. */
export function mergeNoFf(repo: string, branch: string, message: string): MergeOutcome {
  try {
    git(repo, ['-c', 'user.name=ASIST', '-c', 'user.email=asist@localhost', 'merge', '--no-ff', '-m', message, branch])
    return { ok: true }
  } catch (err) {
    const failure = err as { message?: string; stdout?: string | Buffer; stderr?: string | Buffer }
    const text = [failure.message ?? String(err), failure.stdout, failure.stderr].filter(Boolean).join('\n')
    // git sometimes reports a conflict on stdout, so the unresolved entries in the index decide, not the
    // wording or the language of the message.
    const conflict = git(repo, ['ls-files', '--unmerged']).trim().length > 0
    if (conflict) {
      try {
        git(repo, ['merge', '--abort'])
      } catch (abortError) {
        throw new Error(errorText('jobs.merging.abortFailed', { detail: String(abortError) }))
      }
    }
    return { ok: false, conflict, message: text.split('\n').slice(0, 5).join('\n') }
  }
}

/** Whether the working tree has no uncommitted change, which a merge requires. */
export function isClean(repo: string): boolean {
  return git(repo, ['status', '--porcelain']).trim() === ''
}
