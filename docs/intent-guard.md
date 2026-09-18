# The intent guard — valid JSON is not intent

A byte-complete tool-call envelope sitting in a reasoning channel is *evidence*, not proof. The model may have been illustrating a format, rehearsing a plan it abandoned, reporting what it would output, or explicitly retracting the call. The intent guard is the layer that decides whether a detected candidate may actually be exposed as executable.

## Three levels, kept separate

| level | question | produced by |
| --- | --- | --- |
| **ground truth** | what is this case, really? | fixture labels (`groundTruth` in `packages/bench/fixtures/`) |
| **detection** | is there evidence of a misplaced call? | `detected` + `confidence` + `category` |
| **recovery** | may it be exposed as executable? | `recovered` + `recoveredCalls` (+ `recoveredResponse`) |

Detection stays permissive: envelope structure decides it, exactly as before. The gate only ever makes *recovery* stricter. In the default mode it does not change `detected`, `pattern`, or `confidence` at all — `toolCalls` keeps every candidate, and `recoveredCalls` is the gated subset that `recoveredResponse` is built from.

## Signals

Every signal below is deterministic and explainable; there is no model in the loop.

| signal | how it is measured | effect |
| --- | --- | --- |
| terminal position (reasoning) | nothing but reasoning tags / whitespace after the last envelope in its reasoning region | corroborates (no veto) |
| reasoning prose after the envelope | ≥ `TRAILING_PROSE_MIN` (80) non-whitespace chars after the envelope, other envelopes' own spans excluded | **blocks** → `tool_rehearsal` |
| hard negation / illustration cues | within ±240 chars of the envelope, envelope body excluded — "do not execute", "illustrative only", "hypothetical", "the model would output", "for reference", … | **blocks** → `quoted_tool_call` |
| retraction cues | after the envelope — "actually, no", "never mind", "scratch that", … | **blocks** → `tool_rehearsal` |
| quotation context | envelope raw span wrapped in quotation marks, or inside a fenced code block whose opener/framing reads as reported output ("outputs:", "would be", "sample output", …) | **blocks** → `quoted_tool_call` |
| schema violation | `schemaValid: "no"` against supplied `toolSchemas` | **blocks** |
| unknown tool name | `nameKnown: "no"` with supplied schemas | **blocks** (partial schema lists: see `intentGate: "off"`) |
| agent state | caller passes `expectToolCall: false` | **blocks** |
| side-effect policy | call name listed in `sideEffectingTools` | **blocks** unless `recoverSideEffecting: true` |
| planning language | "I could", "I might", "for example", "should I", … near the envelope | warning in `block`, **blocks** in `strict` |
| truncation | `finish_reason: "length"` | warning in `block`, **blocks** in `strict` |

**Design rule: language cues may only *suppress* recovery — never justify it.** Position, termination behavior, and schema validity carry the weight; a model that merely *says* it will call something gains nothing from the wording. Envelope spans are masked out before cue scanning, so cue words inside argument values never veto a call. A **bare** fenced block is never a veto by itself — models legitimately draft calls in fences; only a fence whose framing reads as reported output blocks.

Pattern B (content-channel) trailing text is deliberately **not** treated as a rehearsal signal — trailing text *is* Pattern B's signature ([pi #952](https://github.com/earendil-works/pi/issues/952)). The block list for content-channel envelopes is the language/quotation/schema evidence only.

## Gate modes

| mode | behavior |
| --- | --- |
| `block` **(default)** | withhold recovery on the hard evidence above; soft cues warn |
| `strict` | additionally require positive corroboration: every reasoning envelope must be terminal, no planning cues, `finish_reason` must be `stop` |
| `off` | pre-gate (0.2.x) behavior — structure alone decides recovery. The escape hatch for partial schema lists, and for callers who deliberately want mid-thought recoveries. |

Mode `off` still reports `category` (detection-layer information), but performs no gating.

## Options

| TypeScript | Python (`check_and_rescue(..., **opts)`) | default | meaning |
| --- | --- | --- | --- |
| `intentGate: 'block' \| 'strict' \| 'off'` | `intent_gate` | `'block'` | gate strictness |
| `expectToolCall?: boolean` | `expect_tool_call` | unknown | agent state; `false` blocks recovery |
| `sideEffectingTools?: string[]` | `side_effecting_tools` | none | names that must stay detection-only |
| `recoverSideEffecting?: boolean` | `recover_side_effecting` | `false` | opt back in for listed names |

Result additions: `category` (`'swallowed_tool_call' | 'tool_rehearsal' | 'quoted_tool_call' | null`), `intent` (the evidence behind the decision — `boundary`, `trailingProseChars`, `cues`, `quotedContext`, `expectToolCall`, `blocked[]`), and `recoveredCalls` (the gate-passing subset).

## Per-envelope semantics and mixed sets

Each candidate is evaluated individually: a response with one rehearsed mid-thought envelope and one terminal genuine call (`adv-mixed-genuine-rehearsed`) recovers exactly the terminal call, keeps both in `toolCalls`, and names the dropped one in `warnings[]`. Recovery is not all-or-nothing per response; it is all-or-nothing only for envelopes that fail the *same* hard gate.

## Categories

| category | meaning |
| --- | --- |
| `swallowed_tool_call` | structurally complete candidate with no veto evidence — the default |
| `tool_rehearsal` | mid-thought draft and/or retracted after being written |
| `quoted_tool_call` | quoted, reported, or explicitly negated |

## What this does not promise

- **Cue lists are non-exhaustive.** A paraphrase outside the lists falls back to position and termination evidence — which is exactly why those signals, not language, carry the classification.
- **Content-channel narration without cues** (Pattern B shape, no retraction/negation language, no planning cue) can still be recovered in `block` mode. Use `strict`, `sideEffectingTools`, or a human review step for high-stakes deployments.
- **A genuine call followed by substantial reasoning prose in the reasoning channel is withheld by default.** Real swallows end with the envelope, so this recall trade favours safety; `intentGate: 'off'` restores it.
- **The gate is not an authorization layer.** Recovered calls are data — dispatch them through the same validation and authorization path as any other tool call. The proxy heals responses; it does not bypass your dispatcher.
