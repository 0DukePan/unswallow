import type { ClassifiedHit } from './classify';
import type {
  CheckOptions,
  ToolIntentCategory,
  ToolIntentEvidence,
  ToolValidationResult,
} from './types';

/** How far around an envelope cue language is scanned. */
export const CUE_WINDOW = 240;
/** Reasoning-channel prose longer than this after an envelope reads as a rehearsal. */
export const TRAILING_PROSE_MIN = 80;

const REASONING_TAG = /<\s*\/?\s*[a-zA-Z0-9_.:-]*\s*(?:think|response)[^>]*>/gi;
const QUOTE_CHARS = new Set(['"', "'", '`', '\u201c', '\u201d', '\u2018', '\u2019']);

/**
 * Hard negation / illustration cues: their presence near an envelope withholds
 * recovery (it is treated as quoted_tool_call material). Language cues may
 * only ever *suppress* recovery — they never justify it.
 */
export const NEGATION_CUES: readonly string[] = [
  'do not execute',
  "don't execute",
  'not execute',
  'do not run',
  "don't run",
  'will not call',
  "won't call",
  'do not call',
  "don't call",
  'without calling',
  'illustrative only',
  'for illustration',
  'hypothetical',
  'if i were to call',
  'example only',
  'not a real call',
  'sample output',
  'example output',
  'the model would output',
  'would output',
  'for reference',
];

/** Retraction cues: only meaningful after the envelope (draft then retract). */
export const RETRACTION_CUES: readonly string[] = [
  'actually, no',
  'actually no',
  'never mind',
  'nevermind',
  'scratch that',
  'on second thought',
  'disregard that',
];

/** Soft planning cues: warning in `block` mode, blocking in `strict` mode. */
export const PLANNING_CUES: readonly string[] = [
  'i could',
  'i might',
  'maybe i',
  'perhaps i',
  'for example',
  'should i',
  'let me think',
];

/**
 * Report framing that turns a *fenced* envelope into quoted material.
 * Consulted only while the envelope sits inside a fenced code block — a bare
 * fence (models legitimately draft calls in fences) is never a veto by itself.
 */
export const REPORT_CUES: readonly string[] = [
  'outputs:',
  'output:',
  'would output',
  'would be',
  'example output',
  'sample output',
  'for reference',
];

/** Whether `index` sits inside a fenced code block, and whether its framing reads as reported output. */
function fenceContext(text: string, index: number): { inside: boolean; annotated: boolean } {
  if (!text.includes('```') && !text.includes('~~~')) {
    return { inside: false, annotated: false };
  }
  let count = 0;
  let lastStart = -1;
  let lineStart = 0;
  while (lineStart < index) {
    let j = lineStart;
    while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
    if (
      (text.startsWith('```', j) || text.startsWith('~~~', j))
    ) {
      count++;
      lastStart = lineStart;
    }
    const next = text.indexOf('\n', lineStart);
    if (next === -1 || next + 1 >= index) break;
    lineStart = next + 1;
  }
  if (count % 2 === 0) return { inside: false, annotated: false };
  const annotation = text.slice(Math.max(0, lastStart - 80), index);
  return { inside: true, annotated: matchCues(annotation, REPORT_CUES).length > 0 };
}

export interface EnvelopeIntent {
  name: string;
  reasoning: boolean;
  terminal: boolean;
  trailingProseChars: number;
  negationCues: string[];
  retractionCues: string[];
  planningCues: string[];
  quotedContext: boolean;
  blocked: string[];
}

export interface IntentEvaluation {
  category: ToolIntentCategory | null;
  evidence: ToolIntentEvidence;
  perEnvelope: EnvelopeIntent[];
  planningCues: string[];
}

interface Span {
  start: number;
  end: number;
}

function maskSpans(text: string, spans: Span[]): string {
  let out = '';
  let cursor = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    if (span.start >= span.end) continue;
    if (span.start > cursor) out += text.slice(cursor, span.start);
    out += ' '.repeat(span.end - span.start);
    cursor = Math.max(cursor, span.end);
  }
  return out + text.slice(cursor);
}

