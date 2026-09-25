import { useState } from 'react'
import { Trash2, X } from 'lucide-react'
import { TASK_STATUSES, addDaysKey, type Task, type TaskPatch, type TaskStatus } from '@shared/tasks'
import { relativeTime } from '@/panels/primitives/format'
import { useT } from '@/i18n'

/**
 * The editor on the right. The title and the notes are saved when the field loses focus, while the
 * status and the due date are saved the moment they are pressed. The parent gives it key={task.id},
 * so selecting another task builds it anew.
 */
export function Editor({
  task,
  today,
  onChange,
  onRemove,
  onClose
}: {
  task: Task
  today: string
  onChange: (patch: TaskPatch) => void
  onRemove: () => void
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const [title, setTitle] = useState(task.title)
  const [notes, setNotes] = useState(task.notes)
  const commitTitle = (): void => {
    const value = title.trim()
    if (!value) {
      setTitle(task.title)
      return
    }
    if (value !== task.title) onChange({ title: value })
  }
  const commitNotes = (): void => {
    if (notes !== task.notes) onChange({ notes })
  }
  const setStatus = (status: TaskStatus): void => {
    if (status !== task.status) onChange({ status })
  }
  const setDue = (due: string | null): void => {
    if (due !== task.due) onChange({ due })
  }
  const quick: Array<[string, string | null]> = [
    [t('tasks.editor.dueToday'), today],
    [t('tasks.editor.dueTomorrow'), addDaysKey(today, 1)],
    [t('tasks.editor.dueNextWeek'), addDaysKey(today, 7)],
    [t('tasks.editor.dueNone'), null]
  ]
  return (
    <aside className="tk-editor" aria-label={t('tasks.editor.label')}>
      <div className="tk-editor-head">
        <div className="tk-editor-status" role="group" aria-label={t('tasks.editor.status')}>
          {TASK_STATUSES.map((status) => (
            <button key={status} type="button" aria-pressed={task.status === status} onClick={() => setStatus(status)}>
              {t(`tasks.status.${status}`)}
            </button>
          ))}
        </div>
        <button type="button" className="tk-editor-close" aria-label={t('tasks.editor.close')} onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <input
        className="tk-editor-title"
        value={title}
        aria-label={t('tasks.editor.title')}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={commitTitle}
        onKeyDown={(event) => {
          if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
          if (event.key === 'Escape') {
            event.stopPropagation()
            setTitle(task.title)
            ;(event.target as HTMLInputElement).blur()
          }
        }}
      />
      <div className="tk-field">
        <label htmlFor={`due-${task.id}`}>{t('tasks.editor.due')}</label>
        <input
          id={`due-${task.id}`}
          type="date"
          value={task.due ?? ''}
          onChange={(event) => setDue(event.target.value || null)}
        />
        <div className="tk-quick" role="group" aria-label={t('tasks.editor.dueChoices')}>
          {quick.map(([label, value]) => (
            <button key={label} type="button" aria-pressed={task.due === value} onClick={() => setDue(value)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="tk-field">
        <label htmlFor={`notes-${task.id}`}>{t('tasks.editor.notes')}</label>
        <textarea
          id={`notes-${task.id}`}
          value={notes}
          placeholder={t('tasks.editor.notesPlaceholder')}
          onChange={(event) => setNotes(event.target.value)}
          onBlur={commitNotes}
          onKeyDown={(event) => {
            if (event.key === 'Escape') event.stopPropagation()
          }}
        />
      </div>
      <dl className="tk-editor-meta">
        <div>
          <dt>{t('tasks.editor.createdAt')}</dt>
          <dd>{relativeTime(task.createdAt)}</dd>
        </div>
        <div>
          <dt>{t('tasks.editor.updatedAt')}</dt>
          <dd>{relativeTime(task.updatedAt)}</dd>
        </div>
        {task.completedAt && (
          <div>
            <dt>{t('tasks.editor.completedAt')}</dt>
            <dd>{relativeTime(task.completedAt)}</dd>
          </div>
        )}
      </dl>
      <div className="tk-editor-foot">
        <button type="button" className="tk-danger" onClick={onRemove}>
          <Trash2 size={14} /> {t('common.delete')}
        </button>
      </div>
    </aside>
  )
}
