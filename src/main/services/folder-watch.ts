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
 * Reports what may have changed in one folder, from fs.watch on macOS (FSEvents) and Windows
 * (ReadDirectoryChangesW). An event says only that something happened to a name: FSEvents reports a new
 * file, a write in place and a deletion all as 'rename', so the caller looks at each named entry itself.
 * The watch is not recursive, so an entry inside a subfolder is never reported.
 *
 * A report of everything means the caller has to look at the whole folder again: when Windows's buffer of
 * events overflowed (no name), when FSEvents reports the folder itself (it does so when it coalesced events
 * below it, and when the folder was moved, removed or put back), and when the folder at the path is no
 * longer the one watched. The parent folder is watched for that last case, because on Windows the watch
 * follows the folder it was opened on wherever it is moved, and sees nothing of a new folder put at the path.
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

  // Watches the folder now at the path, and says whether it is another one than was watched.
  const follow = async (): Promise<boolean> => {
    const now = await identityOf(directory)
    if (closed || (now === identity && (now === null || folder !== null))) return false
    stopFolder()
    identity = now
    if (now === null) return true
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
