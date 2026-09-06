"""Live-reproduction harness (Python) — the 1:1 mirror of live-probe.mjs.

Runs every case in packages/bench/live-probe/cases/*.json through the
Python unswallow core:

  - synthetic cases: recorded rawResponse / chunks fed straight through
    check_and_rescue / check_and_rescue_stream — no engine needed;
  - live cases: the case's prompt is sent to the configured
    OpenAI-compatible endpoint and the RAW provider response is captured
    first, then run through unswallow.

Usage:
  python packages/bench/live-probe/live_probe.py --out out.json
  python packages/bench/live-probe/live_probe.py --endpoint http://localhost:8080/v1 \
      --model Qwen/Qwen3-4B --engine llama.cpp --version bXXXX --api-key none \
      --out out.json

Exit 0 when every runnable case passed its expectation; 1 on behavioral
failures; 2 on usage/IO errors.
"""

import argparse
import asyncio
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# parents[2] of packages/bench/live-probe/live_probe.py is packages/; the
# python mirror package lives next to bench/ under packages/.
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))

from unswallow import (  # noqa: E402
    StreamAccumulator,
    check_and_rescue,
    check_and_rescue_stream,
)

CASES_DIR = Path(__file__).resolve().parent / "cases"


def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--case", action="append", default=[], help="specific case file (repeatable)")
    p.add_argument("--endpoint", default=None, help="OpenAI-compatible base URL, e.g. http://localhost:8080/v1")
    p.add_argument("--model", default=None)
    p.add_argument("--engine", default=None)
    p.add_argument("--version", default=None)
    p.add_argument("--api-key", default=None)
    p.add_argument("--out", default=None, help="write the JSON report here")
    p.add_argument("--fail-fast", action="store_true")
    return p.parse_args(argv)


def load_cases(args):
    if args.case:
        files = [Path(c).resolve() for c in args.case]
    else:
        files = sorted(CASES_DIR.glob("*.json"))
    cases = []
    for f in files:
        doc = json.loads(f.read_text(encoding="utf-8"))
        probe = doc.get("probe", doc)
        if not probe or not probe.get("id"):
            raise SystemExit("case file {} has no probe.id".format(f))
        probe["_file"] = f.name
        cases.append(probe)
    return cases


def chat_url(endpoint):
    """Accept both a full endpoint (…/chat/completions) and a base URL (…/v1)."""
    if endpoint.rstrip("/").endswith("/chat/completions"):
        return endpoint
    return endpoint.rstrip("/") + "/chat/completions"


def post_json(endpoint, api_key, body):
    headers = {"content-type": "application/json"}
    if api_key and api_key != "none":
        headers["authorization"] = "Bearer {}".format(api_key)
    req = urllib.request.Request(chat_url(endpoint), data=json.dumps(body).encode(), headers=headers)
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=300) as res:
            text = res.read().decode()
    except urllib.error.HTTPError as e:
        raise RuntimeError("HTTP {}: {}".format(e.code, e.read().decode()[:500])) from None
    latency_ms = (time.perf_counter() - t0) * 1000.0
    return json.loads(text), latency_ms


def post_stream(endpoint, api_key, body):
    headers = {"content-type": "application/json", "accept": "text/event-stream"}
    if api_key and api_key != "none":
        headers["authorization"] = "Bearer {}".format(api_key)
    req = urllib.request.Request(chat_url(endpoint), data=json.dumps(body).encode(), headers=headers)
    t0 = time.perf_counter()
    chunks = []
    with urllib.request.urlopen(req, timeout=600) as res:
        buf = b""
        while True:
            block = res.read(4096)
            if not block:
                break
            buf += block
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                line = line.decode().strip()
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    continue
                try:
                    chunks.append(json.loads(payload))
                except ValueError:
                    pass
    latency_ms = (time.perf_counter() - t0) * 1000.0
    return chunks, latency_ms


