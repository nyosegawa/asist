import { useState } from 'react'
import type { AgentJob } from '@shared/ipc'
import { useT } from '@/i18n'
import { useToastStore } from '@/state/stores'

/** Asks a job to stop, or confirms the stop of a job restored after a restart, from the job card and from the job list. */
export function JobStopButton({ job, className }: { job: AgentJob; className: string }): React.JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const t = useT()
  const toast = useToastStore((state) => state.push)
  if (job.status !== 'running' && !(job.status === 'stopping' && job.processIdentity)) return null
  const stop = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.api.jobCancel(job.id)
    } catch (error) {
      toast({ kind: 'error', title: t('jobs.stop.failed'), body: String(error) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <button disabled={busy} onClick={() => void stop()} className={className}>
      {t(job.status === 'stopping' ? 'jobs.stop.retry' : 'common.stop')}
    </button>
  )
}
