/**
 * The agent runtime registry (B2b Tasks 11 and 13): picks the `AgentRuntime` for one turn by its `RuntimeKind`. Four kinds
 * exist in this build: `scripted` (in-process, no child process: src/runner/runtimes/scripted.ts), `cli-agent` (the
 * vendor-neutral kind every real engine adapter runs under: src/runner/runtimes/cliAgent/, the engine's own native
 * executable run on the host, confined to the turn's own worktree by policy, every actual command run through
 * `sandbox_exec` into the container) and `local-model` (src/runner/runtimes/localModel/: a tool-calling loop in the runner
 * process against a model server on this machine, reached over loopback only; its file tools are confined to the worktree and
 * every command still runs through `sandbox_exec`) and `hosted-model` (src/runner/runtimes/hostedModel/: the same tool loop against a
 * free hosted API, reached over HTTPS through the turn's host egress proxy at exactly the chosen provider's host, with the user's key
 * held in memory and sent only as that provider's auth header).
 *
 * This file spawns nothing. The `cli-agent` adapter is the one spawn site for the engine: it resolves the native
 * executable itself (production never sets `agentBin`), builds the engine's environment from an allow-list (never the
 * runner's own), points it at the turn's loopback egress proxy and hands it the turn's bearer. The newline-JSON wire
 * Task 11 used before the real adapter existed is gone: the adapter parses the engine's own stream-json output.
 *
 * The test seams in `RuntimeTurnContext` (`agentBin`, `agentArgvPrefix`, `agentEnv`) let the runner's process-tree tests
 * run a stand-in executable through the same adapter; the runner's production path never sets them.
 */
import type { AgentRuntime, RuntimeKind } from '../../shared/nexus/runtime';
import { CLI_AGENT_KIND, createCliAgentAdapter, type Preflight, type TurnCaps } from './cliAgent/adapter';
import { sanitizeOverlay } from './cliAgent/testSeam';
import { HOSTED_MODEL_KIND, createHostedModelAdapter } from './hostedModel/adapter';
import type { HostedTestSeam } from './hostedModel/transport';
import { LOCAL_MODEL_KIND, createLocalModelAdapter } from './localModel/adapter';
import type { RuntimeProbeAdapter } from './probe';
import { SCRIPTED_KIND, ScriptedRuntime, type ScriptedStep } from './scripted';

export { CLI_AGENT_KIND, HOSTED_MODEL_KIND, LOCAL_MODEL_KIND, SCRIPTED_KIND };

/** What one turn needs to build its runtime: the bearer for MCP calls, and (kind-specific) how to reach the engine. */
export interface RuntimeTurnContext {
  token: string;
  mcpUrl: string;
  /** `scripted` only: the fixture this turn replays. */
  steps?: readonly ScriptedStep[];
  fetchImpl?: typeof fetch;
  /** `cli-agent` only, TEST SEAM: an explicit executable (a stand-in). Production leaves it unset and the adapter resolves the native one. */
  agentBin?: string;
  /** `cli-agent` only, TEST SEAM: names added to the engine's environment after its allow-list. */
  agentEnv?: NodeJS.ProcessEnv;
  /** `cli-agent` only, TEST SEAM: argv placed before the engine's own argv (a stand-in's script path). */
  agentArgvPrefix?: readonly string[];
  /**
   * The turn's loopback egress proxy URL, once the proxy is running (null before). `cli-agent`: the engine never starts without one.
   * `hosted-model`: every request to the provider goes through it (a CONNECT tunnel, then TLS); without one no request is made.
   */
  egressProxyUrl?: () => string | null;
  /** `cli-agent` only: the turn's caps (tokens, tool calls, spend), enforced by the adapter as well. */
  caps?: TurnCaps;
  /** `cli-agent` only: the Nexus MCP tools this turn may call (default: every tool the runner serves; main checks the claims). */
  mcpTools?: readonly string[];
  /** `cli-agent` only: called the moment the process is spawned (its pid is then known), to register it with procTree. */
  onSpawned?: (info: { pid: number; imageName: string }) => void | Promise<void>;
  /** `cli-agent` only: called once the process is gone (it exited, or was killed): its pidfile is forgotten, never killed later. */
  onGone?: (pid: number) => void | Promise<void>;
  taskkillBin?: string;
  /** `local-model` only: the hosts the live consent granted (the plan's `egress.allow`); the request's endpoint must be one of them. Without it only the default loopback address is consented. */
  consentedHosts?: readonly { host: string; port: number }[];
  /**
   * `hosted-model` only: the user's provider API key (`plan.runtime.apiKey`), IN MEMORY for this turn. Sent only as the chosen provider's
   * auth header; never logged, stored or put in an event. Absent: the turn fails `auth`. (`consentedHosts` above is shared with
   * `local-model`: for this kind the chosen provider's host must be one of them.)
   */
  apiKey?: string;
  /** `hosted-model` only, TEST SEAM: how the allowed target is connected (a loopback mock, a test trust root); production never sets it. */
  hostedTestSeam?: HostedTestSeam;
}

/** The version and flag check of an executable, kept across turns (keyed by the executable, its size and mtime). */
const PREFLIGHT_CACHE = new Map<string, Preflight>();

export function runtimeFor(kind: RuntimeKind, ctx: RuntimeTurnContext): AgentRuntime {
  if (kind === SCRIPTED_KIND) return new ScriptedRuntime({ token: ctx.token, mcpUrl: ctx.mcpUrl, steps: ctx.steps ?? [], fetchImpl: ctx.fetchImpl });
  if (kind === CLI_AGENT_KIND) {
    // Only the test seams ever set `agentEnv`; whatever they give is cut down to the names a test may add.
    const overlay = sanitizeOverlay(ctx.agentEnv);
    return createCliAgentAdapter({
      token: ctx.token, mcpUrl: ctx.mcpUrl, bin: ctx.agentBin, argvPrefix: ctx.agentArgvPrefix, envOverlay: overlay,
      proxyUrl: ctx.egressProxyUrl, caps: ctx.caps, mcpTools: ctx.mcpTools, onSpawned: ctx.onSpawned, onExited: ({ pid }) => ctx.onGone?.(pid),
      taskkillBin: ctx.taskkillBin, preflightCache: PREFLIGHT_CACHE
    });
  }
  if (kind === LOCAL_MODEL_KIND) {
    return createLocalModelAdapter({
      token: ctx.token, mcpUrl: ctx.mcpUrl, consentedHosts: ctx.consentedHosts, caps: ctx.caps, mcpTools: ctx.mcpTools, fetchImpl: ctx.fetchImpl
    });
  }
  if (kind === HOSTED_MODEL_KIND) {
    return createHostedModelAdapter({
      token: ctx.token, mcpUrl: ctx.mcpUrl, apiKey: ctx.apiKey, proxyUrl: ctx.egressProxyUrl, consentedHosts: ctx.consentedHosts, caps: ctx.caps,
      mcpTools: ctx.mcpTools, fetchImpl: ctx.fetchImpl, seam: ctx.hostedTestSeam
    });
  }
  throw new Error(`no runtime is registered for ${String(kind)}`);
}

/**
 * The adapters the runner's probe reports (production: the `cli-agent` adapter, sharing the preflight cache with turns, the
 * `local-model` adapter, which only reads from the loopback model server when asked, and the `hosted-model` adapter, which answers from
 * its preset table with no network call and no key). Runs nothing by itself.
 */
export function probeAdapters(): RuntimeProbeAdapter[] {
  return [createCliAgentAdapter({ preflightCache: PREFLIGHT_CACHE }), createLocalModelAdapter(), createHostedModelAdapter()];
}
