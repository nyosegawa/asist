#!/usr/bin/env python3
"""ASIST-owned JSON-lines worker for pinned mlx-audio STT models."""

from __future__ import annotations

import json
import os
import sys
import traceback

from mlx_audio.stt.generate import generate_transcription
from mlx_audio.stt.utils import load_model

PREFIX = "ASIST_JSON:"


def emit(payload: dict) -> None:
    print(PREFIX + json.dumps(payload, ensure_ascii=False), flush=True)


def main() -> int:
    if len(sys.argv) != 3:
        emit({"type": "fatal", "error": "expected model reference and revision"})
        return 2

    model_ref, revision = sys.argv[1:]
    try:
        kwargs = {} if revision == "-" else {"revision": revision}
        model = load_model(model_ref, **kwargs)
        emit({"type": "ready"})
    except Exception as error:
        emit({"type": "fatal", "error": str(error)})
        traceback.print_exc(file=sys.stderr)
        return 1

    for raw_line in sys.stdin:
        try:
            request = json.loads(raw_line)
            request_id = str(request["id"])
            # generate_transcription filters kwargs against each model signature.
            # Whisper therefore uses its real long-form path with explicit 30 s
            # windows, while Qwen uses its own automatic chunking implementation.
            output_base = str(request["wavPath"]) + ".transcript"
            try:
                result = generate_transcription(
                    model=model,
                    audio=str(request["wavPath"]),
                    output_path=output_base,
                    format="txt",
                    verbose=None,
                    # The caller sends the language of the conversation in the form this model
                    # takes: Qwen3-ASR an English name, Whisper an ISO 639-1 code.
                    language=str(request["language"]),
                    chunk_duration=30.0,
                    temperature=0.0,
                )
            finally:
                try:
                    os.unlink(output_base + ".txt")
                except FileNotFoundError:
                    pass
            emit({"type": "result", "id": request_id, "text": result.text.strip()})
        except Exception as error:
            request_id = str(request.get("id", "")) if "request" in locals() else ""
            emit({"type": "error", "id": request_id, "error": str(error)})
            traceback.print_exc(file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
