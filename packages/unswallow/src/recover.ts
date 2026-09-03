import { randomUUID } from 'node:crypto';
import type { RawProviderResponse, ToolCallEntry, ToolEnvelope } from './types';

const TOOL_OPEN_AT = /<(tool_call|tool_calls)\b[^>]*>/iy;
const FUNC_OPEN_AT = /<function=([^>]*)>/iy;
const PARAMETER = /<parameter=([^>]*)>([\s\S]*?)<\/parameter\s*>/gi;
const MAX_ENVELOPE_LENGTH = 20000;
export const MAX_ENVELOPES = 32;

export interface LocatedEnvelope extends ToolEnvelope {
  start: number;
  end: number;
}

export interface ExtractionResult {
  envelopes: LocatedEnvelope[];
  capped: boolean;
}

function findClose(text: string, tag: string, from: number): { start: number; end: number } | null {
  const close = new RegExp(`</${tag}\\s*>`, 'i');
  close.lastIndex = from;
  const m = close.exec(text);
  if (!m) return null;
  return { start: m.index, end: m.index + m[0].length };
}

function coerceScalar(v: string): unknown {
  const t = v.trim();
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  return t;
}

export function validateEnvelopeShape(obj: unknown): {
  name: string;
  arguments: Record<string, unknown>;
  argumentsFromString?: boolean;
} | null {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  const fn =
    typeof o.function === 'object' && o.function !== null && !Array.isArray(o.function)
      ? (o.function as Record<string, unknown>)
      : o;
  if (typeof fn.name !== 'string' || fn.name.trim().length === 0 || fn.name.length > 200) {
    return null;
  }
  let args = fn.arguments;
  let fromString = false;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
      fromString = true;
    } catch {
      return null;
    }
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null;
  return {
    name: fn.name.trim(),
    arguments: args as Record<string, unknown>,
    argumentsFromString: fromString,
  };
}

function tryQwenAt(text: string, tag: string, openStart: number, openLen: number): LocatedEnvelope | null {
  const innerStart = openStart + openLen;
  const close = findClose(text, tag, innerStart);
  if (!close) return null;
  const inner = text.slice(innerStart, close.start).trim();
  const raw = text.slice(openStart, close.end);
  if (inner.length === 0 || raw.length > MAX_ENVELOPE_LENGTH) return null;
  const attrName = /name\s*=\s*"([^"]*)"/i.exec(text.slice(openStart, innerStart))?.[1]?.trim();
  if (inner.startsWith('{') || inner.startsWith('[')) {
    let obj: unknown;
    try {
      obj = JSON.parse(inner);
    } catch {
      return null;
    }
    const shape = validateEnvelopeShape(obj);
    if (!shape) return null;
    return {
      name: shape.name,
      arguments: shape.arguments,
      argumentsFromString: shape.argumentsFromString,
      raw,
      format: 'qwen-xml',
      start: openStart,
      end: close.end,
    };
  }
  if (attrName) {
    const params: Record<string, unknown> = {};
    PARAMETER.lastIndex = 0;
    let pm: RegExpExecArray | null;
    let any = false;
    while ((pm = PARAMETER.exec(inner)) !== null) {
      params[pm[1].trim()] = coerceScalar(pm[2]);
      any = true;
    }
    if (any) {
      return { name: attrName, arguments: params, raw, format: 'qwen-xml', start: openStart, end: close.end };
    }
  }
  return null;
}

