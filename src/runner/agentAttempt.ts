/**
 * One agent turn, end to end (B2b Task 11): create, preflight and start the turn's own container (network `none`, the
 * session worktree bound read-write at `/workspace`); start the host egress proxy for the runtime's own host traffic
 * (Task 12); write the adapter's engine-format files into the job's config dir; run the runtime and relay its events
 * (`message.delta` chunked to at most 4 KiB, every free-text field redacted); after every granted `sandbox_exec` the
 * caller (RunnerCore's MCP relay) re-walks the worktree and the turn ends `failed: worktree_guard` on a refusal; at the
 * end the container is stopped and removed, the proxy closed, every config file but `context.md` deleted, and the turn
 * is reported `attempt.exited`.
 *
 * This module owns no attempt bookkeeping of its own (no map, no timers): everything it needs to report a fact or read
 * a flag is given through `port`, built fresh per turn by RunnerCore (core.ts), which also owns the AbortController a
 * cancel or release fires. `port.guardRefusal()` is how the worktree-guard check (run from RunnerCore's exec relay,
 * which alone has a hold of the agent-turn registry Task 6 added) reaches this orchestrator: the relay sets the flag
 * and aborts `port.signal`; this function, once its runtime loop notices the abort, reports the turn's failure as
 * `worktree_guard` rather than a plain cancel.
 */
import * as path from 'node:path';
import type { AttemptPhase, ExitReason, RefusalReason } from '../shared/nexus/runnerProtocol';
import { chunkText } from '../shared/nexus/runnerProtocol';
import type { AttemptFailureClass } from '../shared/nexus/runnerProtocol';
import type { AgentPlan, ExitInfo, PreflightReport } from '../shared/nexus/execution';
import type { AgentRuntime, RunRequest, RuntimeEvent } from '../shared/nexus/runtime';
import type { GuardRefusal } from './worktreeGuard';
import { scrub } from './logs';
import { DockerError, SpecError } from './sandbox/dockerDriver';
import type { startHostEgressProxy, HostEgressProxy } from './hostEgressProxy';
import type { RunnerDriver, RunnerFs } from './types';

export const AGENT_STOP_GRACE_MS = 10_000;

/** What `agentAttempt.run` needs: posting (already validated and scrubbed by RunnerCore), the driver, and a few hooks. */
export interface AgentAttemptPort {
  driver: RunnerDriver;
  fs: RunnerFs;
  now: () => number;
  /** The attempt's own redacted log (`LogWriter.nexus`, already bound). */
  log: (text: string) => void;
  phase: (phase: AttemptPhase) => void;
  provisioned: (containerId: string, imageDigest: string, preflight: PreflightReport) => void;
  refuse: (reason: RefusalReason, detail?: string) => Promise<void>;
  fault: (failureClass: AttemptFailureClass, message: string) => Promise<void>;
  runtimeEvent: (event: RuntimeEvent) => void;
  exited: (exit: ExitInfo, reason?: ExitReason) => void;
  bindAgentTurn: (bearer: string, attemptId: string, containerId: string) => void;
  unbindAgentTurn: (bearer: string) => void;
  /** Already constructed and bound to this turn's own bearer (src/runner/runtimes/registry.ts `runtimeFor`). */
  runtime: AgentRuntime;
  startHostEgressProxy: typeof startHostEgressProxy;
  imagesDir?: string;
  /** Set by RunnerCore's exec relay the moment a `sandbox_exec` leaves the worktree guarded tree refused; null until then. */
  guardRefusal: () => GuardRefusal | null;
  /** Fires on `attempt.cancel` or `attempt.release`. */
  signal: AbortSignal;
}

const msgOf = (e: unknown): string => String((e as Error)?.message ?? e ?? 'error').replace(/\s+/g, ' ').slice(0, 1000);

function failureClassOf(e: unknown): AttemptFailureClass {
  if (e instanceof DockerError) {
    if (e.kind === 'disk_full') return 'disk_full';
    if (e.kind === 'docker_resources') return 'docker_resources';
  }
  return 'docker_error';
}

