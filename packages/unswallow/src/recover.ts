import { randomUUID } from 'node:crypto';
import type { RawProviderResponse, ToolCallEntry, ToolEnvelope } from './types';

const XML_TOOL_CALL = /<(tool_call|tool_calls)\b[^>]*>/i;
const FUNCTION_OPEN = /<function=([^>]*)>/i;
const PARAMETER = /<parameter=([^>]*)>([\s\S]*?)<\/parameter\s*>/gi;
const MAX_ENVELOPE_LENGTH = 20000;

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

function extractQwenXml(text: string): ToolEnvelope | null {
  const m = XML_TOOL_CALL.exec(text);
  if (!m) return null;
  const tag = m[1];
  const innerStart = m.index + m[0].length;
  const close = findClose(text, tag, innerStart);
  if (!close) return null;
  const inner = text.slice(innerStart, close.start).trim();
  const raw = text.slice(m.index, close.end);
  if (inner.length === 0 || raw.length > MAX_ENVELOPE_LENGTH) return null;
  const attrName = /name\s*=\s*"([^"]*)"/i.exec(m[0])?.[1]?.trim();
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
      return { name: attrName, arguments: params, raw, format: 'qwen-xml' };
    }
  }
  return null;
}

function extractFunctionXml(text: string): ToolEnvelope | null {
  const m = FUNCTION_OPEN.exec(text);
  if (!m) return null;
  const name = m[1].trim().replace(/^["']|["']$/g, '');
  if (!name) return null;
  const innerStart = m.index + m[0].length;
  const close = findClose(text, 'function', innerStart);
  if (!close) return null;
  const inner = text.slice(innerStart, close.start).trim();
  const raw = text.slice(m.index, close.end);
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
    return { name, arguments: params, raw, format: 'function-xml' };
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
        };
      }
    } catch {
      return null;
    }
  }
  return null;
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

function extractJson(text: string): ToolEnvelope | null {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    const end = scanBalancedJson(text, i);
    if (end === -1) continue;
    const raw = text.slice(i, end);
    if (raw.length > MAX_ENVELOPE_LENGTH) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      continue;
    }
    const shape = validateEnvelopeShape(obj);
    if (!shape) continue;
    return {
      name: shape.name,
      arguments: shape.arguments,
      argumentsFromString: shape.argumentsFromString,
      raw,
      format: 'json',
    };
  }
  return null;
}

export function extractEnvelope(text: string): ToolEnvelope | null {
  return extractQwenXml(text) ?? extractFunctionXml(text) ?? extractJson(text);
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

export function applyRecoveryToResponse(
  response: RawProviderResponse,
  name: string,
  argumentsObj: Record<string, unknown>
): RawProviderResponse {
  const clone = structuredClone(response);
  const choice = clone.choices[0];
  choice.message.tool_calls = [buildToolCallsEntry(name, argumentsObj)];
  if (choice.finish_reason === 'stop') {
    choice.finish_reason = 'tool_calls';
  }
  return clone;
}