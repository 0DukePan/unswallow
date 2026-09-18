"""Cross-language false-positive / safety evaluation over the pinned fixture
corpus — the Python mirror of packages/bench/fp-eval.mjs.

Three levels are kept strictly separate (see docs/false-positives.md):
ground truth (`groundTruth.classification` / `recoverable`), detector output
(`detected` + `confidence`), and recovery (`recovered` + `recoveredCalls`).

The pinned corpus is adversarial and small: these are regression counts over
documented examples, NOT population estimates.

Run from the repo root:
    python packages/python/bench/fp_eval.py
    python packages/python/bench/fp_eval.py --check   # CI: exit nonzero on regression

Writes packages/python/bench/results_python_fp.{json,md}.
"""

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from unswallow import check_and_rescue

FIXTURES = Path(__file__).resolve().parent.parent.parent / "bench" / "fixtures"
RESULTS_DIR = Path(__file__).resolve().parent
RESULTS_JSON = RESULTS_DIR / "results_python_fp.json"
RESULTS_MD = RESULTS_DIR / "results_python_fp.md"

IS_CHECK = "--check" in sys.argv


def mulberry32(seed):
    """Bit-for-bit mirror of the canonical implementation (see perf_python.py)."""
    a = seed & 0xFFFFFFFF

    def rng():
        nonlocal a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = ((a ^ (a >> 15)) * (a | 1)) & 0xFFFFFFFF
        t = ((t + ((t ^ (t >> 7)) * (t | 61))) & 0xFFFFFFFF) ^ t
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0

    return rng


def ground_truth_of(fixture):
    gt = fixture.get("groundTruth") or {}
    recoverable = gt.get("recoverable")
    if not isinstance(recoverable, bool):
        recoverable = (fixture.get("expect") or {}).get("detected", False) is not False
    return {"classification": gt.get("classification"), "recoverable": recoverable}


def run_fixture(fixture):
    opts = {"engine_hint": fixture.get("engine"), "engine_version": fixture.get("version")}
    if isinstance(fixture.get("toolSchemas"), list):
        opts["tool_schemas"] = fixture["toolSchemas"]
    return check_and_rescue(fixture["response"], **opts)


def synthetic_negatives():
    rng = mulberry32(0x66702D65)
    openers = [
        "< thinking>\nI could call get_weather",
        "< thinking>\nShould I call search? Maybe",
        "< thinking>\nThe user might expect a tool call here but",
    ]
    middles = [
        " but the question does not actually require one.",
        ", yet no tool result is needed for this answer.",
        ". I will answer directly instead.",
        "; there is nothing to look up.",
    ]
    tails = [
        " I will respond with what I know.\n< response>\n",
        " No tool call is warranted.\n< response>\n",
        " Let me just answer.\n< response>\n",
    ]
    out = []
    for i in range(200):
        text = openers[int(rng() * len(openers))] + middles[int(rng() * len(middles))] + tails[int(rng() * len(tails))]
        result = check_and_rescue(
            {
                "id": "synneg-{}".format(i),
                "object": "chat.completion",
                "model": "synthetic",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": "", "reasoning": text, "tool_calls": []},
                    }
                ],
            },
            engine_hint="vllm",
            engine_version="0.19.0",
        )
        out.append({"id": "synthetic-negative-{}".format(i), "text": text, "detected": result.detected})
    return out


def matrix_meta():
    try:
        raw = json.loads((FIXTURES.parent.parent / "matrix" / "data" / "engine-matrix.json").read_text(encoding="utf-8"))
        engines = sorted({e.get("engine") for e in raw.get("entries", []) if e.get("engine")})
        return {
            "matrixVersion": raw.get("matrixVersion"),
            "updated": raw.get("updated"),
            "engines": engines,
            "entries": len(raw.get("entries", [])),
        }
    except (OSError, ValueError):
        return {"matrixVersion": None, "updated": None, "engines": [], "entries": 0}


def pct(value):
    return "n/a" if value is None else "{:.1f}%".format(value * 100)


