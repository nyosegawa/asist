import type { MessageKey } from '@shared/i18n'
import type { JobStatus } from '@shared/ipc'

/** The one place that words and colors a job's status and log, shared by the cards and by JobsView. */

export const JOB_STATUS_KEY = {
  running: 'jobs.status.running',
  stopping: 'jobs.status.stopping',
  done: 'jobs.status.done',
  error: 'jobs.status.error',
  cancelled: 'jobs.status.cancelled'
} as const satisfies Record<JobStatus, MessageKey>

/** For the chip on a card, which is drawn with a border. */
export const JOB_STATUS_CHIP: Record<JobStatus, string> = {
  running: 'text-holo-peach border-holo-peach/40 holo-pulse',
  stopping: 'text-holo-dim border-holo-line holo-pulse',
  done: 'text-holo-mint border-holo-mint/45',
  error: 'text-holo-red border-holo-red/45',
  cancelled: 'text-holo-dim border-holo-line'
}

/** For the text color in the job list. */
export const JOB_STATUS_TEXT: Record<JobStatus, string> = {
  running: 'text-holo-peach',
  stopping: 'text-holo-dim',
  done: 'text-holo-mint',
  error: 'text-holo-red',
  cancelled: 'text-holo-dim'
}
