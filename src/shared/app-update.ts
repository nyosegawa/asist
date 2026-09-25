/**
 * Where the automatic update of the app stands, as the about page shows it. `off` is a build that does not
 * come from a release (a development run or a local `dist:mac`), which has no feed to update from. An
 * update is downloaded in the background and installed by macOS when the app next quits.
 */
export type AppUpdateState =
  | { phase: 'off' }
  | { phase: 'checking' }
  | { phase: 'current'; checkedAt: number }
  | { phase: 'downloading'; version: string; percent: number }
  | { phase: 'ready'; version: string }
  | { phase: 'failed'; message: string }

/** The part of electron-updater's autoUpdater the controller uses, so that a test can stand in for it. */
export interface Updater {
  on(event: 'checking-for-update', listener: () => void): unknown
  on(event: 'update-not-available', listener: () => void): unknown
  on(event: 'update-available', listener: (info: { version: string }) => void): unknown
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown
  on(event: 'update-downloaded', listener: (info: { version: string }) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  checkForUpdates(): Promise<unknown>
  quitAndInstall(): void
}

/**
 * Follows the updater's events and keeps one state. A check while one is running, while a version is
 * downloading or once one is waiting to be installed would only start the same download again, so it is
 * skipped.
 */
export class AppUpdateController {
  private current: AppUpdateState = { phase: 'checking' }

  constructor(
    private readonly updater: Updater,
    private readonly options: { now: () => number; onChange: (state: AppUpdateState) => void }
  ) {
    updater.on('checking-for-update', () => this.set({ phase: 'checking' }))
    updater.on('update-not-available', () => this.set({ phase: 'current', checkedAt: options.now() }))
    updater.on('update-available', (info) => this.set({ phase: 'downloading', version: info.version, percent: 0 }))
    updater.on('download-progress', (progress) => {
      if (this.current.phase !== 'downloading') return
      this.set({ ...this.current, percent: Math.floor(progress.percent) })
    })
    updater.on('update-downloaded', (info) => this.set({ phase: 'ready', version: info.version }))
    updater.on('error', (error) => this.set({ phase: 'failed', message: error.message }))
  }

  get state(): AppUpdateState {
    return this.current
  }

  check(): void {
    const { phase } = this.current
    if (phase === 'downloading' || phase === 'ready') return
    // A failed check also emits 'error', which is where the state and the log take it from, so the
    // rejection itself carries nothing more.
    this.updater.checkForUpdates().catch(() => undefined)
  }

  /** Quits and installs the downloaded version now, instead of at the next quit. */
  install(): void {
    if (this.current.phase !== 'ready') throw new Error(`no update is ready to install (${this.current.phase})`)
    this.updater.quitAndInstall()
  }

  private set(state: AppUpdateState): void {
    this.current = state
    this.options.onChange(state)
  }
}
