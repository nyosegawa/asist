import { describe, expect, it } from 'vitest'
import type { AgentJob } from '@shared/ipc'
import { recoverAgentJob } from '@shared/job-recovery'

const job: AgentJob = {
  id: 'job-1', title: '調査', prompt: '調査する', cwd: '/workspace',
  readonly: true, engine: 'codex', status: 'running', startedAt: 100
}

describe('recoverAgentJob', () => {
  it('marks a job that never reached the CLI as failed and leaves the stored job untouched', () => {
    expect(recoverAgentJob(job, 200, 'ja')).toMatchObject({ status: 'error', endedAt: 200 })
    expect(job.status).toBe('running')
  })

  it('leaves a job that still carries the writer identity unfinished and returns it as stopping', () => {
    const saved = { ...job, processIdentity: { pid: 123, startedAt: 'process start', token: '00000000-0000-4000-8000-000000000000' } }
    expect(recoverAgentJob(saved, 200, 'ja')).toMatchObject({ status: 'stopping', processIdentity: saved.processIdentity })
    expect(recoverAgentJob(saved, 200, 'ja').endedAt).toBeUndefined()
    expect(saved.status).toBe('running')
  })

  it('does not mark a job as waiting to be merged before its worktree has been inspected', () => {
    const saved = { ...job, worktree: { repo: '/repo', branch: 'job', base: 'abc' } }
    expect(recoverAgentJob(saved, 200, 'ja').mergeState).toBeUndefined()
  })

  it('keeps changes that were already merged out of the merge queue', () => {
    const saved = { ...job, status: 'done' as const, mergeState: 'merged' as const, worktree: { repo: '/repo', branch: 'job', base: 'abc' } }
    expect(recoverAgentJob(saved, 200, 'ja').mergeState).toBe('merged')
  })

  it('writes the summary the model reads in the language of the conversation', () => {
    const saved = { ...job, processIdentity: { pid: 123, startedAt: 'process start', token: '00000000-0000-4000-8000-000000000000' } }
    expect(recoverAgentJob(saved, 200, 'ja').summary).toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/)
    expect(recoverAgentJob(saved, 200, 'en').summary).not.toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/)
    expect(recoverAgentJob(job, 200, 'en').summary).not.toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/)
  })

  it('throws rather than resume a job with an unknown engine on another CLI', () => {
    expect(() => recoverAgentJob({ ...job, engine: undefined } as unknown as AgentJob, 200, 'ja')).toThrow()
  })
})
