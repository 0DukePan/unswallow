import type { RawProviderResponse } from '../src/types';
import type { StreamChunk } from '../src/stream';

export const PROBE_PROMPT =
  'You are being evaluated on tool use. First, use your reasoning channel to plan which tool to call and what arguments to pass. Then actually invoke the get_weather tool for Tokyo. You must emit a real tool call — a plain-text answer is wrong.';

export const PROBE_TOOL = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: 'City name' } },
      required: ['city'],
    },
  },
} as const;

export interface ProbeOptions {
  endpoint: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
}

export type ProbeResult =
  | { ok: true; status: number; response: RawProviderResponse }
  | { ok: false; status?: number; error: string };

export type StreamProbeResult =
  | { ok: true; status: number; chunks: StreamChunk[] }
  | { ok: false; status?: number; error: string };

function probeUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, '');
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
}

async function post(
  o: ProbeOptions,
  stream: boolean
): Promise<{ ok: true; status: number; text: string } | { ok: false; status?: number; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? 60000);
  try {
    const res = await fetch(probeUrl(o.endpoint), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: o.model,
        messages: [{ role: 'user', content: PROBE_PROMPT }],
        tools: [PROBE_TOOL],
        tool_choice: 'auto',
        stream,
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, error: `endpoint returned HTTP ${res.status}: ${text.slice(0, 400)}` };
    }
    return { ok: true, status: res.status, text };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeEndpoint(o: ProbeOptions): Promise<ProbeResult> {
  const r = await post(o, false);
  if (!r.ok) return r;
  try {
    return { ok: true, status: r.status, response: JSON.parse(r.text) as RawProviderResponse };
  } catch {
    return { ok: false, status: r.status, error: 'endpoint returned a non-JSON body' };
  }
}

/** Streaming probe: the streaming tool-call parser is a separate code path in most engines. */
export async function probeEndpointStream(o: ProbeOptions): Promise<StreamProbeResult> {
  const r = await post(o, true);
  if (!r.ok) return r;
  const chunks: StreamChunk[] = [];
  for (const line of r.text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      chunks.push(JSON.parse(payload) as StreamChunk);
    } catch {
      // ignore malformed SSE lines
    }
  }
  if (chunks.length === 0) {
    return { ok: false, status: r.status, error: 'endpoint returned no SSE data chunks for stream:true' };
  }
  return { ok: true, status: r.status, chunks };
}
