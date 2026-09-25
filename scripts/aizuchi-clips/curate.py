#!/usr/bin/env python3
"""Pre-renders the aizuchi clips of one Qwen3-TTS voice, which the app ships instead of synthesizing them.

Qwen3-TTS rambles on a short interjection read alone ("あー。" came out between 0.6 and 6.5 s, measured
on 2026-09-21), but reads it naturally in front of a longer sentence. So every aizuchi is generated
several times in front of a carrier sentence, cut out with a forced aligner, and kept only when speech
recognition hears the aizuchi in the cut and the whole carrier after it; the most typical candidate wins.
Where the recognizer never writes an aizuchi out in full, a partly recognized reading stands in. The result still has to be listened to: review.html plays
every chosen clip next to its runners-up.

Runs in the app's MLX runtime, which already has mlx-audio and the three models in the Hugging Face cache.
  stdin : JSON list of {"text", "speedScale", "volumeScale"}; clips already in the manifest that are not listed are kept
  argv  : voice, language, output directory, verified candidates wanted per clip, path of the report to write
"""

from __future__ import annotations

import base64
import glob
import hashlib
import io
import json
import os
import re
import sys
import wave

import numpy as np

TTS_MODEL = "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit"
TTS_REVISION = "049ef77fe8816b536193c0c25f9a214d17921282"
ASR_MODEL = "mlx-community/Qwen3-ASR-1.7B-8bit"
ALIGNER_MODEL = "mlx-community/Qwen3-ForcedAligner-0.6B-4bit"

# The carrier has no comma, so the only long pause of a reading is the one after the aizuchi.
CARRIER = "今日は朝からとてもいい天気ですね。"
RATE = 24_000
FRAME = 480
VOICED_FRAME_RMS = 0.004
# The voiced RMS the app's SpeechShaper levels streamed sentences to.
TARGET_RMS = 0.07
PEAK_CEILING = 0.95
TAIL_FRAMES = 5


def snapshot(model: str, revision: str | None = None) -> str:
    root = os.path.expanduser(f"~/.cache/huggingface/hub/models--{model.replace('/', '--')}/snapshots")
    found = [os.path.join(root, revision)] if revision else sorted(glob.glob(os.path.join(root, "*")))
    if not found or not os.path.isdir(found[0]):
        raise SystemExit(f"{model} is not in the Hugging Face cache")
    return found[0]


def plain(text: str) -> str:
    # Long vowels, the small tsu and small vowels are where a recognizer's spelling of an interjection varies.
    return re.sub(r"[。、,.!?！？\s…ー〜っッぁぃぅぇぉ]", "", text)


def edit_distance(a: str, b: str) -> int:
    row = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        previous, row[0] = row[0], i
        for j, cb in enumerate(b, 1):
            previous, row[j] = row[j], min(row[j] + 1, row[j - 1] + 1, previous + (ca != cb))
    return row[-1]


def resample_16k(audio: np.ndarray) -> np.ndarray:
    length = int(len(audio) * 16_000 / RATE)
    return np.interp(np.linspace(0, len(audio) - 1, length), np.arange(len(audio)), audio).astype(np.float32)


def wav_bytes(audio: np.ndarray) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(RATE)
        out.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
    return buffer.getvalue()


