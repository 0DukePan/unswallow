import http from 'node:http';
import { checkMessage } from './pipeline';
import { createStreamAccumulator } from './stream';
import { applyRecoveryMany } from './recover';
import { normalizeEngine } from './matrix';
import type { StreamChunk } from './stream';
import type {
  CheckOptions,
  RawProviderResponse,
  SwallowCheckResult,
  ToolSchema,
} from './types';

export interface ProxyOptions extends CheckOptions {
  upstream: string;
  prefix?: string;
  maxBodyBytes?: number;
  onResult?: (result: SwallowCheckResult, path: string) => void;
  /** Opt-in: derive expectToolCall / toolSchemas from the client's request tools. */
  requestAware?: boolean;
  /** Detect and report but never rewrite a response. */
  observeOnly?: boolean;
}

export interface ProxyServer extends http.Server {
  upstreamUrl: string;
  engineHint?: string;
  engineVersion?: string;
}

const DEFAULT_PREFIX = '/v1';
const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;

function linkAbort(
  req: http.IncomingMessage,
  res: http.ServerResponse
): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController();
  let done = false;
  const abort = () => {
    if (done || res.writableEnded || res.writableFinished) return;
    done = true;
    controller.abort();
  };
  // NOTE: req 'close' also fires after a normally-consumed request body on
  // keep-alive connections, so it is NOT by itself proof the client is gone.
  // Abort only when the request never completed, the socket is destroyed, or
  // the response stream closes before it was fully written.
  const onReqClose = () => {
    const abortedFlag = (req as unknown as { aborted?: boolean }).aborted === true;
    if (!req.complete || abortedFlag || req.socket.destroyed) abort();
  };
  const onResClose = () => {
    if (!res.writableEnded && !res.writableFinished) abort();
  };
  req.on('close', onReqClose);
  res.on('close', onResClose);
  return {
    signal: controller.signal,
    release: () => {
      req.removeListener('close', onReqClose);
      res.removeListener('close', onResClose);
    },
  };
}

function isAbortError(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e.name === 'AbortError' || (e as { code?: string }).code === 'ABORT_ERR')
  );
}

function safeWrite(res: http.ServerResponse, chunk: string): void {
  if (res.destroyed || res.writableEnded) return;
  try {
    res.write(chunk);
  } catch {
    // downstream already gone; the linked abort handles upstream teardown
  }
}

function isChatCompletions(path: string, prefix: string): boolean {
  const base = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  return path === `${base}/chat/completions` || path === `${base}/chat/completions/`;
}

