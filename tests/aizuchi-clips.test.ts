import { describe, expect, it } from 'vitest'
import { pickWeightedClip } from '@shared/aizuchi-clips'
import type { AizuchiClip } from '@shared/ipc'

describe('pickWeightedClip', () => {
  const clip = (text: string, weight: number): AizuchiClip => ({
    text,
    category: 'flow',
    weight,
    audio: 'x'
  })

  it('picks a clip in proportion to its weight', () => {
    const clips = [clip('a', 1), clip('b', 3)]
    // The cumulative ranges are a=[0,1) and b=[1,4), so r=0.5*4=2 lands on b.
    expect(pickWeightedClip(clips, { random: () => 0.5 })!.text).toBe('b')
    // r=0.1*4=0.4 lands on a.
    expect(pickWeightedClip(clips, { random: () => 0.1 })!.text).toBe('a')
    // r=0.99*4=3.96 lands on b.
    expect(pickWeightedClip(clips, { random: () => 0.99 })!.text).toBe('b')
  })

  it('excludes the text that was played last, so the same phrase does not repeat', () => {
    const clips = [clip('a', 100), clip('b', 1)]
    expect(pickWeightedClip(clips, { excludeText: 'a', random: () => 0.5 })!.text).toBe('b')
  })

  it('picks from the whole set instead of returning null when every clip is excluded', () => {
    const clips = [clip('a', 1)]
    expect(pickWeightedClip(clips, { excludeText: 'a', random: () => 0.5 })!.text).toBe('a')
  })

  it('returns null for an empty list', () => {
    expect(pickWeightedClip([], { random: () => 0.5 })).toBeNull()
  })

  it('still picks uniformly when every weight is zero', () => {
    const clips = [clip('a', 0), clip('b', 0)]
    expect(pickWeightedClip(clips, { random: () => 0.9 })!.text).toBe('b')
  })
})
