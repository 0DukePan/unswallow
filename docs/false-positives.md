# False-positive methodology

A wrong recovery is worse than the silent failure it replaces. This document states exactly what counts as a false positive, how the guards earn their keep, and how the methodology is verified.

## Three levels, kept strictly separate

| level | question | artifacts |
| --- | --- | --- |
| **ground truth** | what is this case, really? | `groundTruth.classification` + `groundTruth.recoverable` in every fixture |
| **detection** | is there evidence of a misplaced call? | `detected` + `confidence` + `category` |
| **recovery** | may it be exposed as executable? | `recovered` + `recoveredCalls` (+ `recoveredResponse`) |

Mixing the three makes benchmark numbers unreadable, so the metrics below name them explicitly:

- **False negative** — a genuine swallow (`classification: swallowed_tool_call`) that is not detected.
- **Detection false positive** — a non-executable case flagged as a tool-call *candidate* (pattern A/B). Annoying, low-stakes on its own; quoted/rehearsal candidates legitimately land here because the structure really is there. Pattern C field-leak detections are a separate detection class and are not counted.
- **Unsafe recovery** — a non-executable case actually *recovered*. This is the dangerous failure mode, reported and gated separately — never averaged into a single false-positive number.

`confidence` is a detector output, not part of a fixture's ground truth; it is evaluated through the metrics, not asserted in labels.

## What counts as a recovery

unswallow "recovers" a structurally valid envelope **and** passes the intent gate. Structure alone requires:

1. `tool_calls` is empty (or absent) — an already-parsed call is left untouched.
2. A structurally complete tool-call envelope exists in a reasoning channel (Pattern A), in `content` with trailing text (Pattern B), or as a balanced JSON object with `name` + `arguments`.
3. The envelope shape validates: `function.name` is a non-empty string, `function.arguments` is an object (or a JSON string that parses to an object), and the whole raw envelope is within size limits.

The intent gate then withholds recovery on deterministic evidence against execution — negation/quotation language, retraction, mid-reasoning drafts, schema violations, unknown tool names, `expectToolCall: false`, side-effect policy — and in `strict` mode additionally requires positive corroboration. Full signal list: [intent-guard.md](intent-guard.md).

## The guard fixtures

At least one pinned fixture per way the guard can fire, plus the adversarial corpus meant to break it:

### Structural guards (`fp-guard-*`) — detection must stay silent

| fixture | shape | ground truth |
| --- | --- | --- |
| `fp-guard-discussion-only` | marker-free prose narrating a call | `tool_discussion` |
| `fp-guard-partial-json` | `name` without `arguments` | `malformed_envelope` |
| `fp-guard-json-array-args` | `arguments` is an array | `malformed_envelope` |
| `fp-guard-json-string-args` | `arguments` is an unparseable string | `malformed_envelope` |
| `fp-guard-multiple-partial` | several partial envelopes | `malformed_envelope` |
| `fp-guard-user-content-mention` | user text merely mentions `<tool_call>` | `tool_discussion` |
| `fp-guard-xml-empty-name` | XML envelope with an empty name | `malformed_envelope` |

### Adversarial corpus (`adv-*`) — detection may surface candidates, recovery must be right

| fixture | shape | ground truth | expected |
| --- | --- | --- | --- |
| `adv-quoted-complete-negated` | complete envelope + "Do not execute this" | `quoted_tool_call` | detected, **not recovered** |
| `adv-quoted-report-context` | "the model would output: …" fenced block | `quoted_tool_call` | detected, **not recovered** |
| `adv-rehearsal-mid-reasoning` | envelope mid-thought, planning prose after | `tool_rehearsal` | detected, **not recovered** |
| `adv-retraction-after-call` | envelope + "Actually, no — scratch that" | `tool_rehearsal` | detected, **not recovered** |
| `adv-narration-content` | Pattern B envelope + retraction in content | `tool_rehearsal` | detected, **not recovered** |
| `adv-mixed-genuine-rehearsed` | rehearsed draft + terminal genuine call | `tool_rehearsal` (recoverable) | recovered **subset only** (1 of 2) |
| `adv-malformed-args-vs-schema` | valid shape, wrong-typed arguments | `malformed_envelope` | detected, **not recovered** |
| `adv-unknown-tool-name-vs-schema` | name absent from declared tools | `malformed_envelope` | detected, **not recovered** |
| `adv-multiple-json-objects` | several non-envelope JSON objects | `unrelated_json` | nothing detected |
| `adv-discussion-incomplete` | "I would use search with…" | `tool_discussion` | nothing detected |
| `adv-context-loss` | empty channels, no envelope anywhere | `context_loss` | nothing detected |

All fixtures are hash-pinned against `fixtures.sha256` and run read-only in CI (`npm run bench:check`), which also lints ground-truth coherence and checks that recovered calls deep-equal the fixture's `expectedCalls`.

## Metrics

`npm run bench:fp` / `npm run bench:fp:python` write `packages/bench/results/fp-results.*` and `packages/python/bench/results_python_fp.*`:

| metric | definition |
| --- | --- |
| detection recall | genuine swallows detected ÷ genuine fixtures |
| **unsafe recovery rate** | non-executable recovered ÷ non-executable fixtures — **the gate: any nonzero value fails CI** |
| recovery precision | recovered calls on intended fixtures ÷ all recovered calls |
| detection false-positive rate | non-executable flagged as candidates ÷ non-executable fixtures (informational) |
| reconstruction correctness | recovered calls deep-equal `expectedCalls` where declared |
| synthetic false positives | 200 seeded discussion-only negatives that must stay silent |

`--check` fails on any unsafe recovery, any false negative, or any synthetic false positive. Per-fixture expectations (`expect.*`, including `category`) are enforced by the correctness runner (`npm run bench:check`).

## The naive-baseline comparison

`packages/bench/perf.mjs` measures a naive implementation — one marker regex plus a single `JSON.parse`, no envelope validation, no intent gate. It fires on most of the structural guard fixtures. That gap is the price of the guard, and the guard fixtures exist to make sure nobody "optimizes" the naive path back in.

## What the guard does not promise

- **Cue lists are non-exhaustive.** A paraphrase outside the language lists falls back to position/termination evidence; a content-channel narration with no cues at all can still be recovered in `block` mode (see [intent-guard.md](intent-guard.md) for `strict` and `sideEffectingTools`).
- **A genuine call followed by substantial reasoning prose in the reasoning channel is withheld by default.** Real swallows end with the envelope; `intentGate: 'off'` restores the permissive behaviour.
- **Pattern C (reasoning-tag leak) is detection-only, never recovered, by design.**
- **Confidence is a tiered heuristic** (see README §Confidence), not a calibrated probability.
- **The corpus is adversarial and small.** Metrics are regression counts over documented examples, never population estimates, and are not a claim about your traffic.
