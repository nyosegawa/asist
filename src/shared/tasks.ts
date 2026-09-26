import { z } from 'zod'
import { isoWithOffset } from './calendar'
import type { Translate } from './i18n'
import { errorText } from './i18n/error-text'
import type { StoredFormat } from './stored-format'
import type { PromptLanguage, PromptText } from './conversation-locale'

/**
 * The shared task schema and the calculations over it. The main process saves tasks.json, and the
 * renderer's board and list, the todo card and the Agent's tools all use the same shape. A task's
 * status is also its column, and there are three: todo, doing and done. The position within a column
 * is `order`, consecutive integers from zero, and only the columns a move touched are renumbered. A
 * due date is a local YYYY-MM-DD date with no time of day.
 */

export const TASK_STATUSES = ['todo', 'doing', 'done'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]
/**
 * The status as the Agent reads it, in the language of the prompt. The task tools name these same
 * words in their descriptions. The screen takes its own labels from `tasks.status` in the dictionary.
 */
export const TASK_STATUS_LABEL: Record<TaskStatus, PromptText> = {
  todo: { ja: 'やること', en: 'to do' },
  doing: { ja: '進行中', en: 'in progress' },
  done: { ja: '完了', en: 'done' }
}

export const MAX_TASKS = 2_000
export const MAX_TASK_TITLE_LENGTH = 200
export const MAX_TASK_NOTES_LENGTH = 5_000

export interface Task {
  id: string
  title: string
  /** A free-form note. An empty string means there is none. */
  notes: string
  status: TaskStatus
  /** The due date as YYYY-MM-DD, or null when the task has none. */
  due: string | null
  /** The position within the task's own status column, counted from zero. */
  order: number
  createdAt: number
  /**
   * When the title, notes, due date or status last changed. Reordering alone does not move it.
   */
  updatedAt: number
  completedAt: number | null
}

export interface TaskSnapshot {
  tasks: Task[]
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const dueSchema = z
  .string()
  .regex(DAY_PATTERN, errorText('tasks.errors.dueFormat'))
  .refine((value) => {
    const [y, m, d] = value.split('-').map(Number)
    const date = new Date(y, m - 1, d)
    return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d
  }, errorText('tasks.errors.dueUnreal'))
const titleSchema = z
  .string({ error: errorText('tasks.errors.titleType') })
  .trim()
  .min(1, errorText('tasks.errors.titleEmpty'))
  .max(MAX_TASK_TITLE_LENGTH, errorText('tasks.errors.titleTooLong', { limit: MAX_TASK_TITLE_LENGTH }))
const notesSchema = z.string().max(MAX_TASK_NOTES_LENGTH, errorText('tasks.errors.notesTooLong', { limit: MAX_TASK_NOTES_LENGTH }))
const statusSchema = z.enum(TASK_STATUSES, { error: errorText('tasks.errors.statusInvalid') })

export const taskInputSchema = z
  .object({
    title: titleSchema,
    notes: notesSchema.default(''),
    due: dueSchema.nullable().default(null),
    status: statusSchema.default('todo')
  })
  .strict()
export type TaskInput = z.input<typeof taskInputSchema>

/** A change to a task. Only the fields present are changed. */
export const taskPatchSchema = z
  .object({
    title: titleSchema.optional(),
    notes: notesSchema.optional(),
    due: dueSchema.nullable().optional(),
    status: statusSchema.optional()
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, errorText('tasks.errors.patchEmpty'))
export type TaskPatch = z.input<typeof taskPatchSchema>

/** A move on the board: put the task at position `index`, counted from zero, of the status column. */
export const taskMoveSchema = z
  .object({
    id: z.string().trim().min(1, errorText('tasks.errors.idRequired')),
    status: statusSchema,
    index: z.number().int().min(0)
  })
  .strict()
export type TaskMove = z.infer<typeof taskMoveSchema>

const storedTaskSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    title: titleSchema,
    notes: notesSchema,
    status: statusSchema,
    due: dueSchema.nullable(),
    order: z.number().int().min(0),
    createdAt: z.number().int().min(0),
    updatedAt: z.number().int().min(0),
    completedAt: z.number().int().min(0).nullable()
  })
  .strict()

