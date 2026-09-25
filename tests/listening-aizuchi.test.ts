import { describe, expect, it } from 'vitest'
import {
  ListeningRecorder,
  shouldBackchannel,
  type BackchannelInput
} from '@shared/listening-aizuchi'

/** The baseline input that fires. Each test breaks exactly one of its conditions. */
const base: BackchannelInput = {
  userSpeaking: true,
  assistantSpeaking: false,
  silenceMs: 350,
  utteranceMs: 5000,
  partialText: '昨日デプロイしようとしたんですけど',
  msSinceLast: 10_000
}

describe('shouldBackchannel, which decides when a listening aizuchi fires', () => {
  it('fires at a clause break of a long utterance, where a conjunctive form meets a mid-sentence pause', () => {
    expect(shouldBackchannel(base)).toEqual({ kind: 'continuer', source: 'text' })
  })

  it('fires on the various conjunctive forms that end a clause', () => {
    for (const text of [
      'エラーが出てて',
      '直したいので',
      'CIが落ちてるんですよ',
      'テストを書いてから',
      '設定を変えまして'
    ]) {
      expect(shouldBackchannel({ ...base, partialText: text })?.kind).toBe('continuer')
    }
  })

  it('fires without a clause break once the user has been speaking long enough', () => {
    const long = 'あ'.repeat(45)
    expect(shouldBackchannel({ ...base, partialText: long })?.kind).toBe('continuer')
  })

  it('does not fire on a short partial text that has no clause break', () => {
    expect(shouldBackchannel({ ...base, partialText: '明日の天気' })).toBeNull()
  })

  it('does not fire while the user is not speaking', () => {
    expect(shouldBackchannel({ ...base, userSpeaking: false })).toBeNull()
  })

  it('does not fire while the assistant is speaking', () => {
    expect(shouldBackchannel({ ...base, assistantSpeaking: true })).toBeNull()
  })

  it('does not fire outside the pause window, where a shorter pause is still speech and a longer one ends the utterance', () => {
    expect(shouldBackchannel({ ...base, silenceMs: 100 })).toBeNull()
    expect(shouldBackchannel({ ...base, silenceMs: 700 })).toBeNull()
  })

  it('does not fire on a short utterance', () => {
    expect(shouldBackchannel({ ...base, utteranceMs: 1500 })).toBeNull()
  })

  it('does not fire again within five seconds of the last aizuchi', () => {
    expect(shouldBackchannel({ ...base, msSinceLast: 3000 })).toBeNull()
  })

  it('does not fire while the partial transcript is empty', () => {
    expect(shouldBackchannel({ ...base, partialText: '' })).toBeNull()
  })
})

describe('shouldBackchannel, combining the MaAI signals with the text', () => {
  const quiet = { eotUser: 0.05, bcReact: 0.1, bcEmo: 0.05 }

  it('fires a continuer on a high bcReact even without a clause break in the text', () => {
    // A partial text that does not fire on the text alone.
    const noText = { ...base, partialText: '明日の天気' }
    expect(shouldBackchannel({ ...noText, vap: { ...quiet, bcReact: 0.6 } })).toEqual({
      kind: 'continuer',
      source: 'model'
    })
  })

  it('fires an assessment when bcEmo is high, which takes precedence over bcReact', () => {
    expect(shouldBackchannel({ ...base, vap: { eotUser: 0.05, bcReact: 0.9, bcEmo: 0.35 } })).toEqual({
      kind: 'assessment',
      source: 'model'
    })
  })

  it('fires on a moderate bcReact when the text is at a clause break', () => {
    expect(shouldBackchannel({ ...base, vap: { ...quiet, bcReact: 0.4 } })).toEqual({
      kind: 'continuer',
      source: 'both'
    })
    // Without a clause break the same probability does not fire.
    expect(shouldBackchannel({ ...base, partialText: '明日の天気', vap: { ...quiet, bcReact: 0.4 } })).toBeNull()
  })

  it('does not fire on low model signals even at a clause break', () => {
    expect(shouldBackchannel({ ...base, vap: quiet })).toBeNull()
  })

  it('holds the aizuchi back when eotUser says the utterance is ending', () => {
    expect(shouldBackchannel({ ...base, vap: { eotUser: 0.85, bcReact: 0.9, bcEmo: 0.5 } })).toBeNull()
  })

  it('keeps the frequency, utterance length and pause window gates even with model signals', () => {
    const vap = { eotUser: 0.1, bcReact: 0.8, bcEmo: 0.05 }
    expect(shouldBackchannel({ ...base, vap, msSinceLast: 3000 })).toBeNull()
    expect(shouldBackchannel({ ...base, vap, utteranceMs: 1500 })).toBeNull()
    expect(shouldBackchannel({ ...base, vap, silenceMs: 100 })).toBeNull()
  })

  it('falls back to the clause break in the text alone when there are no VAP signals', () => {
    expect(shouldBackchannel({ ...base, vap: null })).toEqual({ kind: 'continuer', source: 'text' })
  })
})

describe('ListeningRecorder, which records the hits', () => {
  it('marks an aizuchi as continued when the voice comes back after it, and as a miss when it does not', () => {
    const recorder = new ListeningRecorder()
    recorder.fired({ kind: 'continuer', source: 'both' }, 3000.4)
    recorder.voiced()
    recorder.fired({ kind: 'assessment', source: 'model' }, 9000)
    expect(recorder.take()).toEqual([
      { kind: 'continuer', source: 'both', atMs: 3000, continued: true },
      { kind: 'assessment', source: 'model', atMs: 9000, continued: false }
    ])
    expect(recorder.take()).toEqual([])
  })

  it('drops the records of the previous utterance on reset', () => {
    const recorder = new ListeningRecorder()
    recorder.fired({ kind: 'continuer', source: 'text' }, 3000)
    recorder.reset()
    expect(recorder.take()).toEqual([])
  })
})
