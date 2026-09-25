import { describe, expect, it } from 'vitest'
import { SegmentAssembler } from '@shared/segmenter'

describe('SegmentAssembler in Japanese', () => {
  it('ends a segment at sentence-ending punctuation', () => {
    const a = new SegmentAssembler('ja-JP')
    expect(a.push('こんにちは。')).toEqual(['こんにちは。'])
    expect(a.push('元気ですか?')).toEqual(['元気ですか?'])
    expect(a.push('全角も！対応？する\n')).toEqual(['全角も！', '対応？', 'する'])
  })

  it('assembles a sentence across deltas that cut it in the middle', () => {
    const a = new SegmentAssembler('ja-JP')
    expect(a.push('今日はいい')).toEqual([])
    expect(a.push('天気です')).toEqual([])
    expect(a.push('ね。明日は')).toEqual(['今日はいいですね。'.replace('です', '天気です')])
    expect(a.flush()).toEqual(['明日は'])
  })

  it('splits at a comma once the segment exceeds 50 characters, so playback of a long reply starts sooner', () => {
    const a = new SegmentAssembler('ja-JP')
    const long = 'あ'.repeat(55)
    const out = a.push(`${long}、続きです。`)
    expect(out[0]).toBe(`${long}、`)
    expect(out[1]).toBe('続きです。')
  })

  it('does not split at a comma while the segment is 50 characters or shorter', () => {
    const a = new SegmentAssembler('ja-JP')
    expect(a.push('短い文、続き。')).toEqual(['短い文、続き。'])
  })

  it('flushes the remainder and drops a segment that is empty or only a comma', () => {
    const a = new SegmentAssembler('ja-JP')
    a.push('、')
    expect(a.flush()).toEqual([])
    a.push('残り')
    expect(a.flush()).toEqual(['残り'])
    expect(a.flush()).toEqual([])
  })

  it('collapses runs of markdown marks into a space so they are not read aloud', () => {
    const a = new SegmentAssembler('ja-JP')
    expect(a.push('見出し**強調**です。')).toEqual(['見出し 強調 です。'])
  })
})

describe('SegmentAssembler in the languages that end a sentence in a full stop', () => {
  it('emits a sentence only once the text after it proves the full stop ended it', () => {
    const a = new SegmentAssembler('en-US')
    expect(a.push('Hello there.')).toEqual([])
    expect(a.push(' How are')).toEqual(['Hello there.'])
    expect(a.push(' you?')).toEqual([])
    expect(a.flush()).toEqual(['How are you?'])
  })

  it('keeps a decimal number inside its sentence', () => {
    const a = new SegmentAssembler('de-DE')
    expect(a.push('Es sind 3.5 Grad und es wird kälter. Morgen schneit es. ')).toEqual([
      'Es sind 3.5 Grad und es wird kälter.'
    ])
    expect(a.flush()).toEqual(['Morgen schneit es.'])
  })

  it('reads the two halves of an abbreviation one after the other, because V8 suppresses none', () => {
    const a = new SegmentAssembler('de-DE')
    expect(a.push('Das ist z. B. wichtig. Und dann? ')).toEqual(['Das ist z.', 'B. wichtig.'])
    expect(a.flush()).toEqual(['Und dann?'])
  })

  it('ends a Hindi sentence at the danda', () => {
    const a = new SegmentAssembler('hi-IN')
    expect(a.push('नमस्ते। आप कैसे हैं? ')).toEqual(['नमस्ते।'])
    expect(a.flush()).toEqual(['आप कैसे हैं?'])
  })

  it('ends a Korean sentence at the full stop', () => {
    const a = new SegmentAssembler('ko-KR')
    expect(a.push('안녕하세요. 잘 지내세요? ')).toEqual(['안녕하세요.'])
    expect(a.flush()).toEqual(['잘 지내세요?'])
  })

  it('cuts a long sentence at the comma that follows twenty words, so playback starts sooner', () => {
    const a = new SegmentAssembler('en-US')
    const long = Array(25).fill('word').join(' ')
    expect(a.push(`${long}, and the rest follows`)).toEqual([`${long},`])
    expect(a.flush()).toEqual(['and the rest follows'])
  })

  it('does not cut a sentence that stays under the limit at its comma', () => {
    const a = new SegmentAssembler('en-US')
    expect(a.push('It is short, and it stays whole')).toEqual([])
    expect(a.flush()).toEqual(['It is short, and it stays whole'])
  })

  it('collapses runs of markdown marks and drops a piece with nothing to read', () => {
    const a = new SegmentAssembler('fr-FR')
    a.push('Un **titre** ici. ')
    expect(a.flush()).toEqual(['Un  titre  ici.'])
    a.push('-- ')
    expect(a.flush()).toEqual([])
  })
})
