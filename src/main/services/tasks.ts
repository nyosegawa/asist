import { randomUUID } from 'node:crypto'
import { errorText } from '@shared/i18n/error-text'
import {
  MAX_TASKS,
  TASKS_FORMAT,
  applyTaskPatch,
  buildTask,
  cloneTask,
  emptyTaskSnapshot,
  parseOrThrow,
  placeTask,
  reindex,
  taskInputSchema,
  taskMoveSchema,
  taskPatchSchema,
  type Task,
  type TaskSnapshot
} from '@shared/tasks'
import { storedContent } from '@shared/stored-format'
import { readJsonFile, writeJsonFileAtomic } from './atomic-json'
import { openStoredFile } from './stored-file'

export interface TaskServiceOptions {
  /** Normally tasks.json inside app.getPath('userData'). */
  filePath: string
  now?: () => number
  createId?: () => string
  /** Receives every task once a save has completed, and feeds the renderer's board and cards. */
  onChanged?: (tasks: Task[]) => void
}

export interface TaskService {
  list(): Promise<Task[]>
  create(input: unknown, signal?: AbortSignal): Promise<Task>
  update(id: string, patch: unknown, signal?: AbortSignal): Promise<Task>
  move(move: unknown, signal?: AbortSignal): Promise<Task>
  remove(id: string, signal?: AbortSignal): Promise<Task>
  /** Removes the tasks that are done and returns how many were removed. */
  clearDone(signal?: AbortSignal): Promise<number>
}

/**
 * The store in main that keeps the tasks in a single JSON file. Every operation goes through one queue
 * and runs serially, and a write answers only after the temporary file has been renamed into place. A
 * failed write leaves the in-memory state where it was.
 */
export function createTaskService(options: TaskServiceOptions): TaskService {
  if (!options.filePath.trim()) throw new Error('tasks file path is required')
  const now = options.now ?? Date.now
  const createId = options.createId ?? randomUUID
  let loaded = false
  let snapshot = emptyTaskSnapshot()
  let tail: Promise<void> = Promise.resolve()

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation)
    tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
  const ensureLoaded = async (): Promise<void> => {
    if (loaded) return
    const raw = await readJsonFile(options.filePath)
    snapshot = raw === null ? emptyTaskSnapshot() : await openStoredFile(options.filePath, raw, TASKS_FORMAT)
    loaded = true
  }
  const commit = async (tasks: Task[], signal?: AbortSignal): Promise<void> => {
    const next: TaskSnapshot = { tasks }
    await writeJsonFileAtomic(options.filePath, storedContent(TASKS_FORMAT, next), signal)
    snapshot = next
    try {
      options.onChanged?.(snapshot.tasks.map(cloneTask))
    } catch (error) {
      console.warn('task change listener failed:', error)
    }
  }
  const find = (id: string): Task => {
    const task = snapshot.tasks.find((candidate) => candidate.id === id)
    if (!task) throw new Error(errorText('tasks.errors.notFound'))
    return task
  }
  const stamp = (): number => {
    const at = now()
    if (!Number.isSafeInteger(at) || at < 0) throw new Error('clock returned an invalid timestamp')
    return at
  }
  const write = <T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> =>
    enqueue(async () => {
      signal?.throwIfAborted()
      await ensureLoaded()
      signal?.throwIfAborted()
      return operation()
    })

  return {
    list: () =>
      enqueue(async () => {
        await ensureLoaded()
        return snapshot.tasks.map(cloneTask)
      }),

    create: (value, signal) =>
      write(signal, async () => {
        const input = parseOrThrow(taskInputSchema, value)
        if (snapshot.tasks.length >= MAX_TASKS) throw new Error(errorText('tasks.errors.limit', { limit: MAX_TASKS }))
        const task = buildTask(snapshot.tasks, input, uniqueId(snapshot.tasks, createId), stamp())
        await commit([...snapshot.tasks, task], signal)
        return cloneTask(task)
      }),

    update: (id, value, signal) =>
      write(signal, async () => {
        const patch = parseOrThrow(taskPatchSchema, value)
        const current = find(normalizeId(id))
        await commit(applyTaskPatch(snapshot.tasks, current.id, patch, stamp()), signal)
        return cloneTask(find(current.id))
      }),

    move: (value, signal) =>
      write(signal, async () => {
        const move = parseOrThrow(taskMoveSchema, value)
        await commit(placeTask(snapshot.tasks, move.id, move.status, move.index, stamp()), signal)
        return cloneTask(find(move.id))
      }),

    remove: (id, signal) =>
      write(signal, async () => {
        const task = find(normalizeId(id))
        await commit(reindex(snapshot.tasks.filter((candidate) => candidate.id !== task.id)), signal)
        return cloneTask(task)
      }),

    clearDone: (signal) =>
      write(signal, async () => {
        const done = snapshot.tasks.filter((task) => task.status === 'done').length
        if (done === 0) return 0
        await commit(snapshot.tasks.filter((task) => task.status !== 'done'), signal)
        return done
      })
  }
}

function uniqueId(tasks: readonly Task[], createId: () => string): string {
  const used = new Set(tasks.map((task) => task.id))
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const id = createId().trim()
    if (id && id.length <= 200 && !used.has(id)) return id
  }
  throw new Error(errorText('tasks.errors.createFailed'))
}

function normalizeId(value: string): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id) throw new Error(errorText('tasks.errors.idRequired'))
  return id
}