function stripToProse(text: string): string {
  return text.replace(REASONING_TAG, '').replace(/\s+/g, '');
}

function matchCues(text: string, cues: readonly string[]): string[] {
  const lower = text.toLowerCase();
  return cues.filter((cue) => lower.includes(cue));
}

function nonWhitespaceBefore(text: string, index: number): string | null {
  for (let i = index - 1; i >= 0; i--) {
    if (!/\s/.test(text[i])) return text[i];
  }
  return null;
}

function nonWhitespaceAfter(text: string, index: number): string | null {
  for (let i = index; i < text.length; i++) {
    if (!/\s/.test(text[i])) return text[i];
  }
  return null;
}

/**
 * Evaluate deterministic intent evidence for located envelopes and decide which
 * of them may be recovered. Detection is unaffected; this only gates recovery.
 */
export function evaluateIntent(
  hits: ClassifiedHit[],
  allHits: ClassifiedHit[],
  validations: ToolValidationResult[],
  opts: CheckOptions = {},
  finishReason?: string | null,
  capped = false
): IntentEvaluation {
  const mode: 'block' | 'strict' | 'off' =
    opts.intentGate === 'strict' || opts.intentGate === 'off' ? opts.intentGate : 'block';
  const expectToolCall: 'yes' | 'no' | 'unknown' =
    opts.expectToolCall === true ? 'yes' : opts.expectToolCall === false ? 'no' : 'unknown';
  const sideEffecting = Array.isArray(opts.sideEffectingTools) ? opts.sideEffectingTools : [];
  const sideEffectingAllowed = opts.recoverSideEffecting === true;
  const schemasSupplied = Array.isArray(opts.toolSchemas) && opts.toolSchemas.length > 0;

  const regionSpans = new Map<number, { text: string; spans: Span[] }>();
  for (const hit of allHits) {
    let region = regionSpans.get(hit.regionId);
    if (!region) {
      region = { text: hit.regionText, spans: [] };
      regionSpans.set(hit.regionId, region);
    }
    region.spans.push({ start: hit.envelope.start, end: hit.envelope.end });
  }
  const maskedRegions = new Map<number, string>();
  for (const [id, region] of regionSpans) {
    maskedRegions.set(id, maskSpans(region.text, region.spans));
  }

  const perEnvelope: EnvelopeIntent[] = [];
  const allCues = new Set<string>();
  const allPlanning = new Set<string>();
  let anyQuoted = false;
  let anyReasoning = false;
  let anyMid = false;
  let maxTrailing = 0;

  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    const name = hit.envelope.name;
    const reasoning = hit.channel !== 'content';
    const masked = maskedRegions.get(hit.regionId) ?? hit.regionText;
    const start = hit.envelope.start;
    const end = hit.envelope.end;
    const before = masked.slice(Math.max(0, start - CUE_WINDOW), start);
    const after = masked.slice(end, Math.min(masked.length, end + CUE_WINDOW));
    const windowText = before + '\n' + after;
    const negationCues = matchCues(windowText, NEGATION_CUES);
    const retractionCues = matchCues(after, RETRACTION_CUES);
    const planningCues = matchCues(windowText, PLANNING_CUES);
    const quotedContext =
      (QUOTE_CHARS.has(nonWhitespaceBefore(masked, start) ?? '') &&
        QUOTE_CHARS.has(nonWhitespaceAfter(masked, end) ?? '')) ||
      (() => {
        const fence = fenceContext(masked, start);
        return fence.inside && fence.annotated;
      })();

    // Prose after this envelope, excluding every later envelope's own span.
    const later = allHits
      .filter((h) => h.regionId === hit.regionId && h.envelope.start >= end)
      .sort((a, b) => a.envelope.start - b.envelope.start);
    let trailing = '';
    let cursor = end;
    for (const next of later) {
      trailing += hit.regionText.slice(cursor, next.envelope.start);
      cursor = Math.max(cursor, next.envelope.end);
    }
    trailing += hit.regionText.slice(cursor);
    const trailingProseChars = stripToProse(trailing).length;
    const terminal = reasoning ? trailingProseChars < TRAILING_PROSE_MIN : true;

    const blocked: string[] = [];
    if (mode !== 'off') {
      if (negationCues.length > 0) {
        blocked.push(
          `recovery blocked (${name}): negated or illustrative language near the envelope ("${negationCues[0]}")`
        );
      }
      if (retractionCues.length > 0) {
        blocked.push(
          `recovery blocked (${name}): the call is retracted after being written ("${retractionCues[0]}")`
        );
      }
      if (quotedContext) {
        blocked.push(`recovery blocked (${name}): envelope appears inside quoted or reported text`);
      }
      if (reasoning && !terminal) {
        if (mode === 'strict') {
          blocked.push(
            `recovery blocked (${name}): strict mode requires the envelope to end its reasoning channel (${trailingProseChars} trailing chars)`
          );
        } else if (!capped) {
          blocked.push(
            `recovery blocked (${name}): envelope is followed by reasoning prose (${trailingProseChars} chars) — may be a rehearsal`
          );
        }
      }
      if (expectToolCall === 'no') {
        blocked.push(`recovery blocked (${name}): the caller declared that no tool call was expected this turn`);
      }
      if (sideEffecting.includes(name) && !sideEffectingAllowed) {
        blocked.push(
          `recovery blocked (${name}): tool is listed as side-effecting (pass recoverSideEffecting to allow)`
        );
      }
      const validation = validations[i];
      if (validation && validation.schemaValid === 'no') {
        blocked.push(`recovery blocked (${name}): arguments do not satisfy the supplied tool schema`);
      }
      if (schemasSupplied && validation && validation.nameKnown === 'no') {
        blocked.push(
          `recovery blocked (${name}): tool name is not present in the supplied toolSchemas (pass intentGate "off" if the list is partial)`
        );
      }
      if (mode === 'strict') {
        if (planningCues.length > 0) {
          blocked.push(
            `recovery blocked (${name}): strict mode rejects planning language near the envelope ("${planningCues[0]}")`
          );
        }
        if (finishReason && finishReason !== 'stop') {
          blocked.push(
            `recovery blocked (${name}): strict mode requires finish_reason "stop" (got "${finishReason}")`
          );
        }
      }
    }

    for (const cue of [...negationCues, ...retractionCues, ...planningCues]) allCues.add(cue);
    for (const cue of planningCues) allPlanning.add(cue);
    if (quotedContext) anyQuoted = true;
    if (reasoning) anyReasoning = true;
    if (!terminal) anyMid = true;
    maxTrailing = Math.max(maxTrailing, trailingProseChars);

    perEnvelope.push({
      name,
      reasoning,
      terminal,
      trailingProseChars,
      negationCues,
      retractionCues,
      planningCues,
      quotedContext,
      blocked,
    });
  }

  const quotedVeto = perEnvelope.some((e) => e.negationCues.length > 0 || e.quotedContext);
  const rehearsalVeto = (anyMid && !capped) || perEnvelope.some((e) => e.retractionCues.length > 0);
  const category: ToolIntentCategory | null =
    hits.length === 0
      ? null
      : quotedVeto
        ? 'quoted_tool_call'
        : rehearsalVeto
          ? 'tool_rehearsal'
          : 'swallowed_tool_call';

  const evidence: ToolIntentEvidence = {
    boundary: anyMid ? 'mid' : anyReasoning ? 'terminal' : 'unknown',
    trailingProseChars: maxTrailing,
    cues: [...allCues],
    quotedContext: anyQuoted,
    expectToolCall,
    blocked: perEnvelope.flatMap((e) => e.blocked),
  };

  return { category, evidence, perEnvelope, planningCues: [...allPlanning] };
}
