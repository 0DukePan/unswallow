# Benchmarks — how to run and reproduce

All benchmark layers are rerunnable on your own hardware with the pinned,
hash-verified corpus. This page is the repro guide; the numbers themselves
live in the committed result files.

## What is measured

| layer | command | output | gate |
| --- | --- | --- | --- |
| Correctness (22 hash-pinned fixtures) | `npm run bench` | `packages/bench/results/` | `npm run bench:check` in CI |
| TS perf + proxy overhead | `npm run bench:perf` | `packages/bench/perf/results.md` / `.json` | manual, committed on change |
| Python parity (exact confidence) | `python packages/python/bench/parity.py` | stdout table | CI (python job) |
| Python perf | `python packages/python/bench/perf_python.py` | `packages/python/bench/results_python.md` | manual, committed on change |
| Linux numbers | `.github/workflows/bench-linux.yml` | `results-linux.*` | auto-commit on push after a bench change |
| FP evaluator (guard) | `npm run bench:fp` / `npm run bench:fp:python` | `packages/bench/results/fp-results.*` | CI on fixture/runner change |
| Proxy overhead | part of `npm run bench:perf` | `packages/bench/perf/results.md` §Proxy overhead | — |

## Reproduce a correctness run

```bash
npm ci                 # dev tooling only; the bench corpus has zero runtime deps
npm run bench          # verify sha256 pins, run the 22-fixture corpus, write results/
npm run bench:check    # read-only: fail if a pin or expectation drifts
```

`npm run bench` refuses to run if any pinned fixture changed on disk. After a
deliberate fixture change, re-pin with `npm run bench:update` (reviewed, per
CONTRIBUTING). CI runs `bench:check` on every PR, so a drifted pin or a
fixture expectation that contradicts its matrix row fails loudly.

## Reproduce a perf run

```bash
npm run bench:perf            # TS: latencies p50/p95/p99, throughput, retained heap, proxy overhead
python packages/python/bench/perf_python.py   # Python mirror of the same workloads
```

Both print the sha256 of the generated corpus; the two reports must carry the
same hash — that is the mechanical check behind "same seeds, same payloads".
Methodology notes that matter when comparing machines:

- Seeds are fixed; the corpus is word-salad plus the 22 real fixture shapes.
- Runs are pooled across 5 full passes; percentiles are pooled, the reported
  mean is the median of per-run means, min–max spread is shown.
- TS perf runs under `--expose-gc`; `retained/op` is a post-GC floor.
- Wall-clock on a shared machine: compare the JSON.parse reference row in the
  report across runs to judge machine load before comparing anything else.

## The false-positive evaluator

```bash
npm run bench:fp          # 11 positive + 8 negative fixtures + 200 synthetic negatives
npm run bench:fp:python   # the same corpus through the Python core
```

Both must report 0 false positives and 0 false negatives. The synthetic
negatives are seeded word-salad with tool-call vocabulary but no structural
envelope — the guard must stay silent on all of them.

## Cross-language parity

`python packages/python/bench/parity.py` runs the pinned 22-fixture corpus
through the Python core and requires not just matching expectations but
**exact** equality of every confidence value against the committed TS results
(`packages/bench/results/results.json`). It is part of the CI python job, so
TS/Python behavior drift fails a PR.

## Linux numbers

`.github/workflows/bench-linux.yml` runs the full perf suite on ubuntu-latest
and commits `*-linux.*` reports next to the Windows ones. The committed Linux
artifacts are the reference for cross-machine comparisons — desktop numbers
move with machine load, and the README says so.
