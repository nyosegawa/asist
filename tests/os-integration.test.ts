import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Emitter } from 'mitt'
import { IpcChannel, type AgentJob, type JobEvent } from '@shared/ipc'
import { MACOS, WINDOWS } from './helpers/platform'

type Listener = (event: { preventDefault: () => void }) => void

const mocks = vi.hoisted(() => ({
  notifications: [] as Array<{ title: string; body: string }>,
  agentEvents: null as unknown as Emitter<{ event: JobEvent }>,
  appListeners: new Map<string, Listener[]>(),
  quit: vi.fn(),
  showErrorBox: vi.fn(),
  shutdown: vi.fn<() => Promise<void>>(),
  liveStop: vi.fn<() => Promise<void>>(),
  register: vi.fn((_accelerator: string, _callback: () => void) => true),
  buildMenu: vi.fn((_template: Array<{ label?: string; click?: () => void }>) => ({})),
  settings: { globalHotkey: false },
  windows: false
}))

vi.mock('../src/main/services/platform', async () => {
  const { MACOS, WINDOWS } = await import('./helpers/platform')
  return { platformCapabilities: () => (mocks.windows ? WINDOWS : MACOS) }
})
vi.mock('electron', () => {
  class Notification {
    static isSupported = (): boolean => true
    constructor(private readonly options: { title: string; body: string }) {}
    show(): void {
      mocks.notifications.push({ title: this.options.title, body: this.options.body })
    }
  }
  class Tray {
    setToolTip(): void {}
    setContextMenu(): void {}
    on(): void {}
  }
  return {
    app: {
      on: (name: string, listener: Listener) => mocks.appListeners.set(name, [...(mocks.appListeners.get(name) ?? []), listener]),
      quit: mocks.quit
    },
    dialog: { showErrorBox: mocks.showErrorBox },
    globalShortcut: { unregister: vi.fn(), register: mocks.register, unregisterAll: vi.fn() },
    Menu: { buildFromTemplate: mocks.buildMenu },
    nativeImage: { createFromDataURL: () => ({ setTemplateImage: vi.fn() }), createEmpty: () => ({ addRepresentation: vi.fn() }) },
    Notification,
    Tray
  }
})
vi.mock('../src/main/services/agent', async () => {
  const { default: mitt } = await import('mitt')
  mocks.agentEvents = mitt()
  return { events: mocks.agentEvents, shutdown: mocks.shutdown }
})
vi.mock('../src/main/services/live', () => ({ stop: mocks.liveStop }))
vi.mock('../src/main/services/i18n', () => ({ t: (key: string) => key, errorMessage: (error: unknown) => (error as Error).message }))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => mocks.settings }))

// The quit is approved once for the whole process, so each test takes a fresh copy of the module.
let os: typeof import('../src/main/os-integration')

/** A hidden window that keeps its listeners, so that a test can close it the way the user does. */
function hiddenWindow() {
  const listeners = new Map<string, Listener>()
  const shown = { visible: false, minimized: false }
  return {
    shown,
    /** Raises one of the window's events, such as 'hide', after a test has set what it leaves the window as. */
    emit: (name: string) => listeners.get(name)?.({ preventDefault: () => {} }),
    on: (name: string, listener: Listener) => listeners.set(name, listener),
    /** Closes the window the way the user does, and says whether it closed. */
    close: () => {
      let prevented = false
      listeners.get('close')?.({ preventDefault: () => (prevented = true) })
      return !prevented
    },
    hide: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    isVisible: () => shown.visible,
    isFocused: () => false,
    isMinimized: () => shown.minimized,
    webContents: { send: vi.fn() }
  }
}

/** Asks the app to quit the way Cmd+Q does, and says whether the quit went ahead. */
function quit(): boolean {
  let prevented = false
  for (const listener of mocks.appListeners.get('before-quit') ?? []) listener({ preventDefault: () => (prevented = true) })
  return !prevented
}

const finished = (id: string, patch: Partial<AgentJob> = {}): AgentJob => ({
  id, title: id, prompt: id, cwd: '/w', readonly: true, engine: 'codex', status: 'done', startedAt: 1, endedAt: 2, ...patch
})

