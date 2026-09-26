import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MicCapture } from '@/voice/MicCapture'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

class FakeTrack {
  readonly stop = vi.fn()
  private readonly endedListeners: Array<() => void> = []

  addEventListener(type: string, listener: () => void): void {
    if (type === 'ended') this.endedListeners.push(listener)
  }

  /** What the browser does when the device is unplugged or the permission is withdrawn. */
  end(): void {
    for (const listener of this.endedListeners.splice(0)) listener()
  }
}

function fakeStream(track: FakeTrack): MediaStream {
  return { getTracks: () => [track] } as unknown as MediaStream
}

class FakeSource {
  readonly connect = vi.fn()
  readonly disconnect = vi.fn()
}

class FakeAudioContext {
  static moduleLoads: Array<Promise<void>> = []
  static instances: FakeAudioContext[] = []

  readonly sampleRate = 48_000
  readonly close = vi.fn(async () => undefined)
  readonly source = new FakeSource()
  readonly audioWorklet = {
    addModule: vi.fn(() => FakeAudioContext.moduleLoads.shift() ?? Promise.resolve())
  }

  constructor() {
    FakeAudioContext.instances.push(this)
  }

  createMediaStreamSource(): MediaStreamAudioSourceNode {
    return this.source as unknown as MediaStreamAudioSourceNode
  }
}

class FakeWorkletNode {
  readonly port = { onmessage: null, close: vi.fn() }
  readonly disconnect = vi.fn()
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  FakeAudioContext.instances = []
  FakeAudioContext.moduleLoads = []
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('MicCapture start generations', () => {
  it('finishes a cancelled getUserMedia wait and releases its stream when it arrives', async () => {
    const media = deferred<MediaStream>()
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => media.promise } })
    const mic = new MicCapture()
    let finished = false
    const starting = mic.start(() => {}, () => {}).then(() => { finished = true })
    mic.stop()
    await flush()
    await flush()
    expect(finished).toBe(true)
    const track = new FakeTrack()
    media.resolve(fakeStream(track))
    await flush()
    expect(track.stop).toHaveBeenCalledOnce()
    expect(FakeAudioContext.instances).toHaveLength(0)
    await starting
  })

  it('releases capture resources immediately when stopped during worklet loading', async () => {
    const module = deferred<void>()
    FakeAudioContext.moduleLoads = [module.promise]
    const track = new FakeTrack()
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => fakeStream(track) } })
    const mic = new MicCapture()
    let finished = false
    const starting = mic.start(() => {}, () => {}).then(() => { finished = true })
    await flush()
    mic.stop()
    await flush()
    await flush()
    expect(finished).toBe(true)
    expect(track.stop).toHaveBeenCalledOnce()
    expect(FakeAudioContext.instances[0].close).toHaveBeenCalledOnce()
    module.resolve()
    await flush()
    await starting
    expect(track.stop).toHaveBeenCalledOnce()
  })

  it('shares one start operation within the same generation', async () => {
    const track = new FakeTrack()
    const getUserMedia = vi.fn(async () => fakeStream(track))
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    const mic = new MicCapture()

    const first = mic.start(() => {}, () => {})
    const second = mic.start(() => {}, () => {})

    expect(second).toBe(first)
    await first
    expect(getUserMedia).toHaveBeenCalledOnce()
    expect(track.stop).not.toHaveBeenCalled()
    mic.stop()
    expect(track.stop).toHaveBeenCalledOnce()
  })

  it('lets an obsolete pending start clean up only its own resources', async () => {
    const firstMedia = deferred<MediaStream>()
    const secondMedia = deferred<MediaStream>()
    const getUserMedia = vi
      .fn()
      .mockImplementationOnce(() => firstMedia.promise)
      .mockImplementationOnce(() => secondMedia.promise)
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })

    const firstModule = deferred<void>()
    const secondModule = deferred<void>()
    FakeAudioContext.moduleLoads = [firstModule.promise, secondModule.promise]
    const firstTrack = new FakeTrack()
    const secondTrack = new FakeTrack()
    const mic = new MicCapture()

    const obsolete = mic.start(() => {}, () => {})
    firstMedia.resolve(fakeStream(firstTrack))
    await flush()
    expect(FakeAudioContext.instances).toHaveLength(1)

    mic.stop()
    const current = mic.start(() => {}, () => {})
    secondMedia.resolve(fakeStream(secondTrack))
    await flush()
    expect(FakeAudioContext.instances).toHaveLength(2)

    secondModule.resolve()
    await current
    expect(secondTrack.stop).not.toHaveBeenCalled()
    expect(FakeAudioContext.instances[1].close).not.toHaveBeenCalled()

    firstModule.resolve()
    await obsolete
    expect(firstTrack.stop).toHaveBeenCalledOnce()
    expect(FakeAudioContext.instances[0].close).toHaveBeenCalledOnce()
    expect(secondTrack.stop).not.toHaveBeenCalled()

    mic.stop()
    expect(secondTrack.stop).toHaveBeenCalledOnce()
    expect(FakeAudioContext.instances[1].close).toHaveBeenCalledOnce()
  })
})

describe('MicCapture when the device goes away', () => {
  it('reports a track that ends while it captures', async () => {
    const track = new FakeTrack()
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => fakeStream(track) } })
    const mic = new MicCapture()
    const onEnded = vi.fn()
    await mic.start(() => {}, onEnded)

    track.end()

    expect(onEnded).toHaveBeenCalledOnce()
    mic.stop()
  })

  it('reports nothing for a track of a capture that has been stopped', async () => {
    const track = new FakeTrack()
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => fakeStream(track) } })
    const mic = new MicCapture()
    const onEnded = vi.fn()
    await mic.start(() => {}, onEnded)
    mic.stop()

    track.end()

    expect(onEnded).not.toHaveBeenCalled()
  })
})
