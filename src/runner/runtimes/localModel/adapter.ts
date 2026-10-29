/**
 * The local-model agent adapter (the neutral kind `local-model`): an `AgentRuntime` that drives a model served on THIS machine
 * in a tool-calling loop. The server is Ollama's native API; nothing else is spoken to. It runs in-process in the runner (no child
 * process, no CLI), so everything it does is its own HTTP and file work:
 *
 * - Destination (R2): the only place it connects is a loopback address on the consented port (endpoint.ts), made by the runner
 *   process itself. Never from the sandbox container (its network stays off), never a redirect, never a remote host.
 * - Tools: the host FILE tools, confined to the turn's worktree (fileTools.ts, R5), and the runner's MCP tools
 *   (`tools/list` then `tools/call` over HTTP with the turn's bearer, mcpClient.ts), `sandbox_exec` and `changeset_register`
 *   among them. A command only ever runs through `sandbox_exec`, in the container; the worktree guard the runner runs after
 *   each exec still applies.
 * - Loop and caps: loop.ts (wall clock, model calls, tool calls <= 200, tokens; cost 0 and not estimated; weak-model handling).
 * - Secrets: the bearer is an `Authorization` header to the runner's loopback MCP server and nowhere else; it is not in a
 *   prompt, a request to the model server, a tool result or an event.
 *
 * The same class answers the runner's probe (`describe`, `health`, `setup`, `check`): the server reachable, the chosen model
 * installed, the model reporting tool support. Every detail it reports is one of a few fixed sentences.
 */
import { randomBytes } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { RuntimeSetup } from '../../../shared/nexus/runnerProtocol';
import type { AgentRuntime, RunRequest, RuntimeEvent, RuntimeHealth, RuntimeKind } from '../../../shared/nexus/runtime';
import { supportsTools, tags, version } from './client';
import { DEFAULT_ENDPOINT, ENDPOINT_NOT_CONSENTED, ENDPOINT_NOT_LOOPBACK, loopbackMcpUrl, resolveTarget, type LookupFn, type Target } from './endpoint';
import { DEFAULT_FILE_LIMITS, FILE_TOOL_DEFS, FILE_TOOL_NAMES, FileTools, type FileToolLimits } from './fileTools';
import { DEFAULT_TUNING, runLoop, type LoopTuning } from './loop';
import { McpClient, redactToken } from './mcpClient';
import { namedFiles, systemPrompt, toolDescription, userMessage } from './prompt';

export const LOCAL_MODEL_KIND = 'local-model' as RuntimeKind;
/** The runtime's display name: shown on the setup row only (D-B9). */
export const ADAPTER_LABEL = 'Local model (Ollama)';
/** `RunRequest.model.provider` for this kind. */
export const LOCAL_MODEL_PROVIDER = 'local-model';

const MODEL_RE = /^[A-Za-z0-9._:/@-]{1,128}$/;
const PROBE_TIMEOUT_MS = 4000;
const PROBE_MAX_BYTES = 1024 * 1024;
const PROBE_TOOL_CHECKS = 6;
/** The models the setup row lists with their tool support (each costs one `/api/show`, asked in parallel). */
const PROBE_LISTED_MODELS = 16;
const CONTEXT_MAX_BYTES = 24 * 1024;
const SKILLS_MAX_BYTES = 16 * 1024;
/**
 * The runner tools a small model is offered by default: the ones the work loop needs. The token's other tools (artifact reads, job
 * status and logs, job and review requests, requirement drafts) are only a distraction to a model of a few billion parameters (it
 * spends its turns calling them), so they are offered only with `allTools`.
 */
export const CORE_MCP_TOOLS: readonly string[] = Object.freeze(['context_get', 'sandbox_exec', 'changeset_register']);

/** The turn's caps the adapter enforces (the same shape the other real adapter takes; only tokens and tool calls apply: a local model costs nothing). */
export interface TurnCaps { turnTokens?: number; turnUsdCents?: number; dayRemainingUsdCents?: number; toolCalls?: number }

