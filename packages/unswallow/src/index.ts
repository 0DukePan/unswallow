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
export { checkMessage } from './pipeline';
export { createStreamAccumulator, checkAndRescueStream } from './stream';
export type { StreamChunk, StreamDelta, StreamAccumulatorOptions } from './stream';
export { sanitizeHistory, stripReasoningTags } from './history';
export type { HistoryMessage, SanitizeHistoryOptions } from './history';
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
  SwallowMatrixEntry,
  ToolEnvelope,
  SwallowCheckResult,
  CheckOptions,
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
      recoveredResponse: null,
    };
  }

  const result = checkMessage(response.choices[0].message, opts);
  if (result.recovered && result.toolCalls && result.toolCalls.length > 0) {
    result.recoveredResponse = applyRecoveryMany(
      response,
      result.toolCalls
    );
  }
  return result;
}