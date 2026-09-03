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
  recoveredResponse: RawProviderResponse | null;
}

export interface CheckOptions {
  engineHint?: string;
  engineVersion?: string;
  toolSchemas?: ToolSchema[];
  matrix?: SwallowMatrixEntry[];
  additionalFields?: string[];
}