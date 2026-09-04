"""Python performance benchmark — mirrors packages/bench/perf.mjs scenario-for-scenario
(identical seeded payload generation, same percentile methodology) so TS and Python
numbers are directly comparable.

Run from the repo root:
    python packages/python/bench/perf_python.py
"""

import asyncio
import gc
import json
import platform
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from unswallow import check_and_rescue, check_and_rescue_stream, sanitize_history
from unswallow.matrix import load_matrix, match_matrix_entry

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
    a = seed & 0xFFFFFFFF

    def rng():
        nonlocal a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = a
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        t = (t + ((t ^ (t >> 7)) * (t | 61))) & 0xFFFFFFFF
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


def measure(fn, iterations, warmup=200):
    for _ in range(warmup):
        fn()
    samples = []
    for _ in range(iterations):
        t0 = time.perf_counter()
        fn()
        samples.append((time.perf_counter() - t0) * 1000.0)
    sorted_samples = sorted(samples)
    mean = sum(samples) / iterations
    return {
        "n": iterations,
        "p50": percentile(sorted_samples, 0.5),
        "p95": percentile(sorted_samples, 0.95),
        "p99": percentile(sorted_samples, 0.99),
        "mean": mean,
        "opsPerSec": 1000.0 / mean,
    }


async def measure_stream_async(stream_fn, iterations, warmup=20):
    for _ in range(warmup):
        await stream_fn()
    samples = []
    for _ in range(iterations):
        t0 = time.perf_counter()
        await stream_fn()
        samples.append((time.perf_counter() - t0) * 1000.0)
    sorted_samples = sorted(samples)
    mean = sum(samples) / iterations
    return {
        "n": iterations,
        "p50": percentile(sorted_samples, 0.5),
        "p95": percentile(sorted_samples, 0.95),
        "p99": percentile(sorted_samples, 0.99),
        "mean": mean,
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


async def main_async():
    rng = mulberry32(0x756E7377)
    payloads = {}
    sizes = {}
    for key, _label, _iters, _ret in SCENARIOS:
        payloads[key] = [make_payload(rng, key) for _ in range(50)]
        sizes[key] = round(sum(len(json.dumps(p).encode("utf-8")) for p in payloads[key]) / 50)

    check_rows = []
    for key, label, iters, ret_iters in SCENARIOS:
        pool = payloads[key]
        i = 0

        def run():
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
            "p50": res["p50"],
            "p95": res["p95"],
            "p99": res["p99"],
            "mean": res["mean"],
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

        def naive_run():
            nonlocal k
            p = pool[k % len(pool)]
            k += 1
            naive_check(p["choices"][0]["message"])

        res = measure(naive_run, min(iters, 2000))
        baseline_rows.append({"scenario": key, "label": label, "n": res["n"], "mean": res["mean"], "opsPerSec": res["opsPerSec"]})

    baseline_fp = []
    fixtures_dir = Path(__file__).resolve().parent.parent.parent / "bench" / "fixtures"
    for f in sorted(fixtures_dir.glob("fp-guard-*.json")):
        fixture = json.loads(f.read_text(encoding="utf-8"))
        message = fixture["response"]["choices"][0]["message"]
        naive = naive_check(message)
        baseline_fp.append({"id": fixture.get("id") or f.name, "naiveFired": bool(naive["found"])})

    return check_rows, stream_chunks, stream_res, history_res, matrix_res, baseline_rows, baseline_fp


async def _iter(chunks):
    for c in chunks:
        yield c


def main():
    check_rows, stream_chunks, stream_res, history_res, matrix_res, baseline_rows, baseline_fp = asyncio.run(main_async())

    machine = {
        "platform": "{} {}".format(platform.system().lower(), platform.machine().lower()),
        "python": platform.python_version(),
        "date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    fmt = lambda r: "{:.2f} / {:.2f} / {:.2f} ms".format(r["p50"], r["p95"], r["p99"])
    fmt_mean = lambda r: "{:.3f} ms".format(r["mean"])
    fmt_ops = lambda r: "{:,} ops/s".format(int(r["opsPerSec"]))

    lines = [
        "# unswallow — Python performance report",
        "",
        "measured {} · Python {} · {}".format(machine["date"], machine["python"], machine["platform"]),
        "",
        "Mirrors packages/bench/perf.mjs scenario-for-scenario (same seeds, same payload generation, same percentile methodology).",
        "",
        "## check_and_rescue — latency per call (warm)",
        "",
        "| scenario | payload | n | p50 / p95 / p99 | mean | throughput | retained/op |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for r in check_rows:
        lines.append(
            "| {} | {:.1f} KB | {} | {} | {} | {} | {:.2f} KB |".format(
                r["label"],
                r["payloadBytes"] / 1024,
                r["n"],
                fmt(r),
                fmt_mean(r),
                fmt_ops(r),
                r["retainedPerOpBytes"] / 1024,
            )
        )
    lines += [
        "",
        "## check_and_rescue_stream",
        "",
        "| stream | chunks | payload | p50 / p95 / p99 | mean |",
        "| --- | --- | --- | --- | --- |",
        "| typical reasoning stream, envelope split across deltas | {} | 19.7 KB | {} | {} |".format(
            len(stream_chunks) - 1, fmt(stream_res), fmt_mean(stream_res)
        ),
        "",
        "## Pattern D — sanitizeHistory",
        "",
        "| corpus | p50 / p95 / p99 | mean | throughput |",
        "| --- | --- | --- | --- |",
        "| 40-message history with leaked reasoning | {} | {} | {} |".format(fmt(history_res), fmt_mean(history_res), fmt_ops(history_res)),
        "",
        "## Matrix lookup — match_matrix_entry",
        "",
        "| workload | p50 / p95 / p99 | mean | throughput |",
        "| --- | --- | --- | --- |",
        "| 100k lookups (engine/version/pattern) | {} | {} | {} |".format(fmt(matrix_res), fmt_mean(matrix_res), fmt_ops(matrix_res)),
        "",
        "## Naive baseline (marker scan, no validation, no recovery)",
        "",
        "What the simplest possible approach costs on the same payloads: one marker regex over the text channels plus a single `json.loads` attempt, no envelope validation, no false-positive guard, nothing recovered.",
        "",
        "| scenario | mean | throughput |",
        "| --- | --- | --- |",
    ]
    for r in baseline_rows:
        lines.append("| {} | {} | {} |".format(r["label"], fmt_mean(r), fmt_ops(r)))
    fired = [f["id"] for f in baseline_fp if f["naiveFired"]]
    lines += [
        "",
        "False positives on the pinned guard fixtures (naive fired where nothing should recover): {}/{} ({})".format(
            len(fired), len(baseline_fp), ", ".join(fired) if fired else "none"
        ),
        "",
    ]
    report = "\n".join(lines)

    out_dir = Path(__file__).resolve().parent
    (out_dir / "results_python.md").write_text(report, encoding="utf-8")
    (out_dir / "results_python.json").write_text(
        json.dumps(
            {
                "machine": machine,
                "checkAndRescue": check_rows,
                "baseline": baseline_rows,
                "baselineFp": baseline_fp,
                "streaming": stream_res,
                "history": history_res,
                "matrix": matrix_res,
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