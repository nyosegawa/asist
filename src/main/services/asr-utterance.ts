/** Longer regions drop more whole sentences with FastConformer on joined FLEURS ja clips (2026-10-08). */
export const MAX_RECOGNITION_SECONDS = 10

/** Splits only long audio, at the middle of its longest internal pause, without removing or repeating samples. */
export function splitRecognitionAudio(samples: Float32Array, sampleRate: number, maxSeconds = MAX_RECOGNITION_SECONDS): Float32Array[] {
  const limit = Math.floor(sampleRate * maxSeconds)
  if (samples.length <= limit) return [samples]
  // A 20 ms RMS window avoids mistaking a waveform's zero crossings for pauses; a pause is at or below -40 dBFS.
  const frame = Math.max(1, Math.round(sampleRate * 0.02))
  const pauses: Array<{ start: number; end: number }> = []
  let start: number | null = null
  for (let at = 0; at < samples.length; at += frame) {
    const end = Math.min(at + frame, samples.length)
    let energy = 0
    for (let i = at; i < end; i++) energy += samples[i] * samples[i]
    if (energy / (end - at) <= 0.01 ** 2) start ??= at
    else if (start !== null) {
      pauses.push({ start, end: at })
      start = null
    }
  }
  const parts: Float32Array[] = []
  const split = (first: number, last: number): void => {
    if (last - first <= limit) {
      parts.push(samples.subarray(first, last))
      return
    }
    let longest: (typeof pauses)[number] | undefined
    for (const pause of pauses) {
      if (pause.start <= first || pause.end >= last) continue
      if (!longest || pause.end - pause.start > longest.end - longest.start) longest = pause
    }
    // Continuous speech still has the same upper bound; neither leading nor trailing silence is an internal pause.
    const cut = longest ? Math.floor((longest.start + longest.end) / 2) : first + limit
    split(first, cut)
    split(cut, last)
  }
  split(0, samples.length)
  return parts
}

/** The Unicode blocks speech.cpp joins without spaces: Han, kana, CJK punctuation and full-width forms. */
const UNSPACED = /[\u2e80-\u2fdf\u3000-\u30ff\u31f0-\u33ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\u{1aff0}-\u{1b16f}\u{20000}-\u{323af}]/u

/** Joins recognition results with the same boundary spacing as speech.cpp's transcription by regions. */
export function appendTranscript(before: string, after: string): string {
  const left = before.trimEnd()
  const right = after.trimStart()
  if (!left) return right
  if (!right) return left
  const last = Array.from(left).at(-1)!
  const first = Array.from(right)[0]
  return left + (UNSPACED.test(last) || UNSPACED.test(first) ? '' : ' ') + right
}
