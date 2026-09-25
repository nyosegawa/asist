/**
 * The two agent CLIs report at different granularities. In claude every file read, file write and
 * shell command arrives as a `tool_use`, and its success is in the later `tool_result` carrying the
 * same id. In codex commands and file changes are separate items, and `item.started` pairs with
 * `item.completed` on the same id. Both are flattened here into command, file-change and tool-use, so
 * the display side never has to know which engine ran.
 */

export type AgentStreamEvent =
  /** The session started. `sessionId` is what `continue_agent_job` resumes from. */
  | { kind: 'init'; model: string; sessionId?: string }
  | { kind: 'assistant-text'; text: string }
  /** A non-shell tool call, such as claude's Read, Grep or Write and codex's MCP and web search. It is emitted when the call starts. */
  | { kind: 'tool-use'; name: string; input: string }
  /** A shell command. It arrives once when the command starts and once more, with the same id, when it ends. */
  | { kind: 'command'; id: string; command: string; phase: 'start' }
  | { kind: 'command'; id: string; command: string; phase: 'done'; ok: boolean; exitCode?: number }
  /** A file was created or edited. It is emitted once the change is complete. */
  | { kind: 'file-change'; paths: string[] }
  | { kind: 'result'; ok: boolean; summary: string; numTurns?: number; costUsd?: number }
  /** A line that could not be parsed as JSON, or an informational message from the engine. */
  | { kind: 'raw'; text: string }

export type AgentStreamParser = (raw: string) => AgentStreamEvent[]

const CLAUDE_FILE_WRITING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/**
 * The parser keeps each `tool_use` by id and resolves the command's success and the file change when
 * the matching `tool_result` arrives, so one parser belongs to one job, that is one process.
 */
export function createClaudeStreamParser(): AgentStreamParser {
  const pending = new Map<string, { name: string; input: Record<string, unknown> }>()

  return (raw) => {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return [{ kind: 'raw', text: raw }]
    }
    const type = msg.type as string

    if (type === 'system' && msg.subtype === 'init') {
      return [
        {
          kind: 'init',
          model: String(msg.model ?? '?'),
          ...(typeof msg.session_id === 'string' ? { sessionId: msg.session_id } : {})
        }
      ]
    }

    if (type === 'assistant' || type === 'user') {
      const message = msg.message as { content?: Array<Record<string, unknown>> } | undefined
      const events: AgentStreamEvent[] = []
      for (const block of message?.content ?? []) {
        if (type === 'assistant' && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          events.push({ kind: 'assistant-text', text: block.text.trim() })
        } else if (block.type === 'tool_use') {
          events.push(...claudeToolUse(pending, block))
        } else if (block.type === 'tool_result') {
          events.push(...claudeToolResult(pending, block))
        }
      }
      return events
    }

    if (type === 'result') {
      return [
        {
          kind: 'result',
          ok: !msg.is_error,
          summary: typeof msg.result === 'string' ? msg.result : '',
          numTurns: typeof msg.num_turns === 'number' ? msg.num_turns : undefined,
          costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined
        }
      ]
    }

    return []
  }
}

function claudeToolUse(
  pending: Map<string, { name: string; input: Record<string, unknown> }>,
  block: Record<string, unknown>
): AgentStreamEvent[] {
  const name = String(block.name ?? '?')
  const input = (block.input ?? {}) as Record<string, unknown>
  const id = typeof block.id === 'string' ? block.id : ''
  if (id) pending.set(id, { name, input })
  if (name === 'Bash') {
    return [{ kind: 'command', id, command: String(input.command ?? ''), phase: 'start' }]
  }
  return [{ kind: 'tool-use', name, input: JSON.stringify(input) }]
}

function claudeToolResult(
  pending: Map<string, { name: string; input: Record<string, unknown> }>,
  block: Record<string, unknown>
): AgentStreamEvent[] {
  const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
  const use = pending.get(id)
  if (!use) return []
  pending.delete(id)
  const ok = block.is_error !== true
  if (use.name === 'Bash') {
    return [
      {
        kind: 'command',
        id,
        command: String(use.input.command ?? ''),
        phase: 'done',
        ok,
        ...(ok ? {} : claudeExitCode(block.content))
      }
    ]
  }
  if (ok && CLAUDE_FILE_WRITING_TOOLS.has(use.name)) {
    const path = use.input.file_path ?? use.input.notebook_path
    if (typeof path === 'string') return [{ kind: 'file-change', paths: [path] }]
  }
  return []
}

