import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { vi } from 'vitest'
import { testGitEnv } from './git'
import { longTempFolder } from './temp'

/**
 * What an agent worktree test file hoists for its mocks: the folder ASIST's data and the repository go in, the
 * launch of the agent CLI, the confirmation, git's switch for another owner's repository, and the commands a test
 * collects. Each file declares it with vi.hoisted and its own vi.mock calls, which Vitest takes only from the file.
 */
export interface AgentWorktreeMocks {
  root: string
  launch: ReturnType<typeof vi.fn>
  requestConfirm: ReturnType<typeof vi.fn>
  differentOwner: boolean
  commands: string[] | null
}

/**
 * The user's git, which makes the repositories that ASIST's own git then reads, as in use. /usr/bin/git on a Mac is a
 * shim that looks the real git up through xcrun on every call: a call took 23 ms against 8 ms for the git it finds at
 * a load average of 30 (Apple M5, 2026-10-02), so the path is looked up once.
 */
const userGit = process.platform === 'darwin' ? execFileSync('xcrun', ['--find', 'git'], { encoding: 'utf8' }).trim() : 'git'

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync(userGit, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: testGitEnv() }).trim()

/**
 * The repository each test starts from, made once per file and copied into the test's own folder: making it took
 * six git processes, 200 ms of every test at a load average of 24, and a copy starts none (Apple M5, 2026-10-02).
 */
export function makeTemplate(): string {
  const template = longTempFolder('asist-worktree-template-')
  git(template, 'init', '-q', '-b', 'main')
  git(template, 'config', 'user.name', 'ASIST test')
  git(template, 'config', 'user.email', 'test@localhost')
  git(template, 'config', 'commit.gpgsign', 'false')
  fs.writeFileSync(path.join(template, 'tracked.txt'), 'base\n')
  git(template, 'add', '.')
  git(template, 'commit', '-qm', 'initial')
  return template
}

/**
 * Resets the mocks for a test, with a launch whose completion settles when the agent exits, and copies the template
 * into a new root. Returns the repository.
 */
export function startTest(mocks: AgentWorktreeMocks, template: string): string {
  vi.restoreAllMocks()
  vi.resetModules()
  mocks.launch.mockReset()
  mocks.requestConfirm.mockReset()
  mocks.launch.mockImplementation((_job, _args, handlers) => {
    let resolve!: () => void
    const completion = new Promise<void>((done) => { resolve = done })
    const onExit = handlers.onExit
    handlers.onExit = (code: number | null) => { onExit(code); resolve() }
    return { completion, stop: vi.fn() }
  })
  mocks.root = longTempFolder('asist-worktree-test-')
  const repo = path.join(mocks.root, 'repo')
  fs.cpSync(template, repo, { recursive: true })
  return repo
}

/** Runs merge_agent_job, with a failure in the Japanese the model reads rather than packed in both languages. */
export async function mergeThroughTool(id: string, commit: string): Promise<unknown> {
  const { jobTools } = await import('../../src/main/services/brain/job-tools')
  const { ToolError, resolvePromptTexts } = await import('@shared/tool-registry')
  const tool = jobTools('ja-JP').find((definition) => definition.name === 'merge_agent_job')!
  try {
    return await tool.run({ jobId: id, commit }, {} as never, new AbortController().signal)
  } catch (err) {
    throw err instanceof ToolError ? new Error(resolvePromptTexts(err.message, 'ja')) : err
  }
}