export interface LocalModelAdapterOptions {
  /** The turn's bearer (the MCP `Authorization` header only). Empty for an adapter that only answers the probe. */
  token?: string;
  /** The runner's loopback MCP URL (default: the request's own). Must be `http://127.0.0.1:<port>/...`. */
  mcpUrl?: string;
  /** The hosts the live consent granted (the runner's `plan.egress.allow`); a request's endpoint must be one of them. Default: the server's default address only. */
  consentedHosts?: readonly { host: string; port: number }[];
  caps?: TurnCaps;
  /** The Nexus MCP tools this turn may call (default: every tool the runner lists; main still checks the claims). */
  mcpTools?: readonly string[];
  /** Offer every allowed runner tool, not just the core set (default false: a small model does better with a focused tool list). */
  allTools?: boolean;
  /** The model the probe checks (default: any installed model that supports tools is enough for `ok`). */
  model?: string;
  /** TEST SEAM: the HTTP client for MCP calls (default: the global `fetch`). */
  fetchImpl?: typeof fetch;
  /** TEST SEAM: the resolver for `localhost` (default: `dns.lookup`). */
  lookup?: LookupFn;
  /** Tuning (context size, timeouts, result sizes) and file limits; production leaves them at their defaults. */
  tuning?: Partial<LoopTuning>;
  fileLimits?: Partial<FileToolLimits>;
  /** Lines that never hold the bearer, a prompt, a file's content or a path. */
  log?: (line: string) => void;
  now?: () => number;
}

async function readHead(file: string, max: number): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof fsp.open>> | null = null;
  try {
    fh = await fsp.open(file, 'r');
    const st = await fh.stat();
    if (!st.isFile()) return null;
    const len = Math.min(st.size, max);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, 0);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    return st.size > max ? `${text}\n...[cut]` : text;
  } catch { return null; } finally { await fh?.close().catch(() => undefined); }
}

export class LocalModelAdapter implements AgentRuntime {
  readonly kind: RuntimeKind = LOCAL_MODEL_KIND;
  private readonly active = new Set<AbortController>();
  private lastCheck: { at: number; models: string[]; health: RuntimeHealth; reachable: boolean } | null = null;
  private lastInfo: { at: number; info: { name: string; tools: boolean }[] } | null = null;

  constructor(private readonly o: LocalModelAdapterOptions = {}) {}

  private now(): number { return (this.o.now ?? Date.now)(); }
  private note(line: string): void { try { this.o.log?.(line); } catch { /* a log must never fail a turn */ } }
  private get consented(): readonly { host: string; port: number }[] { return this.o.consentedHosts ?? [DEFAULT_ENDPOINT]; }
  private get endpoint(): { host: string; port: number } { return this.consented[0] ?? DEFAULT_ENDPOINT; }

  /** The loopback target of the adapter's own endpoint (the probe's), or a refusal. */
  private target(): Promise<Target> { return resolveTarget(this.endpoint, { lookup: this.o.lookup }); }

  // ---------------------------------------------------------------- the probe

  /**
   * One look at the server: reachable, the installed models, and whether the chosen model (or, with none chosen, any of the first
   * few) reports tool support. Cached for a few seconds so `describe` and `check` of one probe cost one look. Never throws.
   */
  private async look(): Promise<{ models: string[]; health: RuntimeHealth; reachable: boolean }> {
    const hit = this.lastCheck;
    if (hit && this.now() - hit.at >= 0 && this.now() - hit.at < 5000) return hit;
    const r = await this.lookUncached();
    this.lastCheck = { at: this.now(), ...r };
    return r;
  }

  private async lookUncached(): Promise<{ models: string[]; health: RuntimeHealth; reachable: boolean }> {
    const bad = (reason: 'not_installed' | 'version_unsupported' | 'error', detail: string, models: string[] = [], reachable = true): { models: string[]; health: RuntimeHealth; reachable: boolean } =>
      ({ models, health: { ok: false, reason, detail }, reachable });
    const t = await this.target();
    if (!t.ok) return bad('error', t.reason === 'not_consented' ? ENDPOINT_NOT_CONSENTED : ENDPOINT_NOT_LOOPBACK, [], false);
    const b = { timeoutMs: PROBE_TIMEOUT_MS, maxBytes: PROBE_MAX_BYTES };
    const v = await version(t, b);
    if (!v.ok) return bad('not_installed', 'the local model server is not running', [], false);
    const list = await tags(t, b);
    if (!list.ok) return bad('error', 'the local model server did not list its models');
    const names = list.value;
    const chosen = this.o.model;
    if (chosen !== undefined) {
      const match = names.find((n) => n === chosen || n === `${chosen}:latest`);
      if (!match) return bad('error', 'the chosen model is not installed on the local model server', names);
      const tools = await supportsTools(t, match, b);
      if (!tools.ok) return bad('error', 'the chosen model could not be inspected', names);
      if (!tools.value) return bad('version_unsupported', 'the chosen model does not support tool calls', names);
      return { models: names, health: { ok: true, version: v.value }, reachable: true };
    }
    if (names.length === 0) return bad('error', 'no model is installed on the local model server', names);
    for (const n of names.slice(0, PROBE_TOOL_CHECKS)) {
      const tools = await supportsTools(t, n, b);
      if (tools.ok && tools.value) return { models: names, health: { ok: true, version: v.value }, reachable: true };
    }
    return bad('version_unsupported', 'no installed model supports tool calls', names);
  }

