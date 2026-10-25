/**
 * The engine's stream-json output, translated to the neutral `RuntimeEvent`s (B2b Task 13). One JSON object per line:
 *
 * - `system/init`: remembered (the Nexus MCP server must be `connected`; the model and the engine's own session id are
 *   never passed on). `system/api_retry`: counted.
 * - `assistant`: each text block is a `message.delta`; each new `tool_use` is a `tool.started` and one more tool call;
 *   the message's `usage` becomes a monotonic cumulative `usage` event. One model response is printed once per content
 *   block with the same message id, so usage is kept per message id (the largest value seen) and summed.
 * - `user`: each `tool_result` is a `tool.completed` (its size in bytes, never its content).
 * - `result`: the final usage (the engine's own cost, in cents rounded up; no cost means `costUsdCents: null` and
 *   `estimated: true`, charged at the cap by main) and then exactly one terminal event.
 *
 * A line longer than 1 MiB fails the turn with `protocol` (F25). A line that is not JSON, or an unknown type, is
 * ignored. `runRef` is a Nexus id made here, never the engine's own session id. No free text of a failure is copied
 * from the engine: the message is built from its fixed `subtype` and `terminal_reason` words.
 */
import { randomBytes } from 'node:crypto';
import type { AgentUsage, RuntimeEvent } from '../../../shared/nexus/runtime';

export const STREAM_LINE_MAX_BYTES = 1024 * 1024;
const ARGS_SUMMARY_MAX = 200;
const REF_RE = /[^A-Za-z0-9_.:-]/g;

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** A 26-character Nexus-style id (10 time characters, 16 random). */
export function newRunRef(at: number = Date.now()): string {
  let t = Math.max(0, Math.floor(at));
  let time = '';
  for (let i = 0; i < 10; i++) { time = ALPHABET[t % 32] + time; t = Math.floor(t / 32); }
  const bytes = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += ALPHABET[bytes[i] & 31];
  return time + rand;
}

const ref = (s: unknown): string => String(s ?? '').replace(REF_RE, '_').slice(0, 128) || 'unknown';
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0);

/** A short, content-free description of a tool call: a file tool names its path, others a bounded JSON of the input. */
export function summarizeToolInput(tool: string, input: unknown): string {
  if (isObj(input)) {
    const file = typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : null;
    if (file && (tool === 'Read' || tool === 'Edit' || tool === 'Write')) return file.slice(0, ARGS_SUMMARY_MAX);
    if ((tool === 'Grep' || tool === 'Glob') && typeof input.pattern === 'string') return input.pattern.slice(0, ARGS_SUMMARY_MAX);
  }
  try { return (JSON.stringify(input ?? {}) ?? '').slice(0, ARGS_SUMMARY_MAX); } catch { return ''; }
}

interface MsgUsage { input: number; output: number; cacheCreation: number; cacheRead: number }

/** The bytes of a tool_result's content (a string, or text blocks). */
function resultBytes(content: unknown): number {
  if (typeof content === 'string') return Buffer.byteLength(content, 'utf8');
  if (Array.isArray(content)) {
    let n = 0;
    for (const b of content) if (isObj(b) && typeof b.text === 'string') n += Buffer.byteLength(b.text, 'utf8');
    return n;
  }
  return 0;
}

export class StreamTranslator {
  private buf = '';
  private ended = false;
  private readonly perMessage = new Map<string, MsgUsage>();
  private readonly seenTools = new Set<string>();
  private lastEmitted = '';
  private toolCalls = 0;
  private lastAssistantError: string | null = null;
  /** `system/init` was seen. */
  sawInit = false;
  /** The Nexus MCP server's status in `system/init` (null before init or when not listed). */
  mcpStatus: string | null = null;
  /** `system/api_retry` events seen, and the last one's HTTP status. */
  retries = 0;
  lastRetryStatus: number | null = null;

  constructor(private readonly o: { mcpServerName: string; now?: () => number }) {}

