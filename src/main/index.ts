import './environment'
import { logRenderer } from './logging'
import { app, BrowserWindow, dialog, nativeImage, shell } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import net from 'node:net'
import dns from 'node:dns'

// undici's happy-eyeballs tries IPv6 first and reports a false ETIMEDOUT on a network with no IPv6
// route, which broke connections to hosts such as open-meteo, so it is disabled in favour of IPv4.
net.setDefaultAutoSelectFamily?.(false)
dns.setDefaultResultOrder('ipv4first')
import { registerIpc } from './ipc'
import { leaveOs, notify, quitAfterAgentsStop, setupOsIntegration } from './os-integration'
import * as asr from './services/asr'
import * as tts from './services/tts'
import * as aizuchi from './services/aizuchi'
import * as aizuchiClassifier from './services/aizuchi-classifier'
import * as watchdog from './services/watchdog'
import { initJobReporting } from './services/brain/job-reporting'
import { compactionJob, initMaintenance } from './services/maintenance'
import * as memory from './services/memory'
import { initAppUpdates, installAfterFailedStart, versionAfterFailedStart } from './services/app-update'
import { initMemoryCuration } from './services/memory-curation'
import { allowedFileRoots } from './services/agent'
import { handleFileScheme, registerFileScheme } from './file-protocol'
import { errorMessageIn, translatorIn } from './services/i18n'
import { platformCapabilities } from './services/platform'
import { getSettings } from './services/settings'
import type { UiLocale } from '@shared/i18n'
import { initMail } from './services/mail'
import { isAppPage } from '@shared/app-page'
import { isExternalLink } from '@shared/external-link'
import { windowChrome } from './window-chrome'
import { closeAppPage, watchAppPage } from './page-lifetime'

let mainWindow: BrowserWindow | null = null
const hasSingleInstanceLock = app.requestSingleInstanceLock()
// asist-file://, which the files card fetches images, documents, audio and video over, has to be
// registered before whenReady.
registerFileScheme()

/** The permissions the app's own page asks for: the microphone, copying a job's text, and a video in full screen. */
const PAGE_PERMISSIONS = new Set(['media', 'clipboard-sanitized-write', 'fullscreen'])

/**
 * The page the window shows, and the only page trusted with the preload bridge. A development launch takes
 * it from electron-vite's server; a packaged app always shows the page inside its package, whatever its
 * environment says.
 */
function appPageUrl(): string {
  const devServer = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
  return devServer ?? pathToFileURL(path.join(__dirname, '../renderer/index.html')).href
}

function createWindow(): void {
  const chrome = windowChrome(platformCapabilities().os)
  const appPage = appPageUrl()
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: 'ASIST',
    backgroundColor: '#05070F',
    ...chrome.frame,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.maximize()
    mainWindow?.show()
  })

  // A Google link inside the map card's iframe, such as the one that opens the larger map, goes to the
  // default browser instead of a window inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalLink(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // The preload bridge is exposed to whatever page this window shows, so the window never leaves the
  // app's page: a link clicked in a document or a file dropped on the window would otherwise hand the
  // whole API to that page. A web or mail link opens in its own app instead.
  mainWindow.webContents.on('will-navigate', (event) => {
    if (isAppPage(event.url, appPage)) return
    event.preventDefault()
    if (isExternalLink(event.url)) void shell.openExternal(event.url)
  })

  // Electron grants every permission by default, including to the map's iframe.
  const { session } = mainWindow.webContents
  session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(PAGE_PERMISSIONS.has(permission) && details.isMainFrame && isAppPage(details.requestingUrl, appPage))
  })
  session.setPermissionCheckHandler((_contents, permission, _origin, details) =>
    PAGE_PERMISSIONS.has(permission) && details.isMainFrame && isAppPage(details.requestingUrl ?? '', appPage)
  )

  watchAppPage(mainWindow, appPage)
  logRenderer(mainWindow, appPage)
  registerIpc(mainWindow, appPage)
  setupOsIntegration(mainWindow)

  void mainWindow.loadURL(appPage)
}

/**
 * The interface language of what a failed start shows. It is read from the settings file, and a settings file
 * that cannot be read is one of the failures reported here, so a failing read leaves the text in the language
 * the messages are written in rather than leaving no window at all.
 */
function startupLocale(): UiLocale {
  try {
    return getSettings().uiLocale
  } catch {
    return 'ja-JP'
  }
}

