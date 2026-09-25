import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackchannelDecision } from '@shared/listening-aizuchi'

/**
 * The conversation language decides what the voice pipeline runs: the aizuchi played while the user
 * speaks, MaAI, and the list of phrases Whisper hallucinates all belong to Japanese.
 */

class FakeAudioContext {
  currentTime = 0
  sampleRate = 48_000
  audioWorklet = { addModule: vi.fn(async () => undefined) }

  createAnalyser(): AnalyserNode {
    return { fftSize: 0, connect: vi.fn(), getByteTimeDomainData: vi.fn() } as unknown as AnalyserNode
  }

  createGain(): GainNode {
    return {
      connect: vi.fn(),
      gain: { cancelScheduledValues: vi.fn(), setTargetAtTime: vi.fn(), setValueAtTime: vi.fn() }
    } as unknown as GainNode
  }

  createMediaStreamDestination(): MediaStreamAudioDestinationNode {
    return { stream: {} } as MediaStreamAudioDestinationNode
  }
}

class FakeAudio {
  srcObject: unknown = null
  autoplay = false
}

interface VoiceInternals {
  state: 'off' | 'loading' | 'listening' | 'capturing' | 'transcribing'
  captureGeneration: number
  captureStartedAt: number
  lastPartial: string
  lastBackchannelAt: number
  mic: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }
  vad: unknown
  transcribeWithRecovery: (audio: Float32Array) => Promise<string>
  enqueueUtterance(samples: Float32Array, vadMs: number, vadMode: 'early' | 'extended' | 'fixed'): void
  maybeBackchannel(): void
}

let VoiceController: typeof import('../src/renderer/src/voice/VoiceController').VoiceController

beforeAll(async () => {
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('Audio', FakeAudio)
  ;({ VoiceController } = await import('../src/renderer/src/voice/VoiceController'))
})

beforeEach(() => {
  vi.stubGlobal('window', {
    api: {
      transcribe: vi.fn(),
      transcribeCancel: vi.fn(async () => true),
      transcribePartial: vi.fn(),
      getStatus: vi.fn(async () => ({ asr: true })),
      requestMicPermission: vi.fn(async () => true),
      vapStart: vi.fn(async () => true),
      vapPush: vi.fn(async () => undefined),
      onVapState: vi.fn(() => vi.fn())
    }
  })
})

const internals = (controller: InstanceType<typeof VoiceController>): VoiceInternals =>
  controller as unknown as VoiceInternals

/** A capture in a mid-sentence pause after a clause ending, which is where a listening aizuchi belongs. */
function pausedMidSentence(controller: InstanceType<typeof VoiceController>): void {
  const state = internals(controller)
  state.vad = { speechConfirmed: true, isSpeaking: true, silenceDuration: 400, utteranceDuration: 4000 }
  state.lastPartial = '昨日の夜に資料を作っていたんですけど'
  // Far enough back that the ceiling on how often an aizuchi may sound does not hold this one.
  state.lastBackchannelAt = -60_000
}

describe('listening aizuchi by conversation language', () => {
  it('fires in Japanese and never in another language, whatever the setting says', () => {
    for (const locale of ['ja-JP', 'en-US'] as const) {
      const controller = new VoiceController()
      controller.listeningAizuchi = true
      controller.conversationLocale = locale
      pausedMidSentence(controller)
      const fired: BackchannelDecision[] = []
      controller.events.on('backchannel', (decision) => fired.push(decision))

      internals(controller).maybeBackchannel()

      expect(fired.length).toBe(locale === 'ja-JP' ? 1 : 0)
    }
  })
})

describe('MaAI by conversation language', () => {
  async function start(locale: 'ja-JP' | 'en-US'): Promise<void> {
    const controller = new VoiceController()
    controller.nativeMicPreferred = false
    controller.vapEnabled = true
    controller.conversationLocale = locale
    internals(controller).mic = { start: vi.fn(async () => undefined), stop: vi.fn() }
    await controller.enable()
    controller.disable()
  }

  it('starts the worker in Japanese', async () => {
    await start('ja-JP')
    expect(window.api.vapStart).toHaveBeenCalled()
    expect(window.api.onVapState).toHaveBeenCalled()
  })

  it('leaves the worker alone in another language, so the fixed hangover decides the end of an utterance', async () => {
    await start('en-US')
    expect(window.api.vapStart).not.toHaveBeenCalled()
    expect(window.api.onVapState).not.toHaveBeenCalled()
  })
})

describe('the list of Whisper hallucinations by conversation language', () => {
  async function transcribe(locale: 'ja-JP' | 'en-US', text: string): Promise<string[]> {
    const controller = new VoiceController()
    const state = internals(controller)
    controller.conversationLocale = locale
    state.state = 'listening'
    state.captureGeneration = 1
    state.transcribeWithRecovery = vi.fn(async () => text)
    const utterances: string[] = []
    controller.events.on('utterance', (event) => utterances.push(event.text))
    state.enqueueUtterance(new Float32Array([0.1]), 300, 'fixed')
    await vi.waitFor(() => expect(state.transcribeWithRecovery).toHaveBeenCalled())
    await Promise.resolve()
    await Promise.resolve()
    return utterances
  }

  it('drops the Japanese set phrase in Japanese and starts a turn on it in another language', async () => {
    expect(await transcribe('ja-JP', 'ご視聴ありがとうございました')).toEqual([])
    expect(await transcribe('en-US', 'ご視聴ありがとうございました')).toEqual(['ご視聴ありがとうございました'])
  })
})
