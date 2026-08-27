import type { RawProviderResponse } from '../src/types';

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

export async function probeEndpoint(o: ProbeOptions): Promise<ProbeResult> {
  const base = o.endpoint.replace(/\/+$/, '');
  const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? 60000);
  try {
    const res = await fetch(url, {
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
        stream: false,
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: `endpoint returned HTTP ${res.status}: ${text.slice(0, 400)}`,
      };
    }
    let response: RawProviderResponse;
    try {
      response = JSON.parse(text);
    } catch {
      return { ok: false, status: res.status, error: 'endpoint returned a non-JSON body' };
    }
    return { ok: true, status: res.status, response };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}