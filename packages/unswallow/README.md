# unswallow

[![npm version](https://img.shields.io/npm/v/unswallow)](https://www.npmjs.com/package/unswallow)
[![CI](https://github.com/0DukePan/unswallow/actions/workflows/ci.yml/badge.svg)](https://github.com/0DukePan/unswallow/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/0DukePan/unswallow/blob/main/LICENSE)
[![Zero runtime dependencies](https://img.shields.io/badge/runtime_deps-0-brightgreen)](https://github.com/0DukePan/unswallow/blob/main/packages/unswallow/package.json)

**Detect and recover tool calls trapped inside a model's reasoning channel.**

![unswallow demo](https://raw.githubusercontent.com/0DukePan/unswallow/main/docs/demo.gif)

Your agent's model *decided* to call a tool. The server returned `HTTP 200`, `finish_reason: stop`, and `tool_calls: []`. Your agent loop read "no tool call" and silently stopped mid-task. No crash, no error, no log line pointing at the cause.

The tool call is sitting, fully formed, inside the `reasoning` / `reasoning_content` / `thinking` field. The parser never looked there. This package finds it and puts it back — across **vLLM, SGLang, and llama.cpp**.

```bash
npm i unswallow
npx unswallow check   # self-test demo, or --endpoint to probe your live server
```

## 30-second quickstart

```ts
import { checkAndRescue } from 'unswallow';

const result = checkAndRescue(rawProviderResponse, {
  engineHint: 'vllm',        // 'vllm' | 'sglang' | 'llama.cpp'
  engineVersion: '0.19.0',
});

if (result.recovered && result.recoveredResponse) {
  return result.recoveredResponse;  // tool_calls populated, finish_reason fixed
}
```

One call in your response-handling path. The original object is never mutated (deep copy); clean responses pass through untouched with `confidence: 0`.

## What it covers

| Pattern | What happens | Example |
|---|---|---|
| **A — Trapped inside** | Tool call fully inside the reasoning block | [vLLM #39056](https://github.com/vllm-project/vllm/issues/39056) |
| **B — Trailing after** | Tool-call JSON in `content` with trailing text | [pi #952](https://github.com/earendil-works/pi/issues/952) |
| **C — Field leak** | Reasoning tags leak into the wrong field (detection-only) | MiniMax M3 `<mm:think>` leak |

Parallel calls are all recovered in order (`toolCalls[]`); exact duplicates collapse to one with a warning. A model merely *discussing* a tool call is never "recovered" — recovery requires a structurally complete envelope.

## More ways to use it

```ts
// Streaming (delta-size-agnostic: never parses partial content)
import { checkAndRescueStream } from 'unswallow';
const result = await checkAndRescueStream(sseChunkStream, { engineHint: 'vllm' });

// History hygiene (Pattern D prevention)
import { sanitizeHistory } from 'unswallow';
const clean = sanitizeHistory(messages);

// OpenAI-compatible proxy that heals responses inline
// npx unswallow proxy --upstream http://localhost:8000/v1 --port 8787
import { createProxyServer } from 'unswallow';
createProxyServer({ upstream: 'http://localhost:8000/v1' }).listen(8787);
```

```bash
npx unswallow check --endpoint http://localhost:8000/v1 --model Qwen/Qwen3.5-35B-A3B-FP8 --engine vllm
npx unswallow matrix        # sourced engine/version behavior matrix
```

Python users: `pip install unswallow` — a 1:1 stdlib-only mirror with the same CLI.

## Confidence, benchmarks, docs

Every detection carries a `confidence` score (matrix hit → 0.95, heuristic → 0.55, nothing → 0) plus a `warnings[]` array explaining exactly why. The engine/version behavior matrix ships as its own package (`unswallow-matrix`), every row sourced, refreshed weekly.

Full docs, benchmark reports (22 hash-pinned fixtures, measured latency tables, TS↔Python parity), and contributing guide: **[github.com/0DukePan/unswallow](https://github.com/0DukePan/unswallow)**.

MIT © 2026 unswallow contributors.
