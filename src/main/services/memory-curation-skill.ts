import fs from 'node:fs'
import path from 'node:path'
import type { ConversationLocale } from '@shared/conversation-locale'
import { CURATION_SKILL, FORMAT_FILES, MEMORY_TEMPLATES, SKILL_DIRS, curationSkillSource, worktreeAgentsMd } from '@shared/memory-curation'
import { errMessage } from '@shared/api-errors'
import { errorText } from '@shared/i18n/error-text'
import { conversationLocale } from './conversation-locale'
import { resourcePath } from './resource-path'
import { installPython, uvPath, uvRunEnv } from './uv'

/**
 * Makes ready the Python the skill's scripts run on, before a curation's Agent starts: the Agent may run in
 * a sandbox without the network, where uv could not download it. A failure, as on a first curation without
 * the network, keeps the Agent from starting and is the curation's failure, with the reason.
 */
export async function prepareCurationScripts(signal: AbortSignal): Promise<void> {
  try {
    await installPython(signal)
  } catch (error) {
    if (signal.aborted) throw error
    throw new Error(errorText('memory.errors.checkPythonFailed', { message: errMessage(error) }))
  }
}

/** The environment a curation's Agent runs with, in which `uv run` of the skill's scripts needs nothing of the user's. */
export const curationScriptEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => uvRunEnv(env)

/**
 * Installs the skill into every directory an agent looks in, one for claude and one for codex: the skill written
 * in the prompt language of the conversation, with the templates of the conversation's own language as its
 * assets/templates, the rules its scripts import beside it and a copy of the bundled uv in it, which the Agent
 * runs its checks with (curationScriptCommand). It writes AGENTS.md as well. Both locations are listed in
 * .gitignore, so the worktree stays clean. The language is read on every call, so a change applies at once.
 */
export function installSkill(worktreeDir: string, locale: ConversationLocale = conversationLocale()): void {
  const skills = resourcePath('skills')
  const source = path.join(skills, curationSkillSource(locale))
  const templates = path.join(skills, MEMORY_TEMPLATES, locale)
  for (const required of [path.join(source, 'SKILL.md'), templates]) {
    if (!fs.existsSync(required)) throw new Error(errorText('memory.errors.skillMissing', { path: required }))
  }
  for (const dir of SKILL_DIRS) {
    const target = path.join(worktreeDir, dir, CURATION_SKILL)
    fs.rmSync(target, { recursive: true, force: true })
    copyFolder(source, target)
    copyFolder(templates, path.join(target, 'assets', 'templates'))
    // A copy rather than a link: a link on Windows is a junction, which leaves git's removal of the worktree to
    // decide whether it deletes through it into the app. On APFS the copy is a clone that takes no space (uv
    // 0.12.18 is 37 MB on macOS); elsewhere the whole of uv is written once per curation.
    fs.copyFileSync(uvPath(), path.join(target, path.basename(uvPath())), fs.constants.COPYFILE_FICLONE)
    for (const file of FORMAT_FILES) fs.copyFileSync(path.join(skills, file), path.join(worktreeDir, dir, file))
  }
  fs.writeFileSync(path.join(worktreeDir, 'AGENTS.md'), worktreeAgentsMd(locale), { mode: 0o600 })
}

/**
 * Copies the folder source to target file by file. fs.cpSync of a folder ended Node 22.23.2 on Windows with an
 * access violation whenever either path held a character outside ASCII, as a worktree named after a Japanese
 * job title does; Electron's Node 24.18 copied the same folder, but the tests run on Node 22 (2026-09-27).
 */
function copyFolder(source: string, target: string): void {
  fs.mkdirSync(target, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name)
    const to = path.join(target, entry.name)
    if (entry.isDirectory()) copyFolder(from, to)
    else fs.copyFileSync(from, to)
  }
}
