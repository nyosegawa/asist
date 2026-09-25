import { dueLabel, dueState, parseDayKey } from '@shared/tasks'
import { useT, useFormatLocale } from '@/i18n'

/** The due-date chip: red when overdue, orange today, light blue tomorrow, quiet further out, and colorless once the task is done. */
export function DueChip({ due, today, done }: { due: string | null; today: string; done?: boolean }): React.JSX.Element | null {
  const t = useT()
  const locale = useFormatLocale()
  if (!due) return null
  const full = parseDayKey(due).toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })
  return (
    <span className="tk-due" data-state={done ? 'done' : dueState(due, today)} title={t('tasks.due.title', { date: full })}>
      {dueLabel(due, today, t, locale)}
    </span>
  )
}
