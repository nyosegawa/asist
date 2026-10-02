import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Protocol } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { errorKey } from '@shared/i18n/error-key'
import { HeldBytes } from '@/preview/audio/held-bytes'
import { mp4Samples, readMp4Track } from '@/preview/audio/mp4-samples'
import { afterId3, isInfoFrame, mpegFrames, type MpegFrame } from '@/preview/audio/mpeg-frames'
import { MAX_PEAKS, PeakTrack } from '@/preview/audio/peaks'
import { openRangedFile, PIECE_BYTES } from '@/preview/audio/ranged-file'
import { readWavFormat, wavPeak } from '@/preview/audio/wav'
import openAudio, { type WaveformAnswer } from '@/preview/methods/audio'
import { fileUrl, handleFileScheme } from '../src/main/file-protocol'
import { AAC_LC_CONFIG, adtsFrame, concat, id3Tag, mp3Frame, mp3Length, mp4File, wavFile, xingFrame } from './helpers/audio-files'
import { longTempFolder } from './helpers/temp'

/**
 * The waveform reader of the preview page: how it splits MP3 and ADTS into frames, reads an MPEG-4 file's sample
 * table, reads each WAV sample format, and how the audio document reads a file in pieces from its start and
 * reports the peaks in order. The file is served as asist-file answers a Range request, and the server records
 * the ranges it was asked for. WebCodecs is not in Node, so the MPEG tests give the page a decoder that turns each
 * frame into samples as loud as the frame's marker byte.
 */

const electron = vi.hoisted(() => ({ handle: vi.fn() }))
vi.mock('electron', () => ({ protocol: { registerSchemesAsPrivileged: vi.fn(), handle: electron.handle } }))

const URL = 'asist-file:///tmp/talk.mp3'

/** The ranges asked for, as [start, end) pairs, in the order they were asked for. */
let asked: Array<[number, number]> = []

