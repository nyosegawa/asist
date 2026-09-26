import { describe, expect, it } from 'vitest'
import type { AgentJob } from '@shared/ipc'
import { jobCardPhase, shouldPushJobCard } from '@shared/job-cards'

const job = (patch: Partial<AgentJob>): AgentJob => ({
  id: 'j',
  title: 't',
  prompt: 'p',
  cwd: '/w',
  readonly: false,
  engine: 'codex',
  status: 'running',
  startedAt: 1,
  ...patch
})

describe('when the app pushes a job card on its own', () => {
  it('pushes a card when a job enters merge, conflict, done or error', () => {
    expect(jobCardPhase(job({ status: 'done', mergeState: 'pending' }))).toBe('merge')
    expect(jobCardPhase(job({ status: 'done', mergeState: 'conflict' }))).toBe('merge')
    expect(jobCardPhase(job({ status: 'done', mergeState: 'merged' }))).toBe('done')
    expect(jobCardPhase(job({ status: 'error' }))).toBe('error')
    expect(shouldPushJobCard(job({}), job({ status: 'done' }))).toBe(true)
    expect(shouldPushJobCard(undefined, job({ status: 'error' }))).toBe(true)
  })

  it('pushes a card when a job starts, since the turn that started it may no longer be the one the screen follows', () => {
    expect(shouldPushJobCard(undefined, job({ status: 'running' }))).toBe(true)
    expect(shouldPushJobCard(undefined, job({ status: 'running', memoryCuration: { through: null, applied: false } }))).toBe(false)
  })

  it('pushes nothing for an update while running, an update within the same phase, memory curation, or a cancel by the user', () => {
    expect(shouldPushJobCard(job({}), job({ artifacts: ['/w/a'] }))).toBe(false)
    expect(shouldPushJobCard(job({ status: 'done' }), job({ status: 'done', artifacts: ['/w/a'] }))).toBe(false)
    expect(shouldPushJobCard(job({}), job({ status: 'done', memoryCuration: { through: null, applied: false } }))).toBe(false)
    expect(shouldPushJobCard(job({}), job({ status: 'cancelled' }))).toBe(false)
  })

  it('pushes no card for memory curation in any phase, the merge a user job would ask for included', () => {
    const curation = { memoryCuration: { through: '2026-09-11', applied: false } }
    for (const patch of [
      { status: 'done' as const, mergeState: 'pending' as const },
      { status: 'done' as const, mergeState: 'conflict' as const },
      { status: 'done' as const, mergeState: 'merged' as const },
      { status: 'error' as const }
    ]) {
      expect(jobCardPhase(job({ ...patch, ...curation }))).toBeNull()
    }
  })

  it('pushes the card again as done when a job waiting to be merged becomes merged', () => {
    const waiting = job({ status: 'done', mergeState: 'pending' })
    expect(shouldPushJobCard(waiting, { ...waiting, mergeState: 'merged' })).toBe(true)
  })
})
