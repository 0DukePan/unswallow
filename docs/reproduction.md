# Live reproduction protocol

How to reproduce the documented swallowed-tool-call patterns against a real
engine, how the harness records evidence, and what every status in the
[compatibility matrix](compatibility.md) actually means.

## Harness

`packages/bench/live-probe/` ships a reusable probe in both languages:

| file | language | command |
| --- | --- | --- |
| `live-probe.mjs` | TypeScript | `npm run live-probe` |
| `live_probe.py` | Python | `npm run live-probe:python` |

Both load every case from `packages/bench/live-probe/cases/*.json`, run it
through unswallow, and print a PASS/FAIL line per case plus a machine-readable
report when `--out` is given.

**No engine is required to run the harness.** Cases with a recorded
`rawResponse` (or `chunks`) are *synthetic*: the captured provider bytes are
replayed straight through unswallow, which is exactly how every pinned
benchmark fixture already works. Live cases — the ones that exercise a real
engine — carry a prompt in `request` instead and need `--endpoint`.

## What a case file records

```jsonc
{
  "probe": {
    "id": "synthetic-vllm-pattern-a-function-xml",
    "mode": "synthetic",            // synthetic | live
    "engine": "vllm",               // vllm | sglang | llama.cpp | openai | ...
    "version": "0.19.0",            // engine/server version
    "model": "synthetic/qwen3",
    "pattern": "A",                 // A | B | C | D | none
    "stream": false,
    "expect": { "detected": true, "pattern": "A", "recovered": true },
    "request": { ... },             // live only: messages/tools/params
    "rawResponse": { ... }          // synthetic only: captured bytes pre-unswallow
    // or "chunks": [...]            // synthetic streaming only
  }
}
```

A synthetic case *is* a live capture that was frozen into the corpus — the
`rawResponse` was recorded from a real provider before any unswallow
processing. The 22 pinned fixtures in `packages/bench/fixtures/` are exactly
that, sourced from the linked upstream reports.

## Running a live probe

```bash
# synthetic only — no engine, no endpoint (this is CI's job)
npm run live-probe
npm run live-probe:python

# live: any OpenAI-compatible server
npm run live-probe -- --endpoint http://localhost:8080/v1 \
    --model Qwen/Qwen3-4B --engine llama.cpp --version bXXXX --api-key none \
    --out packages/bench/live-probe/results-llamacpp.json

# run one case only
npm run live-probe -- --case packages/bench/live-probe/cases/synthetic-vllm-pattern-a-function-xml.json
```

The harness:

1. builds the request from the case (messages, tools, `stream`);
2. captures the **raw provider response** — non-streaming: the parsed JSON as
   returned; streaming: the SSE chunks reassembled through the accumulator —
   *before* unswallow sees it;
3. runs unswallow (`checkAndRescue` / `checkAndRescueStream`);
4. records provider, engine, engine version, model, pattern, stream mode,
   detection, recovery, recovered response, warnings, errors, latency, and
   the expectation check;
5. writes a JSON report (`--out`) with the full raw response embedded, and
   prints a human summary.

Exit codes: `0` all cases passed their expectation, `1` behavioral failures,
`2` usage/IO error.

## The recording template for a verified reproduction

For every **verified** row in the compatibility matrix, attach evidence in
the linked issue or PR (redact secrets only). The status-page/matrix
`verified` field is flipped to `true` only when the row carries all of:

| field | what it is |
| --- | --- |
| engine | exact server binary and how it was launched (flags incl. parser/tool-parser settings) |
| engine version | `--version` / server version output, not a guess |
| model | exact model id + quantization (and the template/hf id if relevant) |
| configuration | serving flags, `tool_choice`, request `tools` array, prompt used |
| pattern | A / B / C / D as classified by unswallow |
| raw response | the provider bytes before unswallow processing (embedded in the probe report) |
| expected behavior | what the engine should have done (tool call parsed) |
| observed behavior | what it did (empty `tool_calls`, trailing text, leak) |
| unswallow result | detected / pattern / confidence / warnings |
| recovery result | recovered calls + the healed response |
| probe command | the exact `live-probe` invocation + `--out` report path |

The probe report (`results-*.json`) contains all of this except the server
launch flags — put those in the PR description.

## What each status in the compatibility matrix means

| status | meaning |
| --- | --- |
| **Verified** | Reproduced with the protocol above against the real engine+version+model; raw response + unswallow result recorded. |
| **Partially verified** | The failure shape was reproduced but evidence is incomplete (e.g. no version output, or reproduced on a different quantization), or detection was confirmed without a full recovery trace. |
| **Not reproduced** | No live attempt yet — may still be *sourced* (reported upstream) or *synthetic* (reconstructed from a report). |
| **Unsupported** | The provider/version cannot exhibit the pattern (e.g. `resolved` rows), or unswallow does not handle that pattern for it. |
| **Unknown** | No data and no upstream report. |

Nothing is marked Verified without the evidence above — a fixture expectation
passing is *not* verification, it is a synthetic reconstruction of a report.

## Live runs done

| date | engine | version | model | pattern | result |
| --- | --- | --- | --- | --- | --- |
| 2026-09-06 | llama.cpp (CUDA, GTX 1060) | b10819 | Qwen3-0.6B-Q8_0 | A | **Negative live run** — the server parsed the tool call correctly (`reasoning_content` + `tool_calls: [get_weather]`, `finish_reason: tool_calls`); no swallow occurred. This is a real-engine observation (healthy), **not** a reproduction. Model too small / server too new to exhibit the bug; see the compatibility matrix. |

The 7 synthetic cases (A/B/C, streaming, healthy, fp-guard) pass in both TS
and Python with no engine installed. To attempt a swallow reproduction on
this class of setup, an older llama.cpp build plus a Qwen3 4B–30B model that
outpaces its parser is the realistic combination — a 0.6B model reliably
stops short of emitting the envelope.

Pattern D (history drift) is not reproducible through a single completion
endpoint by design — it is a multi-turn history phenomenon, handled
preventively by `sanitizeHistory`. See [limitations.md](limitations.md).
