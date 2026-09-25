#!/usr/bin/env python3
"""Downloads one Hugging Face repository at a pinned revision into the shared cache.

argv: the repository and the revision. It prints one JSON line with the total size in bytes before
downloading, so that the main process can show progress from the size of the cache, and exits with 0
once every file is in the snapshot.
"""

from __future__ import annotations

import json
import sys
import traceback

from huggingface_hub import HfApi, snapshot_download

PREFIX = "ASIST_JSON:"


def emit(payload: dict) -> None:
    print(PREFIX + json.dumps(payload), flush=True)


def main() -> int:
    if len(sys.argv) != 3:
        emit({"type": "fatal", "error": "expected repository and revision"})
        return 2
    repo, revision = sys.argv[1:]
    try:
        info = HfApi().model_info(repo, revision=revision, files_metadata=True)
        emit({"type": "total", "bytes": sum(sibling.size or 0 for sibling in info.siblings or [])})
        snapshot_download(repo, revision=revision)
    except Exception as error:
        emit({"type": "fatal", "error": str(error)})
        traceback.print_exc(file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