def cut(audio: np.ndarray, items: list, head: str) -> dict | str:
    """Returns the aizuchi's samples and how trustworthy the cut is, or the reason the generation is unusable."""
    carrier_index = next((i for i, item in enumerate(items) if item.text.startswith(CARRIER[0])), None)
    if not carrier_index:
        return "the carrier was not aligned"
    head_start, head_end = items[0].start_time, items[carrier_index - 1].end_time
    carrier_start = items[carrier_index].start_time
    spoken = len(plain(head)) or 1
    # A natural aizuchi takes 0.06 to 0.45 s per character ("なるほどなるほど" at 0.09 s is a normal quick reading); outside that the model mumbled or rambled.
    if not 0.06 * spoken <= head_end - head_start <= 0.45 * spoken + 0.3:
        return f"{head_end - head_start:.2f} s is not a natural length"

    frames = audio[: len(audio) // FRAME * FRAME].reshape(-1, FRAME)
    voiced = np.sqrt((frames**2).mean(axis=1)) >= VOICED_FRAME_RMS
    lo = max(0, int((head_end - 0.15) * RATE / FRAME))
    hi = min(len(voiced), int((carrier_start + 0.15) * RATE / FRAME) + 1)
    # The longest silence between the aizuchi and the carrier is where the cut goes.
    best_start, best_length, run_start = None, 0, None
    for index in range(lo, hi + 1):
        silent = index < hi and not voiced[index]
        if silent and run_start is None:
            run_start = index
        if not silent and run_start is not None:
            if index - run_start > best_length:
                best_start, best_length = run_start, index - run_start
            run_start = None
    if best_start is None or best_length < 4:
        # Without a pause of 80 ms the aizuchi runs into the carrier and cannot be cut cleanly.
        return "no pause before the carrier"
    first = max(0, int(head_start * RATE / FRAME) - 5)
    onset = next((i for i in range(first, best_start) if voiced[i]), None)
    if onset is None:
        return "no voice where the aizuchi was aligned"
    start = max(0, onset - 1) * FRAME
    end = (best_start + min(best_length, TAIL_FRAMES)) * FRAME
    return {"samples": audio[start:end].copy(), "end": end, "pause_ms": best_length * 20, "voiced_ms": (best_start - onset) * 20}


def level(samples: np.ndarray, volume: float) -> np.ndarray:
    frames = samples[: len(samples) // FRAME * FRAME].reshape(-1, FRAME)
    rms = np.sqrt((frames**2).mean(axis=1))
    voiced = frames[rms >= VOICED_FRAME_RMS]
    gain = TARGET_RMS / np.sqrt((voiced**2).mean())
    gain = min(gain, PEAK_CEILING / np.abs(samples).max()) * volume
    out = samples * gain
    fade = int(0.03 * RATE)
    out[-fade:] *= np.linspace(1, 0, fade)
    return out


def main() -> int:
    voice, language, out_dir, candidates, report_path = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5]
    defs = json.load(sys.stdin)
    from mlx_audio.stt.utils import load_model as load_stt
    from mlx_audio.tts.utils import load_model as load_tts

    tts = load_tts(snapshot(TTS_MODEL, TTS_REVISION))
    asr = load_stt(snapshot(ASR_MODEL))
    aligner = load_stt(snapshot(ALIGNER_MODEL))
    os.makedirs(out_dir, exist_ok=True)

    manifest_path = os.path.join(out_dir, "manifest.json")
    kept = json.load(open(manifest_path))["clips"] if os.path.exists(manifest_path) else []
    kept = [clip for clip in kept if not any(clip["text"] == d["text"] for d in defs)]
    manifest, report = [], []
    for definition in defs:
        head = definition["text"]
        speed = float(definition.get("speedScale") or 1.0)
        text = head + ("" if head[-1] in "。、" else "、") + CARRIER
        # Generation goes on until enough candidates passed both checks, within a budget of attempts.
        scored, partial, rejected, attempts = [], [], [], 0
        while len(scored) < candidates and attempts < candidates * 6:
            attempts += 1
            parts = [np.asarray(r.audio, dtype=np.float32).reshape(-1) for r in tts.generate(text=text, voice=voice, lang_code=language, speed=speed, stream=False, verbose=False)]
            audio = np.concatenate(parts)
            # The aligner's Japanese tokenizer needs a package the runtime does not have. Its Chinese one
            # splits by character, which is what locating the end of the aizuchi needs anyway.
            items = list(aligner.generate(resample_16k(audio), text, language="Chinese"))
            found = cut(audio, items, head)
            if isinstance(found, str):
                rejected.append(found)
                continue
            heard = asr.generate(resample_16k(found["samples"]), language="Japanese").text.strip()
            rest = asr.generate(resample_16k(audio[found["end"]:]), language="Japanese").text.strip()
            found["heard"] = heard
            # The carrier must come back whole, which shows that none of the aizuchi was left outside the clip.
            if edit_distance(plain(rest), plain(CARRIER)) > 1:
                rejected.append(f'the carrier came back as "{rest}"')
            elif plain(heard) == plain(head):
                scored.append(found)
            elif plain(heard) and plain(heard) in plain(head):
                # The recognizer writes a doubled form such as "うんうん" once and drops a weak "えっ". With the
                # carrier intact the clip still holds everything spoken before it, so these stand in when no
                # reading is recognized word for word, and the review page marks them for the ear.
                partial.append(found)
            else:
                rejected.append(f'heard "{heard}"')
        found_exact = bool(scored)
        scored = scored or partial
        if not scored:
            print(f"{head}: no verified candidate in {attempts} generations ({'; '.join(rejected)})", file=sys.stderr)
            report.append({"text": head, "candidates": []})
            continue
        median = float(np.median([c["voiced_ms"] for c in scored]))
        for c in scored:
            c["score"] = min(c["pause_ms"], 300) / 300 - abs(c["voiced_ms"] - median) / median
        scored.sort(key=lambda c: -c["score"])
        file = f"{hashlib.sha1(json.dumps(definition, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:12]}.wav"
        clips = [level(c["samples"], float(definition.get("volumeScale") or 1.0)) for c in scored[:3]]
        with open(os.path.join(out_dir, file), "wb") as out:
            out.write(wav_bytes(clips[0]))
        # The entry repeats the definition as it is, without the keys it leaves out, so that the app can match the two.
        manifest.append({**definition, "file": file})
        report.append({
            "text": head,
            "usable": f"{len(scored)} of {attempts}",
            "exact": found_exact,
            "candidates": [
                {"ms": c["voiced_ms"], "pause_ms": c["pause_ms"], "heard": c["heard"], "audio": base64.b64encode(wav_bytes(clip)).decode("ascii")}
                for c, clip in zip(scored[:3], clips)
            ],
        })
        best = scored[0]
        print(f"{head}: {len(scored)} {'verified' if found_exact else 'partly recognized'} in {attempts} generations, chose {best['voiced_ms']} ms", file=sys.stderr)

    with open(manifest_path, "w") as out:
        clips = sorted(kept + manifest, key=lambda clip: clip["text"])
        json.dump({"voice": voice, "language": language, "model": f"{TTS_MODEL}@{TTS_REVISION}", "clips": clips}, out, ensure_ascii=False, indent=2)
        out.write("\n")
    # The libraries print to stdout while they load, so the report goes to a file.
    with open(report_path, "w") as out:
        json.dump({"voice": voice, "clips": report}, out, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
