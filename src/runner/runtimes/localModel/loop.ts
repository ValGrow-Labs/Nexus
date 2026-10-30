/**
 * The local-model runtime's tool loop: ask the model, run the tools it calls, give it the results, until it stops (a reply
 * with no tool call), a cap is hit, the turn is cancelled or something fails. One generator, no state outside it; the events
 * it yields are the turn's own and end with exactly one terminal event. The model call is the one replaceable part (`chatFn`): the
 * hosted-model runtime (src/runner/runtimes/hostedModel/) runs this same loop over its own wire client.
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
import { chat, type ChatMessage, type ChatReply, type ChatTool, type ClientFailure } from './client';
import type { Target } from './endpoint';
import { FILE_TOOL_NAMES, checkRelPath, type FileTools } from './fileTools';
import { McpClient, redactToken } from './mcpClient';
import { HINT_FINISH, HINT_READ_FIX, HINT_RUN, NOTE_TEXT_CALL, NUDGE_BAD_CALL, NUDGE_EMPTY, NUDGE_FINISH, NUDGE_FORMAT, NUDGE_REGISTER, NUDGE_RUN, NUDGE_STUCK, NUDGE_TIME, hintFix, hintMissing, nudgeFix, nudgeGiveUp, nudgeMissing, nudgeNoTools } from './prompt';
import { canonicalToolName, coerceArgs, coerceBySchema, looksLikeCall, recoverTextCalls } from './toolCalls';

/** The most tool calls any turn may make, whatever its cap says. */
export const MAX_TOOL_CALLS = 200;
const MAX_CONSECUTIVE_STRIKES = 4;
const MAX_TOTAL_STRIKES = 12;
const REPEAT_FAIL_NOTICE = 3;
const REPEAT_FAIL_ABORT = 5;
const REPEAT_SAME_ABORT = 6;
const MAX_CALLS_PER_REPLY = 8;
const MAX_NUDGES = 2;
const TIME_MARGIN_MIN_MS = 4 * 60_000;
/** Every nudge of a turn together (each kind is also limited to MAX_NUDGES until the model makes progress). */
const MAX_NUDGES_TOTAL = 10;
const DELTA_MAX_BYTES_PER_TURN = 256 * 1024;
const REF_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface LoopTuning {
  numCtx: number;
  numPredict: number;
  chatTimeoutMs: number;
  chatMaxBytes: number;
  /** The most characters of one tool result given back to the model (a longer one keeps its start and its end). */
  toolResultMaxChars: number;
  /** The most characters of a command's output (each of stdout and stderr) given back to the model. */
  execOutputMaxChars: number;
}
export const DEFAULT_TUNING: Readonly<LoopTuning> = Object.freeze({
  numCtx: 16384, numPredict: 4096, chatTimeoutMs: 15 * 60_000, chatMaxBytes: 4 * 1024 * 1024, toolResultMaxChars: 6_000, execOutputMaxChars: 3_500
});

/**
 * What a model call is handed and gives back when the loop does not talk to a local server itself: the hosted-model runtime
 * supplies its own `chatFn` (its wire client, retries and error mapping) and the loop stays the same. A failure carries the run's
 * own failure code and a fixed sentence (never a server's text).
 */
export interface LoopChatArgs { messages: ChatMessage[]; tools: ChatTool[]; timeoutMs: number; maxBytes: number; signal: AbortSignal; deadline: number; now: () => number }
export type LoopChatResult = { ok: true; value: ChatReply } | { ok: false; code: 'runtime_error' | 'auth' | 'limit' | 'protocol'; message: string };
export type ChatFn = (a: LoopChatArgs) => Promise<LoopChatResult>;

