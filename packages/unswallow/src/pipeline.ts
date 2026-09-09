import { classify } from './classify';
import { scoreConfidence } from './confidence';
import { validateEnvelope } from './validate';
import { loadMatrix, matchMatrixEntry, normalizeEngine } from './matrix';
import type {
  CheckOptions,
  RawMessage,
  SwallowCheckResult,
} from './types';

export const NOT_DETECTED = (engine: SwallowCheckResult['engineHint']): SwallowCheckResult => ({
  detected: false,
  pattern: null,
  toolCall: null,
  toolCalls: null,
  recovered: false,
  source: 'content',
  engineHint: engine,
  matrixMatch: null,
  confidence: 0,
  warnings: [],
  validation: null,
  recoveredResponse: null,
});

export function checkMessage(
  message: RawMessage,
  opts: CheckOptions = {}
): SwallowCheckResult {
  const matrix = loadMatrix(opts.matrix);
  const engine = normalizeEngine(opts.engineHint);
  const version =
    typeof opts.engineVersion === 'string' && opts.engineVersion.trim()
      ? opts.engineVersion.trim()
      : null;

  const cls = classify(message, opts.additionalFields);

  if (cls.pattern === null) {
    return NOT_DETECTED(engine);
  }

  const matrixMatch =
    engine !== 'unknown' && version !== null
      ? matchMatrixEntry(matrix, engine, version, cls.pattern)
      : null;

  const toolCall = cls.envelope
    ? { name: cls.envelope.name, arguments: cls.envelope.arguments }
    : null;
  const toolCalls = cls.envelopes.map((e) => ({ name: e.name, arguments: e.arguments }));
  const validation = validateEnvelope(cls.envelope, opts.toolSchemas);
  const allValidations = cls.envelopes.map((envelope) => validateEnvelope(envelope, opts.toolSchemas));
  const allStructurallyValid = allValidations.every((result) => result.structurallyValid);
  const allSchemasValid = allValidations.every((result) => result.schemaValid === 'yes');

  const conf = scoreConfidence({
    pattern: cls.pattern,
    matrixMatch,
    engineKnown: engine !== 'unknown',
    versionKnown: version !== null,
    detectionOnly: cls.pattern === 'C',
    trailingText: cls.reasons.some((r) => r.startsWith('trailing text')),
    argumentsFromString: cls.envelope?.argumentsFromString ?? false,
    validation,
  });
  const minConfidence = typeof opts.minConfidence === 'number'
    ? Math.max(0, Math.min(1, opts.minConfidence))
    : 0;
  const recovered =
    cls.pattern !== 'C' &&
    toolCalls.length > 0 &&
    allStructurallyValid &&
    conf.confidence >= minConfidence &&
    (!opts.strictSchema || allSchemasValid);

  const pattern: 'A' | 'B' | 'C' | null =
    cls.pattern === 'A' || cls.pattern === 'B' || cls.pattern === 'C' ? cls.pattern : null;

  return {
    detected: true,
    pattern,
    toolCall,
    toolCalls,
    recovered,
    source: cls.source,
    engineHint: engine,
    matrixMatch,
    confidence: conf.confidence,
    warnings: [
      ...cls.reasons,
      ...conf.warnings,
      ...(allStructurallyValid ? [] : ['recovery blocked: recovered envelope is not structurally valid']),
      ...(conf.confidence < minConfidence ? [`recovery blocked: confidence ${conf.confidence.toFixed(2)} is below minConfidence ${minConfidence.toFixed(2)}`] : []),
      ...(opts.strictSchema && !allSchemasValid ? ['recovery blocked: strictSchema requires valid supplied tool schema for every recovered call'] : []),
    ],
    validation,
    recoveredResponse: null,
  };
}