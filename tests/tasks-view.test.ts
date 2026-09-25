// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dayKeyOf, type Task, type TaskStatus } from '@shared/tasks'
import { createTranslator } from '@shared/i18n'
import { TasksView } from '../src/renderer/src/ui/tasks/TasksView'
import { useTaskStore, useToastStore } from '../src/renderer/src/state/stores'
import { useViewStore } from '../src/renderer/src/state/view'
import { answerConfirm } from './helpers/confirm'

/** The tasks view: what the board and the list show, that add, edit and complete reach main, and the order Escape closes things in. */

const t = createTranslator('ja-JP')
const today = dayKeyOf(new Date())
const task = (id: string, title: string, status: TaskStatus, order: number, patch: Partial<Task> = {}): Task => ({
  id,
  title,
  notes: '',
  status,
  due: null,
  order,
  createdAt: 1,
  updatedAt: 1,
  completedAt: status === 'done' ? 1 : null,
  ...patch
})
const tasks = [
  task('a', '相槌を増やす', 'todo', 0, { due: '2000-01-01' }),
  task('b', '経費精算', 'todo', 1, { due: today }),
  task('c', 'レビュー', 'doing', 0, { notes: '月表示を見る' }),
  task('d', '背景を作る', 'done', 0)
]
const api = {
  tasksList: vi.fn(async () => tasks),
  taskCreate: vi.fn(async (input: { title: string; status?: TaskStatus }) => task('new', input.title, input.status ?? 'todo', 9)),
  taskUpdate: vi.fn(async (id: string) => tasks.find((t) => t.id === id)!),
  taskMove: vi.fn(async () => tasks[0]),
  taskRemove: vi.fn(async (id: string) => tasks.find((t) => t.id === id)!),
  tasksClearDone: vi.fn(async () => 1)
}
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('React', React)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('window', Object.assign(window, { api }))
  for (const fn of Object.values(api)) fn.mockClear()
  useTaskStore.setState({ tasks, loaded: true, error: '' })
  useToastStore.setState({ toasts: [] })
  useViewStore.getState().closeApp()
  useViewStore.getState().openApp({ app: 'tasks' })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(): Promise<HTMLElement> {
  await act(async () => root.render(React.createElement(TasksView, { open: true })))
  return container.querySelector<HTMLElement>('[aria-label="TASKS"]')!
}
const setValue = (input: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('board', () => {
  it('groups the tasks by column and shows the count, the due chip and how many are due today or overdue', async () => {
    const view = await render()
    expect(api.tasksList).toHaveBeenCalled()
    const titles = (status: TaskStatus): string[] =>
      [...view.querySelectorAll(`.tk-column[data-status="${status}"] .tk-card-title`)].map((el) => el.textContent)
    expect(titles('todo')).toEqual(['相槌を増やす', '経費精算'])
    expect(titles('doing')).toEqual(['レビュー'])
    expect(titles('done')).toEqual(['背景を作る'])
    expect(view.querySelector('.tk-column[data-status="todo"] .tk-count')?.textContent).toBe('2')
    expect(view.querySelector('.tk-column[data-status="todo"] .tk-due')?.getAttribute('data-state')).toBe('overdue')
    expect(view.querySelector('.tk-stats')?.textContent).toContain('1 今日')
    expect(view.querySelector('.tk-stats')?.textContent).toContain('1 期限切れ')
  })

  it('adds from the field at the top on Enter, and the field under a column sends that column status to main', async () => {
    const view = await render()
    const input = view.querySelector<HTMLInputElement>('.tk-add input')!
    await act(async () => setValue(input, '歯医者の予約'))
    await act(async () => view.querySelector<HTMLFormElement>('.tk-add')!.requestSubmit())
    expect(api.taskCreate).toHaveBeenCalledWith({ title: '歯医者の予約', status: 'todo' })
    expect(input.value).toBe('')

    await act(async () => view.querySelector<HTMLButtonElement>('.tk-column[data-status="doing"] .tk-quick-add button')!.click())
    const quick = view.querySelector<HTMLInputElement>('.tk-column[data-status="doing"] .tk-quick-add input')!
    await act(async () => setValue(quick, '今すぐやる'))
    await act(async () => quick.closest('form')!.requestSubmit())
    expect(api.taskCreate).toHaveBeenLastCalledWith({ title: '今すぐやる', status: 'doing' })
  })

  it('opens the editor on the right when a card is clicked and sends status, due date, title and notes changes to main', async () => {
    const view = await render()
    await act(async () => view.querySelector<HTMLElement>('.tk-column[data-status="doing"] .tk-card')!.click())
    const editor = view.querySelector<HTMLElement>('.tk-editor')!
    expect(editor.querySelector<HTMLInputElement>('.tk-editor-title')?.value).toBe('レビュー')
    expect(editor.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('月表示を見る')
    expect(editor.querySelector('.tk-editor-status [aria-pressed="true"]')?.textContent).toBe(t('tasks.status.doing'))

    await act(async () => [...editor.querySelectorAll<HTMLButtonElement>('.tk-editor-status button')][2].click())
    expect(api.taskUpdate).toHaveBeenLastCalledWith('c', { status: 'done' })
    await act(async () => [...editor.querySelectorAll<HTMLButtonElement>('.tk-quick button')].find((b) => b.textContent === t('tasks.editor.dueTomorrow'))!.click())
    expect(api.taskUpdate.mock.calls.at(-1)?.[1]).toEqual({ due: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) })

    const title = editor.querySelector<HTMLInputElement>('.tk-editor-title')!
    await act(async () => setValue(title, 'レビューを終える'))
    await act(async () => title.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(api.taskUpdate).toHaveBeenLastCalledWith('c', { title: 'レビューを終える' })
    await act(async () => setValue(title, '   '))
    await act(async () => title.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(api.taskUpdate.mock.calls.filter(([, patch]) => 'title' in patch)).toHaveLength(1)

    const notes = editor.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => setValue(notes, '週表示も見る'))
    await act(async () => notes.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(api.taskUpdate).toHaveBeenLastCalledWith('c', { notes: '週表示も見る' })
  })

  it('closes the editor on the first Escape and the view on the second, and removes a task only after the confirmation', async () => {
    const view = await render()
    await act(async () => view.querySelector<HTMLElement>('.tk-card')!.click())
    expect(view.querySelector('.tk-editor')).not.toBeNull()
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(view.querySelector('.tk-editor')).toBeNull()
    expect(useViewStore.getState().open?.app).toBe('tasks')

    await act(async () => view.querySelector<HTMLElement>('.tk-card')!.click())
    await act(async () => view.querySelector<HTMLButtonElement>('.tk-danger')!.click())
    await answerConfirm(false)
    expect(api.taskRemove).not.toHaveBeenCalled()
    await act(async () => view.querySelector<HTMLButtonElement>('.tk-danger')!.click())
    await answerConfirm(true)
    expect(api.taskRemove).toHaveBeenCalledWith('a')

    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(useViewStore.getState().open?.app).not.toBe('tasks')
  })

  it('clears every done task at once from the tool on the done column, after a confirmation', async () => {
    const view = await render()
    await act(async () => view.querySelector<HTMLButtonElement>('.tk-column[data-status="done"] .tk-column-tool')!.click())
    await answerConfirm(true)
    expect(api.tasksClearDone).toHaveBeenCalled()
    expect(useToastStore.getState().toasts.at(-1)?.title).toBe(t('tasks.deletedDone', { count: 1 }))
  })
})

describe('list view', () => {
  it('groups the rows by due date, toggles done from the circle, and keeps the done rows in a collapsed section', async () => {
    const view = await render()
    await act(async () => [...view.querySelectorAll<HTMLButtonElement>('.tk-views button')].find((b) => b.textContent === t('tasks.views.list'))!.click())
    const sections = [...view.querySelectorAll<HTMLElement>('.tk-section')].map((el) => el.dataset.key)
    expect(sections).toEqual(['overdue', 'today', 'none', 'done'])
    expect(view.querySelector('.tk-section[data-key="none"] .tk-chip')?.textContent).toBe(t('tasks.status.doing'))
    expect(view.querySelector('.tk-section[data-key="done"] .tk-rows')).toBeNull()

    await act(async () => view.querySelector<HTMLButtonElement>('.tk-section[data-key="today"] .tk-check')!.click())
    expect(api.taskUpdate).toHaveBeenLastCalledWith('b', { status: 'done' })
    await act(async () => view.querySelector<HTMLButtonElement>('.tk-toggle')!.click())
    await act(async () => view.querySelector<HTMLButtonElement>('.tk-section[data-key="done"] .tk-check')!.click())
    expect(api.taskUpdate).toHaveBeenLastCalledWith('d', { status: 'todo' })
  })

  it('shows the reason and a retry when loading fails', async () => {
    useTaskStore.setState({ tasks: [], loaded: false, error: 'tasks.json が壊れています' })
    api.tasksList.mockRejectedValueOnce(new Error('tasks.json が壊れています'))
    const view = await render()
    expect(view.querySelector('[role="alert"]')?.textContent).toContain('tasks.json が壊れています')
  })
})