beforeEach(async () => {
  vi.resetModules()
  os = await import('../src/main/os-integration')
  mocks.notifications.length = 0
  mocks.appListeners.clear()
  mocks.quit.mockReset()
  mocks.showErrorBox.mockReset()
  mocks.shutdown.mockReset()
  mocks.liveStop.mockReset().mockResolvedValue(undefined)
  mocks.register.mockReset().mockReturnValue(true)
  mocks.buildMenu.mockClear()
  mocks.settings.globalHotkey = false
  mocks.windows = false
})

describe('the OS notification when a job ends while the window is hidden', () => {
  it('is raised for a job of the user and not for the memory curation, which runs behind the conversation', () => {
    os.setupOsIntegration(hiddenWindow() as never)
    mocks.agentEvents.emit('event', { type: 'update', job: finished('curation', { memoryCuration: { through: '2026-09-25', applied: false } }) })
    mocks.agentEvents.emit('event', { type: 'update', job: finished('report') })
    expect(mocks.notifications).toEqual([{ title: 'app.notify.jobDone', body: 'report' }])
  })
})

describe('quitting while agents run', () => {
  it('closes the window only after every agent has stopped', async () => {
    const window = hiddenWindow()
    os.setupOsIntegration(window as never)
    let stopped!: () => void
    mocks.shutdown.mockReturnValue(new Promise((resolve) => (stopped = resolve)))
    expect(quit()).toBe(false)
    expect(quit()).toBe(false)
    expect(window.close()).toBe(false)
    stopped()
    await vi.waitFor(() => expect(mocks.quit).toHaveBeenCalledOnce())
    expect(mocks.shutdown).toHaveBeenCalledOnce()
    expect(quit()).toBe(true)
    expect(window.close()).toBe(true)
  })

  it('stops the live engine once the agents have stopped, so the usage of its open session is recorded before the app goes', async () => {
    os.setupOsIntegration(hiddenWindow() as never)
    mocks.shutdown.mockResolvedValue(undefined)
    expect(quit()).toBe(false)
    await vi.waitFor(() => expect(mocks.quit).toHaveBeenCalledOnce())
    expect(mocks.liveStop).toHaveBeenCalledOnce()
    expect(mocks.shutdown.mock.invocationCallOrder[0]).toBeLessThan(mocks.liveStop.mock.invocationCallOrder[0])
    expect(mocks.liveStop.mock.invocationCallOrder[0]).toBeLessThan(mocks.quit.mock.invocationCallOrder[0])
  })

  it('quits even when the live engine fails to stop, since its session ends with the app', async () => {
    os.setupOsIntegration(hiddenWindow() as never)
    mocks.shutdown.mockResolvedValue(undefined)
    mocks.liveStop.mockRejectedValue(new Error('the session did not close'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(quit()).toBe(false)
    await vi.waitFor(() => expect(mocks.quit).toHaveBeenCalledOnce())
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('leaves the app as it was when an agent cannot be stopped, so the window still hides and a later quit tries again', async () => {
    const window = hiddenWindow()
    os.setupOsIntegration(window as never)
    mocks.shutdown.mockRejectedValueOnce(new Error('an agent did not stop'))
    expect(quit()).toBe(false)
    await vi.waitFor(() => expect(mocks.showErrorBox).toHaveBeenCalledWith('app.startup.agentStopFailed', 'an agent did not stop'))
    expect(window.close()).toBe(false)
    expect(window.hide).toHaveBeenCalledOnce()
    expect(mocks.quit).not.toHaveBeenCalled()

    mocks.shutdown.mockResolvedValueOnce(undefined)
    expect(quit()).toBe(false)
    await vi.waitFor(() => expect(mocks.quit).toHaveBeenCalledOnce())
    expect(mocks.shutdown).toHaveBeenCalledTimes(2)
    expect(quit()).toBe(true)
    expect(window.close()).toBe(true)
  })
})

describe('installing an update now', () => {
  it('starts only after every agent has stopped, and lets the install close the window', async () => {
    const window = hiddenWindow()
    os.setupOsIntegration(window as never)
    let stopped!: () => void
    mocks.shutdown.mockReturnValue(new Promise((resolve) => (stopped = resolve)))
    const install = vi.fn(() => {
      expect(window.close()).toBe(true)
      expect(quit()).toBe(true)
    })
    os.quitAfterAgentsStop(install)
    expect(window.close()).toBe(false)
    stopped()
    await vi.waitFor(() => expect(install).toHaveBeenCalledOnce())
    expect(mocks.quit).not.toHaveBeenCalled()
  })

  it('ends a quit that is already stopping the agents, rather than leaving the app to quit without starting again', async () => {
    os.setupOsIntegration(hiddenWindow() as never)
    let stopped!: () => void
    mocks.shutdown.mockReturnValue(new Promise((resolve) => (stopped = resolve)))
    expect(quit()).toBe(false)
    const install = vi.fn()
    os.quitAfterAgentsStop(install)
    stopped()
    await vi.waitFor(() => expect(install).toHaveBeenCalledOnce())
    expect(mocks.quit).not.toHaveBeenCalled()
    expect(mocks.shutdown).toHaveBeenCalledOnce()
  })

  it('is dropped when an agent cannot be stopped, so that a later quit only quits', async () => {
    os.setupOsIntegration(hiddenWindow() as never)
    mocks.shutdown.mockRejectedValueOnce(new Error('an agent did not stop'))
    const install = vi.fn()
    os.quitAfterAgentsStop(install)
    await vi.waitFor(() => expect(mocks.showErrorBox).toHaveBeenCalledOnce())

    mocks.shutdown.mockResolvedValueOnce(undefined)
    expect(quit()).toBe(false)
    await vi.waitFor(() => expect(mocks.quit).toHaveBeenCalledOnce())
    expect(install).not.toHaveBeenCalled()
  })
})

describe('the global hotkey', () => {
  it('registers the accelerator of the OS it runs on', () => {
    mocks.settings.globalHotkey = true
    os.setupOsIntegration(hiddenWindow() as never)
    mocks.windows = true
    os.setupOsIntegration(hiddenWindow() as never)
    expect(mocks.register.mock.calls.map(([accelerator]) => accelerator)).toEqual([MACOS.hotkey, WINDOWS.hotkey])
    expect(os.hotkeyStatus()).toBe('registered')
  })

  it('reports a registration the OS refuses, and nothing once the setting turns the hotkey off', () => {
    mocks.settings.globalHotkey = true
    mocks.register.mockReturnValue(false)
    os.setupOsIntegration(hiddenWindow() as never)
    expect(os.hotkeyStatus()).toBe('failed')
    mocks.settings.globalHotkey = false
    os.refreshHotkey()
    expect(os.hotkeyStatus()).toBe('off')
  })
})

describe('the tray menu', () => {
  it('asks the page to toggle the microphone, which the hotkey that calls the window up only turns on', () => {
    mocks.settings.globalHotkey = true
    const window = hiddenWindow()
    os.setupOsIntegration(window as never)
    const template = mocks.buildMenu.mock.calls.at(-1)![0]
    template.find((item) => item.label === 'app.tray.toggleMic')!.click!()
    mocks.register.mock.calls[0][1]()
    expect(window.webContents.send.mock.calls.map(([channel]) => channel)).toEqual([IpcChannel.ToggleMic, IpcChannel.HotkeyMic])
  })
})

describe('the window going to the tray or the menu bar, or minimized', () => {
  it('has the page turn the microphone off as it goes, and leaves the microphone alone when it comes back', async () => {
    const presence = await import('../src/main/services/window-presence')
    const window = hiddenWindow()
    window.shown.visible = true
    os.setupOsIntegration(window as never)
    const sent = (): string[] => window.webContents.send.mock.calls.map(([channel]) => channel)
    expect(presence.windowAway()).toBe(false)

    window.shown.visible = false
    window.emit('hide')
    expect(presence.windowAway()).toBe(true)
    window.shown.visible = true
    window.emit('show')
    expect(presence.windowAway()).toBe(false)
    window.shown.minimized = true
    window.emit('minimize')
    expect(presence.windowAway()).toBe(true)
    window.shown.minimized = false
    window.emit('restore')
    expect(presence.windowAway()).toBe(false)
    expect(sent()).toEqual([IpcChannel.WindowAway, IpcChannel.WindowAway])
  })

  it('does not count a window that has not shown yet as away, so that the microphone set to turn on at launch does not race its first show', async () => {
    const presence = await import('../src/main/services/window-presence')
    const window = hiddenWindow()
    os.setupOsIntegration(window as never)
    expect(presence.windowAway()).toBe(false)
    window.shown.visible = true
    window.emit('show')
    expect(presence.windowAway()).toBe(false)
    expect(window.webContents.send).not.toHaveBeenCalled()
  })
})