/**
 * Shows why the start failed, then quits. A release that cannot start is fixed only by a newer one, which an
 * app that fails at every start would otherwise never receive, so the quit installs and starts a newer version
 * when the check finds one. Nothing of the start stays up meanwhile, so a notification is all that tells the
 * user a download is under way.
 */
async function quitAfterFailedStart(error: unknown): Promise<void> {
  // A start that failed after its window opened closes it before the error shows: the page would load under the
  // error, show itself once the error is closed, and listen and speak while a newer version downloads.
  if (mainWindow) {
    leaveOs()
    closeAppPage(mainWindow)
  }
  const locale = startupLocale()
  const text = translatorIn(locale)
  dialog.showErrorBox(text('app.startup.launchFailed'), errorMessageIn(locale, error))
  try {
    const version = await versionAfterFailedStart()
    if (version !== null) {
      const notice = (): boolean => notify(text('app.startup.launchFailed'), text('app.startup.updating', { version }))
      notice()
      // A second launch quits on the single-instance lock, so this one says again what it is doing.
      app.on('second-instance', notice)
      quitAfterAgentsStop(await installAfterFailedStart())
      return
    }
  } catch (updateError) {
    console.error('app update after a failed start:', updateError)
    dialog.showErrorBox(text('app.startup.updateFailed'), errorMessageIn(locale, updateError))
  }
  // A service that started before the failure may have started an agent, the memory curation, so this quit too
  // goes through the gate that stops it.
  quitAfterAgentsStop()
}

if (!hasSingleInstanceLock) {
  // Two processes updating the same userData notify a timer twice and lose JSON updates, so the second
  // one quits.
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    // A development launch uses the same image as the packaged app rather than Electron's default icon.
    if (process.platform === 'darwin' && !app.isPackaged) {
      const icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'build/icon.png'))
      if (icon.isEmpty()) throw new Error('cannot load build/icon.png')
      app.dock?.setIcon(icon)
    }
    // An OS or CPU the app is not built for stops the launch before any service starts. The app's menu and its
    // identity come next, before anything else that can fail.
    windowChrome(platformCapabilities().os).prepare()
    // Reading the settings first keeps a broken file from starting any service; the original file is kept
    // and the place to fix is shown.
    getSettings()
    handleFileScheme(allowedFileRoots)

    // In self-test mode the whole pipeline runs against the real services and the app then exits.
    if (process.env.ASIST_SELFTEST === '1') {
      void import('./services/selftest').then(async ({ runSelfTest }) => {
        const failed = await runSelfTest().catch((err) => {
          console.error('selftest crashed:', err)
          return 99
        })
        app.exit(failed)
      })
      return
    }

    initJobReporting()
    initMaintenance([compactionJob])
    // Mail connects to the accounts in the settings and starts fetching; a failure shows up on the
    // settings screen and in the conversation.
    initMail()
    // Memory builds its index from the files and watches for a curation job being merged. The worker
    // starts only when semantic search is on.
    memory.ensureLoaded()
    initMemoryCuration()

    // The window and the voice open only once the services have started, so that a service that fails to start
    // leaves no page that would listen and speak while the failed start downloads a newer version.
    createWindow()
    // The sidecars are warmed up here, and a failure does not stop the app from starting.
    watchdog.checkAfter(asr.ensureServer().catch((error) => console.error('speech recognition failed to start:', error)))
    watchdog.checkAfter(tts.ensureEngine().then(() => aizuchi.getBank()).catch((error) => console.error('TTS preparation failed:', error)))
    // The aizuchi classifier stays resident when it is prepared and aizuchi are wanted; without it no
    // aizuchi plays at the head of a turn.
    if (aizuchiClassifier.wanted(getSettings())) void aizuchiClassifier.ensureStarted()
    void memory.startEmbeddingIfEnabled().catch((err) => console.error('memory embedding:', err))
    initAppUpdates()

    // The window only hides when it is closed and is destroyed only by a quit or by a start that failed, which
    // never reaches here, so it is never created a second time, which would register the IPC handlers again.
    app.on('activate', () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show()
    })
  }).catch((error: unknown) => quitAfterFailedStart(error))
}

// The window closes only when the app quits, which ends the app by itself, or when a start that failed closes it
// before it checks for an update, which must not end the app, so the last window closing never quits.
app.on('window-all-closed', () => undefined)
