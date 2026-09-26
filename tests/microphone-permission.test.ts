import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ status: 'granted', askForMediaAccess: vi.fn(async () => true) }))
vi.mock('electron', () => ({
  systemPreferences: { getMediaAccessStatus: () => mocks.status, askForMediaAccess: mocks.askForMediaAccess }
}))

import { microphonePermission } from '../src/main/services/microphone-permission'

beforeEach(() => {
  mocks.askForMediaAccess.mockClear()
})

describe('the microphone permission of each OS', () => {
  it('asks the user on macOS when the app has not been allowed yet', async () => {
    mocks.status = 'not-determined'
    await expect(microphonePermission('macos').request()).resolves.toBe(true)
    expect(mocks.askForMediaAccess).toHaveBeenCalledWith('microphone')
  })

  it('reads the switch of the Windows settings without asking, and reports a refusal', async () => {
    mocks.status = 'denied'
    await expect(microphonePermission('windows').request()).resolves.toBe(false)
    mocks.status = 'granted'
    await expect(microphonePermission('windows').request()).resolves.toBe(true)
    expect(mocks.askForMediaAccess).not.toHaveBeenCalled()
  })

  it('opens the privacy page of the settings of the OS it runs on', () => {
    expect(microphonePermission('macos').settingsUrl).toMatch(/^x-apple\.systempreferences:/)
    expect(microphonePermission('windows').settingsUrl).toMatch(/^ms-settings:/)
  })
})
