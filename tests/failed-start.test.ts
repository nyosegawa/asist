import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Starts src/main/index.ts with a service that throws during the start, over the real update service and a
 * stand-in for electron-updater, to see what a start that failed ends with.
 */

class FakeUpdater extends EventEmitter {
  checkForUpdates = vi.fn(async () => undefined)
  quitAndInstall = vi.fn()
}

class FakeWebContents extends EventEmitter {
  setWindowOpenHandler = vi.fn()
  session = { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }
}

const mocks = vi.hoisted(() => ({
  os: 'macos' as 'macos' | 'windows',
  updater: null as unknown as FakeUpdater,
  squirrel: null as unknown as EventEmitter,
  quit: vi.fn(),
  showErrorBox: vi.fn(),
  notify: vi.fn(),
  initMail: vi.fn(),
  // The quit gate stops the agents and then quits or installs; here it does the last step at once.
  quitAfterAgentsStop: vi.fn((install?: () => void) => install?.())
}))

vi.mock('electron', () => {
  class BrowserWindow {
    readonly webContents = new FakeWebContents()
    once = (): void => undefined
    hide = (): void => undefined
    loadURL = (): Promise<void> => Promise.resolve()
    isDestroyed = (): boolean => false
  }
  return {
    app: {
      isPackaged: true,
      requestSingleInstanceLock: () => true,
      whenReady: () => Promise.resolve(),
      on: () => undefined,
      quit: mocks.quit,
      getAppPath: () => '/Applications/ASIST.app/Contents/Resources/app.asar'
    },
    BrowserWindow,
    dialog: { showErrorBox: mocks.showErrorBox },
    nativeImage: { createFromPath: () => ({ isEmpty: () => false }) },
    shell: { openExternal: () => undefined },
    get autoUpdater() {
      return mocks.squirrel
    }
  }
})
vi.mock('electron-updater', () => ({
  get autoUpdater() {
    return mocks.updater
  }
}))
vi.mock('../src/main/environment', () => ({}))
vi.mock('../src/main/logging', () => ({ logRenderer: () => undefined }))
vi.mock('../src/main/ipc', () => ({ registerIpc: () => undefined }))
vi.mock('../src/main/os-integration', () => ({
  setupOsIntegration: () => undefined,
  notify: mocks.notify,
  quitAfterAgentsStop: mocks.quitAfterAgentsStop
}))
vi.mock('../src/main/window-chrome', () => ({ windowChrome: () => ({ frame: {}, prepare: () => undefined }) }))
vi.mock('../src/main/file-protocol', () => ({ handleFileScheme: () => undefined, registerFileScheme: () => undefined }))
vi.mock('../src/main/services/native-mic', () => ({ stop: () => undefined }))
vi.mock('../src/main/services/live', () => ({ stop: () => Promise.resolve() }))
vi.mock('../src/main/services/asr', () => ({ ensureServer: () => Promise.resolve(true) }))
vi.mock('../src/main/services/tts', () => ({ ensureEngine: () => Promise.resolve() }))
vi.mock('../src/main/services/aizuchi', () => ({ getBank: () => undefined }))
vi.mock('../src/main/services/aizuchi-classifier', () => ({ wanted: () => false, ensureStarted: () => undefined }))
vi.mock('../src/main/services/watchdog', () => ({ checkAfter: () => undefined }))
vi.mock('../src/main/services/brain/job-reporting', () => ({ initJobReporting: () => undefined }))
vi.mock('../src/main/services/maintenance', () => ({ compactionJob: {}, initMaintenance: () => undefined }))
vi.mock('../src/main/services/memory', () => ({ ensureLoaded: () => undefined, startEmbeddingIfEnabled: () => Promise.resolve(false) }))
vi.mock('../src/main/services/memory-curation', () => ({ initMemoryCuration: () => undefined }))
vi.mock('../src/main/services/agent', () => ({ allowedFileRoots: () => [] }))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ uiLocale: 'en-US' }) }))
vi.mock('../src/main/services/mail', () => ({ initMail: mocks.initMail }))
vi.mock('../src/main/services/platform', async () => {
  const { MACOS, WINDOWS } = await import('./helpers/platform')
  return { platformCapabilities: () => (mocks.os === 'windows' ? WINDOWS : MACOS) }
})

