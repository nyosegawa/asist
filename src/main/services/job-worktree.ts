import type { AgentJob, JobDiff } from '@shared/ipc'
import { errorText } from '@shared/i18n/error-text'
import { isJobTerminal } from '@shared/job-status'
import * as git from './git'

/** Settles the output after the process has ended. On failure the caller keeps the worktree. */
export function captureWorktree(job: AgentJob): Partial<AgentJob> {
  const worktree = job.worktree!
  git.commitAll(job.cwd, `asist: ${job.title}`)
  const commit = git.headCommit(job.cwd)
  const stat = git.diffStat(worktree.repo, worktree.base, commit)
  if (!stat) {
    git.worktreeRemove(worktree.repo, job.cwd, worktree.branch)
    return { worktree: { ...worktree, commit }, mergeState: 'unchanged' }
  }
  return { worktree: { ...worktree, commit }, mergeState: 'pending' }
}

/** Acts only while the commit that was shown still matches the current branch and worktree. */
export function assertWorktreeReview(job: AgentJob, commit: string): void {
  const worktree = job.worktree
  if (!isJobTerminal(job.status)) throw new Error(errorText('jobs.worktree.jobRunning'))
  if (!worktree || job.mergeState !== 'pending' || !commit || commit !== worktree.commit) {
    throw new Error(errorText('jobs.worktree.reviewStale'))
  }
  if (!git.isClean(job.cwd)) throw new Error(errorText('jobs.worktree.uncommitted'))
  if (git.headCommit(job.cwd) !== commit || git.headCommit(worktree.repo, worktree.branch) !== commit) {
    throw new Error(errorText('jobs.worktree.commitChanged'))
  }
}

export function readWorktreeDiff(job: AgentJob): JobDiff {
  const commit = job.worktree?.commit ?? ''
  assertWorktreeReview(job, commit)
  const worktree = job.worktree!
  return {
    commit,
    stat: git.diffStat(worktree.repo, worktree.base, commit),
    patch: git.diffPatch(worktree.repo, worktree.base, commit)
  }
}