def main():
    fixtures = [json.loads(f.read_text(encoding="utf-8")) for f in sorted(FIXTURES.glob("*.json"))]
    meta = matrix_meta()
    rows = []
    false_negatives = 0
    unsafe_recoveries = 0
    detection_fps = 0
    genuine = 0
    genuine_detected = 0
    non_executable = 0
    non_executable_candidate_detected = 0
    intended_recovered_calls = 0
    unintended_recovered_calls = 0
    reconstruction_checked = 0
    reconstruction_ok = 0
    category_stats = {}

    for fixture in fixtures:
        if fixture.get("stream"):
            continue
        gt = ground_truth_of(fixture)
        result = run_fixture(fixture)
        recovered_call_count = len(result.recovered_calls) if result.recovered and result.recovered_calls else 0
        is_genuine = gt["classification"] == "swallowed_tool_call"
        is_false_negative = gt["recoverable"] and not result.detected
        is_unsafe_recovery = not gt["recoverable"] and result.recovered
        # Pattern C field-leak detections are a separate detection class, not a
        # tool-call candidate flag.
        is_detection_fp = not gt["recoverable"] and result.detected and result.pattern != "C"

        if is_genuine:
            genuine += 1
            if result.detected:
                genuine_detected += 1
        if not gt["recoverable"]:
            non_executable += 1
            if result.detected and result.pattern != "C":
                non_executable_candidate_detected += 1
        if is_false_negative:
            false_negatives += 1
        if is_unsafe_recovery:
            unsafe_recoveries += 1
        if is_detection_fp:
            detection_fps += 1
        if gt["recoverable"]:
            intended_recovered_calls += recovered_call_count
        else:
            unintended_recovered_calls += recovered_call_count

        reconstruction = None
        expected_calls = (fixture.get("groundTruth") or {}).get("expectedCalls")
        if isinstance(expected_calls, list) and result.recovered:
            reconstruction_checked += 1
            actual = [{"name": c.name, "arguments": c.arguments} for c in (result.recovered_calls or [])]
            reconstruction = "ok" if actual == expected_calls else "FAIL"
            if reconstruction == "ok":
                reconstruction_ok += 1

        key = gt["classification"] or "(none)"
        stat = category_stats.setdefault(
            key, {"classification": key, "fixtures": 0, "detected": 0, "recovered": 0, "recoverable": 0}
        )
        stat["fixtures"] += 1
        if result.detected:
            stat["detected"] += 1
        if result.recovered:
            stat["recovered"] += 1
        if gt["recoverable"]:
            stat["recoverable"] += 1

        rows.append(
            {
                "id": fixture.get("id"),
                "classification": gt["classification"],
                "recoverable": gt["recoverable"],
                "detected": result.detected,
                "recovered": result.recovered,
                "recoveredCallCount": recovered_call_count,
                "category": result.category,
                "falseNegative": is_false_negative,
                "detectionFalsePositive": is_detection_fp,
                "unsafeRecovery": is_unsafe_recovery,
                "reconstruction": reconstruction,
                "note": fixture.get("source") if gt["recoverable"] else (fixture.get("groundTruth") or {}).get("reason") or fixture.get("description"),
            }
        )

    synthetic = synthetic_negatives()
    synthetic_fp = sum(1 for s in synthetic if s["detected"])
    total_recovered_calls = intended_recovered_calls + unintended_recovered_calls

    summary = {
        "corpus": {
            "pinnedFixtures": len(rows),
            "genuineSwallows": genuine,
            "nonExecutableCases": non_executable,
            "syntheticNegatives": len(synthetic),
        },
        "results": {
            "falseNegatives": false_negatives,
            "detectionFalsePositives": detection_fps,
            "unsafeRecoveries": unsafe_recoveries,
            "syntheticFalsePositives": synthetic_fp,
            "metrics": {
                "detectionRecall": (genuine_detected / genuine) if genuine else None,
                "detectionFalsePositiveRate": (non_executable_candidate_detected / non_executable) if non_executable else None,
                "unsafeRecoveryRate": (unsafe_recoveries / non_executable) if non_executable else None,
                "recoveryPrecision": (intended_recovered_calls / total_recovered_calls) if total_recovered_calls else None,
                "reconstructionCorrectness": (reconstruction_ok / reconstruction_checked) if reconstruction_checked else None,
            },
            "recoveredCalls": {"intended": intended_recovered_calls, "unintended": unintended_recovered_calls},
            "engineMatrix": meta,
        },
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    RESULTS_JSON.write_text(json.dumps({"summary": summary, "rows": rows, "synthetic": synthetic}, indent=2), encoding="utf-8")

    categories = sorted(category_stats.values(), key=lambda c: c["classification"])
    lines = [
        "# unswallow — Python false-positive & safety evaluation",
        "",
        "generated {}".format(summary["generatedAt"]),
        "",
        "Methodology and full definitions: [docs/false-positives.md](../../../docs/false-positives.md).",
        "",
        "Evaluation engine matrix: v{} (updated {}) — {}, {} rows.".format(
            meta["matrixVersion"] or "?",
            meta["updated"] or "?",
            ", ".join(meta["engines"]) or "none",
            meta["entries"],
        ),
        "",
        "The pinned corpus is adversarial and small — these are regression counts over documented examples, **not** population estimates.",
        "",
        "## Safety headline",
        "",
        "| metric | value |",
        "| --- | --- |",
        "| detection recall (genuine swallows found) | {} ({}/{}) |".format(pct(summary["results"]["metrics"]["detectionRecall"]), genuine_detected, genuine),
        "| **unsafe recovery rate** (non-executable recovered) | {} ({}/{}) |".format(pct(summary["results"]["metrics"]["unsafeRecoveryRate"]), unsafe_recoveries, non_executable),
        "| recovery precision (intended ÷ all recovered calls) | {} ({}/{}) |".format(pct(summary["results"]["metrics"]["recoveryPrecision"]), intended_recovered_calls, total_recovered_calls),
        "| detection false-positive rate (non-executable flagged) | {} ({}/{}) |".format(pct(summary["results"]["metrics"]["detectionFalsePositiveRate"]), non_executable_candidate_detected, non_executable),
        "| reconstruction correctness (recovered == expectedCalls) | {} ({}/{}) |".format(pct(summary["results"]["metrics"]["reconstructionCorrectness"]), reconstruction_ok, reconstruction_checked),
        "| false negatives (genuine swallows missed) | {} |".format(false_negatives),
        "| false positives on seeded synthetic negatives | {}/{} |".format(synthetic_fp, len(synthetic)),
        "",
        "Detection false positives are a candidate-classification event (annoying, low-stakes);",
        "unsafe recovery is the dangerous failure mode and is gated separately — the CI check fails on any nonzero unsafe recovery.",
        "",
        "## Per-category outcomes",
        "",
        "| classification | fixtures | detected | recovered | recoverable |",
        "| --- | --- | --- | --- | --- |",
    ]
    for c in categories:
        lines.append("| {} | {} | {} | {} | {} |".format(c["classification"], c["fixtures"], c["detected"], c["recovered"], c["recoverable"]))
    lines += [
        "",
        "## Pinned corpus",
        "",
        "| fixture | classification | recoverable | detected | category | recovered | calls | verdict |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for r in rows:
        if r["unsafeRecovery"]:
            verdict = "**UNSAFE RECOVERY**"
        elif r["falseNegative"]:
            verdict = "FALSE NEGATIVE"
        elif r["reconstruction"] == "FAIL":
            verdict = "RECONSTRUCTION FAIL"
        else:
            verdict = "ok"
        lines.append(
            "| {} | {} | {} | {} | {} | {} | {} | {} |".format(
                r["id"],
                r["classification"] or "—",
                "yes" if r["recoverable"] else "no",
                "yes" if r["detected"] else "no",
                r["category"] or "—",
                "yes" if r["recovered"] else "no",
                str(r["recoveredCallCount"]) if r["recovered"] else "—",
                verdict,
            )
        )
    lines += [
        "",
        "## Seeded synthetic negatives",
        "",
        "200 seeded discussion-only reasoning samples (mulberry32 seed 0x66702d65) — a model thinking *about* calling a tool, never invoking one.",
        "",
        "False positives on the synthetic negatives: {}/{}".format(synthetic_fp, len(synthetic)),
        "",
    ]
    RESULTS_MD.write_text("\n".join(lines), encoding="utf-8")

    print("fp-eval: {} pinned fixtures ({} genuine, {} non-executable), {} synthetic negatives".format(len(rows), genuine, non_executable, len(synthetic)))
    print("  detection recall: {}".format(pct(summary["results"]["metrics"]["detectionRecall"])))
    print("  unsafe recoveries: {} (rate {})".format(unsafe_recoveries, pct(summary["results"]["metrics"]["unsafeRecoveryRate"])))
    print("  recovery precision: {}".format(pct(summary["results"]["metrics"]["recoveryPrecision"])))
    print("  detection false positives: {} (rate {})".format(detection_fps, pct(summary["results"]["metrics"]["detectionFalsePositiveRate"])))
    print("  reconstruction: {}/{} ok".format(reconstruction_ok, reconstruction_checked))
    print("  false negatives: {}".format(false_negatives))
    if IS_CHECK:
        if unsafe_recoveries > 0 or false_negatives > 0 or synthetic_fp > 0:
            print("fp-eval FAILED: unsafe recoveries and/or false negatives on the pinned corpus", file=sys.stderr)
            for r in rows:
                if r["unsafeRecovery"]:
                    print("  UNSAFE RECOVERY: {}".format(r["id"]), file=sys.stderr)
                if r["falseNegative"]:
                    print("  FALSE NEGATIVE: {}".format(r["id"]), file=sys.stderr)
            return 1
        print("fp-eval: no unsafe recoveries, no false negatives on the pinned corpus")
    return 0


if __name__ == "__main__":
    sys.exit(main())
