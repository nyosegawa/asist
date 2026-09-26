import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
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

function git(cwd: string, args: string[], options: { maxBuffer?: number; env?: NodeJS.ProcessEnv } = {}): string {
  return execFileSync(gitPath(), args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...gitEnv(), ...options.env }
  })
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

const GITMODULES = '.gitmodules'
const SUBMODULE_MODE = '160000'

/** A pathspec that names exactly this path and whatever lies under it. */
const literal = (file: string): string => `:(literal)${file}`

/**
 * For output that grows with the number of changed paths. A job that adds a large package passes the default
 * 4 MB, and git would then be stopped on every attempt to settle the job: 14,000 new paths of 200 characters
 * made a raw diff of 4.4 MB (2026-09-26).
 */
const WHOLE = { maxBuffer: Infinity }

/**
 * What ASIST reads to settle, review or merge a job is the exact change, whatever the repository's settings
 * for showing changes say, and only the command line overrides those. `submodule.<name>.ignore` in .gitmodules
 * or the configuration, and `diff.ignoreSubmodules`, hide a moved submodule from git diff and git status, so
 * a job that only moved one looked unchanged and its worktree was removed with the only copy of the commit;
 * `status.showUntrackedFiles=no` hides new files the same way; and `diff.external`, a textconv driver or
 * `color.diff` replace what git diff prints, so the patch under review would not be the change.
 */
const EXACT_DIFF = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-relative', '--ignore-submodules=none']
const EXACT_STATUS = ['--untracked-files=normal', '--ignore-submodules=none']

/**
 * Commits every uncommitted change in dir as it is, and returns false when there is nothing to commit.
 *
 * The commit is built by write-tree and commit-tree from a copy of the index in a folder of its own, so no
 * hook of the repository runs and ASIST holds no lock of the repository between git's commands: git commit
 * runs prepare-commit-msg even with --no-verify, and a lock left by a crash would stop every later commit.
 * The index is brought up to the commit by git itself once the branch has moved, and when that fails the
 * branch goes back, so that a commit that fails leaves the index and the branch as they were.
 */
