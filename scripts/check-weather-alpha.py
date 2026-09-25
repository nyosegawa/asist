import json
import sys
from pathlib import Path
from PIL import Image


def inspect(path):
    image = Image.open(path)
    result = {'file': str(path), 'mode': image.mode, 'valid': False}
    if 'A' not in image.getbands():
        return result
    alpha = image.getchannel('A')
    top = alpha.crop((0, 0, image.width, image.height // 4))
    histogram = top.histogram()
    transparent = sum(histogram[:2]) / (top.width * top.height)
    result.update(top_transparent=round(transparent, 5), alpha_range=alpha.getextrema())
    result['valid'] = transparent > .95 and alpha.getextrema()[1] > 200
    return result


if __name__ == '__main__':
    paths = [Path(p) for p in sys.argv[1:]] or sorted(Path('src/renderer/src/assets/weather/landscapes').glob('*.png'))
    results = [inspect(p) for p in paths]
    print(json.dumps(results, ensure_ascii=False, indent=2))
    sys.exit(0 if all(r['valid'] for r in results) else 1)