/** A failed Bash call has a `tool_result` body starting with "Exit code 1\n…", so the code is carried only when that number can be read. */
function claudeExitCode(content: unknown): { exitCode?: number } {
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((c) => (typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : '')).join('\n')
        : ''
  const m = /^Exit code (\d+)/.exec(text)
  return m ? { exitCode: Number(m[1]) } : {}
}

export function createCodexStreamParser(): AgentStreamParser {
  return parseCodexStreamLine
}

function parseCodexStreamLine(raw: string): AgentStreamEvent[] {
  let msg: Record<string, unknown>
  try {
    msg = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return [{ kind: 'raw', text: raw }]
  }
  const type = msg.type as string

  if (type === 'thread.started') {
    return [{ kind: 'init', model: 'codex', ...(typeof msg.thread_id === 'string' ? { sessionId: msg.thread_id } : {}) }]
  }

  if (type === 'item.completed' || type === 'item.started') {
    const item = msg.item as Record<string, unknown> | undefined
    if (!item) return []
    const itemType = item.type as string
    const completed = type === 'item.completed'
    const id = typeof item.id === 'string' ? item.id : ''

    if (itemType === 'command_execution') {
      const command = String(item.command ?? '')
      if (!completed) return [{ kind: 'command', id, command, phase: 'start' }]
      const exitCode = typeof item.exit_code === 'number' ? item.exit_code : undefined
      return [
        {
          kind: 'command',
          id,
          command,
          phase: 'done',
          ok: exitCode === 0 && item.status !== 'failed',
          ...(exitCode === undefined ? {} : { exitCode })
        }
      ]
    }
    if (!completed) return []

    if (itemType === 'agent_message') {
      const text = String(item.text ?? '').trim()
      return text ? [{ kind: 'assistant-text', text }] : []
    }
    if (itemType === 'file_change') {
      const changes = Array.isArray(item.changes) ? item.changes : []
      const paths = changes
        .map((c) => (c as { path?: unknown }).path)
        .filter((p): p is string => typeof p === 'string')
      return paths.length > 0 ? [{ kind: 'file-change', paths }] : []
    }
    if (itemType === 'mcp_tool_call') {
      const name = [item.server, item.tool].filter((s) => typeof s === 'string' && s).join('.')
      return [{ kind: 'tool-use', name: name || 'mcp', input: JSON.stringify(item.arguments ?? {}) }]
    }
    if (itemType === 'web_search') {
      return [{ kind: 'tool-use', name: 'WebSearch', input: JSON.stringify({ query: item.query ?? '' }) }]
    }
    if (itemType === 'error') {
      // This is an informational message from codex, such as a skill budget notice, and it must not
      // fail the job.
      return [{ kind: 'raw', text: String(item.message ?? '') }]
    }
    return []
  }

  if (type === 'turn.completed') {
    // codex's turn.completed carries no success flag, so the real outcome comes from the exit code,
    // and the summary comes from the last agent_message.
    return [{ kind: 'result', ok: true, summary: '' }]
  }

  if (type === 'turn.failed') {
    const err = msg.error as { message?: unknown } | undefined
    return [{ kind: 'result', ok: false, summary: codexErrorText(err?.message) }]
  }

  if (type === 'error') {
    // A turn-level error is followed by turn.failed, so it only goes to the log here.
    return [{ kind: 'raw', text: codexErrorText(msg.message) }]
  }

  return []
}

/** A codex error message is sometimes a JSON string inside a JSON string, so the readable body is unwrapped. */
function codexErrorText(message: unknown): string {
  const text = typeof message === 'string' ? message : ''
  try {
    const inner = JSON.parse(text) as { error?: { message?: string }; message?: string }
    return inner.error?.message ?? inner.message ?? text
  } catch {
    return text
  }
}

/** Extracts the absolute paths of the files an event created or edited. Relative paths are dropped. */
export function artifactPaths(event: AgentStreamEvent): string[] {
  if (event.kind !== 'file-change') return []
  return event.paths.filter((p) => p.startsWith('/'))
}
