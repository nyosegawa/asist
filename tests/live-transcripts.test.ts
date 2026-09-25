import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TranscriptTracker } from '../src/main/services/live/transcripts'

describe('TranscriptTracker', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reports the growing text as fragments arrive and finalizes it after quietMs of silence', () => {
    const onDelta = vi.fn()
    const onFinal = vi.fn()
    const tracker = new TranscriptTracker({ quietMs: 1000, onDelta, onFinal })
    tracker.push('user', '明日の')
    vi.advanceTimersByTime(900)
    tracker.push('user', '天気')
    expect(onDelta.mock.calls.map((c) => c[1])).toEqual(['明日の', '明日の天気'])
    vi.advanceTimersByTime(999)
    expect(onFinal).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onFinal).toHaveBeenCalledWith('user', '明日の天気')
    expect(tracker.pending('user')).toBe('')
  })

  it('finalizes immediately on flush and hands the text over without finalizing on take', () => {
    const onFinal = vi.fn()
    const tracker = new TranscriptTracker({ quietMs: 1000, onDelta: vi.fn(), onFinal })
    tracker.push('assistant', 'はい。')
    expect(tracker.flush('assistant')).toBe('はい。')
    expect(onFinal).toHaveBeenCalledWith('assistant', 'はい。')
    tracker.push('user', ' 会議の件 ')
    expect(tracker.take('user')).toBe('会議の件')
    vi.advanceTimersByTime(2000)
    expect(onFinal).toHaveBeenCalledTimes(1)
    expect(tracker.flush('user')).toBe('')
  })

  it('tracks user and assistant separately and stops the pending finalization on dispose', () => {
    const onFinal = vi.fn()
    const tracker = new TranscriptTracker({ quietMs: 1000, onDelta: vi.fn(), onFinal })
    tracker.push('user', 'あ')
    tracker.push('assistant', 'い')
    tracker.dispose()
    vi.advanceTimersByTime(5000)
    expect(onFinal).not.toHaveBeenCalled()
  })
})
