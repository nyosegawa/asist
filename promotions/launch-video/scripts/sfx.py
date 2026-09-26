# /// script
# dependencies = ["numpy"]
# ///
"""Sound effects for the video, all synthesized with numpy: 11 kinds of moments in 3 patterns, and 11
more kinds that only the clay pattern has, since the video uses that pattern.

Kinds in every pattern (what happens on screen):
  voice       someone talks to ASIST (a speech bubble from the user)
  reply       ASIST or the robot answers
  card        a card appears as the answer
  deal        the cards line up in a fan, one after another
  hand        a handwritten label or note is added
  transition  the scene changes
  appear      a small part appears (chip, badge, dialog, CLI name, logo, URL)
  click       something is pressed (Dock icon, the start button)
  work        the Agent job runs and finishes (1.2 s of work, then done)
  night       the night falls and the clock strikes midnight
  write       the diary is written, character by character (2 s)

Kinds in the clay pattern only:
  jump, land  the robot jumps in and lands
  fly         papers fly into a dialog
  open, close a window grows out of its icon, and goes back into it
  done        a job finishes, with confetti
  clock       the clock turns to midnight
  morning     the morning rises
  cta         the address of the site appears
  cascade     n wooden taps over a duration, rising a little (a job's progress)
  chime       n kalimba notes rising through F major pentatonic over a duration (letters, chips, a count)

Patterns:
  musicbox    tuned bells, celesta, kalimba and harp in F major pentatonic, to blend with the music box BGM
  clay        tactile sounds of the clay world: squishy pops, paper, pencil, wood
  mac         clean interface sounds: glassy tones, trackpad clicks, keyboard typing

uv run scripts/sfx.py writes every sound to out/sfx/<pattern>/<kind>.wav for listening one by one.
"""
import wave
from pathlib import Path

import numpy as np

SR = 48000
ROOT = Path(__file__).resolve().parent.parent
KINDS = ['voice', 'reply', 'card', 'deal', 'hand', 'transition', 'appear', 'click', 'work', 'night', 'write']
CLAY_KINDS = ['jump', 'land', 'fly', 'open', 'close', 'done', 'clock', 'morning', 'cta', 'cascade', 'chime']
PATTERNS = ['musicbox', 'clay', 'mac']
# F major pentatonic from F4
PENTA = [65, 67, 69, 72, 74, 77, 79, 81, 84, 86, 89, 91, 93, 96, 98, 101]

# target peak level (dBFS) of each kind; continuous or frequent sounds sit lower
PEAK_DB = {
    'voice': -17, 'reply': -18, 'card': -17, 'deal': -22, 'hand': -21, 'transition': -25,
    'appear': -21, 'click': -20, 'work': -20, 'night': -20, 'write': -25,
    'jump': -21, 'land': -22, 'fly': -24, 'open': -21, 'close': -23, 'done': -18, 'clock': -20,
    'morning': -21, 'cta': -18, 'cascade': -26, 'chime': -24,
}


def hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def ts(sec):
    return np.arange(int(sec * SR)) / SR


def silence(sec):
    return np.zeros(int(sec * SR))


def place(out, at, sig, gain=1.0):
    i = int(at * SR)
    need = i + len(sig)
    if need > len(out):
        out = np.concatenate([out, np.zeros(need - len(out))])
    out[i:need] += sig * gain
    return out


def seq(events, length=None):
    """events: [(time, signal, gain)]"""
    out = silence(length or 0.01)
    for at, sig, g in events:
        out = place(out, at, sig, g)
    return out


def rng(seed):
    return np.random.default_rng(seed)


def noise(sec, seed=0):
    return rng(seed).standard_normal(int(sec * SR))


def band(x, lo, hi, soft=0.25):
    """FFT band-pass with soft edges (lo/hi in Hz)."""
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    lo_edge = 1 / (1 + np.exp(-(np.log(f + 1) - np.log(lo)) / soft))
    hi_edge = 1 / (1 + np.exp((np.log(f + 1) - np.log(hi)) / soft))
    return np.fft.irfft(X * lo_edge * hi_edge, len(x))


def env(sec, attack=0.003, decay=8.0):
    t = ts(sec)
    return (1 - np.exp(-t / max(attack, 1e-4))) * np.exp(-t * decay)


