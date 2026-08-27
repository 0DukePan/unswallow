# @unswallow/matrix

The living engine/version behavior matrix for the reasoning-channel tool-call swallow bug class.

This package is the data file that `unswallow`'s confidence scoring is built on — **versioned independently of the `unswallow` package**, closer to an antivirus definitions file than a code release. A matrix update should never require an `unswallow` release, and an `unswallow` release should never require a matrix change.

## What's in here

- `data/engine-matrix.json` — the matrix. Every row carries a `source` URL; nothing is asserted without one.
- `data/upstream-status.json` — snapshot of the tracked upstream issue threads (refreshed by the weekly CI watcher).
- `scripts/update-matrix.mjs` — polls the tracked upstream issue threads (`npm run update` or `npm run matrix:update` at the repo root).

## How to update a row

Edit `data/engine-matrix.json` and open a PR. That's it — no package release required. The benchmark suite (`packages/bench`) enforces consistency between matrix rows and its fixtures, so flipping a row to `resolved` forces the corresponding fixture to flip as well, or CI fails.

## Row schema

| field | meaning |
| --- | --- |
| `engine` | `vllm` \| `sglang` \| `llama.cpp` — omit for harness-scoped rows |
| `harness` | for rows that describe a harness/framework rather than an engine (e.g. `open-webui`, pattern D) |
| `versionRange` | semver range: `<=0.19.0`, `>=0.20.0 <0.24.0`, `*`, `a || b` |
| `pattern` | `A` trapped-inside · `B` trailing-after · `C` field leak · `D` history drift |
| `behavior` | `swallow` \| `partial` \| `resolved` |
| `knownBehavior` | short description, surfaced in `warnings[]` |
| `source` | issue/PR URL — every row must be sourced |
| `fixHint` | server-side remediation, surfaced by the CLI |
| `modelFamilies` | optional: models the row applies to |

## Release

Bump the version here, publish with `npm publish` from this directory, and bump the `@unswallow/matrix` range in `packages/unswallow/package.json` if needed. Matrix data itself never waits for this process.