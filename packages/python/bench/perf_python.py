"""Python performance benchmark — mirrors packages/bench/perf.mjs scenario-for-scenario
(identical seeded payload generation, same percentile methodology) so TS and Python
numbers are directly comparable.

Run from the repo root:
    python packages/python/bench/perf_python.py
"""

import asyncio
import copy
import gc
import hashlib
import json
import platform
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from unswallow import check_and_rescue, check_and_rescue_stream, extract_all_envelopes, sanitize_history
from unswallow.matrix import load_matrix, match_matrix_entry
from unswallow.stream import StreamAccumulator

WORDS = [
    "the", "user", "asked", "about", "weather", "tokyo", "berlin", "need", "call", "tool",
    "reasoning", "carefully", "check", "arguments", "city", "temperature", "report", "answer",
    "first", "should", "use", "get_weather", "function", "parse", "result", "then", "final",
    "consider", "likely", "state", "require", "estimate", "slight", "chance", "forecast",
    "humidity", "wind", "northwest", "degrees", "celsius", "clear", "cloudy", "evening",
    "morning", "summary", "request", "details", "source", "verify", "values", "exact",
    "roughly", "approximately", "decide", "plan", "approach", "correct", "fields", "schema",
]
CITIES = ["Tokyo", "Berlin", "Paris", "Oslo", "Shanghai", "Kyoto", "Rome", "Beijing", "Hangzhou", "Oslo"]


def mulberry32(seed):
    """Bit-for-bit match of the canonical implementation used by perf.mjs.
    The final `^ t` step is load-bearing: omitting it (as this function once
    did) silently produces a different sequence, which breaks the
    cross-language "same seeds, same payloads" guarantee."""
    a = seed & 0xFFFFFFFF

    def rng():
        nonlocal a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = ((a ^ (a >> 15)) * (a | 1)) & 0xFFFFFFFF
        # JS evaluates `t + Math.imul(t ^ t >>> 7, 61 | t) ^ t` with ToInt32
        # coercion on the sum before the XOR, so the sum must be masked here.
        t = ((t + ((t ^ (t >> 7)) * (t | 61))) & 0xFFFFFFFF) ^ t
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0

    return rng


def make_text(rng, target_bytes):
    out = ""
    while len(out.encode("utf-8")) < target_bytes:
        n = 6 + int(rng() * 14)
        words = [WORDS[int(rng() * len(WORDS))] for _ in range(n)]
        out += " ".join(words) + ".\n"
    return out


def make_payload(rng, scenario):
    city = CITIES[int(rng() * len(CITIES))]
    if scenario == "a-small":
        reasoning = "< thinking>\n" + make_text(rng, 2000 + rng() * 1000)
    elif scenario == "a-large":
        reasoning = "< thinking>\n" + make_text(rng, 64000)
    elif scenario == "a-huge":
        reasoning = "< thinking>\n" + make_text(rng, 1000000)
    elif scenario == "a-xml":
        reasoning = "< thinking>\n" + make_text(rng, 1500)
    elif scenario == "b-trailing":
        return {
            "model": "Kimi-K2-Thinking",
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {
                        "role": "assistant",
                        "content": '{"name": "get_weather", "arguments": {"city": "' + city + '"}}\n\n' + make_text(rng, 800),
                        "tool_calls": [],
                    },
                }
            ],
        }
    elif scenario == "c-leak":
        return {
            "model": "MiniMax-M3",
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {
                        "role": "assistant",
                        "content": "Here is the summary. <mm:think>" + make_text(rng, 300),
                        "tool_calls": [],
                    },
                }
            ],
        }
    elif scenario == "clean":
        return {
            "model": "Qwen/Qwen3.5-35B-A3B-FP8",
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "tool_calls",
                    "message": {
                        "role": "assistant",
                        "content": "",
                        "reasoning": "< thinking>\n" + make_text(rng, 800) + "\n< response>\n",
                        "tool_calls": [
                            {
                                "id": "call_abc",
                                "type": "function",
                                "function": {"name": "get_weather", "arguments": '{"city": "' + city + '"}'},
                            }
                        ],
                    },
                }
            ],
        }
    elif scenario == "fp-discussion":
        return {
            "model": "Qwen/Qwen3.5-35B-A3B-FP8",
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {
                        "role": "assistant",
                        "content": "",
                        "reasoning": (
                            "< thinking>\nI could call get_weather for " + city + " but no tool result is required here.\n"
                            + make_text(rng, 1200) + "\n< response>\n"
                        ),
                        "tool_calls": [],
                    },
                }
            ],
        }
    else:
        raise ValueError(scenario)

    if scenario in ("a-small", "a-large", "a-huge", "a-xml"):
        if scenario == "a-xml":
            envelope = "<tool_call>\n<function=get_weather>\n<parameter=city>\n" + city + "\n</parameter>\n</function>\n</tool_call>\n"
        else:
            envelope = '<tool_call>\n{"name": "get_weather", "arguments": {"city": "' + city + '"}}\n</tool_call>\n'
        reasoning += envelope + "< response>\n"
    return {
        "model": "Qwen/Qwen3.5-35B-A3B-FP8",
        "choices": [
            {
                "index": 0,
                "finish_reason": "stop",
                "message": {"role": "assistant", "content": "", "reasoning": reasoning, "tool_calls": []},
            }
        ],
    }


