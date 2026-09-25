import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  quickText: vi.fn(async () => 'SUMMARY'),
  conversationLocale: 'ja-JP' as 'ja-JP' | 'ko-KR'
}))

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
vi.mock('../src/main/services/llm', () => ({ quickText: mocks.quickText }))
vi.mock('../src/main/services/settings', () => ({
  getSettings: () => ({ conversationLocale: mocks.conversationLocale, conversationModel: { provider: 'anthropic', id: 'claude-sonnet-5' } })
}))

/** The handover summary is read back into the next conversation, so it is written in the language that conversation is held in. */
describe('the handover summary', () => {
  it('asks in English for every language but Japanese, and names the language the summary is written in', async () => {
    const { handoffSystem } = await import('../src/main/services/brain/summarizer')
    const prompt = handoffSystem('ko-KR')
    expect(prompt).toContain('bullet points in Korean')
    // A Japanese line here would ask for a summary in Japanese of a Korean conversation.
    expect(prompt).not.toMatch(/[぀-ヿ一-鿿]/)
  })

  it('merges an existing summary with the newer log, in the language of the conversation', async () => {
    mocks.conversationLocale = 'ko-KR'
    const { summarizeHandoff } = await import('../src/main/services/brain/summarizer')
    await summarizeHandoff('OLD', 'LOG')
    const [system, user] = mocks.quickText.mock.calls[0] as unknown as [string, string]
    expect(system).toContain('bullet points in Korean')
    expect(user).toContain('OLD')
    expect(user).toContain('LOG')
    expect(user).not.toMatch(/[぀-ヿ一-鿿]/)
  })
})
