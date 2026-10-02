import { useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { Trash2, X } from 'lucide-react'
import { TASK_STATUSES, addDaysKey, type Task, type TaskPatch, type TaskStatus } from '@shared/tasks'
import { relativeTime } from '@/panels/primitives/format'
import { keyForApp } from '@/ui/key-for-app'
import { useT } from '@/i18n'

interface Typed {
  /** The task's value when the typing started. */
  from: string
  text: string
  /** Set once leaving the field sent the text to main. */
  sent?: true
}

interface TaskField {
  value: string
  type: (text: string) => void
  leave: () => void
  /** Throws away what was typed, so that the field shows the task's value again. */
  drop: () => void
}

/**
 * A text field of the editor. It shows the task's current value, so a change made from the conversation
 * appears in it, except while the user is typing in it. Leaving the field saves the text only when it
 * differs from the value the typing started from, and the text stays in the field until the task has it.
 */
function useTaskField(
  value: string,
  { parse, save }: { parse: (text: string) => string | null; save: (text: string) => Promise<boolean> }
): TaskField {
  const [typed, setTyped] = useState<Typed | null>(null)
  // A text sent to main gives way once the task's value changes, by that save or from anywhere else.
  useEffect(() => {
    setTyped((current) => (current?.sent ? null : current))
  }, [value])
  const leave = (): void => {
    if (typed === null || typed.sent) return
    const text = parse(typed.text)
    if (text === null || text === typed.from || text === value) {
      setTyped(null)
      return
    }
    const sent: Typed = { from: typed.from, text, sent: true }
    setTyped(sent)
    void save(text).then((saved) => {
      // A text main did not take stays in the field as typed, and leaving the field again saves it again.
      if (!saved) setTyped((current) => (current === sent ? { from: sent.from, text } : current))
    })
  }
  return {
    value: typed?.text ?? value,
    type: (text) => setTyped((current) => ({ from: current && !current.sent ? current.from : value, text })),
    leave,
    drop: () => setTyped(null)
  }
}

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
  /** Saves a change through main, reporting a failure itself, and resolves to whether it was saved. */
  onChange: (patch: TaskPatch) => Promise<boolean>
  onRemove: () => void
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const title = useTaskField(task.title, { parse: (text) => text.trim() || null, save: (value) => onChange({ title: value }) })
  const notes = useTaskField(task.notes, { parse: (text) => text, save: (value) => onChange({ notes: value }) })
  const setStatus = (status: TaskStatus): void => {
    if (status !== task.status) void onChange({ status })
  }
  const setDue = (due: string | null): void => {
    if (due !== task.due) void onChange({ due })
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
        value={title.value}
        aria-label={t('tasks.editor.title')}
        onChange={(event) => title.type(event.target.value)}
        onBlur={title.leave}
        onKeyDown={(event) => {
          const field = event.currentTarget
          const key = keyForApp(event)
          if (key === 'Enter') field.blur()
          if (key === 'Escape') {
            event.stopPropagation()
            // blur() runs onBlur before React would apply a drop made in this handler, and that onBlur would
            // save the text Escape throws away.
            flushSync(title.drop)
            field.blur()
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
          value={notes.value}
          placeholder={t('tasks.editor.notesPlaceholder')}
          onChange={(event) => notes.type(event.target.value)}
          onBlur={notes.leave}
          onKeyDown={(event) => {
            if (keyForApp(event) === 'Escape') event.stopPropagation()
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
