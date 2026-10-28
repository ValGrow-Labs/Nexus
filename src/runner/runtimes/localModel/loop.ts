/**
 * The local-model runtime's tool loop: ask the model, run the tools it calls, give it the results, until it stops (a reply
 * with no tool call), a cap is hit, the turn is cancelled or something fails. One generator, no state outside it; the events
 * it yields are the turn's own and end with exactly one terminal event.
 *
 * Weak models are the normal case, so the loop is built to survive them without ever widening what they may do:
 * - a call with a near-miss name or string-typed arguments is repaired (toolCalls.ts); a call written as JSON in the text of a
 *   reply is run as the call it means; the result carries a note asking for the real interface next time;
 * - a malformed call (arguments that are not an object), an unknown tool and an empty reply each get a corrective message
 *   (a tool result or a user nudge) and count as a strike: four in a row, or twelve in a turn, end the turn `protocol`;
 * - an exact call (same tool, same arguments) that failed three times is not run again (the model is told so); a fifth failure,
 *   or six identical calls back to back, end the turn `protocol`: nothing loops for ever;
 * - a reply that only talks, before any tool was used, or after files were written but before the change was registered, and an
 *   empty reply, are nudged (at most twice each) rather than taken as the end of the work; a third empty reply fails a turn that
 *   used no tool and ends one that did.
 *
 * Caps, all enforced here: wall clock (the caller's signal), model calls (`limits.maxTurns`), tool calls (at most 200, and
 * the turn's own cap), tokens (the server's own counts, cumulative); each ends the turn `failed: limit`. Usage is cumulative,
 * its cost is 0 and never estimated: a local model costs nothing and the token counts are the server's. Nothing of a file's
 * content, the bearer or a server's error text is ever put in an event.
 */
import type { RunRequest, RuntimeEvent } from '../../../shared/nexus/runtime';
import { chat, type ChatMessage, type ChatTool, type ClientFailure } from './client';
import type { Target } from './endpoint';
import { FILE_TOOL_NAMES, type FileTools } from './fileTools';
import { McpClient, redactToken } from './mcpClient';
import { NOTE_TEXT_CALL, NUDGE_EMPTY, NUDGE_NO_TOOLS, NUDGE_REGISTER } from './prompt';
import { canonicalToolName, coerceArgs, coerceBySchema, recoverTextCalls } from './toolCalls';

/** The most tool calls any turn may make, whatever its cap says. */
export const MAX_TOOL_CALLS = 200;
const MAX_CONSECUTIVE_STRIKES = 4;
const MAX_TOTAL_STRIKES = 12;
const REPEAT_FAIL_NOTICE = 3;
const REPEAT_FAIL_ABORT = 5;
const REPEAT_SAME_ABORT = 6;
const MAX_CALLS_PER_REPLY = 8;
const MAX_NUDGES = 2;
const DELTA_MAX_BYTES_PER_TURN = 256 * 1024;
const REF_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface LoopTuning {
  numCtx: number;
  numPredict: number;
  chatTimeoutMs: number;
  chatMaxBytes: number;
  /** The most characters of one tool result given back to the model (a longer one keeps its start and its end). */
  toolResultMaxChars: number;
}
export const DEFAULT_TUNING: Readonly<LoopTuning> = Object.freeze({
  numCtx: 16384, numPredict: 4096, chatTimeoutMs: 15 * 60_000, chatMaxBytes: 4 * 1024 * 1024, toolResultMaxChars: 16_000
});

export interface LoopDeps {
  req: RunRequest;
  /** Aborted by a cancel or by the wall clock; `endedBy` says which. */
  signal: AbortSignal;
  endedBy: () => 'wall' | 'cancel' | null;
  target: Extract<Target, { ok: true }>;
  model: string;
  messages: ChatMessage[];
  /** What the model is offered: the file tools and the runner's. */
  tools: readonly ChatTool[];
  /** The runner's tools, by name, with their argument schemas (the file tools are not here). */
  mcpSchemas: ReadonlyMap<string, unknown>;
  files: FileTools;
  mcp: McpClient | null;
  token: string;
  caps: { turnTokens?: number; toolCalls?: number };
  tuning: LoopTuning;
  now: () => number;
  /** The wall clock's end, in `now()` time. */
  deadline: number;
}

