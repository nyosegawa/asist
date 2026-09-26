import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logFileName, type ConversationRecord } from '../src/main/services/brain/conversation-log'

/** The turn ids of a launch against the conversation log that earlier launches left behind. */

const mocks = vi.hoisted(() => ({ dir: '' }))

vi.mock('../src/main/services/store', () => ({ dataPath: (name: string) => `${mocks.dir}/${name}` }))
vi.mock('../src/main/services/settings', () => ({
  getSettings: () => ({ conversationLocale: 'ja-JP', uiLocale: 'ja-JP', conversationLogRetentionDays: 90, ttsEngine: 'none' })
}))
vi.mock('../src/main/services/tts', () => ({}))

beforeEach(() => {
  vi.resetModules()
  mocks.dir = fs.mkdtempSync(path.join(tmpdir(), 'asist-turn-ids-'))
})
afterEach(() => fs.rmSync(mocks.dir, { recursive: true, force: true }))

function writeLog(day: Date, records: ConversationRecord[]): void {
  const dir = path.join(mocks.dir, 'conversations')
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(path.join(dir, logFileName(day)), records.map((record) => `${JSON.stringify(record)}\n`).join(''))
}

describe('turn ids across launches', () => {
  it('continues after the highest id the earlier launches left in the log the history replays, one held in a checkpoint included', async () => {
    const now = new Date()
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12)
    const t = now.getTime()
    writeLog(yesterday, [{ t: yesterday.getTime(), kind: 'user', turnId: 40, text: '昨日の話' }])
    writeLog(now, [
      { t, kind: 'checkpoint', summary: '要約', records: [{ t, kind: 'user', turnId: 57, text: '残した話' }] },
      // The only turn of the launch before this one, cut off by quitting before its reply.
      { t, kind: 'user', turnId: 1, text: '途中で終わった話' }
    ])
    const { turnScheduler } = await import('../src/main/services/brain/session')
    expect(turnScheduler.allocateTurnId()).toBe(58)
    const handle = turnScheduler.start(async () => {})
    expect(handle.turnId).toBe(59)
    await handle.completion
  })
})
