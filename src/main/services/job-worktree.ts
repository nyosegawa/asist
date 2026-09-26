import type { AgentJob, JobDiff } from '@shared/ipc'
import { errorText } from '@shared/i18n/error-text'
import { isJobTerminal } from '@shared/job-status'
import * as git from './git'

/**
 * Settles the output after the process has ended. On failure the caller keeps the worktree. The job's own
 * changes are those since the merge base with the repository's current HEAD: a job that merged or rebased
 * onto the user's branch holds the user's commits as well, and their submodule changes are the user's, not
 * the job's to leave out. A worktree is removed only when nothing in it is left, since a commit made inside a
 * submodule of the worktree has no other copy.
 */
export function captureWorktree(job: AgentJob): Pick<AgentJob, 'worktree' | 'mergeState'> {
  const worktree = job.worktree!
  const base = git.mergeBase(worktree.repo, git.headCommit(worktree.dir))
  const { leftOut } = git.commitAll(worktree.dir, `asist: ${job.title}`, base)
  const submodules = [...new Set([...leftOut, ...git.submodulesWithChanges(worktree.dir)])].sort()
  const commit = git.headCommit(worktree.dir)
  const settled = { ...worktree, commit, submodules: submodules.length > 0 ? submodules : undefined }
  if (!git.diffStat(worktree.repo, commit) && submodules.length === 0) {
    git.worktreeRemove(worktree.repo, worktree.dir, worktree.branch)
    return { worktree: settled, mergeState: 'unchanged' }
  }
  return { worktree: settled, mergeState: 'pending' }
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

/** The diff a merge would bring in and the submodules the job settled without, as they were found when it settled. */
export function readWorktreeDiff(job: AgentJob): JobDiff {
  const commit = job.worktree?.commit ?? ''
  assertWorktreeReview(job, commit)
  const worktree = job.worktree!
  return {
    commit,
    stat: git.diffStat(worktree.repo, commit),
    patch: git.diffPatch(worktree.repo, commit),
    submodules: worktree.submodules ?? []
  }
}