function isStreamingRequest(payload: unknown): boolean {
  return typeof payload === 'object' && payload !== null && (payload as Record<string, unknown>).stream === true;
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error(`request body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function forwardHeaders(req: http.IncomingMessage): Headers {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (k === 'host' || k === 'content-length' || k === 'connection' || k === 'transfer-encoding') {
      continue;
    }
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  return headers;
}

function parseStreamChunk(line: string): StreamChunk | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;
  try {
    return JSON.parse(payload) as StreamChunk;
  } catch {
    return null;
  }
}

function ssePayload(chunk: unknown): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function report(result: SwallowCheckResult, observeOnly: boolean): Record<string, unknown> {
  return {
    detected: result.detected,
    pattern: result.pattern,
    recovered: result.recovered,
    confidence: result.confidence,
    category: result.category,
    blocked: result.intent?.blocked.length ?? 0,
    observeOnly,
  };
}

/**
 * Opt-in request-aware gating: use the client's own request tools to avoid
 * fabricating a call the caller never offered. With requestAware off the
 * proxy behaves exactly as before (request payload is ignored).
 */
function effectiveCheckOpts(
  base: CheckOptions,
  payload: unknown,
  requestAware?: boolean
): CheckOptions {
  if (!requestAware) return base;
  const p = (payload ?? {}) as { tools?: unknown; tool_choice?: unknown };
  const tools = Array.isArray(p.tools) ? (p.tools as ToolSchema[]) : [];
  const hasTools = tools.length > 0;
  const toolChoiceNone = p.tool_choice === 'none';
  if (!hasTools || toolChoiceNone) {
    const next: CheckOptions = { ...base, expectToolCall: false };
    if (hasTools) next.toolSchemas = tools;
    return next;
  }
  return { ...base, toolSchemas: tools };
}

function checkResponse(
  response: RawProviderResponse,
  opts: CheckOptions
): SwallowCheckResult {
  if (
    !response ||
    !Array.isArray((response as { choices?: unknown }).choices) ||
    (response as { choices: unknown[] }).choices.length === 0 ||
    !(response as { choices: Array<{ message?: unknown }> }).choices[0].message
  ) {
    const engine = normalizeEngine(opts.engineHint);
    return {
      detected: false,
      pattern: null,
      toolCall: null,
      toolCalls: null,
      recovered: false,
      source: 'content',
      engineHint: engine,
      matrixMatch: null,
      confidence: 0,
      warnings: ['response has no choices[0].message'],
      validation: null,
      recoveredResponse: null,
      category: null,
      intent: {
        boundary: 'unknown',
        trailingProseChars: 0,
        cues: [],
        quotedContext: false,
        expectToolCall: 'unknown',
        blocked: [],
      },
      recoveredCalls: null,
    };
  }
  const result = checkMessage(
    response.choices[0].message,
    opts,
    response.choices[0].finish_reason ?? null
  );
  if (result.recovered && result.recoveredCalls && result.recoveredCalls.length > 0) {
    result.recoveredResponse = applyRecoveryMany(response, result.recoveredCalls);
  }
  return result;
}

export function createProxyServer(opts: ProxyOptions): ProxyServer {
  const upstream = opts.upstream.replace(/\/+$/, '');
  const prefix = opts.prefix ?? DEFAULT_PREFIX;
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const onResult = opts.onResult;
  const requestAware = opts.requestAware ?? false;
  const observeOnly = opts.observeOnly ?? false;
  const baseCheckOpts: CheckOptions = {
    engineHint: opts.engineHint,
    engineVersion: opts.engineVersion,
    toolSchemas: opts.toolSchemas,
    matrix: opts.matrix,
    additionalFields: opts.additionalFields,
    minConfidence: opts.minConfidence,
    strictSchema: opts.strictSchema,
    intentGate: opts.intentGate,
    expectToolCall: opts.expectToolCall,
    sideEffectingTools: opts.sideEffectingTools,
    recoverSideEffecting: opts.recoverSideEffecting,
  };

  const server = http.createServer(async (req, res) => {
    const path = req.url ?? '/';
    const { signal, release } = linkAbort(req, res);
    try {
      try {
        if (req.method !== 'POST' || !isChatCompletions(path, prefix)) {
          await pipePassthrough(req, res, upstream + path, signal);
          return;
        }

        let body: Buffer;
        try {
          body = await readBody(req, maxBodyBytes);
        } catch (e) {
          if (isAbortError(e)) return;
          if (!res.destroyed && !res.writableEnded) {
            res.writeHead(413);
            res.end(e instanceof Error ? e.message : 'request too large');
          }
          return;
        }

        let payload: unknown;
        try {
          payload = JSON.parse(body.toString('utf8'));
        } catch {
          if (!res.destroyed && !res.writableEnded) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid JSON body' }));
          }
          return;
        }

        const checkOpts = effectiveCheckOpts(baseCheckOpts, payload, requestAware);

        let upstreamRes: Response;
        try {
          upstreamRes = await fetch(upstream + path, {
            method: 'POST',
            headers: forwardHeaders(req),
            body: JSON.stringify(payload),
            signal,
          });
        } catch (e) {
          if (isAbortError(e)) return;
          if (!res.destroyed && !res.writableEnded) {
            res.writeHead(502);
            res.end(e instanceof Error ? e.message : 'upstream unreachable');
          }
          return;
        }

        if (upstreamRes.status !== 200) {
          const text = await upstreamRes.text();
          if (!res.destroyed && !res.writableEnded) {
            res.writeHead(upstreamRes.status, {
              'content-type': upstreamRes.headers.get('content-type') ?? 'application/json',
            });
            res.end(text);
          }
          return;
        }

        if (isStreamingRequest(payload)) {
          await handleStreaming(upstreamRes, res, signal, checkOpts, onResult, path, observeOnly);
          return;
        }

        let response: RawProviderResponse;
        try {
          response = JSON.parse(await upstreamRes.text()) as RawProviderResponse;
        } catch {
          if (!res.destroyed && !res.writableEnded) {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'upstream returned non-JSON for chat completion' }));
          }
          return;
        }
        const result = checkResponse(response, checkOpts);
        onResult?.(result, path);
        const out =
          result.recovered && !observeOnly && result.recoveredResponse
            ? result.recoveredResponse
            : response;
        if (!res.destroyed && !res.writableEnded) {
          res.writeHead(200, {
            'content-type': 'application/json',
            'x-unswallow': JSON.stringify(report(result, observeOnly)),
          });
          res.end(JSON.stringify(out));
        }
      } catch (e) {
        if (isAbortError(e) || signal.aborted) return;
        // Top-level guard: never leave the client hanging / never crash the process.
        if (res.destroyed || res.writableEnded) return;
        try {
          if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: e instanceof Error ? e.message : 'proxy error' }));
          } else {
            safeWrite(res, 'data: [DONE]\n\n');
            res.end();
          }
        } catch {
          // last-resort: ensure the socket does not hang
          try {
            res.end();
          } catch {
            // ignore
          }
        }
      }
    } finally {
      release();
    }
  });

  (server as ProxyServer).upstreamUrl = upstream;
  (server as ProxyServer).engineHint = baseCheckOpts.engineHint as string | undefined;
  (server as ProxyServer).engineVersion = baseCheckOpts.engineVersion as string | undefined;
  return server as ProxyServer;
}

async function pipePassthrough(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  upstreamUrl: string,
  signal?: AbortSignal
): Promise<void> {
  const isGetOrHead = req.method === 'GET' || req.method === 'HEAD';
  try {
    const upstreamRes = await fetch(upstreamUrl, {
      method: req.method ?? 'GET',
      headers: forwardHeaders(req),
      ...(isGetOrHead ? {} : { body: await readBody(req, DEFAULT_MAX_BODY_BYTES) }),
      ...(signal ? { signal } : {}),
    });
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(upstreamRes.status, {
      'content-type': upstreamRes.headers.get('content-type') ?? 'application/octet-stream',
    });
    res.end(Buffer.from(await upstreamRes.arrayBuffer()));
  } catch (e) {
    if (isAbortError(e)) return;
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(502);
    res.end(e instanceof Error ? e.message : 'upstream unreachable');
  }
}

async function handleStreaming(
  upstreamRes: Response,
  res: http.ServerResponse,
  signal: AbortSignal,
  checkOpts: CheckOptions,
  onResult: ((result: SwallowCheckResult, path: string) => void) | undefined,
  path: string,
  observeOnly: boolean
): Promise<void> {
  const acc = createStreamAccumulator();
  const reader = upstreamRes.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finishChunk: string | null = null;
  let doneChunk: string | null = null;
  let overflowed = false;

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const forwardLine = (line: string) => {
    if (overflowed) {
      safeWrite(res, line + '\n');
      return;
    }
    if (line.startsWith('data:')) {
      const chunk = parseStreamChunk(line);
      if (chunk) {
        try {
          acc.push(chunk);
        } catch (e) {
          if (e instanceof RangeError) {
            // Accumulator guard tripped: forward the rest untouched, skip recovery.
            overflowed = true;
            safeWrite(res, line + '\n');
            return;
          }
          throw e;
        }
        const choice = chunk.choices?.[0];
        if (choice?.finish_reason) {
          finishChunk = line;
          return;
        }
      }
      if (line.trim() === 'data: [DONE]') {
        doneChunk = line;
        return;
      }
    }
    safeWrite(res, line + '\n');
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        forwardLine(line);
      }
    }
  } catch (e) {
    if (isAbortError(e) || signal.aborted) {
      try {
        await reader.cancel();
      } catch {
        // reader already released
      }
      if (!res.destroyed && !res.writableEnded) res.destroy();
      return;
    }
    throw e;
  }
  if (buffer.length > 0) forwardLine(buffer);

  if (overflowed) {
    // Forward untouched; do not attempt recovery or diagnostics that need the full body.
    if (finishChunk) safeWrite(res, finishChunk + '\n');
    if (!res.destroyed && !res.writableEnded) {
      safeWrite(res, doneChunk ?? 'data: [DONE]');
      safeWrite(res, '\n\n');
      res.end();
    }
    return;
  }

  let assembled: RawProviderResponse;
  try {
    assembled = acc.end();
  } catch {
    // If the accumulator cannot assemble (e.g. guard), forward what we have.
    if (finishChunk) safeWrite(res, finishChunk + '\n');
    if (!res.destroyed && !res.writableEnded) {
      safeWrite(res, doneChunk ?? 'data: [DONE]');
      safeWrite(res, '\n\n');
      res.end();
    }
    return;
  }
  const result = checkMessage(
    assembled.choices[0].message,
    checkOpts,
    assembled.choices[0].finish_reason ?? null
  );
  onResult?.(result, path);

  safeWrite(
    res,
    ssePayload({
      id: assembled.id,
      object: 'chat.completion.chunk',
      choices: [],
      x_unswallow: report(result, observeOnly),
    })
  );

  if (!observeOnly && result.recovered && result.recoveredCalls && result.recoveredCalls.length > 0) {
    const recovered = applyRecoveryMany(assembled, result.recoveredCalls);
    const calls = recovered.choices[0].message.tool_calls ?? [];
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      safeWrite(
        res,
        ssePayload({
          id: assembled.id,
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              finish_reason: null,
              delta: { tool_calls: [{ index: i, ...call }] },
            },
          ],
        })
      );
    }
    safeWrite(
      res,
      ssePayload({
        id: assembled.id,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, finish_reason: 'tool_calls', delta: {} }],
      })
    );
  } else if (finishChunk) {
    safeWrite(res, finishChunk + '\n');
  }

  if (!res.destroyed && !res.writableEnded) {
    safeWrite(res, doneChunk ?? 'data: [DONE]');
    safeWrite(res, '\n\n');
    res.end();
  }
}

export function startProxy(opts: ProxyOptions & { host?: string; port?: number }): ProxyServer {
  const server = createProxyServer(opts);
  server.listen(opts.port ?? 8787, opts.host ?? '127.0.0.1');
  return server;
}