def percentile(sorted_samples, p):
    idx = min(len(sorted_samples) - 1, max(0, int(p * len(sorted_samples)) - 1))
    return sorted_samples[idx]


def _mean(arr):
    return sum(arr) / len(arr)


def _median(arr):
    s = sorted(arr)
    m = len(s) >> 1
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2


def measure(fn, iterations, warmup=200, runs=5):
    """Repeat-run measurement mirroring perf.mjs: `runs` full passes, each with
    its own warmup; percentiles from pooled samples; mean = median of the
    per-run means with the per-run min-max spread reported alongside."""
    per_run_means = []
    pooled = []
    for _ in range(runs):
        for _ in range(warmup):
            fn()
        samples = []
        for _ in range(iterations):
            t0 = time.perf_counter()
            fn()
            samples.append((time.perf_counter() - t0) * 1000.0)
        pooled.extend(samples)
        per_run_means.append(_mean(samples))
    sorted_samples = sorted(pooled)
    mean = _median(per_run_means)
    return {
        "n": iterations * runs,
        "runs": runs,
        "perRunN": iterations,
        "p50": percentile(sorted_samples, 0.5),
        "p95": percentile(sorted_samples, 0.95),
        "p99": percentile(sorted_samples, 0.99),
        "mean": mean,
        "meanMin": min(per_run_means),
        "meanMax": max(per_run_means),
        "perRunMeans": per_run_means,
        "opsPerSec": 1000.0 / mean,
    }


async def measure_stream_async(stream_fn, iterations, warmup=20, runs=3):
    per_run_means = []
    pooled = []
    for _ in range(runs):
        for _ in range(warmup):
            await stream_fn()
        samples = []
        for _ in range(iterations):
            t0 = time.perf_counter()
            await stream_fn()
            samples.append((time.perf_counter() - t0) * 1000.0)
        pooled.extend(samples)
        per_run_means.append(_mean(samples))
    sorted_samples = sorted(pooled)
    mean = _median(per_run_means)
    return {
        "n": iterations * runs,
        "runs": runs,
        "perRunN": iterations,
        "p50": percentile(sorted_samples, 0.5),
        "p95": percentile(sorted_samples, 0.95),
        "p99": percentile(sorted_samples, 0.99),
        "mean": mean,
        "meanMin": min(per_run_means),
        "meanMax": max(per_run_means),
        "perRunMeans": per_run_means,
        "opsPerSec": 1000.0 / mean,
    }


def measure_retained(fn, iterations):
    fn()
    gc.collect()
    import tracemalloc

    tracemalloc.start()
    for _ in range(iterations):
        fn()
    current, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    return {"iterations": iterations, "perOpBytes": (current / iterations) if iterations else 0}


