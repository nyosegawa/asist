import { useState } from 'react'
import { AlignLeft, ChevronDown, ChevronRight } from 'lucide-react'
import { columnOf, dueState, openTasks, type DueState, type Task } from '@shared/tasks'
import { DueChip } from './DueChip'
import { useT, useFormatLocale } from '@/i18n'

/**
 * The list. Open tasks are grouped by how close their due date is, and finished ones go into a
 * folded section. Pressing the circle finishes a task, or reopens one that is already finished, and
 * pressing the row opens the editor on the right.
 */

const SECTIONS: Array<DueState | 'none'> = ['overdue', 'today', 'tomorrow', 'week', 'later', 'none']

export function ListView({
  tasks,
  today,
  selectedId,
  onSelect,
  onToggleDone
}: {
  tasks: Task[]
  today: string
  selectedId: string | null
  onSelect: (id: string | null) => void
  onToggleDone: (task: Task) => void
}): React.JSX.Element {
  const t = useT()
  const locale = useFormatLocale()
  const [doneOpen, setDoneOpen] = useState(false)
  const open = openTasks(tasks).sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'))
  const grouped = new Map<DueState | 'none', Task[]>()
  for (const task of open) {
    const key = dueState(task.due, today) ?? 'none'
    grouped.set(key, [...(grouped.get(key) ?? []), task])
  }
  const done = columnOf(tasks, 'done').sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
  const row = (task: Task): React.JSX.Element => (
    <li key={task.id} className="tk-row" data-status={task.status} data-selected={task.id === selectedId || undefined}>
      <button
        type="button"
        className="tk-check"
        data-status={task.status}
        aria-label={task.status === 'done' ? t('tasks.list.markOpen') : t('tasks.list.markDone')}
        title={task.status === 'done' ? t('tasks.list.markOpen') : t('tasks.list.markDone')}
        onClick={() => onToggleDone(task)}
      />
      <button type="button" className="tk-row-main" onClick={() => onSelect(task.id === selectedId ? null : task.id)}>
        <span className="tk-row-title">{task.title}</span>
        <span className="tk-row-meta">
          {task.notes && <AlignLeft size={12} aria-label={t('tasks.notes')} />}
          {task.status === 'doing' && <span className="tk-chip">{t('tasks.status.doing')}</span>}
          {task.status === 'done' && task.completedAt ? (
            <span className="tk-due" data-state="done">
              {t('tasks.list.completedAt', { date: new Date(task.completedAt).toLocaleDateString(locale, { month: 'numeric', day: 'numeric' }) })}
            </span>
          ) : (
            <DueChip due={task.due} today={today} />
          )}
        </span>
      </button>
    </li>
  )
  return (
    <div className="tk-list">
      {open.length === 0 && (
        <p className="tk-notice">
          {t('tasks.list.empty')}
          <small>{t('tasks.list.emptyHint')}</small>
        </p>
      )}
      {SECTIONS.filter((section) => grouped.has(section)).map((section) => (
        <section key={section} className="tk-section" data-key={section} aria-label={t(`tasks.list.${section}`)}>
          <h3>
            {t(`tasks.list.${section}`)} <b>{grouped.get(section)!.length}</b>
          </h3>
          <ul className="tk-rows">{grouped.get(section)!.map(row)}</ul>
        </section>
      ))}
      {done.length > 0 && (
        <section className="tk-section" data-key="done" aria-label={t('tasks.list.done')}>
          <h3>
            <button type="button" className="tk-toggle" aria-expanded={doneOpen} onClick={() => setDoneOpen((open) => !open)}>
              {doneOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {t('tasks.list.done')} <b>{done.length}</b>
            </button>
          </h3>
          {doneOpen && <ul className="tk-rows">{done.slice(0, 100).map(row)}</ul>}
        </section>
      )}
    </div>
  )
}
