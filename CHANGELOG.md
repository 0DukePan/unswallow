# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-09-06

The reproduction + benchmark release (unswallow 0.2.0, unswallow-matrix
0.2.0, Python unswallow 0.2.0). The headline: the first **verified live
reproduction** of a swallowed tool call, closing the evidence gap between
"reported upstream" and "reproduced and recovered here".

### Added

- **Verified live reproduction (Pattern A, llama.cpp b8461)**: drove the
  exact bug-era build from [ggml-org/llama.cpp #20837](https://github.com/ggml-org/llama.cpp/issues/20837)
  (b8461, cea560f) with unsloth Qwen3.5-9B-UD-Q4_K_XL and thinking
  enabled through a multi-turn agent loop. After one successful tool call,
  the model emitted the XML envelope
  (`<tool_call><function=read_file>...`) inside `reasoning_content` and
  stopped with `finish_reason: stop` and no `tool_calls` — in both
  non-streaming and streaming modes. Raw responses were captured
  pre-unswallow and are pinned as fixtures
  `llamacpp-b8461-qwen3.5-9b-multiturn-pattern-a` /
  `-streaming-multiturn-pattern-a`; unswallow recovers
  `read_file({"path": "package.json"})` at confidence 0.95. The engine
  matrix llama.cpp row is now `verified: true` with the live evidence
  recorded (matrix v1.3.0), and `docs/reproduction.md` documents the exact
  repro commands. Also recorded as dated negative live runs: llama.cpp
  b10819 + Qwen3-0.6B (healthy), Pattern B single-turn (9/9 healthy),
  Pattern C mid-think truncation (clean channel split).
- **Live-reproduction harness** (`packages/bench/live-probe`, TS +
  Python): runs recorded synthetic cases or any OpenAI-compatible endpoint,
  captures the raw provider response before unswallow processing, records
  provider/engine/version/model/pattern/stream/detection/recovery/latency/
  errors, and writes machine-readable JSON + human output. Live cases skip
  cleanly when no endpoint is configured.
- **Real agent integrations verified** (LangChain + LlamaIndex): installed
  `langchain-openai` / `llama-index` / `openai` and drove real agents
  through the unswallow proxy against a mock that serves the live-captured
  b8461 swallow — both frameworks execute the recovered `read_file`
  end-to-end (`packages/examples/integration_langchain.py`,
  `integration_llama_index.py`, `run_framework_integrations.py`, plus the
  manual-dispatch `framework-integrations` workflow).
- **Formal fp-eval metrics**: TP/FP/TN/FN + precision/recall/specificity/F1
  reported in both languages (pinned corpus now 12 positives + 8 negatives
  + 200 synthetic negatives; 0 FP / 0 FN, precision/recall/F1 1.0), with
  the evaluated engine-matrix version recorded in the results.
- **Edge-case + regression sweep**: 14 new tests per language (parsing
  escapes/unicode/whitespace/missing keys, streaming robustness against
  empty and non-string deltas, history corruption survival). TS 99, Python
  94.
- **CI completeness**: ruff lint on Python, fp-eval gates (TS + Python),
  `bench:smoke` aggregate on the test matrix, docs link checker over all
  markdown, and a package artifact validation job (npm pack + wheel
  install smoke). All green on GitHub Actions for `main`.

### Changed

- Engine matrix `matrixVersion` 1.2.0 → 1.3.0 (llama.cpp row verified).
- `docs/reproduction.md`, `docs/compatibility.md`,
  `docs/agent-integrations.md`: Verified row, live-run records, exact repro
  commands, and real-install integration notes.

### Migration notes

- No API or behavior changes; confidence/recovery for the affected
  llama.cpp + Qwen3.5 combination is unchanged (still 0.95 on a matrix
  hit). The matrix `verified` flag and the new fixtures are additive.

## [0.1.3] - 2026-09-05

The launch release: everything committed since 0.1.2, all three packages
(unswallow 0.1.3, unswallow-matrix 0.1.3, Python unswallow 0.1.3).

### Added

- **Benchmark hardening**: every scenario runs 5 full passes (3 for async)
  with the per-run min–max spread reported; component probes back the
  README's TS↔Python divergence note (deep copy, envelope scan, leak-tracker
  loop); the 22 pinned fixtures run through the same harness (real fixture
  corpus section); both reports print a matching corpus sha256. This also
  fixed a `mulberry32` port bug — the Python RNG was missing the canonical
  final XOR, so the two languages were generating different corpora while
  the README claimed "same seeds, same payloads".
- **Framework adapters**: LiteLLM `CustomLogger` callback, OpenTelemetry
  adapters (TS + Python, spans + detection counter), and
  `docs/integrations.md` with OpenAI SDK / Vercel AI SDK / LangChain
  patterns — all lazily imported, core stays zero-dependency.