const wellFormed = (s: string): string => { const f = (s as unknown as { toWellFormed?: () => string }).toWellFormed; return typeof f === 'function' ? f.call(s) : s; };

/** Keeps the start and the end of a long text (a test run's verdict is at its end). */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.4);
  const tail = max - head;
  return `${text.slice(0, head)}\n...[${text.length - max} characters omitted]...\n${text.slice(text.length - tail)}`;
}

function failMessage(kind: ClientFailure, status?: number): string {
  switch (kind) {
    case 'unreachable': return 'the local model server could not be reached';
    case 'timeout': return 'the local model server did not answer in time';
    case 'too_large': return 'the local model server answered with more than the allowed size';
    case 'redirect': return 'the local model server answered with a redirect, which is refused';
    case 'bad_json': return 'the local model server sent an answer that could not be read';
    case 'status':
      if (status === 404) return 'the chosen model is not installed on the local model server';
      if (status === 400) return 'the local model server refused the request (the model may not support tool calls)';
      return `the local model server reported an error (HTTP ${typeof status === 'number' ? status : 0})`;
    default: return 'the local model server request was cancelled';
  }
}

/** Older tool output is dropped, newest kept, when the history would not fit the context window. */
function compact(messages: ChatMessage[], numCtx: number): void {
  const budget = Math.floor(numCtx * 3 * 0.6);
  const size = (): number => messages.reduce((n, m) => n + m.content.length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0);
  if (size() <= budget) return;
  for (let i = 2; i < messages.length - 6 && size() > budget; i++) {
    const m = messages[i];
    if (m.role === 'tool' && m.content.length > 200) m.content = '[earlier output omitted to save space]';
  }
}

const fixedEvent = (s: string): string => (REF_RE.test(s) ? s : 'unknown_tool');

