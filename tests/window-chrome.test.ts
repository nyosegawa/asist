import fs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ setAppUserModelId: vi.fn(), setApplicationMenu: vi.fn() }))

/** Electron's View menu as Electron 43 builds it for the viewMenu role, with role names in lower case. */
const ELECTRON_VIEW_MENU = [
  { role: 'reload', label: 'Reload', accelerator: 'CmdOrCtrl+R' },
  { role: 'forcereload', label: 'Force Reload', accelerator: 'Shift+CmdOrCtrl+R' },
  { role: 'toggledevtools', label: 'Toggle Developer Tools', accelerator: 'Alt+Command+I' },
  { type: 'separator' },
  { role: 'resetzoom', label: 'Actual Size', accelerator: 'CommandOrControl+0' },
  { role: 'zoomin', label: 'Zoom In', accelerator: 'CommandOrControl+Plus' },
  { role: 'zoomout', label: 'Zoom Out', accelerator: 'CommandOrControl+-' },
  { type: 'separator' },
  { role: 'togglefullscreen', label: 'Toggle Full Screen', accelerator: 'Control+Command+F' }
]

vi.mock('electron', () => {
  class BrowserWindow {
    constructor(readonly webContents: unknown) {}
  }
  class MenuItem {
    label = ''
    submenu: { items: unknown[] } | undefined
    constructor({ role }: { role: string }) {
      if (role !== 'viewMenu') throw new Error(`no ${role} in this fake`)
      this.label = 'View'
      this.submenu = { items: ELECTRON_VIEW_MENU }
    }
  }
  return {
    app: { setAppUserModelId: mocks.setAppUserModelId },
    BrowserWindow,
    MenuItem,
    Menu: { setApplicationMenu: mocks.setApplicationMenu, buildFromTemplate: (template: unknown[]) => ({ template }) }
  }
})

import { BrowserWindow } from 'electron'
import { windowChrome } from '../src/main/window-chrome'

type Item = { label?: string; role?: string; type?: string; accelerator?: string; submenu?: Item[]; click?: (item: unknown, window: unknown) => void }

/** A page the menu may act on, which records what was done to it. */
function fakePage() {
  return { zoomLevel: 0, reload: vi.fn(), reloadIgnoringCache: vi.fn(), toggleDevTools: vi.fn() }
}

describe('the menu on macOS', () => {
  it("reloads, zooms and inspects the window's own page, not the files card's page that has the keyboard", () => {
    windowChrome('macos').prepare()
    const menu = (mocks.setApplicationMenu.mock.lastCall![0] as { template: Item[] }).template
    const view = menu.find((item) => item.label === 'View')!.submenu!
    const app = fakePage()
    const window = new BrowserWindow(app as never)
    const choose = (label: string): void => view.find((item) => item.label === label)!.click!({}, window)
    choose('Zoom In')
    choose('Zoom In')
    choose('Zoom Out')
    expect(app.zoomLevel).toBe(0.5)
    choose('Actual Size')
    expect(app.zoomLevel).toBe(0)
    choose('Reload')
    choose('Force Reload')
    choose('Toggle Developer Tools')
    expect([app.reload, app.reloadIgnoringCache, app.toggleDevTools].map((method) => method.mock.calls.length)).toEqual([1, 1, 1])
  })

  it("keeps Electron's other menus and the View menu's labels and keys", () => {
    windowChrome('macos').prepare()
    const menu = (mocks.setApplicationMenu.mock.lastCall![0] as { template: Item[] }).template
    expect(menu.map((item) => item.role ?? item.label)).toEqual(['appMenu', 'fileMenu', 'editMenu', 'View', 'windowMenu'])
    const view = menu.find((item) => item.label === 'View')!.submenu!
    expect(view.map((item) => item.label ?? item.role ?? item.type)).toEqual(ELECTRON_VIEW_MENU.map((item) => item.label && item.role !== 'togglefullscreen' ? item.label : (item.role ?? item.type)))
    expect(view.filter((item) => item.click).map((item) => item.accelerator)).toEqual(ELECTRON_VIEW_MENU.filter((item) => item.label && item.role !== 'togglefullscreen').map((item) => item.accelerator))
  })
})

describe('the window on Windows', () => {
  it('runs under the ID the installer gives the Start menu shortcut, without which Windows shows no notification', () => {
    const appId = /^appId: (\S+)$/m.exec(fs.readFileSync('electron-builder.yml', 'utf8'))?.[1]
    windowChrome('windows').prepare()
    expect(mocks.setAppUserModelId).toHaveBeenCalledWith(appId)
  })
})
