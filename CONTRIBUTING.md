# Contributing

Small project, sharp scope: detect and recover tool calls trapped in reasoning channels. If you are here because a server swallowed your tool call — you are the target user, and your raw response is the most valuable contribution there is.

## How to contribute a fixture (most valuable)

If your model output looks like this — `tool_calls: []` while a tool call is visibly sitting in `reasoning` / `reasoning_content` / `thinking`:

1. Open an issue with the **raw, unredacted provider response JSON** (redact secrets only).
2. Tell us: engine, version, model, serving flags (e.g. `--reasoning-parser qwen3 --tool-call-parser qwen3_coder`), and the request's `tools` array if possible. Streaming captures are just as valuable as non-streaming.
3. It becomes a hash-pinned fixture in `packages/bench/fixtures/` with full attribution to the issue.

Rules that keep the corpus honest:

- **Fixtures are pinned.** Every fixture is SHA-256 recorded in `packages/bench/fixtures.sha256`. The runner refuses to run if a pinned fixture changes. Regenerate pins only after review, with `npm run bench:update`.
- **Fixtures must match reality.** Think tags are byte-verified against engine sources: vLLM's Qwen3 parser uses ` thinking` / ` response` and `<tool_call>…</tool_call>` with `<function=NAME>` / `<parameter=KEY>VALUE</parameter>`. When in doubt, check the serving engine's parser source, not a blog post. Documented second mechanisms are welcome as their own fixtures (e.g. the vLLM 0.19 `tool_choice: "required"` silent-empty bug from #39056, PR #35936).
- **Perf changes need perf evidence.** If a PR changes scan/recovery internals, run `npm run bench:perf` before and after and include the numbers (or at least confirm no order-of-magnitude regression) in the description.
- **Every fixture carries its source.** `sourced: true` means it's reconstructed from a real report; `false` means self-authored/adversarial. Sample size and sourcing are disclosed in every published result.
- **Fixtures are cross-checked against the engine matrix.** `bench/run.mjs --check` fails if a fixture's expectations contradict its matrix row's behavior — flipping a matrix row to `resolved` forces the matching fixtures to flip too.
- **Adversarial fixtures are welcome.** Especially attempts to make the false-positive guard misfire (model *discussing* a tool call without invoking one). Those are the most important fixtures in the corpus.
- **Multi-envelope invariant.** A swallowed turn may carry several parallel calls: every structurally complete envelope must be recovered in document order (`toolCalls`), exact duplicates collapse to one with a warning, and the scan caps at 32. Fixtures with several calls set `toolCallCount` in `expect` — the runner enforces it in both languages.

## How to update the engine matrix

The matrix (`packages/matrix/data/engine-matrix.json`) is a living data file published as its own package, `unswallow-matrix`, versioned independently of `unswallow`. One row, one source URL, one PR:

```json
{
  "engine": "vllm",
  "versionRange": ">=0.24.0",
  "pattern": "A",
  "behavior": "resolved",
  "knownBehavior": "short description",
  "source": "https://github.com/.../issues/..."
}
```

Matrix changes don't require a package release. `npm run matrix:update` polls the tracked upstream issue threads, refreshes `packages/matrix/data/upstream-status.json`, and reports which benchmark fixtures each row affects.

## Development

```bash
npm install
npm run build     # tsc -> packages/unswallow/dist/
npm test          # 52 tests (semver, core, false-positive guard, streaming, history hygiene, proxy)
npm run test:python   # 42 tests, stdlib-only (mirrors the TS suite)
npm run bench     # verify hash pins + run the 17-fixture corpus + matrix consistency, write packages/bench/results/
npm run bench:perf     # TS latencies/throughput/memory + proxy overhead, write packages/bench/perf/
npm run bench:python   # Python parity (15 fixtures vs TS, exact confidence) + Python perf, write packages/python/bench/
npm run matrix:update  # poll tracked upstream issue threads (advisory + snapshot) + sync matrix into the Python package
```

Repo layout (npm workspaces):

```
packages/
  unswallow/   # the published `unswallow` package: src/ (core + streaming + history + proxy), cli/ (bin)
  matrix/      # the published `unswallow-matrix` package: data/engine-matrix.json, update tooling
  bench/       # private: fixtures/, run.mjs, perf.mjs, results/
  python/      # the published PyPI `unswallow` package: 1:1 Python mirror (stdlib-only)
```

The engine matrix is bundled in the Python package as data — `npm run matrix:update` syncs it automatically (`python packages/python/scripts/sync_matrix.py`), and CI fails if the copies drift apart.

Requirements for merged code:

- Zero runtime dependencies (`unswallow` depends only on `unswallow-matrix`; the Python package is pure stdlib).
- No test regressions; a new fixture for any new detection/recovery behavior; streaming behavior needs streaming fixtures; proxy behavior needs proxy tests with a fake upstream.
- TS and Python must stay behaviorally identical — the Python test suite mirrors the TS suite, and the 17-fixture bench corpus runs against the TS core. If you change detection semantics, port the change to both.
- CLI output must stay dependency-free (plain ANSI, no chalk-style deps).
- Comments in code are avoided by convention; the README is the documentation.

## Scope guard

This project deliberately does **not** normalize tool-call dialects, rewrite prompts, or act as a general proxy. If your feature fixes tool calls that *aren't* the reasoning-channel swallow, it probably belongs elsewhere.

## License

MIT.