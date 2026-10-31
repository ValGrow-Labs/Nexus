/**
 * The hosted-model agent adapter (the neutral kind `hosted-model`): an `AgentRuntime` that drives a model served by a free hosted API
 * in the same tool-calling loop the local-model runtime uses (src/runner/runtimes/localModel/loop.ts, its confined host file tools,
 * its text-call recovery, caps and prompts: reused, not copied). Only the model call differs: a chat-completions client (the wire shape both providers offer)
 * (client.ts) over HTTPS through the turn's host egress proxy (transport.ts). It runs in-process in the runner.
 *
 * - Destination (H2): exactly the CHOSEN provider's host on 443, from the preset table (presets.ts, the only place a provider, host or
 *   model name lives), and only when the live consent's host list (`consentedHosts`) includes it. The request is made by the runner
 *   process through the proxy bound to that consent; never from the sandbox container, never a redirect, never another host. A
 *   request that names an endpoint other than the chosen provider's is refused with a fixed sentence.
 * - The API key (H3) comes in memory (`plan.runtime.apiKey`) and is the value of the provider's one auth header and nothing else:
 *   not in a body, URL, prompt, log line, tool result, event or failure (every failure is a fixed sentence; events are scrubbed of it
 *   once more on the way out).
 * - Tools, loop and caps: as the local-model runtime. Cost is 0 and not estimated; tokens are the provider's own counts.
 *
 * The same class answers the runner's probe (`describe`, `health`, `setup`, `check`) OFFLINE and key-blind (H7): the table's hosts,
 * labels and models, no network call at all, and no knowledge of whether a key exists (that is main's).
 */
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { MODEL_NAME_RE } from '../../../shared/nexus/localModel';
import { isRuntimeApiKey, type RuntimeSetup } from '../../../shared/nexus/runnerProtocol';
import type { AgentRuntime, RunRequest, RuntimeEvent, RuntimeHealth, RuntimeKind } from '../../../shared/nexus/runtime';
import { loopbackMcpUrl } from '../localModel/endpoint';
import { DEFAULT_FILE_LIMITS, FILE_TOOL_DEFS, FILE_TOOL_NAMES, FileTools, type FileToolLimits } from '../localModel/fileTools';
import { CONTEXT_MAX_BYTES, CORE_MCP_TOOLS, SKILLS_MAX_BYTES, readHead, type TurnCaps } from '../localModel/adapter';
import { DEFAULT_TUNING, runLoop, type LoopTuning } from '../localModel/loop';
import { McpClient, redactToken } from '../localModel/mcpClient';
import { namedFiles, systemPrompt, toolDescription, userMessage } from '../localModel/prompt';
import { DEFAULT_BACKOFF, createChatFn, type Backoff } from './client';
import { MSG } from './messages';
import { allModels, allPresetHosts, presetFor, providerList } from './presets';
import type { HostedTestSeam } from './transport';

export const HOSTED_MODEL_KIND = 'hosted-model' as RuntimeKind;
/** The runtime's display name: shown on the setup row only (D-B9). */
export const ADAPTER_LABEL = 'Hosted free-API model';
/** The probe's version string: the preset table has no server to ask. */
export const PROBE_VERSION = 'presets-1';

/** A hosted model has a bigger window than a small local one, but the free tier's per-minute token budget is small: the history stays modest. */
export const HOSTED_TUNING: Readonly<LoopTuning> = Object.freeze({ ...DEFAULT_TUNING, numCtx: 16384, numPredict: 4096, chatTimeoutMs: 120_000, nudgeTextOnly: false });

export interface HostedModelAdapterOptions {
  /** The turn's bearer (the MCP `Authorization` header only). Empty for an adapter that only answers the probe. */
  token?: string;
  /** The runner's loopback MCP URL (default: the request's own). Must be `http://127.0.0.1:<port>/...`. */
  mcpUrl?: string;
  /** The user's provider API key (from `plan.runtime.apiKey`), in memory only. */
  apiKey?: string;
  /** The turn's host egress proxy URL, once the proxy runs (null before). A turn never makes a request without one. */
  proxyUrl?: () => string | null;
  /** The hosts the live consent granted (the plan's `egress.allow`); the chosen provider's host must be one of them. Without it nothing is consented. */
  consentedHosts?: readonly { host: string; port: number }[];
  caps?: TurnCaps;
  mcpTools?: readonly string[];
  allTools?: boolean;
  /** TEST SEAM: the HTTP client for MCP calls (default: the global `fetch`). */
  fetchImpl?: typeof fetch;
  /** TEST SEAM: only changes how the allowed target is connected (see transport.ts); production never sets it. */
  seam?: HostedTestSeam;
  /** TEST SEAM: the wait between retries. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  backoff?: Partial<Backoff>;
  tuning?: Partial<LoopTuning>;
  fileLimits?: Partial<FileToolLimits>;
  /** Lines that never hold the bearer, the key, a prompt, a file's content or a path. */
  log?: (line: string) => void;
  now?: () => number;
}

