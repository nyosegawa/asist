import { afterEach, describe, expect, it, vi } from 'vitest'
import { useJobStore, useToastStore } from '@/state/stores'
import { translate } from '@/i18n'

describe('loading a job log', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows an error when the log cannot be read, and keeps the lines already shown', async () => {
    const shown = [{ t: 1, event: { kind: 'system' as const, text: 'started' } }]
    useJobStore.setState({ logs: { 'job-1': shown } })
    useToastStore.setState({ toasts: [] })
    vi.stubGlobal('window', { api: { jobLog: vi.fn(async () => Promise.reject(new Error('EACCES: permission denied'))) } })
    await useJobStore.getState().loadLog('job-1')
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ kind: 'error', title: translate('jobs.log.loadFailed'), body: 'EACCES: permission denied' })
    ])
    expect(useJobStore.getState().logs['job-1']).toBe(shown)
  })
})
