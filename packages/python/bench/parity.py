"""Cross-language parity bench: run the 15-fixture corpus through the Python core
and compare against the fixture expectations AND the exact confidence values
recorded by the TypeScript core in packages/bench/results/results.json.

Run from the repo root:
    python packages/python/bench/parity.py
"""

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from unswallow import check_and_rescue, check_and_rescue_stream

BENCH = Path(__file__).resolve().parents[1]
FIXTURES = BENCH.parent / "bench" / "fixtures"
TS_RESULTS = BENCH.parent / "bench" / "results" / "results.json"


def load_fixtures():
    out = []
    for f in sorted(FIXTURES.glob("*.json")):
        out.append(json.loads(f.read_text(encoding="utf-8")))
    return out


def run_fixture(fixture):
    opts = {
        "engine_hint": fixture.get("engine"),
        "engine_version": fixture.get("version"),
    }
    if fixture.get("stream"):
        chunks = fixture.get("chunks") or []

        async def run():
            return await check_and_rescue_stream(_iter(chunks), **opts)

        return asyncio.run(run())
    return check_and_rescue(fixture["response"], **opts)


async def _iter(chunks):
    for c in chunks:
        yield c


def main():
    fixtures = load_fixtures()
    ts_results = {}
    if TS_RESULTS.exists():
        ts_results = {r["id"]: r["actual"] for r in json.loads(TS_RESULTS.read_text(encoding="utf-8"))["results"]}

    failures = []
    rows = []
    for fixture in fixtures:
        fid = fixture.get("id") or fixture["response"].get("id", "?")
        expect = fixture.get("expect") or {}
        result = run_fixture(fixture)
        ts = ts_results.get(fid)
        issues = []
        if result.detected != expect.get("detected", False):
            issues.append("detected: py={} expected={}".format(result.detected, expect.get("detected")))
        if result.pattern != expect.get("pattern"):
            issues.append("pattern: py={} expected={}".format(result.pattern, expect.get("pattern")))
        if result.recovered != expect.get("recovered", False):
            issues.append("recovered: py={} expected={}".format(result.recovered, expect.get("recovered")))
        if result.confidence < expect.get("minConfidence", 0):
            issues.append("confidence: py={:.2f} < min={}".format(result.confidence, expect.get("minConfidence")))
        conf_match = "?"
        if ts is not None and ts.get("confidence") is not None:
            ts_conf = ts["confidence"]
            conf_match = "yes" if abs(ts_conf - result.confidence) < 1e-9 else "no"
            if conf_match == "no":
                issues.append("TS/Python confidence differ: ts={} py={}".format(ts_conf, result.confidence))
        if issues:
            failures.append((fid, issues))
        rows.append((fid, ts["confidence"] if ts else None, result.confidence, conf_match, "FAIL" if issues else "PASS"))

    print("cross-language parity — Python vs TypeScript on the pinned fixture corpus")
    print()
    print("| fixture | TS conf | Python conf | identical | status |")
    print("| --- | --- | --- | --- | --- |")
    for fid, ts_conf, py_conf, conf_match, status in rows:
        print("| {} | {} | {:.2f} | {} | {} |".format(fid, ("{:.2f}".format(ts_conf) if ts_conf is not None else "-"), py_conf, conf_match, status))

    n_pass = sum(1 for r in rows if r[4] == "PASS")
    print()
    print("{} / {} fixtures: expectations + exact confidence parity with the TypeScript core".format(n_pass, len(rows)))
    for fid, issues in failures:
        print("FAIL {}: {}".format(fid, "; ".join(issues)))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())