export function emptyTaskSnapshot(): TaskSnapshot {
  return { tasks: [] }
}

/**
 * Turns a zod failure into one error for the user. Every message of these schemas carries a message key,
 * and the renderer writes the first one in the language of the interface.
 */
export function parseOrThrow<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  throw new Error(result.error.issues.map((issue) => issue.message).join(' / '))
}

/**
 * Validates what was read from disk strictly: a broken entry is never dropped to make the rest
 * succeed. The order within each column is renumbered after reading, so the writing side does not
 * have to keep the numbers consecutive.
 */
export function parseStoredTaskSnapshot(value: unknown): TaskSnapshot {
  if (!value || typeof value !== 'object') throw new Error(errorText('tasks.errors.storeBroken'))
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.tasks)) throw new Error(errorText('tasks.errors.storeListBroken'))
  if (record.tasks.length > MAX_TASKS) throw new Error(errorText('tasks.errors.storeTooMany', { limit: MAX_TASKS }))
  const tasks = record.tasks.map((item, index) => {
    const parsed = storedTaskSchema.safeParse(item)
    if (!parsed.success)
      throw new Error(errorText('tasks.errors.storeItemBroken', { index: index + 1, message: parsed.error.issues[0]?.message ?? '' }))
    return parsed.data
  })
  const ids = new Set<string>()
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error(errorText('tasks.errors.storeDuplicateId', { id: task.id }))
    ids.add(task.id)
  }
  return { tasks: reindex(tasks) }
}

export const TASKS_FORMAT: StoredFormat<TaskSnapshot> = {
  name: 'tasks.json',
  version: 1,
  upgrades: {},
  parse: parseStoredTaskSnapshot,
  serialize: (snapshot) => ({ tasks: snapshot.tasks })
}

export const cloneTask = (task: Task): Task => ({ ...task })

/** The tasks with that status, in their column order. */
export function columnOf(tasks: readonly Task[], status: TaskStatus): Task[] {
  return tasks.filter((task) => task.status === status).sort(byOrder)
}
const byOrder = (a: Task, b: Task): number => a.order - b.order || a.createdAt - b.createdAt || a.id.localeCompare(b.id)

/** Renumbers `order` from zero within each column without changing the order itself. */
export function reindex(tasks: readonly Task[]): Task[] {
  const out: Task[] = []
  for (const status of TASK_STATUSES) {
    columnOf(tasks, status).forEach((task, order) => out.push(task.order === order ? task : { ...task, order }))
  }
  return out
}

/**
 * Puts the task at position `index` of the status column. Moving between columns also changes the
 * status, and it sets completedAt on entering done and clears it on leaving done.
 */
export function placeTask(tasks: readonly Task[], id: string, status: TaskStatus, index: number, now: number): Task[] {
  const current = tasks.find((task) => task.id === id)
  if (!current) throw new Error(errorText('tasks.errors.notFound'))
  const moved = transition(current, status, now)
  const target = columnOf(tasks, status).filter((task) => task.id !== id)
  const at = Math.max(0, Math.min(index, target.length))
  target.splice(at, 0, moved)
  const rest = tasks.filter((task) => task.status !== status && task.id !== id)
  return reindex([...rest, ...target.map((task, order) => ({ ...task, order }))])
}

/** Changes only the status, putting the task at the end of the column it moves into. */
export function withStatus(tasks: readonly Task[], id: string, status: TaskStatus, now: number): Task[] {
  const current = tasks.find((task) => task.id === id)
  if (!current) throw new Error(errorText('tasks.errors.notFound'))
  if (current.status === status) return [...tasks]
  return placeTask(tasks, id, status, Number.MAX_SAFE_INTEGER, now)
}

function transition(task: Task, status: TaskStatus, now: number): Task {
  if (task.status === status) return task
  return {
    ...task,
    status,
    updatedAt: now,
    completedAt: status === 'done' ? now : null
  }
}

