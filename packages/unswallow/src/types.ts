export type EngineId = 'vllm' | 'sglang' | 'llama.cpp';

export type ToolPattern = 'A' | 'B' | 'C' | 'D';

export type ChannelSource =
  | 'reasoning'
  | 'reasoning_content'
  | 'thinking'
  | 'thought'
  | 'content';

export interface ToolCallEntry {
  id?: string;
  type?: string;
  function: { name: string; arguments: string };
}

export interface RawMessage {
  role?: string;
  content?: string | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
  thinking?: string | null;
  thought?: string | null;
  tool_calls?: ToolCallEntry[];
  [key: string]: unknown;
}

export interface RawProviderResponse {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices: Array<{
    index?: number;
    finish_reason?: string | null;
    message: RawMessage;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export interface ToolSchema {
  type?: string;
  function?: {
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
  name?: string;
  parameters?: Record<string, unknown>;
}

export interface SwallowMatrixEntry {
  engine?: EngineId;
  harness?: string;
  versionRange: string;
  pattern: ToolPattern;
  modelFamilies?: string[];
  behavior: 'swallow' | 'partial' | 'resolved';
  verified?: boolean;
  knownBehavior: string;
  source: string;
  fixHint?: string;
}

export interface ToolEnvelope {
  name: string;
  arguments: Record<string, unknown>;
  raw: string;
  format: 'qwen-xml' | 'function-xml' | 'deepseek' | 'json';
  argumentsFromString?: boolean;
}

export interface ToolValidationResult {
  structurallyValid: boolean;
  nameKnown: 'yes' | 'no' | 'unknown';
  schemaValid: 'yes' | 'no' | 'unknown';
  errors: string[];
}

export type ToolIntentCategory =
  | 'swallowed_tool_call'
  | 'tool_rehearsal'
  | 'quoted_tool_call';

export interface ToolIntentEvidence {
  /** Envelope position relative to its reasoning-channel boundary. */
  boundary: 'terminal' | 'mid' | 'unknown';
  /** Non-whitespace reasoning text (tags excluded) after the furthest envelope. */
  trailingProseChars: number;
  /** Matched discussion/negation cues near an envelope. */
  cues: string[];
  /** Whether an envelope sat inside quotation marks or reported text. */
  quotedContext: boolean;
  /** Caller-declared agent state: was a tool call expected this turn? */
  expectToolCall: 'yes' | 'no' | 'unknown';
  /** Reasons recovery was withheld for at least one envelope. */
  blocked: string[];
}

export interface SwallowCheckResult {
  detected: boolean;
  pattern: 'A' | 'B' | 'C' | null;
  toolCall: { name: string; arguments: Record<string, unknown> } | null;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> | null;
  recovered: boolean;
  source: ChannelSource;
  engineHint: EngineId | 'unknown';
  matrixMatch: SwallowMatrixEntry | null;
  confidence: number;
  warnings: string[];
  validation: ToolValidationResult | null;
  recoveredResponse: RawProviderResponse | null;
  /** Detection-layer classification; null when nothing was detected. */
  category: ToolIntentCategory | null;
  /** Deterministic intent evidence behind the classification and recovery gate. */
  intent: ToolIntentEvidence;
  /** The gate-passing subset of toolCalls that was actually recovered. */
  recoveredCalls: Array<{ name: string; arguments: Record<string, unknown> }> | null;
}

export interface CheckOptions {
  engineHint?: string;
  engineVersion?: string;
  toolSchemas?: ToolSchema[];
  matrix?: SwallowMatrixEntry[];
  additionalFields?: string[];
  /** Require at least this confidence before recovering a structurally valid call. */
  minConfidence?: number;
  /** Recover only when supplied tool schemas validate the recovered arguments. */
  strictSchema?: boolean;
  /**
   * Recovery gate strictness. `block` (default) withholds recovery when there is
   * deterministic evidence against execution; `strict` additionally requires
   * positive corroboration; `off` restores the pre-intent-gate behavior.
   */
  intentGate?: 'block' | 'strict' | 'off';
  /** Agent state: `false` withholds recovery when no call was expected this turn. */
  expectToolCall?: boolean;
  /** Tool names treated as side-effecting: detected but not recovered by default. */
  sideEffectingTools?: string[];
  /** Opt back in to recovering calls whose names are listed in sideEffectingTools. */
  recoverSideEffecting?: boolean;
}