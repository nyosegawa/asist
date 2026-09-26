# /// script
# dependencies = ["librosa", "numpy"]
# ///
"""Estimates the downbeat phase from chord changes: the chroma novelty per beat, averaged by beat mod 4."""
import sys
from pathlib import Path

import librosa
import numpy as np

MUSIC = sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / 'assets/bgm/musicbox.mp3'

y, sr = librosa.load(MUSIC, sr=22050, mono=True)
P, t0 = 0.56605, 0.1309
yh = librosa.effects.harmonic(y)
hop = 256
chroma = librosa.feature.chroma_cqt(y=yh, sr=sr, hop_length=hop, bins_per_octave=36)
times = librosa.frames_to_time(np.arange(chroma.shape[1]), sr=sr, hop_length=hop)
S = np.abs(librosa.stft(yh, n_fft=4096, hop_length=hop))
freqs = librosa.fft_frequencies(sr=sr, n_fft=4096)
low = S[(freqs > 40) & (freqs < 260)]
n = int((50 - t0) / P)
grid = t0 + np.arange(n) * P


def seg(M, t):
    m = (times >= t) & (times < t + P)
    v = M[:, m].mean(axis=1)
    return v / (np.linalg.norm(v) + 1e-9)


C = np.array([seg(chroma, t) for t in grid])
L = np.array([seg(low, t) for t in grid])
nov_c = np.r_[0, 1 - (C[1:] * C[:-1]).sum(axis=1)]
nov_l = np.r_[0, 1 - (L[1:] * L[:-1]).sum(axis=1)]
for ph in range(4):
    print(f'phase {ph}: chroma novelty {nov_c[ph::4][1:].mean():.4f}  bass novelty {nov_l[ph::4][1:].mean():.4f}')
for ph in range(8):
    print(f'phase8 {ph}: chroma novelty {nov_c[ph::8][1:].mean():.4f}  bass novelty {nov_l[ph::8][1:].mean():.4f}')
