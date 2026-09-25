import type { PromptLanguage, PromptText } from './conversation-locale'
import type { JobStatus, JobMergeState } from './ipc'
import { isJobExecuting } from './job-status'

/**
 * Naming of the workspace directory of a job, for example `20260717-153045-リポジトリ調査`.
 */

const pad = (n: number): string => String(n).padStart(2, '0')

export function workspaceDirName(title: string, at: Date): string {
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  const slug = title.slice(0, 24).replace(/[^\w\u3040-\u30ff\u4e00-\u9faf-]/g, '_') || 'job'
  return `${stamp}-${slug}`
}

export interface JobAccessInput {
  /** A cwd was named, so the job targets an existing directory such as a repository. */
  explicitCwd: boolean
  /** What the LLM asked for; undefined when it said nothing. */
  readonlyInput?: boolean
  /** What the `agentMode` setting means when the LLM says nothing. */
  defaultReadonly: boolean
  /** The named cwd sits inside a git repository, so the job can be isolated in a worktree. */
  gitRepo?: boolean
}

export interface JobAccess {
  readonly: boolean
  /** The job runs in a git worktree cut from the named repository, and its changes wait to be merged. */
  isolate: boolean
}

/**
 * A job with no cwd runs in a workspace of its own and may always write there, because that is where
 * it puts its report or other output. Writing into an existing directory named by cwd is isolated in
 * a worktree when that directory is a git repository, and happens in place when it is not. None of
 * this decides whether the job may start: the workspace is only the starting directory, and a writing
 * agent is not confined to it, so every job the conversation model asks for is shown to the user first.
 */
export function resolveJobAccess(input: JobAccessInput): JobAccess {
  if (!input.explicitCwd) return { readonly: false, isolate: false }
  const readonly = input.readonlyInput ?? input.defaultReadonly
  if (readonly) return { readonly, isolate: false }
  return { readonly: false, isolate: Boolean(input.gitRepo) }
}

export function worktreeBranchName(dirName: string): string {
  return `asist/${dirName}`
}

export interface JobContextItem {
  id: string
  title: string
  status: JobStatus
  engine: string
  startedAt: number
  endedAt?: number
  summary?: string
  /** It is 'pending' while the worktree's changes wait to be merged, which keeps a finished job in the context block. */
  mergeState?: JobMergeState
}

const RECENT_WINDOW_MS = 30 * 60_000
const minutes = (ms: number): number => Math.max(1, Math.round(ms / 60_000))

export interface RecentProjectItem {
  name: string
  path: string
}

/**
 * The status block injected every turn, outside the last cache breakpoint of the system prompt. The
 * conversation history keeps only spoken text, because tool results disappear across turns, so
 * without this block the LLM does not know a job is running and starts the same one again. The
 * recently used projects, by name and path, sit in the same block so that the user can point at a
 * place with "いつもの" or "さっきの".
 */
export function formatJobContextBlock(
  jobs: JobContextItem[],
  now: number,
  language: PromptLanguage,
  projects: RecentProjectItem[] = []
): string | null {
  const say = (text: PromptText): string => text[language]
  const awaitingMerge = (j: JobContextItem): boolean => j.mergeState === 'pending'
  const active = jobs.filter((j) => isJobExecuting(j.status) || awaitingMerge(j))
  const recent = jobs
    .filter((j) => !awaitingMerge(j))
    .filter((j) => j.endedAt !== undefined && now - j.endedAt < RECENT_WINDOW_MS)
    .filter((j) => j.status === 'done' || j.status === 'error' || j.status === 'cancelled')
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, 5)
  const projectLines =
    projects.length > 0
      ? [say(TEXTS.projectsHeading), ...projects.map((p) => `- ${p.name}: ${p.path}`)]
      : []
  if (active.length === 0 && recent.length === 0) return projectLines.length > 0 ? projectLines.join('\n') : null

  const lines: string[] = [say(TEXTS.jobsHeading)]
  for (const j of active) {
    const label = awaitingMerge(j)
      ? say(TEXTS.awaitingMerge)
      : j.status === 'stopping'
        ? say(TEXTS.stopping)
        : say(TEXTS.running(minutes(now - j.startedAt)))
    lines.push(`- [${j.id}] ${label} (${j.engine}): ${j.title}`)
  }
  for (const j of recent) {
    const label = say(TEXTS.outcome[j.status as 'done' | 'error' | 'cancelled'])
    const summary = j.summary ? ` — ${j.summary.slice(0, 100)}` : ''
    lines.push(`- [${j.id}] ${label} ${say(TEXTS.minutesAgo(minutes(now - (j.endedAt ?? now))))}: ${j.title}${summary}`)
  }
  lines.push(say(TEXTS.noDuplicates))
  return [...lines, ...projectLines].join('\n')
}

/** What the status block says to the model, in both prompt languages. */
const TEXTS = {
  projectsHeading: {
    ja: '# 最近のプロジェクト(run_agent_task の cwd に使える。他の場所は resolve_project で解決する)',
    en: '# Recently used projects (any of these can be the cwd of run_agent_task; resolve another place with resolve_project)'
  },
  jobsHeading: { ja: '# エージェントジョブの現況', en: '# Agent jobs right now' },
  awaitingMerge: {
    ja: '変更の取り込み待ち(merge_agent_job で取り込む / discard_agent_job で捨てる)',
    en: 'its changes are waiting to be merged (merge_agent_job merges them, discard_agent_job throws them away)'
  },
  stopping: { ja: '停止中(終了確認を待っています)', en: 'stopping (waiting for it to confirm)' },
  running: (mins: number): PromptText => ({ ja: `実行中 ${mins}分経過`, en: `running, ${mins} min so far` }),
  minutesAgo: (mins: number): PromptText => ({ ja: `${mins}分前`, en: `${mins} min ago` }),
  outcome: {
    done: { ja: '完了', en: 'finished' },
    error: { ja: '失敗', en: 'failed' },
    cancelled: { ja: '中止', en: 'stopped' }
  },
  noDuplicates: {
    ja: 'ここにあるジョブと同じ内容を新しく起動しない(進捗・結果を聞かれたらここから答える。足りなければget_agent_job)。',
    en: 'Do not start a job that does the same as one listed here. Answer a question about progress or results from this block, and reach for get_agent_job only when it is not enough.'
  }
} as const
