import type { ChannelSource, RawMessage, ToolEnvelope, ToolPattern } from './types';
import { extractRegions, type Region } from './scan';
import { extractEnvelope } from './recover';

export interface Classification {
  pattern: ToolPattern | null;
  envelope: ToolEnvelope | null;
  source: ChannelSource;
  reasons: string[];
}

export function classify(
  message: RawMessage,
  additionalFields?: string[]
): Classification {
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return {
      pattern: null,
      envelope: null,
      source: 'content',
      reasons: ['response already carries tool_calls'],
    };
  }

  const regions = extractRegions(message, additionalFields);
  const reasoningRegions = regions.filter((r) => r.channel !== 'content');
  const contentRegions = regions.filter((r) => r.channel === 'content');

  for (const region of reasoningRegions) {
    const envelope = extractEnvelope(region.text);
    if (envelope) {
      const reasons: string[] = [
        `tool-call envelope (${envelope.format}) found inside ${region.channel} channel${
          region.source === 'think-block' ? ' (think block in content)' : ''
        } while tool_calls is empty`,
      ];
      const contentEnvelopes = contentRegions
        .map((r) => extractEnvelope(r.text))
        .filter(Boolean);
      if (contentEnvelopes.length > 0) {
        reasons.push('an additional envelope was found in content; recovered the reasoning-channel one');
      }
      return { pattern: 'A', envelope, source: region.channel, reasons };
    }
  }

  for (const region of contentRegions) {
    const envelope = extractEnvelope(region.text);
    if (envelope) {
      const idx = region.text.indexOf(envelope.raw);
      const trailing = region.text.slice(idx + envelope.raw.length).trim();
      const reason = trailing
        ? `trailing text (${trailing.length} chars) after tool-call envelope in content — strict JSON.parse would fail`
        : 'complete tool-call envelope present in content but never parsed into tool_calls';
      return { pattern: 'B', envelope, source: 'content', reasons: [reason] };
    }
  }

  if (regions.some((r) => r.source === 'leak')) {
    return {
      pattern: 'C',
      envelope: null,
      source: 'thinking',
      reasons: ['reasoning tags leaked into the content field (unclosed think block)'],
    };
  }

  return { pattern: null, envelope: null, source: 'content', reasons: [] };
}