def bell_env(sec, attack, release):
    t = ts(sec)
    a = np.minimum(1, t / attack)
    r = np.clip((sec - t) / release, 0, 1)
    return a * r


def partials(f, sec, spec, attack=0.002):
    """spec: [(ratio, amp, decay)]"""
    t = ts(sec)
    sig = sum(a * np.sin(2 * np.pi * f * r * t) * np.exp(-t * d) for r, a, d in spec)
    return sig * (1 - np.exp(-t / attack))


def glide(f0, f1, sec, curve=0.5):
    t = ts(sec)
    f = f0 + (f1 - f0) * (t / sec) ** curve
    return np.sin(2 * np.pi * np.cumsum(f) / SR)


def reverb(x, wet=0.2, sec=0.9, seed=3):
    ir = noise(sec, seed) * np.exp(-ts(sec) * (6.9 / sec))
    ir = band(ir, 300, 9000)
    ir /= np.sqrt(np.sum(ir ** 2))
    n = len(x) + len(ir)
    y = np.fft.irfft(np.fft.rfft(x, n) * np.fft.rfft(ir, n), n)
    return np.concatenate([x, np.zeros(len(ir))]) * (1 - wet) + y * wet * 0.6


# instrument voices for the music box pattern
def musicbox(m, sec=1.2):
    return partials(hz(m), sec, [(1, 1, 3.5), (2.0, 0.25, 7), (3.01, 0.12, 12), (5.43, 0.08, 20)], 0.001)


def celesta(m, sec=1.0):
    return partials(hz(m), sec, [(1, 1, 4.5), (2.0, 0.35, 9), (4.0, 0.08, 18)], 0.002)


def kalimba(m, sec=0.9):
    return partials(hz(m), sec, [(1, 1, 5), (5.9, 0.18, 30), (2.0, 0.1, 10)], 0.001)


def harp(m, sec=1.0):
    return partials(hz(m), sec, [(1, 1, 3.2), (2, 0.4, 5), (3, 0.15, 8)], 0.004)


def church_bell(m, sec=2.4):
    return partials(hz(m), sec, [(0.5, 0.5, 1.2), (1, 1, 1.6), (1.19, 0.5, 2.2), (1.56, 0.35, 2.8), (2.0, 0.3, 3.2), (2.51, 0.15, 4)], 0.004)


# clay pattern voices
def squish(f0, f1, sec=0.13):
    t = ts(sec)
    body = glide(f0, f1, sec, 0.6) * np.sin(np.pi * np.minimum(1, t / sec)) ** 0.7
    wet = band(noise(sec, int(f0)), 300, 1500) * np.exp(-t * 30) * 0.15
    return body + wet


def paper(sec, lo=1500, hi=7000, seed=0, shape='swell'):
    t = ts(sec)
    n = band(noise(sec, seed), lo, hi)
    e = np.sin(np.pi * t / sec) ** (2 if shape == 'swell' else 0.5) if shape != 'snap' else np.exp(-t * 90)
    return n * e


def thump(f=90, sec=0.08):
    t = ts(sec)
    return np.sin(2 * np.pi * f * t) * np.exp(-t * 45)


def wood(f=900, sec=0.12, seed=0):
    t = ts(sec)
    return (partials(f, sec, [(1, 1, 38), (2.7, 0.35, 60)], 0.0005)
            + band(noise(sec, seed), f * 0.8, f * 2.5) * np.exp(-t * 120) * 0.4)


def pencil(sec, strokes, seed=0):
    r = rng(seed)
    out = silence(sec)
    t0 = 0.0
    for k in range(strokes):
        dur = r.uniform(0.05, 0.11)
        s = band(noise(dur, seed + k), 2500, 8000)
        grain = 0.6 + 0.4 * np.abs(band(noise(dur, seed + 50 + k), 20, 120))
        s = s * grain * np.sin(np.pi * ts(dur) / dur) ** 0.8
        out = place(out, t0, s, r.uniform(0.6, 1.0))
        t0 += dur + r.uniform(0.01, 0.05)
    return out


# mac pattern voices
def glass(f, sec=0.4, decay=9):
    return partials(f, sec, [(1, 1, decay), (2.0, 0.2, decay * 2), (3.0, 0.05, decay * 3)], 0.004)


