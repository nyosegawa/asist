import { describe, expect, it } from 'vitest'
import { classifyOverlap, type OverlapInput } from '@shared/user-backchannel'

/** Input that has not yet met the plain barge-in thresholds of 250 ms voiced and 100 ms of human speech. */
const base: OverlapInput = { voicedMs: 120, speechMs: 100, bcDet: null, confirmMs: 250, minSpeechMs: 100 }

describe('classifyOverlap decides what the user voice during playback means', () => {
  it('without the model, calls a barge-in once the voiced time reaches the threshold and human speech is evident', () => {
    expect(classifyOverlap(base)).toBe('undecided')
    expect(classifyOverlap({ ...base, voicedMs: 260 })).toBe('bargein')
  })

  it('calls it noise when the voice continues but there is no evidence of human speech', () => {
    expect(classifyOverlap({ ...base, voicedMs: 260, speechMs: 0 })).toBe('noise')
    expect(classifyOverlap({ ...base, voicedMs: 260, speechMs: 40 })).toBe('undecided')
  })

  it('lets it pass as an aizuchi when the detector is above the threshold and there is any evidence of human speech', () => {
    expect(classifyOverlap({ ...base, bcDet: 0.6, speechMs: 20 })).toBe('backchannel')
    expect(classifyOverlap({ ...base, bcDet: 0.6, speechMs: 0 })).toBe('undecided')
  })

  it('waits a little longer before calling a barge-in when the model is present, to give the detector a chance', () => {
    expect(classifyOverlap({ ...base, voicedMs: 300, bcDet: 0.1 })).toBe('undecided')
    expect(classifyOverlap({ ...base, voicedMs: 500, bcDet: 0.1 })).toBe('bargein')
  })

  it('never lets a voice pass as an aizuchi without the model, which is every conversation outside Japanese', () => {
    for (let voicedMs = 0; voicedMs <= 1200; voicedMs += 50) {
      for (const speechMs of [0, 40, 100, voicedMs]) {
        expect(classifyOverlap({ ...base, voicedMs, speechMs })).not.toBe('backchannel')
      }
    }
  })

  it('calls a barge-in for a voice too long to be an aizuchi, even when the detector fired', () => {
    expect(classifyOverlap({ ...base, voicedMs: 950, bcDet: 0.9 })).toBe('bargein')
    // However long it lasts, without evidence of human speech it is not a barge-in.
    expect(classifyOverlap({ ...base, voicedMs: 950, speechMs: 0, bcDet: 0.9 })).toBe('noise')
  })
})
