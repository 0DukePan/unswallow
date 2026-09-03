import { checkMessage } from './index';
import { applyRecoveryMany } from './recover';
import type {
  CheckOptions,
  RawProviderResponse,
  SwallowCheckResult,
  ToolCallEntry,
} from './types';

export interface StreamDelta {
  content?: string;
  reasoning?: string;
  reasoning_content?: string;
  thinking?: string;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
  [key: string]: unknown;
}

export interface StreamChunk {
  id?: string;
  object?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    finish_reason?: string | null;
    delta?: StreamDelta;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export interface StreamAccumulatorOptions {
  maxBufferBytes?: number;
  onLeak?: (note: string) => void;
}

const DEFAULT_MAX_BUFFER_BYTES = 1_000_000;
const TAIL_SIZE = 64;

const OPEN_TAG_AT = /^<\s*([a-zA-Z0-9_.:-]*?\s*think)\s*>/i;
const CLOSE_TAG_AT = /^<\s*\/\s*([a-zA-Z0-9_.:-]*?\s*think)\s*>/i;
const RESPONSE_TAG_AT = /^<\s*([a-zA-Z0-9_.:-]*?\s*response)\s*>/i;

class ChannelTracker {
  opens = 0;
  closes = 0;
  private tail = '';
  private inString = false;
  private escaped = false;

  push(text: string): void {
    const buf = this.tail + text;
    for (let i = 0; i < buf.length; i++) {
      const ch = buf[i];
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (ch === '\\') this.escaped = true;
        else if (ch === '"') this.inString = false;
        continue;
      }
      if (ch === '"') {
        this.inString = true;
        continue;
      }
      if (ch !== '<') continue;
      const rest = buf.slice(i);
      if (OPEN_TAG_AT.test(rest)) {
        this.opens++;
        continue;
      }
      if (CLOSE_TAG_AT.test(rest) || RESPONSE_TAG_AT.test(rest)) {
        this.closes++;
      }
    }
    this.tail = buf.slice(-TAIL_SIZE);
  }
}

function accumulateToolCalls(
  message: { tool_calls?: ToolCallEntry[] },
  deltaCalls: StreamDelta['tool_calls']
): void {
  if (!deltaCalls || deltaCalls.length === 0) return;
  if (!message.tool_calls) message.tool_calls = [];
  for (const dc of deltaCalls) {
    const index = dc.index ?? message.tool_calls.length;
    if (index >= message.tool_calls.length) {
      message.tool_calls.push({
        id: dc.id,
        type: dc.type,
        function: {
          name: dc.function?.name ?? '',
          arguments: dc.function?.arguments ?? '',
        },
      });
    }
    const target = message.tool_calls[index];
    if (!target) continue;
    if (dc.id && !target.id) target.id = dc.id;
    if (dc.type && !target.type) target.type = dc.type;
    if (dc.function?.name && !target.function.name) target.function.name = dc.function.name;
    if (dc.function?.arguments) target.function.arguments += dc.function.arguments;
  }
}

export function createStreamAccumulator(
  opts: StreamAccumulatorOptions = {}
): {
  push(chunk: StreamChunk): void;
  end(): RawProviderResponse;
} {
  const maxBytes = opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const channels: Record<string, { text: string; tracker: ChannelTracker }> = {};
  const rawToolCalls: StreamDelta['tool_calls'][] = [];
  let totalBytes = 0;
  let lastFinishReason: string | null = null;
  let responseId: string | undefined;
  let responseModel: string | undefined;
  let messageToolCalls: ToolCallEntry[] | undefined;
  let leaked = false;

  const channel = (name: string) => {
    if (!channels[name]) channels[name] = { text: '', tracker: new ChannelTracker() };
    return channels[name];
  };

  return {
    push(chunk: StreamChunk): void {
      if (chunk.id) responseId = chunk.id;
      if (chunk.model) responseModel = chunk.model;
      const choice = chunk.choices?.[0];
      if (!choice?.delta) return;
      if (choice.finish_reason) lastFinishReason = choice.finish_reason;
      const delta = choice.delta;
      if (delta.tool_calls && delta.tool_calls.length > 0) {
        rawToolCalls.push(delta.tool_calls);
      }
      for (const field of ['content', 'reasoning', 'reasoning_content', 'thinking', 'thought'] as const) {
        const text = delta[field];
        if (typeof text !== 'string' || text.length === 0) continue;
        const c = channel(field);
        c.tracker.push(text);
        if (field === 'content') {
          if (c.tracker.closes > c.tracker.opens) {
            leaked = true;
            opts.onLeak?.('think tag closed without opening in the content channel (mid-stream leak)');
          }
        }
        c.text += text;
        totalBytes += text.length;
        if (totalBytes > maxBytes) {
          throw new RangeError(
            `stream buffer exceeded ${maxBytes} bytes; pass maxBufferBytes to raise the guard`
          );
        }
      }
    },
    end(): RawProviderResponse {
      const message: RawProviderResponse['choices'][0]['message'] = { role: 'assistant' };
      for (const [field, c] of Object.entries(channels)) {
        if (c.text.length > 0) (message as Record<string, unknown>)[field] = c.text;
        if (field === 'content' && c.tracker.opens > c.tracker.closes) {
          opts.onLeak?.(
            'unclosed think block in the content channel at stream end (pattern C field leak)'
          );
        }
      }
      if (rawToolCalls.length > 0) {
        for (const dc of rawToolCalls) accumulateToolCalls(message, dc);
      }
      return {
        id: responseId,
        object: 'chat.completion',
        model: responseModel,
        choices: [
          {
            index: 0,
            finish_reason: lastFinishReason ?? 'stop',
            message,
          },
        ],
      };
    },
  };
}

export async function checkAndRescueStream(
  stream: AsyncIterable<StreamChunk>,
  opts: CheckOptions & StreamAccumulatorOptions = {}
): Promise<SwallowCheckResult> {
  const acc = createStreamAccumulator(opts);
  for await (const chunk of stream) {
    acc.push(chunk);
  }
  const response = acc.end();
  const result = checkMessage(response.choices[0].message, opts);
  if (result.recovered && result.toolCalls && result.toolCalls.length > 0) {
    result.recoveredResponse = applyRecoveryMany(
      response,
      result.toolCalls
    );
  }
  return result;
}