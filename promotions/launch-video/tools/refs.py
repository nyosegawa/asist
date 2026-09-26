# /// script
# dependencies = ["pillow"]
# ///
"""Makes the pictures that are passed to imagegen with the prompts in assets/gen/prompts/, into assets/gen/refs/.

  ref-robot-cta.png   the robot of website/public/img/cta.jpg, the model for every robot pose
  ref-girl-cta.png    the girl of the same picture
  ref-hero-flat.png   website/public/img/hero.png on the paper colour, the model for the material and colours
  frame-3x2.png       six dashed frames on a transparent canvas; a sheet generated with it as Image 1 keeps
                      one prop inside each frame, which is what tools/cutout.py relies on
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT.parent.parent / 'website/public'
OUT = ROOT / 'assets/gen/refs'
OUT.mkdir(parents=True, exist_ok=True)

cta = Image.open(SITE / 'img/cta.jpg').convert('RGB')
cta.crop((1780, 330, 2140, 680)).save(OUT / 'ref-robot-cta.png')
cta.crop((280, 330, 620, 680)).save(OUT / 'ref-girl-cta.png')

hero = Image.open(SITE / 'img/hero.png').convert('RGBA')
flat = Image.new('RGBA', hero.size, (251, 250, 247, 255))
flat.alpha_composite(hero)
flat.convert('RGB').save(OUT / 'ref-hero-flat.png')

W, H, INSET = 2048, 1536, 64
frame = Image.new('RGBA', (W, H), (0, 0, 0, 0))
draw = ImageDraw.Draw(frame)
cw, ch = W // 3, H // 2
for r in range(2):
    for c in range(3):
        x0, y0, x1, y1 = c * cw + INSET, r * ch + INSET, (c + 1) * cw - INSET, (r + 1) * ch - INSET
        for ax, ay, bx, by in [(x0, y0, x1, y0), (x1, y0, x1, y1), (x1, y1, x0, y1), (x0, y1, x0, y0)]:
            length = abs(bx - ax) + abs(by - ay)
            sx, sy = (bx > ax) - (bx < ax), (by > ay) - (by < ay)
            for p in range(0, length, 42):
                q = min(p + 26, length)
                draw.line([(ax + sx * p, ay + sy * p), (ax + sx * q, ay + sy * q)], fill=(150, 156, 176, 255), width=4)
frame.save(OUT / 'frame-3x2.png')
print('wrote', ', '.join(sorted(f.name for f in OUT.iterdir())))
