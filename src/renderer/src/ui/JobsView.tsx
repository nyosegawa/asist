import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { HoloDialog } from '@/components/ui/dialog'
import { useT, useFormatLocale } from '@/i18n'
import { useJobStore } from '@/state/stores'
import { useMiniApp, useViewStore } from '@/state/view'
import { foldJobLog, rowText } from '@shared/job-log-view'
import { JOB_STATUS_TEXT } from '@/ui/job-presentation'
import { JobLogRows } from '@/ui/JobLog'
import { JobStopButton } from './JobStopButton'
import { JobArtifacts } from './JobArtifacts'

/** The list of agent jobs, together with the full log of the selected one. */

/**
 * Copies the whole log to the clipboard. Like a copy of a selection it leaves the timestamps out and
 * separates the rows with newlines. Right after the press the label says the log was copied, so that
 * the press is visible.
 */
function CopyLogButton({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const t = useT()
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <button
      onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}
      disabled={text.length === 0}
      className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-holo-line px-3 py-1 font-mono text-[10px] text-holo-dim transition-colors hover:border-holo-cyan/40 hover:text-holo-cyan disabled:cursor-default disabled:opacity-40"
      aria-label={t('jobs.screen.copyLabel')}
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
      {copied ? t('jobs.screen.copied') : t('jobs.screen.copy')}
    </button>
  )
}

/** App passes `open`, so the view keeps drawing through the closing animation even after the store says it is closed. */
export function JobsView({ open }: { open: boolean }): React.JSX.Element {
  const closeApp = useViewStore((s) => s.closeApp)
  const update = useViewStore((s) => s.update)
  const { jobId } = useMiniApp('jobs')
  const { jobs, logs, loadLog } = useJobStore()
  const t = useT()
  const locale = useFormatLocale()
  const logRef = useRef<HTMLDivElement>(null)

  // With no job chosen, or one the list does not have, the newest job is shown.
  const active = jobs.some((j) => j.id === jobId) ? jobId : (jobs[0]?.id ?? null)
  useEffect(() => {
    if (active !== jobId) update('jobs', { jobId: active })
  }, [active, jobId, update])
  const log = active ? (logs[active] ?? []) : []
  const rows = foldJobLog(log)
  const logText = rows.map((row) => rowText(row, t)).join('\n')
  const job = jobs.find((j) => j.id === active)

  useEffect(() => {
    if (open && active) void loadLog(active)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [log.length])

  return (
    <HoloDialog embedded open={open} onOpenChange={(next) => !next && closeApp()} title="AGENT JOBS" wide>
      {jobs.length === 0 ? (
        <div className="py-10 text-center text-xs text-holo-dim">{t('jobs.screen.empty')}</div>
      ) : (
        <div className="flex h-full min-h-0 gap-4">
          <div className="flex w-56 shrink-0 flex-col gap-1 overflow-y-auto">
            {jobs.map((j) => (
              <button
                key={j.id}
                onClick={() => update('jobs', { jobId: j.id })}
                className={`cursor-pointer rounded-lg border px-3 py-2 text-left transition-colors ${
                  j.id === active
                    ? 'border-holo-cyan/50 bg-holo-cyan/5'
                    : 'border-holo-line hover:border-holo-cyan/25'
                }`}
              >
                <div className="truncate text-xs text-holo-text">{j.title}</div>
                <div className={`font-mono text-[9px] tracking-wider ${JOB_STATUS_TEXT[j.status]}`}>
                  {j.status.toUpperCase()}
                  <span className="ml-2 text-holo-dim">
                    {new Date(j.startedAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              </button>
            ))}
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-2">
            {job && (
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{job.title}</div>
                  <div className="truncate font-mono text-[9px] text-holo-dim">
                    {job.engine} · {job.cwd} · {t(job.readonly ? 'jobs.card.readOnly' : 'jobs.card.writable')}
                    {job.costUsd ? ` · $${job.costUsd.toFixed(3)}` : ''}
                  </div>
                </div>
                {/* The controls are gathered at the right edge so that justify-between does not scatter them. */}
                <div className="flex shrink-0 items-center gap-2">
                  <CopyLogButton text={logText} />
                  <JobStopButton job={job} className="shrink-0 cursor-pointer rounded-lg border border-holo-red/40 px-3 py-1 font-mono text-[10px] text-holo-red hover:bg-holo-red/10 disabled:opacity-40" />
                </div>
              </div>
            )}
            {/* The app sets user-select: none, so selection is allowed here for the log alone, and the timestamps stay out of it through jl-time. */}
            <div
              ref={logRef}
              className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-holo-line/70 bg-holo-bg/70 p-3 font-mono text-[11px] leading-relaxed select-text"
            >
              <JobLogRows rows={rows} time />
              {log.length === 0 && <span className="text-holo-dim">{t('jobs.screen.emptyLog')}</span>}
            </div>
            {job && <JobArtifacts job={job} />}
          </div>
        </div>
      )}
    </HoloDialog>
  )
}
