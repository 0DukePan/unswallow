from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Dict, List, Optional

from .semver import matches_range, parse_range
from .types import EngineId, SwallowMatrixEntry, ToolPattern

BUNDLED_MATRIX = Path(__file__).parent / "data" / "engine-matrix.json"
ENV_MATRIX = os.environ.get("UNSWALLOW_MATRIX_PATH")


def load_matrix(custom: Optional[List[SwallowMatrixEntry]] = None) -> List[SwallowMatrixEntry]:
    if custom:
        return custom
    candidates = []
    if ENV_MATRIX:
        candidates.append(Path(ENV_MATRIX))
    candidates.append(BUNDLED_MATRIX)
    for p in candidates:
        try:
            raw = json.loads(p.read_text(encoding="utf-8"))
            entries = raw.get("entries", [])
            if isinstance(entries, list) and entries:
                return [SwallowMatrixEntry.from_json(row) for row in entries]
        except (OSError, ValueError):
            continue
    return []


def get_matrix_file(custom: Optional[List[SwallowMatrixEntry]] = None) -> Dict[str, object]:
    if custom:
        return {"matrixVersion": "custom", "updated": "n/a", "entries": custom}
    candidates = []
    if ENV_MATRIX:
        candidates.append(Path(ENV_MATRIX))
    candidates.append(BUNDLED_MATRIX)
    for p in candidates:
        try:
            raw = json.loads(p.read_text(encoding="utf-8"))
            raw["entries"] = [SwallowMatrixEntry.from_json(row) for row in raw.get("entries", [])]
            return raw
        except (OSError, ValueError):
            continue
    return {"matrixVersion": "none", "updated": "n/a", "entries": []}


def normalize_engine(hint: Optional[str]) -> str:
    if not hint:
        return "unknown"
    h = hint.strip().lower().replace("-", "").replace("_", "").replace(" ", "").replace(".", "")
    if h == "vllm":
        return "vllm"
    if h == "sglang":
        return "sglang"
    if h in ("llamacpp", "llama"):
        return "llama.cpp"
    return "unknown"


def _comparator_count(range_str: str) -> int:
    r = parse_range(range_str)
    if not r:
        return 0
    return max(len(group) for group in r)


def match_matrix_entry(
    entries: List[SwallowMatrixEntry],
    engine: EngineId,
    version: str,
    pattern: ToolPattern,
) -> Optional[SwallowMatrixEntry]:
    candidates = [
        e
        for e in entries
        if e.engine == engine and e.pattern == pattern and matches_range(version, e.version_range)
    ]
    if not candidates:
        return None
    candidates.sort(key=lambda e: _comparator_count(e.version_range), reverse=True)
    return candidates[0]
