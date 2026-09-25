import type { Translate } from './i18n'
import type { JobLogEvent, JobLogLine } from './ipc'

/**
 * Folds a job log into rows for display. The main process stores the events as they arrive and the
 * shape of a row is decided here, so the card, the jobs screen and the text copied to the clipboard
 * all show the same thing.
 * - A command has a start and a done event under the same id, and they fold into one row.
 * - Repeated calls to the same reading tool fold into one row, shown as "Read ×5".
 * - A codex command is wrapped in `/bin/zsh -lc '...'`, so only the inner command is shown.
 */

export type JobLogRow =
  | { kind: 'system'; t: number; text: string }
  | { kind: 'stderr'; t: number; text: string }
  | { kind: 'assistant'; t: number; text: string }
  /** A tool call. A `count` above 1 means a run of calls to the same tool, and `detail` is the last call's. */
  | { kind: 'tool'; t: number; name: string; detail: string; count: number }
  | { kind: 'command'; t: number; command: string; status: 'running' | 'ok' | 'error'; exitCode?: number }
  | { kind: 'file'; t: number; paths: string[] }
  | { kind: 'result'; t: number; ok: boolean; text: string }

export function foldJobLog(lines: readonly JobLogLine[]): JobLogRow[] {
  const rows: JobLogRow[] = []
  const commandRow = new Map<string, number>()
  for (const { t, event } of lines) {
    const row = toRow(t, event)
    if (!row) continue
    if (event.kind === 'command') {
      const index = commandRow.get(event.id)
      if (event.phase === 'done' && index !== undefined) {
        rows[index] = row
        continue
      }
      commandRow.set(event.id, rows.length)
      rows.push(row)
      continue
    }
    const last = rows[rows.length - 1]
    if (row.kind === 'tool' && last?.kind === 'tool' && last.name === row.name) {
      rows[rows.length - 1] = { ...row, count: last.count + 1 }
      continue
    }
    rows.push(row)
  }
  return rows
}

function toRow(t: number, event: JobLogEvent): JobLogRow | null {
  switch (event.kind) {
    case 'system':
      return { kind: 'system', t, text: event.text }
    case 'stderr':
      return { kind: 'stderr', t, text: event.text }
    case 'raw':
      return { kind: 'system', t, text: event.text }
    case 'init':
      return { kind: 'system', t, text: `session ready · model: ${event.model}${event.sessionId ? ` · session: ${event.sessionId}` : ''}` }
    case 'assistant-text':
      return { kind: 'assistant', t, text: event.text }
    case 'tool-use':
      return { kind: 'tool', t, name: event.name, detail: describeToolInput(event.name, event.input), count: 1 }
    case 'command':
      return event.phase === 'start'
        ? { kind: 'command', t, command: displayCommand(event.command), status: 'running' }
        : {
            kind: 'command',
            t,
            command: displayCommand(event.command),
            status: event.ok ? 'ok' : 'error',
            ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode })
          }
    case 'file-change':
      return { kind: 'file', t, paths: event.paths }
    case 'result':
      // A run that reports no summary leaves the text empty, and each reader words the outcome itself.
      return { kind: 'result', t, ok: event.ok, text: event.summary }
  }
}

/** Builds a short string that identifies a tool call at a glance. A tool not listed here falls back to the head of its arguments. */
export function describeToolInput(name: string, input: string): string {
  let args: Record<string, unknown>
  try {
    args = JSON.parse(input) as Record<string, unknown>
  } catch {
    return clip(input)
  }
  const str = (key: string): string | null => (typeof args[key] === 'string' ? (args[key] as string) : null)
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return str('file_path') ?? ''
    case 'NotebookEdit':
      return str('notebook_path') ?? ''
    case 'Grep':
    case 'Glob': {
      const pattern = str('pattern') ?? ''
      const scope = str('path')
      return scope ? `${pattern}  ${scope}` : pattern
    }
    case 'WebFetch':
      return str('url') ?? ''
    case 'WebSearch':
      return str('query') ?? ''
    case 'Agent':
    case 'Task':
      return str('description') ?? clip(input)
    default:
      return clip(input)
  }
}

/** codex runs a command wrapped in `/bin/zsh -lc '...'`, and a row a person reads shows only the inner command. */
export function displayCommand(command: string): string {
  const m = /^\/bin\/(?:zsh|bash|sh) -lc (.*)$/s.exec(command)
  if (!m) return command
  const inner = m[1]
  if (inner.length >= 2 && (inner[0] === "'" || inner[0] === '"') && inner[inner.length - 1] === inner[0]) {
    return inner.slice(1, -1)
  }
  return inner
}

/** The step running now, which is the last row when it is a running command or a tool call. It is null once the job has finished. */
export function currentStep(rows: readonly JobLogRow[]): JobLogRow | null {
  const last = rows[rows.length - 1]
  if (!last) return null
  if (last.kind === 'command' && last.status === 'running') return last
  if (last.kind === 'tool') return last
  return null
}

/**
 * One row as plain text, for copying and for the log tail the LLM reads in get_agent_job. A run that
 * reported no summary has its outcome worded from the dictionary, so the copy button writes it in the
 * language of the screen and the tool result in the language of the conversation.
 */
export function rowText(row: JobLogRow, t: Translate): string {
  switch (row.kind) {
    case 'result':
      return row.text || t(row.ok ? 'jobs.log.done' : 'jobs.log.failed')
    case 'tool':
      return `${row.name}${row.count > 1 ? ` ×${row.count}` : ''} ${row.detail}`.trimEnd()
    case 'command':
      return `$ ${row.command}${row.status === 'error' ? ` (exit ${row.exitCode ?? '?'})` : ''}`
    case 'file':
      return row.paths.map((p) => `✎ ${p}`).join('\n')
    default:
      return row.text
  }
}

const clip = (s: string): string => (s.length > 80 ? `${s.slice(0, 80)}…` : s)