export interface LoopDeps {
  req: RunRequest;
  /** Aborted by a cancel or by the wall clock; `endedBy` says which. */
  signal: AbortSignal;
  endedBy: () => 'wall' | 'cancel' | null;
  /** The local server's checked address (the default chat path); not needed with a `chatFn`. */
  target?: Extract<Target, { ok: true }>;
  /** Replaces the local server's chat call (the hosted-model runtime). */
  chatFn?: ChatFn;
  model: string;
  messages: ChatMessage[];
  /** What the model is offered: the file tools and the runner's. */
  tools: readonly ChatTool[];
  /** The runner's tools, by name, with their argument schemas (the file tools are not here). */
  mcpSchemas: ReadonlyMap<string, unknown>;
  files: FileTools;
  /** The files the task names that did not exist when it started: the turn is not done while one is unwritten. */
  taskFiles: readonly string[];
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

/** Lines of a test runner's output a small model gains nothing from (YAML fences, timings, bookkeeping counters, the runner's own stack frames). */
const NOISE_LINE_RES: readonly RegExp[] = [
  /^\s*(?:---|\.\.\.)\s*$/,
  /^\s*(?:duration_ms|failureType): .*$/,
  /^\s*type: 'suite'\s*$/,
  /^\s*code: 'ERR_TEST_FAILURE'\s*$/,
  /^# (?:suites|cancelled|skipped|todo|duration_ms) .*$/,
  /^\s*(?:async )?(?:Test|Suite|process|Module\w*|Object)\.\S+(?: \(.*\))?\s*$/,
  /^#?\s+at .*node:internal.*$/
];
/** What a FAILED run need not repeat: the passing tests and the TAP bookkeeping (the failing ones, with their errors, stay). */
const PASSING_LINE_RES: readonly RegExp[] = [/^\s*ok \d+ - .*$/, /^\s*# Subtest: .*$/, /^\s*\d+\.\.\d+\s*$/, /^TAP version \d+\s*$/, /^\s*(?:code|name|operator): '.*'\s*$/];
const isNoise = (l: string, failed: boolean): boolean => NOISE_LINE_RES.some((re) => re.test(l)) || (failed && PASSING_LINE_RES.some((re) => re.test(l)));

/**
 * A `sandbox_exec` result for a small model: the runner's answer is JSON (`{exit:{code}, stdout, stderr, truncated}`) whose output is
 * one long escaped string; it is given back as plain lines, test-runner noise dropped and each stream cut to what a small context
 * holds (start and end kept). `code` is the exit code, or null when the answer is not that shape (the text is then given as it is).
 */
export function renderExec(text: string, maxChars: number): { text: string; code: number | null; where: string | null; failing: string[] } {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return { text, code: null, where: null, failing: [] }; }
  if (typeof v !== 'object' || v === null) return { text, code: null, where: null, failing: [] };
  const o = v as { exit?: unknown; stdout?: unknown; stderr?: unknown; truncated?: unknown };
  const exit = typeof o.exit === 'number' ? o.exit : (typeof o.exit === 'object' && o.exit !== null ? (o.exit as { code?: unknown }).code : undefined);
  const code = typeof exit === 'number' && Number.isInteger(exit) ? exit : null;
  const failed = code !== null && code !== 0;
  const tidy = (x: unknown): string => (typeof x === 'string' ? x.split('\n').filter((l) => !isNoise(l, failed)).join('\n').trim() : '');
  const out = tidy(o.stdout); const err = tidy(o.stderr);
  const parts = [code === null ? 'The command did not finish normally.' : `exit code: ${code} (${code === 0 ? 'passed' : 'FAILED'})`];
  if (out) parts.push(`stdout:\n${clip(out, maxChars)}`);
  if (err) parts.push(`stderr:\n${clip(err, Math.floor(maxChars / 2))}`);
  if (o.truncated === true) parts.push('(the output was cut)');
  const all = `${tidy(o.stderr)}\n${tidy(o.stdout)}`;
  return { text: parts.join('\n'), code, where: failed ? failureLocation(all) : null, failing: failed ? failingTests(all) : [] };
}

/** The names of the failing tests a TAP run lists (`not ok 4 - name`), at most four, each cut short. */
export function failingTests(output: string): string[] {
  const names: string[] = [];
  for (const m of output.matchAll(/^\s*not ok \d+ - (.{1,200})$/gm)) {
    const n = m[1].trim().slice(0, 80);
    if (!names.includes(n)) names.push(n);
    if (names.length >= 4) break;
  }
  return names;
}

const LOCATION_RE = /\/workspace\/((?:[\w.@+-]+\/)*[\w.@+-]+\.(?:[cm]?[jt]sx?|py|rb|go|rs|java)):(\d{1,6})/g;

/**
 * Where a failed run says its error is: `path line N`, for a file of the project (the command runs with the project at /workspace; a source
 * file is preferred to a test file), or null. A small model otherwise "fixes" the file it wrote last, not the one that is wrong.
 */
export function failureLocation(output: string): string | null {
  let first: string | null = null;
  for (const m of output.matchAll(LOCATION_RE)) {
    if (m[1].startsWith('node_modules/') || m[1].includes('/node_modules/')) continue;
    const where = `${m[1]} line ${m[2]}`;
    // A source file beats a test file: the test only says what it expected.
    if (!/(?:^|\/)(?:tests?|__tests__|specs?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(m[1])) return where;
    first ??= where;
  }
  return first;
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
export function compact(messages: ChatMessage[], numCtx: number): void {
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
  const failed = (code: 'runtime_error' | 'auth' | 'limit' | 'protocol', message: string): RuntimeEvent => ({ t: 'run.failed', at: at(), code, message });
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
  let nudgesEmpty = 0;
  let wroteFiles = false;
  let registered = false;
  /** The last `sandbox_exec` verdict: none yet, passed (exit 0), failed, or ran with a result that was not read. */
  let lastRun: 'none' | 'pass' | 'fail' | 'unknown' = 'none';
  /** Where the last failed run put its first error (`src/a.js line 4`), when it said. */
  let lastWhere: string | null = null;
  let lastFailing: string[] = [];
  let gaveUp = false;
  let timeWarned = false;
  const wallMs = Math.max(1, d.deadline - at());
  const wrote = new Set<string>();
  const hasSandbox = d.mcpSchemas.has('sandbox_exec');
  const missingFiles = (): string[] => d.taskFiles.filter((f) => !wrote.has(f));
  /** Nudges given per kind since the model last made progress (a file written or a command run); all nudges together are capped too. */
  const nudgesByKind = new Map<string, number>();
  let nudgesTotal = 0;
  let deltaBytes = 0;
  let lastKey = '';
  let sameRun = 0;
  const fails = new Map<string, number>();

  for (;;) {
    const stop = ended();
    if (stop) { yield usageEvent(); yield stop; return; }
    if (modelCalls >= maxModelCalls) { yield usageEvent(); yield failed('limit', 'the turn went over its model-call limit'); return; }
    // Time is nearly up with work written and not registered: say so once, so the work is kept rather than lost to the wall clock.
    // One slow reply can take minutes, so the margin is the larger of four minutes and a fifth of the turn's wall clock, never more than half of it.
    if (!timeWarned && hasChangeset && wroteFiles && !registered && d.deadline - at() < Math.min(Math.max(TIME_MARGIN_MIN_MS, Math.floor(wallMs * 0.2)), Math.floor(wallMs * 0.5))) {
      timeWarned = true;
      d.messages.push({ role: 'user', content: `${NUDGE_TIME}${NUDGE_FORMAT}` });
    }
    compact(d.messages, d.tuning.numCtx);
    const remaining = d.deadline - at();
    const bounds = { timeoutMs: Math.min(d.tuning.chatTimeoutMs, Math.max(1000, remaining + 1000)), maxBytes: d.tuning.chatMaxBytes, signal: d.signal };
    let r: LoopChatResult;
    if (d.chatFn) r = await d.chatFn({ messages: d.messages, tools: [...d.tools], ...bounds, deadline: d.deadline, now: d.now });
    else {
      const lr = await chat(d.target!, { model: d.model, messages: d.messages, tools: [...d.tools], numCtx: d.tuning.numCtx, numPredict: d.tuning.numPredict }, bounds);
      r = lr.ok ? lr : { ok: false, code: 'runtime_error', message: failMessage(lr.kind, lr.status) };
    }
    modelCalls++;
    if (!r.ok) {
      const stopped = ended();
      yield usageEvent();
      yield stopped ?? failed(r.code, r.message);
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
      if (text.trim().length === 0 && nudgesEmpty >= MAX_NUDGES && usage.toolCalls === 0) { yield usageEvent(); yield failed('protocol', 'the model did not produce usable tool calls'); return; }
      if (nudgesTotal < MAX_NUDGES_TOTAL) {
        // What is left to do, said specifically: the files the task named, then the run, the fix, the registration. Each kind of nudge is
        // given at most MAX_NUDGES times (an empty reply and a text-only one before any tool have their own), and all together at most MAX_NUDGES_TOTAL.
        const missing = missingFiles();
        if (text.trim().length > 0 && looksLikeCall(text, known) && (nudgesByKind.get('badcall') ?? 0) < MAX_NUDGES) {
          nudge = NUDGE_BAD_CALL; nudgesByKind.set('badcall', (nudgesByKind.get('badcall') ?? 0) + 1);
        } else if (usage.toolCalls === 0) {
          if (text.trim().length === 0) { if (nudgesEmpty < MAX_NUDGES) { nudge = NUDGE_EMPTY; nudgesEmpty++; } }
          else if (nudgesNoTool < MAX_NUDGES) { nudge = nudgeNoTools(missing); nudgesNoTool++; }
        } else {
          let kind = '';
          if (registered) { /* the change is registered: nothing is left */ }
          else if (missing.length > 0) { kind = 'missing'; nudge = nudgeMissing(missing); }
          else if (wroteFiles && hasSandbox && lastRun === 'none') { kind = 'run'; nudge = NUDGE_RUN; }
          else if (wroteFiles && lastRun === 'fail') {
            // The model could not fix it in two tries: its files are not lost. They are registered as they are, with a summary that says what
            // still fails; the platform's own gate (the tests run again before review) judges them and the next turn can iterate.
            if (hasChangeset && (nudgesByKind.get('fix') ?? 0) >= MAX_NUDGES) { kind = 'giveup'; nudge = nudgeGiveUp(lastFailing); }
            else { kind = 'fix'; nudge = nudgeFix(lastWhere, lastFailing); }
          }
          else if (hasChangeset && wroteFiles) { kind = 'finish'; nudge = lastRun === 'pass' ? NUDGE_FINISH : NUDGE_REGISTER; }
          if (nudge !== null) {
            if ((nudgesByKind.get(kind) ?? 0) >= MAX_NUDGES) nudge = null; else nudgesByKind.set(kind, (nudgesByKind.get(kind) ?? 0) + 1);
          }
          if (nudge === null && text.trim().length === 0 && nudgesEmpty < MAX_NUDGES) { nudge = NUDGE_EMPTY; nudgesEmpty++; }
        }
      }
      if (nudge === null) { yield usageEvent(); yield { t: 'run.completed', at: at(), stopReason: reply.doneReason === 'length' ? 'max_tokens' : 'end_turn' }; return; }
      nudgesTotal++;
      d.messages.push({ role: 'user', content: `${nudge}${NUDGE_FORMAT}` });
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
      /** What the model should do next, when the loop knows (appended to the result). */
      let hint = '';
      if ((fails.get(key) ?? 0) >= REPEAT_FAIL_NOTICE) {
        ok = false; bytes = 0;
        content = `ERROR: this exact call has already failed ${fails.get(key)} times. Do not repeat it: change the arguments or try another approach.`;
      } else if (isFile) {
        const fr = await d.files.run(name, args);
        ok = fr.ok; bytes = Buffer.byteLength(fr.text, 'utf8');
        content = name === 'read_file' ? clip(fr.text, d.tuning.toolResultMaxChars) : fr.text;
        if (ok && name === 'read_file' && lastRun === 'fail') hint = HINT_READ_FIX;
        if (ok && (name === 'write_file' || name === 'delete_file')) wroteFiles = true;
        if (ok && name === 'write_file') {
          const c = checkRelPath(args.path);
          if (c.ok) wrote.add(c.segs.join('/'));
          nudgesByKind.clear();
          const missing = missingFiles();
          hint = missing.length > 0 ? hintMissing(missing) : (hasSandbox && lastRun !== 'pass' ? HINT_RUN : '');
        }
      } else if (d.mcp) {
        const mr = await d.mcp.call(name, args, d.signal);
        ok = mr.ok; bytes = mr.bytes;
        content = mr.text.length > 0 ? mr.text : (ok ? '(no output)' : 'ERROR: the tool failed');
        if (ok && name === 'sandbox_exec') {
          const r = renderExec(content, d.tuning.execOutputMaxChars);
          content = r.text;
          lastRun = r.code === null ? 'unknown' : (r.code === 0 ? 'pass' : 'fail');
          nudgesByKind.clear();
          lastWhere = r.where; lastFailing = r.failing;
          hint = r.code === null ? '' : (r.code !== 0 ? hintFix(r.where, r.failing) : (hasChangeset && missingFiles().length === 0 ? HINT_FINISH : (missingFiles().length > 0 ? hintMissing(missingFiles()) : '')));
        } else content = clip(content, d.tuning.toolResultMaxChars);
        if (ok && name === 'changeset_register') registered = true;
      } else {
        ok = false; bytes = 0; content = 'ERROR: the tool is not available';
      }
      if (!ok) fails.set(key, (fails.get(key) ?? 0) + 1);
      yield { t: 'tool.completed', callId, ok, resultBytes: bytes };
      const stop3 = ended();
      if (stop3) { yield usageEvent(); yield stop3; return; }
      const note = fromText && i === 0 ? `\n${NOTE_TEXT_CALL}` : '';
      toolMsg(`${ok || content.startsWith('ERROR') ? '' : 'ERROR: '}${content}${note}${hint ? `\n${hint}` : ''}`);
      const stuckFail = (fails.get(key) ?? 0) >= REPEAT_FAIL_ABORT;
      const stuckSame = sameRun >= REPEAT_SAME_ABORT;
      if (stuckFail || stuckSame) {
        // Stuck on one call. Work already written is not thrown away: once, the model is told to register it as it is (the platform's own
        // gate judges it); a second time, or with nothing written, the turn ends as before.
        if (hasChangeset && wroteFiles && !registered && !gaveUp) {
          gaveUp = true; fails.clear(); sameRun = 0;
          d.messages.push({ role: 'user', content: `${NUDGE_STUCK}${NUDGE_FORMAT}` });
          continue;
        }
        yield usageEvent();
        yield failed('protocol', stuckFail ? 'the model kept repeating a failing tool call' : 'the model kept repeating the same tool call');
        return;
      }
    }
    yield usageEvent();
  }
}