SCENARIOS = [
    ("a-small", "Pattern A — small reasoning (~2–3KB)", 3000, 2000),
    ("a-xml", "Pattern A — function-XML envelope (~1.5KB)", 3000, 2000),
    ("a-large", "Pattern A — large reasoning (64KB)", 500, 200),
    ("a-huge", "Pattern A — 1MB reasoning", 100, 50),
    ("b-trailing", "Pattern B — trailing text in content", 2000, 1000),
    ("c-leak", "Pattern C — field leak (detection-only)", 2000, 1000),
    ("clean", "Healthy — tool_calls already populated", 2000, 1000),
    ("fp-discussion", "False-positive guard — discussion-only", 2000, 1000),
]


def _scan_balanced(text, start):
    depth = 0
    in_string = False
    escaped = False
    i = start
    while i < len(text):
        ch = text[i]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
        else:
            if ch == '"':
                in_string = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return i + 1
        i += 1
    return -1


NAIVE_MARKER = re.compile(r"<tool_call>|<function=|\{\"name\"\s*:")


def naive_check(message):
    text = "\n".join(
        message.get(f, "") if isinstance(message.get(f), str) else ""
        for f in ("reasoning", "reasoning_content", "thinking", "thought", "content")
    )
    if not NAIVE_MARKER.search(text):
        return {"found": False, "name": None}
    i = text.find("{")
    if i == -1:
        return {"found": True, "name": None}
    end = _scan_balanced(text, i)
    if end == -1:
        return {"found": True, "name": None}
    try:
        obj = json.loads(text[i:end])
        name = obj.get("name") if isinstance(obj, dict) else None
        return {"found": True, "name": name if isinstance(name, str) else None}
    except ValueError:
        return {"found": True, "name": None}


def probe_clone(payload):
    """The recovery deep copy mechanism (CPython shares immutable strings)."""
    return copy.deepcopy(payload)


def probe_scan(reasoning_text):
    """The envelope scan mechanism over the reasoning text."""
    return extract_all_envelopes(reasoning_text)


def probe_tracker_loop(chunks):
    """The streaming per-chunk leak-tracker loop (push only, no final check)."""
    acc = StreamAccumulator()
    for c in chunks:
        acc.push(c)
    return acc