function tryFunctionAt(text: string, name: string, openStart: number, openLen: number): LocatedEnvelope | null {
  const clean = name.trim().replace(/^["']|["']$/g, '');
  if (!clean) return null;
  const innerStart = openStart + openLen;
  const close = findClose(text, 'function', innerStart);
  if (!close) return null;
  const inner = text.slice(innerStart, close.start).trim();
  const raw = text.slice(openStart, close.end);
  if (raw.length > MAX_ENVELOPE_LENGTH) return null;
  const params: Record<string, unknown> = {};
  PARAMETER.lastIndex = 0;
  let pm: RegExpExecArray | null;
  let any = false;
  while ((pm = PARAMETER.exec(inner)) !== null) {
    params[pm[1].trim()] = coerceScalar(pm[2]);
    any = true;
  }
  if (any) {
    return { name: clean, arguments: params, raw, format: 'function-xml', start: openStart, end: close.end };
  }
  if (inner.startsWith('{')) {
    try {
      const shape = validateEnvelopeShape(JSON.parse(inner));
      if (shape) {
        return {
          name: shape.name,
          arguments: shape.arguments,
          argumentsFromString: shape.argumentsFromString,
          raw,
          format: 'function-xml',
          start: openStart,
          end: close.end,
        };
      }
    } catch {
      return null;
    }
  }
  return null;
}

function tryJsonAt(text: string, braceIndex: number): LocatedEnvelope | null {
  const end = scanBalancedJson(text, braceIndex);
  if (end === -1) return null;
  const raw = text.slice(braceIndex, end);
  if (raw.length > MAX_ENVELOPE_LENGTH) return null;
  let shape: ReturnType<typeof validateEnvelopeShape> = null;
  try {
    shape = validateEnvelopeShape(JSON.parse(raw));
  } catch {
    return null;
  }
  if (!shape) return null;
  return {
    name: shape.name,
    arguments: shape.arguments,
    argumentsFromString: shape.argumentsFromString,
    raw,
    format: 'json',
    start: braceIndex,
    end,
  };
}

export function extractAllEnvelopes(text: string): ExtractionResult {
  const envelopes: LocatedEnvelope[] = [];
  let capped = false;
  const n = text.length;
  let pos = 0;
  let guard = 0;
  while (pos < n) {
    if (guard++ > n + 16) break;
    if (envelopes.length >= MAX_ENVELOPES) {
      capped = true;
      break;
    }
    const lt = text.indexOf('<', pos);
    const brace = text.indexOf('{', pos);
    let next = -1;
    if (lt === -1) next = brace;
    else if (brace === -1) next = lt;
    else next = Math.min(lt, brace);
    if (next === -1) break;
    if (text[next] === '{') {
      const hit = tryJsonAt(text, next);
      if (hit) {
        envelopes.push(hit);
        pos = hit.end;
      } else {
        pos = next + 1;
      }
      continue;
    }
    TOOL_OPEN_AT.lastIndex = next;
    const tool = TOOL_OPEN_AT.exec(text);
    if (tool) {
      const hit = tryQwenAt(text, tool[1], next, tool[0].length);
      if (hit) {
        envelopes.push(hit);
        pos = hit.end;
      } else {
        pos = next + tool[0].length;
      }
      continue;
    }
    FUNC_OPEN_AT.lastIndex = next;
    const func = FUNC_OPEN_AT.exec(text);
    if (func) {
      const hit = tryFunctionAt(text, func[1] ?? '', next, func[0].length);
      if (hit) {
        envelopes.push(hit);
        pos = hit.end;
      } else {
        pos = next + func[0].length;
      }
      continue;
    }
    pos = next + 1;
  }
  return { envelopes, capped };
}

function scanBalancedJson(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

export function extractEnvelope(text: string): ToolEnvelope | null {
  const found = extractAllEnvelopes(text).envelopes[0];
  if (!found) return null;
  const { start: _s, end: _e, ...envelope } = found;
  return envelope;
}

export function buildToolCallsEntry(
  name: string,
  argumentsObj: Record<string, unknown>
): ToolCallEntry {
  return {
    id: `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(argumentsObj) },
  };
}

export function applyRecoveryMany(
  response: RawProviderResponse,
  calls: Array<{ name: string; arguments: Record<string, unknown> }>
): RawProviderResponse {
  const clone = structuredClone(response);
  const choice = clone.choices[0];
  choice.message.tool_calls = calls.map((c) => buildToolCallsEntry(c.name, c.arguments));
  if (choice.finish_reason === 'stop') {
    choice.finish_reason = 'tool_calls';
  }
  return clone;
}

export function applyRecoveryToResponse(
  response: RawProviderResponse,
  name: string,
  argumentsObj: Record<string, unknown>
): RawProviderResponse {
  return applyRecoveryMany(response, [{ name, arguments: argumentsObj }]);
}