import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Starts src/main/index.ts with a service that throws during the start, over the real update service and a
 * stand-in for electron-updater, to see what a start that failed ends with and what stays up meanwhile.
 */

class FakeUpdater extends EventEmitter {
  autoInstallOnAppQuit = false
  checkForUpdates = vi.fn(async () => undefined)
  quitAndInstall = vi.fn()
}

class FakeWebContents extends EventEmitter {
  setWindowOpenHandler = vi.fn()
  session = { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }
}

/** The app's events, which the stand-in for Electron emits the way Electron does. */
const appEvents = new EventEmitter()

/**
 * A window as Electron keeps one: it emits ready-to-show once its page has loaded, and a destroyed window emits
 * nothing more and leaves the app with no window, which Electron reports as window-all-closed.
 */
class FakeWindow extends EventEmitter {
  readonly webContents = new FakeWebContents()
  destroyed = false
  show = vi.fn()
  maximize = vi.fn()
  hide = vi.fn()
  loadURL = vi.fn(() => Promise.resolve())
  isDestroyed = (): boolean => this.destroyed
  destroy = vi.fn(() => {
    this.destroyed = true
    this.removeAllListeners()
    appEvents.emit('window-all-closed')
  })
}

const mocks = vi.hoisted(() => ({
  os: 'macos' as 'macos' | 'windows',
  windows: [] as FakeWindow[],
  updater: null as unknown as FakeUpdater,
  squirrel: null as unknown as EventEmitter,
  quit: vi.fn(),
  showErrorBox: vi.fn(),
  notify: vi.fn(() => true),
  leaveOs: vi.fn(),
  prepare: vi.fn(),
  settingsBroken: false,
  initMail: vi.fn(),
  wanted: vi.fn(() => false),
  ensureServer: vi.fn(() => Promise.resolve(true)),
  ensureEngine: vi.fn(() => Promise.resolve()),
  // The quit gate stops the agents and then quits or installs; here it does the last step at once.
  quitAfterAgentsStop: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    on: (event: string, listener: (...args: unknown[]) => void) => appEvents.on(event, listener),
    quit: mocks.quit,
    getAppPath: () => '/Applications/ASIST.app/Contents/Resources/app.asar'
  },
  BrowserWindow: class {
    constructor() {
      const window = new FakeWindow()
      mocks.windows.push(window)
      return window
    }
  },
  dialog: { showErrorBox: mocks.showErrorBox },
  nativeImage: { createFromPath: () => ({ isEmpty: () => false }) },
  shell: { openExternal: () => undefined },
  get autoUpdater() {
    return mocks.squirrel
  }
}))
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
  leaveOs: mocks.leaveOs,
  notify: mocks.notify,
  quitAfterAgentsStop: mocks.quitAfterAgentsStop
}))
vi.mock('../src/main/window-chrome', () => ({ windowChrome: () => ({ frame: {}, prepare: mocks.prepare }) }))
vi.mock('../src/main/file-protocol', () => ({ handleFileScheme: () => undefined, registerFileScheme: () => undefined }))
vi.mock('../src/main/services/native-mic', () => ({ stop: () => undefined }))
vi.mock('../src/main/services/live', () => ({ stop: () => Promise.resolve() }))
vi.mock('../src/main/services/asr', () => ({ ensureServer: mocks.ensureServer }))
vi.mock('../src/main/services/tts', () => ({ ensureEngine: mocks.ensureEngine }))
vi.mock('../src/main/services/aizuchi', () => ({ getBank: () => undefined }))
vi.mock('../src/main/services/aizuchi-classifier', () => ({ wanted: mocks.wanted, ensureStarted: () => undefined }))
vi.mock('../src/main/services/watchdog', () => ({ checkAfter: () => undefined }))
vi.mock('../src/main/services/brain/job-reporting', () => ({ initJobReporting: () => undefined }))
vi.mock('../src/main/services/maintenance', () => ({ compactionJob: {}, initMaintenance: () => undefined }))
vi.mock('../src/main/services/memory', () => ({ ensureLoaded: () => undefined, startEmbeddingIfEnabled: () => Promise.resolve(false) }))
vi.mock('../src/main/services/memory-curation', () => ({ initMemoryCuration: () => undefined }))
vi.mock('../src/main/services/agent', () => ({ allowedFileRoots: () => [] }))
vi.mock('../src/main/services/settings', () => ({
  getSettings: () => {
    if (mocks.settingsBroken) throw new Error('settings.json is damaged')
    return { uiLocale: 'en-US' }
  }
}))
vi.mock('../src/main/services/mail', () => ({ initMail: mocks.initMail }))
vi.mock('../src/main/services/platform', async () => {
  const { MACOS, WINDOWS } = await import('./helpers/platform')
  return { platformCapabilities: () => (mocks.os === 'windows' ? WINDOWS : MACOS) }
})