def build_request(probe, args, stream):
    req = dict(probe.get("request") or {})
    req.setdefault("messages", [{"role": "user", "content": "Hello."}])
    req["stream"] = stream
    req.setdefault("model", args.model or probe.get("model") or "unknown")
    req.pop("_file", None)
    return req


def expected_of(probe):
    e = probe.get("expect") or {}
    return {"detected": e.get("detected", False), "pattern": e.get("pattern"), "recovered": e.get("recovered", False)}


def summarize(result):
    return {
        "detected": result.detected,
        "pattern": result.pattern,
        "toolCalls": [{"name": t.name, "arguments": t.arguments} for t in (result.tool_calls or [])],
        "recovered": result.recovered,
        "confidence": result.confidence,
        "source": result.source,
        "engineHint": result.engine_hint,
        "matrixMatch": (
            {
                "engine": result.matrix_match.engine,
                "versionRange": result.matrix_match.version_range,
                "pattern": result.matrix_match.pattern,
                "behavior": result.matrix_match.behavior,
                "verified": result.matrix_match.verified,
            }
            if result.matrix_match
            else None
        ),
        "warnings": list(result.warnings or []),
    }


def assemble_response(chunks):
    acc = StreamAccumulator()
    for c in chunks:
        acc.push(c)
    return acc.end()


