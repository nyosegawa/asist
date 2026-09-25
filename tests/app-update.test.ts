import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { AppUpdateController, type AppUpdateState, type Updater } from '../src/shared/app-update'

class FakeUpdater extends EventEmitter {
  checkForUpdates = vi.fn(async () => undefined)
  quitAndInstall = vi.fn()
}

function setup(): { updater: FakeUpdater; controller: AppUpdateController; states: AppUpdateState[] } {
  const updater = new FakeUpdater()
  const states: AppUpdateState[] = []
  const controller = new AppUpdateController(updater as unknown as Updater, { now: () => 42, onChange: (state) => states.push(state) })
  return { updater, controller, states }
}

describe('AppUpdateController', () => {
  it('follows a check that finds, downloads and stages a new version', () => {
    const { updater, controller, states } = setup()
    updater.emit('checking-for-update')
    updater.emit('update-available', { version: '0.1.1' })
    updater.emit('download-progress', { percent: 37.8 })
    updater.emit('update-downloaded', { version: '0.1.1' })
    expect(states).toEqual([
      { phase: 'checking' },
      { phase: 'downloading', version: '0.1.1', percent: 0 },
      { phase: 'downloading', version: '0.1.1', percent: 37 },
      { phase: 'ready', version: '0.1.1' }
    ])
    expect(controller.state).toEqual({ phase: 'ready', version: '0.1.1' })
  })

  it('records when the running version was found to be the latest', () => {
    const { updater, controller } = setup()
    updater.emit('update-not-available')
    expect(controller.state).toEqual({ phase: 'current', checkedAt: 42 })
  })

  it('does not start another check while a version downloads or waits to be installed', () => {
    const { updater, controller } = setup()
    updater.emit('update-available', { version: '0.1.1' })
    controller.check()
    updater.emit('update-downloaded', { version: '0.1.1' })
    controller.check()
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('checks again after a failed check and keeps the failure until then', async () => {
    const { updater, controller } = setup()
    updater.checkForUpdates.mockRejectedValueOnce(new Error('net::ERR_INTERNET_DISCONNECTED'))
    controller.check()
    updater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'))
    await Promise.resolve()
    expect(controller.state).toEqual({ phase: 'failed', message: 'net::ERR_INTERNET_DISCONNECTED' })
    controller.check()
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('installs only a version that has been downloaded', () => {
    const { updater, controller } = setup()
    updater.emit('update-available', { version: '0.1.1' })
    expect(() => controller.install()).toThrow()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    updater.emit('update-downloaded', { version: '0.1.1' })
    controller.install()
    expect(updater.quitAndInstall).toHaveBeenCalledOnce()
  })
})
