import type { AgentJob, JobDiff } from '@shared/ipc'
import { errorText } from '@shared/i18n/error-text'
import { isJobTerminal } from '@shared/job-status'
import * as git from './git'

type Worktree = NonNullable<AgentJob['worktree']>

/**
 * The commit a job's own changes are counted from: its merge base with the repository's current HEAD, since
 * a job that merged or rebased onto the user's branch holds the user's commits as well. A branch that shares
 * no history with the job, made by `checkout --orphan`, has none, and the job's changes are then those since
 * the commit it started from.
 */
function jobBase(worktree: Worktree, commit: string): string {
  return git.mergeBase(worktree.repo, commit) ?? worktree.base
}

/**
 * Settles the output after the process has ended. On failure the caller keeps the worktree. The submodule
 * changes left out are the job's own, counted from jobBase. A worktree is removed only when nothing in it is
 * left, since a commit made inside a submodule of the worktree has no other copy.
 */
export function captureWorktree(job: AgentJob): Pick<AgentJob, 'worktree' | 'mergeState'> {
  const worktree = job.worktree!
  const base = jobBase(worktree, git.headCommit(worktree.dir))
  const { leftOut } = git.commitAll(worktree.dir, `asist: ${job.title}`, base)
  const submodules = [...new Set([...leftOut, ...git.submodulesWithChanges(worktree.dir)])].sort()
  const commit = git.headCommit(worktree.dir)
  const settled = { ...worktree, commit, submodules: submodules.length > 0 ? submodules : undefined }
  if (!git.hasChanges(worktree.repo, base, commit) && submodules.length === 0) {
    git.worktreeRemove(worktree.repo, worktree.dir, worktree.branch)
    return { worktree: settled, mergeState: 'unchanged' }
  }
  return { worktree: settled, mergeState: 'pending' }
}

/** What a discard of the worktree's branch would throw away, counted as a settled job's changes are. */
export function discardStat(worktree: Worktree): string {
  return git.diffStat(worktree.repo, jobBase(worktree, worktree.branch), worktree.branch)
}

/**
 * The commit a merge of `commit` into the repository's HEAD starts from, which is what a review counts from
 * and what the merge applies the changes since. A branch with no history in common with the job has none,
 * and nothing is merged into it.
 */
export function mergeBase(worktree: Worktree, commit: string): string {
  const base = git.mergeBase(worktree.repo, commit)
  if (base === null) throw new Error(errorText('jobs.merging.noCommonHistory'))
  return base
}

/** Acts only while the commit that was shown still matches the current branch and worktree. */
export function assertWorktreeReview(job: AgentJob, commit: string): void {
  const worktree = job.worktree
  if (!isJobTerminal(job.status)) throw new Error(errorText('jobs.worktree.jobRunning'))
  if (!worktree || job.mergeState !== 'pending' || !commit || commit !== worktree.commit) {
    throw new Error(errorText('jobs.worktree.reviewStale'))
  }
  if (!git.isSettled(worktree.dir, worktree.submodules)) throw new Error(errorText('jobs.worktree.uncommitted'))
  if (git.headCommit(worktree.dir) !== commit || git.headCommit(worktree.repo, worktree.branch) !== commit) {
    throw new Error(errorText('jobs.worktree.commitChanged'))
  }
}

/**
 * The diff a merge would bring in, counted from the merge base it names, and the submodules the job settled
 * without, as they were found when it settled.
 */
export function readWorktreeDiff(job: AgentJob): JobDiff {
  const commit = job.worktree?.commit ?? ''
  assertWorktreeReview(job, commit)
  const worktree = job.worktree!
  const base = mergeBase(worktree, commit)
  return {
    commit,
    base,
    stat: git.diffStat(worktree.repo, base, commit),
    patch: git.diffPatch(worktree.repo, base, commit),
    submodules: worktree.submodules ?? []
  }
}