/** Builds a new task from the input, placed at the end of its column. */
export function buildTask(tasks: readonly Task[], input: z.output<typeof taskInputSchema>, id: string, now: number): Task {
  return {
    id,
    title: input.title,
    notes: input.notes,
    status: input.status,
    due: input.due,
    order: columnOf(tasks, input.status).length,
    createdAt: now,
    updatedAt: now,
    completedAt: input.status === 'done' ? now : null
  }
}

/** Applies the change. When the status changes, the task goes to the end of the new column. */
export function applyTaskPatch(tasks: readonly Task[], id: string, patch: z.output<typeof taskPatchSchema>, now: number): Task[] {
  const current = tasks.find((task) => task.id === id)
  if (!current) throw new Error(errorText('tasks.errors.notFound'))
  const moved = patch.status !== undefined && patch.status !== current.status ? withStatus(tasks, id, patch.status, now) : [...tasks]
  return moved.map((task) =>
    task.id !== id
      ? task
      : {
          ...task,
          title: patch.title ?? task.title,
          notes: patch.notes ?? task.notes,
          due: patch.due === undefined ? task.due : patch.due,
          updatedAt: now
        }
  )
}

export type DueState = 'overdue' | 'today' | 'tomorrow' | 'week' | 'later'

const pad = (n: number): string => String(n).padStart(2, '0')
/** The device's local date as YYYY-MM-DD. */
export const dayKeyOf = (date: Date): string => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
export function parseDayKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}
export const addDaysKey = (key: string, days: number): string => {
  const date = parseDayKey(key)
  date.setDate(date.getDate() + days)
  return dayKeyOf(date)
}
/** The difference between two dates in days. It is positive when b is the later one. */
export const daysBetweenKeys = (a: string, b: string): number =>
  Math.round((parseDayKey(b).getTime() - parseDayKey(a).getTime()) / 86_400_000)

export function dueState(due: string | null, today: string): DueState | null {
  if (!due) return null
  if (due < today) return 'overdue'
  if (due === today) return 'today'
  const days = daysBetweenKeys(today, due)
  if (days === 1) return 'tomorrow'
  if (days <= 7) return 'week'
  return 'later'
}

/**
 * A relative label such as "今日", "明日", "昨日", "3日前" or "5日後". Anything further out is written
 * as a date, as in "9/20(日)", and the year is added only when it differs from today's.
 */
export function dueLabel(due: string, today: string, t: Translate, locale: string): string {
  const days = daysBetweenKeys(today, due)
  if (days === 0) return t('tasks.due.today')
  if (days === 1) return t('tasks.due.tomorrow')
  if (days === -1) return t('tasks.due.yesterday')
  if (days < 0 && days >= -13) return t('tasks.due.daysAgo', { count: -days })
  if (days > 1 && days <= 7) return t('tasks.due.inDays', { count: days })
  const date = parseDayKey(due)
  const sameYear = date.getFullYear() === parseDayKey(today).getFullYear()
  return date.toLocaleDateString(locale, { year: sameYear ? undefined : 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' })
}

/** The unfinished tasks, doing before todo, each group in its column order. */
export function openTasks(tasks: readonly Task[]): Task[] {
  return [...columnOf(tasks, 'doing'), ...columnOf(tasks, 'todo')]
}

/**
 * Reduces a title to the form used to decide whether two titles are the same, ignoring differences in
 * character width, letter case and runs of whitespace.
 */
export const titleIdentity = (title: string): string =>
  title.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('ja')

/**
 * The shape returned to the Agent. It always carries the id, the status and the due date. The time a
 * task was finished is local time with its offset, as the calendar and mail give theirs: the utterance
 * carries local time, so a UTC stamp would put a task finished at 0:30 in Japan on the day before.
 */
export function taskSummary(task: Task, language: PromptLanguage): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    statusLabel: TASK_STATUS_LABEL[task.status][language],
    due: task.due,
    ...(task.notes ? { notes: task.notes } : {}),
    ...(task.completedAt
      ? { completedAt: isoWithOffset(task.completedAt, Intl.DateTimeFormat().resolvedOptions().timeZone) }
      : {})
  }
}
