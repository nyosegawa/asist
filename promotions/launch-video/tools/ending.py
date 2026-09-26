# /// script
# dependencies = ["librosa", "numpy"]
# ///
"""Lists the note onsets of the music's ending (where it slows down), with their strength, and the grid beats for comparison."""
import sys
from pathlib import Path

import librosa
import numpy as np

MUSIC = sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / 'assets/bgm/musicbox.mp3'

y, sr = librosa.load(MUSIC, sr=22050, mono=True)
hop = 256
env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
on = librosa.onset.onset_detect(onset_envelope=env, sr=sr, hop_length=hop, units='frames', backtrack=False)
times = librosa.frames_to_time(on, sr=sr, hop_length=hop)
low = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop, fmax=300)
for f, t in zip(on, times):
    if 46.5 <= t <= 57:
        k = (t - 0.1309) / 0.56605
        print(f'{t:6.3f} s  strength {env[f]:5.2f}  bass {low[f]:5.2f}  grid beat {k:6.2f}')
