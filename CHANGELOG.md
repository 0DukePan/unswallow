# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.2]: https://github.com/0DukePan/unswallow/releases/tag/v0.1.2
[0.1.1]: https://github.com/0DukePan/unswallow/releases/tag/v0.1.1
[0.1.0]: https://github.com/0DukePan/unswallow/releases/tag/v0.1.0
