import type { AgentEngine } from './ipc'
import { errorText } from './i18n/error-text'
import { CURATION_SKILL, SKILL_DIRS } from './memory-curation'

/**
 * Argument building for the agent CLIs. The per-engine differences in starting, resuming and
 * enforcing read-only live here.
 * - codex: `exec --json`. Read-only is enforced by the OS through the `-s read-only` sandbox.
 *   Resuming is `exec resume <thread_id> <prompt>`, where the sandbox is set with `-c sandbox_mode`.
 * - claude: `-p --output-format stream-json`. Read-only is enforced by the CLI through plan mode and
 *   a tool list that holds only reading tools. Resuming is `--resume <session_id>`.
 *
 * A job that writes runs in the mode each CLI has for working unattended, in which a reviewing model
 * decides on what would otherwise ask a person: claude's `auto` permission mode, and codex's
 * `--approve-for-me`, which keeps the workspace-write sandbox and sends the requests to leave it
 * (network, a path outside the workspace) to an automatic review. Plain `-s workspace-write` under
 * `exec` never asks, so such a request simply fails.
 */

/**
 * What each CLI calls the two modes a job runs in. The names are the CLIs' own and are shown as they are in
 * every language, so that the setting reads like the CLI's documentation. A read-only claude job runs in its
 * plan mode with reading tools only, and a read-only codex job in its read-only sandbox.
 */
export const AGENT_MODE_NAME: Record<AgentEngine, Record<'readonly' | 'auto', string>> = {
  claude: { readonly: 'Plan', auto: 'Auto' },
  codex: { readonly: 'Read Only', auto: 'Approve for me' }
}

export interface AgentCliJob {
  engine: AgentEngine
  prompt: string
  cwd: string
  readonly: boolean
  sessionId?: string
  /** Present on a memory curation job, which runs confined (see claudeCurationArgs). */
  memoryCuration?: object
}

/** The tools claude may use in read-only mode: no writing tools and no Bash. */
export const CLAUDE_READONLY_TOOLS = 'Read,Glob,Grep,WebSearch,WebFetch'

const clip = (s: string): string => `${s.slice(0, 80)}${s.length > 80 ? '…' : ''}`

/**
 * A memory curation job starts on a timer with nobody to confirm it, and its prompt holds the day's
 * transcript, which can carry text from a mail or a web page written to steer the agent. So it does not
 * get the unattended mode of a writing job. claude runs in restricted mode, which ignores the user's
 * settings and keeps the file tools inside the worktree; anything not allowed here is refused
 * (dontAsk); the only command is the skill's validator, and the skill's own files are closed to editing
 * so that the validator cannot be rewritten into another program. Measured with claude 2.1.276 on
 * 2026-09-23: a deny rule for the file tools must be written as Edit(...), since Write(...) is ignored,
 * and a compound command such as `validate.mjs . && curl …` is refused as a whole.
 */
function claudeCurationArgs(cwd: string): string[] {
  const validator = (root: string): string => `Bash(node ${root}${SKILL_DIRS[0]}/${CURATION_SKILL}/scripts/validate.mjs *)`
  return [
    '--restricted',
    '--strict-mcp-config',
    '--permission-mode',
    'dontAsk',
    '--tools',
    'Read,Write,Edit,Glob,Grep,Bash',
    '--allowedTools',
    'Read',
    'Write',
    'Edit',
    'Glob',
    'Grep',
    validator(''),
    validator(`${cwd}/`),
    '--disallowedTools',
    ...SKILL_DIRS.map((dir) => `Edit(./${dir}/**)`)
  ]
}

function claudePermissionArgs(job: AgentCliJob): string[] {
  if (job.memoryCuration) return claudeCurationArgs(job.cwd)
  return job.readonly
    ? ['--permission-mode', 'plan', '--tools', CLAUDE_READONLY_TOOLS]
    : ['--permission-mode', 'auto']
}

/**
 * codex confines a memory curation job with its workspace-write sandbox, which the OS enforces: writes
 * stay in the worktree and the network is closed. With approvals turned off, a request to leave the
 * sandbox fails instead of going to the automatic review that --approve-for-me would give it.
 */
const CODEX_CURATION_ACCESS = ['-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"']

/**
 * `exec resume` has no --approve-for-me (codex-cli 0.155), so a resumed job names the settings behind the
 * flag: requests for approval are raised, and the automatic review answers them.
 */
function codexResumeAccess(job: AgentCliJob): string[] {
  if (job.memoryCuration) return CODEX_CURATION_ACCESS
  if (job.readonly) return ['-c', 'sandbox_mode="read-only"']
  return ['-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="auto_review"']
}

export function buildStartArgs(job: AgentCliJob): string[] {
  if (job.engine === 'codex') {
    // --ignore-user-config keeps the run independent of the model preferences in
    // ~/.codex/config.toml. Authentication still comes through CODEX_HOME.
    return [
      'exec',
      '--json',
      '--ignore-user-config',
      '--skip-git-repo-check',
      '-C',
      job.cwd,
      // --approve-for-me implies the workspace-write sandbox and cannot be combined with -s (codex-cli 0.155).
      ...(job.memoryCuration ? CODEX_CURATION_ACCESS : job.readonly ? ['-s', 'read-only'] : ['--approve-for-me']),
      job.prompt
    ]
  }
  return ['-p', job.prompt, '--output-format', 'stream-json', '--verbose', ...claudePermissionArgs(job)]
}

/** Resumes the stored session in the same directory. It throws when no session id was kept. */
export function buildResumeArgs(job: AgentCliJob, prompt: string): string[] {
  if (!job.sessionId) throw new Error(errorText('jobs.continue.noSession'))
  if (job.engine === 'codex') {
    return [
      'exec',
      'resume',
      '--json',
      '--ignore-user-config',
      '--skip-git-repo-check',
      ...codexResumeAccess(job),
      job.sessionId,
      prompt
    ]
  }
  return [
    '-p',
    prompt,
    '--resume',
    job.sessionId,
    '--output-format',
    'stream-json',
    '--verbose',
    ...claudePermissionArgs(job)
  ]
}

export function displayCommand(job: AgentCliJob, resumePrompt?: string): string {
  const prompt = clip(resumePrompt ?? job.prompt)
  if (job.engine === 'codex') {
    return resumePrompt
      ? `$ codex exec resume ${job.sessionId ?? '?'} "${prompt}"`
      : `$ codex exec ${job.readonly ? '-s read-only' : '--approve-for-me'} "${prompt}"`
  }
  return resumePrompt ? `$ claude -p --resume ${job.sessionId ?? '?'} "${prompt}"` : `$ claude -p "${prompt}"`
}
