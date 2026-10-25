/**
 * The scripted agent runtime (B2b Task 11): a test double of `AgentRuntime` that runs IN-PROCESS in the runner (no
 * child process at all) and replays a fixed script of steps, calling the real loopback MCP server over real HTTP for
 * every `call` step (the same wire path a real engine adapter's `tools/call` would use) and yielding the matching
 * `RuntimeEvent`s. It exists only so the runner's own turn orchestration (agentAttempt.ts) can be exercised end to
 * end without any real agent CLI installed.
 */
import type { AgentRuntime, RunRequest, RuntimeEvent, RuntimeHealth, RuntimeKind } from '../../shared/nexus/runtime';

export const SCRIPTED_KIND = 'scripted' as RuntimeKind;

export type ScriptedStep =
  | { op: 'delta'; text: string }
  /** One `tools/call` to the real MCP server, with this turn's own bearer. */
  | { op: 'call'; tool: string; args: Record<string, unknown> }
  | { op: 'usage'; inputTokens?: number; outputTokens?: number; cacheCreationTokens?: number; cacheReadTokens?: number;
      costUsdCents?: number | null; toolCalls?: number; estimated?: boolean }
  | { op: 'complete'; stopReason?: string }
  | { op: 'fail'; code?: 'runtime_error' | 'auth' | 'limit' | 'protocol'; message?: string };

export interface ScriptedRuntimeOptions {
  /** The turn's own bearer (never logged, never put anywhere but the Authorization header). */
  token: string;
  /** The runner's loopback MCP URL (`AgentPlan.runtime.request.mcp.url`). */
  mcpUrl: string;
  steps: readonly ScriptedStep[];
  /** A test seam: the HTTP client (defaults to the global `fetch`). */
  fetchImpl?: typeof fetch;
}

function summarize(args: unknown): string {
  try { return JSON.stringify(args).slice(0, 200); } catch { return ''; }
}

/** One MCP `tools/call` over real HTTP, exactly as a real adapter's client would send it. */
async function callTool(o: ScriptedRuntimeOptions, tool: string, args: unknown, signal: AbortSignal):
  Promise<{ ok: boolean; resultBytes: number }> {
  const fetchFn = o.fetchImpl ?? globalThis.fetch;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } });
  try {
    const res = await fetchFn(o.mcpUrl, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${o.token}` },
      body
    });
    const json = await res.json() as { result?: { content?: { type: string; text: string }[]; isError?: boolean } };
    const result = json?.result;
    const text = result?.content?.[0]?.text ?? '';
    return { ok: !result?.isError, resultBytes: Buffer.byteLength(text, 'utf8') };
  } catch {
    return { ok: false, resultBytes: 0 };
  }
}

/**
 * Runs entirely in the runner's own event loop (no child process). `cancel` is a no-op: the caller's `AbortSignal`
 * (checked between every step) is the only thing that ever stops it.
 */
export class ScriptedRuntime implements AgentRuntime {
  readonly kind: RuntimeKind = SCRIPTED_KIND;
  constructor(private readonly o: ScriptedRuntimeOptions) {}

  async describe(): ReturnType<AgentRuntime['describe']> {
    return { version: '1', supportsHttpMcp: true, supportsResume: false, models: ['scripted'], label: 'Scripted test runtime', egressHosts: [] };
  }
  async health(): Promise<RuntimeHealth> { return { ok: true, version: '1' }; }

  async *start(req: RunRequest, signal: AbortSignal): AsyncIterable<RuntimeEvent> {
    const runRef = `scripted-${req.sessionId}`.slice(0, 128);
    yield { t: 'run.started', runRef, at: Date.now() };
    let callId = 0;
    for (const step of this.o.steps) {
      if (signal.aborted) { yield { t: 'run.cancelled', at: Date.now() }; return; }
      if (step.op === 'delta') {
        yield { t: 'message.delta', text: step.text };
      } else if (step.op === 'call') {
        const cid = String(++callId);
        yield { t: 'tool.started', callId: cid, tool: step.tool, argsSummary: summarize(step.args) };
        const r = await callTool(this.o, step.tool, step.args, signal);
        yield { t: 'tool.completed', callId: cid, ok: r.ok, resultBytes: r.resultBytes };
      } else if (step.op === 'usage') {
        yield {
          t: 'usage', inputTokens: step.inputTokens ?? 0, outputTokens: step.outputTokens ?? 0,
          cacheCreationTokens: step.cacheCreationTokens ?? 0, cacheReadTokens: step.cacheReadTokens ?? 0,
          costUsdCents: step.costUsdCents ?? null, toolCalls: step.toolCalls ?? 0, estimated: step.estimated ?? false
        };
      } else if (step.op === 'fail') {
        yield { t: 'run.failed', at: Date.now(), code: step.code ?? 'runtime_error', message: step.message ?? 'scripted failure' };
        return;
      } else if (step.op === 'complete') {
        yield { t: 'run.completed', at: Date.now(), stopReason: step.stopReason ?? 'end_turn' };
        return;
      }
    }
    yield { t: 'run.completed', at: Date.now(), stopReason: 'end_turn' };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async cancel(): Promise<void> { /* nothing to kill: the caller's AbortSignal already stops `start` */ }
}
