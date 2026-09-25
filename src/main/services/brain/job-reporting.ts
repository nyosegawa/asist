import { isBackgroundJob, isJobTerminal } from '@shared/job-status'
import type { TurnPlaybackAckStatus } from '@shared/ipc'
import { errMessage } from '@shared/api-errors'
import { PlaybackDeliveryTracker } from '@shared/playback-delivery'
import { fillPrompt, promptText, type PromptText } from '@shared/conversation-locale'
import { marker } from '@shared/conversation-markers'
import { conversationLocale } from '../conversation-locale'
import * as agentRunner from '../agent'
import { beginTurn, type TurnInput } from './index'
import { conversationOwner, record, turnScheduler } from './session'

/**
 * Automatic reporting of finished jobs. The end of an agent job is handed to a turn as a system
 * notice, and the LLM reports it in the flow of the conversation. A report never takes a turn away
 * from the user: it starts only while idle. It counts as delivered only once the renderer
 * acknowledges that the speech actually started, and is queued again when it was not played.
 */

const JOB_REPORT_PLAYBACK_TIMEOUT_MS = 3 * 60_000
const MAX_JOB_REPORT_ATTEMPTS = 5

/** What the model is told about a job that ended. It reads it and reports it in its own words. */
const REPORT: Readonly<Record<'done' | 'error' | 'artifacts' | 'mergePending' | 'mergeUnchanged' | 'noSummary' | 'noReason', PromptText>> = {
  done: {
    ja: `{notice} ジョブ「{title}」(jobId: {jobId})が完了した。結果の要約: {summary}{artifactNote}{mergeNote}`,
    en: `{notice} The job "{title}" (jobId: {jobId}) is done. A summary of the result: {summary}{artifactNote}{mergeNote}`
  },
  error: {
    ja: `{notice} ジョブ「{title}」(jobId: {jobId})がエラーで停止した。理由: {summary}{mergeNote}`,
    en: `{notice} The job "{title}" (jobId: {jobId}) stopped with an error. The reason: {summary}{mergeNote}`
  },
  artifacts: { ja: ` 成果物: {artifacts}`, en: ` What it produced: {artifacts}` },
  mergePending: {
    ja: ` 変更はworktreeにあり取り込み待ち。差分は画面のジョブパネルで見られる。取り込むか捨てるかを聞くこと(「取り込んで」でmerge_agent_job、「捨てて」でdiscard_agent_job)。`,
    en: ` The changes are in a worktree, waiting to be taken in. The diff is on the job panel on screen. Ask whether to take them in or throw them away: merge_agent_job takes them in, discard_agent_job throws them away.`
  },
  mergeUnchanged: { ja: ` 変更は無かったのでworktreeは片付けた。`, en: ` Nothing changed, so the worktree has been cleared away.` },
  noSummary: { ja: `要約なし`, en: `no summary` },
  noReason: { ja: `不明`, en: `unknown` }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const reportedJobs = new Set<string>()
const reportingJobs = new Set<string>()
const playbackDeliveries = new PlaybackDeliveryTracker()
let reportQueue: Promise<void> = Promise.resolve()

/** Receives from the renderer whether the interjected audio actually started or was discarded before it did. */
export function acknowledgePlayback(turnId: number, status: TurnPlaybackAckStatus): void {
  playbackDeliveries.acknowledge(turnId, status)
}

/** Waits for the running turn and its speech to finish, for at most two minutes. */
async function waitForIdle(): Promise<void> {
  for (let i = 0; i < 240; i++) {
    if (turnScheduler.activeTurnId === null) return
    await sleep(500)
  }
}

export function initJobReporting(): void {
  agentRunner.events.on('event', (event) => {
    if (event.type !== 'update') return
    const job = event.job
    if (
      !isJobTerminal(job.status) ||
      reportedJobs.has(job.id) ||
      reportingJobs.has(job.id)
    ) return
    if (isBackgroundJob(job)) {
      reportedJobs.add(job.id)
      return
    }
    // A cancellation the user made in the UI needs no spoken report, because it already happened on screen.
    if (job.status === 'cancelled') {
      reportedJobs.add(job.id)
      return
    }
    reportingJobs.add(job.id)
    const locale = conversationLocale()
    const artifacts = (job.artifacts ?? []).slice(-5)
    const artifactNote = artifacts.length > 0 ? fillPrompt(promptText(locale, REPORT.artifacts), { artifacts: artifacts.join(', ') }) : ''
    const mergeNote =
      job.mergeState === 'pending'
        ? promptText(locale, REPORT.mergePending)
        : job.worktree && job.mergeState === 'unchanged'
          ? promptText(locale, REPORT.mergeUnchanged)
          : ''
    const values = { notice: marker(locale, 'systemNotice'), title: job.title, jobId: job.id, artifactNote, mergeNote }
    const notice: TurnInput =
      job.status === 'done'
        ? {
            notice: 'job-done',
            text: fillPrompt(promptText(locale, REPORT.done), {
              ...values,
              summary: (job.summary ?? promptText(locale, REPORT.noSummary)).slice(0, 500)
            })
          }
        : {
            notice: 'job-error',
            text: fillPrompt(promptText(locale, REPORT.error), {
              ...values,
              summary: (job.summary ?? promptText(locale, REPORT.noReason)).slice(0, 200)
            })
          }
    // The notice is not read out verbatim: the LLM reports it in the flow of the conversation, and waits if speech is in progress.
    reportQueue = reportQueue
      .catch((error) => console.error('previous job report failed:', errMessage(error)))
      .then(async () => {
        // An engine that owns the conversation, such as Gemini Live, is handed the notice and reports
        // it in context. The notice is written to the conversation log here, while the wording of the
        // report is recorded on that side from the output transcript.
        const owner = conversationOwner()
        if (owner) {
          record({ kind: 'notice', turnId: turnScheduler.allocateTurnId(), notice: notice.notice!, text: notice.text })
          await owner.notify(notice.text)
          reportedJobs.add(job.id)
          return
        }
        // User input can arrive between the wait and the start, and must not be taken over, so the
        // loop keeps waiting until an idle-only start succeeds.
        for (let attempt = 1; attempt <= MAX_JOB_REPORT_ATTEMPTS; attempt++) {
          await waitForIdle()
          const handle = beginTurn(notice, {}, 'interject', true)
          if (!handle) {
            attempt--
            continue
          }

          // The run of beginTurn starts on a microtask, so the tracking is always registered before
          // started or segment reaches the renderer. An abort on the main side counts as not played
          // and is queued again.
          const delivery = playbackDeliveries.expect(
            handle.turnId,
            JOB_REPORT_PLAYBACK_TIMEOUT_MS
          )
          const interrupted = (): void => {
            playbackDeliveries.acknowledge(handle.turnId, 'interrupted')
          }
          handle.signal.addEventListener('abort', interrupted, { once: true })
          if (handle.signal.aborted) interrupted()
          try {
            await handle.completion
          } catch (error) {
            interrupted()
            console.error('job report turn failed:', errMessage(error))
          } finally {
            handle.signal.removeEventListener('abort', interrupted)
          }

          const outcome = await delivery
          if (outcome === 'started') {
            reportedJobs.add(job.id)
            return
          }
          console.warn(
            `job report was not played (${outcome}); retrying ${attempt}/${MAX_JOB_REPORT_ATTEMPTS}`
          )
        }
        console.error(`job report could not be delivered after retries: ${job.id}`)
      })
      .catch((error) => console.error('job report failed:', errMessage(error)))
      .finally(() => {
        reportingJobs.delete(job.id)
      })
  })
}
