#!/usr/bin/env python3
"""ASIST-owned JSON-lines worker for the pinned Qwen3-TTS model on mlx-audio.

Reads one JSON object per line from stdin and answers on stdout, each line prefixed with `ASIST_JSON:`.
  in : {"id": "...", "text": "...", "voice": "ono_anna", "language": "japanese", "speed": 1.0}
       {"type": "cancel", "id": "..."}
  out: {"type": "ready", "sampleRate": 24000, "voices": [...], "languages": [...]}
       {"type": "chunk", "id": "...", "seq": 0, "pcm": "<base64 int16le mono>"}
       {"type": "end", "id": "...", "samples": 123456}
       {"type": "error", "id": "...", "error": "..."}
       {"type": "fatal", "error": "..."}

Audio leaves in chunks while the sentence is still being generated, so playback can start about 0.2 s
after the request instead of after the whole sentence. Requests are served one at a time in arrival
order. A cancel takes effect between two chunks, and a request cancelled before it starts is dropped.
argv: the model reference and its revision ("-" for the latest). The main process pins and downloads
the model; with HF_HUB_OFFLINE set this worker reads local files only.
"""

from __future__ import annotations

import base64
import json
import queue
import sys
import threading
import traceback

PREFIX = "ASIST_JSON:"
# Seconds of audio per chunk. Shorter chunks start playback sooner but cost more decoder calls.
STREAMING_INTERVAL = 0.5

_print_lock = threading.Lock()


def emit(payload: dict) -> None:
    with _print_lock:
        print(PREFIX + json.dumps(payload, ensure_ascii=False, separators=(",", ":")), flush=True)


def read_requests(requests: "queue.Queue[dict | None]", cancelled: set[str], lock: threading.Lock) -> None:
    for raw_line in sys.stdin:
        try:
            message = json.loads(raw_line)
        except json.JSONDecodeError:
            continue
        if message.get("type") == "cancel":
            with lock:
                cancelled.add(str(message.get("id", "")))
            continue
        requests.put(message)
    requests.put(None)


def main() -> int:
    if len(sys.argv) != 3:
        emit({"type": "fatal", "error": "expected model reference and revision"})
        return 2
    model_ref, revision = sys.argv[1:]
    try:
        import numpy as np
        from mlx_audio.tts.utils import load_model

        kwargs = {} if revision == "-" else {"revision": revision}
        model = load_model(model_ref, **kwargs)
        talker = model.config.talker_config
        voices = sorted((talker.spk_id or {}).keys())
        if not voices:
            raise RuntimeError("the model has no preset voices")
        # The first generation compiles kernels and is several times slower, so it happens before "ready".
        for _ in model.generate(text="あ", voice=voices[0], lang_code="auto", stream=False, verbose=False):
            pass
        emit({
            "type": "ready",
            "sampleRate": int(model.sample_rate),
            "voices": voices,
            "languages": sorted((talker.codec_language_id or {}).keys()),
        })
    except Exception as error:
        emit({"type": "fatal", "error": str(error)})
        traceback.print_exc(file=sys.stderr)
        return 1

    requests: "queue.Queue[dict | None]" = queue.Queue()
    cancelled: set[str] = set()
    lock = threading.Lock()
    threading.Thread(target=read_requests, args=(requests, cancelled, lock), daemon=True).start()

    def is_cancelled(request_id: str) -> bool:
        with lock:
            return request_id in cancelled

    while True:
        request = requests.get()
        if request is None:
            return 0
        request_id = str(request.get("id", ""))
        try:
            if is_cancelled(request_id):
                continue
            samples = 0
            seq = 0
            for result in model.generate(
                text=str(request["text"]),
                voice=request.get("voice"),
                lang_code=str(request.get("language") or "auto"),
                speed=float(request.get("speed") or 1.0),
                stream=True,
                streaming_interval=STREAMING_INTERVAL,
                verbose=False,
            ):
                if is_cancelled(request_id):
                    break
                audio = np.asarray(result.audio, dtype=np.float32).reshape(-1)
                pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2")
                emit({"type": "chunk", "id": request_id, "seq": seq, "pcm": base64.b64encode(pcm.tobytes()).decode("ascii")})
                samples += int(pcm.shape[0])
                seq += 1
            else:
                emit({"type": "end", "id": request_id, "samples": samples})
        except Exception as error:
            emit({"type": "error", "id": request_id, "error": str(error)})
            traceback.print_exc(file=sys.stderr)
        finally:
            with lock:
                cancelled.discard(request_id)


if __name__ == "__main__":
    raise SystemExit(main())
