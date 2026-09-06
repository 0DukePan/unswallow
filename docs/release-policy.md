# Versioning & release policy

## Versioning

Semantic versioning for all published packages (`unswallow` npm, `unswallow-matrix`
npm, `unswallow` PyPI). During `0.x` the convention applies as usual: breaking
changes land in minor bumps (`0.2.0`, not `0.1.1`), and are called out in the
CHANGELOG.

- **The three packages version together** for code releases (unswallow,
  unswallow-matrix, Python unswallow share the `vX.Y.Z` tag), but the matrix
  *data* is versioned independently (`matrixVersion` inside
  `engine-matrix.json`) and can ship new rows between code releases.
- **Zero runtime dependencies is a compatibility promise** — no new required
  dependency enters the runtime path without a major version.
- **Matrix data-format policy** (see `packages/matrix/README.md`): additive
  changes are non-breaking; removing/renaming a field or flipping an existing
  row's behavior is a breaking change requiring a major bump.

## The release lifecycle

Current and planned phases (per the roadmap in the README):

| phase | meaning | contents |
| --- | --- | --- |
| 0.1.x | experimental | core detection/recovery, streaming, proxy, Python port, fixtures |
| 0.2.x | reproduction + benchmark | live-reproduction harness, verified compatibility matrix, formal FP metrics |
| 0.3.x | integration-focused | agent-stack integrations, framework adapters |
| 1.0.0 | stable | public API and behavior stable; breaking changes only via majors |

**v1.0.0 is not released until the public API and detection behavior are
stable** — no pending behavioral flips in the matrix, no API surface churn in
the pipeline. Until then, `0.x` minors may still break API.

## How a release happens

1. **Bump the version** in `packages/unswallow/package.json`,
   `packages/matrix/package.json`, `packages/python/pyproject.toml`, and the
   Python `__init__.py` — all three must match the tag.
2. **Update `CHANGELOG.md`** — the changelog entry for the version becomes the
   GitHub Release notes (the publish workflow reads it), so it must land in the
   same commit as the bump.
3. **Commit + tag + push**:

   ```bash
   git commit -am "release: v0.2.0"
   git tag v0.2.0
   git push origin main --tags
   ```

4. **The publish workflow** (`.github/workflows/publish.yml`, on `v*` tags)
   publishes `unswallow-matrix` first (dependency order), then `unswallow`
   with npm provenance, then the Python package to PyPI, then opens a **draft
   GitHub Release** with the changelog notes.
5. **Review and publish the draft release** — releases are never
   auto-published.

CI on `main`/PRs runs tests, lint, typecheck, coverage, the read-only bench
corpus check, the fp-eval gate, both language parity runs, the example
walkthroughs, and the package artifact validation job — so a tagged commit is
already fully verified before the tag fires the publish.

## Migration notes

Breaking changes (during `0.x`: minor bumps) must carry a migration note in
the CHANGELOG entry describing what changed, why, and how to update —
including any effect on detection results (e.g. a matrix row flip that changes
confidence or recovery for an engine/version combination).

## Pre-release checks (this repo's Definition of Done)

- [ ] `npm test`, `python -m unittest discover -s packages/python/tests -t packages/python`
- [ ] `npm run lint`, `python -m ruff check packages/python`
- [ ] `npm run typecheck` (tsc + mypy)
- [ ] `npm run coverage`, `python packages/scripts/coverage_python.py`
- [ ] `npm run bench:check` (hash pins + fixture expectations + matrix consistency)
- [ ] `npm run bench:fp`, `npm run bench:fp:python` (0 FP / 0 FN on the pinned corpus)
- [ ] `python packages/python/bench/parity.py` (22/22 exact confidence parity)
- [ ] `npm run examples`, `npm run examples:python`, `npm run integration`,
      `npm run integration:python`
- [ ] package artifact validation (npm pack + wheel install smoke)
