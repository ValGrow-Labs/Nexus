/**
 * The hosted-model runtime's chat client: one chat-completions call per model turn (messages, tools, tool_calls,
 * usage; no streaming), made through transport.ts, with the free tier's reality handled here (ruling H4):
 *
 * - 429 and 5xx are retried with a bounded backoff that honours the provider's `Retry-After` (seconds or a date) and is counted against
 *   the turn's wall clock: a wait that would not fit ends the turn `limit` instead of sleeping past it. A 429 that says the daily quota
 *   is gone ends it `limit` with its own sentence at once; one that does not clear in time ends it `limit` with the rate sentence;
 * - 401 and 403 end the turn `auth` (the key was rejected); 404, and the provider's own "model not found" codes, say the model is
 *   unavailable; a refusal of a tool call the model could not format is retried (twice), then handed to the loop as an empty reply so
 *   its own nudges apply;
 * - a context that is too long (400 or 413) is trimmed in the turn's own history (old tool output dropped, then the oldest steps) and
 *   retried ONCE; a second time it ends the turn with a fixed sentence.
 *
 * Usage comes from the provider's own `usage` counts; the cost is 0 (a free tier) and never estimated. The key is the value of the
 * preset's one auth header and appears nowhere else: not in the body, the URL, a log line or a failure. A failure is a fixed sentence
 * (messages.ts); a provider's body is read only to classify it and is never kept.
 */
import type { ChatMessage, ChatReply, ChatTool } from '../localModel/client';
import { clip, compact, type ChatFn, type LoopChatArgs, type LoopChatResult } from '../localModel/loop';
import { MSG } from './messages';
import type { ProviderPreset } from './presets';
import { postJson, type HostedTestSeam } from './transport';

export interface Backoff {
  /** The first retry's wait when the provider gave none; doubled each time. */
  baseMs: number;
  /** The longest single wait honoured; a longer `Retry-After` ends the turn instead. */
  maxWaitMs: number;
  /** Retries of a 429 and of a 5xx answer (each counted per call). */
  max429: number;
  max5xx: number;
  /** Immediate retries of a tool call the provider could not parse. */
  maxBadGeneration: number;
}
export const DEFAULT_BACKOFF: Readonly<Backoff> = Object.freeze({ baseMs: 1000, maxWaitMs: 60_000, max429: 4, max5xx: 3, maxBadGeneration: 2 });

export interface HostedChatOptions {
  preset: ProviderPreset;
  model: string;
  apiKey: string;
  /** The turn's host egress proxy URL, read at each call (null when it is gone). */
  proxyUrl: () => string | null;
  numPredict: number;
  temperature: number;
  backoff: Backoff;
  /** The history's size budget in the loop's own unit (a context size); the trim after a "too long" answer goes well under it. */
  numCtx: number;
  /** TEST SEAMS: the wait (default: a timer that the turn's signal ends) and the connection layer. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  seam?: HostedTestSeam;
  log?: (line: string) => void;
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal.aborted) { resolve(); return; }
  const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, Math.max(0, ms));
  const onAbort = (): void => { clearTimeout(t); resolve(); };
  signal.addEventListener('abort', onAbort, { once: true });
});

// ---------------------------------------------------------------- the wire shape

type WireToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
type WireMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: WireToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string; name?: string };

const NOTE_NOT_RUN = '(this call was not run)';

/**
 * The loop's history (arguments as objects, tool results by order) as the wire wants it: call ids on the assistant's calls and on each
 * result that follows (in order), arguments as JSON text, and a result for every call (one that never got an answer says so).
 */
export function toWireMessages(messages: readonly ChatMessage[], quirks: ProviderPreset['quirks']): WireMessage[] {
  const out: WireMessage[] = [];
  let pending: { id: string; name: string }[] = [];
  let n = 0;
  const flush = (): void => {
    for (const p of pending) out.push({ role: 'tool', tool_call_id: p.id, content: NOTE_NOT_RUN, ...(quirks.toolMessageName ? { name: p.name } : {}) });
    pending = [];
  };
  for (const m of messages) {
    if (m.role === 'tool') {
      const p = pending.shift();
      if (!p) continue; // a result with no call before it cannot be sent
      out.push({ role: 'tool', tool_call_id: p.id, content: m.content, ...(quirks.toolMessageName ? { name: p.name } : {}) });
      continue;
    }
    flush();
    if (m.role === 'assistant') {
      const calls: WireToolCall[] = (m.tool_calls ?? []).map((c) => {
        const id = `call_${++n}`;
        pending.push({ id, name: c.function.name });
        return { id, type: 'function', function: { name: c.function.name, arguments: JSON.stringify(c.function.arguments ?? {}) } };
      });
      out.push({ role: 'assistant', content: m.content, ...(calls.length > 0 ? { tool_calls: calls } : {}) });
    } else out.push({ role: m.role, content: m.content });
  }
  flush();
  return out;
}

function strip(schema: unknown, keys: readonly string[]): unknown {
  if (Array.isArray(schema)) return schema.map((x) => strip(x, keys));
  if (typeof schema !== 'object' || schema === null) return schema;
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) if (!keys.includes(k)) o[k] = strip(v, keys);
  return o;
}

