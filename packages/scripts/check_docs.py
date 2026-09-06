"""Docs link checker — validates internal markdown links.

Scans README.md, CONTRIBUTING.md, CHANGELOG.md and docs/*.md for inline
markdown links and image references, and fails when a relative target does
not exist on disk (anchor-only links and external http(s) URLs are skipped).
Code fences are ignored so example code does not produce false positives.

Run from the repo root:
    python packages/scripts/check_docs.py
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

FILES = [
    ROOT / "README.md",
    ROOT / "CONTRIBUTING.md",
    ROOT / "CHANGELOG.md",
    *sorted((ROOT / "docs").glob("*.md")),
    ROOT / "packages" / "matrix" / "README.md",
    ROOT / "packages" / "python" / "README.md",
]

LINK_RE = re.compile(r"\[[^\]]*\]\(([^)]+)\)")
IMG_RE = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")


def iter_md_links(text):
    for m in LINK_RE.finditer(text):
        yield m.group(1)
    for m in IMG_RE.finditer(text):
        yield m.group(1)


def in_code_fence(text, pos):
    fences = 0
    for line in text[:pos].splitlines(keepends=True):
        if line.lstrip().startswith(("```", "~~~")):
            fences += 1
    return fences % 2 == 1


def check_file(path):
    text = path.read_text(encoding="utf-8")
    problems = []
    for target in iter_md_links(text):
        target = target.strip()
        if not target or target.startswith(("#", "http://", "https://", "mailto:")):
            continue
        if "://" in target:  # any other protocol (e.g. git+https)
            continue
        if target.startswith("#"):
            continue
        # strip anchor part
        file_part = target.split("#")[0]
        if not file_part:
            continue
        if in_code_fence(text, text.find(target)):
            continue
        resolved = (path.parent / file_part).resolve()
        if not resolved.exists():
            problems.append("{} -> {} (missing)".format(path.relative_to(ROOT), target))
    return problems


def main():
    problems = []
    for path in FILES:
        if not path.exists():
            problems.append("missing doc file listed for checking: {}".format(path.relative_to(ROOT)))
            continue
        problems.extend(check_file(path))
    if problems:
        print("docs link check FAILED:")
        for p in problems:
            print("  " + p)
        return 1
    print("docs link check: {} files, all internal links resolve.".format(len(FILES)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
