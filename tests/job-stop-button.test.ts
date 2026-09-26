// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentJob } from '@shared/ipc'
import { createTranslator } from '@shared/i18n'
import { errorText } from '@shared/i18n/error-text'
import { JobStopButton } from '@/ui/JobStopButton'
import { useToastStore } from '@/state/stores'

let root: Root
let container: HTMLDivElement
const cancel = vi.fn()
const job: AgentJob = {
  id: 'restore-job', title: '復元', prompt: 'edit', cwd: '/test', engine: 'codex', readonly: false,
  status: 'stopping', startedAt: 1, processIdentity: { pid: 123, startedAt: 'start', token: 'test' }
}
beforeEach(() => {
  vi.stubGlobal('React', React)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('api', { jobCancel: cancel })
  cancel.mockReset()
  useToastStore.setState({ toasts: [] })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
const render = async (value = job): Promise<void> => {
  await act(async () => root.render(React.createElement(JobStopButton, { job: value, className: '' })))
}

it('allows another stop request after the first one answers and blocks a second one while it is pending', async () => {
  let resolve!: () => void
  cancel.mockReturnValue(new Promise<void>((done) => { resolve = done }))
  await render()
  const button = container.querySelector('button')!
  await act(async () => button.click())
  expect(cancel).toHaveBeenCalledExactlyOnceWith(job.id)
  expect(button.disabled).toBe(true)
  await act(async () => button.click())
  expect(cancel).toHaveBeenCalledOnce()
  await act(async () => resolve())
  expect(button.disabled).toBe(false)
})

it('shows why a stop request failed in the language of the interface, and allows it to be retried', async () => {
  cancel
    .mockRejectedValueOnce(new Error(`Error invoking remote method 'job-cancel': Error: ${errorText('jobs.process.stopTimedOut')}`))
    .mockResolvedValue(undefined)
  await render()
  await act(async () => container.querySelector('button')!.click())
  expect(useToastStore.getState().toasts.at(-1)?.body).toBe(createTranslator('ja-JP')('jobs.process.stopTimedOut'))
  await act(async () => container.querySelector('button')!.click())
  expect(cancel).toHaveBeenCalledTimes(2)
})

it('removes the stop button once the job has ended, so nothing else is stopped', async () => {
  await render()
  await render({ ...job, status: 'error', processIdentity: undefined })
  expect(container.querySelector('button')).toBeNull()
  expect(cancel).not.toHaveBeenCalled()
})