def tick(f=2200, sec=0.03):
    t = ts(sec)
    return np.sin(2 * np.pi * f * t) * np.exp(-t * 160)


def trackpad():
    t = ts(0.05)
    return seq([(0, thump(140, 0.05), 0.9), (0, tick(3200, 0.02), 1.0),
                (0, band(noise(0.05, 11), 2000, 9000) * np.exp(-t * 400), 0.5)])


def key(seed):
    r = rng(seed)
    t = ts(0.06)
    click = band(noise(0.06, seed), 1800, 7000) * np.exp(-t * r.uniform(220, 320))
    thock = np.sin(2 * np.pi * r.uniform(180, 260) * t) * np.exp(-t * 70) * 0.5
    return click + thock


def s_musicbox(kind, i=0):
    if kind == 'voice':
        return reverb(seq([(0, celesta(81, 0.8), 0.7), (0.07, celesta(89, 1.0), 1.0)]), 0.25)
    if kind == 'reply':
        return reverb(seq([(0, celesta(86, 0.8), 1.0), (0.09, celesta(81, 1.0), 0.8)]), 0.25)
    if kind == 'card':
        m = [81, 84, 86, 89][i % 4]
        return reverb(seq([(0, harp(m - 12, 1.0), 0.5), (0.01, musicbox(m, 1.2), 1.0)]), 0.25)
    if kind == 'deal':
        return reverb(musicbox([84, 86, 89, 91, 93][i % 5], 0.7), 0.2)
    if kind == 'hand':
        return reverb(kalimba([77, 79, 81, 84, 86, 89][i % 6], 0.8), 0.2)
    if kind == 'transition':
        # a soft harp glissando up the scale
        notes = [65, 69, 72, 74, 77, 81, 84, 86]
        return reverb(seq([(k * 0.04, harp(m, 0.9), 0.35 + 0.08 * k) for k, m in enumerate(notes)]), 0.35)
    if kind == 'appear':
        return reverb(celesta(96, 0.5), 0.2)
    if kind == 'click':
        t = ts(0.02)
        return reverb(seq([(0, band(noise(0.02, 5), 3000, 9000) * np.exp(-t * 300), 0.4), (0, musicbox(101, 0.4), 0.8)]), 0.15)
    if kind == 'work':
        ticks = [(k * 0.2, musicbox(81, 0.25), 0.35) for k in range(6)]
        done = [(1.2 + k * 0.07, musicbox(m, 1.4), 0.9) for k, m in enumerate([77, 81, 84, 89])]
        return reverb(seq(ticks + done), 0.3)
    if kind == 'night':
        shimmer = seq([(k * 0.12, celesta(m, 1.6) * bell_env(1.6, 0.25, 1.0), 0.4) for k, m in enumerate([89, 93, 96, 101])])
        return reverb(seq([(0, shimmer, 1.0), (0.7, church_bell(65), 0.9)]), 0.4, 1.4)
    if kind == 'write':
        r = rng(21)
        return reverb(seq([(k * 0.25 + r.uniform(0, 0.04), musicbox(int(r.choice(PENTA[6:12])), 0.5), 0.4) for k in range(8)]), 0.3)


