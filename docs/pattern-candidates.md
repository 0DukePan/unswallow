# Pattern candidates

This page records sourced failure modes that are deliberately outside
unswallow's recovery scope. It is documentation only and is not consumed by
the compatibility matrix or detection pipeline.

## Pattern E — budget-interruption corruption

- **Status:** detection-only / needs reproduction
- **Source:** [vLLM #44676](https://github.com/vllm-project/vllm/issues/44676)
- **Failure class:** a provider-specific `reasoning_end_str` is force-injected
  in the middle of a tool argument string when a reasoning budget interrupts
  generation.

This is not an extractable, structurally complete envelope. Recovery would
require guessing which argument bytes belong to the model versus the injected
marker, violating unswallow's false-positive guard. Accordingly, Pattern E is
not a `ToolPattern`, has no matrix row, and has no recovery implementation.

If investigated after a real reproduction, any future API may accept a
caller-supplied `reasoningEndMarkers` list and return a warning only. It must
never merge fragments or reconstruct a tool-call envelope.
