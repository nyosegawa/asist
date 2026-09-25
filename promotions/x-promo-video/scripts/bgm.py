"""Generates candidate background music with Lyria 3.5 (Gemini API) into assets/bgm/.

The API key is read from GEMINI_API_KEY or ~/.config/gemini/api_key and is never printed.
Usage: python3 scripts/bgm.py             all variants in parallel
       python3 scripts/bgm.py musicbox    one variant (the one the video uses)
"""
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'assets/bgm'
URL = 'https://generativelanguage.googleapis.com/v1beta/interactions'

# The structure follows the scenes of the video (see README.md).
COMMON = """Instrumental only, no vocals.
Quiet, unobtrusive background music for a 40-second product video about a friendly voice assistant on the Mac, set in a soft pastel clay-diorama world.
It must stay in the background: low and even dynamics, soft attacks, no loud drums, no drops, no risers, no big climax, nothing harsh or bright.
Key of C major, about 96 BPM, warm, calm and gently cheerful.
The track is exactly 40 seconds long.
[0:00 - 0:08] very soft intro, the lead instrument alone with a warm pad.
[0:08 - 0:29] a light, gentle groove joins: soft bass and very quiet percussion.
[0:29 - 0:34] quieter dreamy night moment, percussion drops out.
[0:34 - 0:40] warm, simple resolution; the final chord rings out and fades to silence by 0:40."""

VARIANTS = {
    'piano': 'Instruments: felt piano as the lead, kalimba accents, warm analog pad, soft upright bass, brushed shaker.',
    'guitar': 'Instruments: nylon-string acoustic guitar fingerpicking as the lead, soft glockenspiel accents, mellow Rhodes pad, round soft bass, light rim clicks.',
    'musicbox': 'Instruments: celesta and music box as the lead, soft marimba, airy string pad, gentle sub bass, almost no percussion (only a soft shaker).',
}


def api_key():
    key = os.environ.get('GEMINI_API_KEY')
    if not key:
        key = (Path.home() / '.config/gemini/api_key').read_text().strip()
    return key


def generate(name):
    body = {
        'model': 'lyria-3.5',
        'input': f'{COMMON}\n{VARIANTS[name]}',
        'response_format': {'type': 'audio'},
    }
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), method='POST', headers={
        'x-goog-api-key': api_key(), 'Content-Type': 'application/json'})
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            res = json.load(r)
    except urllib.error.HTTPError as e:
        return f'{name}: HTTP {e.code} {e.read().decode()[:500]}'
    audio = [c for s in res.get('steps', []) if s.get('type') == 'model_output'
             for c in s.get('content', []) if c.get('type') == 'audio']
    if not audio:
        return f'{name}: no audio in response: {json.dumps(res)[:500]}'
    mime = audio[0].get('mime_type') or audio[0].get('mimeType') or ''
    ext = 'mp3' if 'mp' in mime else 'wav'
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f'{name}.{ext}'
    path.write_bytes(base64.b64decode(audio[0]['data']))
    (OUT / f'{name}.json').write_text(json.dumps({'prompt': body['input'], 'mime': mime, 'usage': res.get('usage')}, ensure_ascii=False, indent=1))
    return f'{name}: {path.name} ({mime}) in {time.time() - started:.0f}s'


names = sys.argv[1:] or list(VARIANTS)
with ThreadPoolExecutor(len(names)) as ex:
    for line in ex.map(generate, names):
        print(line, flush=True)