export async function* runLoop(d: LoopDeps): AsyncGenerator<RuntimeEvent> {
  const at = (): number => d.now();
  const maxToolCalls = Math.min(MAX_TOOL_CALLS, d.caps.toolCalls ?? MAX_TOOL_CALLS);
  const maxModelCalls = Math.max(1, d.req.limits.maxTurns);
  const known = [...FILE_TOOL_NAMES, ...d.mcpSchemas.keys()];
  const hasChangeset = d.mcpSchemas.has('changeset_register');
  const usage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, toolCalls: 0 };
  const usageEvent = (): RuntimeEvent => ({ t: 'usage', ...usage, costUsdCents: 0, estimated: false });
  const failed = (code: 'runtime_error' | 'limit' | 'protocol', message: string): RuntimeEvent => ({ t: 'run.failed', at: at(), code, message });
  const ended = (): RuntimeEvent | null => {
    const why = d.endedBy();
    if (why === 'wall') return failed('limit', 'the turn ran past its wall clock');
    if (why === 'cancel' || d.signal.aborted) return { t: 'run.cancelled', at: at() };
    return null;
  };

  let modelCalls = 0;
  let strikes = 0;
  let totalStrikes = 0;
  let nudgesNoTool = 0;
  let nudgesRegister = 0;
  let nudgesEmpty = 0;
  let wroteFiles = false;
  let registered = false;
  let deltaBytes = 0;
  let lastKey = '';
  let sameRun = 0;
  const fails = new Map<string, number>();

  for (;;) {
    const stop = ended();
    if (stop) { yield usageEvent(); yield stop; return; }
    if (modelCalls >= maxModelCalls) { yield usageEvent(); yield failed('limit', 'the turn went over its model-call limit'); return; }
    compact(d.messages, d.tuning.numCtx);
    const remaining = d.deadline - at();
    const r = await chat(d.target, { model: d.model, messages: d.messages, tools: [...d.tools], numCtx: d.tuning.numCtx, numPredict: d.tuning.numPredict },
      { timeoutMs: Math.min(d.tuning.chatTimeoutMs, Math.max(1000, remaining + 1000)), maxBytes: d.tuning.chatMaxBytes, signal: d.signal });
    modelCalls++;
    if (!r.ok) {
      const stopped = ended();
      yield usageEvent();
      yield stopped ?? failed('runtime_error', failMessage(r.kind, r.status));
      return;
    }
    const reply = r.value;
    usage.inputTokens += reply.inputTokens;
    usage.outputTokens += reply.outputTokens;
    yield usageEvent();
    if (typeof d.caps.turnTokens === 'number' && usage.inputTokens + usage.outputTokens > d.caps.turnTokens) {
      yield failed('limit', 'the turn went over its token cap');
      return;
    }

    // The reply's calls: the server's own, else the ones written as JSON in the text.
    let text = wellFormed(redactToken(reply.content, d.token));
    let calls: { name: unknown; arguments: unknown }[] = reply.toolCalls;
    let fromText = false;
    if (calls.length === 0 && text.trim().length > 0) {
      const rec = recoverTextCalls(text, known);
      if (rec) { calls = rec.map((c) => ({ name: c.name, arguments: c.args })); text = ''; fromText = true; }
    }
    if (text.trim().length > 0 && deltaBytes < DELTA_MAX_BYTES_PER_TURN) {
      const t = text.length > 8192 ? `${text.slice(0, 8192)}...` : text;
      deltaBytes += Buffer.byteLength(t, 'utf8');
      yield { t: 'message.delta', text: t };
    }

    // The assistant message goes back into the history with object arguments (the server needs them to be objects).
    const asObj = (a: unknown): Record<string, unknown> => { const c = coerceArgs(a); return c.ok ? c.args : {}; };
    const shaped = calls.slice(0, MAX_CALLS_PER_REPLY).map((c) => ({ function: { name: typeof c.name === 'string' ? c.name.slice(0, 128) : 'unknown', arguments: asObj(c.arguments) } }));
    d.messages.push({ role: 'assistant', content: text, ...(shaped.length > 0 ? { tool_calls: shaped } : {}) });

    if (calls.length === 0) {
      let nudge: string | null = null;
      if (text.trim().length === 0) {
        // An empty reply is nudged twice; after that it ends the turn when work was done, and fails it when none was.
        if (nudgesEmpty < MAX_NUDGES) { nudge = NUDGE_EMPTY; nudgesEmpty++; }
        else if (usage.toolCalls === 0) { yield usageEvent(); yield failed('protocol', 'the model did not produce usable tool calls'); return; }
      } else if (usage.toolCalls === 0 && nudgesNoTool < MAX_NUDGES) { nudge = NUDGE_NO_TOOLS; nudgesNoTool++; }
      else if (hasChangeset && wroteFiles && !registered && nudgesRegister < MAX_NUDGES) { nudge = NUDGE_REGISTER; nudgesRegister++; }
      if (nudge === null) { yield usageEvent(); yield { t: 'run.completed', at: at(), stopReason: reply.doneReason === 'length' ? 'max_tokens' : 'end_turn' }; return; }
      d.messages.push({ role: 'user', content: nudge });
      continue;
    }

    for (let i = 0; i < calls.length; i++) {
      const stop2 = ended();
      if (stop2) { yield usageEvent(); yield stop2; return; }
      const raw = calls[i];
      usage.toolCalls++;
      if (usage.toolCalls > maxToolCalls) { yield usageEvent(); yield failed('limit', 'the turn went over its tool-call cap'); return; }
      const callId = String(usage.toolCalls);
      const toolMsg = (content: string): void => { d.messages.push({ role: 'tool', content, ...(typeof raw.name === 'string' ? { tool_name: raw.name.slice(0, 128) } : {}) }); };

      // Too many calls in one reply: the extras are answered, not run.
      if (i >= MAX_CALLS_PER_REPLY) {
        yield { t: 'tool.started', callId, tool: 'unknown_tool', argsSummary: '' };
        yield { t: 'tool.completed', callId, ok: false, resultBytes: 0 };
        continue;
      }

      const name = canonicalToolName(raw.name, known);
      if (name === null) {
        const shown = typeof raw.name === 'string' ? raw.name.slice(0, 64) : '';
        yield { t: 'tool.started', callId, tool: fixedEvent(shown), argsSummary: '' };
        yield { t: 'tool.completed', callId, ok: false, resultBytes: 0 };
        toolMsg(`ERROR: there is no tool named "${shown.replace(/[^\x20-\x7e]/g, '?')}". The tools are: ${known.join(', ')}.`);
        if (++strikes > MAX_CONSECUTIVE_STRIKES || ++totalStrikes > MAX_TOTAL_STRIKES) { yield usageEvent(); yield failed('protocol', 'the model did not produce usable tool calls'); return; }
        continue;
      }
      const a = coerceArgs(raw.arguments);
      if (!a.ok) {
        yield { t: 'tool.started', callId, tool: name, argsSummary: '' };
        yield { t: 'tool.completed', callId, ok: false, resultBytes: 0 };
        toolMsg(`ERROR: the arguments of ${name} must be a JSON object. Call it again with the right arguments.`);
        if (++strikes > MAX_CONSECUTIVE_STRIKES || ++totalStrikes > MAX_TOTAL_STRIKES) { yield usageEvent(); yield failed('protocol', 'the model did not produce usable tool calls'); return; }
        continue;
      }
      strikes = 0;
      const isFile = FILE_TOOL_NAMES.includes(name);
      const args = isFile ? a.args : coerceBySchema(a.args, d.mcpSchemas.get(name));
      const key = `${name}\0${JSON.stringify(args)}`;
      sameRun = key === lastKey ? sameRun + 1 : 1;
      lastKey = key;
      let summary: string;
      try { summary = isFile ? d.files.summarize(name, args) : JSON.stringify(args).slice(0, 200); } catch { summary = ''; }
      yield { t: 'tool.started', callId, tool: name, argsSummary: wellFormed(redactToken(summary, d.token)) };

      let ok: boolean; let content: string; let bytes: number;
      if ((fails.get(key) ?? 0) >= REPEAT_FAIL_NOTICE) {
        ok = false; bytes = 0;
        content = `ERROR: this exact call has already failed ${fails.get(key)} times. Do not repeat it: change the arguments or try another approach.`;
      } else if (isFile) {
        const fr = await d.files.run(name, args);
        ok = fr.ok; content = fr.text; bytes = Buffer.byteLength(fr.text, 'utf8');
        if (ok && (name === 'write_file' || name === 'delete_file')) wroteFiles = true;
      } else if (d.mcp) {
        const mr = await d.mcp.call(name, args, d.signal);
        ok = mr.ok; bytes = mr.bytes;
        content = clip(mr.text.length > 0 ? mr.text : (ok ? '(no output)' : 'ERROR: the tool failed'), d.tuning.toolResultMaxChars);
        if (ok && name === 'changeset_register') registered = true;
      } else {
        ok = false; bytes = 0; content = 'ERROR: the tool is not available';
      }
      if (!ok) fails.set(key, (fails.get(key) ?? 0) + 1);
      yield { t: 'tool.completed', callId, ok, resultBytes: bytes };
      const stop3 = ended();
      if (stop3) { yield usageEvent(); yield stop3; return; }
      toolMsg(`${ok || content.startsWith('ERROR') ? '' : 'ERROR: '}${content}${fromText && i === 0 ? `\n${NOTE_TEXT_CALL}` : ''}`);
      if ((fails.get(key) ?? 0) >= REPEAT_FAIL_ABORT) { yield usageEvent(); yield failed('protocol', 'the model kept repeating a failing tool call'); return; }
      if (sameRun >= REPEAT_SAME_ABORT) { yield usageEvent(); yield failed('protocol', 'the model kept repeating the same tool call'); return; }
    }
    yield usageEvent();
  }
}
