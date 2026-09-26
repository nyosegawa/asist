"""Tiles stills (out/stills/t*.jpg by default) into one labelled contact sheet for review."""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
out = Path(sys.argv[1])
files = [Path(f) for f in sys.argv[2:]] or sorted((ROOT / 'out/stills').glob('t*.jpg'), key=lambda p: float(p.stem[1:]))
cols = 3 if len(files) > 4 else 2
w = 640
h = 360
rows = (len(files) + cols - 1) // cols
sheet = Image.new('RGB', (cols * w + (cols - 1) * 6, rows * h + (rows - 1) * 6), (30, 30, 30))
font = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 22)
for k, f in enumerate(files):
    im = Image.open(f).convert('RGB').resize((w, h), Image.LANCZOS)
    x = (k % cols) * (w + 6)
    y = (k // cols) * (h + 6)
    sheet.paste(im, (x, y))
    d = ImageDraw.Draw(sheet)
    d.rectangle([x, y, x + 86, y + 30], fill=(0, 0, 0))
    d.text((x + 6, y + 3), f.stem, fill=(255, 255, 0), font=font)
sheet.save(out, quality=88)
print(out)
