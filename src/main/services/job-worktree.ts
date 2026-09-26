import fs from 'node:fs'
import type { AgentJob, JobDiff } from '@shared/ipc'
import { errorText } from '@shared/i18n/error-text'
import { isJobTerminal } from '@shared/job-status'
import * as git from './git'

type Worktree = NonNullable<AgentJob['worktree']>

const sortedUnique = (paths: string[]): string[] => [...new Set(paths)].sort()

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
 * Refuses to work on a worktree whose folder is gone, deleted by hand, with a reason the user can act on:
 * git would otherwise fail to start in the missing folder, which reads as if git itself were missing.
 */
export function assertWorktreePresent(worktree: Worktree): void {
  if (!fs.existsSync(worktree.dir)) {
    throw new Error(errorText('jobs.worktree.gone', { dir: worktree.dir, branch: worktree.branch }))
  }
}

/**
 * Settles the output after the process has ended. On failure the caller keeps the worktree. The commit holds
 * the worktree as the agent left it, and the submodules it touched or holds work in are recorded: a job with
 * any is never merged by ASIST, and its worktree stays until the user discards it, since a commit made inside
 * a submodule of the worktree has no other copy. The worktree is removed without asking only when neither the
 * diff nor its submodules hold anything that could be lost.
 */
export function captureWorktree(job: AgentJob): Pick<AgentJob, 'worktree' | 'mergeState'> {
  const worktree = job.worktree!
  assertWorktreePresent(worktree)
  git.commitAll(worktree.dir, `asist: ${job.title}`)
  const commit = git.headCommit(worktree.dir)
  const base = jobBase(worktree, commit)
  const submodules = sortedUnique([...git.submoduleEntryChanges(worktree.repo, base, commit), ...git.submodulesWithWork(worktree.dir)])
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

/**
 * The submodules that keep a job from being merged by ASIST: those the changes a merge counted from `base`
 * would bring in touch, and those the job changed inside their own folders, as found when it settled.
 */
function touchedSubmodules(worktree: Worktree, base: string, commit: string): string[] {
  return sortedUnique([...(worktree.submodules ?? []), ...git.submoduleEntryChanges(worktree.repo, base, commit)])
}

/** Acts only while the commit that was shown still matches the current branch and worktree. */
export function assertWorktreeReview(job: AgentJob, commit: string): void {
  const worktree = job.worktree
  if (!isJobTerminal(job.status)) throw new Error(errorText('jobs.worktree.jobRunning'))
  if (!worktree || job.mergeState !== 'pending' || !commit || commit !== worktree.commit) {
    throw new Error(errorText('jobs.worktree.reviewStale'))
  }
  assertWorktreePresent(worktree)
  if (!git.isSettled(worktree.dir)) throw new Error(errorText('jobs.worktree.uncommitted'))
  if (git.headCommit(worktree.dir) !== commit || git.headCommit(worktree.repo, worktree.branch) !== commit) {
    throw new Error(errorText('jobs.worktree.commitChanged'))
  }
}

/**
 * Refuses a merge that would apply more than the review counted from `base` showed, one of a job that
 * touched submodules, which the user merges or discards, and one with nothing to merge. The submodules are
 * looked into again, since the merge removes the worktree and whatever work appeared in them since it settled.
 */
export function assertMergeable(job: AgentJob, commit: string, base: string): void {
  const worktree = job.worktree!
  if (mergeBase(worktree, commit) !== base) throw new Error(errorText('jobs.merging.baseChanged'))
  const submodules = sortedUnique([...touchedSubmodules(worktree, base, commit), ...git.submodulesWithWork(worktree.dir)])
  if (submodules.length > 0) {
    throw new Error(errorText('jobs.merging.submodules', { paths: submodules.join(', '), branch: worktree.branch }))
  }
  if (!git.hasChanges(worktree.repo, base, commit)) throw new Error(errorText('jobs.merging.noChanges', { id: job.id }))
}

/**
 * The diff a merge would bring in, counted from the merge base it names, and the submodules that keep the
 * job from being merged by ASIST.
 */
export function readWorktreeDiff(job: AgentJob): JobDiff {
  const commit = job.worktree?.commit ?? ''
  assertWorktreeReview(job, commit)
  const worktree = job.worktree!
  const base = mergeBase(worktree, commit)
  return {
    commit,
    base,
    into: git.checkedOut(worktree.repo),
    stat: git.diffStat(worktree.repo, base, commit),
    patch: git.diffPatch(worktree.repo, base, commit),
    submodules: touchedSubmodules(worktree, base, commit)
  }
}