def s_clay(kind, i=0):
    if kind == 'voice':
        return reverb(squish(200, 430), 0.08)
    if kind == 'reply':
        return reverb(seq([(0, squish(330, 520, 0.1), 0.8), (0.1, squish(420, 640, 0.1), 1.0)]), 0.08)
    if kind == 'card':
        return reverb(seq([(0, paper(0.2, seed=i), 1.0), (0.17, thump(85), 0.8)]), 0.06)
    if kind == 'deal':
        return reverb(seq([(0, paper(0.05, 2000, 8000, seed=10 + i, shape='snap'), 1.0), (0.02, thump(110, 0.05), 0.5)]), 0.05)
    if kind == 'hand':
        return reverb(pencil(0.45, 3 + i % 2, seed=30 + i), 0.05)
    if kind == 'transition':
        t = ts(0.5)
        return reverb(band(noise(0.5, 40), 150, 1200) * np.sin(np.pi * t / 0.5) ** 2, 0.1)
    if kind == 'appear':
        return reverb(seq([(0, wood(760, seed=4), 0.8), (0.0, squish(500, 380, 0.07), 0.5)]), 0.06)
    if kind == 'click':
        return reverb(seq([(0, wood(1500, 0.06, 7), 1.0), (0.012, wood(2600, 0.04, 8), 0.6)]), 0.04)
    if kind == 'work':
        ticks = [(k * 0.15, wood(1200 if k % 2 else 950, 0.06, k), 0.45) for k in range(8)]
        done = [(1.2, wood(620, 0.2, 90), 1.0), (1.26, celesta(89, 1.0), 0.45)]
        return reverb(seq(ticks + done), 0.1)
    if kind == 'night':
        t = ts(1.4)
        air = band(noise(1.4, 60), 120, 700) * bell_env(1.4, 0.5, 0.8) * 0.5
        return reverb(seq([(0, air, 1.0), (0.55, wood(1300, 0.05, 61), 0.5), (0.8, wood(1000, 0.05, 62), 0.5),
                           (1.05, church_bell(65, 2.0), 0.55)]), 0.25, 1.2)
    if kind == 'write':
        return reverb(pencil(2.0, 16, seed=70), 0.05)


def s_clay_only(kind, i=0, n=1, dur=0.0):
    if kind == 'jump':
        t = ts(0.3)
        swish = band(noise(0.3, 44), 600, 3000) * np.sin(np.pi * t / 0.3) ** 2 * 0.25
        return reverb(seq([(0, squish(180, 560, 0.2), 1.0), (0.02, swish, 1.0)]), 0.08)
    if kind == 'land':
        return reverb(seq([(0, thump(70, 0.12), 1.0), (0.0, squish(420, 260, 0.09), 0.6)]), 0.06)
    if kind == 'fly':
        return reverb(paper(0.38, 1200, 6000, seed=45), 0.08)
    if kind == 'open':
        return reverb(seq([(0, paper(0.26, 900, 5000, seed=46), 0.9), (0.2, thump(95), 0.8), (0.2, squish(380, 520, 0.08), 0.4)]), 0.08)
    if kind == 'close':
        return reverb(seq([(0, squish(520, 300, 0.1), 1.0), (0.09, wood(900, 0.06, 47), 0.5)]), 0.06)
    if kind == 'done':
        rustle = seq([(k * 0.035, paper(0.05, 2500, 9000, seed=60 + k, shape='snap'), 0.5) for k in range(10)])
        chime = seq([(0.02 + k * 0.08, celesta(m, 1.0), 0.55) for k, m in enumerate([81, 86, 89])])
        return reverb(seq([(0, wood(620, 0.2, 90), 1.0), (0, chime, 1.0), (0.05, rustle, 0.8)]), 0.12)
    if kind == 'clock':
        return reverb(seq([(0, wood(1400, 0.05, 71), 0.5), (0.18, wood(1100, 0.05, 72), 0.5), (0.36, church_bell(65, 2.2), 0.6)]), 0.3, 1.2)
    if kind == 'morning':
        return reverb(seq([(k * 0.07, kalimba(m, 0.9), 0.5 + 0.08 * k) for k, m in enumerate([72, 77, 81, 84, 89])]), 0.25)
    if kind == 'cta':
        return reverb(seq([(0, squish(300, 520, 0.12), 0.7)] + [(0.05 + k * 0.06, musicbox(m, 1.3), 0.7) for k, m in enumerate([84, 89, 93, 96])]), 0.3)
    if kind == 'chime':
        gap = dur / max(1, n - 1) if n > 1 else 0
        return reverb(seq([(k * gap, kalimba(PENTA[5 + k % 10], 0.6), 0.55 + 0.04 * k) for k in range(n)]), 0.25)
    if kind == 'cascade':
        gap = dur / max(1, n - 1) if n > 1 else 0
        return reverb(seq([(k * gap, wood(900 + 60 * k, 0.05, 80 + k), 0.8) for k in range(n)]), 0.06)


