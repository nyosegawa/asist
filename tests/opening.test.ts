import { describe, expect, it, vi } from 'vitest'
import type { BridgeClip, AizuchiClip, BridgePlan } from '@shared/ipc'
import type { AizuchiClassification } from '@shared/aizuchi-classifier'
import { TurnOpening } from '@/voice/opening'

const clip: AizuchiClip = { text: 'なるほど。', category: 'understand', weight: 1, audio: 'eA==' }
const plan: BridgePlan = { bridge: '会議の件ですね。' }
const classification: AizuchiClassification = { cls: 'understand', prob: 0.9, complete: 0.8 }
const input = {
  startedAt: 10,
  speechEndAt: 1000,
  classification,
  /** The lookahead plan is already resolved when the speech ends. */
  plan: Promise.resolve<BridgePlan | null>(plan),
  sinceListeningMs: 9000
}

function setup(picked: AizuchiClip | null = clip) {
  const play = vi.fn()
  const pickAizuchi = vi.fn(() => picked)
  const resolvers: Array<(bridge: BridgeClip) => void> = []
  const rejecters: Array<(error: Error) => void> = []
  const synthesizeBridge = vi.fn(
    () =>
      new Promise<BridgeClip>((resolve, reject) => {
        resolvers.push(resolve)
        rejecters.push(reject)
      })
  )
  const bodyQueued = { after: false }
  const onBridgeOutcome = vi.fn()
  const opening = new TurnOpening({
    pickAizuchi,
    play,
    synthesizeBridge,
    bodyQueuedAfter: () => bodyQueued.after,
    onBridgeOutcome
  })
  return { opening, play, pickAizuchi, synthesizeBridge, resolvers, rejecters, bodyQueued, onBridgeOutcome }
}

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('TurnOpening', () => {
  it('plays the aizuchi when the speech ends, asks for the bridge to be synthesized, and hands both texts over with the final transcript', async () => {
    const { opening, play, pickAizuchi, synthesizeBridge, resolvers } = setup()
    opening.begin(input)
    expect(pickAizuchi).toHaveBeenCalledWith(classification)
    expect(play).toHaveBeenCalledWith(clip, 'aizuchi')
    await flush()
    expect(synthesizeBridge).toHaveBeenCalledWith('会議の件ですね。')
    expect(opening.claim(10)).toEqual({ aizuchi: 'なるほど。', bridge: '会議の件ですね。', bridgePending: false })
    // Once it has been claimed, the same utterance never receives it a second time.
    expect(opening.claim(10)).toBeNull()
    // A synthesis that finishes after the claim still plays, as long as the body of the reply has not arrived.
    resolvers[0]({ text: '会議の件ですね。', audio: 'YQ==' })
    await flush()
    expect(play).toHaveBeenLastCalledWith({ text: '会議の件ですね。', audio: 'YQ==' }, 'bridge')
  })

  it('plays the aizuchi from the classification even when the lookahead is late, and asks for the bridge once the plan resolves', async () => {
    const { opening, play, pickAizuchi, synthesizeBridge, resolvers } = setup()
    let settle!: (plan: BridgePlan | null) => void
    const settled = new Promise<BridgePlan | null>((resolve) => (settle = resolve))
    opening.begin({ ...input, plan: settled })
    expect(pickAizuchi).toHaveBeenCalledWith(classification)
    expect(play).toHaveBeenCalledWith(clip, 'aizuchi')
    // The final transcript arrives first, so the bridge is handed over as still pending.
    expect(opening.claim(10)).toEqual({ aizuchi: 'なるほど。', bridge: null, bridgePending: true })
    settle(plan)
    await flush()
    expect(synthesizeBridge).toHaveBeenCalledWith('会議の件ですね。')
    resolvers[0]({ text: '会議の件ですね。', audio: 'YQ==' })
    await flush()
    expect(play).toHaveBeenLastCalledWith({ text: '会議の件ですね。', audio: 'YQ==' }, 'bridge')
  })

  it('settles without a bridge when the lookahead produced no plan', async () => {
    const { opening, synthesizeBridge } = setup()
    opening.begin({ ...input, plan: Promise.resolve(null) })
    await flush()
    expect(synthesizeBridge).not.toHaveBeenCalled()
    expect(opening.claim(10)).toEqual({ aizuchi: 'なるほど。', bridge: null, bridgePending: false })
  })

  it('plays neither aizuchi nor bridge without a classification, and asks for no bridge on flow, correct, hold and none', async () => {
    const { opening, play, synthesizeBridge } = setup(null)
    opening.begin({ ...input, classification: null })
    await flush()
    expect(play).not.toHaveBeenCalled()
    expect(synthesizeBridge).not.toHaveBeenCalled()
    expect(opening.claim(10)).toEqual({ aizuchi: null, bridge: null, bridgePending: false })
    for (const cls of ['flow', 'correct', 'hold', 'none'] as const) {
      opening.begin({ ...input, startedAt: 20, classification: { cls, prob: 0.95, complete: 0.9 } })
      await flush()
    }
    expect(synthesizeBridge).not.toHaveBeenCalled()
  })

  it('leaves the bridge unplayed and records it as late when the body of the reply was queued first', async () => {
    const { opening, play, resolvers, bodyQueued, onBridgeOutcome } = setup()
    opening.begin(input)
    await flush()
    opening.claim(10)
    bodyQueued.after = true
    resolvers[0]({ text: '会議の件ですね。', audio: 'YQ==' })
    await flush()
    expect(play).toHaveBeenCalledTimes(1)
    expect(onBridgeOutcome).toHaveBeenCalledWith({ bridge: 'late' })
  })

  it('records the bridge as failed when its synthesis throws', async () => {
    const { opening, rejecters, onBridgeOutcome } = setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    opening.begin(input)
    await flush()
    rejecters[0](new Error('tts down'))
    await flush()
    expect(onBridgeOutcome).toHaveBeenCalledWith({ bridge: 'failed' })
    vi.restoreAllMocks()
  })

  it('asks for no bridge and hands over the aizuchi alone when the lookahead carries no bridge text', async () => {
    const { opening, synthesizeBridge } = setup()
    opening.begin({ ...input, plan: Promise.resolve({ bridge: '' }) })
    await flush()
    expect(synthesizeBridge).not.toHaveBeenCalled()
    expect(opening.claim(10)).toEqual({ aizuchi: 'なるほど。', bridge: null, bridgePending: false })
  })

  it('turns the real start of a clip into the delay since the speech ended and the length of the clip, per role', async () => {
    const { opening } = setup()
    opening.begin(input)
    expect(opening.clipStarted('aizuchi', 640.4, 1250)).toEqual({ aizuchiMs: 250, aizuchiClipMs: 640 })
    expect(opening.clipStarted('listening', 500, 1300)).toBeNull()
    await flush()
    opening.claim(10)
    expect(opening.clipStarted('bridge', 900, 2100)).toEqual({ bridgeMs: 1100, bridgeClipMs: 900, bridge: 'played' })
  })

  it('plays no aizuchi right after a listening aizuchi, while still asking for the bridge', async () => {
    const { opening, play, pickAizuchi, synthesizeBridge } = setup()
    opening.begin({ ...input, sinceListeningMs: 1500 })
    await flush()
    expect(pickAizuchi).not.toHaveBeenCalled()
    expect(play).not.toHaveBeenCalled()
    expect(synthesizeBridge).toHaveBeenCalledOnce()
    expect(opening.claim(10)).toEqual({ aizuchi: null, bridge: '会議の件ですね。', bridgePending: false })
  })

  it('hands nothing to the transcript of another utterance, is replaced when the next utterance starts, and never plays the old bridge', async () => {
    const { opening, play, resolvers } = setup()
    opening.begin(input)
    await flush()
    expect(opening.claim(99)).toBeNull()
    opening.begin({ ...input, startedAt: 20, speechEndAt: 2000 })
    await flush()
    resolvers[0]({ text: '会議の件ですね。', audio: 'YQ==' })
    await flush()
    expect(play.mock.calls.filter(([, role]) => role === 'bridge')).toHaveLength(0)
    expect(opening.claim(10)).toBeNull()
    expect(opening.claim(20)).toEqual({ aizuchi: 'なるほど。', bridge: '会議の件ですね。', bridgePending: false })
  })

  it('drops the recorded opening when the transcript is discarded as an echo, and ignores a cancel for another utterance', () => {
    const { opening } = setup()
    opening.begin(input)
    opening.cancel(99)
    expect(opening.clipStarted('aizuchi', 600, 1200)).not.toBeNull()
    opening.cancel(10)
    expect(opening.clipStarted('aizuchi', 600, 1200)).toBeNull()
    expect(opening.claim(10)).toBeNull()
  })

  it('plays no bridge that finishes synthesizing after the user talked over the claimed turn', async () => {
    const { opening, play, resolvers } = setup()
    opening.begin(input)
    await flush()
    opening.claim(10)
    opening.interrupt()
    resolvers[0]({ text: '会議の件ですね。', audio: 'YQ==' })
    await flush()
    expect(play.mock.calls.filter(([, role]) => role === 'bridge')).toHaveLength(0)
  })
})