export function buildBody(o: Pick<HostedChatOptions, 'preset' | 'model' | 'numPredict' | 'temperature'>, messages: readonly ChatMessage[], tools: readonly ChatTool[]): string {
  const keys = o.preset.quirks.stripSchemaKeys ?? [];
  const wireTools = tools.map((t) => ({ type: 'function', function: { name: t.function.name, description: t.function.description,
    parameters: keys.length > 0 ? strip(t.function.parameters, keys) : t.function.parameters } }));
  return JSON.stringify({
    model: o.model, messages: toWireMessages(messages, o.preset.quirks), ...(wireTools.length > 0 ? { tools: wireTools, tool_choice: 'auto' } : {}),
    temperature: o.temperature, max_tokens: o.numPredict, stream: false
  });
}

const asCount = (x: unknown): number => (typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : 0);

/** The reply's text, tool calls and token counts (the provider's own `usage`), or null when it is not a chat reply. */
export function parseWireReply(text: string): ChatReply | null {
  let j: unknown;
  try { j = JSON.parse(text); } catch { return null; }
  if (typeof j !== 'object' || j === null) return null;
  const root = j as { choices?: unknown; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
  const choice = Array.isArray(root.choices) ? root.choices[0] as { message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown } | undefined : undefined;
  const m = choice?.message;
  if (typeof m !== 'object' || m === null) return null;
  const calls = Array.isArray(m.tool_calls) ? m.tool_calls as { function?: { name?: unknown; arguments?: unknown } }[] : [];
  return {
    content: typeof m.content === 'string' ? m.content : '',
    toolCalls: calls.map((c) => ({ name: c?.function?.name, arguments: c?.function?.arguments })),
    inputTokens: asCount(root.usage?.prompt_tokens), outputTokens: asCount(root.usage?.completion_tokens),
    doneReason: choice?.finish_reason === 'length' ? 'length' : (typeof choice?.finish_reason === 'string' ? choice.finish_reason.slice(0, 32) : '')
  };
}

// ---------------------------------------------------------------- classifying an error answer

export type ErrorKind = 'auth' | 'model_missing' | 'too_long' | 'bad_generation' | 'quota' | 'rate' | 'transient' | 'refused' | 'other';

const QUOTA_RE = /per ?day|daily|requests per day|tokens per day|\bRPD\b|\bTPD\b|insufficient_quota/i;
const TOO_LONG_RE = /context[_ ]length|maximum context|too long|too many tokens|reduce the length|request too large|token limit|input token count/i;

/** The kind of an error answer, from its status and (only to classify) its body. The body is never kept. */
export function classify(status: number, bodyText: string, quirks: ProviderPreset['quirks']): ErrorKind {
  if (status === 401 || status === 403) return 'auth';
  let code = '';
  try {
    const e = (JSON.parse(bodyText) as { error?: { code?: unknown; type?: unknown; status?: unknown } } | null)?.error;
    code = [e?.code, e?.type, e?.status].filter((x): x is string => typeof x === 'string').join(' ').toLowerCase();
  } catch { code = ''; }
  const missing = quirks.modelMissingCodes ?? [];
  if (status === 404 || missing.some((c) => code.includes(c))) return 'model_missing';
  if (status === 429) return QUOTA_RE.test(bodyText) ? 'quota' : 'rate';
  if (status === 413) return 'too_long';
  if (status === 400) {
    if (quirks.badGenerationCode && code.includes(quirks.badGenerationCode)) return 'bad_generation';
    if (TOO_LONG_RE.test(bodyText) || code.includes('context_length')) return 'too_long';
    return 'refused';
  }
  if (status === 408 || status === 409 || status >= 500) return 'transient';
  return 'other';
}

/** The provider's short error label (its `code`, `type` and `status` words) for the local log only, or ''. Only plain label characters
 *  are kept (letters, digits, underscore, dot, dash, space), so no sentence, prompt text or key can pass through. */
export function errorLabel(bodyText: string): string {
  try {
    const e = (JSON.parse(bodyText) as { error?: { code?: unknown; type?: unknown; status?: unknown } } | null)?.error;
    return [e?.code, e?.type, e?.status].filter((x): x is string => typeof x === 'string' && /^[A-Za-z0-9_. -]{1,40}$/.test(x)).join(' ').toLowerCase();
  } catch { return ''; }
}

/** `Retry-After` as milliseconds (seconds, possibly fractional, or an HTTP date), or null. */
export function retryAfterMs(h: string | string[] | undefined, nowMs: number): number | null {
  const v = Array.isArray(h) ? h[0] : h;
  if (typeof v !== 'string' || v.trim() === '') return null;
  const s = v.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.max(0, t - nowMs) : null;
}

// ---------------------------------------------------------------- trimming a history that is too long

/** Drops old tool output, then the oldest steps (never the system prompt or the task), in place. Returns whether anything changed. */
export function trimHistory(messages: ChatMessage[]): boolean {
  const before = messages.reduce((n, m) => n + m.content.length + (m.tool_calls ? 64 : 0), 0) + messages.length;
  for (let i = 2; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'tool' && m.content.length > 300) m.content = '[earlier output omitted to save space]';
    else if (m.role === 'assistant' && m.content.length > 600) m.content = clip(m.content, 600);
  }
  // Keep the system prompt, the task and the last six messages; the cut never leaves a tool result without its call.
  let k = messages.length - 6;
  while (k > 2 && messages[k].role === 'tool') k--;
  if (k > 2) messages.splice(2, k - 2, { role: 'user', content: '(earlier steps were removed to fit the model\'s limit; continue from the files in the project)' });
  const after = messages.reduce((n, m) => n + m.content.length + (m.tool_calls ? 64 : 0), 0) + messages.length;
  return after < before;
}

