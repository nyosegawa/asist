import { StreamResampler } from '@shared/pcm'

/**
 * Opens the microphone at its native sample rate and downsamples to 16 kHz mono here rather than
 * asking for AudioContext({ sampleRate: 16000 }), whose forced resampling degrades the audio on
 * macOS and costs transcription quality. A streaming resampler with linear interpolation does it
 * instead.
 */

const TARGET_SAMPLE_RATE = 16_000

/** An AudioWorkletProcessor that batches about 1024 samples per message, to keep the message rate down. */
const PROCESSOR_SOURCE = `
class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.chunks = []
    this.length = 0
  }
  process(inputs) {
    const channel = inputs[0]?.[0]
    if (channel) {
      this.chunks.push(channel.slice(0))
      this.length += channel.length
      if (this.length >= 1024) {
        const out = new Float32Array(this.length)
        let offset = 0
        for (const chunk of this.chunks) {
          out.set(chunk, offset)
          offset += chunk.length
        }
        this.port.postMessage(out, [out.buffer])
        this.chunks = []
        this.length = 0
      }
    }
    return true
  }
}
registerProcessor('pcm-processor', PcmProcessor)
`

export { StreamResampler }

export class MicCapture {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: AudioWorkletNode | null = null
  /** A getUserMedia or worklet setup that began before a stop belongs to an older generation and never reaches the shared state. */
  private generation = 0
  private startOperation: { generation: number; promise: Promise<void>; cancel: () => void } | null = null

  get sampleRate(): number {
    return TARGET_SAMPLE_RATE
  }

  /**
   * onEnded is called when the device goes away, because it was unplugged or the permission was
   * withdrawn. The capture then delivers nothing more, so the caller has to build it again.
   */
  start(onFrame: (frame: Float32Array) => void, onEnded: () => void): Promise<void> {
    if (this.ctx) return Promise.resolve()
    const generation = this.generation
    if (this.startOperation?.generation === generation) return this.startOperation.promise

    const controller = new AbortController()
    let finishCancelled!: () => void
    const cancelled = new Promise<void>((resolve) => { finishCancelled = resolve })
    const operation = {
      generation,
      promise: Promise.resolve(),
      cancel: () => {
        controller.abort()
        finishCancelled()
      }
    }
    // Neither getUserMedia nor addModule can be cancelled. The caller's wait ends at once, and
    // startOnce releases whatever arrives late, touching only its own generation.
    operation.promise = Promise.race([
      this.startOnce(generation, onFrame, onEnded, controller.signal), cancelled
    ]).finally(() => {
      if (this.startOperation === operation) this.startOperation = null
    })
    this.startOperation = operation
    return operation.promise
  }

  stop(): void {
    this.generation++
    this.startOperation?.cancel()
    this.startOperation = null
    const node = this.node
    const stream = this.stream
    const ctx = this.ctx
    this.node = null
    this.stream = null
    this.ctx = null
    this.release(node, stream, ctx)
  }

  /**
   * Every resource is built in a local variable and reaches the shared state only if the generation
   * is still the same at the end. When a restart overlaps a pending getUserMedia, the older call
   * releases its own stream and context and nothing else.
   */
  private async startOnce(
    generation: number,
    onFrame: (frame: Float32Array) => void,
    onEnded: () => void,
    signal: AbortSignal
  ): Promise<void> {
    let stream: MediaStream | null = null
    let ctx: AudioContext | null = null
    let node: AudioWorkletNode | null = null
    let source: MediaStreamAudioSourceNode | null = null
    const current = (): boolean => generation === this.generation
    const releasePending = (): void => {
      if (source) {
        try {
          source.disconnect()
        } catch {
          // The source is not connected, or is already disconnected.
        }
      }
      this.release(node, stream, ctx)
      source = null
      node = null
      stream = null
      ctx = null
    }
    signal.addEventListener('abort', releasePending, { once: true })

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      })
      if (!current()) return
      // Stopping a track does not fire ended, so only a device that goes away reaches onEnded.
      for (const track of stream.getTracks()) {
        track.addEventListener('ended', () => {
          if (current()) onEnded()
        }, { once: true })
      }

      // The context runs at the native rate, usually 44.1 kHz or 48 kHz.
      ctx = new AudioContext()
      const resampler = new StreamResampler(ctx.sampleRate, TARGET_SAMPLE_RATE)
      console.log(`mic capture: ${ctx.sampleRate}Hz → ${TARGET_SAMPLE_RATE}Hz`)

      const moduleUrl = URL.createObjectURL(
        new Blob([PROCESSOR_SOURCE], { type: 'application/javascript' })
      )
      try {
        await ctx.audioWorklet.addModule(moduleUrl)
      } finally {
        URL.revokeObjectURL(moduleUrl)
      }
      if (!current()) return

      source = ctx.createMediaStreamSource(stream)
      node = new AudioWorkletNode(ctx, 'pcm-processor')
      const committedNode = node
      node.port.onmessage = (event: MessageEvent<Float32Array>): void => {
        if (!current() || this.node !== committedNode) return
        const frame = resampler.process(event.data)
        if (frame.length > 0) onFrame(frame)
      }
      source.connect(node)
      if (!current()) return

      // Only one start runs per generation, so the three fields can be published together.
      this.stream = stream
      this.ctx = ctx
      this.node = node
      stream = null
      ctx = null
      node = null
      source = null
      // The node is never connected to the destination, so the microphone is not monitored aloud.
    } finally {
      signal.removeEventListener('abort', releasePending)
      releasePending()
    }
  }

  private release(
    node: AudioWorkletNode | null,
    stream: MediaStream | null,
    ctx: AudioContext | null
  ): void {
    if (node) {
      try {
        node.port.onmessage = null
        node.port.close()
      } catch {
        // A failure closing the port must not stop the stream and context from being released.
      }
      try {
        node.disconnect()
      } catch {
        // The node is not connected, or is already disconnected.
      }
    }
    for (const track of stream?.getTracks() ?? []) {
      try {
        track.stop()
      } catch {
        // One failing stop must not leave the remaining tracks held.
      }
    }
    if (ctx) {
      try {
        void ctx.close().catch(() => {})
      } catch {
        // An already closed context is fine; the other resources have been released by now.
      }
    }
  }
}
