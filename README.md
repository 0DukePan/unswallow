# unswallow

[![npm version](https://img.shields.io/npm/v/unswallow)](https://www.npmjs.com/package/unswallow)
[![PyPI version](https://img.shields.io/pypi/v/unswallow)](https://pypi.org/project/unswallow/)
[![CI](https://github.com/0DukePan/unswallow/actions/workflows/ci.yml/badge.svg)](https://github.com/0DukePan/unswallow/actions/workflows/ci.yml)
[![Demo](https://img.shields.io/badge/demo-gif-purple)](docs/demo.gif)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Zero runtime dependencies](https://img.shields.io/badge/runtime_deps-0-brightgreen)](package.json)

**Detect and recover tool calls trapped inside a model's reasoning channel.**

![unswallow demo](docs/demo.gif)

Your agent's model *decided* to call a tool. The server returned `HTTP 200`, `finish_reason: stop`, and `tool_calls: []`. Your agent loop read "no tool call", and silently stopped mid-task. No crash, no error, no log line pointing at the cause.

The tool call is sitting, fully formed, inside the `reasoning` / `reasoning_content` / `thinking` field. The parser never looked there. This package finds it and puts it back.

## Why unswallow

- **Zero runtime dependencies** — stdlib only, in both TypeScript and Python. Nothing to audit, nothing to break.
- **Non-destructive** — recovery returns a healed deep copy; the original response object is never mutated, and clean responses pass through byte-identical.
- **No false recoveries** — a model merely *discussing* a tool call is never "recovered". Recovery requires a structurally complete envelope, enforced by pinned adversarial fixtures.
- **Fast enough to be invisible** — single checks land around a tenth of a millisecond on realistic payloads (see [Benchmarks](#benchmarks)); a healthy response returns before any scanning even starts.

```bash
npx unswallow check
```

```
⚠ REASONING-CHANNEL SWALLOW DETECTED — Pattern A (trapped inside)

  BEFORE                   AFTER
  tool_calls: []           tool_calls: [Finish(…)]
  finish_reason: stop      finish_reason: tool_calls

  recovered: Finish({"answer": 204})

confidence    : ██████████ 0.95
matrix match  : vllm <=0.19.0 → swallow
source        : https://github.com/vllm-project/vllm/issues/39056
fix hint      : upgrade to vLLM >= 0.24.0 (Qwen3 family)
```

No framework, no config, no dependencies. One function in, one function out.

---

## The bug class

Reasoning models emit their tool calls **before** closing the think block — "reasoning about which tool to call" and "calling it" blur together during generation. Server-side parsers split the output on the closing think tag and route everything before it into `reasoning`. Downstream tool-call parsing only inspects `content`. The tool call never reaches the tool parser.

It isn't malformed. It isn't in the wrong dialect. It's syntactically perfect, sitting in the wrong field — and the response your client receives looks exactly like "the model chose not to act."

Four independently-confirmed patterns:

| Pattern | What happens | Confirmed example |
| --- | --- | --- |
| **A — Trapped inside** | Tool call fully contained inside the reasoning block; parser never sees it | [vLLM #39056](https://github.com/vllm-project/vllm/issues/39056) (Qwen3.5-35B-A3B-FP8), [SGLang #30744](https://github.com/sgl-project/sglang/issues/30744), [llama.cpp #20837](https://github.com/ggml-org/llama.cpp/issues/20837) |
| **B — Trailing after** | Tool call lands in `content`, but reasoning text is appended right after the JSON, breaking strict `JSON.parse` | [pi #952](https://github.com/earendil-works/pi/issues/952) (Kimi-K2-Thinking) |
| **C — Field leak** | Reasoning tags/content leak into the wrong field mid-stream | MiniMax M3 `<mm:think>` streaming leak |
| **D — History drift** | Reasoning tags leak into history; the model starts imitating fake thinking tags on later turns | [open-webui #23339](https://github.com/open-webui/open-webui/issues/23339) |

unswallow ships Pattern A and B (detection + recovery) and Pattern C (detection-only) today. Pattern D is a prevention feature for the roadmap.

**Why this is worse than a normal parsing bug:** every other tool-call failure fails loudly — bad JSON throws, an unknown function name is visible in the raw text. This one returns a valid, well-formed response that looks like a deliberate non-action. Close to undetectable without already knowing to look for it.

## Install

```bash
npm i unswallow        # library + CLI + proxy, zero runtime dependencies
pip install unswallow  # 1:1 Python mirror, zero runtime dependencies
```

## Use it — library

```ts
import { checkAndRescue } from 'unswallow';

const result = checkAndRescue(rawProviderResponse, {
  engineHint: 'vllm',        // 'vllm' | 'sglang' | 'llama.cpp' — enables matrix-aware confidence
  engineVersion: '0.19.0',   // server version, same reason
  toolSchemas: myTools,      // optional: only used for confidence scoring
});

if (result.recovered && result.recoveredResponse) {
  // keep going with the ordinary, well-formed response — tool_calls is populated
  return result.recoveredResponse;
}
```

One call, dropped into any response-handling path. `result.recoveredResponse` is a deep copy — the original object is never mutated. When nothing is detected (`confidence: 0`), the response passes through completely untouched.

## Use it — streaming

The swallow is most dangerous on streaming paths, and streaming parsers are the least reliable (vLLM's own maintainers note that many assume single-token deltas — an assumption that breaks under multi-token chunking, e.g. speculative decoding). unswallow is **delta-size-agnostic by construction**: it never parses partial content. It only accumulates per-channel deltas, then runs the full check-and-rescue pass once at stream end.

```ts
import { checkAndRescueStream } from 'unswallow';

// stream: AsyncIterable<StreamChunk> — OpenAI-compatible SSE chunks
const result = await checkAndRescueStream(stream, {
  engineHint: 'vllm',
  engineVersion: '0.19.0',
  onLeak: (note) => log.warn(note),   // live pattern-C signal, optional
});
```

If you parse your own SSE, the accumulator is also exported:

```ts
import { createStreamAccumulator } from 'unswallow';
const acc = createStreamAccumulator({ maxBufferBytes: 1_000_000 });
for (const chunk of rawChunks) acc.push(chunk);
const assembled = acc.end();
```

Chunks split mid-tag or mid-JSON-string, whole envelopes in one multi-token delta, healthy streamed `tool_calls` — all covered by pinned streaming fixtures. A streamed `finish_reason: stop` that was really a swallowed tool call comes back with `finish_reason: tool_calls`.

## Use it — history hygiene (Pattern D)

Reasoning tags that leak into conversation history make models imitate fake thinking tags on subsequent turns ([open-webui #23339](https://github.com/open-webui/open-webui/issues/23339)). That's a prevention problem, not a per-response repair — strip reasoning artifacts from history before re-sending:

```ts
import { sanitizeHistory, stripReasoningTags } from 'unswallow';

const clean = sanitizeHistory(messages);                 // strips reasoning fields + leaked think blocks
const text = stripReasoningTags(assistantText);          // "< thinking>\nplan\n< response>\nanswer" → "answer"
```

Conservative by design: only structurally-recognized reasoning regions are removed — plain text, including the word "think", is never touched.

## Use it — Python

The same library, mirrored 1:1, stdlib-only:

```python
from unswallow import check_and_rescue, check_and_rescue_stream, sanitize_history

result = check_and_rescue(
    raw_provider_response,
    engine_hint="vllm",
    engine_version="0.19.0",
)

result = await check_and_rescue_stream(chunk_iterable)      # same semantics, streaming
clean = sanitize_history(messages)                           # pattern D, history hygiene
```

The Python package ships the same matrix data, the same confidence scoring, the same false-positive guard, and the same CLI (`unswallow check`, `unswallow matrix`) — see [`packages/python/README.md`](packages/python/README.md).

## Use it — proxy

An OpenAI-compatible passthrough that detects and recovers the swallow inline — scoped strictly to this one bug class, deliberately not a general repair proxy. Point any OpenAI-compatible client at it:

```bash
npx unswallow proxy --upstream http://localhost:8000/v1 --port 8787 --engine vllm --version 0.19.0
```

- **Non-streaming:** the response is healed in place; `x-unswallow` header reports `{detected, pattern, recovered, confidence}`.
- **Streaming:** chunks are forwarded live as they arrive; the terminal `finish_reason: stop` chunk is held, and if a swallow is detected a recovery tail (`tool_calls` delta + `finish_reason: tool_calls`) is emitted in its place, followed by a diagnostics event. Parallel calls emit one delta chunk per recovered call.
- **Abort propagation:** if your client drops the connection mid-stream, the proxy cancels the upstream request immediately instead of draining it.
- Everything else (other routes, other methods) passes through untouched.

```ts
import { createProxyServer } from 'unswallow';
const server = createProxyServer({ upstream: 'http://localhost:8000/v1', engineHint: 'vllm', engineVersion: '0.19.0' });
server.listen(8787);
```

## Use it — CLI

```bash
# self-test against a bundled real-world fixture (vLLM #39056)
npx unswallow check

# probe a live OpenAI-compatible server with a purpose-built trigger prompt
npx unswallow check --endpoint http://localhost:8000/v1 --model Qwen/Qwen3.5-35B-A3B-FP8 --engine vllm --version 0.19.0

# run against a captured raw response (curl output, server logs, CI artifacts)
npx unswallow check --fixture captured-response.json

# machine-readable output for CI
npx unswallow check --endpoint ... --json

# browse the engine/version behavior matrix
npx unswallow matrix
```

Exit codes for live probes: `0` = not affected, `1` = affected (recovered or not), `2` = error. Wire it into CI the way you'd wire a health check.

## How it works

```
raw provider response + optional engine hint + optional tool schemas
        │
   ① Channel scan      reasoning / reasoning_content / thinking / content,
                        plus think-blocks embedded in content
        │
   ② Envelope extract  structurally complete tool-call envelopes:
                        <tool_call>…</tool_call>, <function=name>…</function>,
                        or balanced JSON with name + arguments
        │
   ③ Classify          A: trapped inside reasoning · B: trailing text after JSON
                        in content · C: reasoning-tag leak (detection-only)
        │
   ④ Recover           rebuild tool_calls[] in place (deep copy), set
                        finish_reason: tool_calls, return the healed response
        │
   ⑤ Confidence        matrix hit → 0.95 · heuristic fallback → 0.55 · nothing → 0,
                        with warnings[] explaining exactly why
```

## The false-positive guard

**A wrong recovery is worse than the silent failure it replaces.** So recovery is never a keyword match — it requires a *structurally complete* envelope: a balanced `name` + `arguments` object (or the equivalent XML form). A model that merely *discusses* calling a tool in its reasoning is never "recovered":

- `"I could call get_weather for Tokyo, but I don't need it"` → not detected
- `{"name": "get_weather"}` (no `arguments`) → not detected
- `{"name": "get_weather", "arguments": {"city": "Tokyo"}` (unbalanced) → not detected

These are pinned benchmark fixtures (`fp-guard-*` in [`packages/bench/fixtures/`](packages/bench/fixtures/)) — the guard can't regress silently.

## Confidence

| Situation | Confidence |
| --- | --- |
| Engine + version hit in the matrix, behavior = swallow | **0.95** |
| Matrix hit, behavior = partial (post-patch era) | **0.80** |
| Matrix hit, but version range marked *resolved* | **0.60** + warning ("reported version is probably wrong") |
| Generic marker scan, engine/version unknown or unmatched | **0.55** + explicit warnings |
| Pattern C (field leak) | ≤ 0.50, detection-only, no recovery |
| No structural envelope found | **0**, response untouched |

These are fixed heuristic tiers reflecting how the match was made (matrix hit vs. generic scan), not a statistically calibrated probability — 0.95 does not mean "correct 95% of the time."

## The engine matrix

The genuinely hard part of this bug class is knowing **which engine, which version range, has which behavior** — it shifts under point releases, parser names get merged (the `qwen3_coder` → `qwen3_xml` folk-fix silently became a no-op on current vLLM), and community knowledge visibly goes stale. The matrix is a living, sourced data file, updated independently of package releases:

| Engine / harness | Version range | Pattern | Behavior | Verified | Source |
| --- | --- | --- | --- | --- | --- |
| vllm | `<=0.19.0` | A | swallow | no | [#39056](https://github.com/vllm-project/vllm/issues/39056) |
| vllm | `>=0.20.0 <0.24.0` | A | partial | no | [#39056](https://github.com/vllm-project/vllm/issues/39056) |
| vllm | `>=0.24.0` | A | resolved | no | [#39056](https://github.com/vllm-project/vllm/issues/39056) |
| vllm | `>=0.24.0` | B | partial | no | [#39056](https://github.com/vllm-project/vllm/issues/39056) |
| sglang | `*` | A | swallow | no | [#30744](https://github.com/sgl-project/sglang/issues/30744) |
| llama.cpp | `*` | A | swallow | no | [#20837](https://github.com/ggml-org/llama.cpp/issues/20837) |
| open-webui | `*` | D | swallow | no | [#23339](https://github.com/open-webui/open-webui/issues/23339) |

On verification, stated plainly: every row is sourced from its linked upstream report, and **none has been independently reproduced by the maintainer** — running each named engine/version against the fixtures requires GPU serving infrastructure this project doesn't have. `verified: no` marks exactly that. If you reproduce a row against the real engine and version, open a PR flipping it to `verified: true` with evidence (server version output + the probe transcript) and it will be merged.

Every row ships with a `source` URL — community PRs against [`packages/matrix/data/engine-matrix.json`](packages/matrix/data/engine-matrix.json) are welcome and don't require a release. The matrix is published as its own package, `unswallow-matrix`, **versioned independently of `unswallow`** — closer to an antivirus definitions file than a code release (see [`packages/matrix/README.md`](packages/matrix/README.md)). `npm run matrix:update` refreshes upstream issue status via the GitHub API (used by the weekly CI watcher) and reports which benchmark fixtures a behavior flip would force to change. A public status page — the matrix rendered as a linkable, always-current page — is published to GitHub Pages weekly ([status page](https://0DukePan.github.io/unswallow/)), and framework adapters (LiteLLM callback, OpenTelemetry, OpenAI SDK, Vercel AI SDK) are in [`docs/integrations.md`](docs/integrations.md).

## Benchmarks

Three layers, all independently rerunnable on your own hardware.

### Correctness — 22/22 hash-pinned fixtures

Hash-pinned fixture corpus seeded from the real upstream reports — **every fixture is byte-checked against `packages/bench/fixtures.sha256` before it runs**, so results can't silently drift. Engine/version hints are recorded per fixture; sample size and sourcing are disclosed in every published result. `sourced: yes` means reconstructed from the linked upstream report; `synthetic` means a constructed or adversarial self-authored case (its `source` field says so explicitly).

| id | engine | version | expected | actual | recovered | confidence | sourced | status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| vllm-qwen3.5-0.19-pattern-a | vllm | 0.19.0 | A | A | yes | 0.95 | yes | PASS |
| vllm-qwen3.5-0.19-pattern-a-parallel | vllm | 0.19.0 | A | A | yes (2) | 0.95 | synthetic | PASS |
| vllm-qwen3.5-0.19-pattern-a-duplicate | vllm | 0.19.0 | A | A | yes (1) | 0.95 | synthetic | PASS |
| vllm-qwen3-0.19-pattern-a-json-envelope | vllm | 0.19.0 | A | A | yes | 0.95 | yes | PASS |
| vllm-qwen3-0.19-tool-choice-required-pattern-b | vllm | 0.19.0 | B | B | yes | 0.55 | yes | PASS |
| vllm-qwen3-0.23-pattern-a-partial | vllm | 0.23.4 | A | A | yes | 0.80 | yes | PASS |
| vllm-qwen3-0.24-clean | vllm | 0.24.0 | none | none | no | 0.00 | yes | PASS |
| vllm-qwen3.5-0.19-streaming-pattern-a | vllm | 0.19.0 | A | A | yes | 0.95 | yes | PASS |
| sglang-qwen3.5-reasoning-content-pattern-a | sglang | 0.4.6 | A | A | yes | 0.95 | yes | PASS |
| llamacpp-qwen3.5-thinking-pattern-a | llama.cpp | b8461 | A | A | yes | 0.95 | yes | PASS |
| pi-kimi2-pattern-b | — | — | B | B | yes | 0.55 | yes | PASS |
| pi-kimi2-streaming-pattern-b | — | — | B | B | yes | 0.55 | yes | PASS |
| minimax-m3-pattern-c-leak | — | — | C | C | no | 0.50 | synthetic | PASS |
| minimax-m3-streaming-pattern-c-leak | — | — | C | C | no | 0.50 | synthetic | PASS |
| deepseek-reasoning-content-pattern-a | sglang | 0.4.6 | A | A | yes | 0.95 | synthetic | PASS |
| fp-guard-discussion-only | vllm | 0.19.0 | none | none | no | 0.00 | synthetic | PASS |
| fp-guard-partial-json | vllm | 0.19.0 | none | none | no | 0.00 | synthetic | PASS |
| fp-guard-json-array-args | vllm | 0.19.0 | none | none | no | 0.00 | synthetic | PASS |
| fp-guard-json-string-args | vllm | 0.19.0 | none | none | no | 0.00 | synthetic | PASS |
| fp-guard-multiple-partial | vllm | 0.19.0 | none | none | no | 0.00 | synthetic | PASS |
| fp-guard-user-content-mention | vllm | 0.19.0 | none | none | no | 0.00 | synthetic | PASS |
| fp-guard-xml-empty-name | vllm | 0.19.0 | none | none | no | 0.00 | synthetic | PASS |

Regenerate with `npm run bench`; verified read-only in CI (`npm run bench:check`). Every fixture is also cross-checked against its engine matrix row: flip a row to a different behavior and the matching fixture must flip too, or CI fails.

### Performance — measured

`npm run bench:perf` — seeded, deterministic corpus; warm latencies, p50/p95/p99, throughput, and retained heap per call (measured with `--expose-gc`). Full report with machine info in [`packages/bench/perf/results.md`](packages/bench/perf/results.md). Latest run (measured 2026-09-05):

*Node v22.16.0 · AMD Ryzen 5 2600X (12 cores) · 15.9 GB RAM · win32 x64*

Every scenario runs 5 full passes (3 for async work); percentiles are pooled across runs, the reported mean is the median of the per-run means, and the per-run min–max spread is in parentheses — a single noisy run shows up in the spread instead of hiding in the mean. Both reports print the sha256 of the generated corpus, and the TypeScript and Python reports carry the same hash (`3066ff5a…`) — that is the mechanical check behind the "same seeds, same payloads" claim.

| scenario | payload | p50 / p95 / p99 | mean (min–max) | throughput |
| --- | --- | --- | --- | --- |
| Pattern A — small reasoning | 2.8 KB | 0.10 / 0.18 / 0.31 ms | 0.115 ms (0.096–0.134) | ~8,700 ops/s |
| Pattern A — function-XML envelope | 1.8 KB | 0.13 / 0.30 / 0.70 ms | 0.151 ms (0.133–0.208) | ~6,600 ops/s |
| Pattern A — large reasoning | 63.5 KB | 0.23 / 0.58 / 1.24 ms | 0.277 ms (0.195–0.361) | ~3,600 ops/s |
| Pattern A — 1 MB reasoning | 987 KB | 3.52 / 8.38 / 11.85 ms | 4.029 ms (2.142–5.027) | ~250 ops/s |
| Pattern B — trailing text | 1.0 KB | 0.09 / 0.17 / 0.31 ms | 0.100 ms (0.086–0.135) | ~10,000 ops/s |
| Pattern C — field leak | 0.5 KB | 0.05 / 0.09 / 0.13 ms | 0.057 ms (0.050–0.073) | ~17,500 ops/s |
| Healthy (tool_calls populated) | 1.1 KB | 0.05 / 0.09 / 0.13 ms | 0.059 ms (0.050–0.067) | ~17,000 ops/s |
| False-positive guard (discussion-only) | 1.5 KB | 0.05 / 0.09 / 0.11 ms | 0.057 ms (0.054–0.066) | ~17,700 ops/s |
| Streaming — typical reasoning stream (843 chunks, 19.7 KB) | — | 2.44 / 4.37 / 5.71 ms | 2.420 ms (2.262–3.080) | ~410 streams/s |
| Streaming — 500 KB content stream (5,323 chunks) | — | 11.45 / 19.54 / 22.38 ms | 12.729 ms (10.426–14.048) | ~80 streams/s |
| sanitizeHistory — 40-message history | — | 0.09 / 0.20 / 0.63 ms | 0.114 ms (0.082–0.139) | ~8,800 ops/s |
| matchMatrixEntry — 100k lookups | — | 0.00 / 0.01 / 0.01 ms | 0.002 ms (0.001–0.002) | ~615,000 ops/s |

The pinned fixtures — the 22 upstream-derived shapes from the correctness table — also run through the same harness (0.05–0.33 ms per fixture in this run, reported per-fixture in [`results.md`](packages/bench/perf/results.md) §Real fixture corpus), so the synthetic word-salad corpus is anchored against real bug-report shapes.

### Naive baseline — what the simplest approach costs

Same payloads, one marker regex plus a single `JSON.parse` attempt: no envelope validation, no false-positive guard, nothing recovered. It is 15–75× faster on small inputs — and it fires on **6 of the 7** pinned guard fixtures where nothing should recover (`fp-guard-json-array-args`, `fp-guard-json-string-args`, `fp-guard-multiple-partial`, `fp-guard-partial-json`, `fp-guard-user-content-mention`, `fp-guard-xml-empty-name`; only the marker-free discussion case stays silent). On 1 MB inputs the two trade places run to run (2.048 ms vs 4.029 ms in this run): the real check's 1 MB cost is dominated by the recovery deep copy, not the scan, so the comparison flips with machine load — on Linux CI the real check wins (see below). That gap — speed without correctness — is exactly what the guard fixtures exist to price.

Notes, honestly stated: every check is linear in payload size (this run: ~4 ms for a 1 MB reasoning block, ~0.3 ms for 64 KB); recovery only runs when an envelope is found, and only the recovered path makes a deep copy; a healthy response (already-parsed `tool_calls`) is the cheapest path by design — it returns before any scanning. The `JSON.parse(JSON.stringify(payload))` round-trip of the 64 KB payload alone measures ~0.41 ms in this run (~0.24 ms on quieter runs), so the scan is the minority of the cost. Two methodology notes: the corpus text is seeded word-salad, not production reasoning traces, so brace/quote-heavy real CoT may scan slightly differently (the pinned fixtures are the real-shaped anchor); and `retained/op` is a post-GC floor (negative GC noise is clamped to `0.00`), i.e. "nothing retained after a full collection", not "nothing allocated". Benchmarks are wall-clock on a shared dev machine — the JSON.parse reference row in the full report is the load anchor (0.409 ms this run): compare it across runs to judge machine load before comparing anything else. Treat cross-machine comparisons with care, and run `npm run bench:perf` on your own hardware before quoting numbers anywhere.

### Python parity — 22/22, exact confidence equality

`npm run bench:python` — the same pinned 22-fixture corpus runs through the Python core and is compared against the TypeScript results **including exact confidence values** (Python 3.14.6):

```
22 / 22 fixtures: expectations + exact confidence parity with the TypeScript core
```

Same seeds, same payloads (both reports print the same corpus sha256), same percentile methodology — `packages/python/bench/results_python.md` mirrors the TS report. Honest headline numbers (measured 2026-09-05, Python 3.14.6, same machine):

| workload | Python | TypeScript (same run) |
| --- | --- | --- |
| check_and_rescue, small reasoning | ~0.36 ms · ~2,800 ops/s | ~0.12 ms · ~8,700 ops/s |
| check_and_rescue, 1 MB reasoning | ~0.62 ms · ~1,600 ops/s | ~4.03 ms · ~250 ops/s |
| check_and_rescue_stream (843 chunks) | ~18.2 ms | ~2.4 ms |
| sanitizeHistory (40-message history) | ~0.54 ms | ~0.11 ms |
| match_matrix_entry, 100k lookups | ~0.012 ms · ~82k ops/s | ~0.002 ms · ~615k ops/s |

Why the two implementations diverge on speed while agreeing exactly on behavior: the logic is identical — the runtimes aren't, and the divergence is backed by component probes measured in the same harness ([`results.md`](packages/bench/perf/results.md) §Component probes, mirrored in the Python report) on the same payloads. On small inputs TypeScript wins because V8 JIT-compiles the shared call graph CPython interprets — visible even in pure lookup work (matrix match ~0.002 ms vs ~0.012 ms). On 1 MB inputs Python wins because recovery deep-copies the whole response: the deep-copy probe measures `structuredClone` at ~1.88 ms while CPython's `copy.deepcopy` shares the immutable string at ~0.014 ms. The envelope-scan probe of the same 1 MB reasoning text is ~0.78 ms (TS) vs ~0.32 ms (Python). Streaming flips hard the other way because the per-chunk leak tracker is a character loop: the tracker-loop probe (accumulator `push` only, no final check) measures ~15.4 ms of Python's ~18.2 ms stream, versus ~1.0 ms of TypeScript's ~2.4 ms. None of this is a methodology artifact — same seeds, same payloads, same harness shapes on both sides.

### Proxy overhead (measured 2026-09-05)

Measured loopback with an in-process upstream (`npm run bench:perf`, proxy section). The added cost is dominated by the second HTTP roundtrip and JSON re-encoding, i.e. the cost of any proxy layer, not of the detection itself — note the direct baselines move with machine load, so read the `added` column, not the absolutes:

| case | direct | via proxy | added |
| --- | --- | --- | --- |
| non-stream, swallowed (recovered) | 3.56 ms | 4.26 ms | +0.70 ms |
| non-stream, healthy (passthrough) | 0.82 ms | 1.97 ms | +1.15 ms |
| streaming, swallowed (recovery tail) | 1.04 ms | 2.54 ms | +1.50 ms |

### Same suite on Linux (CI, ubuntu-latest)

The full performance suite — including the naive baseline — also runs on Linux CI and commits its reports next to the Windows ones: [packages/bench/perf/results-linux.md](packages/bench/perf/results-linux.md) and [packages/python/bench/results_python-linux.md](packages/python/bench/results_python-linux.md). The committed Linux artifacts are from the last workflow run (2026-09-04, previous harness generation) and refresh automatically on the next push after a bench change — the table below compares that run against its same-day win32 run, so it is *not* directly comparable to the 2026-09-05 numbers above. Latest committed run · Node v22.23.2 / Python 3.13.15 · AMD EPYC 7763 · linux x64:

| workload | linux (2026-09-04) | win32 (2026-09-04) |
| --- | --- | --- |
| check, small reasoning (TS) | 0.040 ms · ~25,200 ops/s | 0.108 ms · ~9,300 ops/s |
| check, 1 MB reasoning (TS) | 1.084 ms · ~920 ops/s | 1.664 ms · ~600 ops/s |
| stream, typical reasoning (TS) | 0.661 ms | 0.946 ms |
| proxy added, non-stream swallowed | +1.76 ms | +1.74 ms |
| check, small reasoning (Python) | 0.139 ms · ~7,200 ops/s | 0.219 ms · ~4,600 ops/s |
| check, 1 MB reasoning (Python) | 0.231 ms · ~4,300 ops/s | 0.473 ms · ~2,100 ops/s |
| stream, typical reasoning (Python) | 7.599 ms | 13.439 ms |

Three things worth noting: Linux runs roughly 1.5–3x faster on TS across the board (server chip, no desktop contention); the naive baseline fires on the same 6/7 guard fixtures there too; and on 1 MB inputs the naive scan loses to the real check in *both* languages on Linux (TS 1.220 vs 1.084 ms, Python 7.885 vs 0.231 ms) — the structural short-circuit wins once regexes have room to run.

## API

```ts
function checkAndRescue(
  response: RawProviderResponse,           // OpenAI-compatible chat.completion object
  opts?: CheckOptions
): SwallowCheckResult;

async function checkAndRescueStream(      // same result, over OpenAI-compatible SSE chunks
  stream: AsyncIterable<StreamChunk>,
  opts?: CheckOptions & { maxBufferBytes?: number; onLeak?: (note: string) => void }
): Promise<SwallowCheckResult>;

function createStreamAccumulator(opts?): { push(chunk: StreamChunk): void; end(): RawProviderResponse };

function sanitizeHistory(                  // Pattern D: history hygiene before re-sending
  messages: HistoryMessage[],
  opts?: { stripReasoningFields?: boolean; stripReasoningTags?: boolean }
): HistoryMessage[];

function stripReasoningTags(text: string): string;

function createProxyServer(               // OpenAI-compatible passthrough proxy
  opts: ProxyOptions & { upstream: string; prefix?: string; onResult?: (r: SwallowCheckResult, path: string) => void }
): http.Server;
```

```ts
interface SwallowCheckResult {
  detected: boolean;
  pattern: 'A' | 'B' | 'C' | null;
  toolCall: { name: string; arguments: Record<string, unknown> } | null;  // first recovered call
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> | null;  // all recovered calls, in order
  recovered: boolean;
  source: 'reasoning' | 'reasoning_content' | 'thinking' | 'thought' | 'content';
  engineHint: 'vllm' | 'sglang' | 'llama.cpp' | 'unknown';
  matrixMatch: SwallowMatrixEntry | null;  // null → heuristic-only recovery
  confidence: number;                       // 0–1
  warnings: string[];                       // why confidence isn't 1.0
  recoveredResponse: RawProviderResponse | null;  // healed deep copy, or null
}
```

**Parallel tool calls:** an agent turn that emits several tool calls at once (e.g. two search queries) gets all of them back — every structurally complete envelope is recovered in document order into `tool_calls[]`, and `toolCall` is just the first for convenience. Exact duplicates (same name + same arguments) collapse to a single recovery with a warning, since firing the same tool twice is worse than the swallow. The scan caps at 32 envelopes per response, also with a warning.

## Stability & supply chain

- **Semver.** The core library follows semantic versioning. During `0.x` the
  convention applies as usual: breaking changes land in minor bumps
  (`0.2.0`, not `0.1.1`) and are called out in the CHANGELOG.
- **Zero runtime dependencies is a compatibility promise.** No new *required*
  dependency enters the runtime path without a major version. Integrations
  (LiteLLM callback, OpenTelemetry, framework adapters) live in
  `integrations/` modules that import their framework lazily — installing
  `unswallow` never drags in litellm or an OTel SDK.
- **`unswallow-matrix` data-format policy.** The matrix is versioned
  independently, closer to a definitions file. Additive changes — new rows,
  new fields, fixHint wording — are non-breaking and land in any `0.x`.
  Removing or renaming a field, or flipping an existing row's behavior, is a
  breaking change requiring a major bump: it can change detection results
  under a pinned install, so it must be opt-in. See
  [`packages/matrix/README.md`](packages/matrix/README.md).
- **Provenance.** npm releases are published from CI with sigstore
  provenance (see `.github/workflows/publish.yml`); PyPI builds publish
  through twine from the same workflow. Tag `vX.Y.Z` and the workflow
  publishes `unswallow-matrix` first (dependency order), then `unswallow`,
  then PyPI.

## Roadmap

- **Phase 1 (shipped):** Pattern A + B detection/recovery, vLLM + SGLang + llama.cpp, Qwen3/DeepSeek families, non-streaming, CLI probe, benchmark v0.1.
- **Phase 2 (shipped):** Streaming — delta-size-agnostic accumulator, depth-tracked marker counting as chunks arrive, full pass at stream end (per §8 and vLLM #44873 feedback); Pattern C live leak events; llama.cpp; matrix auto-update on a schedule with fixture-impact reporting.
- **Phase 3 (shipped):** Pattern D — history-drift prevention pass (`sanitizeHistory` / `stripReasoningTags`); lightweight proxy mode (`unswallow proxy` / `createProxyServer`) — OpenAI-compatible passthrough scoped strictly to this bug class.
- **Shipped:** Python port (`pip install unswallow`) — 1:1 interface mirror, stdlib-only, same bundled matrix.
- **Open:** Phase 4 integration options with broader tool-call repair tooling (technical decision, not a promise).

## Contributing

- **Add a fixture** — if your server swallowed a tool call, open an issue and paste the raw response. It becomes a pinned benchmark case. This is how the corpus grows.
- **Update the matrix** — one row in `packages/matrix/data/engine-matrix.json`, one PR, no release required. The bench suite will tell you exactly which fixtures your row affects.
- See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).