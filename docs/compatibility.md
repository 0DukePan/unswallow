# Compatibility matrix

Provider × engine version × model × pattern. This is the *empirical*
companion to the [engine behavior matrix](../packages/matrix/data/engine-matrix.json)
(what is reported) — this page tracks what has actually been **reproduced**
and how unswallow behaved on the reproduction.

Status values: **Verified** · **Partially verified** · **Not reproduced** ·
**Unsupported** · **Unknown**. The protocol and evidence requirements live in
[reproduction.md](reproduction.md) — nothing is marked Verified without a
recorded raw response from the real engine.

| Provider | Version | Model | Pattern | Streaming | Reproduced | Detected | Recovered | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llama.cpp | b8461 (bug-era) | Qwen3.5-9B-UD-Q4_K_XL | A | both | **Verified** (2026-09-06) | yes (0.95) | yes (`read_file`) | Live repro of [#20837](https://github.com/ggml-org/llama.cpp/issues/20837): multi-turn agent loop, thinking enabled; XML envelope in `reasoning_content` after a prior tool call, `finish: stop`, no `tool_calls`. Pinned as fixtures `llamacpp-b8461-qwen3.5-9b-multiturn-pattern-a` / `-streaming-multiturn-pattern-a`. |
| llama.cpp | b10819 (CUDA) | Qwen3-0.6B-Q8_0 | A | both | **Negative live run** (2026-09-06) | no | no | Healthy: server parsed `get_weather` correctly into `tool_calls`; harness verified passthrough. Not a swallow reproduction — evidence the bug needs a larger model / older build. |
| vLLM | 0.19.x | Qwen3 / Qwen3.5 (reported) | A | — | Not reproduced | — | — | Sourced: [#39056](https://github.com/vllm-project/vllm/issues/39056). Synthetic fixtures only. |
| vLLM | 0.19.x | Qwen3 (reported) | B | — | Not reproduced | — | — | Sourced: `tool_choice: required` silent-empty bug, [#39056](https://github.com/vllm-project/vllm/issues/39056) PR #35936. |
| vLLM | >= 0.24.0 | Qwen3 | A/B | — | Not reproduced | — | — | Reported resolved / partial upstream. Running a recovery against this range is expected to warn (confidence 0.60) — see matrix rows. |
| SGLang | 0.4.x | Qwen3 (reported) | A | — | Not reproduced | — | — | Sourced: [#30744](https://github.com/sgl-project/sglang/issues/30744). |
| pi (Kimi-K2) | — | Kimi-K2-Thinking | B | — | Not reproduced | — | — | Sourced: [pi #952](https://github.com/earendil-works/pi/issues/952). |
| MiniMax M3 | — | M3 | C | yes | Not reproduced | — | — | Sourced + synthetic streaming fixture. Detection-only. |
| open-webui | — | — | D | — | Not reproduced | — | — | History-drift pattern; prevention via `sanitizeHistory`, not single-response reproducible. |
| lmstudio | — | — | A | — | Not reproduced | — | — | Sourced: [lmstudio-bug-tracker #827](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/827). |
| Any OpenAI-compatible endpoint | any | any | A/B/C | both | **Harness ready** | — | — | Point `live-probe` at it: `npm run live-probe -- --endpoint <base>/v1 --engine ... --version ... --model ...`. |

## Configuration requirements per provider

- **vLLM**: reproduce the swallow with the Qwen3 reasoning parser +
  `qwen3_coder` (≤ 0.19) tool-call parser and `tool_choice: "required"` for
  the Pattern B silent-empty variant. The parser combo that routes
  pre-`</thinking>` output into `reasoning` is the trigger — see the matrix
  entry `knownBehavior` for the exact mechanism.
- **SGLang**: Qwen3 with reasoning content enabled; envelope appears in
  `reasoning_content`.
- **llama.cpp**: `--reasoning-budget` / think-block handling with a Qwen3
  model; envelope inside the think block (`reasoning` channel).
- **pi / MiniMax / open-webui**: hosted or app-side; capture the raw response
  (`--fixture`/synthetic case) if you cannot run the serving stack yourself.

## Known limitations

- **Pattern D is not single-response reproducible** — it needs a multi-turn
  history; unswallow's answer is prevention (`sanitizeHistory`), so there is
  no D-detection row to verify.
- **vLLM >= 0.24 "resolved" rows** are reported-fixed upstream, not verified
  fixed here. Detection against them is *expected to warn* — a fixture whose
  `engineVersion` is inside a `resolved` range keeps recovering but at
  confidence 0.60 with a "reported version is probably wrong" warning.
- **Engines not listed** are Unknown until probed — the harness makes that a
  five-minute job if you have a server.
