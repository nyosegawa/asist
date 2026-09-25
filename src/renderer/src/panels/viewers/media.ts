/** Renders "0:03", "12:05" or "1:02:03", and "0:00" while the duration is unknown. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/**
 * Splits the samples of every channel into buckets and returns the peak amplitude of each, from 0 to 1. The
 * peaks are normalized so that the largest becomes 1, which keeps a quiet recording visible.
 */
export function downsampleWaveform(channels: readonly Float32Array[], buckets: number): number[] {
  if (channels.length === 0 || buckets <= 0) return []
  const length = channels[0].length
  if (length === 0) return new Array(buckets).fill(0)
  const peaks = new Array<number>(buckets).fill(0)
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor((b * length) / buckets)
    const end = Math.max(start + 1, Math.floor(((b + 1) * length) / buckets))
    let peak = 0
    for (const channel of channels) {
      for (let i = start; i < end && i < channel.length; i++) {
        const v = Math.abs(channel[i])
        if (v > peak) peak = v
      }
    }
    peaks[b] = peak
  }
  const max = Math.max(...peaks)
  return max > 0 ? peaks.map((p) => p / max) : peaks
}
