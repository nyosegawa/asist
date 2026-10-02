import { HeldBytes } from '../audio/held-bytes'
import { mp4Samples, readMp4Track } from '../audio/mp4-samples'
import { errorKey } from '@shared/i18n/error-key'
import { afterId3, isInfoFrame, mpegFrames } from '../audio/mpeg-frames'
import { PeakTrack } from '../audio/peaks'
import { audioDamaged, openRangedFile, type RangedFile } from '../audio/ranged-file'
import { isWav, readWavFormat, wavPeak } from '../audio/wav'
import type { Bytes } from '../fetch-range'
import type { OpenPreviewDocument } from '../serve'

/**
 * The waveform of a recording, built as the file is read from its start a piece at a time, so that what it holds
 * stays the same however long the recording is: WAV from its samples, and MP3, AAC in ADTS and AAC in MPEG-4
 * decoded a frame at a time by WebCodecs' AudioDecoder. The viewers ask for the peaks again and again, each time
 * from where they have got to, and draw them as they come. Opening the document starts the reading, which goes
 * on until the end of the file or until the document is closed.
 */

/** What a viewer is told each time it asks for the waveform. */
export type WaveformAnswer =
  /** The file is none whose waveform is drawn here, or its codec is one the decoder does not take. */
  | { supported: false }
  | {
      supported: true
      /**
       * The heights of the bars of the part decoded so far, from 0 to 1, as many as the viewer asked for once the
       * whole recording is decoded.
       */
      bars: Float32Array
      /** How long the recording is: as far as can be told while it is read, and as decoded once `done`. */
      seconds: number
      /** What the viewer gives back to be answered once there is more. */
      version: number
      done: boolean
    }

/**
 * How long an answer after the first waits to gather more peaks. A viewer asks again as soon as it is answered,
 * so without it the viewer would be answered and would draw again for every frame decoded.
 */
const GATHER_MS = 100
/** How far past its tags an MPEG stream's first frame may lie. A file with none so far is taken for no MPEG audio. */
const FIRST_FRAME_WITHIN = 64 * 1024
/** How many chunks the decoder is given ahead of what it has decoded. */
const DECODE_AHEAD = 64

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

class Waveform {
  track: PeakTrack | null = null
  /** How long the recording is, as far as can be told from what has been read so far. */
  estimate: () => number = () => 0
  private version = 0
  private state: 'reading' | 'done' | 'unsupported' | 'failed' = 'reading'
  private error: unknown = null
  private waiting: Array<() => void> = []

  /** Adds the decoded frames, each channel copied into its own buffer, which `planes` keeps for the next. */
  addDecoded(data: AudioData, planes: Float32Array[]): void {
    this.track ??= new PeakTrack(data.sampleRate)
    const frames = data.numberOfFrames
    for (let c = 0; c < data.numberOfChannels; c++) {
      if (!planes[c] || planes[c].length < frames) planes[c] = new Float32Array(frames)
      data.copyTo(planes[c], { planeIndex: c, format: 'f32-planar' })
    }
    this.track.addChannels(planes, data.numberOfChannels, frames)
    this.changed()
  }

  changed(): void {
    this.version++
    for (const resolve of this.waiting.splice(0)) resolve()
  }

  unsupported(): void {
    this.settle('unsupported')
  }

  end(): void {
    this.track?.end()
    this.settle('done')
  }

  fail(error: unknown): void {
    this.error = error
    this.settle('failed')
  }

  /** The waveform `bars` wide, once it has changed since `after`, the version of the last answer. */
  async answer(bars: number, after: number): Promise<WaveformAnswer> {
    while (this.state === 'reading' && this.version <= after) await new Promise<void>((resolve) => this.waiting.push(resolve))
    // The first answer goes at once, so that the first peaks are drawn as soon as they are decoded.
    if (after > 0 && this.state === 'reading') await sleep(GATHER_MS)
    if (this.state === 'failed') throw this.error
    if (this.state === 'unsupported') return { supported: false }
    const done = this.state === 'done'
    const track = this.track
    const seconds = done ? (track?.seconds ?? 0) : this.estimate()
    return { supported: true, bars: track?.bars(bars, seconds) ?? new Float32Array(0), seconds, version: this.version, done }
  }

  private settle(state: 'done' | 'unsupported' | 'failed'): void {
    if (this.state !== 'reading') return
    this.state = state
    this.changed()
  }
}

interface Chunk {
  bytes: Bytes
  /** In microseconds. */
  timestamp: number
}

/**
 * Decodes the chunks in order and adds what comes out to the waveform, giving the decoder no more than
 * DECODE_AHEAD chunks ahead of its output. False when the decoder does not take the configuration.
 */
