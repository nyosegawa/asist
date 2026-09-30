import type { ReactNode } from 'react'
import { CircleAlert } from 'lucide-react'
import { useT } from '@/i18n'
import { progressLabel } from '../progress-label'
import type { PreparationTarget, SettingsContext } from './context'
import { Btn, Progress } from './primitives'

/**
 * A preparation shown under the row that needs it: what is missing, the button that fetches it, and the
 * progress while it runs. Only one preparation runs at a time, so every button waits while one is busy.
 */
export function PrepLine({ text, children, progress }: { text: string; children: ReactNode; progress?: ReactNode }): React.JSX.Element {
  return (
    <div className="st-prepline">
      <CircleAlert size={14} aria-hidden />
      <span className="st-prepline-text">{text}</span>
      <div className="st-prepline-actions">{children}</div>
      {progress}
    </div>
  )
}

/** The button that starts one preparation, and the button that stops it where it can be stopped. */
export function PrepareButton({
  ctx,
  target,
  onClick,
  onCancel,
  label
}: {
  ctx: SettingsContext
  target: PreparationTarget
  onClick: () => void
  onCancel?: () => void
  label?: string
}): React.JSX.Element {
  const t = useT()
  const preparing = ctx.prep.busy && ctx.prep.target === target
  return (
    <>
      <Btn tone="primary" data-prep={target} disabled={ctx.prep.busy} onClick={onClick}>
        {preparing ? t('common.preparing') : (label ?? t('settingsModels.prepare'))}
      </Btn>
      {preparing && onCancel && (
        <Btn tone="quiet" onClick={onCancel}>
          {t('common.stop')}
        </Btn>
      )}
    </>
  )
}

/** The progress of the preparation of `target`, or nothing while another one or none runs. */
export function PrepProgress({ ctx, target }: { ctx: SettingsContext; target: PreparationTarget }): React.JSX.Element | null {
  const { prep } = ctx
  if (!(prep.busy && prep.target === target && prep.progress)) return null
  return <Progress percent={prep.progress.pct ?? 0} label={progressLabel(prep.progress)} />
}
