import type { AgentJob } from '@shared/ipc'
import { isJobExecuting } from '@shared/job-status'
import { useT } from '@/i18n'
import { useJobStore, usePanelStore } from '@/state/stores'
import { useViewStore } from '@/state/view'
import { JOB_STATUS_KEY } from '@/ui/job-presentation'
import type { CardContext, CardDefinition } from '../shell/card'
import { Action, Actions, Box, Chip, Empty, More } from '../primitives/Card'
import { relativeTime } from '../primitives/format'
import './jobs.css'

/**
 * Jobs card. It answers a question such as "ジョブどうなってる" in a single card, and pressing a row opens
 * that job's agent-job card.
 */

const LIMIT: Record<CardContext['size'], number> = { l: 8, m: 6, s: 4, focus: Infinity }

type Group = 'decision' | 'active' | 'recent'

const groupOf = (job: AgentJob): Group => {
  if (job.mergeState === 'pending' || job.mergeState === 'conflict' || job.mergeState === 'error') return 'decision'
  return isJobExecuting(job.status) ? 'active' : 'recent'
}

const GROUP_ORDER: Record<Group, number> = { decision: 0, active: 1, recent: 2 }

type StateKey = (typeof JOB_STATUS_KEY)[AgentJob['status']] | 'jobs.merge.pending' | 'jobs.merge.conflict' | 'jobs.merge.error'

/** The short state shown at the right of a row. A row that waits for a decision says what it waits for. */
const stateLabel = (job: AgentJob): { key: StateKey; tone: 'peach' | 'mint' | 'red' | 'dim' } => {
  if (job.mergeState === 'pending') return { key: 'jobs.merge.pending', tone: 'mint' }
  if (job.mergeState === 'conflict') return { key: 'jobs.merge.conflict', tone: 'red' }
  if (job.mergeState === 'error') return { key: 'jobs.merge.error', tone: 'red' }
  if (job.status === 'running') return { key: 'jobs.status.running', tone: 'peach' }
  if (job.status === 'stopping') return { key: 'jobs.status.stopping', tone: 'dim' }
  if (job.status === 'error') return { key: 'jobs.status.error', tone: 'red' }
  return { key: JOB_STATUS_KEY[job.status], tone: job.status === 'done' ? 'mint' : 'dim' }
}

export function sortJobsForCard(jobs: readonly AgentJob[]): AgentJob[] {
  return [...jobs].sort((a, b) => {
    const order = GROUP_ORDER[groupOf(a)] - GROUP_ORDER[groupOf(b)]
    return order !== 0 ? order : (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt)
  })
}

function JobsBody({ spec, size }: CardContext): React.JSX.Element {
  const t = useT()
  const jobs = useJobStore((s) => s.jobs)
  const apply = usePanelStore((s) => s.apply)
  const setFocused = usePanelStore((s) => s.setFocused)
  const openApp = useViewStore((s) => s.openApp)
  const sorted = sortJobsForCard(jobs)
  const decisions = sorted.filter((j) => groupOf(j) === 'decision').length
  const active = sorted.filter((j) => groupOf(j) === 'active').length
  const shown = sorted.slice(0, LIMIT[size])
  const rest = sorted.length - shown.length
  const open = (job: AgentJob): void =>
    apply({ op: 'create', key: `job:${job.id}`, type: 'agent-job', slot: 'right', props: { jobId: job.id }, state: 'ready' })

  const headline = decisions
    ? t('jobs.list.decisions', { count: decisions })
    : active
      ? t('jobs.list.running', { count: active })
      : t(sorted.length ? 'jobs.list.idle' : 'jobs.list.none')
  const note = [
    active && decisions ? t('jobs.list.runningNote', { count: active }) : '',
    sorted.length ? t('jobs.list.totalNote', { count: sorted.length }) : ''
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="card jb" data-size={size}>
      <div className="card-hero">
        <h3>{t('jobs.list.title')}</h3>
        <p>{headline}</p>
        {note && <p className="card-note">{note}</p>}
      </div>
      <Box title={t('jobs.list.box')} note={t('jobs.list.boxNote')}>
        {sorted.length === 0 ? (
          <Empty note={t('jobs.list.emptyNote')}>{t('jobs.list.empty')}</Empty>
        ) : (
          <ul className="card-rows">
            {shown.map((job) => {
              const state = stateLabel(job)
              const group = groupOf(job)
              return (
                <li key={job.id} className="card-row jb-item" data-group={group}>
                  <button type="button" className="card-row-link" onClick={() => open(job)}>
                    <span className="card-row-title">{job.title}</span>
                    <span className="card-row-meta">
                      {job.engine} ·{' '}
                      {group === 'recent'
                        ? relativeTime(job.endedAt ?? job.startedAt)
                        : t('jobs.list.startedAt', { when: relativeTime(job.startedAt) })}
                    </span>
                  </button>
                  <span className="card-row-aside">
                    <Chip tone={state.tone}>
                      {group !== 'recent' && <i className="jb-dot" aria-hidden />}
                      {t(state.key)}
                    </Chip>
                  </span>
                </li>
              )
            })}
          </ul>
        )}
        {rest > 0 && (
          <More onClick={() => setFocused(spec.key)} label={t('jobs.list.moreLabel')}>
            {t('common.more', { count: rest })}
          </More>
        )}
      </Box>
      <Actions>
        <Action leadsTo="screen" onClick={() => openApp({ app: 'jobs' })}>{t('jobs.list.openJobs')}</Action>
      </Actions>
    </div>
  )
}

export const jobsCard: CardDefinition = {
  Body: JobsBody,
  kicker: 'AGENT',
  className: 'jb-card'
}
