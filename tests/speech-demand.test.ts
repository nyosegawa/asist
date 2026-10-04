import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '@shared/ipc'

const mocks = vi.hoisted(() => ({ idleSince: -Infinity as number | null, turn: null as number | null }))
vi.mock('../src/main/services/local-tts', () => ({ idleSince: () => mocks.idleSince }))
vi.mock('../src/main/services/aizuchi-classifier', () => ({ wanted: (settings: AppSettings) => settings.aizuchi }))
vi.mock('../src/main/services/brain/session', () => ({ turnScheduler: { get activeTurnId() { return mocks.turn } } }))

let demand: typeof import('../src/main/services/speech-demand')
let presence: typeof import('../src/main/services/window-presence')
const local = { ttsEngine: 'qwen3tts', aizuchi: true } as AppSettings
const minutes = (count: number): number => count * 60_000

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  mocks.idleSince = -Infinity
  mocks.turn = null
  demand = await import('../src/main/services/speech-demand')
  presence = await import('../src/main/services/window-presence')
})
afterEach(() => {
  vi.useRealTimers()
})

describe('what needs the local speech models', () => {
  it('wants speech recognition and the aizuchi classifier only while the microphone is on', () => {
    expect([demand.asrWanted(), demand.classifierWanted(local)]).toEqual([false, false])
    demand.setMicrophone(true)
    expect([demand.asrWanted(), demand.classifierWanted(local)]).toEqual([true, true])
    demand.setMicrophone(false)
    expect([demand.asrWanted(), demand.classifierWanted(local)]).toEqual([false, false])
  })

  it('leaves a local speech synthesis model unwanted at launch, before anything has needed it', () => {
    expect(demand.ttsWanted(local)).toBe(false)
  })

  it('always wants the engine of another app and the speech of the OS, which it does not load itself', () => {
    expect(demand.ttsWanted({ ...local, ttsEngine: 'voicevox' })).toBe(true)
    expect(demand.ttsWanted({ ...local, ttsEngine: 'system' })).toBe(true)
  })

  it('keeps a local speech synthesis model wanted for five minutes after the microphone turned off', () => {
    demand.setMicrophone(true)
    vi.advanceTimersByTime(minutes(30))
    expect(demand.ttsWanted(local)).toBe(true)
    demand.setMicrophone(false)
    vi.advanceTimersByTime(minutes(5) - 1_000)
    expect(demand.ttsWanted(local)).toBe(true)
    vi.advanceTimersByTime(2_000)
    expect(demand.ttsWanted(local)).toBe(false)
  })

  it('counts the five minutes from the last reading when it came after the microphone turned off', () => {
    demand.setMicrophone(true)
    demand.setMicrophone(false)
    vi.advanceTimersByTime(minutes(3))
    mocks.idleSince = Date.now()
    vi.advanceTimersByTime(minutes(4))
    expect(demand.ttsWanted(local)).toBe(true)
    vi.advanceTimersByTime(minutes(1) + 1_000)
    expect(demand.ttsWanted(local)).toBe(false)
  })

  it('keeps it wanted while it loads or reads, however long ago anything else needed it', () => {
    vi.advanceTimersByTime(minutes(60))
    mocks.idleSince = null
    expect(demand.ttsWanted(local)).toBe(true)
  })

  it('lets a local speech synthesis model go once the reply under way has ended while the window is away', () => {
    demand.setMicrophone(true)
    demand.setMicrophone(false)
    mocks.idleSince = Date.now()
    presence.setWindowAway(true)
    // Between two sentences of a reply nothing is being read, but the turn goes on.
    mocks.turn = 7
    expect(demand.ttsWanted(local)).toBe(true)
    mocks.turn = null
    expect(demand.ttsWanted(local)).toBe(false)
    presence.setWindowAway(false)
    expect(demand.ttsWanted(local)).toBe(true)
  })
})
