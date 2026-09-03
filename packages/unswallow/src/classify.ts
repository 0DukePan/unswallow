import type { ChannelSource, RawMessage, ToolEnvelope, ToolPattern } from './types';
import { extractRegions, type Region } from './scan';
import { extractAllEnvelopes, MAX_ENVELOPES, type LocatedEnvelope } from './recover';

export interface ClassifiedHit {
  envelope: LocatedEnvelope;
  channel: ChannelSource;
  thinkBlock: boolean;
}

export interface Classification {
  pattern: ToolPattern | null;
  envelope: ToolEnvelope | null;
  envelopes: ToolEnvelope[];
  source: ChannelSource;
  reasons: string[];
}

function dedupe(hits: ClassifiedHit[]): { kept: ClassifiedHit[]; duplicates: number } {
  const seen = new Set<string>();
  const kept: ClassifiedHit[] = [];
  let duplicates = 0;
  for (const hit of hits) {
    const key = `${hit.envelope.name}\n${JSON.stringify(hit.envelope.arguments)}`;
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    kept.push(hit);
  }
  return { kept, duplicates };
}

function scanChannel(regions: Region[]): {
  hits: ClassifiedHit[];
  capped: boolean;
  trailingChars: number;
} {
  const hits: ClassifiedHit[] = [];
  let capped = false;
  let trailingChars = 0;
  for (const region of regions) {
    const { envelopes, capped: regionCapped } = extractAllEnvelopes(region.text);
    capped = capped || regionCapped;
    for (const envelope of envelopes) {
      hits.push({
        envelope,
        channel: region.channel,
        thinkBlock: region.source === 'think-block',
      });
      const tail = region.text.slice(envelope.end).trim();
      if (tail.length > 0) trailingChars += tail.length;
    }
  }
  return { hits, capped, trailingChars };
}

function formatsOf(hits: ClassifiedHit[]): string {
  return [...new Set(hits.map((h) => h.envelope.format))].join(', ');
}

export function classify(
  message: RawMessage,
  additionalFields?: string[]
): Classification {
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return {
      pattern: null,
      envelope: null,
      envelopes: [],
      source: 'content',
      reasons: ['response already carries tool_calls'],
    };
  }

  const regions = extractRegions(message, additionalFields);
  const reasoningRegions = regions.filter((r) => r.channel !== 'content');
  const contentRegions = regions.filter((r) => r.channel === 'content');

  const reasoning = scanChannel(reasoningRegions);
  if (reasoning.hits.length > 0) {
    const { kept, duplicates } = dedupe(reasoning.hits);
    const first = kept[0];
    const reasons: string[] = [
      kept.length === 1
        ? `tool-call envelope (${first.envelope.format}) found inside ${first.channel} channel${
            first.thinkBlock ? ' (think block in content)' : ''
          } while tool_calls is empty`
        : `${kept.length} tool-call envelopes (${formatsOf(kept)}) found inside reasoning channel${
            kept.some((h) => h.thinkBlock) ? ' (think block in content)' : ''
          } while tool_calls is empty`,
    ];
    if (reasoning.capped) {
      reasons.push(`envelope scan capped at ${MAX_ENVELOPES}; recovered the first ${MAX_ENVELOPES}`);
    }
    if (duplicates > 0) {
      reasons.push(`ignored ${duplicates} duplicate tool-call envelope(s)`);
    }
    const contentHits = scanChannel(contentRegions).hits;
    if (contentHits.length > 0) {
      reasons.push('additional envelope(s) found in content; recovered the reasoning-channel one(s)');
    }
    return {
      pattern: 'A',
      envelope: kept[0].envelope,
      envelopes: kept.map((h) => h.envelope),
      source: kept[0].channel,
      reasons,
    };
  }

  const content = scanChannel(contentRegions);
  if (content.hits.length > 0) {
    const { kept, duplicates } = dedupe(content.hits);
    const reasons: string[] =
      content.trailingChars > 0
        ? [
            kept.length === 1
              ? `trailing text (${content.trailingChars} chars) after tool-call envelope in content — strict JSON.parse would fail`
              : `trailing text (${content.trailingChars} chars) after tool-call envelopes in content — strict JSON.parse would fail`,
          ]
        : [
            kept.length === 1
              ? 'complete tool-call envelope present in content but never parsed into tool_calls'
              : 'complete tool-call envelopes present in content but never parsed into tool_calls',
          ];
    if (content.capped) {
      reasons.push(`envelope scan capped at ${MAX_ENVELOPES}; recovered the first ${MAX_ENVELOPES}`);
    }
    if (duplicates > 0) {
      reasons.push(`ignored ${duplicates} duplicate tool-call envelope(s)`);
    }
    return {
      pattern: 'B',
      envelope: kept[0].envelope,
      envelopes: kept.map((h) => h.envelope),
      source: 'content',
      reasons,
    };
  }

  if (regions.some((r) => r.source === 'leak')) {
    return {
      pattern: 'C',
      envelope: null,
      envelopes: [],
      source: 'thinking',
      reasons: ['reasoning tags leaked into the content field (unclosed think block)'],
    };
  }

  return { pattern: null, envelope: null, envelopes: [], source: 'content', reasons: [] };
}