  get done(): boolean { return this.ended; }
  get toolCallCount(): number { return this.toolCalls; }

  /** The cumulative usage so far (cost unknown until the result). */
  usage(): AgentUsage {
    let input = 0; let output = 0; let cc = 0; let cr = 0;
    for (const u of this.perMessage.values()) { input += u.input; output += u.output; cc += u.cacheCreation; cr += u.cacheRead; }
    return { inputTokens: input, outputTokens: output, cacheCreationTokens: cc, cacheReadTokens: cr, costUsdCents: null, toolCalls: this.toolCalls, estimated: true };
  }

  private now(): number { return (this.o.now ?? Date.now)(); }

  private fail(code: 'runtime_error' | 'auth' | 'limit' | 'protocol', message: string): RuntimeEvent {
    this.ended = true;
    return { t: 'run.failed', at: this.now(), code, message };
  }

  /** Feeds a chunk of stdout; returns the events it completes. After a terminal event nothing more is returned. */
  feed(chunk: string): RuntimeEvent[] {
    if (this.ended) return [];
    this.buf += chunk;
    const out: RuntimeEvent[] = [];
    for (;;) {
      const nl = this.buf.indexOf('\n');
      if (nl < 0) break;
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (this.tooLong(line)) { out.push(this.fail('protocol', 'a stream line was over 1 MiB')); this.buf = ''; return out; }
      this.line(line, out);
      if (this.ended) { this.buf = ''; return out; }
    }
    if (this.tooLong(this.buf)) { this.buf = ''; out.push(this.fail('protocol', 'a stream line was over 1 MiB')); }
    return out;
  }

  /** The stream ended: a last line without a newline is still read. */
  flush(): RuntimeEvent[] {
    if (this.ended) return [];
    const out: RuntimeEvent[] = [];
    const rest = this.buf; this.buf = '';
    if (rest.trim()) {
      if (this.tooLong(rest)) out.push(this.fail('protocol', 'a stream line was over 1 MiB'));
      else this.line(rest, out);
    }
    return out;
  }

  private tooLong(s: string): boolean {
    return s.length > STREAM_LINE_MAX_BYTES / 3 && Buffer.byteLength(s, 'utf8') > STREAM_LINE_MAX_BYTES;
  }

  private line(raw: string, out: RuntimeEvent[]): void {
    const t = raw.trim();
    if (!t) return;
    let msg: unknown;
    try { msg = JSON.parse(t); } catch { return; }
    if (!isObj(msg)) return;
    switch (msg.type) {
      case 'system': this.system(msg); return;
      case 'assistant': this.assistant(msg, out); return;
      case 'user': this.user(msg, out); return;
      case 'result': this.result(msg, out); return;
      default: return;
    }
  }

  private system(msg: Record<string, unknown>): void {
    if (msg.subtype === 'init') {
      this.sawInit = true;
      const servers = Array.isArray(msg.mcp_servers) ? msg.mcp_servers : [];
      const mine = servers.find((s) => isObj(s) && s.name === this.o.mcpServerName);
      this.mcpStatus = isObj(mine) && typeof mine.status === 'string' ? mine.status : null;
    } else if (msg.subtype === 'api_retry') {
      this.retries++;
      this.lastRetryStatus = typeof msg.error_status === 'number' ? msg.error_status : null;
    }
  }

