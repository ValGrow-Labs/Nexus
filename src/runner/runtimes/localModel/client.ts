/**
 * The local model server's HTTP client (Ollama's native API: `GET /api/version`, `GET /api/tags`, `POST /api/show`,
 * `POST /api/chat`). It speaks plain HTTP to the ONE checked loopback address `endpoint.ts` produced, and nothing else:
 *
 * - `node:http` with the address as the host (never a name to resolve again), no agent (no kept-alive socket outlives a
 *   request), a `Host` header of the loopback address itself;
 * - redirects are never followed: any 3xx is a failure, so a server cannot send the request elsewhere;
 * - every request has a timeout and every response a size cap (the body is read to the cap and the socket destroyed past
 *   it); the caller's `AbortSignal` destroys the request at once;
 * - a failure is a closed kind (`unreachable | timeout | too_large | redirect | status | bad_json | aborted`): the server's own
 *   error text and body are never kept, returned or logged.
 */
import * as http from 'node:http';
import type { Target } from './endpoint';

export type ClientFailure = 'unreachable' | 'timeout' | 'too_large' | 'redirect' | 'status' | 'bad_json' | 'aborted';
export type ClientResult<T> = { ok: true; value: T } | { ok: false; kind: ClientFailure; status?: number };
type Ok = Extract<Target, { ok: true }>;
interface Bounds { timeoutMs: number; maxBytes: number; signal?: AbortSignal }

export interface RequestOptions extends Bounds {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}

/** One JSON request. Never throws. */
export function requestJson(target: Ok, o: RequestOptions): Promise<ClientResult<unknown>> {
  return new Promise((resolve) => {
    let settled = false;
    let req: http.ClientRequest | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (r: ClientResult<unknown>): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      if (!r.ok) { try { req?.destroy(); } catch { /* gone */ } }
      resolve(r);
    };
    const onAbort = (): void => done({ ok: false, kind: 'aborted' });
    if (o.signal?.aborted) { resolve({ ok: false, kind: 'aborted' }); return; }
    o.signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => done({ ok: false, kind: 'timeout' }), Math.max(1, o.timeoutMs));
    (timer as { unref?: () => void }).unref?.();
    const payload = o.body === undefined ? null : Buffer.from(JSON.stringify(o.body), 'utf8');
    try {
      req = http.request({
        host: target.address, port: target.port, method: o.method, path: o.path, agent: false, family: target.family,
        headers: {
          host: target.hostHeader, accept: 'application/json', connection: 'close',
          ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {})
        }
      }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) { res.resume(); done({ ok: false, kind: 'redirect', status }); return; }
        if (status < 200 || status >= 300) { res.resume(); done({ ok: false, kind: 'status', status }); return; }
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > o.maxBytes) { res.resume(); done({ ok: false, kind: 'too_large' }); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > o.maxBytes) { done({ ok: false, kind: 'too_large' }); res.destroy(); return; }
          chunks.push(c);
        });
        res.on('error', () => done({ ok: false, kind: 'unreachable' }));
        res.on('aborted', () => done({ ok: false, kind: 'unreachable' }));
        res.on('end', () => {
          if (settled) return;
          try { done({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }); }
          catch { done({ ok: false, kind: 'bad_json' }); }
        });
      });
      req.on('error', () => done({ ok: false, kind: 'unreachable' }));
      req.end(payload ?? undefined);
    } catch {
      done({ ok: false, kind: 'unreachable' });
    }
  });
}

// ---- the four calls ----

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
}
export interface ChatTool { type: 'function'; function: { name: string; description: string; parameters: unknown } }
export interface ChatReply {
  content: string;
  toolCalls: { name: unknown; arguments: unknown }[];
  inputTokens: number;
  outputTokens: number;
  doneReason: string;
}

const asCount = (x: unknown): number => (typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : 0);

/** The reply's text, its tool calls (exactly as the server gave them) and its token counts, or null when it is not a chat reply. */
export function parseChatReply(json: unknown): ChatReply | null {
  if (typeof json !== 'object' || json === null) return null;
  const j = json as { message?: { content?: unknown; tool_calls?: unknown }; prompt_eval_count?: unknown; eval_count?: unknown; done_reason?: unknown };
  const m = j.message;
  if (typeof m !== 'object' || m === null) return null;
  const calls = Array.isArray(m.tool_calls) ? m.tool_calls as { function?: { name?: unknown; arguments?: unknown } }[] : [];
  return {
    content: typeof m.content === 'string' ? m.content : '',
    toolCalls: calls.map((c) => ({ name: c?.function?.name, arguments: c?.function?.arguments })),
    inputTokens: asCount(j.prompt_eval_count), outputTokens: asCount(j.eval_count),
    doneReason: typeof j.done_reason === 'string' ? j.done_reason.slice(0, 32) : ''
  };
}

export interface ChatRequest { model: string; messages: ChatMessage[]; tools: ChatTool[]; numCtx: number; numPredict: number }

export async function chat(target: Ok, r: ChatRequest, o: Bounds): Promise<ClientResult<ChatReply>> {
  const res = await requestJson(target, {
    method: 'POST', path: '/api/chat', ...o,
    body: { model: r.model, messages: r.messages, tools: r.tools, stream: false, options: { num_ctx: r.numCtx, num_predict: r.numPredict, temperature: 0.2 } }
  });
  if (!res.ok) return res;
  const reply = parseChatReply(res.value);
  return reply ? { ok: true, value: reply } : { ok: false, kind: 'bad_json' };
}

/** The server's version string, or a failure. */
export async function version(target: Ok, o: Bounds): Promise<ClientResult<string>> {
  const res = await requestJson(target, { method: 'GET', path: '/api/version', ...o });
  if (!res.ok) return res;
  const v = (res.value as { version?: unknown } | null)?.version;
  return typeof v === 'string' && /^[0-9A-Za-z._+-]{1,32}$/.test(v) ? { ok: true, value: v } : { ok: false, kind: 'bad_json' };
}

/** The installed model names. */
export async function tags(target: Ok, o: Bounds): Promise<ClientResult<string[]>> {
  const res = await requestJson(target, { method: 'GET', path: '/api/tags', ...o });
  if (!res.ok) return res;
  const list = (res.value as { models?: unknown } | null)?.models;
  if (!Array.isArray(list)) return { ok: false, kind: 'bad_json' };
  const names = list.map((m) => (m as { name?: unknown; model?: unknown } | null)?.name ?? (m as { model?: unknown } | null)?.model)
    .filter((n): n is string => typeof n === 'string' && /^[A-Za-z0-9._:/@-]{1,128}$/.test(n));
  return { ok: true, value: [...new Set(names)] };
}

/** Whether one model reports tool support: its `capabilities` list, else (an older server) a template that names `.Tools`. */
export async function supportsTools(target: Ok, model: string, o: Bounds): Promise<ClientResult<boolean>> {
  const res = await requestJson(target, { method: 'POST', path: '/api/show', body: { model }, ...o });
  if (!res.ok) return res;
  const j = res.value as { capabilities?: unknown; template?: unknown } | null;
  if (Array.isArray(j?.capabilities)) return { ok: true, value: j.capabilities.includes('tools') };
  return { ok: true, value: typeof j?.template === 'string' && j.template.includes('.Tools') };
}