async def main_async():
    rng = mulberry32(0x756E7377)
    payloads = {}
    sizes = {}
    for key, _label, _iters, _ret in SCENARIOS:
        payloads[key] = [make_payload(rng, key) for _ in range(50)]
        # separators match JSON.stringify byte-for-byte so reported sizes line
        # up with the TypeScript report.
        sizes[key] = round(
            sum(len(json.dumps(p, separators=(",", ":")).encode("utf-8")) for p in payloads[key]) / 50
        )
    # Cross-language corpus identity: must match the sha256 the TypeScript
    # harness records, or the "same seeds, same payloads" guarantee is broken.
    corpus_hash = hashlib.sha256(
        json.dumps(payloads["a-small"], separators=(",", ":")).encode("utf-8")
    ).hexdigest()

    check_rows = []
    for key, label, iters, ret_iters in SCENARIOS:
        pool = payloads[key]
        i = 0

        def run(pool=pool):
            nonlocal i
            p = pool[i % len(pool)]
            i += 1
            check_and_rescue(p)

        res = measure(run, iters)
        retained = measure_retained(run, ret_iters)
        check_rows.append({
            "scenario": key,
            "label": label,
            "payloadBytes": sizes[key],
            "n": res["n"],
            "runs": res["runs"],
            "p50": res["p50"],
            "p95": res["p95"],
            "p99": res["p99"],
            "mean": res["mean"],
            "meanMin": res["meanMin"],
            "meanMax": res["meanMax"],
            "perRunMeans": res["perRunMeans"],
            "opsPerSec": res["opsPerSec"],
            "retainedPerOpBytes": retained["perOpBytes"],
        })

    srng = mulberry32(0x53747265)
    reasoning = (
        "< thinking>\n" + make_text(srng, 20000)
        + '<tool_call>\n{"name": "get_weather", "arguments": {"city": "Tokyo"}}\n</tool_call>\n< response>\n'
    )
    stream_chunks = [
        {"choices": [{"index": 0, "finish_reason": None, "delta": {"reasoning": reasoning[i : i + 24]}}]}
        for i in range(0, len(reasoning), 24)
    ]
    stream_chunks.append({"choices": [{"index": 0, "finish_reason": "stop", "delta": {}}]})

    async def stream_run():
        await check_and_rescue_stream(_iter(stream_chunks), engine_hint="vllm", engine_version="0.19.0")

    stream_res = await measure_stream_async(stream_run, 300)

    history = []
    hrng = mulberry32(0x48697374)
    for i in range(40):
        if i % 2 == 0:
            content = "< thinking>\n" + make_text(hrng, 400) + "\n< response>\n" + make_text(hrng, 200)
        else:
            content = make_text(hrng, 300)
        msg = {"role": "user" if i % 3 == 0 else "assistant", "content": content}
        if i % 3 == 1:
            msg["reasoning"] = "< thinking>\n" + make_text(hrng, 400) + "\n< response>\n"
        history.append(msg)
    history_res = measure(lambda: sanitize_history(history), 3000)

    matrix_entries = load_matrix()
    mrng = mulberry32(0x4D6174)
    engines = ["vllm", "sglang", "llama.cpp"]
    versions = ["0.19.0", "0.23.4", "0.24.0", "0.26.0", "0.4.6", "b8461", "1.0.0"]
    patterns = ["A", "B", "C"]
    tuples = [
        (engines[int(mrng() * 3)], versions[int(mrng() * 7)], patterns[int(mrng() * 3)])
        for _ in range(100000)
    ]
    mi = 0

    def matrix_run():
        nonlocal mi
        e, v, p = tuples[mi % len(tuples)]
        mi += 1
        match_matrix_entry(matrix_entries, e, v, p)

    matrix_res = measure(matrix_run, 100000)

    baseline_rows = []
    for key, label, iters, _ret in SCENARIOS:
        pool = payloads[key]
        k = 0

        def naive_run(pool=pool):
            nonlocal k
            p = pool[k % len(pool)]
            k += 1
            naive_check(p["choices"][0]["message"])

        res = measure(naive_run, min(iters, 2000))
        baseline_rows.append(
            {
                "scenario": key,
                "label": label,
                "n": res["n"],
                "mean": res["mean"],
                "meanMin": res["meanMin"],
                "meanMax": res["meanMax"],
                "perRunMeans": res["perRunMeans"],
                "opsPerSec": res["opsPerSec"],
            }
        )

    baseline_fp = []
    fixtures_dir = Path(__file__).resolve().parent.parent.parent / "bench" / "fixtures"
    for f in sorted(fixtures_dir.glob("fp-guard-*.json")):
        fixture = json.loads(f.read_text(encoding="utf-8"))
        message = fixture["response"]["choices"][0]["message"]
        naive = naive_check(message)
        baseline_fp.append({"id": fixture.get("id") or f.name, "naiveFired": bool(naive["found"])})

    # Real fixture corpus — the pinned upstream-derived shapes, same harness.
    fixture_rows = []
    for f in sorted(fixtures_dir.glob("*.json")):
        fixture = json.loads(f.read_text(encoding="utf-8"))
        fid = fixture.get("id") or fixture.get("response", {}).get("id") or f.name
        opts = {"engine_hint": fixture.get("engine"), "engine_version": fixture.get("version")}
        payload = fixture.get("response") or fixture.get("chunks") or {}
        payload_bytes = len(json.dumps(payload).encode("utf-8"))
        if fixture.get("stream"):
            chunks = fixture.get("chunks") or []

            async def run_stream(chunks=chunks, opts=opts):
                await check_and_rescue_stream(_iter(chunks), **opts)

            res = await measure_stream_async(run_stream, 200, warmup=20, runs=3)
        else:
            response = fixture["response"]
            iters = max(100, min(3000, round(2_000_000 / max(1, payload_bytes))))

            def run(response=response, opts=opts):
                check_and_rescue(response, **opts)

            res = measure(run, iters, warmup=100, runs=3)
        fixture_rows.append({"id": fid, "stream": bool(fixture.get("stream")), "payloadBytes": payload_bytes, **res})

    # Component probes — the mechanisms cited in the README divergence note.
    huge = payloads["a-huge"][0]
    huge_reasoning = huge["choices"][0]["message"]["reasoning"]
    clone_res = measure(lambda: probe_clone(huge), 200, warmup=50, runs=3)
    scan_res = measure(lambda: probe_scan(huge_reasoning), 300, warmup=50, runs=3)
    tracker_loop_res = measure(lambda: probe_tracker_loop(stream_chunks), 200, warmup=50, runs=3)
    probes = {"clone": clone_res, "scan": scan_res, "trackerLoop": tracker_loop_res}
    probes_ctx = {
        "clonePayloadBytes": len(json.dumps(huge).encode("utf-8")),
        "scanBytes": len(huge_reasoning.encode("utf-8")),
        "trackerChunks": len(stream_chunks) - 1,
        "streamTotalMs": stream_res["mean"],
    }

    return check_rows, stream_chunks, stream_res, history_res, matrix_res, baseline_rows, baseline_fp, fixture_rows, probes, probes_ctx, corpus_hash


