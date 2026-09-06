# False-positive methodology

A wrong recovery is worse than the silent failure it replaces. The false-positive guard is the most-tested behavior in the corpus — and this document states exactly what counts as a false positive, how the guard earns its keep, and how the methodology is verified.

## What counts as a false positive

unswallow "recovers" only when a response meets **all** of these:

1. `tool_calls` is empty (or absent) — an already-parsed call is left untouched.
2. A **structurally complete** tool-call envelope exists somewhere in a reasoning channel (Pattern A), in `content` with trailing text (Pattern B), or as a balanced JSON object with `name` + `arguments`.
3. The envelope shape validates: `function.name` is a non-empty string, `function.arguments` is an object (or a JSON string that parses to an object), and the whole raw envelope is within size limits.

Anything else is not recovered. In particular, these are **not** recoveries:

- A model *discussing* a call: `"I could call get_weather for Tokyo, but I don't need it"`.
- A partial envelope: `{"name": "get_weather"}` without `arguments`.
- An unbalanced envelope: `{"name": "get_weather", "arguments": {"city": "Tokyo"}`.
- `arguments` as a JSON array or scalar.
- Tag-like text inside a JSON string value.
- Envelopes past the 32-per-response cap or the 20 KB length cap.
- Envelopes found in `content` with **no** trailing text (Pattern B requires the strict-parser failure mode).

A false positive is therefore: **a recovery that fires when no real tool call was intended** — most plausibly when a model narrates or quotes a call in its reasoning. The structural requirement is what excludes narration: narration rarely produces a byte-balanced, schema-valid envelope with arguments.

## The guard fixtures

Seven pinned fixtures in `packages/bench/fixtures/` exist to make the guard regress *loudly* (`fp-guard-*`):

| fixture | shape | why it must stay silent |
| --- | --- | --- |
| `fp-guard-discussion-only` | marker-free prose | the classic narration case |
| `fp-guard-partial-json` | `name` without `arguments` | structurally incomplete |
| `fp-guard-json-array-args` | `arguments` is an array | wrong shape |
| `fp-guard-json-string-args` | `arguments` is an unparseable string | wrong shape |
| `fp-guard-multiple-partial` | several partial envelopes | each one individually invalid |
| `fp-guard-user-content-mention` | user message merely quotes a call | guard must scope to assistant reasoning |
| `fp-guard-xml-empty-name` | XML envelope with an empty name | invalid target |

All seven expect `detected: false, confidence: 0` in both languages, are hash-pinned against `fixtures.sha256`, and run in CI read-only (`npm run bench:check`) plus in the 200-synthetic-negative FP evaluator (`npm run bench:fp`, `npm run bench:fp:python`) which asserts **zero** false recoveries on 200 word-salad reasoning samples.

## The naive-baseline comparison

`packages/bench/perf.mjs` also measures a naive implementation — one marker regex plus a single `JSON.parse`, no envelope validation. On small inputs it is 15–75× faster. It fires on **6 of the 7** guard fixtures. That gap is the price of the guard, and the guard fixtures exist to make sure nobody "optimizes" the naive path back in.

## What the guard does not promise

- It cannot distinguish "model quoted a hypothetical complete call in narration" from a real call if the narration is byte-identical to a valid envelope. The conservative choice (recover) is deliberate: a server-side swallow is the common, high-cost failure; a quoted complete call in reasoning is rare and low-cost.
- Pattern C (reasoning-tag leak) is detection-only, never recovered, by design.
- Confidence is a tiered heuristic (see README §Confidence), not a calibrated probability.
