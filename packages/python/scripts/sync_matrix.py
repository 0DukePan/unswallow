"""Sync the engine matrix from packages/matrix into the Python package.

Run from the repo root after editing packages/matrix/data/engine-matrix.json:
    python packages/python/scripts/sync_matrix.py
CI verifies the copies stay identical (see .github/workflows/ci.yml).
"""

import hashlib
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "packages" / "matrix" / "data" / "engine-matrix.json"
TARGET = ROOT / "packages" / "python" / "unswallow" / "data" / "engine-matrix.json"


def main() -> int:
    if not SOURCE.exists():
        print("error: source matrix not found: {}".format(SOURCE), file=sys.stderr)
        return 1
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(SOURCE, TARGET)
    src_hash = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
    dst_hash = hashlib.sha256(TARGET.read_bytes()).hexdigest()
    print("synced {} -> {}".format(SOURCE, TARGET))
    print("sha256 {}".format(dst_hash))
    return 0 if src_hash == dst_hash else 1


if __name__ == "__main__":
    sys.exit(main())
