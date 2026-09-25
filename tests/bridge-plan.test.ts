import { describe, expect, it, vi } from 'vitest'
import type { BridgePlan } from '@shared/ipc'
import { BridgePlanner } from '@/voice/bridge-plan'

const plan = (bridge: string): BridgePlan => ({ bridge })

function setup() {
  const resolvers: Array<(plan: BridgePlan) => void> = []
  const rejecters: Array<(error: Error) => void> = []
  const request = vi.fn(
    () =>
      new Promise<BridgePlan>((resolve, reject) => {
        resolvers.push(resolve)
        rejecters.push(reject)
      })
  )
  const onPlan = vi.fn()
  const onFailure = vi.fn()
  const planner = new BridgePlanner({ plan: request, onPlan, onFailure })
  return { planner, request, resolvers, rejecters, onPlan, onFailure }
}

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('BridgePlanner', () => {
  it('sends one request at a time and keeps only the latest partial transcript while a request is in flight', async () => {
    const { planner, request, resolvers } = setup()
    planner.observe({ text: '昨日の会議で', lastAssistantText: '' })
    planner.observe({ text: '昨日の会議で予算の', lastAssistantText: '' })
    planner.observe({ text: '昨日の会議で予算の話が', lastAssistantText: '' })
    expect(request).toHaveBeenCalledTimes(1)
    resolvers[0](plan('会議の件ですね。'))
    await flush()
    expect(planner.current()).toEqual(plan('会議の件ですね。'))
    expect(request).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenLastCalledWith({ text: '昨日の会議で予算の話が', lastAssistantText: '' })
    resolvers[1](plan('予算の件ですね。'))
    await flush()
    expect(planner.current()).toEqual(plan('予算の件ですね。'))
  })

  it('sends nothing for a partial transcript that is too short or unchanged', () => {
    const { planner, request } = setup()
    planner.observe({ text: 'あの', lastAssistantText: '' })
    expect(request).not.toHaveBeenCalled()
    planner.observe({ text: '昨日の会議で', lastAssistantText: '' })
    planner.observe({ text: '昨日の会議で ', lastAssistantText: '' })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('drops a stale result that arrives after a reset and reports no failure for it', async () => {
    const { planner, resolvers, rejecters, onPlan, onFailure } = setup()
    planner.observe({ text: '昨日の会議で', lastAssistantText: '' })
    planner.observe({ text: '昨日の会議で予算の', lastAssistantText: '' })
    planner.reset()
    resolvers[0](plan('古い'))
    await flush()
    expect(planner.current()).toBeNull()
    expect(onPlan).not.toHaveBeenCalled()
    // The reset also drops the held input, so nothing is sent again.
    expect(rejecters).toHaveLength(1)
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('waits at the end of an utterance for the request in flight and the held one, and returns the latest plan', async () => {
    const { planner, resolvers } = setup()
    planner.observe({ text: '昨日の会議で', lastAssistantText: '' })
    planner.observe({ text: '昨日の会議で予算の', lastAssistantText: '' })
    const settled = planner.finish({ text: '昨日の会議で予算の話が', lastAssistantText: '' })
    resolvers[0](plan('会議の件ですね。'))
    await flush()
    // The held request is sent again, so the wait continues.
    let done = false
    void settled.then(() => (done = true))
    await flush()
    expect(done).toBe(false)
    resolvers[1](plan('予算の件ですね。'))
    await expect(settled).resolves.toEqual(plan('予算の件ですね。'))
  })

  it('sends the last partial transcript at the end of an utterance when nothing is in flight, and returns null at once when there is nothing to send', async () => {
    const { planner, request, resolvers } = setup()
    const settled = planner.finish({ text: 'あの', lastAssistantText: '' })
    expect(request).toHaveBeenCalledWith({ text: 'あの', lastAssistantText: '' })
    resolvers[0](plan(''))
    await expect(settled).resolves.toEqual(plan(''))
    planner.reset()
    await expect(planner.finish({ text: '', lastAssistantText: '' })).resolves.toBeNull()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('returns null to an end of utterance that is still waiting when a reset happens', async () => {
    const { planner, resolvers } = setup()
    planner.observe({ text: '昨日の会議で', lastAssistantText: '' })
    const settled = planner.finish({ text: '昨日の会議で', lastAssistantText: '' })
    planner.reset()
    await expect(settled).resolves.toBeNull()
    resolvers[0](plan('古い'))
    await flush()
    expect(planner.current()).toBeNull()
  })

  it('reports a failure and sends again on the next partial transcript', async () => {
    const { planner, request, rejecters, resolvers, onFailure } = setup()
    planner.observe({ text: '昨日の会議で', lastAssistantText: '' })
    rejecters[0](new Error('timeout'))
    await flush()
    expect(onFailure).toHaveBeenCalledOnce()
    planner.observe({ text: '昨日の会議で予算の', lastAssistantText: '' })
    expect(request).toHaveBeenCalledTimes(2)
    resolvers[1](plan('予算の件ですね。'))
    await flush()
    expect(planner.current()).toEqual(plan('予算の件ですね。'))
  })
})