async function stopAndRemove(driver: RunnerDriver, cid: string): Promise<void> {
  try { await driver.stop(cid, AGENT_STOP_GRACE_MS); } catch { /* best effort */ }
  try { await driver.kill(cid); } catch { /* already stopped */ }
  try { await driver.remove(cid); } catch { /* already gone */ }
}
async function safeRemove(driver: RunnerDriver, cid: string): Promise<void> {
  try { await driver.remove(cid); } catch { /* already gone, or never started */ }
}

/** Step 3: the adapter's own engine-format files (here: the `RunRequest` itself, for the runtime process to read). */
async function writeEngineFiles(fs: RunnerFs, configDir: string, req: RunRequest): Promise<void> {
  try {
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, 'request.json'), JSON.stringify(req), 'utf8');
  } catch { /* the runtime still runs: it was given the request object directly, in-process or via argv/env */ }
}

/** Step 7: every config file except `context.md` (main's write, kept for the record). */
async function cleanupEngineFiles(fs: RunnerFs, configDir: string): Promise<void> {
  let names: string[];
  try { names = await fs.readdir(configDir); } catch { return; }
  for (const name of names) {
    if (name === 'context.md') continue;
    try { await fs.rm(path.join(configDir, name), { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** Every free-text field of a runtime event, redacted (a capability token first, then the general redactor). */
function redactEvent(e: RuntimeEvent): RuntimeEvent {
  switch (e.t) {
    case 'message.delta': return { ...e, text: scrub(e.text) };
    case 'tool.started': return { ...e, argsSummary: scrub(e.argsSummary) };
    case 'approval.requested': return { ...e, summary: scrub(e.summary) };
    case 'run.failed': return { ...e, message: scrub(e.message) };
    default: return e;
  }
}

function summaryOf(e: RuntimeEvent): string {
  switch (e.t) {
    case 'run.started': return `run started (${e.runRef})`;
    case 'message.delta': return `message: ${e.text.length > 200 ? `${e.text.slice(0, 200)}…` : e.text}`;
    case 'tool.started': return `tool ${e.tool} started`;
    case 'tool.completed': return `tool call ${e.ok ? 'ok' : 'failed'} (${e.resultBytes} bytes)`;
    case 'approval.requested': return `approval requested: ${e.summary}`;
    case 'usage': return `usage: ${e.inputTokens}+${e.outputTokens} tokens, ${e.toolCalls} tool call(s)`;
    case 'run.completed': return `run completed: ${e.stopReason}`;
    case 'run.failed': return `run failed (${e.code}): ${e.message}`;
    case 'run.cancelled': return 'run cancelled';
    default: return '';
  }
}

/** Relays one runtime event: `message.delta` chunked to at most MESSAGE_DELTA_MAX_BYTES, in order; everything logged, redacted. */
function relay(port: AgentAttemptPort, raw: RuntimeEvent): void {
  const e = redactEvent(raw);
  port.log(summaryOf(e));
  if (e.t === 'message.delta') {
    for (const piece of chunkText(e.text)) port.runtimeEvent({ t: 'message.delta', text: piece });
    return;
  }
  port.runtimeEvent(e);
}

export async function run(plan: AgentPlan, port: AgentAttemptPort): Promise<void> {
  const cancelledExit = (): ExitInfo => ({ code: null, oomKilled: false, finishedAt: port.now() });

  if (port.signal.aborted) { port.exited(cancelledExit(), 'cancelled'); return; }

  // ---- step 1: create, preflight and start the container ----
  port.phase('creating');
  let cid: string;
  try {
    cid = (await port.driver.create(plan.container)).containerId;
  } catch (e) {
    if (e instanceof SpecError) await port.refuse('bad_plan', msgOf(e));
    else await port.fault(failureClassOf(e), msgOf(e));
    return;
  }
  if (port.signal.aborted) { await safeRemove(port.driver, cid); port.exited(cancelledExit(), 'cancelled'); return; }

  port.phase('preflight');
  let report: PreflightReport;
  try { report = await port.driver.preflight(cid, plan.container); }
  catch (e) { await safeRemove(port.driver, cid); await port.fault('docker_error', msgOf(e)); return; }
  if (!report.ok) {
    await safeRemove(port.driver, cid);
    port.log(`preflight refused the agent container: ${report.problems.length} problem(s)`);
    port.provisioned(cid, plan.container.image.id, report);
    return;
  }
  if (port.signal.aborted) { await safeRemove(port.driver, cid); port.exited(cancelledExit(), 'cancelled'); return; }

  port.phase('starting');
  try { await port.driver.start(cid); } catch (e) { await safeRemove(port.driver, cid); await port.fault('docker_error', msgOf(e)); return; }

  // From here the container runs and the bearer may be bound: everything below is one region whose end (success,
  // failure, throw or cancel alike) always unbinds, ends the runtime process, closes the proxy and removes the container.
  const request: RunRequest = { ...plan.runtime.request, container: { id: cid } };
  const configDir = plan.runtime.request.configDir;
  let proxy: HostEgressProxy | null = null;
  let runRef: string | null = null;
  let completedOk = false;
  let failedWith: string | null = null;
  const onAbort = (): void => { void port.runtime.cancel(runRef ?? '', AGENT_STOP_GRACE_MS).catch(() => undefined); };
  try {
    // The MCP exec relay trusts only this binding for which container a grant of this turn's bearer runs inside.
    port.bindAgentTurn(plan.runtime.token, plan.attemptId, cid);
    port.provisioned(cid, plan.container.image.id, report);
    port.phase('running');

    // ---- step 2: the host egress proxy for this turn (a failure, consent_mismatch included, fails the turn) ----
    try {
      proxy = await port.startHostEgressProxy({
        allow: plan.egress.allow,
        consentHostsSha256: plan.egress.consentHostsSha256,
        onDecision: () => { /* no attempt.event in this build: the runtime's own host traffic is not evidence */ },
        imagesDir: port.imagesDir
      });
    } catch (e) {
      failedWith = (e as { code?: unknown } | null)?.code === 'consent_mismatch' ? 'consent_mismatch' : 'proxy_failed';
      port.log(`the host egress proxy did not start: ${msgOf(e)}`);
      relay(port, { t: 'run.failed', at: port.now(), code: 'runtime_error', message: `failed: ${failedWith}` });
    }

    if (!failedWith && !port.signal.aborted) {
      // ---- step 3: the adapter's engine-format files ----
      await writeEngineFiles(port.fs, configDir, request);

      // ---- steps 4-6: run the turn, relaying events; the worktree guard (run by the exec relay) can end it early ----
      port.signal.addEventListener('abort', onAbort, { once: true });
      try {
        for await (const raw of port.runtime.start(request, port.signal)) {
          const guard = port.guardRefusal();
          // A refused worktree never ends as anything but `failed: worktree_guard`: any terminal event is overridden.
          const terminal = raw.t === 'run.completed' || raw.t === 'run.failed' || raw.t === 'run.cancelled';
          const event: RuntimeEvent = terminal && guard
            ? { t: 'run.failed', at: port.now(), code: 'runtime_error', message: `failed: worktree_guard (${guard})` }
            : raw;
          relay(port, event);
          if (event.t === 'run.started') runRef = event.runRef;
          if (event.t === 'run.completed') { completedOk = true; break; }
          if (event.t === 'run.failed' || event.t === 'run.cancelled') break;
        }
      } catch (e) {
        port.log(`the turn stopped: ${msgOf(e)}`);
      }
    }
  } finally {
    port.signal.removeEventListener('abort', onAbort);
    // ---- step 7: cleanup, always ----
    port.unbindAgentTurn(plan.runtime.token);
    // The host process is ended even when no abort fired (a turn that completed or failed with its CLI still alive).
    try { await port.runtime.cancel(runRef ?? '', AGENT_STOP_GRACE_MS); } catch { /* best effort */ }
    try { await proxy?.close(); } catch { /* best effort */ }
    await stopAndRemove(port.driver, cid);
    await cleanupEngineFiles(port.fs, configDir);
  }
  const finalGuard = port.guardRefusal();
  if (finalGuard) port.log(`the turn failed: worktree_guard (${finalGuard})`);
  if (failedWith) port.log(`the turn failed: ${failedWith}`);

  if (finalGuard || failedWith) { port.exited({ code: 1, oomKilled: false, finishedAt: port.now() }); return; }
  if (port.signal.aborted) { port.exited(cancelledExit(), 'cancelled'); return; }
  port.exited({ code: completedOk ? 0 : 1, oomKilled: false, finishedAt: port.now() });
}
