# Limitations & FAQ

The honest edges of unswallow, stated plainly.

## What unswallow does not do

- **It does not fix engines.** It detects and heals the *response*; the server
  that swallowed the call is unchanged. The fix is an engine upgrade (see the
  matrix `fixHint` rows) or a parser change on your serving side.
- **It does not repair arbitrary tool-call breakage.** Wrong dialects, missing
  schema fields, malformed JSON in `content` that is *not* a reasoning-channel
  swallow — out of scope. Scope guard in CONTRIBUTING.md.
- **It does not recover Pattern C.** A reasoning-tag leak (Pattern C) is
  detected and surfaced (`onLeak`, `warnings`), never recovered — there is no
  complete tool call to recover.
- **It does not strip reasoning from live responses.** Recovery keeps the
  reasoning channel intact; it only populates `tool_calls`. History hygiene
  (`sanitizeHistory`) is a separate, opt-in pass for the *next* request.
- **It does not guarantee against quoted-envelope narration.** A model that
  writes a byte-complete, balanced envelope with arguments while *narrating*
  (not invoking) a tool is indistinguishable from a swallow by structure
  alone. Recovery is the deliberate conservative choice. See
  [false-positives.md](false-positives.md).

## Detection limits

- **Envelope caps:** 32 envelopes per response, 20 KB per raw envelope.
  Beyond either, the scan stops with a warning.
- **Channels scanned:** `reasoning`, `reasoning_content`, `thinking`,
  `thought`, `content` (including think-blocks embedded in content), plus any
  fields you name via `additionalFields`. A tool call trapped in some other
  custom field is invisible unless you list it.
- **Pattern D is prevention, not detection.** History drift is handled by
  `sanitizeHistory` before re-sending; unswallow does not detect drift after
  the fact.
- **The matrix is sourced, not laboratory-verified.** Every matrix row links
  its upstream report and states `verified: no` until someone reproduces it
  against the real engine/version. Treat "resolved" rows as "reported fixed",
  and keep the guard enabled.

## Performance envelope

- Checks are linear in payload size. Order of magnitude on a desktop (see
  [benchmarks.md](benchmarks.md) for the honest repro guide): ~0.1 ms for a
  small reasoning payload, ~4 ms for a 1 MB reasoning block (TS; Python is
  faster on large payloads because its deep copy is cheaper).
- Healthy responses (already-parsed `tool_calls`) return before any scanning.
- The false-positive guard costs speed; the naive baseline is 15–75× faster on
  small inputs and fires on 6 of 7 guard fixtures. That trade is deliberate.

## FAQ

**Q: Is a "recovered" call guaranteed to be what the model intended?**
A: The envelope was emitted by the model with a valid `name` + `arguments`
shape; recovery is faithful to that emission. Whether the model *should* have
called the tool is not something a response-level check can know.

**Q: Can this run on my OpenAI-compatible server without code changes?**
A: Yes — `npx unswallow proxy --upstream <base>/v1 ...` is a passthrough that
heals responses in place (non-streaming) or appends a recovery tail
(streaming). It is scoped strictly to this bug class.

**Q: My server is on the matrix as `resolved`. Do I still need this?**
A: If you are on the reported-fixed version range, detection will warn that
the version looks wrong and confidence drops to 0.60 — the guard stays on.
"Resolved" rows are sourced from upstream reports, not verified by the
maintainer; and the matrix is a snapshot, so run `npm run matrix:update` or
check the status page for newer rows.

**Q: Why does confidence say 0.55 instead of 0.95?**
A: 0.95 requires a matrix row matching your engine + version + pattern.
Without a hint, or with an unmatched version, recovery is still performed but
flagged as heuristic. Pass `engineHint`/`engineVersion` (or the proxy flags
`--engine`/`--version`) to get matrix-tier confidence.

**Q: Why is my response's confidence 0 even though I see the call?**
A: Either the envelope is structurally incomplete (see the guard list in
[false-positives.md](false-positives.md)), it is past the caps, or it is in a
channel that was not scanned. `warnings[]` says exactly which.

**Q: Does recovery mutate my response object?**
A: No. Recovery returns a healed deep copy; the original is never touched,
and a clean response passes through untouched (no copy is made at all).

**Q: Which Python versions are supported?**
A: `requires-python = ">=3.9"`; CI tests 3.9, 3.11, 3.13.

**Q: What is the license?**
A: MIT — see [LICENSE](../LICENSE).