/** The event with the key (if it ever appeared) replaced: a last guard; nothing puts it there. */
function scrub(e: RuntimeEvent, key: string): RuntimeEvent {
  if (key.length < 8) return e;
  const s = (t: string): string => (t.includes(key) ? t.split(key).join('[redacted]') : t);
  switch (e.t) {
    case 'message.delta': return { ...e, text: s(e.text) };
    case 'tool.started': return { ...e, argsSummary: s(e.argsSummary) };
    case 'run.failed': return { ...e, message: s(e.message) };
    case 'run.completed': return { ...e, stopReason: s(e.stopReason) };
    default: return e;
  }
}

export class HostedModelAdapter implements AgentRuntime {
  readonly kind: RuntimeKind = HOSTED_MODEL_KIND;
  private readonly active = new Set<AbortController>();

  constructor(private readonly o: HostedModelAdapterOptions = {}) {}

  private now(): number { return (this.o.now ?? Date.now)(); }
  private note(line: string): void { try { this.o.log?.(line); } catch { /* a log must never fail a turn */ } }

  // ---------------------------------------------------------------- the probe (offline, key-blind)

  /** No network call, no key: the preset table's hosts, labels and models. */
  // eslint-disable-next-line @typescript-eslint/require-await
  async describe(): ReturnType<AgentRuntime['describe']> {
    return { version: PROBE_VERSION, supportsHttpMcp: true, supportsResume: false, models: allModels().map((m) => m.name), label: ADAPTER_LABEL, egressHosts: allPresetHosts() };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async health(_o: { proxyUrl?: string } = {}): Promise<RuntimeHealth> { return { ok: true, version: PROBE_VERSION }; }

  async setup(o: { proxyUrl?: string } = {}): Promise<RuntimeSetup> { return (await this.check(o)).setup; }

  /**
   * The setup row. `signedIn` is `unknown` (whether a key exists is main's knowledge, never the runner's probe); `flagsOk` is true;
   * `egressHosts` is every provider's host; `providers` lists each with its models; `models` is every table model once (for readers
   * that only know the flat list). `proxyUrl` is accepted and ignored: the probe never makes a request.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async check(_o: { proxyUrl?: string } = {}): Promise<{ health: RuntimeHealth; setup: RuntimeSetup }> {
    return { health: { ok: true, version: PROBE_VERSION },
      setup: { signedIn: 'unknown', flagsOk: true, label: ADAPTER_LABEL, egressHosts: allPresetHosts(), models: allModels(), providers: providerList() } };
  }

  // ---------------------------------------------------------------- a turn

  async *start(req: RunRequest, signal: AbortSignal): AsyncIterable<RuntimeEvent> {
    const key = typeof this.o.apiKey === 'string' ? this.o.apiKey : '';
    for await (const e of this.turn(req, signal)) yield scrub(e, key);
  }

  private async *turn(req: RunRequest, signal: AbortSignal): AsyncIterable<RuntimeEvent> {
    const runRef = `hm-${this.now().toString(36)}-${randomBytes(6).toString('hex')}`;
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

      const preset = presetFor(req.model.provider);
      if (!preset || typeof req.model.model !== 'string' || !MODEL_NAME_RE.test(req.model.model)) { yield failed('protocol', MSG.notChosen); return; }
      // The chosen provider's host and port, and no other: a request that names an endpoint must name exactly this one, and the live consent must grant it.
      if (req.endpoint !== undefined && !(typeof req.endpoint.host === 'string' && req.endpoint.host.toLowerCase() === preset.host && req.endpoint.port === preset.port)) {
        yield failed('runtime_error', MSG.notGranted); return;
      }
      if (!(this.o.consentedHosts ?? []).some((h) => typeof h?.host === 'string' && h.host.toLowerCase() === preset.host && h.port === preset.port)) {
        yield failed('runtime_error', MSG.notGranted); return;
      }
      const apiKey = this.o.apiKey;
      if (apiKey === undefined || apiKey.length === 0) { yield failed('auth', MSG.keyMissing); return; }
      if (!isRuntimeApiKey(apiKey)) { yield failed('auth', MSG.keyRejected); return; }
      const token = this.o.token ?? '';
      if (token.length === 0) { yield failed('auth', 'no capability token was given for this turn'); return; }
      const mcpUrl = loopbackMcpUrl(this.o.mcpUrl ?? req.mcp.url);
      if (!mcpUrl) { yield failed('runtime_error', 'the Nexus MCP server address is not a loopback address'); return; }
      if (!path.isAbsolute(req.worktree.hostPath)) { yield failed('protocol', 'the worktree path is not absolute'); return; }

      const mcp = new McpClient({ url: mcpUrl.toString(), token, fetchImpl: this.o.fetchImpl });
      const listed = await mcp.listTools(ac.signal);
      // Ended while the tool list was being read (a cancel, through either door, or the wall clock): that is the turn's end, not a server fault.
      if (why === 'wall') { yield failed('limit', 'the turn ran past its wall clock'); return; }
      if (signal.aborted || ac.signal.aborted) { yield { t: 'run.cancelled', at: at() }; return; }
      if (!listed) { yield failed('runtime_error', 'the Nexus MCP server did not answer'); return; }
      const allow = this.o.mcpTools ? new Set(this.o.mcpTools) : null;
      const mcpTools = listed.filter((t) => !FILE_TOOL_NAMES.includes(t.name) && (!allow || allow.has(t.name)) && (this.o.allTools === true || CORE_MCP_TOOLS.includes(t.name)));
      const mcpSchemas = new Map(mcpTools.map((t) => [t.name, t.inputSchema] as const));
      const tools = [...FILE_TOOL_DEFS, ...mcpTools.map((t) => ({ type: 'function' as const,
        function: { name: t.name, description: toolDescription(t.name, t.description), parameters: t.inputSchema } }))];

      const [context, skills] = await Promise.all([readHead(req.context.file, CONTEXT_MAX_BYTES), readHead(path.join(req.configDir, 'skills.md'), SKILLS_MAX_BYTES)]);
      const scrubbed = (s: string | null): string | null => (s === null ? null : redactToken(s, token));
      const files = new FileTools(req.worktree.hostPath, { ...DEFAULT_FILE_LIMITS, ...this.o.fileLimits });
      const newFiles: string[] = [];
      for (const f of namedFiles(req.message)) if (!(await files.exists(f))) newFiles.push(f);
      const messages = [
        { role: 'system' as const, content: systemPrompt({ hasSandbox: mcpSchemas.has('sandbox_exec'), hasChangeset: mcpSchemas.has('changeset_register'), conversational: true }) },
        { role: 'user' as const, content: userMessage({ message: redactToken(req.message, token), context: scrubbed(context), skills: scrubbed(skills), newFiles,
          hasSandbox: mcpSchemas.has('sandbox_exec'), hasChangeset: mcpSchemas.has('changeset_register') }) }
      ];

      const tuning: LoopTuning = { ...HOSTED_TUNING, ...this.o.tuning };
      const wallMs = Math.max(1000, req.limits.wallClockMs);
      const deadline = at() + wallMs;
      wallTimer = setTimeout(() => { why ??= 'wall'; ac.abort(); }, wallMs);
      (wallTimer as { unref?: () => void }).unref?.();
      const chatFn = createChatFn({ preset, model: req.model.model, apiKey, proxyUrl: this.o.proxyUrl ?? (() => null), numPredict: tuning.numPredict,
        temperature: 0.2, backoff: { ...DEFAULT_BACKOFF, ...this.o.backoff }, numCtx: tuning.numCtx, sleep: this.o.sleep, seam: this.o.seam, log: this.o.log });
      this.note(`hosted model turn: ${mcpTools.length} runner tool(s) offered`);
      yield* runLoop({
        req, signal: ac.signal, endedBy: () => why, chatFn, model: req.model.model, messages, tools, mcpSchemas,
        files, taskFiles: newFiles, mcp, token,
        caps: { turnTokens: this.o.caps?.turnTokens, toolCalls: this.o.caps?.toolCalls },
        tuning, now: () => at(), deadline
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
export function createHostedModelAdapter(o: HostedModelAdapterOptions = {}): HostedModelAdapter {
  return new HostedModelAdapter(o);
}
