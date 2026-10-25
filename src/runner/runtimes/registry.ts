/**
 * The agent runtime registry (B2b Tasks 11 and 13): picks the `AgentRuntime` for one turn by its `RuntimeKind`. Two kinds
 * exist in this build: `scripted` (in-process, no child process: src/runner/runtimes/scripted.ts) and `cli-agent` (the
 * vendor-neutral kind every real engine adapter runs under: src/runner/runtimes/cliAgent/, the engine's own native
 * executable run on the host, confined to the turn's own worktree by policy, every actual command run through
 * `sandbox_exec` into the container).
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
import { SCRIPTED_KIND, ScriptedRuntime, type ScriptedStep } from './scripted';

export { CLI_AGENT_KIND, SCRIPTED_KIND };

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
  /** `cli-agent` only: the turn's loopback egress proxy URL, once the proxy is running (null before). The engine never starts without one. */
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
  throw new Error(`no runtime is registered for ${String(kind)}`);
}
