import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/** The entries of a watched folder that may have changed, or everything in it. */
export type FolderChange = { names: string[] } | { all: true }

export interface FolderWatch {
  close(): void
}

/**
 * The wait from the first event to the report, so that one report serves all the events of one save (a
 * temporary file and its rename over the target). FSEvents holds events back for 50 ms (libuv 1.52), and of
 * ten saves, eight arrived in one batch and two in two batches 50 ms apart (Apple M5, 2026-10-02).
 */
const SETTLE_MS = 100

/**
 * FSEvents watches a path, so on macOS a watch that is open goes on reporting the folder put at the path in
 * place of the one it was opened on, and it is never opened again for that. Opening another would lose
 * changes: libuv (1.52) makes a new FSEvents stream for every watch opened or closed, on a thread of its own
 * after fs.watch has returned, and what changes before that stream runs is never reported. Under load from
 * other work, a note written into a replaced folder after its new watch was opened went unreported (Apple M5,
 * 2026-10-02). ReadDirectoryChangesW watches the folder it was opened on wherever it is moved, and it runs
 * once fs.watch has returned, so on Windows the watch is opened again on the folder now at the path.
 */
const WATCH_FOLLOWS_PATH = process.platform === 'darwin'

/**
 * Reports what may have changed in one folder, from fs.watch on macOS (FSEvents) and Windows
 * (ReadDirectoryChangesW). An event says only that something happened to a name: FSEvents reports a new
 * file, a write in place and a deletion all as 'rename', so the caller looks at each named entry itself.
 * The watch is not recursive, so an entry inside a subfolder is never reported.
 *
 * A report of everything means the caller has to look at the whole folder again: when Windows's buffer of
 * events overflowed (no name), when FSEvents reports the folder itself (it does so when it coalesced events
 * below it, and when the folder was moved, removed or put back), and when the folder at the path is another
 * one than before. The parent folder is watched for that last case, because on Windows the watch follows the
 * folder it was opened on wherever it is moved, and sees nothing of a new folder put at the path.
 *
 * On macOS a watch reports only from a moment after it opens (see WATCH_FOLLOWS_PATH), so a change made in
 * that moment is seen only when that entry changes again.
 */
export async function watchFolder(directory: string, onChange: (change: FolderChange) => void): Promise<FolderWatch> {
  const ownName = path.basename(directory)
  let closed = false
  let folder: fs.FSWatcher | null = null
  // The identity of the folder watched, or null while no folder is at the path.
  let identity: string | null = null
  let names = new Set<string>()
  let everything = false
  let checkFolder = false
  let timer: NodeJS.Timeout | null = null
  // The reports run one after another, so that two never open a watch of the folder at once.
  let flushing = Promise.resolve()

  const schedule = (): void => {
    timer ??= setTimeout(() => {
      flushing = flushing.then(flush).catch((error: unknown) => console.error('folder watch: a change could not be reported:', error))
    }, SETTLE_MS)
  }
  const stopFolder = (): void => {
    folder?.close()
    folder = null
  }
  const onFolderEvent = (_event: string, name: string | null): void => {
    if (name === null) everything = true
    else if (path.isAbsolute(name)) {
      // Windows names the folder by its full path when it is being deleted, and the deletion waits until
      // every handle on the folder is closed, this watch's included.
      stopFolder()
      checkFolder = true
    } else if (name === ownName) {
      checkFolder = true
      everything = true
    } else names.add(name)
    schedule()
  }
  const onFolderError = (error: Error): void => {
    console.warn('folder watch: the watch of the folder failed and is opened again:', error)
    stopFolder()
    checkFolder = true
    schedule()
  }
  const onParentEvent = (_event: string, name: string | null): void => {
    if (name !== null && name !== ownName) return
    checkFolder = true
    schedule()
  }

  // Watches the folder now at the path, and says whether what is there may differ from what was reported.
  const follow = async (): Promise<boolean> => {
    const now = await identityOf(directory)
    if (closed) return false
    const replaced = now !== identity
    identity = now
    if (folder && (!replaced || WATCH_FOLLOWS_PATH)) return replaced
    stopFolder()
    if (now === null) return replaced
    try {
      folder = fs.watch(directory, { persistent: false }, onFolderEvent)
      folder.on('error', onFolderError)
    } catch (error) {
      if (!isMissing(error)) throw error
      identity = null
    }
    return true
  }

  const flush = async (): Promise<void> => {
    timer = null
    const changed = names
    names = new Set()
    let all = everything
    everything = false
    try {
      if (checkFolder) {
        checkFolder = false
        if (await follow()) all = true
      }
    } catch (error) {
      console.error('folder watch: the folder could not be looked at:', error)
      all = true
    }
    if (closed) return
    if (all) onChange({ all: true })
    else if (changed.size > 0) onChange({ names: [...changed] })
  }

  const parent = fs.watch(path.dirname(directory), { persistent: false }, onParentEvent)
  parent.on('error', (error) => {
    console.error('folder watch: the watch of the parent folder failed, and a folder put in place of the watched one goes unseen:', error)
    parent.close()
  })
  try {
    await follow()
  } catch (error) {
    parent.close()
    throw error
  }

  return {
    close: () => {
      closed = true
      if (timer) clearTimeout(timer)
      stopFolder()
      parent.close()
    }
  }
}

/** The device and inode of the folder at the path, or null when there is none. */
async function identityOf(directory: string): Promise<string | null> {
  try {
    const stat = await fsp.stat(directory, { bigint: true })
    return `${stat.dev}:${stat.ino}`
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}
