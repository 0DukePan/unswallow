# CLI JSON contract

`unswallow inspect --json` and `unswallow doctor --json` are stable,
machine-readable interfaces for CI and incident tooling. Their top-level
`schemaVersion` is currently the string `"1"`.

## Compatibility policy

- Additive fields may be added within schema version `1`.
- Existing fields keep their documented meaning and JSON type for the life of
  schema version `1`.
- Removing or renaming a field, or changing its type or meaning, requires a
  new `schemaVersion` and a changelog migration note.
- Consumers must ignore fields they do not recognize and must branch on
  `schemaVersion` before depending on fields introduced by later versions.

## `inspect --json`

Exit status is `0` when no swallow is detected, `1` when one is detected, and
`2` for invalid input or processing failure.

The report contains:

| field | meaning |
| --- | --- |
| `schemaVersion` | CLI-report schema version |
| `detected`, `pattern`, `recovered` | detection and recovery outcome |
| `source` | response field where the envelope was found |
| `toolCall`, `toolCalls` | extracted call(s), if any |
| `validation` | structural, name, and schema validation outcome |
| `confidence`, `warnings` | confidence and explanatory diagnostics |
| `matrixMatch` | matching compatibility row, including source and fix hint |
| `recoveredResponse` | healed response only when recovery was allowed |

`validation.schemaValid` is `"unknown"` if a supplied schema is malformed or
cannot safely be evaluated. It is never reported as `"yes"` in that case.

## `doctor --json`

Exit status is `0` for a healthy probe, `1` for an affected or
recovery-supported probe, and `2` for network, provider, output-file, or
processing failures.

The report contains:

| field | meaning |
| --- | --- |
| `schemaVersion` | CLI-report schema version |
| `status` | `healthy`, `affected`, or `recovery-supported` |
| `probeStatus` | upstream HTTP status |
| `rawResponseFile` | `--out` file path, or `null` |
| `result` | the complete check result described above |
| `compatibility` | matching matrix row, if one exists |
| `recommendation` | matrix fix hint, if one exists |

`doctor --out <file>` writes the raw, pre-recovery provider response in the
fixture-wrapper shape accepted by `unswallow inspect`. It must not be mistaken
for a verified reproduction: the capture still needs its engine/model/version
metadata, review, and hash pin before a matrix row can be marked verified.
