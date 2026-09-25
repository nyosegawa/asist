import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { ConversationLocale } from '@shared/conversation-locale'
import { CURATION_SKILL, SKILL_DIRS, curationSkillSource, worktreeAgentsMd } from '@shared/memory-curation'
import { conversationLocale } from './conversation-locale'

/** The skill written in the prompt language of the conversation, read on every call so a change applies at once. */
export function skillSourceDir(locale: ConversationLocale = conversationLocale()): string {
  const name = curationSkillSource(locale)
  return app.isPackaged
    ? path.join(process.resourcesPath, 'skills', name)
    : path.join(app.getAppPath(), 'resources', 'skills', name)
}

/**
 * Installs the skill into every directory an agent looks in, one for claude and one for codex, and writes
 * AGENTS.md. Both locations are listed in .gitignore, so the worktree stays clean.
 */
export function installSkill(worktreeDir: string, source = skillSourceDir()): void {
  if (!fs.existsSync(path.join(source, 'SKILL.md'))) throw new Error(`the memory curation skill is missing: ${source}`)
  for (const dir of SKILL_DIRS) {
    const target = path.join(worktreeDir, dir, CURATION_SKILL)
    fs.rmSync(target, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.cpSync(source, target, { recursive: true })
  }
  fs.writeFileSync(path.join(worktreeDir, 'AGENTS.md'), worktreeAgentsMd(conversationLocale()), { mode: 0o600 })
}
