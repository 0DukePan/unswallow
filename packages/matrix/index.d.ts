export type EngineId = 'vllm' | 'sglang' | 'llama.cpp';

export type ToolPattern = 'A' | 'B' | 'C' | 'D';

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

export declare const matrixPath: string;
export declare const upstreamStatusPath: string;
export declare const entries: SwallowMatrixEntry[];
export declare const matrixVersion: string;
export declare const updated: string;