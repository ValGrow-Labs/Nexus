/**
 * The CLI agent adapter (B2b Task 13): the one real implementation of `AgentRuntime` for the neutral kind `cli-agent`.
 * It runs the engine's own native executable ON THE HOST under the runner, with:
 *
 * - the Task 0 argv (args.ts) and the files written into the job's config dir (files.ts), the worktree as the cwd;
 * - an environment built from nothing (env.ts): the allow-list, `HTTPS_PROXY` = the turn's loopback egress proxy,
 *   `NO_PROXY=127.0.0.1`, the turn's bearer as `NEXUS_MCP_TOKEN`; the engine's own login store is used in place and
 *   never read, copied or stored (D-B1);
 * - the message and the context on stdin as one preamble (never argv);
 * - the stream-json output translated to neutral events (stream.ts);
 * - the turn's caps enforced here as well (tokens, tool calls, wall clock, spend): a turn over a cap is cancelled and
 *   fails `limit`;
 * - the tree killed with `procTree.killProcessTree` on cancel, and always at the end (no process remains).
 *
 * This is the runner's ONE spawn site for the engine (`spawn(bin`): the health runs (`--version`, `--help`,
 * `auth status`) and a turn all go through `launch`. A turn never starts when the engine's version or flags are not the
 * pinned ones (`version_unsupported`), when no egress proxy is running for it, or when no budget is left.
 *
 * File tools are confined by policy (restricted tools, deny rules, `dontAsk`), not by OS isolation; every command an
 * agent runs goes through `sandbox_exec` into the container.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { MCP_TOOLS } from '../../../shared/nexus/mcpTools';
import type { RuntimeSetup } from '../../../shared/nexus/runnerProtocol';
import type { AgentRuntime, RunRequest, RuntimeEvent, RuntimeHealth, RuntimeKind } from '../../../shared/nexus/runtime';
import { killProcessTree } from '../../procTree';
import type { RunnerFs } from '../../types';
import { ARGV_MAX_BYTES, budgetCentsOf, buildArgs } from './args';
import { SKILLS_FILE_FLAG, SUPPORTED_VERSION_RE, helpFlagsOf, isAgentBinary, missingFlags, parseSignedIn, parseVersion, resolveAgentCli } from './binary';
import { agentEnv, mergeOverlay } from './env';
import { MCP_SERVER_NAME, writeTurnFiles } from './files';
import { StreamTranslator, newRunRef } from './stream';

export const CLI_AGENT_KIND = 'cli-agent' as RuntimeKind;
/** The engine's display name: shown on the setup row only (D-B9). */
export const ADAPTER_LABEL = 'Claude Code';
/** The one network destination the engine's process needs (D-B2), pinned by CR15. */
export const EGRESS_HOSTS: readonly { host: string; port: number }[] = Object.freeze([Object.freeze({ host: 'api.anthropic.com', port: 443 })]);

/** A loopback address nothing listens on: a health run with no proxy given still cannot reach any network. */
const DEAD_PROXY = 'http://127.0.0.1:9';
const CONTEXT_MAX_BYTES = 1024 * 1024;
const HEALTH_RUN_TIMEOUT_MS = 30_000;
const OUTPUT_KEEP_BYTES = 512 * 1024;
const EXIT_WAIT_MS = 3_000;

export interface TurnCaps { turnTokens?: number; turnUsdCents?: number; dayRemainingUsdCents?: number; toolCalls?: number }

/** The preflight verdict of one executable: its version and its flags, as `--version` and `--help` said. */
export interface Preflight {
  ok: boolean;
  reason?: 'not_installed' | 'version_unsupported' | 'error';
  detail: string;
  version: string | null;
  /** `--help` names the skills-file flag. */
  skillsFlag: boolean;
}

