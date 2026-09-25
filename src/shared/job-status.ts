import type { AgentJob, JobStatus } from './ipc'

/**
 * Memory curation runs behind the conversation. It is kept out of every list, card, count and event that
 * the user or the conversation model sees, and only the memory page of the settings reports on it.
 */
export const isBackgroundJob = (job: Pick<AgentJob, 'memoryCuration'>): boolean => Boolean(job.memoryCuration)

export function isJobExecuting(status: JobStatus): boolean {
  return status === 'running' || status === 'stopping'
}

export function isJobTerminal(status: JobStatus): boolean {
  return status === 'done' || status === 'error' || status === 'cancelled'
}
