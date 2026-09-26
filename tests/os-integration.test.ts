import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Emitter } from 'mitt'
import type { AgentJob, JobEvent } from '@shared/ipc'

const mocks = vi.hoisted(() => ({
  notifications: [] as Array<{ title: string; body: string }>,
  agentEvents: null as unknown as Emitter<{ event: JobEvent }>
}))

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
    app: { on: vi.fn() },
    globalShortcut: { unregister: vi.fn(), register: vi.fn(() => true), unregisterAll: vi.fn() },
    Menu: { buildFromTemplate: vi.fn(() => ({})) },
    nativeImage: { createFromDataURL: () => ({ setTemplateImage: vi.fn() }) },
    Notification,
    Tray
  }
})
vi.mock('../src/main/services/agent', async () => {
  const { default: mitt } = await import('mitt')
  mocks.agentEvents = mitt()
  return { events: mocks.agentEvents }
})
vi.mock('../src/main/services/i18n', () => ({ t: (key: string) => key }))
vi.mock('../src/main/services/settings', () => ({ getSettings: () => ({ globalHotkey: false }) }))

import { setupOsIntegration } from '../src/main/os-integration'

const hiddenWindow = {
  on: vi.fn(),
  isVisible: () => false,
  isFocused: () => false,
  isMinimized: () => false,
  webContents: { send: vi.fn() }
}

const finished = (id: string, patch: Partial<AgentJob> = {}): AgentJob => ({
  id, title: id, prompt: id, cwd: '/w', readonly: true, engine: 'codex', status: 'done', startedAt: 1, endedAt: 2, ...patch
})

beforeEach(() => {
  mocks.notifications.length = 0
})

describe('the OS notification when a job ends while the window is hidden', () => {
  it('is raised for a job of the user and not for the memory curation, which runs behind the conversation', () => {
    setupOsIntegration(hiddenWindow as never)
    mocks.agentEvents.emit('event', { type: 'update', job: finished('curation', { memoryCuration: { through: '2026-09-25', applied: false } }) })
    mocks.agentEvents.emit('event', { type: 'update', job: finished('report') })
    expect(mocks.notifications).toEqual([{ title: 'app.notify.jobDone', body: 'report' }])
  })
})
