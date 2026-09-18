import { classify } from './classify';
import { scoreConfidence } from './confidence';
import { evaluateIntent } from './intent';
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
  category: null,
  intent: {
    boundary: 'unknown',
    trailingProseChars: 0,
    cues: [],
    quotedContext: false,
    expectToolCall: 'unknown',
    blocked: [],
  },
  recoveredCalls: null,
});

export function checkMessage(
  message: RawMessage,
  opts: CheckOptions = {},
  finishReason?: string | null
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
  const validations = cls.envelopes.map((envelope) => validateEnvelope(envelope, opts.toolSchemas));
  const validation = validations[0] ?? validateEnvelope(cls.envelope, opts.toolSchemas);
  const allStructurallyValid = validations.every((result) => result.structurallyValid);
  const allSchemasValid = validations.every((result) => result.schemaValid === 'yes');

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

  const intent = evaluateIntent(cls.hits, cls.allHits, validations, opts, finishReason ?? null, cls.capped);
  const gateMode =
    opts.intentGate === 'strict' || opts.intentGate === 'off' ? opts.intentGate : 'block';

  const minConfidence = typeof opts.minConfidence === 'number'
    ? Math.max(0, Math.min(1, opts.minConfidence))
    : 0;
  const recoveryEnvelopes = cls.envelopes.filter(
    (_, i) => validations[i].structurallyValid && intent.perEnvelope[i].blocked.length === 0
  );
  const recoveredCalls = recoveryEnvelopes.map((envelope) => ({
    name: envelope.name,
    arguments: envelope.arguments,
  }));
  const recovered =
    cls.pattern !== 'C' &&
    recoveredCalls.length > 0 &&
    conf.confidence >= minConfidence &&
    (!opts.strictSchema || allSchemasValid);

  const pattern: 'A' | 'B' | 'C' | null =
    cls.pattern === 'A' || cls.pattern === 'B' || cls.pattern === 'C' ? cls.pattern : null;

  const partialRecovery =
    recovered && recoveredCalls.length > 0 && recoveredCalls.length < cls.envelopes.length
      ? [`recovered ${recoveredCalls.length} of ${cls.envelopes.length} candidate envelopes (blocked ones are listed above)`]
      : [];
  const planningWarning =
    gateMode === 'block' && intent.planningCues.length > 0
      ? [
          `planning language detected near the envelope ("${intent.planningCues[0]}") — not blocking in the default gate; see docs/intent-guard.md`,
        ]
      : [];
  const finishWarning =
    gateMode !== 'off' && finishReason === 'length'
      ? ['finish_reason "length": the response may have been truncated — verify the recovered envelope is complete']
      : [];

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
      ...intent.evidence.blocked,
      ...partialRecovery,
      ...planningWarning,
      ...finishWarning,
    ],
    validation,
    recoveredResponse: null,
    category: intent.category,
    intent: intent.evidence,
    recoveredCalls: recovered ? recoveredCalls : null,
  };
}
