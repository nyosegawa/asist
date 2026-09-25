#!/usr/bin/env python3
"""The aizuchi classifier worker (a fine-tuned ModernBERT-ja 70m, ONNX int8).

Reads one JSON request per line from stdin and answers with one line on stdout, prefixed with `ASIST_JSON:`.
  in : {"id": "...", "prev": "the previous assistant utterance, may be empty", "text": "the user's partial transcript"}
  out: {"type": "ready"}
       {"type": "result", "id": "...", "cls": "work", "prob": 0.93, "complete": 0.12}
       {"type": "error", "id": "...", "error": "..."}
       {"type": "fatal", "error": "..."}

The caller (shared/aizuchi-classifier.ts) normalizes the input, dropping punctuation and whitespace.
With `prev` the input is encoded as the pair <s> prev </s><s> text </s>, otherwise as text alone, as in training.
The model matches torch at batch=1; batches with padding are not used because that was not verified.
argv: the path to model.onnx, the path to tokenizer.json, the thread count. Downloading and pinning the files is
the main process's job (aizuchi-classifier.ts); this worker reads local files only and never uses the network.
"""

from __future__ import annotations

import json
import sys
import traceback

PREFIX = "ASIST_JSON:"
CLASSES = [
    "none", "flow", "ack", "work", "think", "check", "understand",
    "agree", "empathy", "cheer", "surprise", "correct", "hold",
]
MAX_TOKENS = 64


def emit(payload: dict) -> None:
    print(PREFIX + json.dumps(payload, ensure_ascii=False, separators=(",", ":")), flush=True)


def main() -> int:
    if len(sys.argv) != 4:
        emit({"type": "fatal", "error": "expected model path, tokenizer path and threads"})
        return 2
    model_path, tokenizer_path, threads = sys.argv[1], sys.argv[2], int(sys.argv[3])
    try:
        import numpy as np
        import onnxruntime as ort
        from tokenizers import Tokenizer

        tokenizer = Tokenizer.from_file(tokenizer_path)
        # A long input is truncated from prev, the first segment, because the user's own utterance is what
        # the decision rests on.
        tokenizer.enable_truncation(MAX_TOKENS, strategy="only_first")
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        session = ort.InferenceSession(model_path, options, providers=["CPUExecutionProvider"])

        def classify(prev: str, text: str) -> dict:
            encoding = tokenizer.encode(prev, text) if prev else tokenizer.encode(text)
            ids = np.asarray([encoding.ids], dtype=np.int64)
            mask = np.asarray([encoding.attention_mask], dtype=np.int64)
            cls_logits, complete_logit = session.run(None, {"input_ids": ids, "attention_mask": mask})
            logits = cls_logits[0].astype(np.float64)
            probs = np.exp(logits - logits.max())
            probs /= probs.sum()
            index = int(probs.argmax())
            complete = 1.0 / (1.0 + np.exp(-float(complete_logit[0])))
            return {"cls": CLASSES[index], "prob": round(float(probs[index]), 4), "complete": round(complete, 4)}

        # The first run is slow because the graph is being prepared, so it is warmed up before ready.
        classify("", "起動")
        emit({"type": "ready"})
    except Exception as error:  # noqa: BLE001
        emit({"type": "fatal", "error": str(error)})
        traceback.print_exc(file=sys.stderr)
        return 1

    for raw_line in sys.stdin:
        request_id = ""
        try:
            request = json.loads(raw_line)
            request_id = str(request["id"])
            text = str(request["text"])
            prev = str(request.get("prev") or "")
            if not text:
                raise ValueError("text is empty")
            emit({"type": "result", "id": request_id, **classify(prev, text)})
        except Exception as error:  # noqa: BLE001
            emit({"type": "error", "id": request_id, "error": str(error)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
