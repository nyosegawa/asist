import { app, autoUpdater as squirrel } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import mitt from 'mitt'
import { autoUpdater } from 'electron-updater'
import { AppUpdateController, afterStaging, type AppUpdateState, type Updater } from '@shared/app-update'
import { errorText } from '@shared/i18n/error-text'
import { platformCapabilities } from './platform'

/**
 * electron-builder writes app-update.yml, the address of the releases, only into a build that has a publish
 * setting and an updatable target. On macOS that is a build with a dmg or zip target, which only
 * scripts/release.mjs makes; on Windows it is the NSIS installer built with the GitHub setting that only the
 * release workflow passes. A local `dist:mac` or `dist:win` has none, and updating it from a release would
 * replace a build of unreleased code.
 */
const FEED = 'app-update.yml'
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * How long a start that failed waits on a check that has not answered, or on a download that has received
 * nothing, before it quits without the update. electron-updater's own timeout waits for a `socket` event that
 * the requests of Electron's net never emit (electron-updater 6.8.9, Electron 43.7.7), so it never gives up on a
 * stalled connection, and an app that shows nothing would stay alive while the single-instance lock refuses
 * every later launch. A check against GitHub answered in about a second (2026-10-02), and electron-updater
 * reports a download's progress every second while bytes arrive.
 */
const FAILED_START_STALL_MS = 30_000

export const events = mitt<{ changed: AppUpdateState }>()

let controller: AppUpdateController | null = null

export function appUpdateState(): AppUpdateState {
  return controller?.state ?? { phase: 'off' }
}

/**
 * The updater whose update-downloaded means that the next quit installs the version. The NSIS updater reports
 * it once the installer is on disk and matches latest.yml, and runs that installer itself when the app quits,
 * so on Windows its own event already means it.
 */
function installableUpdater(): Updater {
  return platformCapabilities().os === 'macos' ? afterStaging(autoUpdater, squirrel) : autoUpdater
}

export function initAppUpdates(): void {
  if (controller || !app.isPackaged || !fs.existsSync(path.join(process.resourcesPath, FEED))) return
  autoUpdater.logger = console
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  // A release carries only the full installer. Left false, the NSIS updater warns about a web installer on
  // every download.
  autoUpdater.disableWebInstaller = true
  controller = new AppUpdateController(installableUpdater(), {
    now: Date.now,
    onChange: (state) => {
      if (state.phase === 'failed') console.error('app update failed:', state.message)
      events.emit('changed', state)
    }
  })
  controller.check()
  setInterval(() => controller?.check(), CHECK_INTERVAL_MS)
}

/**
 * The install of the downloaded version, checked now so that the about page hears why it cannot start.
 * Installing quits the app, so the caller runs it through the same gate as any other quit.
 */
export function readyUpdateInstall(): () => void {
  const ready = controller
  if (!ready) throw new Error('automatic updates are off in this build')
  if (ready.state.phase !== 'ready') throw new Error(`no update is ready to install (${ready.state.phase})`)
  return () => ready.install()
}

/**
 * The newer version a start that failed installs before it quits, or null when this build does not update,
 * the running version is the latest, or the check fails or stalls. The updater starts last in a start, so a
 * start that failed never reached it and it starts here. The caller asks once its error dialog is closed: on
 * macOS, Electron's net delivers no response body while dialog.showErrorBox is open (Electron 43.7.7,
 * 2026-10-02), so a check started before the dialog would only wait on it.
 */
export async function versionAfterFailedStart(): Promise<string | null> {
  initAppUpdates()
  const state = await settledState((state) => state.phase !== 'checking')
  return state.phase === 'downloading' || state.phase === 'ready' ? state.version : null
}

/** The install of the version found after a failed start, once it is downloaded. Throws why the download failed or stalled. */
export async function installAfterFailedStart(): Promise<() => void> {
  const state = await settledState((state) => state.phase !== 'checking' && state.phase !== 'downloading')
  if (state.phase === 'failed') throw new Error(state.message)
  return readyUpdateInstall()
}

/**
 * The first state of the update that `settled` accepts, the current one included. A wait for the network that
 * hears nothing for FAILED_START_STALL_MS ends as a failure. Once the whole version is downloaded nothing is
 * cut short: Squirrel.Mac reports nothing while it unpacks and verifies the version, and reads no network.
 */
function settledState(settled: (state: AppUpdateState) => boolean): Promise<AppUpdateState> {
  return new Promise((resolve) => {
    let stall: ReturnType<typeof setTimeout> | undefined
    const finish = (state: AppUpdateState): void => {
      clearTimeout(stall)
      events.off('changed', follow)
      resolve(state)
    }
    const follow = (state: AppUpdateState): void => {
      clearTimeout(stall)
      if (settled(state)) return finish(state)
      const waitsForNetwork = state.phase === 'checking' || (state.phase === 'downloading' && state.percent < 100)
      if (!waitsForNetwork) return
      stall = setTimeout(() => {
        console.error(`app update after a failed start: nothing received for ${FAILED_START_STALL_MS / 1000} s (${state.phase})`)
        finish({ phase: 'failed', message: errorText('app.startup.updateStalled') })
      }, FAILED_START_STALL_MS)
    }
    events.on('changed', follow)
    follow(appUpdateState())
  })
}
