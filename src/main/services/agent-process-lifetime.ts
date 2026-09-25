import type { ChildProcess } from 'node:child_process'
import { errorText } from '@shared/i18n/error-text'

export interface AgentProcess {
  completion: Promise<void>
  stop(): void
}

/** Owns the agent until stdout has closed and its own process group is confirmed gone. */
export function manageAgentProcess(child: ChildProcess, onClose: (code: number | null) => void): AgentProcess {
  let streamsClosed = false
  let exitCode: number | null = null
  let finished = false
  let stopping = false
  let forceTimer: ReturnType<typeof setTimeout> | undefined
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  let groupWatch: ReturnType<typeof setInterval> | undefined
  let resolve!: () => void
  let reject!: (error: Error) => void
  const completion = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  // A rejection that happens before anyone awaits must not become an unhandled rejection. The caller
  // still receives the original promise.
  void completion.catch(() => {})
  const signalGroup = (signal: NodeJS.Signals | 0): boolean => {
    if (child.pid === undefined) return false
    try {
      process.kill(-child.pid, signal)
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ESRCH') return false
      // macOS answers EPERM for a group whose members have all exited but are not reaped yet, which is
      // how a stopped descendant waits for launchd, and for a member running as another user. Either way
      // the group still exists, and the watch goes on until it is gone or the deadline passes.
      if (code === 'EPERM') return true
      throw error
    }
  }
  const clearTimers = (): void => {
    clearTimeout(forceTimer)
    clearTimeout(deadlineTimer)
    clearInterval(groupWatch)
  }
  const checkCompletion = (): boolean => {
    if (finished) return true
    if (!streamsClosed) return false
    try {
      if (signalGroup(0)) return false
      finished = true
      clearTimers()
      onClose(exitCode)
      resolve()
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    return finished
  }
  const stop = (): void => {
    if (finished || stopping) return
    stopping = true
    try { signalGroup('SIGTERM') } catch (error) { reject(error as Error) }
    // Sending the signal successfully does not make the process finished: settling the output waits until
    // the descendants are gone.
    forceTimer = setTimeout(() => {
      try {
        signalGroup('SIGKILL')
        checkCompletion()
      } catch (error) { reject(error as Error) }
    }, 2_000)
    deadlineTimer = setTimeout(() => reject(new Error(errorText('jobs.process.stopTimedOut'))), 5_000)
  }
  child.once('close', (code: number | null) => {
    streamsClosed = true
    exitCode = code
    if (checkCompletion()) return
    // Even a CLI that exited on its own can leave a child process behind with its stdio detached.
    stop()
    if (!finished) {
      // Ownership is not given up after the deadline: a late confirmation still settles the job's state.
      groupWatch = setInterval(checkCompletion, 25)
    }
  })
  return { completion, stop }
}
