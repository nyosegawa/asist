import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IpcChannel, type RendererApi } from '@shared/ipc'
import { rendererApiContractError } from '../src/renderer/src/bridge-contract'

const mocks = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), on: vi.fn(), remove: vi.fn() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.expose },
  ipcRenderer: { invoke: mocks.invoke, on: mocks.on, removeListener: mocks.remove }
}))
let ipc: EventEmitter
beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  ipc = new EventEmitter()
  mocks.on.mockImplementation((channel, listener) => ipc.on(channel, listener))
  mocks.remove.mockImplementation((channel, listener) => ipc.removeListener(channel, listener))
  mocks.invoke.mockResolvedValue(undefined)
})

async function loadPreload(): Promise<RendererApi> {
  await import('../src/preload')
  return mocks.expose.mock.calls.find(([name]) => name === 'api')![1] as RendererApi
}

describe('renderer preload bridge contract', () => {
  it('satisfies the contract with the real preload and passes the job and the reviewed commit to main', async () => {
    const api = await loadPreload()
    expect(rendererApiContractError(api)).toBeNull()
    await api.jobCancel('running-job')
    const diff = { commit: 'reviewed-commit', base: 'merge-base', into: 'main', patch: '+change', stat: '1 file changed', submodules: [] }
    mocks.invoke.mockResolvedValueOnce(diff)
    expect(await api.jobDiff('worktree-job')).toEqual(diff)
    await api.jobMerge('worktree-job', diff.commit, diff.base)
    expect(mocks.invoke.mock.calls).toEqual([
      [IpcChannel.JobCancel, 'running-job'],
      [IpcChannel.JobDiff, 'worktree-job'],
      [IpcChannel.JobMerge, 'worktree-job', diff.commit, diff.base]
    ])
  })

  it('passes only the payload of a job event on, and sends nothing to a screen that unsubscribed', async () => {
    const api = await loadPreload()
    const listener = vi.fn()
    const unsubscribe = api.onJobEvent(listener)
    const payload = { type: 'log', id: 'job', line: { t: 1, event: { kind: 'system', text: 'running' } } }
    ipc.emit(IpcChannel.JobEvent, { sender: 'electron event' }, payload)
    expect(listener).toHaveBeenCalledWith(payload)
    unsubscribe()
    ipc.emit(IpcChannel.JobEvent, { sender: 'electron event' }, payload)
    expect(listener).toHaveBeenCalledOnce()
  })

  it('does not treat a missing or partial bridge as ready to start', () => {
    expect(rendererApiContractError(undefined)).not.toBeNull()
    expect(rendererApiContractError({ getStatus: vi.fn() })).toContain('onStatusChanged')
  })
})