// ---------------------------------------------------------------- the call

const failure = (code: 'runtime_error' | 'auth' | 'limit', message: string): LoopChatResult => ({ ok: false, code, message });

/** The loop's `chatFn` for one turn: one provider, one model, one key. */
export function createChatFn(o: HostedChatOptions): ChatFn {
  const sleep = o.sleep ?? defaultSleep;
  const url = `https://${o.preset.host}${o.preset.basePath}/chat/completions`;
  const allowed = [{ host: o.preset.host, port: o.preset.port }];
  const auth = { [o.preset.authHeader]: `${o.preset.authPrefix}${o.apiKey}` };

  return async (a: LoopChatArgs): Promise<LoopChatResult> => {
    let n429 = 0; let n5xx = 0; let nBad = 0; let trimmed = false;
    for (;;) {
      if (a.signal.aborted) return failure('runtime_error', MSG.cancelled);
      const t = await postJson({ url, allowed, headers: auth, body: buildBody(o, a.messages, a.tools), proxyUrl: o.proxyUrl(),
        timeoutMs: a.timeoutMs, maxBytes: a.maxBytes, signal: a.signal, seam: o.seam });
      if (!t.ok) {
        switch (t.kind) {
          case 'aborted': return failure('runtime_error', MSG.cancelled);
          case 'timeout': return failure('runtime_error', MSG.timeout);
          case 'no_proxy': return failure('runtime_error', MSG.noProxy);
          case 'proxy_refused': return failure('runtime_error', MSG.proxyRefused);
          case 'tls_failed': return failure('runtime_error', MSG.tlsFailed);
          case 'too_large': return failure('runtime_error', MSG.tooLarge);
          case 'redirect': return failure('runtime_error', MSG.redirect);
          case 'bad_target': return failure('runtime_error', MSG.notGranted);
          default: return failure('runtime_error', MSG.unreachable);
        }
      }
      if (t.status >= 200 && t.status < 300) {
        const reply = parseWireReply(t.text);
        return reply ? { ok: true, value: reply } : failure('runtime_error', MSG.badJson);
      }
      const kind = classify(t.status, t.text, o.preset.quirks);
      switch (kind) {
        case 'auth': return failure('auth', MSG.keyRejected);
        case 'model_missing': return failure('runtime_error', MSG.modelUnavailable);
        case 'refused': {
          // The turn's message stays the one fixed sentence; the provider's short label goes to the local log so a refusal can be diagnosed.
          o.log?.(`hosted model: the provider refused a request (HTTP ${t.status}${errorLabel(t.text) ? `, ${errorLabel(t.text)}` : ''})`);
          return failure('runtime_error', MSG.refused);
        }
        case 'quota': return failure('limit', MSG.quotaExhausted);
        case 'too_long': {
          if (trimmed) return failure('runtime_error', MSG.contextTooLong);
          trimmed = true;
          // The loop's own compaction at a much smaller budget first, then the harder trim; the history itself shrinks, so later calls stay small.
          compact(a.messages, Math.max(1024, Math.floor(o.numCtx / 4)));
          trimHistory(a.messages);
          o.log?.('hosted model: the history was trimmed once after a too-long answer');
          continue;
        }
        case 'bad_generation': {
          if (nBad >= o.backoff.maxBadGeneration) return { ok: true, value: { content: '', toolCalls: [], inputTokens: 0, outputTokens: 0, doneReason: 'error' } };
          nBad++;
          continue;
        }
        case 'rate':
        case 'transient': {
          const is429 = kind === 'rate';
          const tries = is429 ? n429 : n5xx;
          if (tries >= (is429 ? o.backoff.max429 : o.backoff.max5xx)) return is429 ? failure('limit', MSG.rateLimited) : failure('runtime_error', MSG.server(t.status));
          const given = retryAfterMs(t.headers['retry-after'], a.now());
          const wait = given ?? Math.min(o.backoff.baseMs * 2 ** tries, o.backoff.maxWaitMs);
          // A wait the provider asks for that is longer than we honour, or that would not leave time to ask again, ends the turn: never sleep past the wall clock.
          if (wait > o.backoff.maxWaitMs || a.now() + wait >= a.deadline) return is429 ? failure('limit', MSG.rateLimited) : failure('runtime_error', MSG.server(t.status));
          if (is429) n429++; else n5xx++;
          await sleep(wait, a.signal);
          continue;
        }
        default: return failure('runtime_error', MSG.server(t.status));
      }
    }
  };
}
