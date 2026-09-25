import mitt from 'mitt'
import type { Task } from '@shared/tasks'
import { createTaskService, type TaskService } from './tasks'
import { dataPath } from './store'

let service: TaskService | null = null
/** Carries every task after a save has completed, and ipc relays it to the renderer. */
export const events = mitt<{ changed: Task[] }>()

/** The shared instance, created on first use so that the userData path is resolved only after app ready. */
export function getTaskService(): TaskService {
  return (service ??= createTaskService({
    filePath: dataPath('tasks.json'),
    onChanged: (tasks) => events.emit('changed', tasks)
  }))
}
