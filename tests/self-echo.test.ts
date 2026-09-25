import { describe, expect, it } from 'vitest'
import { isSelfEcho, normalizeForEcho, stripClipEcho } from '@shared/self-echo'

describe('normalizeForEcho', () => {
  it('removes punctuation, spaces and symbols and lowercases the rest', () => {
    expect(normalizeForEcho('明日は、晴れです。 (たぶん)')).toBe('明日は晴れですたぶん')
    expect(normalizeForEcho('OK Google')).toBe('okgoogle')
  })
})

describe('isSelfEcho', () => {
  const recent = ['明日の東京は晴れで、最高気温は28度です。', '傘は要らなそうですよ。']

  it('treats a complete loopback of a recent utterance as an echo', () => {
    expect(isSelfEcho('明日の東京は晴れで最高気温は28度です', recent)).toBe(true)
  })

  it('treats a loopback of only part of a sentence, recorded from partway through, as an echo', () => {
    expect(isSelfEcho('最高気温は28度です', recent)).toBe(true)
    expect(isSelfEcho('傘は要らなそうですよ', recent)).toBe(true)
  })

  it('treats a loopback that spans a sentence boundary as an echo', () => {
    expect(isSelfEcho('28度です。傘は要らな', recent)).toBe(true)
  })

  it('judges by bigram overlap, so a few characters of ASR drift still count as an echo', () => {
    // The transcript drifts, as when "最高気温は28度です" comes back as "再考気温は28度です".
    expect(isSelfEcho('明日の東京は晴れで最高気温は28度れす', recent)).toBe(true)
  })

  it('does not treat a new user utterance as an echo', () => {
    expect(isSelfEcho('じゃあ大阪の天気はどう?', recent)).toBe(false)
    expect(isSelfEcho('ありがとう、助かった', recent)).toBe(false)
  })

  it('lets a different sentence on the same topic through, since overlapping words alone are not enough', () => {
    expect(isSelfEcho('東京より大阪の気温が知りたいんだけど', recent)).toBe(false)
  })

  it('does not judge a short utterance such as an aizuchi, where a false positive is likely', () => {
    expect(isSelfEcho('はい', recent)).toBe(false)
    expect(isSelfEcho('うん。', recent)).toBe(false)
  })

  it('returns false when there is no recent utterance', () => {
    expect(isSelfEcho('明日の東京は晴れで最高気温は28度です', [])).toBe(false)
  })
})

describe('isSelfEcho in a language written with spaces', () => {
  const recent = ['Tomorrow in Tokyo it will be sunny, with a high of twenty-eight degrees.', 'You will not need an umbrella.']

  it('treats a loopback of a recent reply as an echo', () => {
    expect(isSelfEcho('tomorrow in tokyo it will be sunny with a high of twenty eight degrees', recent)).toBe(true)
    expect(isSelfEcho('you will not need an umbrella', recent)).toBe(true)
  })

  it('counts the overlap word by word, so a word the transcript got wrong still counts as an echo', () => {
    expect(isSelfEcho('tomorrow in tokyo it will be sunny with a high of twenty eight degrease', recent)).toBe(true)
  })

  it('does not read the last word of one reply and the first of the next as a single word', () => {
    expect(isSelfEcho('you will not need an umbrella today', ['Tomorrow will be sunny.', 'You will not need an umbrella.'])).toBe(true)
  })

  it('lets a new utterance through even when it is about the same thing', () => {
    expect(isSelfEcho('what about the temperature in Osaka instead', recent)).toBe(false)
    expect(isSelfEcho('thanks, that helps a lot', recent)).toBe(false)
  })
})

describe('stripClipEcho removes an aizuchi clip that leaked into the transcript', () => {
  const CLIPS = ['はい。', 'うんうん。', 'ええ。']

  it('strips a leading clip, with or without the punctuation that follows it', () => {
    expect(stripClipEcho('はい明日の天気教えて', CLIPS)).toBe('明日の天気教えて')
    expect(stripClipEcho('はい、明日の天気教えて', CLIPS)).toBe('明日の天気教えて')
  })

  it('strips a clip that leaked in at the end', () => {
    expect(stripClipEcho('お願いします はい', CLIPS)).toBe('お願いします')
  })

  it('returns an empty string when the whole utterance is an echo, so the caller can drop it', () => {
    expect(stripClipEcho('はい', CLIPS)).toBe('')
    expect(stripClipEcho('うんうん', CLIPS)).toBe('')
    expect(stripClipEcho('はい。うんうん。', CLIPS)).toBe('')
  })

  it('leaves a clip word in the middle of a sentence alone, so a real utterance is not broken', () => {
    expect(stripClipEcho('じゃあはいって返事して', CLIPS)).toBe('じゃあはいって返事して')
  })

  it('passes the text through when there is no clip candidate', () => {
    expect(stripClipEcho('はい', [])).toBe('はい')
  })

  it('strips the longest matching clip first, so a doubled aizuchi is not read as the short clip twice', () => {
    expect(stripClipEcho('はいはいわかりました', ['はいはい。', 'はい。'])).toBe('わかりました')
  })

  it('strips the punctuation of any language around the clip, not only the marks Japanese writes', () => {
    expect(stripClipEcho('Right, what is the weather tomorrow?', ['Right.'])).toBe('what is the weather tomorrow?')
    expect(stripClipEcho('¿Sí? dime la hora', ['Sí'])).toBe('dime la hora')
  })
})
