import { applyRecoveryMany } from './recover';
import { checkMessage } from './pipeline';
import { normalizeEngine } from './matrix';
import type {
  CheckOptions,
  RawProviderResponse,
  SwallowCheckResult,
} from './types';

export {
  loadMatrix,
  getMatrixFile,
  matchMatrixEntry,
  normalizeEngine,
} from './matrix';
export { matchesRange, parseVersion, parseRange } from './semver';
export {
  extractEnvelope,
  extractAllEnvelopes,
  validateEnvelopeShape,
  buildToolCallsEntry,
  applyRecoveryToResponse,
  applyRecoveryMany,
  MAX_ENVELOPES,
} from './recover';
export type { LocatedEnvelope, ExtractionResult } from './recover';
export { extractRegions, splitThinkBlocks, REASONING_FIELDS } from './scan';
export { checkMessage, NOT_DETECTED } from './pipeline';
export {
  evaluateIntent,
  NEGATION_CUES,
  RETRACTION_CUES,
  PLANNING_CUES,
  REPORT_CUES,
  CUE_WINDOW,
  TRAILING_PROSE_MIN,
} from './intent';
export type { EnvelopeIntent, IntentEvaluation } from './intent';
export { validateEnvelope } from './validate';
export { createStreamAccumulator, checkAndRescueStream } from './stream';
export { observeCheckResult } from './integrations/otel';
export type { StreamChunk, StreamDelta, StreamAccumulatorOptions } from './stream';
export { ensureReasoningEcho, sanitizeHistory, stripReasoningTags } from './history';
export type { HistoryMessage, EnsureReasoningEchoOptions, SanitizeHistoryOptions } from './history';
export { createProxyServer, startProxy } from './proxy';
export type { ProxyOptions, ProxyServer } from './proxy';
export type {
  EngineId,
  ToolPattern,
  ChannelSource,
  ToolCallEntry,
  RawMessage,
  RawProviderResponse,
  ToolSchema,
  ToolValidationResult,
  SwallowMatrixEntry,
  ToolEnvelope,
  SwallowCheckResult,
  CheckOptions,
  ToolIntentCategory,
  ToolIntentEvidence,
} from './types';

export function checkAndRescue(
  response: RawProviderResponse,
  opts: CheckOptions = {}
): SwallowCheckResult {
  if (
    !response ||
    !Array.isArray(response.choices) ||
    response.choices.length === 0 ||
    !response.choices[0].message
  ) {
    return {
      detected: false,
      pattern: null,
      toolCall: null,
      toolCalls: null,
      recovered: false,
      source: 'content',
      engineHint: normalizeEngine(opts.engineHint),
      matrixMatch: null,
      confidence: 0,
      warnings: ['response has no choices[0].message'],
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
    };
  }

  const result = checkMessage(response.choices[0].message, opts, response.choices[0].finish_reason ?? null);
  if (result.recovered && result.recoveredCalls && result.recoveredCalls.length > 0) {
    result.recoveredResponse = applyRecoveryMany(
      response,
      result.recoveredCalls
    );
  }
  return result;
}