/** The resources of a release, which carry the address of the releases, and of a local build, which do not. */
const releaseResources = fs.mkdtempSync(path.join(os.tmpdir(), 'asist-release-'))
const localResources = fs.mkdtempSync(path.join(os.tmpdir(), 'asist-local-build-'))
fs.writeFileSync(path.join(releaseResources, 'app-update.yml'), 'provider: github\n')

/** Starts the app with mail failing as a damaged cache made it fail, and waits until the failure is shown. */
async function failToStart(platform: 'macos' | 'windows'): Promise<void> {
  mocks.os = platform
  mocks.initMail.mockImplementation(() => {
    throw new Error('database disk image is malformed')
  })
  await import('../src/main/index')
  await vi.waitFor(() => expect(mocks.showErrorBox).toHaveBeenCalled())
}

/** What electron-updater, and on macOS Squirrel.Mac, report for a newer version found, downloaded and staged. */
function publish(version: string): void {
  mocks.updater.emit('checking-for-update')
  mocks.updater.emit('update-available', { version })
  mocks.updater.emit('download-progress', { percent: 100 })
  mocks.updater.emit('update-downloaded', { version })
  if (mocks.os === 'macos') mocks.squirrel.emit('update-downloaded')
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.updater = new FakeUpdater()
  mocks.squirrel = new EventEmitter()
  Object.defineProperty(process, 'resourcesPath', { value: releaseResources, configurable: true })
})

afterAll(() => {
  fs.rmSync(releaseResources, { recursive: true, force: true })
  fs.rmSync(localResources, { recursive: true, force: true })
})

describe('a start that failed', () => {
  it.each(['macos', 'windows'] as const)('installs a newer version the check finds and starts it, on %s', async (platform) => {
    await failToStart(platform)
    await vi.waitFor(() => expect(mocks.updater.checkForUpdates).toHaveBeenCalled())
    publish('0.5.1')
    await vi.waitFor(() => expect(mocks.updater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, true))
    expect(mocks.notify).toHaveBeenCalled()
    expect(mocks.quit).not.toHaveBeenCalled()
  })

  it.each([
    ['the running version is the latest', () => mocks.updater.emit('update-not-available')],
    ['the check fails', () => mocks.updater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'))]
  ])('quits without installing anything when %s', async (_case, answer) => {
    await failToStart('macos')
    await vi.waitFor(() => expect(mocks.updater.checkForUpdates).toHaveBeenCalled())
    answer()
    await vi.waitFor(() => expect(mocks.quit).toHaveBeenCalled())
    expect(mocks.updater.quitAndInstall).not.toHaveBeenCalled()
    expect(mocks.showErrorBox).toHaveBeenCalledOnce()
  })

  it('shows why the download of a newer version failed, and quits', async () => {
    await failToStart('windows')
    await vi.waitFor(() => expect(mocks.updater.checkForUpdates).toHaveBeenCalled())
    mocks.updater.emit('update-available', { version: '0.5.1' })
    mocks.updater.emit('error', new Error('net::ERR_CONNECTION_RESET'))
    await vi.waitFor(() => expect(mocks.quit).toHaveBeenCalled())
    expect(mocks.showErrorBox).toHaveBeenCalledTimes(2)
    expect(mocks.updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('quits at once in a build that does not update itself', async () => {
    Object.defineProperty(process, 'resourcesPath', { value: localResources, configurable: true })
    await failToStart('macos')
    await vi.waitFor(() => expect(mocks.quit).toHaveBeenCalled())
    expect(mocks.updater.checkForUpdates).not.toHaveBeenCalled()
  })
})
