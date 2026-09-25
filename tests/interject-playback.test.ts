import { describe, expect, it, vi } from 'vitest'
import { InterjectPlaybackAcks } from '../src/renderer/src/interject-playback'

const segment = (turnId: number, index: number) => ({
  turnId,
  index,
  text: '報告です',
  audio: null,
  phonemes: null
})

describe('InterjectPlaybackAcks', () => {
  it('acknowledges only actual report playback, not a filler or another turn', () => {
    const send = vi.fn(async () => undefined)
    const acks = new InterjectPlaybackAcks(send)
    acks.track(7)

    expect(acks.markSegmentStarted(segment(7, 998))).toBe(false)
    expect(acks.markSegmentStarted(segment(8, 0))).toBe(false)
    expect(acks.markSegmentQueued(segment(7, 0))).toBe(true)
    expect(acks.markSegmentStarted(segment(7, 0))).toBe(true)
    expect(acks.markSegmentStarted(segment(7, 1))).toBe(false)
    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith(7, 'started')
  })

  it('immediately rejects a started event that loses the main/renderer idle race', () => {
    const send = vi.fn(async () => undefined)
    const acks = new InterjectPlaybackAcks(send)

    acks.rejectStarted(12)

    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith(12, 'interrupted')
  })

  it('does not wait for the main timeout when a turn ends without a body segment', () => {
    const send = vi.fn(async () => undefined)
    const acks = new InterjectPlaybackAcks(send)
    acks.track(20)

    expect(acks.finishTurn(20)).toBe(true)
    expect(acks.finishTurn(20)).toBe(false)
    expect(send).toHaveBeenCalledWith(20, 'interrupted')
  })

  it('keeps a queued body after done until its actual playback starts', () => {
    const send = vi.fn(async () => undefined)
    const acks = new InterjectPlaybackAcks(send)
    acks.track(21)
    acks.markSegmentQueued(segment(21, 0))

    expect(acks.finishTurn(21)).toBe(false)
    expect(send).not.toHaveBeenCalled()
    expect(acks.markSegmentStarted(segment(21, 0))).toBe(true)
    expect(send).toHaveBeenCalledWith(21, 'started')
  })

  it('requeues every tracked but unplayed turn when user input discards the queue', () => {
    const send = vi.fn(async () => undefined)
    const acks = new InterjectPlaybackAcks(send)
    acks.track(3)
    acks.track(4)

    expect(acks.interruptPending()).toEqual([3, 4])
    expect(acks.interruptPending()).toEqual([])
    expect(acks.markSegmentStarted(segment(3, 0))).toBe(false)
    expect(send.mock.calls).toEqual([
      [3, 'interrupted'],
      [4, 'interrupted']
    ])
  })

  it('retries a transient IPC acknowledgement failure', async () => {
    vi.useFakeTimers()
    try {
      const send = vi.fn().mockRejectedValueOnce(new Error('ipc busy')).mockResolvedValue(undefined)
      const acks = new InterjectPlaybackAcks(send)
      acks.track(9)
      acks.markSegmentStarted(segment(9, 0))
      await Promise.resolve()

      await vi.advanceTimersByTimeAsync(250)
      expect(send).toHaveBeenCalledTimes(2)
      expect(send).toHaveBeenLastCalledWith(9, 'started')
    } finally {
      vi.useRealTimers()
    }
  })
})
