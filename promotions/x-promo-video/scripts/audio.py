# /// script
# dependencies = ["numpy"]
# ///
"""Mixes the background music and the sound effects for the video into out/audio.wav.

The effects are placed at the cues that render.mjs wrote to out/cues.json. Each cue names
what happens on screen; KIND below maps it to one of the 11 kinds of sound in sfx.py, and
--sfx chooses which of the three patterns plays them.

  uv run scripts/audio.py                        (clay effects, 9 dB under the levels in sfx.py)
  uv run scripts/audio.py --sfx none --out out/audio-none.wav
"""
import argparse
import json
import subprocess
import wave
from pathlib import Path

import numpy as np

import sfx

ROOT = Path(__file__).resolve().parent.parent
SR = sfx.SR
ap = argparse.ArgumentParser()
ap.add_argument('--bgm', default='assets/bgm/musicbox.mp3')
ap.add_argument('--sfx', default='clay', choices=sfx.PATTERNS + ['none'])
ap.add_argument('--sfx-db', type=float, default=-9, help='overall level of the effects in dB, added to the per-kind levels in sfx.py')
ap.add_argument('--out', default='out/audio.wav')
args = ap.parse_args()

# cue in the timeline -> kind of sound (None = silent on purpose)
KIND = {
    'voice': 'voice', 'reply': 'reply', 'robot': 'reply',
    'scene': 'transition', 'move': 'transition',
    'chip': 'appear', 'dialog': 'appear', 'cli': 'appear', 'logo': 'appear', 'cta': 'appear',
    'tap': 'click', 'click': 'click',
    'progress': 'work',
    # left quiet on purpose: cards and handwriting come too often, the zoom and the memory scene read better in silence
    'card': None, 'deal': None, 'label': None, 'badge': None, 'note': None, 'zoom': None,
    'night': None, 'clock': None, 'write': None,
    'done': None, 'marker': None, 'cursor': None,
}

meta = json.loads((ROOT / 'out/cues.json').read_text())
DUR = meta['duration']
N = int(DUR * SR)
fx = np.zeros((N, 2))
pan_rng = np.random.default_rng(5)
night_at = [c['t'] for c in meta['cues'] if c['type'] == 'night']

for c in meta['cues']:
    kind = KIND[c['type']]
    if kind is None or args.sfx == 'none':
        continue
    if c['type'] == 'scene' and any(abs(c['t'] - t) < 0.05 for t in night_at):
        continue  # the memory scene opens without a sound
    sig = sfx.make(args.sfx, kind, c.get('i', 0)) * 10 ** (args.sfx_db / 20)
    start = c['t'] - (0.05 if kind == 'transition' else 0)
    i = int(start * SR)
    sig = sig[: N - i]
    pan = pan_rng.uniform(-0.25, 0.25)
    fx[i : i + len(sig), 0] += sig * np.sqrt(1 - pan)
    fx[i : i + len(sig), 1] += sig * np.sqrt(1 + pan)

# the music is decoded at a fixed loudness so the effects always sit at the same place under it
raw = subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', str(ROOT / args.bgm), '-af', 'loudnorm=I=-22:TP=-3',
                      '-ar', str(SR), '-ac', '2', '-f', 'f32le', '-'], capture_output=True, check=True).stdout
bgm = np.frombuffer(raw, dtype='<f4').reshape(-1, 2)[:N]
music = np.zeros((N, 2))
music[: len(bgm)] = bgm

mix = music + fx
# fade in the very first samples and out over the last 1.2 seconds
fade = np.ones(N)
fade[: int(0.02 * SR)] = np.linspace(0, 1, int(0.02 * SR))
tail = int(1.2 * SR)
fade[-tail:] = np.linspace(1, 0, tail) ** 1.5
mix *= fade[:, None]
mix = np.tanh(mix * 1.2) / np.tanh(1.2)
mix *= 0.89 / np.abs(mix).max()

pcm = (mix * 32767).astype('<i2')
with wave.open(str(ROOT / args.out), 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print('wrote', args.out, f'({args.sfx} effects)')
