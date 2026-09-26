"""Cuts a rendered video into contact sheets for review: one sheet per span of seconds, frames at a fixed rate.

  python3 tools/review.py out/video.mp4 OUTDIR [fps] [seconds-per-sheet]
"""
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

video, outdir = sys.argv[1], Path(sys.argv[2])
fps = float(sys.argv[3]) if len(sys.argv) > 3 else 4
span = float(sys.argv[4]) if len(sys.argv) > 4 else 6
outdir.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory() as tmp:
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', video, '-vf', f'fps={fps},scale=480:-1', f'{tmp}/f%05d.jpg'], check=True)
    frames = sorted(Path(tmp).glob('f*.jpg'))
    per = int(span * fps)
    cols = 6
    font = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 16)
    for s in range(0, len(frames), per):
        group = frames[s:s + per]
        rows = (len(group) + cols - 1) // cols
        sheet = Image.new('RGB', (cols * 484, rows * 274), (30, 30, 30))
        d = ImageDraw.Draw(sheet)
        for k, f in enumerate(group):
            x, y = (k % cols) * 484, (k // cols) * 274
            sheet.paste(Image.open(f), (x, y))
            t = (s + k) / fps
            d.rectangle([x, y, x + 58, y + 20], fill=(0, 0, 0))
            d.text((x + 4, y + 2), f'{t:.2f}', fill=(255, 255, 0), font=font)
        name = outdir / f'sheet-{s / fps:05.1f}.jpg'
        sheet.save(name, quality=85)
        print(name)
