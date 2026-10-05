import { spawn, type ChildProcess } from 'node:child_process'

/**
 * A watcher that sends SIGTERM to a process group if ASIST ends, crashed or killed, while the group's leader
 * runs, on macOS. It is a shell in a session of its own that reads a pipe only ASIST writes to, and ASIST writes
 * a line there once the leader has exited, so that no watcher is left to signal the group's PID once another
 * process may have it. Kept out of the group, it never keeps the group alive after its leader. Windows needs no
 * watcher: libuv puts every child it starts without `detached` into a job object that closes with ASIST.
 */

/**
 * The watcher's script, given the leader's PID, which is also its group's. A line on its input means the leader
 * has exited; an end without one means ASIST is gone, and the group and every process descended from the leader
 * are sent SIGTERM. The descendants are read while the leader still links them, since claude's Bash tool and
 * codex run each command in a process group of their own, and codex 0.155.0 left its running command to finish
 * after it got SIGTERM itself (2026-10-02). The depth limit keeps a table read while processes come and go from
 * looping.
 */
const WATCHER = [
  'read -r _ && exit',
  'descendants=$(/bin/ps -axo pid=,ppid= | /usr/bin/awk -v root="$1" \'{ parent[$1] = $2 } END { for (pid in parent) { up = parent[pid]; for (depth = 0; (up in parent) && up != root && depth < 64; depth++) up = parent[up]; if (up == root) print pid } }\')',
  'kill -TERM -"$1" $descendants'
].join('\n')

/**
 * Starts the watcher of `leader`'s group, named `name` in the process table, and says whether it started. One
 * that could not be started, as at the limit of processes, leaves the caller to decide what runs without it; a
 * watcher killed later by someone else leaves the group running as it would be without one.
 */
export function watchForAsistEnd(leader: ChildProcess, env: NodeJS.ProcessEnv, name: string): boolean {
  const group = leader.pid!
  const watcher = spawn('/bin/sh', ['-c', WATCHER, name, String(group)], {
    env,
    detached: true,
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true
  })
  // A failed spawn is reported here with its reason after the caller has already reacted to the missing PID.
  const lost = (error: Error): void => console.error(`the watcher of ${name} ${group} is gone:`, error)
  watcher.on('error', lost)
  if (watcher.pid === undefined) return false
  watcher.stdin!.on('error', lost)
  leader.once('exit', () => watcher.stdin!.end('\n'))
  return true
}
