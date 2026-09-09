import type { SwallowMatrixEntry, ToolPattern, ToolValidationResult } from './types';

export interface ConfidenceInput {
  pattern: ToolPattern | null;
  matrixMatch: SwallowMatrixEntry | null;
  engineKnown: boolean;
  versionKnown: boolean;
  detectionOnly: boolean;
  trailingText: boolean;
  argumentsFromString: boolean;
  validation?: ToolValidationResult | null;
}

export interface ConfidenceResult {
  confidence: number;
  warnings: string[];
}

export function scoreConfidence(input: ConfidenceInput): ConfidenceResult {
  if (!input.pattern) {
    return { confidence: 0, warnings: [] };
  }
  const warnings: string[] = [];
  let c: number;
  if (input.matrixMatch) {
    const m = input.matrixMatch;
    c = m.behavior === 'swallow' ? 0.95 : m.behavior === 'partial' ? 0.8 : 0.6;
    if (m.behavior === 'resolved') {
      warnings.push(
        `matrix marks ${m.engine} ${m.versionRange} as resolved; a detection here means the reported engine version is likely wrong`
      );
    }
  } else {
    c = 0.55;
    if (!input.engineKnown) {
      warnings.push('engine unknown; pass engineHint for matrix-aware confidence');
    }
    if (!input.versionKnown) {
      warnings.push('engine version unknown; pass engineVersion for matrix-aware confidence');
    }
    if (input.engineKnown && input.versionKnown) {
      warnings.push(
        'recovered via generic marker scan; engine/version not in the known matrix — verify manually'
      );
    }
  }
  if (input.detectionOnly) {
    c = Math.min(c, 0.5);
    warnings.push('pattern C is detection-only; no recovery performed');
  }
  if (input.trailingText) {
    warnings.push(
      'trailing text after the envelope in content — recovered the JSON envelope; verify the tail is not part of the arguments'
    );
  }
  if (input.argumentsFromString) {
    warnings.push('arguments arrived as a JSON string and were parsed into an object');
  }
  if (input.validation?.nameKnown === 'no') {
    c *= 0.5;
    warnings.push('recovered tool name is not found in provided toolSchemas (confidence ×0.5)');
  }
  if (input.validation?.schemaValid === 'no') {
    c *= 0.5;
    warnings.push('recovered arguments do not satisfy the provided tool schema (confidence ×0.5)');
  }
  if (input.validation && input.validation.errors.length > 0) {
    warnings.push(...input.validation.errors);
  }
  const confidence = Math.max(0, Math.min(1, Math.round(c * 100) / 100));
  return { confidence, warnings };
}