export interface CliAdapterOptions {
  /** The turn's bearer (`NEXUS_MCP_TOKEN`: environment only). Empty for an adapter that only answers health. */
  token?: string;
  /** The runner's loopback MCP URL. */
  mcpUrl?: string;
  /** An explicit absolute executable (the test stand-ins). Without it the native executable is resolved along PATH. */
  bin?: string;
  /** argv placed before the pinned argv (a test stand-in's own script path). */
  argvPrefix?: readonly string[];
  /** Where the allow-listed names are copied from (default: the runner's own environment). */
  baseEnv?: NodeJS.ProcessEnv;
  /** Names added after the allow-list; set only by the runner's test seams, never by production. */
  envOverlay?: Readonly<Record<string, string>>;
  /** The turn's egress proxy URL, known once the proxy has started. */
  proxyUrl?: () => string | null;
  caps?: TurnCaps;
  /** The Nexus MCP tools this turn may call (default: every tool the runner serves; main still checks the claims). */
  mcpTools?: readonly string[];
  /** Called the moment the process is spawned (its pid is then known). */
  onSpawned?: (info: { pid: number; imageName: string }) => void | Promise<void>;
  /** Called once when that process has ended or been killed. */
  onExited?: (info: { pid: number }) => void | Promise<void>;
  taskkillBin?: string;
  /** Lines that never hold a secret, the message, the context, a path of the user's or the engine's own output. */
  log?: (line: string) => void;
  fs?: RunnerFs;
  /** A cache shared across adapters (production): keyed by the executable, its size and its mtime. */
  preflightCache?: Map<string, Preflight>;
}

const delay = (ms: number): Promise<void> => new Promise((r) => { const t = setTimeout(r, ms); (t as { unref?: () => void }).unref?.(); });

interface RunResult { code: number | null; stdout: string; timedOut: boolean; spawnFailed: boolean }

export class CliAgentAdapter implements AgentRuntime {
  readonly kind: RuntimeKind = CLI_AGENT_KIND;
  private pid: number | null = null;
  private imageName = '';
  private cancelled = false;
  private killing: Promise<void> | null = null;
  private own = new Map<string, Preflight>();

  constructor(private readonly o: CliAdapterOptions = {}) {}

  private base(): NodeJS.ProcessEnv { return this.o.baseEnv ?? process.env; }
  private get fs(): RunnerFs { return this.o.fs ?? fsp; }
  private note(line: string): void { try { this.o.log?.(line); } catch { /* a log must never fail a turn */ } }

  /** The executable to run, or null: an explicit one must be absolute and the native one (or this process's own binary). */
  private binary(): string | null {
    const given = this.o.bin;
    if (given !== undefined) {
      if (isAgentBinary(given)) return given;
      return path.isAbsolute(given) && given === process.execPath ? given : null;
    }
    return resolveAgentCli({ env: this.base() });
  }

