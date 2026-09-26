# /// script
# dependencies = ["numpy", "scipy", "pillow"]
# ///
"""Cuts the sheets imagegen returned (assets/gen/raw/) into one WebP per prop and trims the characters.

Props are found as clusters of opaque pixels (the mask is dilated first so that a sun's separate
rays stay with its body) and named in reading order. Some generations carry a faint white haze
around the subject (alpha about 50-110 over some 80 px), which shows as a glow on dark backgrounds,
so the alpha is choked: values under LO become 0 and the rest is stretched back to the full range.
The colour of the remaining edge pixels is then taken from the nearest opaque pixel, because the
haze has lightened them. WebP at quality 90 keeps the props within about 2 levels of the PNG at an
eighth of its size.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

GEN = Path(__file__).resolve().parent.parent / 'assets/gen'
SHEETS = {
    'sheet-day': ['calendar', 'envelope', 'sun', 'cloud', 'coins', 'check'],
    'sheet-night': ['moon', 'star', 'star-lav', 'diary', 'clock', 'pencil'],
    'sheet-misc': ['globe', 'docs', 'bubble', 'terminal', 'pin', 'stopwatch'],
    'sheet-extra': ['cloud-wide', 'cloud-small', 'cloud-rain', 'newspaper', 'sparkle', 'mic'],
}
CHARS = ['robot-wave', 'robot-cheer', 'robot-present', 'robot-diary', 'girl-talk']
PAD = 8


def clean(rgba, lo, hi=245):
    out = rgba.copy()
    a = rgba[:, :, 3].astype(np.float32)
    out[:, :, 3] = (np.clip((a - lo) / (hi - lo), 0, 1) * 255).astype(np.uint8)
    solid = rgba[:, :, 3] > 250
    # Every pixel takes the colour of its nearest solid pixel, which changes only the partly transparent edge.
    _, (iy, ix) = ndimage.distance_transform_edt(~solid, return_indices=True)
    edge = (out[:, :, 3] > 0) & ~solid
    out[edge, :3] = rgba[iy[edge], ix[edge], :3]
    out[out[:, :, 3] == 0, :3] = 0
    return out


def trim(rgba):
    ys, xs = np.where(rgba[:, :, 3] > 0)
    y0, y1 = max(ys.min() - PAD, 0), min(ys.max() + PAD + 1, rgba.shape[0])
    x0, x1 = max(xs.min() - PAD, 0), min(xs.max() + PAD + 1, rgba.shape[1])
    return rgba[y0:y1, x0:x1]


def props(sheet, names, lo):
    im = np.array(Image.open(GEN / f'raw/{sheet}.png').convert('RGBA'))
    mask = ndimage.binary_dilation(im[:, :, 3] > lo, iterations=40)
    labels, n = ndimage.label(mask)
    boxes = ndimage.find_objects(labels)
    sizes = ndimage.sum(np.ones_like(labels), labels, range(1, n + 1))
    keep = sorted(range(n), key=lambda i: -sizes[i])[:len(names)]
    # Props are named in reading order: rows by the centre of their box, then left to right.
    keep.sort(key=lambda i: (int((boxes[i][0].start + boxes[i][0].stop) / 2 // (im.shape[0] / 2)), boxes[i][1].start))
    for name, i in zip(names, keep):
        part = np.where((labels == i + 1)[:, :, None], im, 0).astype(np.uint8)
        out = trim(clean(part, lo))
        Image.fromarray(out).save(GEN / f'props/{name}.webp', quality=90, method=6)
        print(sheet, name, out.shape[1], 'x', out.shape[0])


def chars(lo):
    for name in CHARS:
        im = np.array(Image.open(GEN / f'raw/{name}.png').convert('RGBA'))
        out = trim(clean(im, lo))
        Image.fromarray(out).save(GEN / f'chars/{name}.webp', quality=90, method=6)
        print('char', name, out.shape[1], 'x', out.shape[0])


if __name__ == '__main__':
    lo = int(sys.argv[1]) if len(sys.argv) > 1 else 120
    for sheet, names in SHEETS.items():
        props(sheet, names, lo)
    chars(40)
