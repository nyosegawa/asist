import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import type { AgentProcessIdentity } from '@shared/ipc'
import { errorText } from '@shared/i18n/error-text'
import { childEnv } from '../child-env'
import type { AgentEvents, AgentOwner, AgentProcess } from './owner'

/** Carried across the exec and inherited by descendants. It identifies this one launch and is not a credential. */
export const AGENT_PROCESS_TOKEN = 'ASIST_AGENT_EXECUTION_ID'

/** A stop sends SIGTERM, and SIGKILL to whatever is left once this long has passed. */
const KILL_AFTER_MS = 2_000
/** A stop that has not seen the agent gone by then is reported as failed. */
const STOP_DEADLINE_MS = 5_000
/**
 * How often the processes carrying the token are looked for. ps then reads the environment of every process
 * of the user, which took about 50 ms for 500 processes on an Apple Silicon Mac (2026-10-02), on main's
 * thread, so it runs far less often than the check of the CLI's own group.
 */
const TOKEN_SCAN_MS = 500

interface GroupMember { pid: number; pgid: number; state: string; startedAt: string }

function processTable(): GroupMember[] {
  const output = execFileSync('/bin/ps', ['-axo', 'pid=,pgid=,stat=,lstart='], {
    encoding: 'utf8', timeout: 2_000, maxBuffer: 4 * 1024 * 1024,
    env: childEnv({ LC_ALL: 'C' }), windowsHide: true
  })
  const lines = output.split('\n').filter((line) => line.trim())
  if (lines.length === 0) throw new Error(errorText('jobs.process.tableUnreadable'))
  return lines.map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/)
    if (!match) throw new Error(errorText('jobs.process.tableUnparsable'))
    return { pid: Number(match[1]), pgid: Number(match[2]), state: match[3], startedAt: match[4] }
  })
}

export function captureProcessIdentity(pid: number, token: string): AgentProcessIdentity {
  const member = processTable().find((row) => row.pid === pid)
  if (!member || member.pgid !== pid) throw new Error(errorText('jobs.process.groupUnconfirmed'))
  return { pid, startedAt: member.startedAt, token }
}