  private assistant(msg: Record<string, unknown>, out: RuntimeEvent[]): void {
    if (msg.parent_tool_use_id) return; // a subagent's turn: none is allowed to run, and none is relayed
    const m = msg.message;
    if (!isObj(m)) return;
    if (typeof msg.error === 'string') this.lastAssistantError = msg.error;
    const content = Array.isArray(m.content) ? m.content : [];
    for (const b of content) {
      if (!isObj(b)) continue;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.length > 0) out.push({ t: 'message.delta', text: b.text });
      else if (b.type === 'tool_use' && typeof b.id === 'string' && !this.seenTools.has(b.id)) {
        this.seenTools.add(b.id);
        this.toolCalls++;
        const tool = ref(b.name);
        out.push({ t: 'tool.started', callId: ref(b.id), tool, argsSummary: summarizeToolInput(tool, b.input) });
      }
    }
    if (isObj(m.usage)) {
      const id = typeof m.id === 'string' ? m.id : `anon-${this.perMessage.size}`;
      const u = m.usage;
      const prev = this.perMessage.get(id) ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
      this.perMessage.set(id, {
        input: Math.max(prev.input, num(u.input_tokens)), output: Math.max(prev.output, num(u.output_tokens)),
        cacheCreation: Math.max(prev.cacheCreation, num(u.cache_creation_input_tokens)), cacheRead: Math.max(prev.cacheRead, num(u.cache_read_input_tokens))
      });
    }
    this.emitUsage(out);
  }

  private emitUsage(out: RuntimeEvent[]): void {
    const u = this.usage();
    const key = `${u.inputTokens}/${u.outputTokens}/${u.cacheCreationTokens}/${u.cacheReadTokens}/${u.toolCalls}`;
    if (key === this.lastEmitted) return;
    this.lastEmitted = key;
    out.push({ t: 'usage', ...u });
  }

  private user(msg: Record<string, unknown>, out: RuntimeEvent[]): void {
    if (msg.parent_tool_use_id) return;
    const m = msg.message;
    if (!isObj(m) || !Array.isArray(m.content)) return;
    for (const b of m.content) {
      if (isObj(b) && b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        out.push({ t: 'tool.completed', callId: ref(b.tool_use_id), ok: b.is_error !== true, resultBytes: resultBytes(b.content) });
      }
    }
  }

  private result(msg: Record<string, unknown>, out: RuntimeEvent[]): void {
    // The engine's own totals are the authority for tokens (assistant lines under-report output while streaming).
    if (isObj(msg.usage)) {
      const u = msg.usage;
      const mine = this.usage();
      const final: MsgUsage = {
        input: Math.max(mine.inputTokens, num(u.input_tokens)), output: Math.max(mine.outputTokens, num(u.output_tokens)),
        cacheCreation: Math.max(mine.cacheCreationTokens, num(u.cache_creation_input_tokens)), cacheRead: Math.max(mine.cacheReadTokens, num(u.cache_read_input_tokens))
      };
      this.perMessage.set('__result__', { input: final.input - mine.inputTokens, output: final.output - mine.outputTokens,
        cacheCreation: final.cacheCreation - mine.cacheCreationTokens, cacheRead: final.cacheRead - mine.cacheReadTokens });
    }
    const cost = typeof msg.total_cost_usd === 'number' && Number.isFinite(msg.total_cost_usd) && msg.total_cost_usd >= 0
      ? Math.ceil(msg.total_cost_usd * 100 - 1e-9) : null;
    out.push({ t: 'usage', ...this.usage(), costUsdCents: cost, estimated: cost === null });
    const subtype = typeof msg.subtype === 'string' ? msg.subtype.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) : 'unknown';
    const terminal = typeof msg.terminal_reason === 'string' ? msg.terminal_reason.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) : '';
    if (msg.is_error !== true && subtype === 'success') {
      this.ended = true;
      out.push({ t: 'run.completed', at: this.now(), stopReason: typeof msg.stop_reason === 'string' && msg.stop_reason ? msg.stop_reason.slice(0, 64) : 'end_turn' });
      return;
    }
    const status = typeof msg.api_error_status === 'number' ? msg.api_error_status : this.lastRetryStatus;
    const authErr = status === 401 || status === 403 || this.lastAssistantError === 'authentication_failed';
    const limit = subtype === 'error_max_budget_usd' || subtype === 'error_max_turns' || subtype === 'error_max_tokens';
    const code = authErr ? 'auth' : limit ? 'limit' : 'runtime_error';
    out.push(this.fail(code, `the engine ended the turn: ${subtype}${terminal ? ` (${terminal})` : ''}${status ? `, status ${status}` : ''}`));
  }
}