def run_case(probe, args):
    record = {
        "caseId": probe["id"],
        "file": probe.get("_file"),
        "mode": probe.get("mode", "live" if "rawResponse" not in probe and "chunks" not in probe else "synthetic"),
        "engine": probe.get("engine", args.engine),
        "engineVersion": probe.get("version", args.version),
        "model": probe.get("model", args.model),
        "pattern": probe.get("pattern"),
        "stream": bool(probe.get("stream")),
        "expect": expected_of(probe),
        "provider": {
            "endpoint": args.endpoint,
            "engine": probe.get("engine", args.engine),
            "engineVersion": probe.get("version", args.version),
            "model": probe.get("model", args.model),
        },
        "detected": None,
        "recovery": None,
        "errors": [],
        "rawResponseCaptured": False,
        "unswallow": None,
        "latencyMs": None,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    try:
        response = None
        chunks = None
        if "rawResponse" in probe:
            response = json.loads(json.dumps(probe["rawResponse"]))
            record["rawResponseCaptured"] = True
        elif "chunks" in probe:
            chunks = json.loads(json.dumps(probe["chunks"]))
            response = assemble_response(chunks)
            record["rawResponseCaptured"] = True
        else:
            if not args.endpoint:
                # Live case without a configured endpoint: skip, so the default
                # (no-arg) run stays a clean synthetic-only gate.
                record["skipped"] = True
                record["passed"] = True
                return record
            request = build_request(probe, args, probe.get("stream", False))
            record["request"] = request
            if probe.get("stream"):
                chunks, latency_ms = post_stream(args.endpoint, args.api_key, request)
                record["latencyMs"] = latency_ms
                response = assemble_response(chunks)
            else:
                response, latency_ms = post_json(args.endpoint, args.api_key, request)
                record["latencyMs"] = latency_ms
            record["rawResponseCaptured"] = True

        check_opts = {
            "engine_hint": args.engine or probe.get("engine"),
            "engine_version": args.version or probe.get("version"),
        }
        if chunks is not None:
            result = asyncio.run(check_and_rescue_stream(_iter(chunks), **check_opts))
        else:
            result = check_and_rescue(response, **check_opts)

        record["rawResponse"] = response
        record["unswallow"] = summarize(result)
        record["detected"] = result.detected
        record["recovery"] = {
            "recovered": result.recovered,
            "toolCalls": [t.name for t in (result.tool_calls or [])],
            "confidence": result.confidence,
            "recoveredResponse": result.recovered_response,
        }
        if result.recovered_response is not None:
            choice = result.recovered_response["choices"][0]
            record["recovered"] = {
                "finishReason": choice.get("finish_reason"),
                "toolCalls": [
                    {"name": tc["function"]["name"], "arguments": tc["function"]["arguments"]}
                    for tc in choice["message"].get("tool_calls") or []
                ],
            }

        exp = record["expect"]
        issues = []
        if result.detected != exp["detected"]:
            issues.append("detected: got {}, expected {}".format(result.detected, exp["detected"]))
        if (result.pattern or None) != exp["pattern"]:
            issues.append("pattern: got {}, expected {}".format(result.pattern, exp["pattern"]))
        if result.recovered != exp["recovered"]:
            issues.append("recovered: got {}, expected {}".format(result.recovered, exp["recovered"]))
        if exp["recovered"] and not (
            result.recovered_response
            and len((result.recovered_response["choices"][0]["message"].get("tool_calls") or [])) > 0
        ):
            issues.append("expected a recovered response with tool_calls populated")
        record["passed"] = not issues
        record["issues"] = issues
        return record
    except Exception as e:  # noqa: BLE001 — harness boundary
        record["errors"] = [str(e)]
        record["passed"] = False
        return record


async def _iter(chunks):
    for c in chunks:
        yield c


def render_human(records, args):
    lines = ["unswallow live-probe (python)", "  endpoint: {}".format(args.endpoint or "(synthetic only)"), ""]
    for r in records:
        if r.get("skipped"):
            lines.append("[SKIP] {}  (live case — no endpoint configured)".format(r["caseId"]))
            lines.append("")
            continue
        status = "PASS" if r["passed"] else "FAIL"
        lines.append(
            "[{}] {}  ({} mode, {}, engine={} {}, model={})".format(
                status,
                r["caseId"],
                r["mode"],
                "streaming" if r["stream"] else "non-streaming",
                r["engine"] or "-",
                r["engineVersion"] or "",
                r["model"] or "-",
            )
        )
        for e in r["errors"]:
            lines.append("    error: {}".format(e))
        if r.get("unswallow"):
            u = r["unswallow"]
            names = ", ".join(tc["name"] for tc in u["toolCalls"]) or "-"
            lines.append(
                "    unswallow: detected={} pattern={} recovered={} confidence={} calls=[{}] source={}".format(
                    u["detected"], u["pattern"], u["recovered"], u["confidence"], names, u["source"]
                )
            )
            if u["matrixMatch"]:
                m = u["matrixMatch"]
                lines.append(
                    "    matrix: {} {} {} -> {} (verified: {})".format(
                        m["engine"], m["versionRange"], m["pattern"], m["behavior"], m["verified"]
                    )
                )
            if r.get("latencyMs") is not None:
                lines.append("    provider latency: {:.1f} ms".format(r["latencyMs"]))
        for i in r.get("issues") or []:
            lines.append("    expected: {}".format(i))
        lines.append("")
    run = [r for r in records if not r.get("skipped")]
    passed = sum(1 for r in run if r["passed"])
    suffix = ""
    skipped = sum(1 for r in records if r.get("skipped"))
    if skipped:
        suffix = " ({} live case(s) skipped — no endpoint)".format(skipped)
    lines.append("{}/{} cases passed their expectation.{}".format(passed, len(run), suffix))
    return "\n".join(lines)


def main(argv=None):
    args = parse_args(argv)
    cases = load_cases(args)
    records = [run_case(probe, args) for probe in cases]
    run = [r for r in records if not r.get("skipped")]
    skipped = sum(1 for r in records if r.get("skipped"))
    report = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "harness": {"language": "python", "version": "0.2.0"},
        "provider": {"endpoint": args.endpoint, "engine": args.engine, "engineVersion": args.version, "model": args.model},
        "summary": {"passed": sum(1 for r in run if r["passed"]), "total": len(run), "skipped": skipped},
        "records": records,
    }
    if args.out:
        Path(args.out).resolve().write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(render_human(records, args))
    if args.out:
        print("report written to {}".format(Path(args.out).resolve()))
    return 0 if all(r["passed"] for r in run) else 1


if __name__ == "__main__":
    sys.exit(main())
