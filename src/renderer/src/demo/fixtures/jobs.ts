import type { AgentJob, JobLogEvent } from '@shared/ipc'

/** For the job list card: one job each awaiting a merge, running, recently finished and failed. */
const HOUR = 60 * 60 * 1000
export const DEMO_JOBS: AgentJob[] = [
  {
    id: 'demo-job-merge',
    title: 'README 末尾に追記',
    prompt: 'READMEの末尾に注意書きを足す',
    cwd: '/Users/demo/repo/.asist-worktrees/asist-readme',
    readonly: false,
    engine: 'claude',
    status: 'done',
    startedAt: Date.now() - 2 * HOUR,
    endedAt: Date.now() - 2 * HOUR + 4 * 60_000,
    summary: 'README.md の末尾に「注意」の節を足しました。',
    numTurns: 6,
    costUsd: 0.21,
    mergeState: 'pending',
    worktree: { repo: '/Users/demo/repo', branch: 'asist/readme-note', base: 'main', commit: 'abc' }
  },
  {
    id: 'demo-job-1',
    title: 'README 英訳',
    prompt: 'READMEを英訳',
    cwd: '/Users/demo/repo',
    readonly: false,
    engine: 'codex',
    status: 'running',
    startedAt: Date.now() - 90_000
  },
  {
    id: 'demo-job-done',
    title: '競合サービスの調査',
    prompt: '競合サービスを調べてレポートにまとめる',
    cwd: '/Users/demo/asist-jobs/20260919-090000-competitors',
    readonly: false,
    engine: 'codex',
    status: 'done',
    startedAt: Date.now() - 6 * HOUR,
    endedAt: Date.now() - 6 * HOUR + 12 * 60_000,
    summary: '主要3社の料金と機能を比較し、report.md にまとめました。差が大きいのは同時接続数の上限です。',
    numTurns: 14,
    costUsd: 0.62,
    artifacts: [
      '/Users/demo/asist-jobs/20260919-090000-competitors/report.md',
      '/Users/demo/asist-jobs/20260919-090000-competitors/pricing.csv',
      '/Users/demo/asist-jobs/20260919-090000-competitors/notes/interview.md'
    ]
  },
  {
    id: 'demo-job-failed',
    title: '週報の下書き',
    prompt: '今週の週報を下書きする',
    cwd: '/Users/demo/asist-jobs/20260918-180000-weekly',
    readonly: false,
    engine: 'claude',
    status: 'error',
    startedAt: Date.now() - 26 * HOUR,
    endedAt: Date.now() - 26 * HOUR + 30_000,
    summary: 'API rate limit に達したため中断しました。'
  },
  {
    id: 'demo-job-old',
    title: 'selftest-codex',
    prompt: 'selftest',
    cwd: '/Users/demo/asist-jobs/20260917-000000-selftest',
    readonly: true,
    engine: 'codex',
    status: 'done',
    startedAt: Date.now() - 50 * HOUR,
    endedAt: Date.now() - 50 * HOUR + 20_000,
    summary: 'OK',
    numTurns: 2,
    costUsd: 0.01
  }
]

/** The running job and its log, shown on the agent job card and on the agent screen. */
export const DEMO_JOB: AgentJob = DEMO_JOBS.find((job) => job.id === 'demo-job-1')!

export const DEMO_JOB_LOG: JobLogEvent[] = [
  { kind: 'system', text: '$ claude -p "READMEを英訳して README_en.md に保存"' },
  { kind: 'init', model: 'claude-sonnet-5', sessionId: 'demo-session' },
  { kind: 'tool-use', name: 'Read', input: JSON.stringify({ file_path: '/Users/demo/repo/README.md' }) },
  { kind: 'tool-use', name: 'Read', input: JSON.stringify({ file_path: '/Users/demo/repo/docs/setup.md' }) },
  { kind: 'assistant-text', text: 'READMEを読みました。英訳を開始します。' },
  { kind: 'command', id: 'c1', command: 'ls docs', phase: 'start' },
  { kind: 'command', id: 'c1', command: 'ls docs', phase: 'done', ok: true, exitCode: 0 },
  { kind: 'command', id: 'c2', command: 'cat README_en.md', phase: 'start' },
  { kind: 'command', id: 'c2', command: 'cat README_en.md', phase: 'done', ok: false, exitCode: 1 },
  { kind: 'tool-use', name: 'Write', input: JSON.stringify({ file_path: '/Users/demo/repo/README_en.md' }) },
  { kind: 'file-change', paths: ['/Users/demo/repo/README_en.md'] },
  { kind: 'command', id: 'c3', command: 'wc -l README_en.md', phase: 'start' }
]
