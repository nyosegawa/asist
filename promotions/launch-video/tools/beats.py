# /// script
# dependencies = ["librosa", "numpy"]
# ///
"""Prints the beats of the music, the straight beat grid fitted to them (BEAT and B() in js/core.js), and
a loudness curve."""
import sys
from pathlib import Path

import librosa
import numpy as np

MUSIC = sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / 'assets/bgm/musicbox.mp3'

y, sr = librosa.load(MUSIC, sr=22050, mono=True)
tempo, beats = librosa.beat.beat_track(y=y, sr=sr, units='time', tightness=200)
onset_env = librosa.onset.onset_strength(y=y, sr=sr)
onsets = librosa.onset.onset_detect(onset_envelope=onset_env, sr=sr, units='time')
rms = librosa.feature.rms(y=y, hop_length=2205)[0]
print('tempo', tempo)
k = np.arange(len(beats))
period, t0 = np.polyfit(k, beats, 1)
print(f'grid: period {period:.5f} s ({60 / period:.3f} BPM), first beat {t0:.4f} s, '
      f'largest miss {np.abs(beats - (t0 + k * period)).max() * 1000:.0f} ms')
print('beats', len(beats))
print('beat times', np.round(beats, 3).tolist())
print('beat intervals', np.round(np.diff(beats), 3).tolist())
print('rms per 0.1s (dB), 1 value per second:')
db = 20 * np.log10(rms + 1e-9)
print([round(float(db[i * 10: i * 10 + 10].mean()), 1) for i in range(len(db) // 10)])
print('onsets', np.round(onsets, 2).tolist())
