import type { AgentJob } from './ipc'
import { isBackgroundJob } from './job-status'

/**
 * When the app pushes a job card by itself, without waiting for a call from the LLM, so that the diff
 * is already on screen by the time the voice asks whether to merge it. A card goes up when the job
 * enters a phase that needs the user's decision, and when it ends.
 * - Waiting for a decision: merge, conflict or failed commit (`mergeState`).
 * - Finished: done and error. A job the user stopped is left out.
 * A background job, memory curation, never pushes a card.
 * The card at the start of a job comes from run_agent_task and is not handled here.
 */
export type JobCardPhase = 'merge' | 'done' | 'error'

export function jobCardPhase(job: AgentJob): JobCardPhase | null {
  if (isBackgroundJob(job)) return null
  if (job.mergeState === 'pending' || job.mergeState === 'conflict' || job.mergeState === 'error') return 'merge'
  if (job.status === 'done') return 'done'
  if (job.status === 'error') return 'error'
  return null
}

/** True only when the job has entered a new phase. An update within the same phase, such as another artifact, pushes nothing. */
export function shouldPushJobCard(previous: AgentJob | undefined, next: AgentJob): boolean {
  const phase = jobCardPhase(next)
  if (!phase) return false
  return previous === undefined || jobCardPhase(previous) !== phase
}