  async describe(): ReturnType<AgentRuntime['describe']> {
    const l = await this.look();
    const v = l.health.ok ? l.health.version : 'unknown';
    return { version: v, supportsHttpMcp: true, supportsResume: false, models: l.models, label: ADAPTER_LABEL,
      egressHosts: [{ host: this.endpoint.host, port: this.endpoint.port }] };
  }

  /** `proxyUrl` is accepted and ignored: this runtime never uses a proxy (loopback only, from the runner itself). */
  async health(_o: { proxyUrl?: string } = {}): Promise<RuntimeHealth> { return (await this.look()).health; }

  /**
   * The setup row: there is no login to a local server, so `signedIn` is `yes` once the server answers (nothing blocks) and
   * `unknown` when it does not; `flagsOk` is the health.
   */
  async setup(_o: { proxyUrl?: string } = {}): Promise<RuntimeSetup> { return (await this.check()).setup; }

  async check(_o: { proxyUrl?: string } = {}): Promise<{ health: RuntimeHealth; setup: RuntimeSetup }> {
    const l = await this.look();
    const models = l.reachable ? await this.modelInfo(l.models) : [];
    return { health: l.health, setup: { signedIn: l.reachable ? 'yes' : 'unknown', flagsOk: l.health.ok, label: ADAPTER_LABEL,
      egressHosts: [{ host: this.endpoint.host, port: this.endpoint.port }], ...(l.reachable ? { models } : {}) } };
  }

  /**
   * The installed models (the first PROBE_LISTED_MODELS) with whether each reports tool support, for the setup row's model choice.
   * A model that cannot be inspected is listed as not supporting tools. Cached with the look; never throws.
   */
  private async modelInfo(names: readonly string[]): Promise<{ name: string; tools: boolean }[]> {
    const hit = this.lastInfo;
    if (hit && this.now() - hit.at >= 0 && this.now() - hit.at < 5000) return hit.info;
    const t = await this.target();
    const b = { timeoutMs: PROBE_TIMEOUT_MS, maxBytes: PROBE_MAX_BYTES };
    const info = t.ok ? await Promise.all(names.slice(0, PROBE_LISTED_MODELS).map(async (name) => {
      const r = await supportsTools(t, name, b);
      return { name, tools: r.ok && r.value };
    })) : [];
    this.lastInfo = { at: this.now(), info };
    return info;
  }

  // ---------------------------------------------------------------- a turn

