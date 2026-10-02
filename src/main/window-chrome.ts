import {
  app,
  BrowserWindow,
  Menu,
  MenuItem,
  type BrowserWindowConstructorOptions,
  type MenuItemConstructorOptions,
  type WebContents
} from 'electron'
import type { WindowControlColors } from '@shared/ipc'
import type { OsFamily } from '@shared/platform'

/**
 * The frame of the main window on each OS. The page draws its own top bar on both: macOS keeps its traffic
 * lights over the left of it, and Windows draws its minimize, maximize and close buttons over the right
 * of it, where the page reads their place from the titlebar-area-* CSS environment variables.
 */
export interface WindowChrome {
  frame: Pick<BrowserWindowConstructorOptions, 'titleBarStyle' | 'trafficLightPosition' | 'titleBarOverlay'>
  /**
   * Runs first in a launch, before anything that can fail, because it also gives the app the identity Windows
   * shows its notifications under, and a start that failed notifies while it updates.
   */
  prepare: () => void
  /** Colours the buttons the OS draws over the page in the current theme. */
  paintControls: (window: BrowserWindow, colors: WindowControlColors) => void
}

/** The appId of electron-builder.yml, which the installer gives the Start menu shortcut. */
const APP_USER_MODEL_ID = 'com.nyosegawa.asist'

/**
 * The buttons' background, left clear so that the theme's background picture shows behind them. The
 * symbols start clear as well, until the page has sent the theme's colour, rather than in the system's
 * dark colour over a dark picture.
 */
const CLEAR = '#00000000'

/**
 * What the items of Electron's View menu do, done to the window's own page. Electron's roles for them act on the
 * webContents that has the keyboard, which is the files card's HTML page, a <webview>, while it has the focus, so
 * a reload, a zoom or the developer tools would reach that page instead of the app.
 */
const ON_APP_PAGE: Record<string, (page: WebContents) => void> = {
  reload: (page) => page.reload(),
  forcereload: (page) => page.reloadIgnoringCache(),
  toggledevtools: (page) => page.toggleDevTools(),
  resetzoom: (page) => {
    page.zoomLevel = 0
  },
  zoomin: (page) => {
    page.zoomLevel += 0.5
  },
  zoomout: (page) => {
    page.zoomLevel -= 0.5
  }
}

/**
 * Electron's View menu with its labels and keys, each item acting on the page of the window it is chosen in. The
 * separators and the full screen item, which acts on the window already, are left as Electron makes them.
 */
function viewMenu(): MenuItemConstructorOptions {
  const view = new MenuItem({ role: 'viewMenu' })
  const items = view.submenu!.items.map((item): MenuItemConstructorOptions => {
    const act = item.role ? ON_APP_PAGE[item.role.toLowerCase()] : undefined
    if (!act) return item.role ? { role: item.role } : { type: item.type }
    return {
      label: item.label,
      accelerator: item.accelerator ?? undefined,
      click: (_item, window) => {
        if (window instanceof BrowserWindow) act(window.webContents)
      }
    }
  })
  return { label: view.label, submenu: items }
}

const CHROMES: Record<OsFamily, WindowChrome> = {
  macos: {
    frame: { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } },
    // Electron's own menu for macOS, but for its View menu.
    prepare: () => {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'fileMenu' }, { role: 'editMenu' }, viewMenu(), { role: 'windowMenu' }])
      )
    },
    // macOS draws the traffic lights in its own colours.
    paintControls: () => {}
  },
  windows: {
    frame: { titleBarStyle: 'hidden', titleBarOverlay: { color: CLEAR, symbolColor: CLEAR } },
    prepare: () => {
      // Electron's default menu (File, Edit, View, Window) is hidden with the title bar but still opens
      // with Alt. Copy and paste in a text field work without it.
      Menu.setApplicationMenu(null)
      // Windows shows a notification only from an app whose ID matches the one on its Start menu shortcut,
      // and groups the window under the pinned shortcut by the same ID.
      app.setAppUserModelId(APP_USER_MODEL_ID)
    },
    paintControls: (window, { symbol }) => window.setTitleBarOverlay({ color: CLEAR, symbolColor: symbol })
  }
}

/** The frame of the main window on this OS. */
export const windowChrome = (os: OsFamily): WindowChrome => CHROMES[os]