- **Supply chain + stability**: npm provenance config, tag-triggered
  `publish.yml` (matrix → unswallow → PyPI), README stability policy
  (semver, matrix data-format compat), matrix package compat policy.
- **Status page**: `render-status.mjs` + GitHub Pages deploy workflow,
  regenerated weekly and on matrix data changes.
- **Engine matrix v1.2.0**: sourced LM Studio row (pattern A swallow,
  lmstudio-bug-tracker #827), tracked by the weekly watcher.
- **CI**: verified-column + version assertions in CLI smoke tests; weekly
  registry smoke workflow against the published npm/PyPI packages.

## [0.1.2] - 2026-09-05

Release of the pre-launch hardening pass (unswallow 0.1.2, unswallow-matrix
0.1.2, Python unswallow 0.1.2).

### Added

- `unswallow matrix` now renders a `verified` column (`yes`/`no`) in both the
  TypeScript and Python CLIs, matching the `verified` field already carried by
  every engine-matrix row.
- Engine matrix data v1.1.0 (unswallow-matrix 0.1.2) marks every row
  `verified: false` with a README legend: rows are sourced from upstream
  reports, none has been independently reproduced by the maintainer yet, and
  a PR flipping a row to `verified: true` requires server-version output +
  probe transcript as evidence.
- 5 new false-positive-guard fixtures (7 total), pinning the rule that
  recovery requires a structurally complete envelope — a model merely
  discussing a tool call is never recovered.
- Naive-measurement baseline in both perf benches (TS + Python), explaining
  the measured cross-language divergence (clone vs scan overhead).

### Changed

- README benchmark section now integrates the committed Linux numbers
  (clone 0.54 vs 0.007 ms, scan 0.125 vs 0.259 ms, tracker loop ~9.4 of
  11.7 ms); `unswallow --version` reports the package version.

## [0.1.1] - 2026-09-04

### Fixed

- npm package page: bundled a dedicated `README.md` with the published
  package (previously the npm page rendered with no readme body) and
  refreshed package metadata.

## [0.1.0] - 2026-09-03

Initial release.

### Added

- Core detection and recovery engine (TypeScript, zero runtime dependencies):
  Pattern A (tool call trapped inside the reasoning channel) and Pattern B
  (tool-call envelope stranded in `content`) detection + recovery; Pattern C
  (reasoning-tag field leak) detection-only.
- Parallel tool-call recovery: every structurally complete envelope in a
  swallowed turn is recovered in document order (`toolCalls[]`); exact
  duplicates collapse to one with a warning; scan caps at 32 envelopes.
- Streaming support: delta-size-agnostic accumulator
  (`createStreamAccumulator`, `checkAndRescueStream`) with live Pattern C
  leak events; full check-and-rescue pass runs once at stream end.
- History hygiene (Pattern D): `sanitizeHistory` / `stripReasoningTags`
  strip reasoning fields and leaked think blocks from conversation history
  without touching plain text.
- Diagnostic CLI (`npx unswallow check`): bundled self-test demo, live
  endpoint probing with exit codes for CI, captured-response fixtures,
  machine-readable `--json`, and the `unswallow matrix` browser.
- OpenAI-compatible proxy mode (`npx unswallow proxy`, `createProxyServer`):
  heals responses in place (non-streaming), appends a recovery tail
  (streaming), propagates downstream client aborts to upstream, and passes
  everything else through untouched.
- Python port (`pip install unswallow`): 1:1 stdlib-only mirror of the
  TypeScript library, CLI included.
- Engine/version behavior matrix as an independently versioned data package
  (`unswallow-matrix`), every row sourced, with a weekly upstream-status
  watcher and fixture-impact reporting.
- Benchmarks: 17 hash-pinned fixtures (sourced + adversarial), measured
  latency/throughput/memory reports for both languages, TS↔Python exact
  parity bench, and proxy-overhead measurements.

### Fixed

- False-positive guard: recovery requires a structurally complete envelope
  (`name` + `arguments`); a model merely discussing a tool call is never
  "recovered" (pinned adversarial fixtures enforce this).
- Single-call bottleneck: the pipeline no longer stops at the first envelope
  per turn.
- Proxy client aborts now cancel the upstream request instead of draining it.

[0.2.0]: https://github.com/0DukePan/unswallow/releases/tag/v0.2.0
[0.1.3]: https://github.com/0DukePan/unswallow/releases/tag/v0.1.3
[0.1.2]: https://github.com/0DukePan/unswallow/releases/tag/v0.1.2
[0.1.1]: https://github.com/0DukePan/unswallow/releases/tag/v0.1.1
[0.1.0]: https://github.com/0DukePan/unswallow/releases/tag/v0.1.0
