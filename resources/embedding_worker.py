#!/usr/bin/env python3
"""The embedding worker for memory search (multilingual-e5 small, ONNX int8).

Reads one JSON request per line from stdin and answers with one line on stdout, prefixed with `ASIST_JSON:`.
  in : {"id": "...", "kind": "query" | "document", "texts": ["...", ...]}
  out: {"type": "ready", "dim": 384}
       {"type": "result", "id": "...", "vectors": ["<base64 float32le>", ...]}
       {"type": "error", "id": "...", "error": "..."}
       {"type": "fatal", "error": "..."}

multilingual-e5 is trained with a prefix per purpose, so the worker prepends "query: " or "passage: " according
to `kind`; the caller never deals with the prefix.
The ONNX model returns only last_hidden_state, so the worker mean-pools it with the attention mask and
normalizes it, as the Pooling layer of the original sentence-transformers model does. Cosine similarity is
then a dot product.
argv: the path to model.onnx, the path to tokenizer.json, the thread count. Downloading and pinning the files is
the main process's job (embedding.ts); this worker reads local files only and never uses the network.
"""

from __future__ import annotations

import base64
import json
import sys
import traceback

PREFIX = "ASIST_JSON:"
PREFIXES = {"query": "query: ", "document": "passage: "}
MAX_TOKENS = 512
BATCH = 16


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
        tokenizer.enable_truncation(MAX_TOKENS)
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        session = ort.InferenceSession(model_path, options, providers=["CPUExecutionProvider"])
        # A BERT-style export also takes token_type_ids, which are all zero for a single segment.
        takes_token_types = any(node.name == "token_type_ids" for node in session.get_inputs())

        def encode(texts: list[str]) -> np.ndarray:
            encodings = tokenizer.encode_batch(texts)
            length = max(len(e.ids) for e in encodings)
            ids = np.zeros((len(encodings), length), dtype=np.int64)
            mask = np.zeros((len(encodings), length), dtype=np.int64)
            for row, e in enumerate(encodings):
                ids[row, : len(e.ids)] = e.ids
                mask[row, : len(e.ids)] = e.attention_mask
            feed = {"input_ids": ids, "attention_mask": mask}
            if takes_token_types:
                feed["token_type_ids"] = np.zeros_like(ids)
            hidden = session.run(None, feed)[0].astype(np.float32)
            weights = mask.astype(np.float32)[:, :, None]
            pooled = (hidden * weights).sum(1) / np.maximum(weights.sum(1), 1.0)
            norms = np.linalg.norm(pooled, axis=1, keepdims=True)
            return pooled / np.maximum(norms, 1e-12)

        # The first run is slow because the graph is being prepared, so it is warmed up before ready.
        dim = int(encode([PREFIXES["query"] + "warm up"]).shape[1])
        emit({"type": "ready", "dim": dim})
    except Exception as error:  # noqa: BLE001
        emit({"type": "fatal", "error": str(error)})
        traceback.print_exc(file=sys.stderr)
        return 1

    for raw_line in sys.stdin:
        request_id = ""
        try:
            request = json.loads(raw_line)
            request_id = str(request["id"])
            kind = str(request["kind"])
            if kind not in PREFIXES:
                raise ValueError(f"unknown kind: {kind}")
            texts = [PREFIXES[kind] + str(text) for text in request["texts"]]
            encoded: list[str] = []
            for start in range(0, len(texts), BATCH):
                for vector in encode(texts[start : start + BATCH]):
                    encoded.append(base64.b64encode(np.asarray(vector, dtype="<f4").tobytes()).decode("ascii"))
            emit({"type": "result", "id": request_id, "vectors": encoded})
        except Exception as error:  # noqa: BLE001
            emit({"type": "error", "id": request_id, "error": str(error)})
            traceback.print_exc(file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