export function commitAll(dir: string, message: string): boolean {
  if (git(dir, ['status', '--porcelain', ...EXACT_STATUS], WHOLE).trim() === '') return false
  const head = hasHead(dir) ? headCommit(dir) : null
  const index = path.resolve(dir, git(dir, ['rev-parse', '--git-path', 'index']).trim())
  const scratch = fs.mkdtempSync(path.join(tmpdir(), 'asist-index-'))
  try {
    const staging = path.join(scratch, 'index')
    if (fs.existsSync(index)) fs.copyFileSync(index, staging)
    const env = { GIT_INDEX_FILE: staging }
    git(dir, ['add', '-A'], { env })
    const tree = git(dir, ['write-tree'], { env }).trim()
    if (head && tree === git(dir, ['rev-parse', `${head}^{tree}`]).trim()) {
      // Nothing is left to commit, but the index can still disagree with HEAD: a change staged and then
      // undone on disk, or a commit whose index was never brought up to it before a crash. Left so, the
      // job would never count as settled.
      git(dir, ['add', '-A'])
      return false
    }
    const commit = git(dir, [
      '-c', 'user.name=ASIST', '-c', 'user.email=asist@localhost', 'commit-tree', tree, ...(head ? ['-p', head] : []), '-m', message
    ]).trim()
    git(dir, ['update-ref', '-m', message, 'HEAD', commit, head ?? ''])
    try {
      git(dir, ['add', '-A'])
    } catch (error) {
      git(dir, head ? ['update-ref', 'HEAD', head, commit] : ['update-ref', '-d', 'HEAD', commit])
      throw error
    }
    return true
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

interface RawEntry {
  path: string
  oldMode: string
  newMode: string
}

/** The entries of a raw diff made with -z and --no-renames, where a field of modes and ids is followed by a field with the path. */
function rawEntries(raw: string): RawEntry[] {
  const fields = raw.split('\0')
  const entries: RawEntry[] = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [oldMode, newMode] = fields[i].slice(1).split(' ')
    entries.push({ path: fields[i + 1], oldMode, newMode })
  }
  return entries
}

/**
 * The submodules the changes from base to commit touch, with .gitmodules when it changed: a submodule moved
 * to another commit, added or removed, or a path turned into a submodule or out of one.
 */
export function submoduleEntryChanges(repo: string, base: string, commit: string): string[] {
  return rawEntries(git(repo, ['diff', ...EXACT_DIFF, '--raw', '-z', '--no-renames', base, commit], WHOLE))
    .filter((entry) => entry.oldMode === SUBMODULE_MODE || entry.newMode === SUBMODULE_MODE || entry.path === GITMODULES)
    .map((entry) => entry.path)
}

/**
 * The submodules of dir whose own folder holds work that no commit of dir carries and that may exist
 * nowhere else: files changed or added inside one that is initialized, a commit it moved to, commits of its
 * own repository that its remote does not have, or, in one that is not initialized, files written into its
 * folder, which git status does not show at all. The repository of a submodule initialized in a worktree lives
 * in the worktree's own git folder and is deleted with it.
 */
export function submodulesWithWork(dir: string): string[] {
  const submodules = gitlinks(dir)
  if (submodules.length === 0) return []
  const changed = new Set<string>()
  // With -z an entry of the second porcelain format is one field, and its path is all that follows the
  // fixed fields, spaces included. Without renames no entry carries a second path.
  const fixedFields: Record<string, number> = { '1': 8, u: 10 }
  const status = git(dir, ['status', '--porcelain=v2', '-z', '--no-renames', ...EXACT_STATUS, '--', ...submodules.map(literal)], WHOLE)
  for (const entry of status.split('\0')) {
    const count = fixedFields[entry[0]]
    if (count === undefined) continue
    const fields = entry.split(' ')
    if (fields[2].startsWith('S')) changed.add(fields.slice(count).join(' '))
  }
  for (const file of submodules) {
    if (changed.has(file)) continue
    const folder = path.join(dir, file)
    if (writtenWhileUninitialized(folder) || holdsUnpublishedCommits(folder)) changed.add(file)
  }
  return [...changed].sort()
}

/**
 * The paths of the submodule entries in dir's index. .gitmodules does not list a repository that was added
 * without `git submodule add`, and can still name a path that holds ordinary files by now, so the index,
 * which git itself reads, is what counts. Listing it took a median of 19 ms for 100,000 entries, an output
 * of 8.3 MB, with the bundled git 2.55 on an Apple M5 (2026-09-26).
 */
function gitlinks(dir: string): string[] {
  return git(dir, ['ls-files', '--stage', '-z'], WHOLE)
    .split('\0')
    .filter((entry) => entry.startsWith(`${SUBMODULE_MODE} `))
    .map((entry) => entry.slice(entry.indexOf('\t') + 1))
}

/** A folder of a submodule that is not initialized is empty in a new worktree, and git does not look inside it. */
function writtenWhileUninitialized(folder: string): boolean {
  let names: string[]
  try {
    names = fs.readdirSync(folder)
  } catch (error) {
    // A folder that is gone or replaced by a file shows in git status already.
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw error
  }
  return names.length > 0 && !names.includes('.git')
}

/**
 * Whether the repository of an initialized submodule has a commit that none of its remote-tracking branches
 * reaches: one on a branch, a tag or the stash, or one only its reflog remembers, as after a commit on a side
 * branch and a checkout of the pinned commit again. What its remote has can be fetched again, so only that
 * is left out. A pinned commit that no remote branch reaches counts as well, since nothing here shows that
 * it exists anywhere else.
 */
function holdsUnpublishedCommits(folder: string): boolean {
  if (!fs.existsSync(path.join(folder, '.git'))) return false
  return git(folder, ['rev-list', '-n', '1', '--all', '--reflog', '--not', '--remotes']).trim() !== ''
}

/**
 * Whether dir holds no change that commitAll would commit, new files included whatever
 * status.showUntrackedFiles says. It does not look inside submodules, whose changes no commit of dir carries
 * and which submodulesWithWork finds instead.
 */
export function isSettled(dir: string): boolean {
  return git(dir, ['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=all'], WHOLE).trim() === ''
}

/**
 * The commit a merge of `commit` into the repository's HEAD starts from, or null when they share no history,
 * as with a branch made by `checkout --orphan`, or when HEAD has no commit yet.
 */
export function mergeBase(repo: string, commit: string): string | null {
  if (!hasHead(repo)) return null
  try {
    return git(repo, ['merge-base', 'HEAD', commit]).trim()
  } catch (error) {
    // merge-base exits with 1 and prints nothing when the two have no common ancestor.
    if ((error as { status?: number }).status === 1) return null
    throw error
  }
}

/** Whether anything changed from base to commit. */
export function hasChanges(repo: string, base: string, commit: string): boolean {
  try {
    git(repo, ['diff', ...EXACT_DIFF, '--quiet', base, commit])
    return false
  } catch (error) {
    if ((error as { status?: number }).status === 1) return true
    throw error
  }
}

/**
 * A summary of the changes from base to commit, listing at most the first 500 files before its total line.
 * An empty string means nothing changed.
 */
export function diffStat(repo: string, base: string, commit: string): string {
  return git(repo, ['diff', ...EXACT_DIFF, '--stat', '--stat-count=500', base, commit]).trim()
}

export interface DiffEntry {
  path: string
  /** The git file mode after the change, such as 100644, 120000 for a symbolic link, or 000000 for a deletion. */
  mode: string
}

/** Every path the changes from base to commit touch, with its mode afterwards. Renames count as a deletion and an addition. */
export function diffEntries(repo: string, base: string, commit: string): DiffEntry[] {
  return rawEntries(git(repo, ['diff', ...EXACT_DIFF, '--raw', '-z', '--no-renames', base, commit], WHOLE))
    .map((entry) => ({ path: entry.path, mode: entry.newMode }))
}

/**
 * The diff from base to commit, cut at the limit. git is stopped once its output passes four bytes for each
 * character kept, so a diff of any size is read only that far; a character takes at most three bytes of
 * UTF-8, so what was read always reaches past the limit. The note on the cut is part of the patch, which the
 * merge view shows and the LLM reads in get_agent_job, so it is written in the language of the conversation.
 */
export function diffPatch(repo: string, base: string, commit: string, maxChars = 60_000): string {
  let patch: string
  try {
    patch = git(repo, ['diff', ...EXACT_DIFF, base, commit], { maxBuffer: maxChars * 4 })
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
