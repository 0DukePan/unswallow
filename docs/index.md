# unswallow docs

The docs live next to the code they describe — every page below is linked from
the places that matter (README sections point at the methodology/repro pages,
CONTRIBUTING at the release/dev process).

## The bug and the library

- [README](../README.md) — problem statement, patterns A–D, quick start,
  library/streaming/CLI/proxy usage, confidence, engine matrix, benchmarks.
- [limitations.md](limitations.md) — honest edges, detection caps, FAQ.
- [false-positives.md](false-positives.md) — what counts as a false positive,
  the guard fixtures, what the guard does not promise.

## Reproducing and verifying

- [reproduction.md](reproduction.md) — the live-reproduction protocol, the
  `packages/bench/live-probe` harness, the evidence template, the status
  definitions, and the **verified live reproduction** (llama.cpp b8461 +
  Qwen3.5-9B, Pattern A, non-streaming + streaming) with exact repro
  commands.
- [compatibility.md](compatibility.md) — provider × engine version × model ×
  pattern status table. First **Verified** row: llama.cpp b8461 (bug-era) +
  Qwen3.5-9B-UD-Q4_K_XL, Pattern A, detected + recovered; remaining rows
  honestly labeled Not reproduced / sourced.
- [benchmarks.md](benchmarks.md) — how to run every benchmark layer and
  reproduce the numbers (correctness, perf, parity, fp-eval, Linux reference).
- [agent-integrations.md](agent-integrations.md) — runnable OpenAI-compatible
  examples + **verified real-install LangChain/LlamaIndex drivers** through
  the proxy + recipes for the OpenAI SDK / custom agents / self-hosted
  engines.

## Integration and operations

- [integrations.md](integrations.md) — LiteLLM callback, OpenTelemetry
  adapters (TS + Python), SDK patterns.
- [launch.md](launch.md) — launch notes.
- [release-policy.md](release-policy.md) — versioning, lifecycle (0.1.x →
  1.0.0), release steps, migration notes, pre-release checklist.

## Contributing

- [CONTRIBUTING.md](../CONTRIBUTING.md) — fixtures, matrix updates, dev
  commands, scope guard.

## The developer journey

```bash
git clone https://github.com/0DukePan/unswallow && cd unswallow
npm ci                          # 1. install (dev tooling only; runtime deps are zero)
npm run build                   # 2. build the TS core
npm test                        # 3a. TS tests (99)
npm run test:python             # 3b. Python tests (94)
npm run lint && npm run typecheck   # 4. lint + types (eslint/tsc + ruff/mypy)
npm run coverage                # 5. coverage (TS)
python packages/scripts/coverage_python.py   #    coverage (Python)
npm run bench:check             # 6. hash pins + fixture expectations + matrix consistency
npm run bench:fp                # 7. fp-eval (0 FP / 0 FN, precision/recall)
python packages/python/bench/parity.py   # 8. 22/22 exact-confidence parity
npm run live-probe              # 9. reproduction harness (synthetic cases, no engine)
npm run examples && npm run integration   # 10. walkthroughs (TS)
npm run examples:python && npm run integration:python  #    walkthroughs (Python)
```

Everything above runs on a stock machine with Node ≥ 18.17 and Python ≥ 3.9 —
no engines, GPUs, or author-specific environment required. Live engine probing
(`npm run live-probe -- --endpoint <base>/v1 --engine ...`) is the only step
that needs a server, and it is optional by design.