/** Whether a line of ps holds the token as a variable of the environment. */
function tokenPattern(token: string): RegExp {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|\\s)${AGENT_PROCESS_TOKEN}=${escaped}(?:\\s|$)`)
}

/**
 * Whether the member carries the agent's token. 'unreadable' means its environment could not be read on this
 * pass, so it is neither ours nor foreign yet.
 */
function memberToken(pid: number, token: string): 'ours' | 'foreign' | 'unreadable' {
  // The environment ps prints can contain secrets, so it is only matched against and neither the raw
  // output nor the underlying error leaves this function.
  let environment: string
  try {
    environment = execFileSync('/bin/ps', ['eww', '-p', String(pid), '-o', 'command='], {
      encoding: 'utf8', timeout: 2_000, maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'], env: childEnv(), windowsHide: true
    })
  } catch (error) {
    // ps exits with 1 when the member ended after the table was read.
    if ((error as { status?: number | null }).status === 1) return 'unreadable'
    throw new Error(errorText('jobs.process.tokenUnreadable'))
  }
  if (tokenPattern(token).test(environment)) return 'ours'
  // A process that is exiting stays in the table as "Ss", "Rs" or "?Es" for a few milliseconds after the
  // kernel has released its arguments, and ps then prints "(node)" or "<defunct>" with no environment.
  // Measured on macOS 26.2 on 2026-09-22: 22 of 1431 reads of a Node process around its exit. Another
  // user's process prints the same form, so it proves nothing about ownership either way.
  if (/^(?:\(.*\)|<defunct>)$/.test(environment.trim())) return 'unreadable'
  return 'foreign'
}

interface TokenHolder { pid: number; pgid: number }

/**
 * Every process whose environment carries the agent's token. claude and codex run each command in a session
 * or process group of their own, which a signal to the CLI's group does not reach but which inherits the
 * CLI's environment. ps prints each process's environment on its line, and a value can hold a newline, so a
 * line that shows the token is only a lead, confirmed by reading that one process.
 */
function tokenHolders(token: string): TokenHolder[] {
  // The environment ps prints can contain secrets, so it is only matched against and neither the raw
  // output nor the underlying error leaves this function.
  let output: string
  try {
    output = execFileSync('/bin/ps', ['-x', '-ww', '-E', '-o', 'pid=,pgid=,command='], {
      encoding: 'utf8', timeout: 2_000, maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'], env: childEnv(), windowsHide: true
    })
  } catch {
    throw new Error(errorText('jobs.process.tokenUnreadable'))
  }
  const carries = tokenPattern(token)
  const leads = new Map<number, number>()
  let current: TokenHolder | undefined
  for (const line of output.split('\n')) {
    const start = /^\s*(\d+)\s+(\d+)\s/.exec(line)
    if (start) current = { pid: Number(start[1]), pgid: Number(start[2]) }
    if (current && carries.test(line)) leads.set(current.pid, current.pgid)
  }
  return [...leads].filter(([pid]) => memberToken(pid, token) === 'ours').map(([pid, pgid]) => ({ pid, pgid }))
}

/** The signal a stop sends at this point: SIGTERM, and SIGKILL to whatever is left from KILL_AFTER_MS on. */
const phaseSignal = (elapsed: number): NodeJS.Signals => (elapsed >= KILL_AFTER_MS ? 'SIGKILL' : 'SIGTERM')

/** Sends each process the signal once, and nothing more once it was sent SIGKILL. */
function signalOnce(sent: Map<number, NodeJS.Signals>, pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    const previous = sent.get(pid)
    if (previous === signal || previous === 'SIGKILL') continue
    sent.set(pid, signal)
    try {
      process.kill(pid, signal)
    } catch (error) {
      // ESRCH is a process that ended after it was read.
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error(errorText('jobs.process.exitUnconfirmed'))
    }
  }
}

/** What a later run of ASIST finds of an agent: nothing, processes it cannot judge on this pass, or its processes to stop. */
export type AgentRemains = { state: 'gone' } | { state: 'unreadable' } | { state: 'owned'; pids: number[] }

/**
 * A PID alone never stops another process. Every remaining member of the agent's group is checked, even once
 * the leader is gone, and every process outside the group that carries the agent's token is the agent's too.
 */
export function inspectProcessIdentity(identity: AgentProcessIdentity): AgentRemains {
  const members = processTable().filter((row) => row.pgid === identity.pid && !row.state.startsWith('Z'))
  const tokens = members.map((member) => memberToken(member.pid, identity.token))
  const leader = members.find((row) => row.pid === identity.pid)
  // macOS, like BSD, never gives a new process a PID that is still the id of a process group, so a leader
  // that started at another time, in a group where no member carries the token, means the agent's group
  // ended and its PID went to another process, which is left alone. ps prints the start time in the local
  // time zone, so the same agent also shows another start time after the Mac changed time zone, and its
  // token tells it apart.
  const reused = leader !== undefined && leader.startedAt !== identity.startedAt && !tokens.includes('ours')
  if (!reused) {
    for (const token of tokens) {
      if (token === 'unreadable') return { state: 'unreadable' }
      if (token === 'foreign') throw new Error(errorText('jobs.process.tokenMismatch'))
    }
  }
  const pids = new Set(tokenHolders(identity.token).map((holder) => holder.pid))
  if (!reused) for (const member of members) pids.add(member.pid)
  return pids.size === 0 ? { state: 'gone' } : { state: 'owned', pids: [...pids] }
}

/** Stops only an agent whose parent link a restart broke, and settles its output once it can no longer write. */
export function recoverAgentProcess(identity: AgentProcessIdentity, onStopped: () => void): AgentProcess {
  let running = false
  let resolve!: () => void
  let reject!: (error: Error) => void
  const completion = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  void completion.catch(() => {})
  const stop = (): Promise<void> => {
    if (running) return completion
    running = true
    const started = Date.now()
    const sent = new Map<number, NodeJS.Signals>()
    const check = (): void => {
      try {
        const remains = inspectProcessIdentity(identity)
        if (remains.state === 'gone') {
          onStopped()
          resolve()
          return
        }
        const elapsed = Date.now() - started
        if (elapsed >= STOP_DEADLINE_MS) {
          throw new Error(errorText(remains.state === 'owned' ? 'jobs.process.staleRunning' : 'jobs.process.tokenUnreadable'))
        }
        // An unconfirmed group receives no signal; the next pass sees an exiting member as a zombie or gone.
        if (remains.state === 'owned') signalOnce(sent, remains.pids, phaseSignal(elapsed))
        setTimeout(check, TOKEN_SCAN_MS)
      } catch (error) {
        reject(error instanceof Error ? error : new Error(errorText('jobs.process.exitUnconfirmed')))
      }
    }
    // The recovery event fires only after the caller has registered the completion and the process.
    queueMicrotask(check)
    return completion
  }
  return { completion, stop }
}

/** One stop of a running agent, from its SIGTERM to the agent gone or the deadline. */
interface Stop {
  startedAt: number
  /** The signals sent to each process outside the CLI's group, and to the group under its negative id. */
  sent: Map<number, NodeJS.Signals>
  timers: Array<ReturnType<typeof setTimeout>>
  done: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
}

/**
 * Owns the agent until stdout has closed, its own process group is confirmed gone, and no process carrying
 * its token is left.
 */
export function manageAgentProcess(child: ChildProcess, token: string, events: AgentEvents): AgentProcess {
  let streamsClosed = false
  let exitCode: number | null = null
  let finished = false
  let lastScan = -Infinity
  let watch: ReturnType<typeof setInterval> | undefined
  let stopping: Stop | undefined
  let resolve!: () => void
  let reject!: (error: Error) => void
  const completion = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  // A rejection that happens before anyone awaits must not become an unhandled rejection. The caller
  // still receives the original promise.
  void completion.catch(() => {})
  const fail = (error: unknown): void => {
    const failure = error instanceof Error ? error : new Error(String(error))
    reject(failure)
    stopping?.reject(failure)
  }
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
  /** Sends the signal of the stop's phase to the CLI's group and to each process outside it that carries the token. */
  const signalAll = (current: Stop, holders: TokenHolder[]): void => {
    const signal = phaseSignal(Date.now() - current.startedAt)
    if (child.pid !== undefined) {
      const group = -child.pid
      const previous = current.sent.get(group)
      if (previous !== signal && previous !== 'SIGKILL') {
        current.sent.set(group, signal)
        signalGroup(signal)
      }
    }
    signalOnce(current.sent, holders.filter((holder) => holder.pgid !== child.pid).map((holder) => holder.pid), signal)
  }
  const finish = (): void => {
    finished = true
    clearInterval(watch)
    for (const timer of stopping?.timers ?? []) clearTimeout(timer)
    try {
      events.onClose(exitCode)
      resolve()
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    stopping?.resolve()
  }
  const checkCompletion = (): void => {
    if (finished || !streamsClosed) return
    try {
      if (signalGroup(0)) return
      if (Date.now() - lastScan < TOKEN_SCAN_MS) return
      lastScan = Date.now()
      const holders = tokenHolders(token)
      if (holders.length === 0) {
        finish()
        return
      }
      if (stopping) signalAll(stopping, holders)
    } catch (error) {
      fail(error)
    }
  }
  const stop = (): Promise<void> => {
    if (finished) return completion
    if (stopping) return stopping.done
    let resolveStop!: () => void
    let rejectStop!: (error: Error) => void
    const done = new Promise<void>((settled, failed) => { resolveStop = settled; rejectStop = failed })
    // A caller may leave the stop's outcome to onStopFailed and never wait for it.
    void done.catch(() => {})
    const current: Stop = { startedAt: Date.now(), sent: new Map(), timers: [], done, resolve: resolveStop, reject: rejectStop }
    stopping = current
    try {
      signalAll(current, tokenHolders(token))
    } catch (error) {
      fail(error)
    }
    // Sending the signal successfully does not make the process finished: settling the output waits until
    // the descendants are gone.
    current.timers.push(setTimeout(() => {
      try {
        signalAll(current, tokenHolders(token))
        checkCompletion()
      } catch (error) {
        fail(error)
      }
    }, KILL_AFTER_MS))
    // Ownership is not given up after the deadline: a late confirmation still settles the job's state, and
    // the next stop sends the signals again.
    current.timers.push(setTimeout(() => {
      clearTimeout(current.timers[0])
      if (stopping === current) stopping = undefined
      const error = new Error(errorText('jobs.process.stopTimedOut'))
      events.onStopFailed(error)
      current.reject(error)
    }, STOP_DEADLINE_MS))
    return done
  }
  child.once('close', (code: number | null) => {
    streamsClosed = true
    exitCode = code
    checkCompletion()
    if (finished) return
    // Even a CLI that exited on its own can leave processes behind, in its group or in groups of their own.
    if (!stopping) void stop()
    watch = setInterval(checkCompletion, 25)
  })
  return { completion, stop }
}

/**
 * An agent on macOS is the process group of a shell that waits for permission to start: the CLI must not
 * start writing before the job is persisted, and if ASIST exits first, the EOF on stdin ends the shell
 * before the exec. The prompt follows the permission on the same stdin: the shell's read takes only the
 * first line from a pipe, and the CLI reads the rest (see agent-cli).
 */
export const posixOwner: AgentOwner = {
  start(cli, args, { cwd, env, token }, events) {
    const child = spawn('/bin/sh', ['-c', 'IFS= read -r ready && [ "$ready" = start ] && exec "$@"', 'asist-agent-launcher', cli, ...args], {
      cwd,
      env: { ...env, [AGENT_PROCESS_TOKEN]: token },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    return { child, identity: () => captureProcessIdentity(child.pid!, token), lifetime: manageAgentProcess(child, token, events) }
  },
  recover: recoverAgentProcess
}
