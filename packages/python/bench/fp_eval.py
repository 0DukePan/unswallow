"""Cross-language false-positive / false-negative evaluation over the pinned
fixture corpus — the Python mirror of packages/bench/fp-eval.mjs.

Definitions and methodology are documented in docs/false-positives.md.
The pinned corpus is adversarial and small: numbers here are regression
counts over documented examples, NOT population estimates.

Run from the repo root:
    python packages/python/bench/fp_eval.py
    python packages/python/bench/fp_eval.py --check   # CI: exit nonzero on regression

Writes packages/python/bench/results_python_fp.{json,md}.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from unswallow import check_and_rescue

FIXTURES = Path(__file__).resolve().parent.parent.parent / "bench" / "fixtures"
RESULTS_DIR = Path(__file__).resolve().parent
RESULTS_JSON = RESULTS_DIR / "results_python_fp.json"
RESULTS_MD = RESULTS_DIR / "results_python_fp.md"

IS_CHECK = "--check" in sys.argv

WORDS = [
    "the", "user", "asked", "about", "weather", "tokyo", "need", "call", "tool",
    "reasoning", "carefully", "check", "arguments", "city", "answer", "would",
    "maybe", "perhaps", "use", "get_weather", "function", "could", "then", "final",
    "consider", "likely", "summarize", "directly", "instead", "schema", "emit",
]

OPENERS = [
    "< thinking>\nI could call get_weather",
    "< thinking>\nShould I call search? Maybe",
    "< thinking>\nThe user might expect a tool call here but",
]
MIDDLES = [
    " but the question does not actually require one.",
    ", yet no tool result is needed for this answer.",
    ". I will answer directly instead.",
    "; there is nothing to look up.",
]
TAILS = [
    " I will respond with what I know.\n< response>\n",
    " No tool call is warranted.\n< response>\n",
    " Let me just answer.\n< response>\n",
]


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


def label_of(fixture):
    expect = fixture.get("expect") or {}
    return "negative" if expect.get("detected") is False else "positive"


def run_fixture(fixture):
    opts = {"engine_hint": fixture.get("engine"), "engine_version": fixture.get("version")}
    return check_and_rescue(fixture["response"], **opts)


def synthetic_negatives():
    rng = mulberry32(0x66702D65)
    out = []
    for i in range(200):
        a = OPENERS[int(rng() * len(OPENERS))]
        b = MIDDLES[int(rng() * len(MIDDLES))]
        c = TAILS[int(rng() * len(TAILS))]
        text = a + b + c
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


def main():
    fixtures = []
    for f in sorted(FIXTURES.glob("*.json")):
        fixtures.append(json.loads(f.read_text(encoding="utf-8")))

    rows = []
    fp = 0
    fn = 0
    positives = 0
    negatives = 0
    for fixture in fixtures:
        if fixture.get("stream"):
            continue
        label = label_of(fixture)
        result = run_fixture(fixture)
        is_fp = label == "negative" and result.detected
        is_fn = label == "positive" and not result.detected
        if is_fp:
            fp += 1
        if is_fn:
            fn += 1
        if label == "positive":
            positives += 1
        else:
            negatives += 1
        rows.append(
            {
                "id": fixture.get("id"),
                "label": label,
                "expectedDetected": label == "positive",
                "detected": result.detected,
                "recovered": result.recovered,
                "pattern": result.pattern,
                "falsePositive": is_fp,
                "falseNegative": is_fn,
                "note": fixture.get("source") if label == "positive" else fixture.get("description"),
            }
        )

    synthetic = synthetic_negatives()
    synthetic_fp = sum(1 for s in synthetic if s["detected"])
    total = positives + negatives
    accuracy = (total - fp - fn) / total if total else None

    summary = {
        "corpus": {
            "pinnedPositives": positives,
            "pinnedNegatives": negatives,
            "syntheticNegatives": len(synthetic),
            "total": total + len(synthetic),
        },
        "results": {
            "falsePositives": fp,
            "falseNegatives": fn,
            "syntheticFalsePositives": synthetic_fp,
            "detectionAccuracy": accuracy,
        },
        "generatedAt": __import__("time").strftime("%Y-%m-%dT%H:%M:%SZ", __import__("time").gmtime()),
    }

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    (RESULTS_JSON).write_text(
        json.dumps({"summary": summary, "rows": rows, "synthetic": synthetic}, indent=2), encoding="utf-8"
    )

    lines = [
        "# unswallow — Python false-positive evaluation",
        "",
        "generated {}".format(summary["generatedAt"]),
        "",
        "Methodology and full definitions: [docs/false-positives.md](../../../docs/false-positives.md).",
        "",
        "The pinned corpus is adversarial and small — these are regression counts over documented examples, **not** population estimates.",
        "",
        "## Results",
        "",
        "| metric | count |",
        "| --- | --- |",
        "| pinned positive examples (real swallow shapes) | {} |".format(positives),
        "| pinned negative examples (discussion / near-miss) | {} |".format(negatives),
        "| seeded synthetic negatives | {} |".format(len(synthetic)),
        "| false positives (pinned negatives detected) | {} |".format(fp),
        "| false negatives (pinned positives missed) | {} |".format(fn),
        "| false positives (synthetic negatives) | {} |".format(synthetic_fp),
        "| detection accuracy on the pinned corpus | {} |".format(
            "n/a" if accuracy is None else "{:.1f}%".format(accuracy * 100)
        ),
        "",
        "## Pinned corpus",
        "",
        "| fixture | label | expected | detected | recovered | verdict |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for r in rows:
        verdict = "FALSE POSITIVE" if r["falsePositive"] else ("FALSE NEGATIVE" if r["falseNegative"] else "ok")
        lines.append(
            "| {} | {} | {} | {} | {} | {} |".format(
                r["id"],
                r["label"],
                "detect" if r["expectedDetected"] else "none",
                "yes" if r["detected"] else "no",
                "yes" if r["recovered"] else "no",
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
    report = "\n".join(lines)
    RESULTS_MD.write_text(report, encoding="utf-8")

    print(
        "fp-eval: {} positives, {} pinned negatives, {} synthetic negatives".format(
            positives, negatives, len(synthetic)
        )
    )
    print("  false positives: {} pinned, {} synthetic".format(fp, synthetic_fp))
    print("  false negatives: {}".format(fn))
    print(
        "  detection accuracy (pinned): {}".format(
            "n/a" if accuracy is None else "{:.1f}%".format(accuracy * 100)
        )
    )
    if IS_CHECK:
        if fp > 0 or fn > 0 or synthetic_fp > 0:
            print("fp-eval FAILED: false positives and/or false negatives on the pinned corpus", file=sys.stderr)
            for r in rows:
                if r["falsePositive"]:
                    print("  FALSE POSITIVE: {}".format(r["id"]), file=sys.stderr)
                if r["falseNegative"]:
                    print("  FALSE NEGATIVE: {}".format(r["id"]), file=sys.stderr)
            return 1
        print("fp-eval: no false positives, no false negatives on the pinned corpus")
    return 0


if __name__ == "__main__":
    sys.exit(main())