/** The resources of a release, which carry the address of the releases, and of a local build, which do not. */
const releaseResources = fs.mkdtempSync(path.join(os.tmpdir(), 'asist-release-'))
const localResources = fs.mkdtempSync(path.join(os.tmpdir(), 'asist-local-build-'))
fs.writeFileSync(path.join(releaseResources, 'app-update.yml'), 'provider: github\n')

/** Starts the app with mail failing as a damaged cache made it fail, and waits until the check has begun. */
async function failToStart(platform: 'macos' | 'windows'): Promise<void> {
  mocks.os = platform
  mocks.initMail.mockImplementation(() => {
    throw new Error('database disk image is malformed')
  })
  await start()
}

async function start(): Promise<void> {
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
  appEvents.removeAllListeners()
  mocks.windows.length = 0
  mocks.settingsBroken = false
  mocks.initMail.mockReset()
  mocks.wanted.mockReset().mockReturnValue(false)
  mocks.quitAfterAgentsStop.mockImplementation((install?: () => void) => (install ? install() : mocks.quit()))
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

describe('what a start that failed leaves up while it updates', () => {
  it('opens no window and starts no voice when a service fails to start', async () => {
    await failToStart('macos')
    expect(mocks.windows).toEqual([])
    expect(mocks.ensureServer).not.toHaveBeenCalled()
    expect(mocks.ensureEngine).not.toHaveBeenCalled()
  })

  it('closes a window that had opened before the error shows, and nothing shows it again or quits the app early', async () => {
    mocks.wanted.mockImplementation(() => {
      throw new Error('the aizuchi classifier is damaged')
    })
    await start()
    const [window] = mocks.windows
    expect(window.destroy).toHaveBeenCalled()
    expect(window.destroy.mock.invocationCallOrder[0]).toBeLessThan(mocks.showErrorBox.mock.invocationCallOrder[0])
    expect(mocks.leaveOs).toHaveBeenCalled()
    // Electron emits ready-to-show once the page has loaded, which it would have done under the error.
    window.emit('ready-to-show')
    appEvents.emit('second-instance')
    await vi.waitFor(() => expect(mocks.updater.checkForUpdates).toHaveBeenCalled())
    mocks.updater.emit('update-available', { version: '0.5.1' })
    expect(window.show).not.toHaveBeenCalled()
    expect(mocks.quit).not.toHaveBeenCalled()
  })

  it('says again what it is doing when the app is launched again during the download', async () => {
    await failToStart('windows')
    await vi.waitFor(() => expect(mocks.updater.checkForUpdates).toHaveBeenCalled())
    mocks.updater.emit('update-available', { version: '0.5.1' })
    await vi.waitFor(() => expect(mocks.notify).toHaveBeenCalledOnce())
    appEvents.emit('second-instance')
    expect(mocks.notify).toHaveBeenCalledTimes(2)
  })

  it('gives the app its identity before reading the settings, so that Windows shows the notification of a start that failed on them', async () => {
    mocks.os = 'windows'
    mocks.settingsBroken = true
    await start()
    await vi.waitFor(() => expect(mocks.updater.checkForUpdates).toHaveBeenCalled())
    mocks.updater.emit('update-available', { version: '0.5.1' })
    await vi.waitFor(() => expect(mocks.notify).toHaveBeenCalled())
    expect(mocks.prepare).toHaveBeenCalled()
    expect(mocks.prepare.mock.invocationCallOrder[0]).toBeLessThan(mocks.notify.mock.invocationCallOrder[0])
  })
})
