import { describe, expect, it } from 'vitest'
import { formatJobContextBlock, resolveJobAccess } from '@shared/job-workspace'

describe('resolveJobAccess, which decides where a job writes', () => {
  it('always lets a job with no explicit cwd write in its own workspace', () => {
    // Even when the model passes readonly: true, the job can write in the workspace, because that is where it puts its output.
    expect(resolveJobAccess({ explicitCwd: false, readonlyInput: true, defaultReadonly: true }))
      .toEqual({ readonly: false, isolate: false })
    expect(resolveJobAccess({ explicitCwd: false, defaultReadonly: false }))
      .toEqual({ readonly: false, isolate: false })
  })

  it('keeps an explicit cwd with a read-only intent read-only', () => {
    expect(resolveJobAccess({ explicitCwd: true, readonlyInput: true, defaultReadonly: false }))
      .toEqual({ readonly: true, isolate: false })
  })

  it('isolates a write in an explicit cwd into a worktree only when it is a git repository', () => {
    expect(resolveJobAccess({ explicitCwd: true, readonlyInput: false, defaultReadonly: true, gitRepo: true }))
      .toEqual({ readonly: false, isolate: true })
    expect(resolveJobAccess({ explicitCwd: true, readonlyInput: true, defaultReadonly: false, gitRepo: true }).isolate).toBe(false)
    expect(resolveJobAccess({ explicitCwd: true, readonlyInput: false, defaultReadonly: true }))
      .toEqual({ readonly: false, isolate: false })
  })

  it('falls back to the agentMode setting when readonly is not given, for an explicit cwd', () => {
    expect(resolveJobAccess({ explicitCwd: true, defaultReadonly: true }))
      .toEqual({ readonly: true, isolate: false })
    expect(resolveJobAccess({ explicitCwd: true, defaultReadonly: false }))
      .toEqual({ readonly: false, isolate: false })
  })
})

describe('formatJobContextBlock, the job status block given to the model', () => {
  const NOW = 1_000_000_000
  const base = { engine: 'codex', startedAt: NOW - 120_000 }

  it('returns null when there is no job, so no block is added at all', () => {
    expect(formatJobContextBlock([], NOW, 'ja')).toBeNull()
  })

  it('lists running and recently finished jobs, and tells the model not to start the same job twice', () => {
    const text = formatJobContextBlock(
      [
        { ...base, id: 'run1', title: 'AI動向調査', status: 'running' },
        {
          ...base,
          id: 'done1',
          title: '競合比較',
          status: 'done',
          endedAt: NOW - 300_000,
          summary: 'report.mdに保存済み'
        }
      ],
      NOW,
      'ja'
    )!
    expect(text).toContain('[run1] 実行中 2分経過 (codex): AI動向調査')
    expect(text).toContain('[done1] 完了 5分前: 競合比較 — report.mdに保存済み')
    expect(text).toContain('同じ内容を新しく起動しない')
  })

  it('writes the same block in English outside Japanese, with no Japanese left in it', () => {
    const text = formatJobContextBlock(
      [
        { ...base, id: 'run1', title: 'survey', status: 'running' },
        { ...base, id: 'done1', title: 'compare', status: 'done', endedAt: NOW - 300_000 }
      ],
      NOW,
      'en',
      [{ name: 'asist', path: '/repo/asist' }]
    )!
    expect(text).toContain('[run1] running, 2 min so far (codex): survey')
    expect(text).toContain('[done1] finished 5 min ago: compare')
    expect(text).toContain('# Recently used projects')
    expect(text).not.toMatch(/[぀-ヿ一-鿿]/)
  })

  it('leaves out a job that finished more than thirty minutes ago', () => {
    const text = formatJobContextBlock(
      [
        { ...base, id: 'old', title: '古い', status: 'done', endedAt: NOW - 31 * 60_000 },
        { ...base, id: 'new', title: '新しい', status: 'done', endedAt: NOW - 60_000 }
      ],
      NOW,
      'ja'
    )!
    expect(text).toContain('[new]')
    expect(text).not.toContain('[old]')
  })

  it('keeps a finished job that waits to be merged in the block and names the tool that merges it', () => {
    const merged = formatJobContextBlock(
      [{ id: 'j9', title: '修正', status: 'done' as const, mergeState: 'pending' as const, endedAt: NOW - 3 * 3600_000, ...base }],
      NOW,
      'ja'
    )!
    expect(merged).toContain('[j9] 変更の取り込み待ち')
    expect(merged).toContain('merge_agent_job')
  })

  it('lists the recent projects even without any job, and puts them after the job status when there is one', () => {
    const projects = [{ name: 'asist', path: '/repo/asist' }]
    const alone = formatJobContextBlock([], NOW, 'ja', projects)!
    expect(alone).toContain('# 最近のプロジェクト')
    expect(alone).toContain('- asist: /repo/asist')
    expect(alone).not.toContain('ジョブの現況')
    const running = { id: 'j1', title: '調査', status: 'running' as const, ...base }
    const both = formatJobContextBlock([running], NOW, 'ja', projects)!
    expect(both.indexOf('ジョブの現況')).toBeLessThan(both.indexOf('最近のプロジェクト'))
  })

  it('lists at most five finished jobs, newest first', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      ...base,
      id: `d${i}`,
      title: `job${i}`,
      status: 'done' as const,
      endedAt: NOW - (i + 1) * 60_000
    }))
    const text = formatJobContextBlock(many, NOW, 'ja')!
    expect(text).toContain('[d0]')
    expect(text).toContain('[d4]')
    expect(text).not.toContain('[d5]')
  })
})