async function decodeInto(config: AudioDecoderConfig, chunks: AsyncIterable<Chunk>, waveform: Waveform, signal: AbortSignal): Promise<boolean> {
  // A configuration the decoder cannot even read was made from a file whose header is wrong.
  const { supported } = await AudioDecoder.isConfigSupported(config).catch(() => {
    throw audioDamaged()
  })
  if (!supported) return false
  let failed = false
  let wake = (): void => undefined
  const planes: Float32Array[] = []
  const decoder = new AudioDecoder({
    output: (data) => {
      try {
        waveform.addDecoded(data, planes)
      } finally {
        data.close()
      }
    },
    error: () => {
      failed = true
      wake()
    }
  })
  decoder.addEventListener('dequeue', () => wake())
  signal.addEventListener('abort', () => wake(), { once: true })
  decoder.configure(config)
  try {
    for await (const chunk of chunks) {
      while (decoder.decodeQueueSize >= DECODE_AHEAD && !failed && !signal.aborted) await new Promise<void>((resolve) => (wake = resolve))
      if (failed || signal.aborted) break
      decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: chunk.timestamp, data: chunk.bytes }))
    }
    // A decoder that fails while it flushes rejects the flush as well as calling its error callback.
    if (!failed && !signal.aborted) await decoder.flush().catch(() => undefined)
  } finally {
    if (decoder.state !== 'closed') decoder.close()
  }
  if (failed) throw audioDamaged()
  return true
}

async function buildWav(file: RangedFile, waveform: Waveform, signal: AbortSignal): Promise<void> {
  const format = await readWavFormat(file)
  if (!format) return waveform.unsupported()
  const { dataStart, dataEnd, blockAlign, sampleRate } = format
  const seconds = (dataEnd - dataStart) / blockAlign / sampleRate
  waveform.estimate = () => seconds
  const track = (waveform.track = new PeakTrack(sampleRate))
  const held = new HeldBytes(file.pieces(dataStart, dataEnd), dataStart)
  try {
    for (let at = dataStart; at < dataEnd && !signal.aborted; ) {
      let frames = Math.floor((held.end - at) / blockAlign)
      if (frames === 0) {
        if (!(await held.more(at))) throw audioDamaged()
        continue
      }
      for (let i = at - held.start; frames > 0; ) {
        const take = Math.min(track.room, frames)
        track.add(wavPeak(held.bytes, i, take, format), take)
        i += take * blockAlign
        at += take * blockAlign
        frames -= take
      }
      waveform.changed()
    }
  } finally {
    await held.close()
  }
}

async function* withFirst<T>(first: T, rest: AsyncIterable<T>): AsyncGenerator<T> {
  yield first
  yield* rest
}

async function buildMpeg(file: RangedFile, waveform: Waveform, signal: AbortSignal): Promise<void> {
  const start = await afterId3(file.size, file.read)
  const held = new HeldBytes(file.pieces(start, file.size), start)
  const frames = mpegFrames(held, FIRST_FRAME_WITHIN)
  try {
    const first = await frames.next()
    if (first.done) return waveform.unsupported()
    const { header, at: audioStart } = first.value
    // The stream's length is told from the frames given to the decoder so far: their samples, stretched by the
    // part of the file their bytes are. Neither a header nor the first frame is trusted for it: ffmpeg stopped
    // partway leaves a Xing frame that counts no frames, a short jingle joined to a long recording keeps the
    // jingle's count, a file downloaded in part keeps the whole one's, and the first frame of an AAC stream is
    // often a few bytes of silence (13 from afconvert), which would make an hour of a minute.
    let samples = 0
    let bytes = 0
    waveform.estimate = () => (bytes > 0 ? (samples / header.sampleRate) * ((file.size - audioStart) / bytes) : 0)
    async function* chunks(): AsyncGenerator<Chunk> {
      const timestamp = (): number => Math.round((samples / header.sampleRate) * 1e6)
      // A Xing, Info or VBRI frame holds no audio.
      for await (const frame of isInfoFrame(first.value) ? frames : withFirst(first.value, frames)) {
        yield { bytes: frame.bytes, timestamp: timestamp() }
        samples += frame.header.samples
        bytes += frame.bytes.length
      }
    }
    const config = { codec: header.codec, sampleRate: header.sampleRate, numberOfChannels: header.channels }
    if (!(await decodeInto(config, chunks(), waveform, signal))) waveform.unsupported()
  } finally {
    await frames.return(undefined)
    await held.close()
  }
}

async function buildMp4(file: RangedFile, waveform: Waveform, signal: AbortSignal): Promise<void> {
  const track = await readMp4Track(file)
  if (!track) return waveform.unsupported()
  waveform.estimate = () => track.seconds
  if (!(await decodeInto(track.config, mp4Samples(track, file), waveform, signal))) waveform.unsupported()
}

async function build(url: string, waveform: Waveform, signal: AbortSignal): Promise<void> {
  const file = await openRangedFile(url, signal)
  const head = await file.read(0, Math.min(file.size, 12))
  if (isWav(head)) return buildWav(file, waveform, signal)
  if (String.fromCharCode(...head.subarray(4, 8)) === 'ftyp') return buildMp4(file, waveform, signal)
  return buildMpeg(file, waveform, signal)
}

const openAudio = async (url: string) => {
  const waveform = new Waveform()
  const stop = new AbortController()
  void build(url, waveform, stop.signal).then(
    () => waveform.end(),
    (error: unknown) => waveform.fail(error)
  )
  return {
    methods: {
      waveform: ({ bars, after }: { bars: number; after: number }): Promise<WaveformAnswer> => waveform.answer(bars, after)
    },
    // Closing stops the reading and fails every request still waiting, so that none of them stays open in the page
    // and in the viewers' client.
    close: () => {
      stop.abort()
      waveform.fail(new Error(errorKey('files.errors.previewStopped')))
    }
  }
}

export default openAudio satisfies OpenPreviewDocument