  /** The one spawn site for the engine. Never a shell. The environment is whatever `agentEnv` built, nothing inherited. */
  private launch(bin: string, args: readonly string[], env: Record<string, string>, cwd: string | undefined): ChildProcess {
    return spawn(bin, [...(this.o.argvPrefix ?? []), ...args], { cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  }

  /** A short health run: output bounded, killed at the timeout, stdin closed. Never throws. */
  private async runOnce(bin: string, args: readonly string[], proxyUrl: string): Promise<RunResult> {
    let env: Record<string, string>;
    try { env = mergeOverlay(agentEnv(this.base(), { proxyUrl, cliDir: path.dirname(bin) }), this.o.envOverlay); }
    catch { return { code: null, stdout: '', timedOut: false, spawnFailed: true }; }
    return new Promise<RunResult>((resolve) => {
      let child: ChildProcess;
      try { child = this.launch(bin, args, env, undefined); } catch { resolve({ code: null, stdout: '', timedOut: false, spawnFailed: true }); return; }
      const out: Buffer[] = [];
      let size = 0; let timedOut = false; let done = false;
      const finish = (code: number | null, spawnFailed: boolean): void => {
        if (done) return;
        done = true; clearTimeout(timer);
        resolve({ code, stdout: Buffer.concat(out).toString('utf8'), timedOut, spawnFailed });
      };
      child.stdout?.on('data', (d: Buffer) => { if (size < OUTPUT_KEEP_BYTES) { out.push(d); size += d.length; } });
      child.stderr?.on('data', () => { /* discarded: never kept, never logged */ });
      child.stdin?.on('error', () => { /* closed */ });
      child.stdin?.end();
      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid !== undefined) void killProcessTree(child.pid, path.basename(bin), this.o.taskkillBin);
      }, HEALTH_RUN_TIMEOUT_MS);
      child.once('error', () => finish(null, true));
      child.once('close', (code) => finish(code, false));
    });
  }

  private async cacheKey(bin: string): Promise<string> {
    let sig = 'nostat';
    try { const st = await this.fs.stat(bin); sig = `${st.size}:${Math.round(st.mtimeMs)}`; } catch { /* keyed without it */ }
    return `${bin}|${(this.o.argvPrefix ?? []).join('\0')}|${sig}`;
  }

  /** `--version` then `--help`: the pinned version family and every pinned flag, cached per executable. */
  async preflight(proxyUrl?: string): Promise<Preflight> {
    const bin = this.binary();
    if (!bin) return { ok: false, reason: 'not_installed', detail: 'the agent CLI is not installed', version: null, skillsFlag: false };
    const key = await this.cacheKey(bin);
    const cache = this.o.preflightCache ?? this.own;
    const hit = cache.get(key);
    if (hit) return hit;
    const proxy = proxyUrl ?? DEAD_PROXY;
    const v = await this.runOnce(bin, ['--version'], proxy);
    const version = v.code === 0 ? parseVersion(v.stdout) : null;
    let result: Preflight;
    if (v.spawnFailed || v.timedOut) {
      return { ok: false, reason: 'error', detail: 'the agent CLI did not answer --version', version: null, skillsFlag: false };
    } else if (!version || !SUPPORTED_VERSION_RE.test(version)) {
      result = { ok: false, reason: 'version_unsupported', detail: `version ${version ?? 'unknown'} is not a supported version`, version, skillsFlag: false };
    } else {
      const h = await this.runOnce(bin, ['--help'], proxy);
      if (h.spawnFailed || h.timedOut || h.code !== 0) {
        return { ok: false, reason: 'error', detail: 'the agent CLI did not answer --help', version, skillsFlag: false };
      }
      const missing = missingFlags(h.stdout);
      const skillsFlag = helpFlagsOf(h.stdout)[SKILLS_FILE_FLAG] === true;
      result = missing.length > 0
        ? { ok: false, reason: 'version_unsupported', detail: `missing flags: ${missing.join(' ')}`, version, skillsFlag }
        : { ok: true, detail: 'ok', version, skillsFlag };
    }
    cache.set(key, result);
    return result;
  }

  async describe(): ReturnType<AgentRuntime['describe']> {
    const pf = await this.preflight(this.o.proxyUrl?.() ?? undefined);
    return { version: pf.version ?? 'unknown', supportsHttpMcp: true, supportsResume: false, models: [], label: ADAPTER_LABEL,
      egressHosts: EGRESS_HOSTS.map((h) => ({ host: h.host, port: h.port })) };
  }

  /**
   * The engine's own login state as one word: `auth status --json` run under `agentEnv` through the given proxy, its
   * output parsed here and dropped (F17). Without a proxy it is not run at all.
   */
  private async signedIn(bin: string, proxyUrl: string | undefined): Promise<'yes' | 'no' | 'unknown'> {
    if (!proxyUrl) return 'unknown';
    const r = await this.runOnce(bin, ['auth', 'status', '--json'], proxyUrl);
    if (r.spawnFailed || r.timedOut) return 'unknown';
    return parseSignedIn(r.stdout);
  }

  /**
   * `proxyUrl`: the deny-all proxy before consent, the allow proxy after it. Without one only `--version` and `--help`
   * run (neither needs the network) and `auth status` is not asked.
   */
  async health(opts: { proxyUrl?: string } = {}): Promise<RuntimeHealth> {
    const pf = await this.preflight(opts.proxyUrl);
    if (!pf.ok) return { ok: false, reason: pf.reason ?? 'error', detail: pf.detail };
    const bin = this.binary();
    if (bin && opts.proxyUrl && (await this.signedIn(bin, opts.proxyUrl)) === 'no') {
      return { ok: false, reason: 'not_authenticated', detail: 'the agent CLI is not signed in' };
    }
    return { ok: true, version: pf.version ?? 'unknown' };
  }

  /** The setup row's facts: signed in or not (one word), flags, label, hosts. */
  async setup(opts: { proxyUrl?: string } = {}): Promise<RuntimeSetup> {
    const pf = await this.preflight(opts.proxyUrl);
    const bin = this.binary();
    const signedIn = pf.ok && bin ? await this.signedIn(bin, opts.proxyUrl) : 'unknown';
    return { signedIn, flagsOk: pf.ok, label: ADAPTER_LABEL, egressHosts: EGRESS_HOSTS.map((h) => ({ host: h.host, port: h.port })) };
  }

  async *start(req: RunRequest, signal: AbortSignal): AsyncIterable<RuntimeEvent> {
    const runRef = newRunRef();
    this.cancelled = false;
    this.killing = null;
    // Registered FIRST, before the preflight and the file preparation: an abort at any point is never lost. Before the
    // process exists it only sets `cancelled` (and `turn` then never spawns); after it exists it kills the tree.
    const onAbort = (): void => { void this.cancel(runRef, 0); };
    signal.addEventListener('abort', onAbort, { once: true });
    try { yield* this.turn(req, signal, runRef); } finally { signal.removeEventListener('abort', onAbort); }
  }

  private async *turn(req: RunRequest, signal: AbortSignal, runRef: string): AsyncGenerator<RuntimeEvent> {
    const at = (): number => Date.now();
    const failed = (code: 'runtime_error' | 'auth' | 'limit' | 'protocol', message: string): RuntimeEvent => ({ t: 'run.failed', at: at(), code, message });
    yield { t: 'run.started', runRef, at: at() };
    if (signal.aborted || this.cancelled) { yield { t: 'run.cancelled', at: at() }; return; }

    // Nothing starts without a loopback proxy of this turn's own: the engine would otherwise reach the network directly.
    const proxyUrl = this.o.proxyUrl?.() ?? null;
    if (!proxyUrl) { yield failed('runtime_error', 'no egress proxy is running for this turn'); return; }
    const bin = this.binary();
    if (!bin) { yield failed('runtime_error', 'not_installed: the agent CLI is not installed'); return; }
    const pf = await this.preflight(proxyUrl);
    if (!pf.ok) { yield failed('runtime_error', `${pf.reason ?? 'error'}: ${pf.detail}`); return; }
    if (signal.aborted || this.cancelled) { yield { t: 'run.cancelled', at: at() }; return; }

    const cents = budgetCentsOf({ turnUsdCents: this.o.caps?.turnUsdCents, dayRemainingUsdCents: this.o.caps?.dayRemainingUsdCents, maxCostUsd: req.limits.maxCostUsd });
    if (cents <= 0) { yield failed('limit', 'no budget is left for this turn'); return; }

    // Files, context and the preamble.
    let preamble: string; let args: string[]; let env: Record<string, string>;
    try {
      const files = await writeTurnFiles(this.fs, req.configDir, this.o.mcpUrl ?? req.mcp.url);
      const context = await this.readBounded(req.context.file);
      if (context === null) { yield failed('runtime_error', 'the context file is missing or too large'); return; }
      let skills = '';
      let skillsFile: string | null = null;
      const sk = await this.readBounded(files.skillsMd);
      if (sk !== null && sk.trim().length > 0) { if (pf.skillsFlag) skillsFile = files.skillsMd; else skills = sk; }
      preamble = `${skills ? `<nexus-skills>\n${skills}\n</nexus-skills>\n\n` : ''}<nexus-context>\n${context}\n</nexus-context>\n\n${req.message}\n`;
      const tools = this.o.mcpTools ?? MCP_TOOLS.map((t) => t.name);
      args = buildArgs({ dir: req.configDir, mcpJson: files.mcpJson, settingsJson: files.settingsJson, mcpTools: tools, budgetCents: cents, skillsFile });
      if (Buffer.byteLength([bin, ...args].join(' '), 'utf8') > ARGV_MAX_BYTES) { yield failed('protocol', 'the engine argv is too large'); return; }
      env = mergeOverlay(agentEnv(this.base(), { proxyUrl, token: this.o.token, tempDir: files.tempDir, cliDir: path.dirname(bin) }), this.o.envOverlay);
    } catch {
      yield failed('runtime_error', 'the turn files could not be prepared');
      return;
    }

    // An abort that arrived while the files were prepared: no process is ever started for a cancelled turn.
    if (signal.aborted || this.cancelled) { yield { t: 'run.cancelled', at: at() }; return; }

    // Spawn.
    let child: ChildProcess;
    try { child = this.launch(bin, args, env, req.worktree.hostPath); }
    catch { yield failed('runtime_error', 'the agent CLI could not be started'); return; }
    this.imageName = path.basename(bin);
    this.pid = child.pid ?? null;
    const pid = this.pid;
    let exited = false;
    let resolveExit: () => void = () => undefined;
    const exitP = new Promise<void>((r) => { resolveExit = r; });
    const queue: RuntimeEvent[] = [];
    let waiter: (() => void) | null = null;
    const wake = (): void => { const w = waiter; waiter = null; w?.(); };
    const tr = new StreamTranslator({ mcpServerName: MCP_SERVER_NAME });
    let exitCode: number | null = null;
    let spawnError = false;
    let wallClock = false;

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { if (!tr.done) { for (const e of tr.feed(chunk)) queue.push(e); } wake(); });
    child.stderr?.on('data', () => { /* discarded: never kept, never logged */ });
    child.stdin?.on('error', () => { /* the process may already be gone */ });
    child.once('error', () => { spawnError = true; exited = true; resolveExit(); wake(); });
    child.once('close', (code) => { exitCode = code; exited = true; resolveExit(); wake(); });
    const wallMs = Math.max(1000, req.limits.wallClockMs);
    const wallTimer = setTimeout(() => { wallClock = true; void this.cancel(runRef, 0); }, wallMs);
    (wallTimer as { unref?: () => void }).unref?.();

    // True once the turn ended through one of its own return paths; anything else (a throw from `onSpawned`, a consumer
    // that stops early) is abnormal and the tree is killed at once.
    let normalEnd = false;
    try {
      // An abort that landed between the last check and the spawn: kill now that there is a process.
      if (signal.aborted || this.cancelled) void this.cancel(runRef, 0);
      if (pid !== null) await this.o.onSpawned?.({ pid, imageName: this.imageName });
      if (signal.aborted || this.cancelled) void this.cancel(runRef, 0);
      child.stdin?.end(preamble, 'utf8');
      let terminal = false;
      for (;;) {
        if (queue.length > 0) {
          const ev = queue.shift()!;
          // The turn's own caps, on top of the engine's `--max-budget-usd`: a turn over one is cancelled.
          const over = ev.t === 'usage' ? this.overCap(ev) : null;
          if (over) {
            yield ev;
            await this.cancel(runRef, 0);
            normalEnd = true;
            yield failed('limit', over);
            return;
          }
          if (ev.t === 'run.completed' || ev.t === 'run.failed' || ev.t === 'run.cancelled') { terminal = true; normalEnd = true; }
          yield ev;
          if (terminal) return;
          if (tr.sawInit && (tr.mcpStatus === 'failed' || tr.mcpStatus === 'needs-auth')) {
            await this.cancel(runRef, 0);
            normalEnd = true;
            yield failed('runtime_error', 'the Nexus MCP server did not connect');
            return;
          }
          continue;
        }
        if (exited) {
          for (const e of tr.flush()) queue.push(e);
          if (queue.length > 0) continue;
          normalEnd = true;
          if (signal.aborted || this.cancelled) { yield wallClock ? failed('limit', 'the turn ran past its wall clock') : { t: 'run.cancelled', at: at() }; return; }
          if (spawnError) { yield failed('runtime_error', 'the agent CLI could not be started'); return; }
          yield this.endedWithoutResult(tr, exitCode);
          return;
        }
        await new Promise<void>((resolve) => { waiter = resolve; });
      }
    } finally {
      clearTimeout(wallTimer);
      // No process remains. An abnormal end kills the tree at once; a normal one gets a moment to exit on its own first.
      if (!exited && !normalEnd) await this.cancel(runRef, 0);
      else if (!exited) await Promise.race([exitP, delay(EXIT_WAIT_MS)]);
      if (!exited) { await this.cancel(runRef, 0); await Promise.race([exitP, delay(EXIT_WAIT_MS)]); }
      if (pid !== null) { try { await this.o.onExited?.({ pid }); } catch { /* best effort */ } }
      if (this.pid === pid) this.pid = null;
    }
  }

  /** Why the turn stopped over a cap (null when it did not). */
  private overCap(u: Extract<RuntimeEvent, { t: 'usage' }>): string | null {
    const caps = this.o.caps;
    if (!caps) return null;
    if (typeof caps.turnTokens === 'number' && u.inputTokens + u.outputTokens + u.cacheCreationTokens > caps.turnTokens) return 'the turn went over its token cap';
    if (typeof caps.toolCalls === 'number' && u.toolCalls > caps.toolCalls) return 'the turn went over its tool-call cap';
    if (typeof caps.turnUsdCents === 'number' && u.costUsdCents !== null && u.costUsdCents > caps.turnUsdCents) return 'the turn went over its spend cap';
    return null;
  }

  private endedWithoutResult(tr: StreamTranslator, code: number | null): RuntimeEvent {
    const at = Date.now();
    if (tr.retries > 0 && (tr.lastRetryStatus === 401 || tr.lastRetryStatus === 403)) {
      return { t: 'run.failed', at, code: 'auth', message: 'the model service refused the engine\'s login' };
    }
    if (tr.retries > 0) return { t: 'run.failed', at, code: 'runtime_error', message: 'the model service could not be reached' };
    return { t: 'run.failed', at, code: 'runtime_error', message: `the engine ended without a result${code === null ? '' : ` (exit ${code})`}` };
  }

  /** The file's text when it exists and is at most 1 MiB; null otherwise. */
  private async readBounded(file: string): Promise<string | null> {
    try {
      const st = await this.fs.stat(file);
      if (!st.isFile() || st.size > CONTEXT_MAX_BYTES) return null;
      return await this.fs.readFile(file, 'utf8');
    } catch { return null; }
  }

  /**
   * Ends the turn's process tree now. The engine has no signal Windows delivers gracefully, so `graceMs` does not
   * delay the kill: the whole tree goes, and `start` then reports `run.cancelled`.
   */
  cancel(_runRef: string, _graceMs: number): Promise<void> {
    this.cancelled = true;
    if (this.killing) return this.killing;
    const pid = this.pid;
    if (pid === null) return Promise.resolve();
    this.killing = killProcessTree(pid, this.imageName, this.o.taskkillBin);
    return this.killing;
  }
}

/** The per-turn construction the registry uses. */
export function createCliAgentAdapter(o: CliAdapterOptions): CliAgentAdapter {
  return new CliAgentAdapter(o);
}
