import { describe, expect, it } from 'vitest'
import { appendTranscript, splitRecognitionAudio } from '../src/main/services/asr-utterance'

const RATE = 1000
const audio = (seconds: number): Float32Array => new Float32Array(seconds * RATE).fill(0.2)

describe('splitting recognition audio at pauses', () => {
  it('passes short audio through without a copy, including empty audio', () => {
    for (const samples of [audio(3), new Float32Array(0)]) {
      expect(splitRecognitionAudio(samples, RATE, 4)).toEqual([samples])
      expect(splitRecognitionAudio(samples, RATE, 4)[0]).toBe(samples)
    }
  })

  it('splits at the longest internal pause before splitting either long remainder', () => {
    const samples = audio(15)
    samples.fill(0, 2 * RATE, 3 * RATE)
    samples.fill(0, 8 * RATE, 8.5 * RATE)
    const parts = splitRecognitionAudio(samples, RATE, 7)
    expect(parts.map((part) => part.length / RATE)).toEqual([2.5, 5.75, 6.75])
    expect(Float32Array.from(parts.flatMap((part) => Array.from(part)))).toEqual(samples)
    expect(parts.every((part) => part.buffer === samples.buffer)).toBe(true)
  })

  it('does not pick leading or trailing silence as a pause between words', () => {
    const samples = audio(12)
    samples.fill(0, 0, 2 * RATE)
    samples.fill(0, 10 * RATE)
    samples.fill(0, 6 * RATE, 6.2 * RATE)
    const parts = splitRecognitionAudio(samples, RATE, 7)
    expect(parts.map((part) => part.length / RATE)).toEqual([6.1, 5.9])
  })

  it('bounds continuous sound and silence without losing the last incomplete frame', () => {
    for (const value of [0, 0.2]) {
      const samples = new Float32Array(12 * RATE + 7).fill(value)
      const parts = splitRecognitionAudio(samples, RATE, 5)
      expect(parts.map((part) => part.length)).toEqual([5000, 5000, 2007])
      expect(Float32Array.from(parts.flatMap((part) => Array.from(part)))).toEqual(samples)
    }
  })

  it('measures energy across frames rather than splitting at waveform zero crossings', () => {
    const samples = Float32Array.from({ length: 8 * RATE }, (_, i) => Math.sin(i * Math.PI / 5) * 0.2)
    expect(splitRecognitionAudio(samples, RATE, 5).map((part) => part.length)).toEqual([5000, 3000])
  })
})

describe('joining recognized parts', () => {
  it.each([
    ['前の文。', '次の文。', '前の文。次の文。'],
    ['Hello.', 'World.', 'Hello. World.'],
    ['Hello', '日本語', 'Hello日本語'],
    ['日本語', 'and English', '日本語and English'],
    ['𠀀', 'English', '𠀀English'],
    ['Hello. ', ' World.', 'Hello. World.'],
    ['Hello.', '', 'Hello.'],
    ['', 'Hello.', 'Hello.'],
    ['ภาษาไทย', 'ต่อไป', 'ภาษาไทย ต่อไป']
  ])('joins %j and %j at their writing boundary', (left, right, expected) => {
    expect(appendTranscript(left, right)).toBe(expected)
  })
})
