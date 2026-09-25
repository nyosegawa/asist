import { isJobTerminal } from '@shared/job-status'
import {
  app,
  autoUpdater,
  globalShortcut,
  Menu,
  nativeImage,
  Notification,
  Tray,
  type BrowserWindow
} from 'electron'
import { IpcChannel } from '@shared/ipc'
import * as agent from './services/agent'
import { errorText } from '@shared/i18n/error-text'
import { t } from './services/i18n'
import { getSettings } from './services/settings'

/**
 * How the app lives in the OS: a resident tray item, the global hotkey ⌥Space, and Notification Center
 * notifications, so that the user never has to open the app to reach it.
 */

/** An 18x18 template icon of the orb. Only black and alpha, which is what the macOS menu bar expects. */
const TRAY_ICON_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAABBElEQVR4nK2UOwrCQBCGv8RHGZEgnkFvYC14Au31DloJNrbexrvYaKMnsAr4QCXwT1jWdUF0YNhk5p9/57G7EJYEqGuN2aJS8/4zaQzzJqnWHNgAe+Ai3cuWe9iPJBPgDOyAFTCSrmQ7CxMks1THwBOYR7KeCzP2y0ykbaAAFg6g6RA01GyEKRRj8ZWzrP/gBFnaPWDgESJsGVNxpPo4AUuxWyZr4KpStrLXhFkqpu72qhzvDRg6O/eBh0iMbOb4h4rJoiMEWtr5Btxl60bwH0tLVM5TegQ6wgdLCzXbiJrAVFPqOL5gs2PjT73so+O3oJ8P5F+vCJ7jp0tr8pdnxOTrh+0Fb5w/wpVCPGcAAAAASUVORK5CYII='

let tray: Tray | null = null
let buildTrayMenu: () => void = () => {}
let quitting = false

const notify = (title: string, body: string): boolean => {
  if (!Notification.isSupported()) return false
  new Notification({ title, body: body.slice(0, 180), silent: false }).show()
  return true
}

export function setupOsIntegration(window: BrowserWindow): void {
  app.on('before-quit', () => (quitting = true))
  // Installing an update closes every window before quitting, and a window that only hides here kept the
  // app running with the update staged (a signed test build, 2026-09-25).
  autoUpdater.on('before-quit-for-update', () => (quitting = true))
  window.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      window.hide()
    }
  })

  const showWindow = (): void => {
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_B64}`)
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip('ASIST')
  // The menu is built again whenever the interface language changes, because its labels are fixed once set.
  buildTrayMenu = (): void =>
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: t('app.tray.show'), click: showWindow },
        {
          label: t('app.tray.toggleMic'),
          click: () => {
            showWindow()
            window.webContents.send(IpcChannel.HotkeyMic, undefined)
          }
        },
        { type: 'separator' },
        { label: t('app.tray.quit'), role: 'quit' }
      ])
    )
  buildTrayMenu()
  tray.on('click', showWindow)

  const registerHotkey = (): void => {
    globalShortcut.unregister('Alt+Space')
    if (!getSettings().globalHotkey) return
    const ok = globalShortcut.register('Alt+Space', () => {
      if (window.isVisible() && window.isFocused()) {
        window.hide()
      } else {
        showWindow()
        // A microphone that is off when the window is called up is turned on; the renderer decides that.
        window.webContents.send(IpcChannel.HotkeyMic, undefined)
      }
    })
    if (!ok) console.warn('global hotkey Alt+Space registration failed')
  }
  registerHotkey()
  hotkeyRefresher = registerHotkey
  app.on('will-quit', () => globalShortcut.unregisterAll())

  const notified = new Set<string>()
  agent.events.on('event', (event) => {
    if (event.type !== 'update') return
    const job = event.job
    if (!isJobTerminal(job.status) || notified.has(job.id)) return
    notified.add(job.id)
    if (window.isVisible() && window.isFocused()) return
    if (job.status === 'done') notify(t('app.notify.jobDone'), job.title)
    else if (job.status === 'error') notify(t('app.notify.jobFailed'), job.title)
  })
}

let hotkeyRefresher: (() => void) | null = null

/** Re-registers the hotkey after a settings change. A call before setup does nothing. */
/** Words the tray menu again, after the interface language changed. */
export function refreshTrayMenu(): void {
  buildTrayMenu()
}

export function refreshHotkey(): void {
  hotkeyRefresher?.()
}

/** A notification raised by the renderer, for instance when a timer runs out. */
export function notifyFromRenderer(title: string, body: string): void {
  if (!notify(title, body)) throw new Error(errorText('app.notify.unsupported'))
}
