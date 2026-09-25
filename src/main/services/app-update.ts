import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import mitt from 'mitt'
import { autoUpdater } from 'electron-updater'
import { AppUpdateController, type AppUpdateState } from '@shared/app-update'

/**
 * electron-builder writes app-update.yml, the address of the releases, only into a build with a dmg or zip
 * target, which is what scripts/release.mjs makes. The local `dist:mac` build has none, and updating it
 * from a release would replace a build of unreleased code.
 */
const FEED = 'app-update.yml'
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export const events = mitt<{ changed: AppUpdateState }>()

let controller: AppUpdateController | null = null

export function appUpdateState(): AppUpdateState {
  return controller?.state ?? { phase: 'off' }
}

export function initAppUpdates(): void {
  if (controller || !app.isPackaged || !fs.existsSync(path.join(process.resourcesPath, FEED))) return
  autoUpdater.logger = console
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  controller = new AppUpdateController(autoUpdater, {
    now: Date.now,
    onChange: (state) => {
      if (state.phase === 'failed') console.error('app update failed:', state.message)
      events.emit('changed', state)
    }
  })
  controller.check()
  setInterval(() => controller?.check(), CHECK_INTERVAL_MS)
}

export function installAppUpdate(): void {
  if (!controller) throw new Error('automatic updates are off in this build')
  controller.install()
}
