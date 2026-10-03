/**
 * Long recordings, whose waveform the preview page builds while it reads the file from its start, and which the card
 * draws as the bars come. The content counts as shown once the first bars are drawn, rather than when the flat line
 * the card draws before them is. The card is complete once the whole waveform is drawn: all 400 bars, covering as
 * long a recording as <audio> plays, with bars of sound in every eighth of the width rather than a flat line; a
 * waveform that ends otherwise never completes, and the case fails when its time runs out. The budget gives a
 * two-hour recording 20 s to complete and a one-hour one 10 s. The limits are 90 s for the MP3, 45 s for the m4a
 * and 10 s for the WAV, two and a half to three times the slowest of 32 or 33 runs on GitHub's macOS runner on
 * 2026-10-02 and 03 (18.5 to 38.6 s, 6.4 to 17.7 s and 1.5 to 3.6 s), so that a reader several times slower fails.
 * The viewer before this one decoded the whole file at once and drew everything after 15.6 s for the MP3 and 4.6 s
 * for the WAV on the M5, which its first content and its memory fail rather than these. The memory includes the
 * preview page's frame, which in headless Chrome holds about 160 MB with a five-second WAV open, and stays while
 * the card shows the recording.
 *
 * In one run each on an M5 under a load average of 42 to 63 on 2026-10-03, the card drew its first bars in 295 to
 * 395 ms and its whole waveform in 11.0 s for the two-hour MP3, 3.8 s for the one-hour m4a and 5.8 s for the one-hour
 * WAV, held the page for at most 21 ms, and grew the renderers by 230 to 253 MB at the peak and 87 to 166 MB at the
 * end. On CI the two-hour MP3 took 32.7 and 36.3 s to complete (2026-10-02).
 */
const budget = { cardFirstMs: 1000, cardHeldMs: 150, focusFirstMs: 1000, focusHeldMs: 150, peakMb: 400, finalMb: 300, gpuPeakMb: 100 }

export const cases = [
  ['mp3-2h', 20_000, 90_000],
  ['m4a-1h', 10_000, 45_000],
  ['wav-1h', 10_000, 10_000]
].map(([file, completeMs, limitMs]) => ({
  name: file,
  file,
  shown: (root) => ['drawing', 'ready'].includes(root.querySelector('.fv-media-wave')?.getAttribute('data-state')),
  complete: (root) => {
    const wave = root.querySelector('.fv-media-wave')
    const audio = root.querySelector('audio')
    if (wave?.getAttribute('data-state') !== 'ready' || wave.getAttribute('data-bars') !== '400' || !(audio?.duration > 0)) return false
    if (Math.abs(Number(wave.getAttribute('data-seconds')) - audio.duration) > audio.duration * 0.01) return false
    // A bar of sound reaches the top quarter of the canvas, which the flat line in the middle never does.
    const { width, height } = wave
    const top = Math.ceil(height / 4)
    const copy = new OffscreenCanvas(width, height).getContext('2d')
    copy.drawImage(wave, 0, 0)
    const { data } = copy.getImageData(0, 0, width, top)
    for (let eighth = 0; eighth < 8; eighth++) {
      let sound = false
      for (let x = Math.floor((eighth * width) / 8); x < Math.floor(((eighth + 1) * width) / 8) && !sound; x++) {
        for (let y = 0; y < top && !sound; y++) sound = data[(y * width + x) * 4 + 3] > 0
      }
      if (!sound) return false
    }
    return true
  },
  budget: { ...budget, completeMs },
  limit: { completeMs: limitMs }
}))