def s_mac(kind, i=0):
    if kind == 'voice':
        rise = glide(hz(84), hz(89), 0.26, 0.3) * bell_env(0.26, 0.03, 0.15)
        return reverb(seq([(0, rise, 1.0), (0, glass(hz(96), 0.3, 14), 0.15)]), 0.15)
    if kind == 'reply':
        return reverb(seq([(0, glass(hz(89), 0.5), 0.8), (0.06, glass(hz(84), 0.6), 0.7)]), 0.15)
    if kind == 'card':
        t = ts(0.09)
        swish = band(noise(0.09, 80), 3000, 10000) * np.sin(np.pi * t / 0.09) ** 2 * 0.35
        return reverb(seq([(0, swish, 1.0), (0.07, tick(2100, 0.04), 0.8), (0.07, glass(hz(93), 0.25, 18), 0.25)]), 0.1)
    if kind == 'deal':
        return reverb(tick(1700 + 180 * i, 0.03), 0.08)
    if kind == 'hand':
        return reverb(seq([(0, tick(2600, 0.015), 0.8), (0.004, band(noise(0.02, 90 + i), 3000, 9000) * np.exp(-ts(0.02) * 300), 0.3)]), 0.06)
    if kind == 'transition':
        t = ts(0.32)
        return reverb(band(noise(0.32, 91), 400, 3500) * np.sin(np.pi * t / 0.32) ** 3, 0.1)
    if kind == 'appear':
        return reverb(glass(hz(96), 0.18, 22), 0.1)
    if kind == 'click':
        return reverb(trackpad(), 0.03)
    if kind == 'work':
        gaps = [0, 0.26, 0.48, 0.66, 0.82, 0.95, 1.06]
        ticks = [(g, tick(1500, 0.025), 0.35) for g in gaps]
        done = [(1.2, glass(hz(84), 0.7), 0.8), (1.3, glass(hz(89), 0.9), 0.9)]
        return reverb(seq(ticks + done), 0.15)
    if kind == 'night':
        t = ts(1.6)
        pad = (np.sin(2 * np.pi * hz(53) * t) + 0.6 * np.sin(2 * np.pi * hz(60) * t) + 0.3 * np.sin(2 * np.pi * hz(65) * t)) * bell_env(1.6, 0.6, 0.9)
        return reverb(seq([(0, pad, 0.5), (0.7, glass(hz(77), 1.0, 4), 0.8)]), 0.3)
    if kind == 'write':
        r = rng(123)
        at, ev = 0.0, []
        while at < 1.95:
            ev.append((at, key(int(r.integers(1e6))), r.uniform(0.55, 1.0)))
            at += r.uniform(0.06, 0.14) + (0.18 if r.random() < 0.1 else 0)
        return reverb(seq(ev), 0.05)


MAKERS = {'musicbox': s_musicbox, 'clay': s_clay, 'mac': s_mac}


def make(pattern, kind, i=0, n=1, dur=0.0):
    sig = s_clay_only(kind, i, n, dur) if kind in CLAY_KINDS else MAKERS[pattern](kind, i)
    sig = sig / (np.abs(sig).max() + 1e-9)
    # a short fade removes clicks at the end of the reverb tail
    sig[-int(0.01 * SR):] *= np.linspace(1, 0, int(0.01 * SR))
    return sig * 10 ** (PEAK_DB[kind] / 20)


# how the sound for each kind is heard on its own: several occurrences for kinds that repeat
AUDITION = {'deal': [(k * 0.1, k) for k in range(5)], 'hand': [(k * 0.22, k) for k in range(6)], 'card': [(k * 0.9, k) for k in range(3)]}


def write_wav(path, mono):
    peak = np.abs(mono).max()
    mono = mono / peak * 0.8 if peak > 0 else mono
    pcm = (np.repeat(mono[:, None], 2, axis=1) * 32767).astype('<i2')
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


if __name__ == '__main__':
    for p in PATTERNS:
        for k in KINDS:
            events = [(at, make(p, k, i), 1.0) for at, i in AUDITION.get(k, [(0, 0)])]
            write_wav(ROOT / 'out' / 'sfx' / p / f'{k}.wav', np.concatenate([silence(0.05), seq(events), silence(0.1)]))
    for k in CLAY_KINDS:
        write_wav(ROOT / 'out' / 'sfx' / 'clay' / f'{k}.wav', np.concatenate([silence(0.05), make('clay', k, 0, 6, 0.5), silence(0.1)]))
    print('wrote', len(PATTERNS) * len(KINDS) + len(CLAY_KINDS), 'sounds to out/sfx/')