async def _iter(chunks):
    for c in chunks:
        yield c


def main():
    (
        check_rows,
        stream_chunks,
        stream_res,
        history_res,
        matrix_res,
        baseline_rows,
        baseline_fp,
        fixture_rows,
        probes,
        probes_ctx,
        corpus_hash,
    ) = asyncio.run(main_async())

    machine = {
        "platform": "{} {}".format(platform.system().lower(), platform.machine().lower()),
        "python": platform.python_version(),
        "date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    fmt = lambda r: "{:.2f} / {:.2f} / {:.2f} ms".format(r["p50"], r["p95"], r["p99"])  # noqa: E731
    fmt_spread = lambda r: "{:.3f} ms ({:.3f}\u2013{:.3f})".format(r["mean"], r["meanMin"], r["meanMax"])  # noqa: E731
    fmt_ops = lambda r: "{:,} ops/s".format(int(r["opsPerSec"]))  # noqa: E731

    lines = [
        "# unswallow — Python performance report",
        "",
        "measured {} · Python {} · {}".format(machine["date"], machine["python"], machine["platform"]),
        "",
        "Mirrors packages/bench/perf.mjs scenario-for-scenario (same seeds, same payload generation, same percentile methodology).",
        "",
        "Methodology: every scenario runs 5 full passes (3 for async work); percentiles are pooled across runs; the reported mean is the median of the per-run means, and the per-run min–max spread is in parentheses.",
        "",
        "Corpus identity: sha256 of the a-small payload pool is {} — the TypeScript report must carry the same hash (cross-language \"same seeds, same payloads\" check).".format(corpus_hash),
        "",
        "## check_and_rescue — latency per call (warm)",
        "",
        "| scenario | payload | n | p50 / p95 / p99 | mean (min–max) | throughput | retained/op |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for r in check_rows:
        lines.append(
            "| {} | {:.1f} KB | {} | {} | {} | {} | {:.2f} KB |".format(
                r["label"],
                r["payloadBytes"] / 1024,
                r["n"],
                fmt(r),
                fmt_spread(r),
                fmt_ops(r),
                r["retainedPerOpBytes"] / 1024,
            )
        )
    lines += [
        "",
        "## check_and_rescue_stream",
        "",
        "| stream | chunks | payload | p50 / p95 / p99 | mean (min–max) |",
        "| --- | --- | --- | --- | --- |",
        "| typical reasoning stream, envelope split across deltas | {} | 19.7 KB | {} | {} |".format(
            len(stream_chunks) - 1, fmt(stream_res), fmt_spread(stream_res)
        ),
        "",
        "## Component probes (why TS and Python diverge)",
        "",
        "The mechanisms cited in the README divergence note, measured in isolation on the same payloads: the recovery deep copy, the envelope scan over the reasoning text, and the streaming per-chunk leak-tracker loop (accumulator `push` only, no final check).",
        "",
        "| probe | payload | n | mean (min–max) |",
        "| --- | --- | --- | --- |",
        "| deep copy of 1 MB payload (copy.deepcopy) | {:.1f} KB | {} | {} |".format(probes_ctx["clonePayloadBytes"] / 1024, probes["clone"]["n"], fmt_spread(probes["clone"])),
        "| envelope scan of 1 MB reasoning (extract_all_envelopes) | {:.1f} KB | {} | {} |".format(probes_ctx["scanBytes"] / 1024, probes["scan"]["n"], fmt_spread(probes["scan"])),
        "| leak-tracker loop, {} chunk pushes (19.7 KB) | — | {} | {} |".format(probes_ctx["trackerChunks"], probes["trackerLoop"]["n"], fmt_spread(probes["trackerLoop"])),
        "",
        "## Pattern D — sanitizeHistory",
        "",
        "| corpus | p50 / p95 / p99 | mean (min–max) | throughput |",
        "| --- | --- | --- | --- |",
        "| 40-message history with leaked reasoning | {} | {} | {} |".format(fmt(history_res), fmt_spread(history_res), fmt_ops(history_res)),
        "",
        "## Matrix lookup — match_matrix_entry",
        "",
        "| workload | p50 / p95 / p99 | mean (min–max) | throughput |",
        "| --- | --- | --- | --- |",
        "| 100k lookups (engine/version/pattern) | {} | {} | {} |".format(fmt(matrix_res), fmt_spread(matrix_res), fmt_ops(matrix_res)),
        "",
        "## Naive baseline (marker scan, no validation, no recovery)",
        "",
        "What the simplest possible approach costs on the same payloads: one marker regex over the text channels plus a single `json.loads` attempt, no envelope validation, no false-positive guard, nothing recovered.",
        "",
        "| scenario | mean (min–max) | throughput |",
        "| --- | --- | --- |",
    ]
    for r in baseline_rows:
        lines.append("| {} | {} | {} |".format(r["label"], fmt_spread(r), fmt_ops(r)))
    fired = [f["id"] for f in baseline_fp if f["naiveFired"]]
    lines += [
        "",
        "False positives on the pinned guard fixtures (naive fired where nothing should recover): {}/{} ({})".format(
            len(fired), len(baseline_fp), ", ".join(fired) if fired else "none"
        ),
        "",
        "## Real fixture corpus (pinned upstream-derived shapes)",
        "",
        "The hash-pinned fixtures run through the same harness as the synthetic scenarios — real upstream-derived shapes (reconstructed from the linked vLLM/SGLang/llama.cpp reports), including the false-positive guards.",
        "",
        "| fixture | stream | payload | n | mean (min–max) | throughput |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for r in fixture_rows:
        lines.append(
            "| {} | {} | {:.1f} KB | {} | {} | {} |".format(
                r["id"], "yes" if r["stream"] else "no", r["payloadBytes"] / 1024, r["n"], fmt_spread(r), fmt_ops(r)
            )
        )
    lines += [""]
    report = "\n".join(lines)

    out_dir = Path(__file__).resolve().parent
    (out_dir / "results_python.md").write_text(report, encoding="utf-8")
    (out_dir / "results_python.json").write_text(
        json.dumps(
            {
                "machine": machine,
                "corpusHash": corpus_hash,
                "checkAndRescue": check_rows,
                "baseline": baseline_rows,
                "baselineFp": baseline_fp,
                "streaming": stream_res,
                "history": history_res,
                "matrix": matrix_res,
                "probes": probes,
                "probesCtx": probes_ctx,
                "fixtures": fixture_rows,
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    print(report)
    print("report written to packages/python/bench/results_python.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
