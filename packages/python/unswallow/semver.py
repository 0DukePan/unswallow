from __future__ import annotations

from typing import List, Optional, Tuple

ComparatorOp = str


def parse_version(v: str) -> Optional[List[int]]:
    import re

    m = re.match(r"^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?", v)
    if not m:
        return None
    return [
        int(m.group(1)),
        int(m.group(2)) if m.group(2) else 0,
        int(m.group(3)) if m.group(3) else 0,
    ]


def parse_range(range_str: str) -> Optional[List[List[Tuple[ComparatorOp, List[int]]]]]:
    import re

    or_parts = [p.strip() for p in range_str.split("||") if p.strip()]
    comparators = []
    for part in or_parts:
        tokens = [t for t in part.split() if t]
        group = []
        for token in tokens:
            if token == "*":
                group.append((">=", [0, 0, 0]))
                continue
            m = re.match(r"^(<=|>=|<|>|=)?\s*(.+)$", token)
            if not m:
                return None
            op = m.group(1) or "="
            version = parse_version(m.group(2))
            if version is None:
                return None
            group.append((op, version))
        if not group:
            return None
        comparators.append(group)
    if not comparators:
        return None
    return comparators


def compare_versions(a: List[int], b: List[int]) -> int:
    for i in range(3):
        av = a[i] if i < len(a) else 0
        bv = b[i] if i < len(b) else 0
        if av != bv:
            return -1 if av < bv else 1
    return 0


def matches_range(version: str, range_str: str) -> bool:
    v = parse_version(version)
    if v is None:
        import re

        m = re.search(r"(\d+(?:\.\d+){0,2})", version)
        if m:
            v = parse_version(m.group(1))
    r = parse_range(range_str)
    if v is None or r is None:
        return False
    for group in r:
        if all(_cmp(v, op, target) for op, target in group):
            return True
    return False


def _cmp(v: List[int], op: str, target: List[int]) -> bool:
    c = compare_versions(v, target)
    if op == "=":
        return c == 0
    if op == ">":
        return c > 0
    if op == ">=":
        return c >= 0
    if op == "<":
        return c < 0
    if op == "<=":
        return c <= 0
    return False
