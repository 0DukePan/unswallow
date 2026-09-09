import { splitThinkBlocks } from './scan';

export interface HistoryMessage {
  role?: string;
  content?: string | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
  thinking?: string | null;
  thought?: string | null;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function: { name: string; arguments: string };
  }>;
  [key: string]: unknown;
}

export interface EnsureReasoningEchoOptions {
  /** Value echoed for tool-call turns missing reasoning_content. Defaults to an empty string. */
  defaultValue?: string;
}

export interface SanitizeHistoryOptions {
  stripReasoningFields?: boolean;
  stripReasoningTags?: boolean;
}

const REASONING_FIELDS = ['reasoning', 'reasoning_content', 'thinking', 'thought'] as const;

const DEEPSEEK_OPENER = /[^\x20-\x7E]{1,4}tool_call[^\x20-\x7E]{1,4}/g;

export function stripReasoningTags(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  const parts = splitThinkBlocks(text);
  const withoutBlocks = parts
    .map((r) => {
      if (r.channel === 'content') return r.text;
      if (r.source === 'leak') {
        return r.text.replace(/^<\s*([a-zA-Z0-9_.:-]*?\s*think)\s*>/i, '');
      }
      return '';
    })
    .join('');
  return withoutBlocks.replace(DEEPSEEK_OPENER, '').trim();
}

/**
 * Preserve the reasoning-field echo required by thinking-mode tool APIs.
 * This intentionally makes no provider-specific translation or other edits.
 */
export function ensureReasoningEcho(
  messages: HistoryMessage[],
  opts: EnsureReasoningEchoOptions = {}
): HistoryMessage[] {
  const defaultValue = opts.defaultValue ?? '';
  return messages.map((message) => {
    const out: HistoryMessage = { ...message };
    const calls = out.tool_calls;
    if (
      out.role === 'assistant' &&
      Array.isArray(calls) &&
      calls.length > 0 &&
      (out.reasoning_content === undefined || out.reasoning_content === null)
    ) {
      out.reasoning_content = defaultValue;
    }
    return out;
  });
}

export function sanitizeHistory(
  messages: HistoryMessage[],
  opts: SanitizeHistoryOptions = {}
): HistoryMessage[] {
  const stripFields = opts.stripReasoningFields !== false;
  const stripTags = opts.stripReasoningTags !== false;
  return messages.map((msg) => {
    const out: HistoryMessage = { ...msg };
    if (stripFields) {
      for (const f of REASONING_FIELDS) {
        delete out[f];
      }
    }
    if (stripTags && typeof out.content === 'string') {
      out.content = stripReasoningTags(out.content);
    }
    return out;
  });
}