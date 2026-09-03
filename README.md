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

## The engine matrix

The genuinely hard part of this bug class is knowing **which engine, which version range, has which behavior** — it shifts under point releases, parser names get merged (the `qwen3_coder` → `qwen3_xml` folk-fix silently became a no-op on current vLLM), and community knowledge visibly goes stale. The matrix is a living, sourced data file, updated independently of package releases:

| Engine / harness | Version range | Pattern | Behavior | Source |
| --- | --- | --- | --- | --- |
| vllm | `<=0.19.0` | A | swallow | [#39056](https://github.com/vllm-project/vllm/issues/39056) |
| vllm | `>=0.20.0 <0.24.0` | A | partial | [#39056](https://github.com/vllm-project/vllm/issues/39056) |
| vllm | `>=0.24.0` | A | resolved | [#39056](https://github.com/vllm-project/vllm/issues/39056) |
| vllm | `>=0.24.0` | B | partial | [#39056](https://github.com/vllm-project/vllm/issues/39056) |
| sglang | `*` | A | swallow | [#30744](https://github.com/sgl-project/sglang/issues/30744) |
| llama.cpp | `*` | A | swallow | [#20837](https://github.com/ggml-org/llama.cpp/issues/20837) |
| open-webui | `*` | D | swallow | [#23339](https://github.com/open-webui/open-webui/issues/23339) |

Every row ships with a `source` URL — community PRs against [`packages/matrix/data/engine-matrix.json`](packages/matrix/data/engine-matrix.json) are welcome and don't require a release. The matrix is published as its own package, `unswallow-matrix`, **versioned independently of `unswallow`** — closer to an antivirus definitions file than a code release (see [`packages/matrix/README.md`](packages/matrix/README.md)). `npm run matrix:update` refreshes upstream issue status via the GitHub API (used by the weekly CI watcher) and reports which benchmark fixtures a behavior flip would force to change.

## Benchmarks

Three layers, all independently rerunnable on your own hardware.

### Correctness — 17/17 hash-pinned fixtures

Hash-pinned fixture corpus seeded from the real upstream reports — **every fixture is byte-checked against `packages/bench/fixtures.sha256` before it runs**, so results can't silently drift. Engine/version hints are recorded per fixture; sample size and sourcing (`sourced: true/false`) are disclosed in every published result.

| id | engine | version | expected | actual | recovered | confidence | status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| vllm-qwen3.5-0.19-pattern-a | vllm | 0.19.0 | A | A | yes | 0.95 | PASS |
| vllm-qwen3.5-0.19-pattern-a-parallel | vllm | 0.19.0 | A | A | yes (2) | 0.95 | PASS |
| vllm-qwen3.5-0.19-pattern-a-duplicate | vllm | 0.19.0 | A | A | yes (1) | 0.95 | PASS |
| vllm-qwen3-0.19-pattern-a-json-envelope | vllm | 0.19.0 | A | A | yes | 0.95 | PASS |
| vllm-qwen3-0.19-tool-choice-required-pattern-b | vllm | 0.19.0 | B | B | yes | 0.55 | PASS |
| vllm-qwen3-0.23-pattern-a-partial | vllm | 0.23.4 | A | A | yes | 0.80 | PASS |
| vllm-qwen3-0.24-clean | vllm | 0.24.0 | none | none | no | 0.00 | PASS |
| vllm-qwen3.5-0.19-streaming-pattern-a | vllm | 0.19.0 | A | A | yes | 0.95 | PASS |
| sglang-qwen3.5-reasoning-content-pattern-a | sglang | 0.4.6 | A | A | yes | 0.95 | PASS |
| llamacpp-qwen3.5-thinking-pattern-a | llama.cpp | b8461 | A | A | yes | 0.95 | PASS |
| pi-kimi2-pattern-b | — | — | B | B | yes | 0.55 | PASS |
| pi-kimi2-streaming-pattern-b | — | — | B | B | yes | 0.55 | PASS |
| minimax-m3-pattern-c-leak | — | — | C | C | no | 0.50 | PASS |
| minimax-m3-streaming-pattern-c-leak | — | — | C | C | no | 0.50 | PASS |
| deepseek-reasoning-content-pattern-a | sglang | 0.4.6 | A | A | yes | 0.95 | PASS |
| fp-guard-discussion-only | vllm | 0.19.0 | none | none | no | 0.00 | PASS |
| fp-guard-partial-json | vllm | 0.19.0 | none | none | no | 0.00 | PASS |

Regenerate with `npm run bench`; verified read-only in CI (`npm run bench:check`). Every fixture is also cross-checked against its engine matrix row: flip a row to a different behavior and the matching fixture must flip too, or CI fails.

### Performance — measured

`npm run bench:perf` — seeded, deterministic corpus; warm latencies, p50/p95/p99, throughput, and retained heap per call (measured with `--expose-gc`). Full report with machine info in [`packages/bench/perf/results.md`](packages/bench/perf/results.md). Latest run (measured 2026-09-03):

*Node v22.16.0 · AMD Ryzen 5 2600X (12 cores) · 15.9 GB RAM · win32 x64*

| scenario | payload | p50 / p95 / p99 | mean | throughput |
| --- | --- | --- | --- | --- |
| Pattern A — small reasoning | 2.8 KB | 0.15 / 0.24 / 0.46 ms | 0.162 ms | ~6,200 ops/s |
| Pattern A — function-XML envelope | 1.8 KB | 0.13 / 0.21 / 0.41 ms | 0.141 ms | ~7,100 ops/s |
| Pattern A — large reasoning | 63.5 KB | 0.23 / 0.37 / 0.74 ms | 0.248 ms | ~4,000 ops/s |
| Pattern A — 1 MB reasoning | 987 KB | 2.29 / 4.82 / 9.03 ms | 2.721 ms | ~370 ops/s |
| Pattern B — trailing text | 1.0 KB | 0.14 / 0.24 / 0.42 ms | 0.152 ms | ~6,600 ops/s |
| Pattern C — field leak | 0.5 KB | 0.09 / 0.15 / 0.31 ms | 0.096 ms | ~10,400 ops/s |
| Healthy (tool_calls populated) | 1.1 KB | 0.08 / 0.12 / 0.21 ms | 0.080 ms | ~12,500 ops/s |
| False-positive guard (discussion-only) | 1.5 KB | 0.08 / 0.12 / 0.20 ms | 0.083 ms | ~12,100 ops/s |
| Streaming — typical reasoning stream (843 chunks, 19.7 KB) | — | 1.98 / 3.07 / 3.58 ms | 2.066 ms | ~480 streams/s |
| Streaming — 500 KB content stream (5,323 chunks) | — | 15.11 / 17.93 / 18.58 ms | 15.180 ms | ~66 streams/s |
| sanitizeHistory — 40-message history | — | 0.09 / 0.13 / 0.24 ms | 0.091 ms | ~11,000 ops/s |
| matchMatrixEntry — 100k lookups | — | 0.00 / 0.01 / 0.01 ms | 0.002 ms | ~519,000 ops/s |

Notes, honestly stated: every check is linear in payload size (a 1 MB reasoning block costs ~1.7 ms); recovery only runs when an envelope is found, and only the recovered path makes a deep copy; a healthy response (already-parsed `tool_calls`) is the cheapest path by design — it returns before any scanning. JSON.parse of the 64 KB payload alone measures ~0.30 ms, so the scan itself is the minority of the cost. Two methodology notes: the corpus text is seeded word-salad, not production reasoning traces, so brace/quote-heavy real CoT may scan slightly differently; and `retained/op` is a post-GC floor (negative GC noise is clamped to `0.00`), i.e. "nothing retained after a full collection", not "nothing allocated". Benchmarks are wall-clock on a shared dev machine — the JSON.parse reference row in the full report is the load anchor (it reads ~0.24 ms on a quiet box, 0.333 ms in the run above): compare it across runs to judge machine load before comparing anything else. Treat cross-machine comparisons with care, and run `npm run bench:perf` on your own hardware before quoting numbers anywhere.

### Python parity — 17/17, exact confidence equality

`npm run bench:python` — the same pinned 17-fixture corpus runs through the Python core and is compared against the TypeScript results **including exact confidence values** (Python 3.14.6):

```
17 / 17 fixtures: expectations + exact confidence parity with the TypeScript core
```

Same seeds, same payloads, same percentile methodology — `packages/python/bench/results_python.md` mirrors the TS report. Honest headline numbers (measured 2026-09-03, Python 3.14.6, same machine):

| workload | Python | TypeScript (same run date) |
| --- | --- | --- |
| check_and_rescue, small reasoning | ~0.51 ms · ~2,000 ops/s | ~0.16 ms · ~6,200 ops/s |
| check_and_rescue, 1 MB reasoning | ~1.73 ms · ~580 ops/s | ~2.7 ms · ~370 ops/s |
| check_and_rescue_stream (843 chunks) | ~26.0 ms | ~2.07 ms |
| sanitizeHistory (40-message history) | ~0.62 ms | ~0.09 ms |
| match_matrix_entry, 100k lookups | ~0.016 ms · ~64k ops/s | ~0.002 ms · ~519k ops/s |

### Proxy overhead (measured 2026-09-03)

Measured loopback with an in-process upstream (`npm run bench:perf`, proxy section). The added cost is dominated by the second HTTP roundtrip and JSON re-encoding, i.e. the cost of any proxy layer, not of the detection itself — note the direct baselines move with machine load, so read the `added` column, not the absolutes:

| case | direct | via proxy | added |
| --- | --- | --- | --- |
| non-stream, swallowed (recovered) | 2.67 ms | 5.88 ms | +3.22 ms |
| non-stream, healthy (passthrough) | 2.01 ms | 4.72 ms | +2.71 ms |
| streaming, swallowed (recovery tail) | 3.17 ms | 5.63 ms | +2.46 ms |

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