function serve(file: Uint8Array): void {
  asked = []
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('range') ?? '')
    if (!range) throw new Error('the reader asks for ranges only')
    const start = Number(range[1])
    const end = Math.min(Number(range[2]), file.length - 1)
    if (start > end) return new Response(file.slice(), { status: 200 })
    asked.push([start, end + 1])
    return new Response(file.slice(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${file.length}` } })
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The pieces of `bytes` in the sizes given in turn, as a reader that is handed them one at a time sees them. */
async function* piecesOf(bytes: Uint8Array<ArrayBuffer>, sizes: number[]): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  for (let at = 0, i = 0; at < bytes.length; i++) {
    const size = sizes[i % sizes.length]
    yield bytes.slice(at, at + size)
    at += size
  }
}

async function framesOf(stream: Uint8Array<ArrayBuffer>, sizes = [stream.length], firstWithin = Infinity): Promise<MpegFrame[]> {
  const frames: MpegFrame[] = []
  for await (const frame of mpegFrames(new HeldBytes(piecesOf(stream, sizes), 0), firstWithin)) frames.push(frame)
  return frames
}

/** The marker each frame is filled with, which a frame that took in bytes of another holds at one end only. */
const markers = (frames: MpegFrame[]): number[] =>
  frames.map(({ header, bytes }) => {
    const first = bytes[header.codec === 'mp3' ? 4 : 7]
    return first === bytes[bytes.length - 1] ? first : NaN
  })

describe('splitting MP3 into frames', () => {
  it('takes every frame of a stream of variable bitrate whole, wherever the pieces it arrives in end', async () => {
    const kbps = [128, 160, 64, 320, 32, 192, 96, 128]
    const stream = concat(...kbps.map((rate, i) => mp3Frame(rate, i + 1, { padding: i % 2 })))
    for (const sizes of [[stream.length], [1], [5, 3, 417], [418]]) {
      const frames = await framesOf(stream, sizes)
      expect(markers(frames)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      expect(frames.map((frame) => frame.bytes.length)).toEqual(kbps.map((rate, i) => mp3Length(rate, i % 2)))
      expect(frames.map((frame) => frame.at)).toEqual(frames.map((_, i) => kbps.slice(0, i).reduce((sum, rate, k) => sum + mp3Length(rate, k % 2), 0)))
    }
  })

  it('tells a Xing frame, which holds no audio, from the frames that do', async () => {
    const stream = concat(xingFrame(3), mp3Frame(128, 1), mp3Frame(192, 2), mp3Frame(64, 3))
    const frames = await framesOf(stream)
    expect(frames.map(isInfoFrame)).toEqual([true, false, false, false])
  })

  it('passes over a frame cut short and takes the whole frames after it', async () => {
    const cut = mp3Frame(128, 3).subarray(0, 200)
    const stream = concat(mp3Frame(128, 1), mp3Frame(128, 2), cut, mp3Frame(128, 4), mp3Frame(128, 5))
    expect(markers(await framesOf(stream))).toEqual([1, 2, 4, 5])
    expect(markers(await framesOf(stream, [7]))).toEqual([1, 2, 4, 5])
  })

  it('takes no free-format frame, which the decoder refuses, so a stream in free format yields none', async () => {
    const header = mp3Frame(128, 1)
    header[2] = 0x00
    const stream = concat(...[1, 2, 3, 4].map((marker) => concat(header.subarray(0, 4), new Uint8Array(596).fill(marker))))
    expect(await framesOf(stream)).toEqual([])
  })

  it('passes over bytes that are no frame, with the frame they follow, which no frame confirms, and takes the last frame before a tag', async () => {
    const junk = Uint8Array.of(0xff, 0xfb, 0x90)
    const stream = concat(new Uint8Array(37).fill(0x20), mp3Frame(128, 1), mp3Frame(128, 2), junk, mp3Frame(128, 3), mp3Frame(128, 4), new TextEncoder().encode('TAG'), new Uint8Array(125))
    expect(markers(await framesOf(stream))).toEqual([1, 3, 4])
  })

  it('gives up on a file whose first frame is not within the bytes it may search', async () => {
    const stream = concat(new Uint8Array(5000), mp3Frame(128, 1), mp3Frame(128, 2))
    expect(await framesOf(stream, [1000], 4096)).toEqual([])
    expect(markers(await framesOf(stream, [1000], 8192))).toEqual([1, 2])
  })

  it('takes the frames of AAC in ADTS and their codec', async () => {
    const stream = concat(adtsFrame(300, 1), adtsFrame(371, 2), adtsFrame(280, 3))
    const frames = await framesOf(stream, [64])
    expect(markers(frames)).toEqual([1, 2, 3])
    expect(frames[0].header).toMatchObject({ codec: 'mp4a.40.2', sampleRate: 44_100, channels: 2, samples: 1024 })
  })

  it('counts the footer an ID3 tag says it has', async () => {
    const tagged = id3Tag(500)
    tagged[5] = 0x10
    const file = concat(tagged, new Uint8Array(10), mp3Frame(128, 1))
    expect(await afterId3(file.length, async (start, end) => file.slice(start, end))).toBe(520)
  })

  it('finds where the ID3 tags end from their headers alone', async () => {
    const file = concat(id3Tag(3000), id3Tag(100), mp3Frame(128, 1))
    const read = vi.fn(async (start: number, end: number) => file.slice(start, end))
    expect(await afterId3(file.length, read)).toBe(3010 + 110)
    expect(read.mock.calls).toEqual([
      [0, 10],
      [3010, 3020],
      [3120, 3130]
    ])
  })
})

describe('reading the sample table of an MPEG-4 file', () => {
  const sizes = [300, 310, 290, 305, 280, 315, 299, 301]
  const chunks = [3, 3, 2]

  it.each([
    { moovFirst: false, co64: false },
    { moovFirst: true, co64: true }
  ])('finds every sample of the sound track, its codec and its length (moov first: $moovFirst, 64-bit offsets: $co64)', async (layout) => {
    const { file, offsets } = mp4File({ sizes, chunks, ...layout })
    serve(file)
    const opened = await openRangedFile(URL)
    const track = (await readMp4Track(opened))!
    expect(track.config).toEqual({ codec: 'mp4a.40.2', description: AAC_LC_CONFIG, sampleRate: 44_100, numberOfChannels: 2 })
    expect([...track.offsets]).toEqual(offsets)
    expect([...track.sizes]).toEqual(sizes)
    expect(track.seconds).toBeCloseTo((8 * 1024) / 44_100)
    const samples = []
    for await (const sample of mp4Samples(track, opened)) samples.push(sample)
    expect(samples.map(({ bytes }) => [bytes.length, bytes[0]])).toEqual(sizes.map((size, i) => [size, i]))
    expect(samples.map(({ timestamp }) => timestamp)).toEqual(sizes.map((_, i) => Math.round(((i * 1024) / 44_100) * 1e6)))
  })

  it('reads the boxes in front of a moov box at the end by their headers, without reading the media data', async () => {
    const { file } = mp4File({ sizes: Array.from({ length: 600 }, () => 9000), chunks: Array.from({ length: 100 }, () => 6) })
    expect(file.length).toBeGreaterThan(PIECE_BYTES)
    serve(file)
    await readMp4Track(await openRangedFile(URL))
    const read = asked.reduce((sum, [start, end]) => sum + end - start, 0)
    expect(read - PIECE_BYTES).toBeLessThan(20_000)
  })

  it('takes a track of another codec, such as Apple Lossless, for one without a waveform', async () => {
    serve(mp4File({ sizes, chunks, entry: 'alac' }).file)
    expect(await readMp4Track(await openRangedFile(URL))).toBeNull()
  })

  it('says a file whose samples run past its end is damaged', async () => {
    const { file } = mp4File({ sizes, chunks, moovFirst: true })
    serve(file.subarray(0, file.length - 100))
    await expect(readMp4Track(await openRangedFile(URL))).rejects.toThrow(errorKey('files.errors.audioDamaged'))
  })
})

describe('reading the samples of a WAV file', () => {
  const peakOf = async (file: Uint8Array<ArrayBuffer>, frames: number): Promise<number> => {
    serve(file)
    const format = (await readWavFormat(await openRangedFile(URL)))!
    return wavPeak(file, format.dataStart, frames, format)
  }

  it.each([
    { bits: 16, channels: 2 },
    { bits: 16, channels: 1 },
    { bits: 24, channels: 1 },
    { bits: 24, channels: 2, extensible: true },
    { bits: 32, channels: 2 },
    { bits: 8, channels: 1 },
    { bits: 32, channels: 2, float: true },
    { bits: 32, channels: 1, float: true, extensible: true }
  ] as const)('reads $bits-bit samples of $channels channels (float: $float, extensible: $extensible)', async (samples) => {
    const format = { sampleRate: 22_050, ...samples }
    // The loudest sample is the second channel's in a stereo file, and negative.
    const file = wavFile(format, 100, (frame, channel) => (frame === 40 ? (channel === samples.channels - 1 ? -0.75 : 0.5) : 0.1))
    serve(file)
    const read = (await readWavFormat(await openRangedFile(URL)))!
    expect(read).toMatchObject({ channels: samples.channels, sampleRate: 22_050, blockAlign: (samples.bits / 8) * samples.channels, dataEnd: file.length })
    // Eight bits hold the amplitude to within 1/128.
    const digits = samples.bits === 8 ? 1 : 2
    expect(await peakOf(file, 100)).toBeCloseTo(0.75, digits)
    expect(await peakOf(file, 40)).toBeCloseTo(0.1, digits)
  })

  it('takes the data to the end of the file when its size was never written, as a recorder that stopped leaves it', async () => {
    const file = wavFile({ bits: 16, channels: 2, sampleRate: 8000 }, 50, () => 0.5)
    new DataView(file.buffer).setUint32(40, 0, true)
    serve(concat(file, Uint8Array.of(1)))
    expect(await readWavFormat(await openRangedFile(URL))).toMatchObject({ dataStart: 44, dataEnd: 44 + 200 })
  })

  it.each([
    // The silent and the loudest codes of µ-law and A-law, and a code of segment 5, as ITU-T G.711 expands them.
    { tag: 7, codes: [0xff, 0x7f, 0x00], peak: 32_124 / 32_768 },
    { tag: 7, codes: [0xff, 0xa0], peak: 7_932 / 32_768 },
    { tag: 6, codes: [0xd5, 0x55, 0xaa], peak: 32_256 / 32_768 },
    { tag: 6, codes: [0xd5, 0x0a], peak: 8_064 / 32_768 }
  ])('reads telephone recordings in law $tag', async ({ tag, codes, peak }) => {
    const file = wavFile({ bits: 8, channels: 1, sampleRate: 8000 }, codes.length, () => 0)
    new DataView(file.buffer).setUint16(20, tag, true)
    file.set(codes, 44)
    serve(file)
    const format = (await readWavFormat(await openRangedFile(URL)))!
    expect(wavPeak(file, format.dataStart, codes.length, format)).toBeCloseTo(peak, 5)
  })

  it('takes the data to the end of the file when its size is 0xFFFFFFFF, as a writer that streams leaves it', async () => {
    const file = wavFile({ bits: 16, channels: 1, sampleRate: 8000 }, 50, () => 0.5)
    new DataView(file.buffer).setUint32(40, 0xffffffff, true)
    serve(file)
    expect(await readWavFormat(await openRangedFile(URL))).toMatchObject({ dataStart: 44, dataEnd: 144 })
  })

  it('takes the length of the data of an RF64 file from its ds64 chunk, and not the chunks after it', async () => {
    const data = wavFile({ bits: 16, channels: 2, sampleRate: 8000 }, 60, () => 0.5).subarray(44)
    const head = new Uint8Array(12 + 36 + 24 + 8)
    const view = new DataView(head.buffer)
    head.set(new TextEncoder().encode('RF64'), 0)
    view.setUint32(4, 0xffffffff, true)
    head.set(new TextEncoder().encode('WAVEds64'), 8)
    view.setUint32(16, 28, true)
    view.setBigUint64(28, BigInt(data.length), true)
    head.set(new TextEncoder().encode('fmt '), 48)
    view.setUint32(52, 16, true)
    view.setUint16(56, 1, true)
    view.setUint16(58, 2, true)
    view.setUint32(60, 8000, true)
    view.setUint32(64, 32_000, true)
    view.setUint16(68, 4, true)
    view.setUint16(70, 16, true)
    head.set(new TextEncoder().encode('data'), 72)
    view.setUint32(76, 0xffffffff, true)
    // A chunk after the samples, which the data runs into when its length is taken to the end of the file.
    const after = concat(new TextEncoder().encode('LIST'), Uint8Array.of(4, 0, 0, 0), new Uint8Array(4).fill(0x7f))
    serve(concat(head, data, after))
    expect(await readWavFormat(await openRangedFile(URL))).toMatchObject({ channels: 2, dataStart: 80, dataEnd: 80 + data.length })
  })

  it('reads no samples it cannot read, such as ADPCM, and says so', async () => {
    const file = wavFile({ bits: 8, channels: 1, sampleRate: 8000 }, 10, () => 0)
    new DataView(file.buffer).setUint16(20, 2, true)
    serve(file)
    expect(await readWavFormat(await openRangedFile(URL))).toBeNull()
  })
})

describe('the peaks of a recording', () => {
  /** A track at one frame a second, given one peak a frame. */
  const trackOf = (peaks: number[], sampleRate = 1): PeakTrack => {
    const track = new PeakTrack(sampleRate)
    for (const peak of peaks) track.add(peak, 1)
    return track
  }
  const bars = (track: PeakTrack, count: number, seconds: number): number[] => [...track.bars(count, seconds)].map((height) => Math.round(height * 1000) / 1000)

  it('holds a recording of any length in at most MAX_PEAKS peaks, keeping the loudest of each stretch where it was', () => {
    const track = new PeakTrack(44_100)
    // An hour, quiet but for one loud second, 2,000 seconds in, added as many frames at a time as the track takes.
    const loud = [2000 * 44_100, 2001 * 44_100]
    for (let frame = 0; frame < 3600 * 44_100; ) {
      const end = frame < loud[0] ? loud[0] : frame < loud[1] ? loud[1] : 3600 * 44_100
      const take = Math.min(track.room, end - frame)
      track.add(frame >= loud[0] && frame < loud[1] ? 0.9 : 0.1, take)
      frame += take
    }
    track.end()
    expect(track.peaks).toBeLessThanOrEqual(MAX_PEAKS)
    expect(track.peaks).toBeGreaterThan(MAX_PEAKS / 2)
    // 400 bars of 9 seconds: the loud second is in bar 222.
    const heights = bars(track, 400, 3600)
    expect(heights).toHaveLength(400)
    expect(heights.filter((height) => height === 1)).toHaveLength(1)
    expect(heights.indexOf(1)).toBe(222)
    expect(heights.filter((height) => height !== 1).every((height) => Math.abs(height - 0.1 / 0.9) < 0.001)).toBe(true)
  })

  it('takes the largest peak within each bar and scales the largest bar to 1', () => {
    expect(bars(trackOf([0.1, 0.5, 0.2, 0.8]), 2, 4)).toEqual([0.625, 1])
    expect(bars(trackOf([0, 0, 0, 0]), 2, 4)).toEqual([0, 0])
  })

  it('gives only the bars the peaks read so far reach, while the recording is still read', () => {
    expect(bars(trackOf([0.2, 0.4]), 10, 10)).toEqual([0.5, 1])
    expect(bars(trackOf([0.2, 0.4, 0.1]), 4, 10)).toEqual([1, 0.25])
    expect(bars(trackOf([]), 10, 10)).toEqual([])
  })

  it('gives each bar narrower than a peak the peak it starts in', () => {
    expect(bars(trackOf([0.5, 1], 0.5), 4, 4)).toEqual([0.5, 0.5, 1, 1])
  })

  it('draws a recording longer than it was told to the end of its peaks', () => {
    expect(bars(trackOf([0.2, 0.4, 0.6, 0.8]), 2, 2)).toEqual([0.5, 1])
  })
})

type Drawn = Extract<WaveformAnswer, { supported: true }>

/** Asks the document for the waveform until it is done, as a viewer does, and keeps every answer. */
async function answers(document: Awaited<ReturnType<typeof openAudio>>, count = 400): Promise<WaveformAnswer[]> {
  const all: WaveformAnswer[] = []
  let after = 0
  for (;;) {
    const answer = await document.methods.waveform({ bars: count, after })
    all.push(answer)
    if (!answer.supported || answer.done) return all
    after = answer.version
  }
}

describe('the audio document', () => {
  it('reads a WAV file once from its start in pieces and draws it from its start as it is read', async () => {
    // 4,000,000 frames of 24-bit stereo, 24 MB, whose loudness rises over the recording: a piece ends inside a frame.
    const frames = 4_000_000
    const file = wavFile({ bits: 24, channels: 2, sampleRate: 48_000 }, frames, (frame, channel) => (channel === 1 ? frame / frames : 0) * (frame % 2 ? 1 : -1))
    serve(file)
    const document = await openAudio(URL)
    const all = (await answers(document)) as Drawn[]
    document.close?.()

    expect(asked).toEqual(Array.from({ length: Math.ceil(file.length / PIECE_BYTES) }, (_, i) => [i * PIECE_BYTES, Math.min(file.length, (i + 1) * PIECE_BYTES)]))
    expect(all.length).toBeGreaterThan(1)
    // Each answer draws more of the recording, from its start: bars that rise, as the recording does.
    for (const [i, answer] of all.entries()) {
      if (i > 0) expect(answer.bars.length).toBeGreaterThanOrEqual(all[i - 1].bars.length)
      expect(answer.seconds).toBeCloseTo(frames / 48_000)
      expect(answer.bars.every((height, b) => b === 0 || height > answer.bars[b - 1])).toBe(true)
    }
    const last = all.at(-1)!
    expect(last.done).toBe(true)
    expect(last.bars).toHaveLength(400)
    // The loudest frame of each bar is its last one.
    expect([...last.bars].every((height, b) => Math.abs(height - (b + 1) / 400) < 1e-3)).toBe(true)
  })

  it('reads a file through the asist-file scheme itself', async () => {
    const folder = longTempFolder('asist-audio-')
    try {
      handleFileScheme({ handle: electron.handle } as unknown as Protocol, () => [folder])
      const handler = electron.handle.mock.calls.at(-1)![1] as (request: { url: string; headers: Headers }) => Response
      vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => handler({ url, headers: new Headers(init?.headers) }))
      const target = path.join(folder, 'memo.wav')
      writeFileSync(target, wavFile({ bits: 16, channels: 1, sampleRate: 16_000 }, 3_000_000, (frame) => (frame === 2_999_999 ? 1 : 0.25)))
      const last = (await answers(await openAudio(fileUrl(target)))).at(-1) as Drawn
      expect(last.bars).toHaveLength(400)
      expect(last.bars.at(-1)).toBeCloseTo(1, 3)
      expect(last.bars[0]).toBeCloseTo(0.25, 3)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  it.each([
    { saved: 'at another length', length: 4, etag: '"saved"' },
    { saved: 'at the same length', length: 0, etag: '"saved"' }
  ])('says the file changed when a later piece comes from the file saved $saved', async ({ length, etag }) => {
    const file = wavFile({ bits: 16, channels: 2, sampleRate: 44_100 }, 2_000_000, () => 0.5)
    serve(file)
    const fetchFile = globalThis.fetch
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const response = await fetchFile(url, init)
      const range = response.headers.get('Content-Range')!
      if (range.startsWith('bytes 0-')) return new Response(await response.arrayBuffer(), { status: 206, headers: { 'Content-Range': range, ETag: '"first"' } })
      return new Response(await response.arrayBuffer(), { status: 206, headers: { 'Content-Range': range.replace(/\/\d+$/, `/${file.length + length}`), ETag: etag } })
    })
    const document = await openAudio(URL)
    expect(document.version).toBe(JSON.stringify([file.length, '"first"']))
    await expect(answers(document)).rejects.toThrow(errorKey('files.errors.changedWhileReading'))
  })

  it('stops reading once it is closed, and fails the request still waiting', async () => {
    serve(wavFile({ bits: 16, channels: 2, sampleRate: 44_100 }, 6_000_000, () => 0.5))
    // Each piece takes a while to come, as a file on a slow disk does, and a request stopped meanwhile is not answered.
    const fetchFile = globalThis.fetch
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      return fetchFile(url, init)
    })
    const document = await openAudio(URL)
    const first = (await document.methods.waveform({ bars: 400, after: 0 })) as Drawn
    const waiting = document.methods.waveform({ bars: 400, after: first.version })
    document.close?.()
    await expect(waiting).rejects.toThrow(errorKey('files.errors.previewStopped'))
    const read = asked.length
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(asked.length).toBe(read)
    expect(read).toBeLessThan(Math.ceil((6_000_000 * 4) / PIECE_BYTES))
  })

  it('fails a request made before anything was read when the document closes', async () => {
    serve(wavFile({ bits: 16, channels: 2, sampleRate: 44_100 }, 1000, () => 0.5))
    const document = await openAudio(URL)
    const waiting = document.methods.waveform({ bars: 400, after: 0 })
    document.close?.()
    await expect(waiting).rejects.toThrow(errorKey('files.errors.previewStopped'))
  })

  it('says a file that is no recording it reads, such as FLAC, gets no waveform', async () => {
    serve(concat(new TextEncoder().encode('fLaC'), new Uint8Array(100_000).fill(0x12)))
    expect(await answers(await openAudio(URL))).toEqual([{ supported: false }])
  })
})

describe('the audio document with the decoder', () => {
  /** A decoder the page made: what it was configured with, the chunks it holds, and what it decoded. */
  interface FakeDecoder {
    config: AudioDecoderConfig | null
    queue: Uint8Array[]
    decoded: number[]
    state: string
    decodeQueueSize: number
    release(count: number): void
  }
  let decoders: FakeDecoder[]
  let supported: (config: AudioDecoderConfig) => boolean
  let failAt: number | null
  /** Whether the decoders decode as they are given chunks, or only when a test releases them. */
  let holding: boolean

  beforeEach(() => {
    decoders = []
    supported = () => true
    failAt = null
    holding = false
    vi.stubGlobal(
      'EncodedAudioChunk',
      class {
        readonly data: Uint8Array
        readonly timestamp: number
        constructor(init: { data: Uint8Array; timestamp: number }) {
          this.data = init.data.slice()
          this.timestamp = init.timestamp
        }
      }
    )
    vi.stubGlobal(
      'AudioDecoder',
      class extends EventTarget implements FakeDecoder {
        static isConfigSupported = async (config: AudioDecoderConfig) => ({ supported: supported(config), config })
        config: AudioDecoderConfig | null = null
        queue: Uint8Array[] = []
        decoded: number[] = []
        state = 'unconfigured'
        decodeQueueSize = 0
        constructor(private readonly init: { output: (data: unknown) => void; error: (error: Error) => void }) {
          super()
          decoders.push(this)
        }
        configure(config: AudioDecoderConfig): void {
          this.config = config
          this.state = 'configured'
        }
        decode(chunk: { data: Uint8Array }): void {
          if (this.state !== 'configured') throw new Error(`InvalidStateError: decode on a decoder ${this.state}`)
          this.queue.push(chunk.data)
          this.decodeQueueSize++
          if (!holding) setTimeout(() => this.release(1))
        }
        /** Decodes the first `count` chunks held, each to a frame's samples of two channels, as loud as its marker. */
        release(count: number): void {
          for (const data of this.queue.splice(0, count)) {
            this.decodeQueueSize--
            this.dispatchEvent(new Event('dequeue'))
            if (this.state === 'closed') return
            const marker = data[data.length - 1]
            if (marker === failAt) {
              this.state = 'closed'
              this.init.error(new Error('EncodingError'))
              return
            }
            this.decoded.push(marker)
            const frames = this.config?.codec === 'mp3' ? 1152 : 1024
            this.init.output({
              sampleRate: 44_100,
              numberOfFrames: frames,
              numberOfChannels: 2,
              copyTo: (plane: Float32Array, { planeIndex }: { planeIndex: number }) => plane.fill(planeIndex === 0 ? marker / 100 : 0, 0, frames),
              close: () => undefined
            })
          }
        }
        async flush(): Promise<void> {
          this.release(this.queue.length)
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        close(): void {
          this.state = 'closed'
        }
      }
    )
  })

  const until = async (condition: () => boolean): Promise<void> => {
    await vi.waitFor(() => {
      if (!condition()) throw new Error('not yet')
    })
  }

  it('decodes the frames of an MP3 after its tags in order, without its Xing frame, and draws one bar a frame', async () => {
    const markers = Array.from({ length: 40 }, (_, i) => i + 1)
    serve(concat(id3Tag(2048), xingFrame(40), ...markers.map((marker) => mp3Frame(128, marker))))
    const last = (await answers(await openAudio(URL), 40)).at(-1) as Drawn
    expect(decoders.map((decoder) => decoder.config)).toEqual([{ codec: 'mp3', sampleRate: 44_100, numberOfChannels: 2 }])
    expect(decoders[0].decoded).toEqual(markers)
    expect(last.seconds).toBeCloseTo((40 * 1152) / 44_100)
    // A bar a frame, as loud as the frame's marker, scaled so that the loudest, 40, is 1.
    expect([...last.bars].map((height) => Math.round(height * 40))).toEqual(markers)
  })

  it('gives the decoder no more than 64 chunks ahead of what it has decoded, and closes it when the document closes', async () => {
    holding = true
    serve(concat(...Array.from({ length: 300 }, (_, i) => mp3Frame(128, (i % 90) + 1))))
    const document = await openAudio(URL)
    await until(() => decoders[0]?.decodeQueueSize === 64)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(decoders[0].decodeQueueSize).toBe(64)
    decoders[0].release(10)
    await until(() => decoders[0].decodeQueueSize === 64 && decoders[0].queue.length === 64)
    expect(decoders[0].decoded).toHaveLength(10)

    const first = (await document.methods.waveform({ bars: 400, after: 0 })) as Drawn
    const waiting = document.methods.waveform({ bars: 400, after: first.version })
    document.close?.()
    await expect(waiting).rejects.toThrow(errorKey('files.errors.previewStopped'))
    await until(() => decoders[0].state === 'closed')
  })

  it.each([
    { name: 'a Xing frame that counts no frames, as ffmpeg stopped partway leaves it', head: [xingFrame(0)] },
    { name: 'a Xing frame that counts far fewer frames, as a short jingle joined to a long recording keeps it', head: [xingFrame(5)] },
    { name: 'a first ADTS frame of a few bytes of silence, as afconvert writes it', head: [adtsFrame(13, 1)] }
  ])('tells the length of a stream from the bytes read, not from $name', async ({ head }) => {
    holding = true
    const adts = head[0][1] === 0xf1
    const frames = Array.from({ length: 2000 }, (_, i) => (adts ? adtsFrame(371, (i % 90) + 1) : mp3Frame(128, (i % 90) + 1)))
    serve(concat(...head, ...frames))
    const document = await openAudio(URL)
    await until(() => decoders[0]?.decodeQueueSize === 64)
    decoders[0].release(20)
    const answer = (await document.methods.waveform({ bars: 400, after: 0 })) as Drawn
    const samples = adts ? 1024 : 1152
    const seconds = (2000 * samples) / 44_100
    expect(answer.seconds / seconds).toBeGreaterThan(0.95)
    expect(answer.seconds / seconds).toBeLessThan(1.05)
    // The bars reach as far into the width as the frames decoded are into the stream.
    expect(Math.abs(answer.bars.length - (20 / 2000) * 400)).toBeLessThanOrEqual(1)
    holding = false
    decoders[0].release(decoders[0].queue.length)
    const last = (await answers(document)).at(-1) as Drawn
    expect(last.bars).toHaveLength(400)
    // The silent ADTS frame is audio and is decoded; a Xing frame is not.
    expect(last.seconds).toBeCloseTo(((adts ? 2001 : 2000) * samples) / 44_100)
  })

  it('reads an ID3 tag larger than a piece by its header alone', async () => {
    const tag = id3Tag(5 * 1024 * 1024)
    const markers = Array.from({ length: 30 }, (_, i) => i + 1)
    serve(concat(tag, ...markers.map((marker) => mp3Frame(128, marker))))
    await answers(await openAudio(URL))
    expect(decoders[0].decoded).toEqual(markers)
    // Past the first piece, only the bytes after the tag are asked for.
    expect(asked.slice(1).every(([start]) => start >= tag.length)).toBe(true)
  })

  it('says a recording whose codec the decoder does not take gets no waveform', async () => {
    supported = () => false
    serve(concat(...[1, 2, 3].map((marker) => adtsFrame(400, marker))))
    expect(await answers(await openAudio(URL))).toEqual([{ supported: false }])
    expect(decoders).toEqual([])
  })

  it('fails the waveform with the error the viewer shows when the decoder fails on a frame', async () => {
    failAt = 3
    serve(concat(...[1, 2, 3, 4].map((marker) => mp3Frame(128, marker))))
    await expect(answers(await openAudio(URL))).rejects.toThrow(errorKey('files.errors.audioDamaged'))
  })
})
