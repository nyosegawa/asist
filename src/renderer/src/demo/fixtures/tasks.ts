import { addDaysKey, dayKeyOf, type Task, type TaskStatus } from '@shared/tasks'

/**
 * The fixed task data. Due dates are built relative to the day the demo runs, so that both the board and
 * the list always show at least one task that is overdue, one due today, one due tomorrow, one due this
 * week, one due later and one with no due date.
 */
const today = dayKeyOf(new Date())
const day = (n: number): string => addDaysKey(today, n)
const HOUR = 3_600_000
const now = Date.now()

const make = (id: string, title: string, status: TaskStatus, order: number, patch: Partial<Task> = {}): Task => ({
  id,
  title,
  notes: '',
  status,
  due: null,
  order,
  createdAt: now - 3 * 24 * HOUR,
  updatedAt: now - 2 * HOUR,
  completedAt: null,
  ...patch
})

export const DEMO_TASKS: Task[] = [
  make('task-1', '提案書の下書きを仕上げる', 'doing', 0, { due: today, notes: '比較の節は済み。残りは結論のページ。' }),
  make('task-2', '予約画面のレビューのメモに返事をする', 'doing', 1, { due: day(1) }),
  make('task-3', '競合サービスの料金を調べ直す', 'todo', 0, { due: day(-2) }),
  make('task-4', '経費精算を出す', 'todo', 1, { due: today }),
  make('task-5', '歯医者の予約', 'todo', 2, { due: day(1) }),
  make('task-6', '歓迎会の店を予約する', 'todo', 3, { due: day(4) }),
  make('task-7', '来期の企画の一覧を作る', 'todo', 4, { due: day(12), notes: '大川さんとの打ち合わせで出た三つの案から始める。' }),
  make('task-8', '実家に送る荷物をまとめる', 'todo', 5),
  make('task-9', '採用面談の候補日を返す', 'done', 0, { completedAt: now - 26 * HOUR, updatedAt: now - 26 * HOUR }),
  make('task-10', 'USB-C ケーブルを注文する', 'done', 1, { completedAt: now - 50 * HOUR, updatedAt: now - 50 * HOUR }),
  make('task-11', '定例の議事録を共有する', 'done', 2, { completedAt: now - 3 * 24 * HOUR, updatedAt: now - 3 * 24 * HOUR })
]
