/**
 * The agent runtime registry (B2b Task 11): picks the `AgentRuntime` for one turn by its `RuntimeKind`. Two kinds exist
 * in this build: `scripted` (in-process, no child process: src/runner/runtimes/scripted.ts) and `cli-agent` (the
 * vendor-neutral kind every real engine adapter runs under: its CLI spawned on the host, confined to the turn's own
 * worktree by policy, every actual command run through `sandbox_exec` into the container).
 *
 * `CliAgentRuntime` here is the thin process wrapper every `cli-agent` turn shares: it spawns `agentBin` (resolved by
 * the caller — the real engine's CLI in production, or the test CLI stand-in: `process.execPath` with
 * `ELECTRON_RUN_AS_NODE=1` and `test/fixtures/agent/fake-cli.cjs`, through this SAME spawn site), reads newline-delimited
 * JSON `RuntimeEvent`s from its stdout, and registers the spawned pid with `procTree` the moment it is known, so a
 * crash leaves a pidfile a later `hello` can clean up. `cancel` kills the whole tree (`procTree`'s `taskkill`) rather
 * than trusting the child to exit on a signal Windows has no real equivalent for.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import type { AgentRuntime, RunRequest, RuntimeEvent, RuntimeHealth, RuntimeKind } from '../../shared/nexus/runtime';
import { killProcessTree } from '../procTree';
import { SCRIPTED_KIND, ScriptedRuntime, type ScriptedStep } from './scripted';

export const CLI_AGENT_KIND = 'cli-agent' as RuntimeKind;
export { SCRIPTED_KIND };

/** What one turn needs to build its runtime: the bearer for MCP calls, and (kind-specific) how to reach the engine. */
export interface RuntimeTurnContext {
  token: string;
  mcpUrl: string;
  /** `scripted` only: the fixture this turn replays. */
  steps?: readonly ScriptedStep[];
  fetchImpl?: typeof fetch;
  /** `cli-agent` only: the resolved CLI binary (the real engine's CLI in production; the fake CLI stand-in in tests). */
  agentBin?: string;
  agentEnv?: NodeJS.ProcessEnv;
  /** `cli-agent` only: argv placed before the turn's config dir (e.g. the test stand-in's own script path). */
  agentArgvPrefix?: readonly string[];
  /** `cli-agent` only: called the moment the process is spawned (its pid is then known), to register it with procTree. */
  onSpawned?: (info: { pid: number; imageName: string }) => void | Promise<void>;
  /** `cli-agent` only: called once the process is gone (it exited, or was killed): its pidfile is forgotten, never killed later. */
  onGone?: (pid: number) => void | Promise<void>;
  taskkillBin?: string;
}

export function runtimeFor(kind: RuntimeKind, ctx: RuntimeTurnContext): AgentRuntime {
  if (kind === SCRIPTED_KIND) return new ScriptedRuntime({ token: ctx.token, mcpUrl: ctx.mcpUrl, steps: ctx.steps ?? [], fetchImpl: ctx.fetchImpl });
  if (kind === CLI_AGENT_KIND) {
    if (!ctx.agentBin) throw new Error('the cli-agent runtime needs a resolved CLI binary');
    return new CliAgentRuntime({ agentBin: ctx.agentBin, env: ctx.agentEnv, argvPrefix: ctx.agentArgvPrefix ?? [], onSpawned: ctx.onSpawned, onGone: ctx.onGone, taskkillBin: ctx.taskkillBin });
  }
  throw new Error(`no runtime is registered for ${String(kind)}`);
}

interface CliAgentRuntimeOptions {
  agentBin: string;
  env?: NodeJS.ProcessEnv;
  argvPrefix: readonly string[];
  onSpawned?: (info: { pid: number; imageName: string }) => void | Promise<void>;
  onGone?: (pid: number) => void | Promise<void>;
  taskkillBin?: string;
}

/**
 * Spawns the turn's CLI once, on `start`, and yields the `RuntimeEvent`s it prints (one JSON object per line on
 * stdout; a malformed line is ignored). Never throws out of `start`: a process that ends without a terminal event of
 * its own (`run.completed` / `run.failed` / `run.cancelled`) is reported as `run.cancelled` (the signal fired first)
 * or `run.failed` (it just died).
 */
export class CliAgentRuntime implements AgentRuntime {
  readonly kind: RuntimeKind = CLI_AGENT_KIND;
  private pid: number | null = null;
  private imageName = '';
  private killing: Promise<void> | null = null;

  constructor(private readonly o: CliAgentRuntimeOptions) {}

  async describe(): ReturnType<AgentRuntime['describe']> {
    return { version: '0', supportsHttpMcp: true, supportsResume: false, models: [], label: 'agent CLI', egressHosts: [] };
  }
  async health(): Promise<RuntimeHealth> { return { ok: true, version: '0' }; }

  async *start(req: RunRequest, signal: AbortSignal): AsyncIterable<RuntimeEvent> {
    // The runner's second spawn family (alongside docker and git in proc.ts, and taskkill in procTree.ts): the turn's
    // own CLI, by the caller's already-resolved absolute path. Production resolves the real engine's CLI; tests inject
    // `agentBin = process.execPath` with `ELECTRON_RUN_AS_NODE=1` and the fake CLI stand-in as `argvPrefix`.
    const agentBin = this.o.agentBin;
    this.imageName = path.basename(agentBin);
    const argv = [...this.o.argvPrefix, req.configDir];
    const child: ChildProcess = spawn(agentBin, argv,
      { env: { ...process.env, ...this.o.env }, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    this.pid = child.pid ?? null;
    if (this.pid !== null) await this.o.onSpawned?.({ pid: this.pid, imageName: this.imageName });

    const queue: RuntimeEvent[] = [];
    let waiter: (() => void) | null = null;
    let ended = false;
    let buf = '';
    const wake = (): void => { const w = waiter; waiter = null; w?.(); };
    const push = (ev: RuntimeEvent): void => { queue.push(ev); wake(); };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try { push(JSON.parse(t) as RuntimeEvent); } catch { /* not a frame this adapter understands: ignored */ }
      }
    });
    // The process is gone on its own: its pid may be recycled, so it is forgotten now and never killed later.
    const gone = (): void => {
      ended = true; wake();
      const pid = this.pid;
      if (pid !== null && !this.killing) { this.pid = null; void this.o.onGone?.(pid); }
    };
    child.on('error', gone);
    child.on('close', gone);
    const onAbort = (): void => { void this.cancel('', 0); };
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      let terminal = false;
      for (;;) {
        if (queue.length > 0) {
          const ev = queue.shift()!;
          if (ev.t === 'run.completed' || ev.t === 'run.failed' || ev.t === 'run.cancelled') terminal = true;
          yield ev;
          if (terminal) return;
          continue;
        }
        if (ended) {
          if (!terminal) yield signal.aborted ? { t: 'run.cancelled', at: Date.now() } : { t: 'run.failed', at: Date.now(), code: 'runtime_error', message: 'the process ended unexpectedly' };
          return;
        }
        await new Promise<void>((resolve) => { waiter = resolve; });
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  /** Kills the whole tree of a process still running, then forgets it. Safe to call again and again (one kill, awaited by all). */
  cancel(_runRef: string, _graceMs: number): Promise<void> {
    if (this.killing) return this.killing;
    const pid = this.pid;
    if (pid === null) return Promise.resolve();
    this.pid = null;
    this.killing = (async () => {
      await killProcessTree(pid, this.imageName, this.o.taskkillBin);
      try { await this.o.onGone?.(pid); } catch { /* best effort */ }
    })();
    return this.killing;
  }
}