  async *start(req: RunRequest, signal: AbortSignal): AsyncIterable<RuntimeEvent> {
    const runRef = `lm-${this.now().toString(36)}-${randomBytes(6).toString('hex')}`;
    const at = (): number => this.now();
    const failed = (code: 'runtime_error' | 'auth' | 'limit' | 'protocol', message: string): RuntimeEvent => ({ t: 'run.failed', at: at(), code, message });
    const ac = new AbortController();
    let why: 'wall' | 'cancel' | null = null;
    const onAbort = (): void => { why ??= 'cancel'; ac.abort(); };
    signal.addEventListener('abort', onAbort, { once: true });
    this.active.add(ac);
    let wallTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      yield { t: 'run.started', runRef, at: at() };
      if (signal.aborted) { yield { t: 'run.cancelled', at: at() }; return; }

      if (req.model.provider !== LOCAL_MODEL_PROVIDER || !MODEL_RE.test(req.model.model)) { yield failed('protocol', 'this runtime needs a local model to be chosen'); return; }
      const endpoint = req.endpoint ?? this.endpoint;
      const target = await resolveTarget(endpoint, { consented: this.consented, lookup: this.o.lookup });
      if (!target.ok) { yield failed('runtime_error', target.reason === 'not_consented' ? ENDPOINT_NOT_CONSENTED : ENDPOINT_NOT_LOOPBACK); return; }
      const token = this.o.token ?? '';
      if (token.length === 0) { yield failed('auth', 'no capability token was given for this turn'); return; }
      const mcpUrl = loopbackMcpUrl(this.o.mcpUrl ?? req.mcp.url);
      if (!mcpUrl) { yield failed('runtime_error', 'the Nexus MCP server address is not a loopback address'); return; }
      if (!path.isAbsolute(req.worktree.hostPath)) { yield failed('protocol', 'the worktree path is not absolute'); return; }

      const mcp = new McpClient({ url: mcpUrl.toString(), token, fetchImpl: this.o.fetchImpl });
      const listed = await mcp.listTools(ac.signal);
      if (signal.aborted) { yield { t: 'run.cancelled', at: at() }; return; }
      if (!listed) { yield failed('runtime_error', 'the Nexus MCP server did not answer'); return; }
      const allow = this.o.mcpTools ? new Set(this.o.mcpTools) : null;
      const mcpTools = listed.filter((t) => !FILE_TOOL_NAMES.includes(t.name) && (!allow || allow.has(t.name)) && (this.o.allTools === true || CORE_MCP_TOOLS.includes(t.name)));
      const mcpSchemas = new Map(mcpTools.map((t) => [t.name, t.inputSchema] as const));
      const tools = [...FILE_TOOL_DEFS, ...mcpTools.map((t) => ({ type: 'function' as const,
        function: { name: t.name, description: toolDescription(t.name, t.description), parameters: t.inputSchema } }))];

      const [context, skills] = await Promise.all([readHead(req.context.file, CONTEXT_MAX_BYTES), readHead(path.join(req.configDir, 'skills.md'), SKILLS_MAX_BYTES)]);
      const scrubbed = (s: string | null): string | null => (s === null ? null : redactToken(s, token));
      // The files the task names that are not in the project yet: what the model is told to write first, and what the loop checks at the end.
      const files = new FileTools(req.worktree.hostPath, { ...DEFAULT_FILE_LIMITS, ...this.o.fileLimits });
      const newFiles: string[] = [];
      for (const f of namedFiles(req.message)) if (!(await files.exists(f))) newFiles.push(f);
      const messages = [
        { role: 'system' as const, content: systemPrompt({ hasSandbox: mcpSchemas.has('sandbox_exec'), hasChangeset: mcpSchemas.has('changeset_register') }) },
        { role: 'user' as const, content: userMessage({ message: redactToken(req.message, token), context: scrubbed(context), skills: scrubbed(skills), newFiles,
          hasSandbox: mcpSchemas.has('sandbox_exec'), hasChangeset: mcpSchemas.has('changeset_register') }) }
      ];

      const wallMs = Math.max(1000, req.limits.wallClockMs);
      const deadline = at() + wallMs;
      wallTimer = setTimeout(() => { why ??= 'wall'; ac.abort(); }, wallMs);
      (wallTimer as { unref?: () => void }).unref?.();
      this.note(`local model turn: ${mcpTools.length} runner tool(s) offered`);
      yield* runLoop({
        req, signal: ac.signal, endedBy: () => why, target, model: req.model.model, messages, tools, mcpSchemas,
        files, taskFiles: newFiles, mcp, token,
        caps: { turnTokens: this.o.caps?.turnTokens, toolCalls: this.o.caps?.toolCalls },
        tuning: { ...DEFAULT_TUNING, ...this.o.tuning }, now: () => at(), deadline
      });
    } finally {
      if (wallTimer) clearTimeout(wallTimer);
      signal.removeEventListener('abort', onAbort);
      this.active.delete(ac);
    }
  }

  /** Ends the turn's requests now: `start` then reports `run.cancelled`. There is no process to kill. `graceMs` delays nothing. */
  // eslint-disable-next-line @typescript-eslint/require-await
  async cancel(_runRef: string, _graceMs: number): Promise<void> {
    for (const ac of this.active) ac.abort();
  }
}

/** The per-turn (and probe) construction the registry uses. */
export function createLocalModelAdapter(o: LocalModelAdapterOptions = {}): LocalModelAdapter {
  return new LocalModelAdapter(o);
}
