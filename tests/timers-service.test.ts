import type { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ userData: '', notify: vi.fn(async () => {}) }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    app: { getPath: () => mocks.userData, getPreferredSystemLanguages: () => ['ja-JP'], once: () => undefined },
    powerMonitor: new EventEmitter()
  }
})
vi.mock('../src/main/os-integration', () => ({ notifyFromRenderer: mocks.notify }))
beforeAll(() => {
  mocks.userData = mkdtempSync(path.join(tmpdir(), 'asist-timers-'))
})
afterAll(() => rmSync(mocks.userData, { recursive: true, force: true }))
afterEach(() => {
  vi.useRealTimers()
})

it('announces on waking a timer that ended while the Mac slept, without waiting for its stopped schedule', async () => {
  // The clock is faked before the module loads, because the manager keeps the Date.now it finds then.
  vi.useFakeTimers({ now: new Date('2026-09-26T12:00:00Z') })
  const { powerMonitor } = await import('electron')
  const timers = await import('../src/main/services/timers')
  timers.init()
  timers.create({ id: 'timer:tea', seconds: 600 })
  // The wall clock moves an hour while the timers of the process stand still, as they do in sleep.
  vi.setSystemTime(new Date('2026-09-26T13:00:00Z'))
  expect(mocks.notify).not.toHaveBeenCalled()
  ;(powerMonitor as unknown as EventEmitter).emit('resume')
  expect(mocks.notify).toHaveBeenCalledTimes(1)
  expect(timers.list()[0]).toMatchObject({ id: 'timer:tea', status: 'finished' })
})
