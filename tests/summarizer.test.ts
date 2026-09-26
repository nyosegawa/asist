import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  quickText: vi.fn(async () => 'SUMMARY'),
  conversationLocale: 'ja-JP' as 'ja-JP' | 'ko-KR' | 'en-US'
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

  /**
   * A summary that runs far past the length its prompt asks for means the rewrite failed. That length
   * is counted in the unit of the prompt's language, so an English summary as long as its prompt
   * allows compacts the history as a Japanese one does.
   */
  it.each([
    ['en-US', 'en', '- The user moved the dentist to Friday afternoon. '],
    ['ja-JP', 'ja', '歯医者を金曜の午後に移した。']
  ] as const)('compacts the history with a %s summary as long as its prompt allows and refuses one far beyond it', async (locale, language, sentence) => {
    mocks.conversationLocale = locale
    const { SUMMARY_BUDGET, handoffSystem, summarizeHandoff } = await import('../src/main/services/brain/summarizer')
    const { ConversationHistory } = await import('../src/main/services/brain/history')
    const budget = SUMMARY_BUDGET[language]
    expect(handoffSystem(locale)).toContain(String(budget))
    const unitsPerSentence = language === 'ja' ? sentence.length : sentence.trim().split(/\s+/).length
    const ofLength = (units: number): string => sentence.repeat(Math.floor(units / unitsPerSentence)).trim()
    const compactWith = async (summary: string): Promise<string> => {
      mocks.quickText.mockResolvedValueOnce(summary)
      const history = new ConversationHistory({
        recentTurns: 0,
        compressAtTokens: 0,
        limitTokens: 0,
        hardLimitTokens: 1_000_000,
        load: () => [],
        saveCheckpoint: () => {},
        summarize: summarizeHandoff,
        locale: () => locale,
        onError: () => {}
      })
      history.ensureLoaded()
      history.apply({ t: 1, kind: 'user', turnId: 1, text: 'move the dentist to Friday' })
      history.apply({ t: 2, kind: 'assistant', turnId: 1, text: 'Done.' })
      await history.compact('quiet')
      return history.summary
    }
    expect(await compactWith(ofLength(budget))).toBe(ofLength(budget))
    expect(await compactWith(ofLength(10 * budget))).toBe('')
  })
})
