/**
 * RunnerCore (B2a Task 11): the runner utilityProcess's message loop and per-attempt state machine. It has NO database
 * and no authority: it does what main's plan says inside the sandbox rules, and reports facts that main validates
 * (`parseRunnerMessage`, then main's own state). Every outgoing message is checked here with the same parser first.
 *
 * A container attempt runs, in this order: checks (plan paths, network approval, Docker, disk) -> staging (git archive,
 * blobs re-hashed) -> create (workspace volume, deps volume, egress or service networks, all with the plan's resource
 * labels; then the container) -> preflight (`docker inspect` + the pure comparator; a failure removes the never-started
 * container and reports `provisioned { preflight.ok: false }`) -> start -> `provisioned` -> running (log stream, the
 * wall-clock backstop, the size guard; a dev deployment's probe loop) -> exit -> collect (`exit.json` beside `/out`
 * first; for node:test the per-file JUnit reports merged into `junit.xml`, each case attributed to its file from the plan:
 * junitMerge.ts; then `/out` hashed into the object store, then the parsers) -> `attempt.exited` -> wait for `attempt.release`
 * -> cleanup (containers, the workspace volume and the attempt's networks; never the work folder, the log or a deps cache).
 *
 * An approved dependency install (B2a stabilization, user constraint 5) runs with the job's Nexus egress proxy
 * (egress.ts): the plan's topology is re-checked first (`network_not_approved`); the job's internal network (no route out)
 * and outbound bridge are created; the install and the proxy are both created and preflighted before either starts; the
 * proxy starts first and must say it listens within PROXY_READY_MS; each proxy decision becomes an `attempt.event`
 * (`egress`) and an attempt-log line; the proxy is stopped when the install exits, before collect reports.
 *
 * Engine attempts (no container): `repo.snapshot` and `sde.app.assemble` (async git), and `sde.diagnose` (B2a Task 12:
 * `docker inspect` of this install's containers only, hashed attempt log ranges: diagnose.ts).
 *
 * Heartbeats start when `attempt.start` (or `attempt.adopt`) arrives and continue through staging, create and preflight,
 * every 15 s, until release. A heartbeat of an attempt being finalized after a restart says `exited`, never `missing`.
 *
 * Failures: a refusal before anything ran is `attempt.refused` (docker_missing, docker_stopped, disk_low,
 * network_not_approved, image_missing, input_changed, git_missing, bad_plan); a Docker failure of one attempt before it
 * started is a `fault` with BOTH `attemptId` and `failureClass` (disk_full, docker_resources, docker_error); a fault
 * about the runner itself has neither. Main sends no release after a refusal or a fault before start, so the runner
 * removes what it made then. A running container whose exit Docker cannot report is a `docker_error` fault too, but
 * main releases that attempt (nothing is removed before its release, as for a vanished container).
 * Free text (Docker's errors, git's errors, log lines) is redacted before it leaves; a parser result holding a
 * secret-shaped value is withheld (main would refuse it anyway); no secret leaves the runner in a message.
 */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  IMAGE_VERSIONS_RE, STEP_SEPARATOR_TOKEN, type AgentPlan, type AttemptPlan, type ContainerSpec, type EnginePlan, type ExitInfo, type OutputErrorCode,
  type ParsedOutput, type SandboxProfile, type SandboxProbe, type ServicePlan, type StagedOutput, type ToolPlan
} from '../shared/nexus/execution';
import {
  EGRESS_EVENT_MAX, parseRunnerMessage, ULID_RE, type AttemptFailureClass, type AttemptPhase, type CancelReason, type ExitReason, type McpReplyResult,
  type RefusalReason, type RunnerToMain, type SandboxExecGrant
} from '../shared/nexus/runnerProtocol';
import { expectedNetworkName } from '../shared/nexus/preflightCheck';
import { leaseFloorBytes } from '../shared/nexus/resourceGate';
import { MCP_TOOLS, SANDBOX_EXEC_OUTPUT_MAX_BYTES } from '../shared/nexus/mcpTools';
import { containsSecret, redactSecretText } from '../main/nexus/activity/redact';
import { run as runAgentAttempt, type AgentAttemptPort } from './agentAttempt';
import { diagnose, diagnoseTaskProblem } from './diagnose';
import { appManifestArgv, COMMIT_RE, GitRunner } from './git';
import { gitRead } from './gitRead';
import {
  accept as gitAccept, collect as gitCollect, ensureWorktree, fastForward as gitFastForward, GIT_FAILURE_CODES, GitFailure, HardenedGit,
  mergeCheck as gitMergeCheck, rollback as gitRollback, worktreeName
} from './gitWrite';
import { ImageBuilder } from './imageBuilder';
import { discardUnmergedReport, mergePerFileJunit } from './junitMerge';
import { lastFrameTs, LogWriter } from './logs';
import { McpServer, type McpServerHandle } from './mcpServer';
import { ObjectStore } from './objectStore';
import { collectOut, outBytes, showEntry } from './outputs';
import { parseDiscovery, discoveryFrameworkOf } from './parsers/discovery';
import { JUNIT_MAX_BYTES, parseJunit } from './parsers/junit';
import { APP_MANIFEST_MAX_BYTES, parseAppManifest } from './parsers/manifest';
import { ensureDirUnder, errCode, HomePaths, noLinkUnder } from './paths';
import { httpProbe, type HttpProbe } from './probe';
import { ProcTree } from './procTree';
import { findAttemptDir, readPlanRecord, reconcileAnswer, releaseByLabels, removeResources, type PlanRecord } from './reconcile';
import { startHostEgressProxy } from './hostEgressProxy';
import type { AgentRuntime } from '../shared/nexus/runtime';
import type { ScriptedStep } from './runtimes/scripted';
import { runtimeFor } from './runtimes/registry';
import { RuntimeProber, type RuntimeProbeAdapter } from './runtimes/probe';
import { DEPS_VOLUME_RE, DockerError, SpecError } from './sandbox/dockerDriver';
import type { DockerRunner } from './sandbox/dockerCli';
import { DU_ARGV, GUARD_POLL_MS, guardDecision, parseDuKib, WORKSPACE_MAX_BYTES, type GuardTrip } from './sandbox/sizeGuard';
import { forwarderWithPort, mergePreflight, pickPort, serviceNetworkProblem } from './service';
import { classifyProxyLine, egressTopologyProblem, LineSplitter, mergeProxyPreflight, PROXY_LOG_LINES_MAX, PROXY_READY_MS } from './egress';
import { stageInputs } from './staging';
import { REAL_TIMERS, type RunnerDriver, type RunnerFs, type RunnerTimers, type RunnerTransport } from './types';
import { walk as guardWalk, type GuardRefusal } from './worktreeGuard';

export const HEARTBEAT_MS = 15_000;
/**
 * The runner's own wall-clock backstop fires at this multiple of the plan's wall clock. Main is the authority for
 * timeouts (it sends `attempt.cancel { reason: 'timeout' }` first); its stall exclusions are capped at 1 x the wall
 * clock, so the runner never ends work main still counts as in time.
 */
export const RUNNER_WALL_FACTOR = 2;
export const STOP_GRACE_MS = 10_000;
/** The longest an app-quit shutdown waits for an aborted agent turn to remove its own container. */
export const AGENT_SHUTDOWN_WAIT_MS = 15_000;
export const LOG_DRAIN_MS = 5_000;
/**
 * B2b: the longest a relayed `mcp.call` waits for main's `mcp.reply` before the agent is told it timed out. It must
 * exceed `changeset_register`'s own 120 s wait for ingest (CHANGESET_REGISTER_WAIT_MS), or the agent would get `timeout`
 * at the relay and never the documented `{ pending }` answer.
 */
export const MCP_CALL_TIMEOUT_MS = 130_000;
const ID_RE = /^[0-9A-Za-z_-]{1,64}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const MAX_GC_LIST = 20_000;
/** The B2b git write engines (src/runner/gitWrite.ts), each run as a system child job. */
export const GIT_WRITE_ENGINES: readonly string[] = Object.freeze(['repo.worktree', 'changeset.collect', 'changeset.merge_check', 'changeset.accept',
  'changeset.accept_rollback', 'repo.ff']);
/** Whether `p` is `root` or inside it. */
function insideRoot(p: string, root: string): boolean {
  const a = path.resolve(root); const b = path.resolve(p);
  const rel = process.platform === 'win32' ? path.relative(a.toLowerCase(), b.toLowerCase()) : path.relative(a, b);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export interface RunnerDeps {
  driver: RunnerDriver;
  now: () => number;
  fs: RunnerFs;
  timers?: RunnerTimers;
  log?: (line: string) => void;
  /** `infra/images` (the image build contexts). */
  imagesDir?: string;
  /** The Docker CLI for image builds (null: builds are reported failed). */
  docker?: DockerRunner | null;
  probeHttp?: HttpProbe;
  freeBytes?: (dir: string) => Promise<number | null>;
  sleep?: (ms: number) => Promise<void>;
  /** Test-only bounds. */
  limits?: { logCapBytes?: number; workspaceMaxBytes?: number };
  /** The dev deployment port picker (tests make it deterministic). */
  pickPort?: (taken: ReadonlySet<number>) => number;
  /** Called after a `shutdown` message was handled (the entry exits the process). */
  onShutdown?: () => void;
  /** The git resolver (tests inject one); default: src/main/gitBinary.ts (a found binary is kept, a miss asked again). */
  resolveGit?: () => Promise<string | null>;
  /**
   * B2b Task 14: the adapters whose health `probe.result.runtimes` reports (the runner entry passes the real ones). Without
   * it the runner reports none, so a test never runs an engine. Their health runs under a deny-all proxy before consent and
   * the allow-list proxy only after it (runtimes/probe.ts).
   */
  runtimeProbe?: { adapters: () => readonly RuntimeProbeAdapter[]; startProxy?: typeof startHostEgressProxy; timeoutMs?: number; ttlMs?: number };
  /**
   * B2b Tasks 11 and 13: how an agent turn's runtime is built. Production sets none of this: the `cli-agent` adapter
   * resolves the engine's native executable itself and builds its environment from an allow-list. Tests use
   * `agentBin`, `agentArgvPrefix` and `agentEnv` to run a stand-in executable through that same adapter (the process-tree
   * behavior), and `scriptFor` for the in-process `scripted` kind's fixture.
   */
  agentRuntime?: {
    scriptFor?: (plan: AgentPlan) => readonly ScriptedStep[];
    agentBin?: string;
    agentEnv?: NodeJS.ProcessEnv;
    agentArgvPrefix?: readonly string[];
    fetchImpl?: typeof fetch;
    taskkillBin?: string;
    /** Test observability only: called whenever a `cli-agent` turn's process is spawned (after it is recorded). */
    onSpawned?: (info: { pid: number; imageName: string }) => void;
    /** Test seams: a runtime built per plan (replacing the registry's), and the host proxy starter. */
    makeRuntime?: (plan: AgentPlan) => AgentRuntime;
    startProxy?: typeof startHostEgressProxy;
  };
}

type Kind = 'tool' | 'service' | 'engine' | 'agent';

interface AttemptState {
  id: string; jobId: string; n: number; kind: Kind;
  plan: AttemptPlan | null;
  workDir: string; logPath: string;
  seq: number;
  log: LogWriter | null;
  abort: AbortController;
  logAbort: AbortController;
  logDone: Promise<void> | null;
  heartbeat: unknown;
  timers: { h: unknown; interval: boolean }[];
  containers: string[];
  main: string | null;
  volumes: string[];
  networks: string[];
  containerState: 'running' | 'exited' | 'missing' | null;
  outBytes: number;
  cancel: { graceMs: number; reason: CancelReason } | null;
  timedOut: boolean;
  guard: GuardTrip | null;
  released: boolean;
  settled: boolean;
  finalizing: boolean;
  cleaned: boolean;
  /** The cancel's stop was issued (once). */
  stopIssued: boolean;
  /** Picked up after a restart: its volumes and networks are found by label at cleanup. */
  adopted: boolean;
  /** The container is still there but Docker cannot report its exit: reported as a `docker_error` fault, never `missing`. */
  exitUnreadable: boolean;
  hostPort?: number;
  /** An approved install's egress proxy container, its log stream, and how many decisions were reported. */
  proxy?: { id: string; logDone: Promise<void> | null; ready: boolean; onReady: (() => void) | null; events: number; lines: number; capped: boolean };
  /** B2b Task 11: set by the MCP exec relay (onExecGrant) when the worktree guard refuses the tree after an agent's exec. */
  agentGuardRefusal?: GuardRefusal;
  /** B2b Task 11: settles when the agent turn's orchestrator (agentAttempt.run) has finished, container removed. */
  agentDone?: Promise<void>;
}

/** What `exit.json` beside `/out` records at collect time (the exit is never re-derived from Docker after that). */
interface ExitRecord { attemptId: string; exit: ExitInfo; reason?: ExitReason; guard?: OutputErrorCode }

class Stop extends Error { constructor() { super('stopped'); this.name = 'Stop'; } }

/**
 * The class of an attempt's failure before its container ran: no space (Docker's or the data home's) is `disk_full`
 * (the job waits for disk); another file system failure is `io_error`; anything else `docker_error`.
 */
export function failureClassOf(e: unknown): 'disk_full' | 'io_error' | 'docker_error' {
  if (e instanceof DockerError) return e.kind === 'disk_full' ? 'disk_full' : 'docker_error';
  const code = errCode(e);
  if (code === 'ENOSPC' || code === 'EDQUOT') return 'disk_full';
  if (/^E[A-Z]+$/.test(code)) return 'io_error';
  return 'docker_error';
}

const msgOf = (e: unknown): string => redactSecretText(String((e as Error)?.message ?? e ?? 'error')).replace(/\s+/g, ' ').slice(0, 1000);

export class RunnerCore {
  private readonly driver: RunnerDriver;
  private readonly fs: RunnerFs;
  private readonly now: () => number;
  private readonly timers: RunnerTimers;
  private readonly log: (line: string) => void;
  private readonly probeHttp: HttpProbe;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly freeBytes: (dir: string) => Promise<number | null>;
  private readonly attempts = new Map<string, AttemptState>();
  private bootId: string | null = null;
  private home = '';
  private profiles: SandboxProfile[] = [];
  private paths: HomePaths | null = null;
  private store: ObjectStore | null = null;
  private git: GitRunner | null = null;
  /** B2b: the hardened launcher of the git write engines and `git.read`. */
  private gitw: HardenedGit | null = null;
  private readonly builder: ImageBuilder;
  private stopped = false;
  private recordSeq = 0;
  /** B2b Task 6: the loopback MCP server (started at `hello`), the relayed calls awaiting main's `mcp.reply`, and the
   *  bearer -> {attemptId, containerId} registry a `sandbox_exec` grant is run against (never anything main's reply
   *  names: it carries no container identity at all). */
  private mcpServer: McpServerHandle | null = null;
  private readonly pendingMcp = new Map<string, (r: McpReplyResult) => void>();
  private readonly agentTurns = new Map<string, { attemptId: string; containerId: string }>();
  /** B2b Task 11: this install's agent process trees (src/runner/procTree.ts); built once a data home is known. */
  private procTree: ProcTree | null = null;

  constructor(private readonly port: RunnerTransport, private readonly deps: RunnerDeps) {
    this.driver = deps.driver;
    this.fs = deps.fs;
    this.now = deps.now;
    this.timers = deps.timers ?? REAL_TIMERS;
    this.log = deps.log ?? ((l) => { try { process.stderr.write(`${l}\n`); } catch { /* no stderr */ } });
    this.probeHttp = deps.probeHttp ?? httpProbe;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => this.timers.setTimeout(r, ms)));
    this.freeBytes = deps.freeBytes ?? (async (dir) => {
      try { const s = await this.fs.statfs(dir); const n = Number(s.bavail) * Number(s.bsize); return Number.isFinite(n) ? n : null; } catch { return null; }
    });
    this.builder = new ImageBuilder(deps.docker ?? { binary: async () => null, run: async () => ({ code: null, signal: null, stdout: '', stderr: '',
      stdoutBytes: 0, truncated: false, timedOut: false, aborted: false, error: 'ENOENT' }) },
    { fs: this.fs, imagesDir: deps.imagesDir ?? '', paths: () => this.paths, now: this.now, post: (m) => this.post(m), log: this.log });
    port.on('message', (data) => { void this.dispatch(data); });
  }

  // ---------- transport ----------

  /** Every outgoing message is checked with main's own parser; one that does not parse is never sent. */
  private post(m: RunnerToMain): void {
    let msg: RunnerToMain = this.scrub(m);
    let parsed = parseRunnerMessage(msg);
    if (!parsed && msg.op === 'attempt.exited' && msg.parsed.length > 0) {
      this.log('[runner] a parser result is out of the protocol bounds; the exit is reported without it');
      msg = { ...msg, parsed: [] };
      parsed = parseRunnerMessage(msg);
    }
    if (!parsed) { this.log(`[runner] an outgoing ${String(m?.op)} message did not pass the protocol check; it was not sent`); return; }
    try { this.port.postMessage(parsed); } catch { this.log('[runner] the port to main is closed'); }
  }

  /** Free text redacted (again); parser results with a secret-shaped value withheld. */
  private scrub(m: RunnerToMain): RunnerToMain {
    switch (m.op) {
      case 'fault': return { ...m, message: redactSecretText(m.message).slice(0, 2000) || 'fault' };
      case 'attempt.refused': return m.detail !== undefined ? { ...m, detail: redactSecretText(m.detail).slice(0, 2000) } : m;
      case 'image.build.progress': return { ...m, phase: redactSecretText(m.phase).slice(0, 500) || 'building' };
      case 'image.build.done': return m.error !== undefined ? { ...m, error: redactSecretText(m.error).slice(0, 2000) || 'failed' } : m;
      case 'attempt.exited': {
        const entry = m.outputErrorEntry !== undefined ? { outputErrorEntry: redactSecretText(m.outputErrorEntry).slice(0, 400) || '?' } : {};
        const withheld = m.parsed.find((p) => containsSecret(p.normalized));
        if (!withheld) return { ...m, ...entry };
        // Never silent: the outputs are refused with a reason main can show (`secret_in_report`), and nothing of
        // them travels (no output of a refused /out is trusted).
        this.log(`[runner] the ${withheld.parser} result holds a secret-shaped value; it was withheld`);
        if (m.outputError) return { ...m, outputs: [], parsed: [], ...entry };
        const source = m.outputs.find((o) => o.sha256 === withheld.sourceSha256)?.relPath ?? withheld.parser;
        return { ...m, outputs: [], parsed: [], outputError: 'secret_in_report', outputErrorEntry: source };
      }
      default: return m;
    }
  }

  private async dispatch(raw: unknown): Promise<void> {
    const m = raw as { op?: unknown } & Record<string, unknown>;
    if (typeof m !== 'object' || m === null || typeof m.op !== 'string') return;
    if (this.stopped && m.op !== 'hello') return;
    try {
      switch (m.op) {
        case 'hello': return await this.onHello(m);
        case 'mcp.reply': this.onMcpReply(m); return;
        case 'probe': return await this.onProbe(m.runtimes === true, typeof m.consentHostsSha256 === 'string' ? m.consentHostsSha256 : null);
        case 'attempt.start': return await this.onStart(m.attemptId as string, m.plan as AttemptPlan);
        case 'attempt.cancel': return await this.onCancel(m.attemptId as string, m.graceMs as number, m.reason as CancelReason);
        case 'attempt.adopt': return await this.onAdopt(m.attemptId as string, m.containerId as string, m.logPath as string);
        case 'attempt.release': return await this.onRelease(m.attemptId as string);
        case 'reconcile.list': return await this.onReconcile(m.attempts as { attemptId: string; containerId: string; kind: 'tool' | 'service' }[]);
        case 'reconcile.remove': return await this.onRemove(m.resources as { kind: 'container' | 'volume' | 'network'; id: string }[]);
        case 'image.build.start': {
          if (!this.paths) return;
          void this.builder.start(m as unknown as Parameters<ImageBuilder['start']>[0]);
          return;
        }
        case 'image.build.cancel': this.builder.cancel(String(m.buildId)); return;
        case 'blob.verify': return await this.onVerify(m.sha256 as string);
        case 'gc.scan': return await this.onGcScan(m.scanId as string, m.olderThanMs as number);
        case 'gc.apply': return await this.onGcApply(m.objects as string[], m.workDirs as { jobId: string; attemptN: number }[]);
        case 'git.read': return await this.onGitRead(m.reqId, m.task);
        case 'agent.shutdownTrees': await this.procTree?.shutdownTrees(); return;
        case 'shutdown': await this.shutdown(); this.deps.onShutdown?.(); return;
        default: this.log(`[runner] unknown op ${String(m.op).slice(0, 40)} ignored`);
      }
    } catch (e) {
      // A fault about the runner itself: no attempt named, no class (both or neither).
      this.log(`[runner] ${String(m.op).slice(0, 40)} failed: ${msgOf(e)}`);
      this.post({ op: 'fault', message: `the runner could not handle ${String(m.op).slice(0, 40)}` });
    }
  }

  // ---------- hello, probe ----------

  private async onHello(m: Record<string, unknown>): Promise<void> {
    if (typeof m.bootId !== 'string' || !ULID_RE.test(m.bootId) || typeof m.dataHome !== 'string' || typeof m.home !== 'string') {
      this.log('[runner] hello is malformed'); return;
    }
    if (m.home !== '' && !/^[0-9a-f]{16}$/.test(m.home)) { this.log('[runner] hello carries a malformed install label'); return; }
    this.bootId = m.bootId;
    this.home = m.home;
    this.profiles = Array.isArray(m.profiles) ? (m.profiles as SandboxProfile[]).filter((p) => p && typeof p.id === 'string') : [];
    try {
      this.paths = m.dataHome ? new HomePaths(m.dataHome) : null;
    } catch { this.paths = null; }
    this.store = this.paths ? new ObjectStore(this.paths, this.fs, this.sleep) : null;
    // git runs from the data home (never from a repository folder), the repository named with -C.
    this.git = this.paths ? new GitRunner({ cwd: this.paths.root, resolve: this.deps.resolveGit }) : null;
    this.gitw = this.paths ? new HardenedGit({ cwd: this.paths.root, resolve: this.deps.resolveGit }) : null;
    // B2b Task 11: a runner crash within this SAME main boot leaves orphaned agent process trees (their pidfiles);
    // they are killed now. A pidfile from another main boot is only deleted (its process is inert: dead proxy, MCP
    // port and token).
    this.procTree = this.paths ? new ProcTree({ fs: this.fs, root: this.paths.root, taskkillBin: this.deps.agentRuntime?.taskkillBin, log: this.log }) : null;
    if (this.procTree) await this.procTree.killRecorded(m.bootId);
    this.stopped = false;
    // B2b Task 6: a fresh loopback MCP server each hello (a prior one, if any, is closed first; a restart never
    // leaves two listening). Relayed calls from before are abandoned: nothing still waits on their HTTP response.
    await this.closeMcpServer();
    let mcpUrl: string | null = null;
    try {
      this.mcpServer = await McpServer({
        onCall: (callId, bearer, tool, args) => this.onMcpCall(callId, bearer, tool, args),
        onExecGrant: (bearer, grant) => this.onExecGrant(bearer, grant),
        log: this.log
      });
      mcpUrl = this.mcpServer.url;
    } catch (e) { this.log(`[runner] the loopback MCP server could not start: ${msgOf(e)}`); }
    this.post({ op: 'ready', bootId: m.bootId, mcpUrl });
  }

  private async closeMcpServer(): Promise<void> {
    if (this.mcpServer) { try { await this.mcpServer.close(); } catch { /* best effort */ } this.mcpServer = null; }
    this.pendingMcp.clear();
    this.agentTurns.clear();
  }

  // ---------- B2b Task 6: the MCP relay and the sandbox exec it grants ----------

  /**
   * B2b: binds an agent turn's bearer token to the attempt whose own container a `sandbox_exec` grant for it must run
   * inside (Task 11 calls this when an agent turn's container starts and runs; a test calls it directly). The exec
   * relay below trusts only this registry for which container to run a grant in, never main's reply: a
   * `SandboxExecGrant` carries no container identity at all, so a token whose turn has ended (unbound) is refused,
   * never run against whatever container its old registration (or anything else) might otherwise suggest.
   */
  bindAgentTurn(bearer: string, attemptId: string, containerId: string): void { this.agentTurns.set(bearer, { attemptId, containerId }); }
  /** The turn ended: its token no longer resolves to any container. */
  unbindAgentTurn(bearer: string): void { this.agentTurns.delete(bearer); }

  /** Relays one `tools/call` to main as `mcp.call`, and resolves with its `mcp.reply` (or a timeout). */
  private onMcpCall(callId: string, bearer: string, tool: string, args: unknown): Promise<McpReplyResult> {
    const msg: RunnerToMain = { op: 'mcp.call', callId, bearer, tool, args };
    // Checked with main's own parser before anything is registered: a call that could never be sent (bounds, shape)
    // answers now, so the HTTP request is never left waiting on a reply that will never come.
    if (!parseRunnerMessage(msg)) return Promise.resolve({ ok: false, code: 'bad_args', message: 'the call could not be relayed' });
    return new Promise((resolve) => {
      const timer = this.timers.setTimeout(() => {
        if (this.pendingMcp.delete(callId)) resolve({ ok: false, code: 'timeout', message: 'main did not answer in time' });
      }, MCP_CALL_TIMEOUT_MS);
      this.pendingMcp.set(callId, (r) => { this.timers.clearTimeout(timer); resolve(r); });
      this.post(msg);
    });
  }

  /** Main's answer to one relayed call. The first reply for a `callId` wins; a later or unknown one is ignored. */
  private onMcpReply(m: Record<string, unknown>): void {
    if (typeof m.callId !== 'string') return;
    const resolve = this.pendingMcp.get(m.callId);
    if (!resolve) return;
    this.pendingMcp.delete(m.callId);
    const r = m.result as { ok?: unknown };
    if (!r || typeof r !== 'object' || typeof r.ok !== 'boolean') { resolve({ ok: false, code: 'bad_reply', message: 'main sent a malformed reply' }); return; }
    resolve(m.result as McpReplyResult);
  }

  /**
   * A granted `sandbox_exec`: run in the bearer's own registered container (defence in depth — never anywhere else),
   * the redacted and capped output returned to the agent alone; main hears only `agent.exec.done` (counts and a
   * sha256 of the raw stdout, never its text).
   */
  private async onExecGrant(bearer: string, grant: SandboxExecGrant): Promise<McpReplyResult> {
    const reg = this.agentTurns.get(bearer);
    if (!reg) return { ok: false, code: 'unknown_attempt', message: 'no running turn holds this token' };
    const a = this.attempts.get(reg.attemptId);
    // A turn that was cancelled, released, refused by the worktree guard or is shutting down runs nothing more.
    if (this.stopped || (a && (a.abort.signal.aborted || a.agentGuardRefusal))) {
      return { ok: false, code: 'turn_ended', message: 'this turn has ended; no command is run' };
    }
    const controller = new AbortController();
    const timer = this.timers.setTimeout(() => controller.abort(), grant.timeoutMs + 5_000);
    let r: Awaited<ReturnType<RunnerDriver['exec']>> | null = null;
    let execError: unknown = null;
    try {
      r = await this.driver.exec(reg.containerId, grant.argv, { timeoutMs: grant.timeoutMs, signal: controller.signal, maxOutputBytes: SANDBOX_EXEC_OUTPUT_MAX_BYTES });
    } catch (e) {
      execError = e;
    } finally {
      this.timers.clearTimeout(timer);
    }
    if (r) {
      this.post({ op: 'agent.exec.done', attemptId: reg.attemptId, execId: grant.execId, exit: r.exit, stdoutBytes: Buffer.byteLength(r.stdout, 'utf8'),
        stderrBytes: Buffer.byteLength(r.stderr, 'utf8'), stdoutSha256: createHash('sha256').update(r.stdout, 'utf8').digest('hex'), truncated: r.truncated });
    }
    // B2b Task 11: the attempt log keeps a redacted record of every exec (LogWriter redacts it again regardless), and the
    // worktree is re-walked after EVERY exec, one that failed, timed out or was aborted included: whatever the agent's
    // tools or the command planted in the read-write bind mount is caught before anything else looks at the tree.
    if (a && a.kind === 'agent' && a.plan && a.plan.kind === 'agent') {
      a.log?.nexus(r
        ? `sandbox_exec ${grant.argv.join(' ')} -> exit ${r.exit.code ?? 'null'}${r.stdout ? `
stdout: ${r.stdout}` : ''}${r.stderr ? `
stderr: ${r.stderr}` : ''}`
        : `sandbox_exec ${grant.argv.join(' ')} -> failed: ${msgOf(execError)}`);
      if (!a.agentGuardRefusal) {
        const g = await guardWalk(a.plan.worktree.hostPath);
        if (!g.ok) {
          a.agentGuardRefusal = g.code;
          a.log?.nexus(`the worktree guard refused the tree after an exec: ${g.code} (${g.entry})`);
          a.abort.abort();
        }
      }
    }
    if (!r) return { ok: false, code: 'exec_failed', message: msgOf(execError) };
    return { ok: true, value: { exit: r.exit, stdout: redactSecretText(r.stdout), stderr: redactSecretText(r.stderr), truncated: r.truncated } };
  }

  private runtimeProber: RuntimeProber | null = null;

  private async onProbe(withRuntimes = false, consentHostsSha256: string | null = null): Promise<void> {
    const gpu = { detected: false, usableInContainers: false as const };
    let probe: SandboxProbe;
    try { probe = await this.driver.probe(); } catch { probe = { docker: 'stopped', gpu }; }
    const images = [];
    for (const p of this.profiles) {
      let info: { present: boolean; digestMatches: boolean; sizeBytes?: number; imageId?: string; contextSha256?: string; versions?: string } = { present: false, digestMatches: false };
      if (probe.docker === 'running') { try { info = await this.driver.imageInfo(p.id); } catch { /* not present */ } }
      images.push({ profile: p.id, present: info.present, digestMatches: info.digestMatches,
        ...(info.sizeBytes !== undefined ? { sizeBytes: info.sizeBytes } : {}),
        ...(info.imageId && /^sha256:[0-9a-f]{64}$/.test(info.imageId) ? { imageId: info.imageId } : {}),
        ...(info.contextSha256 && SHA_RE.test(info.contextSha256) ? { contextSha256: info.contextSha256 } : {}),
        ...(typeof info.versions === 'string' && info.versions.length <= 300 && IMAGE_VERSIONS_RE.test(info.versions) ? { versions: info.versions } : {}) });
    }
    const free = this.paths ? await this.freeBytes(this.paths.root) : null;
    const result = { op: 'probe.result' as const, probe, images,
      freeBytes: free !== null && Number.isSafeInteger(Math.floor(free)) && free >= 0 ? Math.floor(free) : null };
    // The sandbox facts the scheduler leases against go out at once; the engine check never holds them back.
    this.post({ ...result, runtimes: [] });
    // The engine is checked only when main asked (a refresh of the runtime check), and its answer follows as a second message.
    if (withRuntimes && this.deps.runtimeProbe) {
      void this.probeRuntimes(consentHostsSha256).then((runtimes) => { if (runtimes.length > 0) this.post({ ...result, runtimes }); }).catch(() => undefined);
    }
  }

  /** `probe.result.runtimes`: the adapters' health through a deny-all proxy (no consent) or the allow-list proxy (after consent). */
  private async probeRuntimes(consentHostsSha256: string | null): Promise<Awaited<ReturnType<RuntimeProber['probe']>>> {
    const rp = this.deps.runtimeProbe;
    if (!rp) return [];
    this.runtimeProber ??= new RuntimeProber({ adapters: rp.adapters, now: this.now, log: this.log, imagesDir: this.deps.imagesDir,
      startProxy: rp.startProxy ?? this.deps.agentRuntime?.startProxy, timeoutMs: rp.timeoutMs, ttlMs: rp.ttlMs });
    try { return await this.runtimeProber.probe(consentHostsSha256); } catch { return []; }
  }

  // ---------- attempt state ----------

  private newState(id: string, jobId: string, n: number, kind: Kind, plan: AttemptPlan | null, workDir: string, logPath: string): AttemptState {
    const a: AttemptState = { id, jobId, n, kind, plan, workDir, logPath, seq: 0, log: null, abort: new AbortController(), logAbort: new AbortController(),
      logDone: null, heartbeat: null, timers: [], containers: [], main: null, volumes: [], networks: [], containerState: null, outBytes: 0,
      cancel: null, timedOut: false, guard: null, released: false, settled: false, finalizing: false, cleaned: false, stopIssued: false, adopted: false,
      exitUnreadable: false };
    // Progress events are numbered from this process's clock, so a runner restarted mid-session (adopting the attempt)
    // continues above what the previous process sent (main drops a seq that is not after the last one).
    a.seq = Math.max(0, Math.floor(this.now())) * 1000;
    this.attempts.set(id, a);
    return a;
  }

  /** For tests: the attempts this runner holds. */
  held(): string[] { return [...this.attempts.keys()]; }

  private heartbeatOnce(a: AttemptState): void {
    if (a.cleaned) return;
    // An attempt being finalized after a restart never says `missing` (its exit is recorded beside /out).
    const state = a.containerState === null ? undefined : a.finalizing ? 'exited' : a.containerState;
    this.post({ op: 'attempt.heartbeat', attemptId: a.id, at: this.now(), logBytes: a.log?.bytes() ?? 0, outBytes: a.outBytes,
      ...(state ? { container: state } : {}) });
  }

  private startHeartbeat(a: AttemptState): void {
    this.heartbeatOnce(a);
    a.heartbeat = this.timers.setInterval(() => this.heartbeatOnce(a), HEARTBEAT_MS);
  }

  private event(a: AttemptState, phase: AttemptPhase): void {
    if (a.released || a.cleaned) return;
    this.post({ op: 'attempt.event', attemptId: a.id, seq: ++a.seq, event: { t: 'phase', phase, at: this.now() } });
  }

  private after(a: AttemptState, ms: number, fn: () => void, interval = false): void {
    const h = interval ? this.timers.setInterval(fn, ms) : this.timers.setTimeout(fn, ms);
    a.timers.push({ h, interval });
  }

  /** Ends the in-memory life of an attempt (timers, heartbeats, streams). Nothing in Docker or on disk is touched. */
  private end(a: AttemptState): void {
    if (a.heartbeat !== null) { this.timers.clearInterval(a.heartbeat); a.heartbeat = null; }
    for (const t of a.timers.splice(0)) (t.interval ? this.timers.clearInterval(t.h) : this.timers.clearTimeout(t.h));
    a.logAbort.abort();
    // The log is closed with the attempt's life (an open file would keep its folder from being removed on Windows).
    if (a.log) void a.log.close().catch(() => undefined);
    if (this.attempts.get(a.id) === a) this.attempts.delete(a.id);
  }

  /** Removes what the runner made for the attempt (containers, networks, the workspace volume). Never the work folder, the log or a deps cache. */
  private async cleanup(a: AttemptState): Promise<void> {
    if (a.cleaned) return;
    a.cleaned = true;
    this.end(a);
    a.abort.abort();
    try { await a.log?.close(); } catch { /* closed */ }
    for (const c of a.containers.splice(0)) { try { await this.driver.remove(c); } catch (e) { this.log(`[runner] container not removed: ${msgOf(e)}`); } }
    for (const n of a.networks.splice(0)) { try { await this.driver.removeNetwork(n); } catch (e) { this.log(`[runner] network not removed: ${msgOf(e)}`); } }
    for (const v of a.volumes.splice(0)) { try { await this.driver.removeVolume(v); } catch (e) { this.log(`[runner] volume not removed: ${msgOf(e)}`); } }
    // An attempt picked up after a restart: what the previous process made is found by its labels (never a deps cache).
    if (a.adopted && a.released) await releaseByLabels({ driver: this.driver, home: this.home, log: this.log }, a.id);
  }

  /** The attempt's exit cannot be known (waitExit said so): its container disappeared, or Docker cannot report its exit. */
  private vanished(a: AttemptState): boolean { return a.containerState === 'missing' || a.exitUnreadable; }

  private checkStop(a: AttemptState): void { if (a.released || a.cancel || this.stopped) throw new Stop(); }

  /** A refusal before anything ran (no release follows): what was made is removed now. */
  private async refuse(a: AttemptState, reason: RefusalReason, detail?: string): Promise<void> {
    a.log?.nexus(`the runner refused the attempt: ${reason}${detail ? ` (${detail})` : ''}`);
    this.post({ op: 'attempt.refused', attemptId: a.id, reason, ...(detail ? { detail: detail.slice(0, 1000) } : {}) });
    a.settled = true;
    await this.cleanup(a);
  }

  /** A Docker failure of one attempt before it started: BOTH the attempt and its class (no release follows). */
  private async fault(a: AttemptState, failureClass: AttemptFailureClass, message: string): Promise<void> {
    a.log?.nexus(`the container could not be created or started: ${message}`);
    this.post({ op: 'fault', message, attemptId: a.id, failureClass });
    a.settled = true;
    await this.cleanup(a);
  }

  /** Docker's failure as a refusal or a classed fault. */
  private async dockerFailure(a: AttemptState, e: unknown): Promise<void> {
    if (e instanceof SpecError) return this.refuse(a, 'bad_plan', e.message);
    if (!(e instanceof DockerError)) return this.fault(a, failureClassOf(e), msgOf(e));
    const kind = e.kind;
    if (kind === 'image_missing') return this.refuse(a, 'image_missing', msgOf(e));
    const cls = kind === 'disk_full' ? 'disk_full' : kind === 'docker_resources' ? 'docker_resources' : 'docker_error';
    return this.fault(a, cls, msgOf(e));
  }

  private async openLog(a: AttemptState): Promise<void> {
    if (!this.paths || a.log) return;
    const w = new LogWriter(this.fs, this.paths.root, a.logPath, { now: this.now, capBytes: this.deps.limits?.logCapBytes });
    try { await w.open(); a.log = w; } catch (e) { this.log(`[runner] the attempt log could not be opened: ${msgOf(e)}`); }
  }

  /** Writes a record beside in/ and out/ atomically (a temporary file renamed into place): a reader sees the old or the new one. */
  private async writeRecord(a: AttemptState, name: 'plan.json' | 'exit.json', value: unknown): Promise<void> {
    if (!this.paths || !(await noLinkUnder(this.fs, this.paths.root, path.join(a.workDir, name)))) return;
    const tmp = path.join(a.workDir, `.${name}.${process.pid}.${++this.recordSeq}.tmp`);
    try {
      await this.fs.writeFile(tmp, JSON.stringify(value), 'utf8');
      await this.fs.rename(tmp, path.join(a.workDir, name));
    } catch (e) {
      this.log(`[runner] ${name} not written: ${msgOf(e)}`);
      try { await this.fs.unlink(tmp); } catch { /* not there */ }
    }
  }

  private async readExit(dir: string): Promise<ExitRecord | null> {
    try {
      const st = await this.fs.lstat(path.join(dir, 'exit.json'));
      if (!st.isFile() || st.size > 64 * 1024) return null;
      const v = JSON.parse(await this.fs.readFile(path.join(dir, 'exit.json'), 'utf8')) as ExitRecord;
      return v && typeof v === 'object' && v.exit && typeof v.exit.oomKilled === 'boolean' ? v : null;
    } catch { return null; }
  }

  // ---------- attempt.start ----------

  private async onStart(attemptId: string, plan: AttemptPlan): Promise<void> {
    if (typeof attemptId !== 'string' || !ULID_RE.test(attemptId) || !plan || typeof plan !== 'object') { this.log('[runner] attempt.start is malformed'); return; }
    if (this.attempts.has(attemptId)) { this.log('[runner] attempt.start for an attempt already held; ignored'); return; }
    const kind: Kind = plan.kind === 'service' ? 'service' : plan.kind === 'engine' ? 'engine' : plan.kind === 'agent' ? 'agent' : 'tool';
    const a = this.newState(attemptId, String(plan.jobId), Number(plan.attemptN), kind, plan, String(plan.workDir), String(plan.logPath));
    // Heartbeats start now: staging, create and preflight can take a while, and main's lease must not run out meanwhile.
    this.startHeartbeat(a);
    try {
      const bad = this.planProblem(attemptId, plan);
      if (bad) return await this.refuse(a, 'bad_plan', bad);
      if (plan.kind === 'engine') return await this.runEngine(a, plan);
      if (plan.kind === 'service') return await this.runService(a, plan);
      if (plan.kind === 'agent') return await this.runAgent(a, plan);
      return await this.runTool(a, plan);
    } catch (e) {
      if (e instanceof Stop) return this.stopped ? undefined : await this.finishStopped(a);
      this.log(`[runner] attempt ${attemptId.slice(0, 10)} stopped on an error: ${msgOf(e)}`);
      if (a.settled || a.cleaned) return;
      if (a.containerState === null) return await this.fault(a, failureClassOf(e), msgOf(e));
      // It ran but cannot be followed any more: stop it and stop heartbeating, so main's lease ends it (runner_lost,
      // retried when idempotent). Nothing is removed: the next restart's reconcile decides.
      a.log?.nexus('the runner lost track of the container and stopped it');
      await Promise.all(a.containers.map((c) => this.stopAndKill(c, STOP_GRACE_MS)));
      this.end(a);
    } finally {
      if (a.released && !a.cleaned) await this.cleanup(a);
    }
  }

  /** Why a plan's ids, paths or labels are not exactly what main derives, or null. */
  private planProblem(attemptId: string, plan: AttemptPlan): string | null {
    if (!this.paths || this.bootId === null) return 'the runner has no data home yet';
    if (plan.attemptId !== attemptId) return 'the plan is for another attempt';
    if (!ID_RE.test(plan.jobId) || !Number.isSafeInteger(plan.attemptN) || plan.attemptN < 1) return 'the plan ids are malformed';
    if (!this.paths.same(plan.workDir, this.paths.workDir(plan.jobId, plan.attemptN))) return 'the work folder is not this attempt\'s';
    if (!this.paths.same(plan.logPath, this.paths.logPath(plan.jobId, plan.attemptN))) return 'the log path is not this attempt\'s';
    if (plan.kind === 'engine') return plan.task?.engine === 'sde.diagnose' ? diagnoseTaskProblem(plan.task) : this.gitTaskProblem(plan);
    if (!this.home) return 'this install has no label';
    // B2b Task 11: an agent turn's container carries its own labels and mounts only its own worktree, read-write, at
    // the container level with no network (the host egress proxy, started per turn, is the only path out).
    if (plan.kind === 'agent') return this.agentPlanProblem(attemptId, plan);
    if (plan.kind === 'tool' && plan.perFileJunit !== undefined) {
      const pf = plan.perFileJunit;
      const argv = plan.container.argv;
      const sep = argv.indexOf('--');
      if (!pf || pf.dir !== 'junit' || !Array.isArray(pf.files) || argv[0] !== 'nexus-node-test' || sep < 0) return 'the per-file report plan is malformed';
      const tail = argv.slice(sep + 1);
      if (tail.length !== pf.files.length || tail.some((x, i) => x !== pf.files[i])) return 'the per-file report mapping is not the files the plan runs';
      // A file equal to the entry's step separator would cut the step in two (fix round 1, item 8).
      if (pf.files.some((f) => typeof f !== 'string' || f === STEP_SEPARATOR_TOKEN || f.startsWith('-'))) return 'a per-file test file is not a plain relative path';
    }
    // A dev deployment's app runs the manifest's argv as ONE step: the entry's step separator in it would start a second
    // command (final batch item 9; main's checkRunArgv refuses it too, this is the runner's own check).
    if (plan.kind === 'service' && (!Array.isArray(plan.app?.argv) || plan.app.argv.some((x) => typeof x !== 'string' || x === STEP_SEPARATOR_TOKEN))) {
      return 'the app argv holds the step separator';
    }
    if (plan.staging.depsVolume && !DEPS_VOLUME_RE.test(plan.staging.depsVolume.name)) return 'the deps volume is not a dependency cache volume';
    const rl = plan.resourceLabels;
    if (!rl || rl['nexus.home'] !== this.home || rl['nexus.attempt'] !== attemptId || rl['nexus.job'] !== plan.jobId) return 'the resource labels are not this attempt\'s';
    const specs = plan.kind === 'tool' ? [plan.container, ...(plan.egressProxy?.container ? [plan.egressProxy.container] : [])] : [plan.app, plan.forwarder];
    for (const s of specs) {
      const l = s.labels;
      if (l['nexus.attempt'] !== attemptId || l['nexus.home'] !== this.home || l['nexus.job'] !== plan.jobId) return 'a container\'s labels are not this attempt\'s';
      for (const m of s.mounts) {
        const bind = /^[A-Za-z]:[\\/]/.test(m.hostPath) || m.hostPath.startsWith('/');
        if (bind) {
          const ok = (m.kind === 'input' && this.paths.same(m.hostPath, path.join(plan.workDir, 'in')) && m.readOnly)
            || (m.kind === 'out' && this.paths.same(m.hostPath, path.join(plan.workDir, 'out')));
          if (!ok) return 'a bind mount is not this attempt\'s staging folder';
        } else if (!(m.kind === 'workspace' && m.hostPath === `nexus-ws-${attemptId}`)
          && !(m.kind === 'deps' && m.hostPath === plan.staging.depsVolume?.name && DEPS_VOLUME_RE.test(m.hostPath))) {
          return 'a volume mount is not this attempt\'s';
        }
      }
    }
    return null;
  }

  /**
   * B2b Task 11: an agent turn's own container, labels, mount and paths. Everything the runner will create, bind or
   * delete is re-derived from the ids and the data home here, never trusted from the plan: the config dir (the runner
   * deletes its files at the turn's end) must be exactly `<home>/jobs/<jobId>/agent`, and the worktree (bound read-write
   * into the container) exactly a session folder `<home>/wt/<session>`; neither may hold a `..` segment. A malformed
   * plan is a refusal, never a thrown TypeError.
   */
  private agentPlanProblem(attemptId: string, plan: AgentPlan): string | null {
    try { return this.agentPlanProblemOf(attemptId, plan); } catch { return 'the agent plan is malformed'; }
  }

  private agentPlanProblemOf(attemptId: string, plan: AgentPlan): string | null {
    const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
    if (!isObj(plan.container) || !isObj(plan.container.labels) || !isObj(plan.container.network) || !Array.isArray(plan.container.mounts)) return 'the agent container is malformed';
    if (!isObj(plan.worktree) || !isObj(plan.runtime) || !isObj(plan.runtime.request) || !isObj(plan.egress) || !Array.isArray(plan.egress.allow)) return 'the agent plan is malformed';
    const rl = plan.resourceLabels;
    if (!isObj(rl) || rl['nexus.home'] !== this.home || rl['nexus.attempt'] !== attemptId || rl['nexus.job'] !== plan.jobId) return 'the resource labels are not this attempt\'s';
    const spec = plan.container;
    const l = spec.labels;
    if (l['nexus.attempt'] !== attemptId || l['nexus.home'] !== this.home || l['nexus.job'] !== plan.jobId) return 'the container\'s labels are not this attempt\'s';
    if (l['nexus.kind'] !== 'agent') return 'an agent container must be labelled nexus.kind=agent';
    if (spec.network.mode !== 'none') return 'an agent container runs with no network at the container level';
    const root = this.paths!.root;
    const noDots = (p: string): boolean => !p.split(/[\\/]/).includes('..');
    const wt = plan.worktree.hostPath;
    if (typeof wt !== 'string' || !path.isAbsolute(wt) || wt.includes('\0') || !noDots(wt)) return 'the worktree is not a plain absolute path';
    try { worktreeName(root, wt); } catch { return 'the worktree is not a session folder of this data home'; }
    const req = plan.runtime.request;
    const configDir = req.configDir;
    if (typeof configDir !== 'string' || !path.isAbsolute(configDir) || configDir.includes('\0') || !noDots(configDir)
      || !this.paths!.same(configDir, path.join(root, 'jobs', plan.jobId, 'agent'))) return 'the config folder is not this job\'s agent folder';
    if (req.jobId !== plan.jobId || req.attempt !== plan.attemptN) return 'the run request is for another job or attempt';
    if (!isObj(req.worktree) || typeof req.worktree.hostPath !== 'string' || !this.paths!.same(req.worktree.hostPath, wt)) return 'the run request names another worktree';
    if (!isObj(req.container) || typeof req.container.id !== 'string' || req.container.id.length === 0 || req.container.id.length > 128) return 'the run request has no container reference';
    let sawWorktree = false;
    for (const m of spec.mounts) {
      if (m.kind !== 'worktree') return 'an agent container may only mount its own worktree';
      if (m.readOnly) return 'the worktree mount must be read-write';
      if (m.containerPath !== '/workspace') return 'the worktree is mounted at /workspace only';
      if (typeof m.hostPath !== 'string' || !this.paths!.same(m.hostPath, wt)) return 'the worktree mount is not this turn\'s worktree';
      sawWorktree = true;
    }
    if (!sawWorktree) return 'the agent container has no worktree mount';
    if (typeof plan.runtime.token !== 'string' || plan.runtime.token.length === 0) return 'the turn has no capability token';
    // The live consent's hash comes from main, never from `allow`: required (64 hex) with any host, absent only for deny-all.
    const consent = plan.egress.consentHostsSha256;
    if (plan.egress.allow.length > 0 ? typeof consent !== 'string' || !/^[0-9a-f]{64}$/.test(consent) : consent !== undefined && (typeof consent !== 'string' || !/^[0-9a-f]{64}$/.test(consent))) {
      return 'the egress hosts carry no valid consent hash';
    }
    // B2b Task 10: the runtime's allow-list is exactly the token's tools: a list of known Nexus MCP tools, once each.
    const tools = plan.mcpTools;
    if (tools !== undefined) {
      if (!Array.isArray(tools) || tools.length > MCP_TOOLS.length || new Set(tools).size !== tools.length
        || tools.some((t) => typeof t !== 'string' || !MCP_TOOLS.some((d) => d.name === t))) return 'the agent plan names a tool this runner does not serve';
    }
    return null;
  }

  /** Docker and disk, checked before anything is made. */
  private async preChecks(a: AttemptState, outputMaxBytes: number): Promise<{ reason: RefusalReason; detail: string } | null> {
    let probe: SandboxProbe;
    try { probe = await this.driver.probe(); } catch { probe = { docker: 'stopped', gpu: { detected: false, usableInContainers: false } }; }
    if (probe.docker === 'missing') return { reason: 'docker_missing', detail: 'Docker is not installed' };
    if (probe.docker !== 'running') return { reason: 'docker_stopped', detail: 'Docker is not running' };
    const free = await this.freeBytes(this.paths!.root);
    const floor = leaseFloorBytes(outputMaxBytes);
    if (free !== null && free < floor) return { reason: 'disk_low', detail: `${free} bytes free at the data home, ${floor} needed` };
    void a;
    return null;
  }

  private networkProblem(plan: ToolPlan): string | null {
    const n = plan.container.network;
    if (n.mode === 'none') return plan.egressProxy === undefined ? null : 'a plan without egress carries an egress proxy';
    if (n.mode === 'egress-approved') {
      const ap = plan.approval;
      if (typeof n.approvalId !== 'string' || n.approvalId.length === 0) return 'egress without an approval id';
      if (!ap || ap.id !== n.approvalId) return 'the approval id is not the one main consumed for this attempt';
      if (ap.jobId !== plan.jobId || ap.attemptN !== plan.attemptN) return 'the approval was consumed by another job or attempt';
      return egressTopologyProblem(plan);
    }
    return 'a tool container runs with no network or its approved egress network only';
  }

  private async createWithRetry(a: AttemptState, spec: ContainerSpec, alias?: string): Promise<string | null> {
    try {
      return (await this.driver.create(spec, alias ? { alias } : {})).containerId;
    } catch (e) {
      if (e instanceof DockerError && e.kind === 'name_conflict') {
        a.log?.nexus('the container name was taken; creating it once more under another name');
        try { return (await this.driver.create(spec, { name: `${spec.name}-2`, ...(alias ? { alias } : {}) })).containerId; } catch (e2) {
          await this.dockerFailure(a, e2); return null;
        }
      }
      await this.dockerFailure(a, e);
      return null;
    }
  }

  /** stop -t <grace> then kill (a container that already stopped is not an error). */
  private async stopAndKill(cid: string, graceMs: number): Promise<void> {
    try { await this.driver.stop(cid, graceMs); } catch (e) { this.log(`[runner] stop failed: ${msgOf(e)}`); }
    try { await this.driver.kill(cid); } catch (e) { this.log(`[runner] kill failed: ${msgOf(e)}`); }
  }

  private followLogs(a: AttemptState, cid: string, sinceMs?: number): void {
    const w = a.log;
    if (!w) return;
    a.logDone = this.driver.streamLogs(cid, (s, t) => w.write(s, t), a.logAbort.signal, sinceMs).catch(() => undefined);
  }

  private async drainLogs(a: AttemptState): Promise<void> {
    if (a.logDone) {
      let h: unknown = null;
      await Promise.race([a.logDone, new Promise<void>((r) => { h = this.timers.setTimeout(r, LOG_DRAIN_MS); })]);
      if (h !== null) this.timers.clearTimeout(h);
    }
    a.logAbort.abort();
  }

  /** The backstop: at RUNNER_WALL_FACTOR x the wall clock, stop -t 10 then kill; the exit then says `timeout`. */
  private armWall(a: AttemptState, wallMs: number, cids: () => string[], elapsedMs = 0): void {
    if (!Number.isSafeInteger(wallMs) || wallMs <= 0) return;
    this.after(a, Math.max(0, wallMs * RUNNER_WALL_FACTOR - elapsedMs), () => {
      if (a.containerState !== 'running' || a.settled) return;
      a.timedOut = true;
      a.log?.nexus('the wall-clock backstop stopped the container');
      void Promise.all(cids().map((c) => this.stopAndKill(c, STOP_GRACE_MS)));
    });
  }

  /** The size guard: every 5 s, `/out` on the host and `/workspace` through `du`; over a limit, the container is killed. */
  private armGuard(a: AttemptState, plan: ToolPlan, cid: string): void {
    let busy = false;
    const outDir = path.join(a.workDir, 'out');
    const outLimit = plan.container.limits.outputMaxBytes;
    const wsLimit = this.deps.limits?.workspaceMaxBytes ?? WORKSPACE_MAX_BYTES;
    this.after(a, GUARD_POLL_MS, () => {
      if (busy || a.guard || a.containerState !== 'running') return;
      busy = true;
      void (async () => {
        try {
          a.outBytes = await outBytes(this.fs, outDir, outLimit, plan.outputContract.maxFiles);
          let ws: number | null = null;
          if (a.outBytes <= outLimit) {
            try {
              const r = await this.driver.exec(cid, [...DU_ARGV], { timeoutMs: 30_000, signal: a.abort.signal, maxOutputBytes: 4096 });
              ws = r.exit.code === 0 ? parseDuKib(r.stdout) : null;
            } catch { ws = null; }
          }
          const trip = guardDecision({ outBytes: a.outBytes, outLimit, workspaceBytes: ws, workspaceLimit: wsLimit });
          if (trip && !a.guard && a.containerState === 'running') {
            a.guard = trip;
            this.post({ op: 'attempt.event', attemptId: a.id, seq: ++a.seq, event: { t: 'guard', guard: trip.guard, bytes: trip.bytes, limitBytes: trip.limitBytes, at: this.now() } });
            a.log?.nexus(`the size guard stopped the container: ${trip.guard} (${trip.bytes} bytes, limit ${trip.limitBytes})`);
            try { await this.driver.kill(cid); } catch (e) { this.log(`[runner] kill failed: ${msgOf(e)}`); }
          }
        } finally { busy = false; }
      })();
    }, true);
  }

  /**
   * Waits for the container's exit; null when the attempt was released meanwhile or its exit cannot be known. When the
   * wait fails, the container is inspected: exited -> its recorded exit; NOT FOUND -> `missing` (heartbeat; main fails
   * the attempt container_vanished); still there (the wait cut short WAIT_RETRIES times) or Docker not answering -> a
   * Docker error, never `missing`: a `fault` with failureClass `docker_error` (main fails the attempt docker_error and
   * releases it). Either way nothing is removed before attempt.release.
   */
  private async waitExit(a: AttemptState, cid: string): Promise<ExitInfo | null> {
    try {
      return await this.driver.wait(cid, a.abort.signal);
    } catch (e) {
      if (a.released || this.stopped) return null;
      let st: Awaited<ReturnType<RunnerDriver['inspect']>> | null = null;
      try { st = await this.driver.inspect(cid); } catch { st = null; }
      if (st?.state === 'exited' && st.exit) return st.exit;
      if (st?.state === 'missing') {
        // The container is gone (removed from outside): main hears `missing` and fails the attempt.
        a.containerState = 'missing';
        a.log?.nexus(`the container disappeared: ${msgOf(e)}`);
        this.heartbeatOnce(a);
        return null;
      }
      a.exitUnreadable = true;
      a.log?.nexus(`the container's exit could not be read: ${msgOf(e)}`);
      this.post({ op: 'fault', message: msgOf(e), attemptId: a.id, failureClass: 'docker_error' });
      return null;
    }
  }

  // ---------- tool attempts ----------

  private async runTool(a: AttemptState, plan: ToolPlan): Promise<void> {
    const spec = plan.container;
    const net = this.networkProblem(plan);
    if (net) return this.refuse(a, 'network_not_approved', net);
    const pre = await this.preChecks(a, spec.limits.outputMaxBytes);
    if (pre) return this.refuse(a, pre.reason, pre.detail);
    await this.openLog(a);
    this.event(a, 'staging');
    const staged = await stageInputs(this.fs, this.paths!, this.git!, plan, a.workDir, a.abort.signal);
    if (!staged.ok) return this.refuse(a, staged.reason, staged.detail);
    await this.writeRecord(a, 'plan.json', { plan } satisfies PlanRecord);
    this.checkStop(a);
    this.event(a, 'creating');
    try {
      for (const m of spec.mounts) if (m.kind === 'workspace') { await this.driver.createVolume(m.hostPath, { ...plan.resourceLabels }); a.volumes.push(m.hostPath); }
      if (plan.staging.depsVolume) await this.driver.createVolume(plan.staging.depsVolume.name, { ...plan.resourceLabels, 'nexus.kind': 'deps' });
      // An approved install: the job's INTERNAL network (the install and the proxy; no route out) and its outbound
      // bridge (the proxy only). Never a bridge for the install itself.
      const px = plan.egressProxy;
      if (spec.network.mode === 'egress-approved' && px) {
        if (expectedNetworkName(spec) !== px.networks.internal) throw new SpecError('the install is not on its internal egress network');
        await this.driver.createNetwork(px.networks.internal, { ...plan.resourceLabels }, { internal: true });
        a.networks.push(px.networks.internal);
        await this.driver.createNetwork(px.networks.outbound, { ...plan.resourceLabels }, { internal: false });
        a.networks.push(px.networks.outbound);
      }
    } catch (e) { return this.dockerFailure(a, e); }
    this.checkStop(a);
    const cid = await this.createWithRetry(a, spec);
    if (!cid) return;
    a.containers.push(cid); a.main = cid;
    let proxyId: string | null = null;
    if (plan.egressProxy) {
      proxyId = await this.createWithRetry(a, plan.egressProxy.container);
      if (!proxyId) return;
      a.containers.push(proxyId);
    }
    this.checkStop(a);
    this.event(a, 'preflight');
    const own = await this.driver.preflight(cid, spec);
    // Both containers pass preflight before either starts (the proxy's networks, alias, command and settings are pinned too).
    const report = plan.egressProxy && proxyId ? mergeProxyPreflight(own, await this.driver.preflight(proxyId, plan.egressProxy.container)) : own;
    if (!report.ok) {
      // Never started: removed now (it holds no evidence); main fails the attempt `limits_not_applied` and releases the rest.
      for (const c of [...a.containers]) {
        try { await this.driver.remove(c); a.containers = a.containers.filter((x) => x !== c); } catch (e) { this.log(`[runner] the refused container was not removed: ${msgOf(e)}`); }
      }
      a.log?.nexus(`preflight refused the container: ${report.problems.length} problem(s)`);
      this.post({ op: 'attempt.provisioned', attemptId: a.id, containerId: cid, imageDigest: spec.image.id, preflight: report });
      a.settled = true;
      return;
    }
    this.checkStop(a);
    this.event(a, 'starting');
    if (proxyId) {
      // The proxy first: the install starts only once the proxy listens (its first line says so).
      try { await this.driver.start(proxyId); } catch (e) { return this.dockerFailure(a, e); }
      const ready = await this.followProxy(a, proxyId);
      if (!ready) {
        await this.stopAndKill(proxyId, 2_000);
        return this.fault(a, 'docker_error', `the egress proxy did not start within ${PROXY_READY_MS / 1000} s`);
      }
      a.log?.nexus(`the egress proxy listens: only ${plan.egressProxy!.container.env.NEXUS_EGRESS_ALLOW} can be reached`);
      this.checkStop(a);
    }
    try { await this.driver.start(cid); } catch (e) { return this.dockerFailure(a, e); }
    a.containerState = 'running';
    const startedAt = this.now();
    // Everything that watches the running container is armed before main hears that it runs.
    this.followLogs(a, cid);
    this.armWall(a, spec.limits.wallClockMs, () => [cid, ...(proxyId ? [proxyId] : [])]);
    this.armGuard(a, plan, cid);
    this.post({ op: 'attempt.provisioned', attemptId: a.id, containerId: cid, imageDigest: spec.image.id, preflight: report });
    this.event(a, 'running');
    // A cancel that arrived while `docker start` ran: it is applied now.
    if (a.cancel && !a.stopIssued) { a.stopIssued = true; void Promise.all(a.containers.map((c) => this.stopAndKill(c, a.cancel!.graceMs))); }
    await this.writeRecord(a, 'plan.json', { plan, startedAt, containerIds: [cid, ...(proxyId ? [proxyId] : [])] } satisfies PlanRecord);
    const exit = await this.waitExit(a, cid);
    if (!exit) { if (!a.released && this.vanished(a)) a.settled = true; return; }
    await this.collect(a, plan, exit);
  }

  /**
   * Follows the egress proxy's output: its ready line resolves the returned promise (true; false after PROXY_READY_MS),
   * each decision becomes an `attempt.event` (`egress`, at most EGRESS_EVENT_MAX) and an attempt-log line; other output
   * (at most PROXY_LOG_LINES_MAX lines) goes to the attempt log, redacted.
   */
  private followProxy(a: AttemptState, proxyId: string, sinceMs?: number, alreadyReady = false): Promise<boolean> {
    const p = { id: proxyId, logDone: null as Promise<void> | null, ready: alreadyReady, onReady: null as (() => void) | null, events: 0, lines: 0, capped: false };
    a.proxy = p;
    const out = new LineSplitter(); const err = new LineSplitter();
    const handle = (line: string): void => {
      const l = classifyProxyLine(line);
      if (l.kind === 'blank') return;
      if (l.kind === 'ready') { p.ready = true; p.onReady?.(); return; }
      if (l.kind === 'other') {
        if (p.lines++ < PROXY_LOG_LINES_MAX) a.log?.nexus(`egress proxy: ${redactSecretText(l.text)}`);
        return;
      }
      const d = l.decision;
      // A host the client named may carry anything: a secret-shaped one is never repeated.
      const host = redactSecretText(d.host) === d.host ? d.host : 'redacted';
      a.log?.nexus(`egress ${d.decision} ${host}:${d.port}${d.decision === 'refused' ? ` (${d.reason})` : ''}`);
      if (a.released || a.cleaned) return;
      if (p.events < EGRESS_EVENT_MAX) {
        p.events++;
        this.post({ op: 'attempt.event', attemptId: a.id, seq: ++a.seq, event: { t: 'egress', decision: d.decision, host, port: d.port, reason: d.reason, at: this.now() } });
      } else if (!p.capped) {
        p.capped = true;
        a.log?.nexus(`more than ${EGRESS_EVENT_MAX} egress decisions: the rest are in this log only`);
      }
    };
    p.logDone = this.driver.streamLogs(proxyId, (s, t) => { for (const l of (s === 'stdout' ? out : err).push(t)) handle(l); }, a.logAbort.signal, sinceMs)
      .catch(() => undefined).then(() => { for (const l of [...out.flush(), ...err.flush()]) handle(l); });
    if (p.ready) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let h: unknown = null;
      const done = (v: boolean): void => { if (h !== null) { this.timers.clearTimeout(h); h = null; } p.onReady = null; resolve(v); };
      p.onReady = () => done(true);
      h = this.timers.setTimeout(() => done(p.ready), PROXY_READY_MS);
      void p.logDone?.then(() => { if (!p.ready) done(false); });
    });
  }

  /** Stops an attempt's egress proxy (if any) and waits a little for its last decisions. */
  private async stopProxy(a: AttemptState): Promise<void> {
    const p = a.proxy;
    if (!p) return;
    await this.stopAndKill(p.id, 2_000);
    if (p.logDone) {
      let h: unknown = null;
      await Promise.race([p.logDone, new Promise<void>((r) => { h = this.timers.setTimeout(r, LOG_DRAIN_MS); })]);
      if (h !== null) this.timers.clearTimeout(h);
    }
  }

  /** Exit -> exit.json -> /out hashed -> parsers -> `attempt.exited`. */
  private async collect(a: AttemptState, plan: ToolPlan | null, exit: ExitInfo): Promise<void> {
    a.containerState = 'exited';
    for (const t of a.timers.splice(0)) (t.interval ? this.timers.clearInterval(t.h) : this.timers.clearTimeout(t.h));
    // The install is done: its egress proxy is stopped now, and its last decisions are read before the exit is reported.
    await this.stopProxy(a);
    await this.drainLogs(a);
    if (a.released) return;
    this.event(a, 'collecting');
    const reason: ExitReason | undefined = a.cancel ? 'cancelled' : a.timedOut ? 'timeout' : undefined;
    const record: ExitRecord = { attemptId: a.id, exit, ...(reason ? { reason } : {}), ...(a.guard ? { guard: a.guard.guard } : {}) };
    await this.writeRecord(a, 'exit.json', record);
    await this.finishFromRecord(a, plan, record);
  }

  /** From a recorded exit: hash `/out` (unless the exit already refuses it), parse, report. Used live and after a restart. */
  private async finishFromRecord(a: AttemptState, plan: ToolPlan | null, rec: ExitRecord): Promise<void> {
    let outputs: StagedOutput[] = []; let parsed: ParsedOutput[] = [];
    let outputError: OutputErrorCode | undefined = rec.guard; let entry: string | undefined;
    // A per-file node:test plan whose reports were not merged parses no junit.xml (the container's own is never taken).
    let skipJunit = false;
    if (!rec.reason && !outputError && plan && this.store) {
      // node:test: the per-file reports are merged into junit.xml first, every case attributed to its file (A5). The
      // merged report is written in the work folder (never inside the container-writable /out) and renamed into place.
      if (plan.perFileJunit && this.paths) {
        const outDir = path.join(a.workDir, 'out');
        let merged = false;
        try {
          const m = await mergePerFileJunit(this.fs, this.paths.root, outDir, plan.perFileJunit.files, a.workDir);
          for (const n of m.notes.slice(0, 20)) a.log?.nexus(n);
          merged = m.merged;
          if (m.merged) a.log?.nexus(`the per-file reports were merged: ${m.cases} test case(s) attributed to ${plan.perFileJunit.files.length} file(s)`);
        } catch (e) { a.log?.nexus(`the per-file reports were not merged: ${msgOf(e)}`); }
        if (!merged) {
          skipJunit = true;
          a.log?.nexus('no per-file report folder was merged: junit.xml is not parsed (a per-file run is judged only on its per-file reports)');
          try { const note = await discardUnmergedReport(this.fs, this.paths.root, outDir, a.workDir); if (note) a.log?.nexus(note); } catch (e) { a.log?.nexus(`junit.xml was not checked: ${msgOf(e)}`); }
        }
      }
      this.event(a, 'hashing');
      // Any read failure of /out refuses the outputs (final review B4): the exit is still reported, never a lost runner.
      let c: Awaited<ReturnType<typeof collectOut>>;
      try {
        c = await collectOut(this.fs, this.store, path.join(a.workDir, 'out'),
          { maxFiles: plan.outputContract.maxFiles, maxBytes: plan.container.limits.outputMaxBytes });
      } catch (e) {
        a.log?.nexus(`/out could not be read: ${msgOf(e)}`);
        c = { ok: false, code: 'unreadable_output_entry', entry: '.' };
      }
      if (!c.ok) { outputError = c.code; entry = showEntry(c.entry); a.log?.nexus(`the outputs were refused: ${c.code} (${entry})`); }
      else outputs = c.outputs;
      a.outBytes = outputs.reduce((s, o) => s + o.bytes, 0);
      if (outputs.length > 0 && plan.parse.length > 0) { this.event(a, 'parsing'); parsed = await this.parseOutputs(a, plan, outputs, skipJunit); }
    }
    if (a.released) return;
    try { await a.log?.close(); } catch { /* closed */ }
    let logBytes = a.log?.bytes() ?? 0;
    if (!a.log) { try { logBytes = (await this.fs.stat(a.logPath)).size; } catch { logBytes = 0; } }
    this.post({ op: 'attempt.exited', attemptId: a.id, exit: rec.exit, outputs, parsed, logBytes,
      ...(outputError ? { outputError } : {}), ...(outputError && entry ? { outputErrorEntry: entry } : {}), ...(rec.reason ? { reason: rec.reason } : {}) });
    a.settled = true;
  }

  private async parseOutputs(a: AttemptState, plan: ToolPlan, outputs: readonly StagedOutput[], skipJunit = false): Promise<ParsedOutput[]> {
    const out: ParsedOutput[] = [];
    for (const p of plan.parse) {
      if (p.parser === 'junit' && skipJunit) continue;
      const o = outputs.find((x) => x.relPath === p.relPath);
      if (!o) continue;
      if (p.parser === 'junit' && o.bytes > JUNIT_MAX_BYTES) { a.log?.nexus('the JUnit report is over 16 MiB; it was not parsed'); continue; }
      let bytes: Buffer;
      try { bytes = await this.fs.readFile(this.paths!.objectPath(o.sha256)); } catch { continue; }
      if (createHash('sha256').update(bytes).digest('hex') !== o.sha256) { a.log?.nexus(`${p.relPath} changed in the object store; it was not parsed`); continue; }
      if (p.parser === 'junit') {
        const r = parseJunit(bytes);
        if (r.ok) out.push({ parser: 'junit', sourceSha256: o.sha256, normalized: r.value });
        else a.log?.nexus(`the JUnit report was refused: ${r.reason}`);
      } else if (p.parser === 'discovery') {
        const fw = discoveryFrameworkOf(plan.container.argv);
        const r = fw ? parseDiscovery(fw, bytes) : null;
        if (r && r.ok) out.push({ parser: 'discovery', sourceSha256: o.sha256, normalized: r.value });
        else a.log?.nexus(`the discovered list was refused: ${r ? r.reason : 'unknown framework'}`);
      }
    }
    return out;
  }

  /** Cancelled (or stopped) before a container ran: an exit without a code, so main releases what was made. */
  private async finishStopped(a: AttemptState): Promise<void> {
    if (a.settled || a.cleaned) return;
    if (a.released) return;
    try { await a.log?.close(); } catch { /* closed */ }
    this.post({ op: 'attempt.exited', attemptId: a.id, exit: { code: null, oomKilled: false, finishedAt: this.now() }, outputs: [], parsed: [],
      logBytes: a.log?.bytes() ?? 0, reason: 'cancelled' });
    a.settled = true;
  }

  // ---------- agent turns (B2b Task 11) ----------

  /** Builds this turn's agentAttempt.ts port (post, log, the registry, the proxy starter, the guard-refusal flag) and runs it. */
  private async runAgent(a: AttemptState, plan: AgentPlan): Promise<void> {
    await this.openLog(a);
    // No link may stand anywhere on the way to the folders the runner binds or deletes in (the config dir, the worktree).
    if (!(await noLinkUnder(this.fs, this.paths!.root, plan.runtime.request.configDir)) || !(await noLinkUnder(this.fs, this.paths!.root, plan.worktree.hostPath))) {
      return this.refuse(a, 'bad_plan', 'a link stands in the turn\'s config or worktree folder');
    }
    // The turn's host egress proxy URL, known once agentAttempt has started the proxy: the cli-agent runtime reads it
    // through `egressProxyUrl` and never starts without one.
    const egress: { url: string | null } = { url: null };
    const startProxy = this.deps.agentRuntime?.startProxy ?? startHostEgressProxy;
    let runtime: AgentRuntime;
    try {
      runtime = this.deps.agentRuntime?.makeRuntime?.(plan) ?? runtimeFor(plan.runtime.kind, {
        token: plan.runtime.token,
        mcpUrl: this.mcpServer?.url ?? '',
        egressProxyUrl: () => egress.url,
        caps: plan.caps,
        mcpTools: plan.mcpTools,
        steps: this.deps.agentRuntime?.scriptFor?.(plan) ?? [],
        fetchImpl: this.deps.agentRuntime?.fetchImpl,
        agentBin: this.deps.agentRuntime?.agentBin,
        agentEnv: this.deps.agentRuntime?.agentEnv,
        agentArgvPrefix: this.deps.agentRuntime?.agentArgvPrefix,
        taskkillBin: this.deps.agentRuntime?.taskkillBin,
        onSpawned: async (info) => {
          await this.procTree?.record({ jobId: plan.jobId, pid: info.pid, imageName: info.imageName, mainBootId: this.bootId ?? '', runnerPid: process.pid });
          this.deps.agentRuntime?.onSpawned?.(info);
        },
        // The process is gone (exited, or killed at the turn's end): its pidfile and live entry go with it.
        onGone: async (pid) => { await this.procTree?.forget(pid); }
      });
    } catch (e) {
      return this.refuse(a, 'bad_plan', `no runtime could be built for this turn: ${msgOf(e)}`);
    }
    const port: AgentAttemptPort = {
      driver: this.driver,
      fs: this.fs,
      now: this.now,
      log: (text) => a.log?.nexus(text),
      phase: (phase) => this.event(a, phase),
      provisioned: (containerId, imageDigest, preflight) => {
        this.post({ op: 'attempt.provisioned', attemptId: a.id, containerId, imageDigest, preflight });
        if (!preflight.ok) a.settled = true;
      },
      refuse: (reason, detail) => this.refuse(a, reason, detail),
      fault: (failureClass, message) => this.fault(a, failureClass, message),
      runtimeEvent: (event) => this.post({ op: 'attempt.runtime', attemptId: a.id, seq: ++a.seq, event }),
      exited: (exit, reason) => {
        if (a.released || a.cleaned) return;
        this.post({ op: 'attempt.exited', attemptId: a.id, exit, outputs: [], parsed: [], logBytes: a.log?.bytes() ?? 0, ...(reason ? { reason } : {}) });
        a.settled = true;
      },
      bindAgentTurn: (bearer, attemptId, containerId) => this.bindAgentTurn(bearer, attemptId, containerId),
      unbindAgentTurn: (bearer) => this.unbindAgentTurn(bearer),
      runtime,
      startHostEgressProxy: async (o) => {
        const proxy = await startProxy(o);
        egress.url = proxy.url;
        // The URL is only good while the proxy runs: once it is closed no runtime may be pointed at it any more.
        const close = proxy.close.bind(proxy);
        (proxy as { close: () => Promise<void> }).close = async () => { egress.url = null; await close(); };
        return proxy;
      },
      imagesDir: this.deps.imagesDir,
      guardRefusal: () => a.agentGuardRefusal ?? null,
      signal: a.abort.signal
    };
    // Kept on the attempt so an app quit (shutdown) can abort the turn and wait for its container to be removed.
    const done = runAgentAttempt(plan, port);
    a.agentDone = done.then(() => undefined, () => undefined);
    try {
      await done;
    } finally {
      try { await a.log?.close(); } catch { /* closed */ }
      if (!a.settled && !a.cleaned) a.settled = true;
    }
  }

  // ---------- dev deployments ----------

  private async runService(a: AttemptState, plan: ServicePlan): Promise<void> {
    const netProblem = serviceNetworkProblem(plan);
    if (netProblem) return this.refuse(a, 'network_not_approved', netProblem);
    const pre = await this.preChecks(a, plan.app.limits.outputMaxBytes);
    if (pre) return this.refuse(a, pre.reason, pre.detail);
    await this.openLog(a);
    this.event(a, 'staging');
    const staged = await stageInputs(this.fs, this.paths!, this.git!, plan, a.workDir, a.abort.signal);
    if (!staged.ok) return this.refuse(a, staged.reason, staged.detail);
    await this.writeRecord(a, 'plan.json', { plan: plan as unknown as Record<string, unknown> } satisfies PlanRecord);
    this.checkStop(a);
    this.event(a, 'creating');
    try {
      await this.driver.createNetwork(plan.networks.internal, { ...plan.resourceLabels }, { internal: true });
      a.networks.push(plan.networks.internal);
      await this.driver.createNetwork(plan.networks.publish, { ...plan.resourceLabels }, { internal: false });
      a.networks.push(plan.networks.publish);
      for (const m of plan.app.mounts) if (m.kind === 'workspace') { await this.driver.createVolume(m.hostPath, { ...plan.resourceLabels }); a.volumes.push(m.hostPath); }
      if (plan.staging.depsVolume) await this.driver.createVolume(plan.staging.depsVolume.name, { ...plan.resourceLabels, 'nexus.kind': 'deps' });
    } catch (e) { return this.dockerFailure(a, e); }
    this.checkStop(a);
    const appId = await this.createWithRetry(a, plan.app, 'app');
    if (!appId) return;
    a.containers.push(appId); a.main = appId;
    const taken = new Set([...this.attempts.values()].map((x) => x.hostPort).filter((x): x is number => typeof x === 'number'));
    const pick = (): number => (this.deps.pickPort ?? pickPort)(taken);
    let port = pick();
    let fwdSpec = forwarderWithPort(plan, port);
    let fwdId = await this.createWithRetry(a, fwdSpec);
    if (!fwdId) return;
    a.containers.push(fwdId);
    this.event(a, 'preflight');
    const appReport = await this.driver.preflight(appId, plan.app);
    const fwdReport = await this.driver.preflight(fwdId, fwdSpec);
    let report = mergePreflight(appReport, fwdReport);
    if (!report.ok) {
      for (const c of a.containers.splice(0)) { try { await this.driver.remove(c); } catch (e) { this.log(`[runner] a refused container was not removed: ${msgOf(e)}`); } }
      this.post({ op: 'attempt.provisioned', attemptId: a.id, containerId: appId, imageDigest: plan.app.image.id, preflight: report, hostPort: port });
      a.settled = true;
      return;
    }
    this.checkStop(a);
    this.event(a, 'starting');
    try { await this.driver.start(appId); } catch (e) { return this.dockerFailure(a, e); }
    a.containerState = 'running';
    try {
      await this.driver.start(fwdId);
    } catch (e) {
      if (!(e instanceof DockerError) || e.kind !== 'port_conflict') return this.dockerFailure(a, e);
      // The port was taken between the pick and the start: once more with another port (create, preflight, start).
      a.log?.nexus(`port ${port} was taken; trying another one`);
      try { await this.driver.remove(fwdId); } catch { /* best effort */ }
      a.containers = a.containers.filter((c) => c !== fwdId);
      taken.add(port);
      port = pick();
      fwdSpec = forwarderWithPort(plan, port);
      fwdId = await this.createWithRetry(a, fwdSpec);
      if (!fwdId) return;
      a.containers.push(fwdId);
      const again = await this.driver.preflight(fwdId, fwdSpec);
      report = mergePreflight(appReport, again);
      if (!report.ok) {
        for (const c of a.containers.splice(0)) { try { await this.driver.remove(c); } catch { /* best effort */ } }
        a.containerState = null;
        this.post({ op: 'attempt.provisioned', attemptId: a.id, containerId: appId, imageDigest: plan.app.image.id, preflight: report, hostPort: port });
        a.settled = true;
        return;
      }
      try { await this.driver.start(fwdId); } catch (e2) { a.containerState = null; return this.dockerFailure(a, e2); }
    }
    const startedAt = this.now();
    this.armService(a, plan, appId, fwdId, port, 0);
    this.post({ op: 'attempt.provisioned', attemptId: a.id, containerId: appId, imageDigest: plan.app.image.id, preflight: report, hostPort: port });
    this.event(a, 'running');
    await this.writeRecord(a, 'plan.json', { plan: plan as unknown as Record<string, unknown>, startedAt, hostPort: port, containerIds: [appId, fwdId] } satisfies PlanRecord);
    await this.waitService(a, appId, fwdId);
  }

  /** The log, the lifetime backstop and the probe loop of a running dev deployment (live, or adopted after a restart). */
  private armService(a: AttemptState, plan: ServicePlan, appId: string, fwdId: string | null, port: number, elapsedMs: number): void {
    a.hostPort = port;
    this.followLogs(a, appId);
    this.armWall(a, plan.idleTtlMs, () => [appId, ...(fwdId ? [fwdId] : [])], elapsedMs);
    let probing = false;
    this.after(a, Math.max(1000, plan.health.intervalMs), () => {
      if (probing || a.containerState !== 'running') return;
      probing = true;
      void this.probeHttp(port, plan.health.path).then((r) => {
        if (a.containerState === 'running' && !a.released) {
          this.post({ op: 'service.health', attemptId: a.id, at: this.now(), status: r.status, ms: r.ms,
            ...(r.bodySha256 ? { bodySha256: r.bodySha256 } : {}), container: 'running' });
        }
      }).finally(() => { probing = false; });
    }, true);
    if (a.cancel && !a.stopIssued) { a.stopIssued = true; void Promise.all([appId, ...(fwdId ? [fwdId] : [])].map((c) => this.stopAndKill(c, a.cancel!.graceMs))); }
  }

  /** Waits for the app's exit, stops the forwarder, collects. */
  private async waitService(a: AttemptState, appId: string, fwdId: string | null): Promise<void> {
    const exit = await this.waitExit(a, appId);
    if (fwdId) await this.stopAndKill(fwdId, 2_000);
    if (!exit) { if (!a.released && this.vanished(a)) a.settled = true; return; }
    await this.collect(a, null, exit);
  }

  // ---------- engine attempts (no container) ----------

  private async runEngine(a: AttemptState, plan: EnginePlan): Promise<void> {
    await this.openLog(a);
    // The git engines need git: none installed is a setup refusal before anything ran (the job waits, never fails).
    const t0 = plan.task;
    if (t0.engine !== 'sde.diagnose' && !(await this.git!.available())) {
      return this.refuse(a, 'git_missing', 'git is not installed');
    }
    this.post({ op: 'attempt.provisioned', attemptId: a.id });
    this.event(a, 'running');
    if (Number.isSafeInteger(plan.wallClockMs) && plan.wallClockMs > 0) {
      this.after(a, plan.wallClockMs * RUNNER_WALL_FACTOR, () => { a.timedOut = true; a.abort.abort(); });
    }
    const parsed: ParsedOutput[] = [];
    let code = 0;
    const t = plan.task;
    try {
      if (t.engine === 'repo.snapshot') {
        if (typeof t.repoPath !== 'string' || !path.isAbsolute(t.repoPath)) throw new Error('the project folder is not an absolute path');
        const facts = await this.git!.snapshot(t.repoPath, a.abort.signal);
        const sha = createHash('sha256').update(JSON.stringify({ branch: facts.branch, commit: facts.commit, dirty: facts.dirty, tree: facts.tree,
          lockfile: facts.lockfile })).digest('hex');
        parsed.push({ parser: 'repo-snapshot', sourceSha256: sha, normalized: facts });
        a.log?.nexus(`snapshot of ${facts.commit.slice(0, 12)}${facts.dirty ? ' (uncommitted changes are not included)' : ''}`);
      } else if (t.engine === 'sde.app.assemble') {
        if (typeof t.repoPath !== 'string' || !path.isAbsolute(t.repoPath) || !COMMIT_RE.test(t.commit)) throw new Error('the assembly plan is malformed');
        appManifestArgv(t.commit);
        const r = await this.git!.readAppManifest(t.repoPath, t.commit, APP_MANIFEST_MAX_BYTES, a.abort.signal);
        if (!r.ok) {
          code = 1;
          a.log?.nexus(r.reason === 'too_large' ? 'nexus.app.json is larger than 16 KiB; it was not read' : 'nexus.app.json is not in the build\'s commit');
        } else {
          const m = parseAppManifest(r.text);
          if (!m.ok) { code = 1; a.log?.nexus(`nexus.app.json was refused: ${m.reason}`); }
          else parsed.push({ parser: 'app-manifest', sourceSha256: m.sha256, normalized: { manifest: m.manifest } });
        }
      } else if (t.engine === 'sde.diagnose') {
        // A1: docker inspect of the subject's containers (this install's only) and hashed log ranges; main adds its probes.
        const r = await diagnose({ driver: this.driver, fs: this.fs, paths: this.paths!, home: this.home }, t, a.abort.signal);
        parsed.push({ parser: 'diagnostic', sourceSha256: createHash('sha256').update(JSON.stringify(r)).digest('hex'), normalized: r });
        a.log?.nexus(`diagnosed ${r.containers.length} container(s) and ${r.logs.length} log range(s)`);
      } else if (GIT_WRITE_ENGINES.includes(t.engine)) {
        const facts = await this.runGitWrite(a, t);
        parsed.push({ parser: 'git-facts', sourceSha256: createHash('sha256').update(JSON.stringify(facts)).digest('hex'), normalized: facts });
      } else {
        code = 1;
        a.log?.nexus(`${(t as { engine: string }).engine} is not in this build`);
      }
    } catch (e) {
      code = 1;
      if (e instanceof GitFailure && GIT_FAILURE_CODES.includes(e.code) && GIT_WRITE_ENGINES.includes(t.engine)) {
        // A git write refused: the code is a fact main words as a sentence (never git's own text); nothing was written.
        const facts = { ok: false as const, code: e.code };
        parsed.push({ parser: 'git-facts', sourceSha256: createHash('sha256').update(JSON.stringify(facts)).digest('hex'), normalized: facts });
        a.log?.nexus(`${t.engine} refused: ${e.code}`);
      } else {
        a.log?.nexus(`the work stopped: ${msgOf(e)}`);
      }
    }
    if (a.released) return;
    for (const h of a.timers.splice(0)) this.timers.clearTimeout(h.h);
    const reason: ExitReason | undefined = a.cancel ? 'cancelled' : a.timedOut ? 'timeout' : undefined;
    try { await a.log?.close(); } catch { /* closed */ }
    this.post({ op: 'attempt.exited', attemptId: a.id, exit: { code: reason ? null : code, oomKilled: false, finishedAt: this.now() },
      outputs: [], parsed: reason ? [] : parsed, logBytes: a.log?.bytes() ?? 0, ...(reason ? { reason } : {}) });
    a.settled = true;
  }

  /** Why a git write task's paths are not exactly what this data home derives, or null (B2b). */
  private gitTaskProblem(plan: EnginePlan): string | null {
    const t = plan.task as { engine: string; worktreePath?: unknown; repoPath?: unknown };
    if (!GIT_WRITE_ENGINES.includes(t.engine)) return null;
    if (typeof t.repoPath !== 'string' || !path.isAbsolute(t.repoPath) || t.repoPath.includes('\0')) return 'the project folder is not an absolute path';
    if (insideRoot(t.repoPath, this.paths!.root) || insideRoot(this.paths!.root, t.repoPath)) return 'the project folder overlaps the data home';
    if (t.engine === 'repo.worktree' || t.engine === 'changeset.collect') {
      try { worktreeName(this.paths!.root, String(t.worktreePath)); } catch { return 'the worktree is not a session folder of this data home'; }
    }
    return null;
  }

  /** One git write engine (B2b Task 7); throws GitFailure on a refusal. */
  private async runGitWrite(a: AttemptState, t: EnginePlan['task']): Promise<Record<string, unknown>> {
    const g = this.gitw!;
    const signal = a.abort.signal;
    const dataRoot = this.paths!.root;
    switch (t.engine) {
      case 'repo.worktree': {
        if (!(await ensureDirUnder(this.fs, dataRoot, path.join(dataRoot, 'wt')))) throw new GitFailure('bad_task', 'the worktree folder is refused');
        const f = await ensureWorktree(g, t, { dataRoot, signal });
        a.log?.nexus(`session worktree ${f.reused ? 'reused' : 'created'} at ${f.base.slice(0, 12)}, locked`);
        return { ...f };
      }
      case 'changeset.collect': {
        const f = await gitCollect(g, t, { dataRoot, signal });
        a.log?.nexus(f.changed ? `committed ${f.diffstat.files} changed file(s) on the session ref` : 'nothing changed in scope');
        return { ...f };
      }
      case 'changeset.merge_check': {
        const f = await gitMergeCheck(g, t, { signal });
        a.log?.nexus(f.clean ? 'the change merges cleanly' : 'the change does not merge cleanly');
        return { ...f };
      }
      case 'changeset.accept': {
        const f = await gitAccept(g, t, { signal, onPrepared: (p) => {
          this.post({ op: 'attempt.event', attemptId: a.id, seq: ++a.seq, event: { t: 'accept.prepared', old: p.old, new: p.new, at: this.now() } });
        } });
        a.log?.nexus(`accepted: the integration ref moved to ${f.new.slice(0, 12)}`);
        return { ...f };
      }
      case 'changeset.accept_rollback': {
        const f = await gitRollback(g, t, { signal });
        a.log?.nexus(f.already ? 'the integration ref was already back' : 'the integration ref was moved back');
        return { ...f };
      }
      case 'repo.ff': {
        const f = await gitFastForward(g, t, { signal });
        a.log?.nexus(`fast-forwarded the branch to ${f.after.slice(0, 12)}`);
        return { ...f };
      }
      default: throw new GitFailure('bad_task', 'not a git write engine');
    }
  }

  /** `git.read` (B2b): a bounded read, answered as `git.read.result`; no attempt, no job. */
  private async onGitRead(reqId: unknown, task: unknown): Promise<void> {
    if (typeof reqId !== 'string' || !ID_RE.test(reqId)) { this.log('[runner] git.read is malformed'); return; }
    const result = this.gitw ? await gitRead(this.gitw, task as Parameters<typeof gitRead>[1])
      : { ok: false as const, code: 'error' as const, message: 'the runner has no data home yet' };
    this.post({ op: 'git.read.result', reqId, result });
  }

  // ---------- cancel, release ----------

  private async onCancel(attemptId: string, graceMs: number, reason: CancelReason): Promise<void> {
    if (typeof attemptId !== 'string' || !ULID_RE.test(attemptId)) return;
    const grace = Number.isSafeInteger(graceMs) && graceMs >= 0 && graceMs <= 300_000 ? graceMs : STOP_GRACE_MS;
    const a = this.attempts.get(attemptId);
    if (!a) {
      // Not held here (the runner restarted): stop its labelled containers, then report an exit so main releases them.
      if (this.home) {
        try {
          const found = await this.driver.listResources({ 'nexus.home': this.home, 'nexus.attempt': attemptId });
          for (const c of found.filter((r) => r.kind === 'container')) await this.stopAndKill(c.id, grace);
        } catch (e) { this.log(`[runner] cancel of an attempt not held here: ${msgOf(e)}`); }
      }
      this.post({ op: 'attempt.exited', attemptId, exit: { code: null, oomKilled: false, finishedAt: this.now() }, outputs: [], parsed: [], logBytes: 0, reason: 'cancelled' });
      return;
    }
    if (a.cancel || a.settled) return;
    a.cancel = { graceMs: grace, reason };
    a.log?.nexus(`stopping: ${reason}`);
    // Engine and agent attempts hold no container RunnerCore tracks here: aborting is the whole cancel (the agent
    // turn's own orchestrator, src/runner/agentAttempt.ts, stops and removes its container from this same signal).
    if (a.kind === 'engine' || a.kind === 'agent') { a.abort.abort(); return; }
    if (a.containerState === 'running' && !a.stopIssued) { a.stopIssued = true; await Promise.all(a.containers.map((c) => this.stopAndKill(c, grace))); }
  }

  private async onRelease(attemptId: string): Promise<void> {
    if (typeof attemptId !== 'string' || !ULID_RE.test(attemptId)) return;
    const a = this.attempts.get(attemptId);
    if (!a) { await releaseByLabels({ driver: this.driver, home: this.home, log: this.log }, attemptId); return; }
    a.released = true;
    if (a.settled) { await this.cleanup(a); return; }
    // Main is done with it while it still runs: stop it now; the pipeline ends without reporting and cleans up.
    a.abort.abort();
    for (const c of a.containers) { try { await this.driver.kill(c); } catch { /* already stopped */ } }
  }

  // ---------- restart recovery ----------

  private async onAdopt(attemptId: string, containerId: string, logPath: string): Promise<void> {
    if (typeof attemptId !== 'string' || !ULID_RE.test(attemptId) || !this.paths) return;
    if (this.attempts.has(attemptId)) return;
    const loc = this.paths.parseLogPath(logPath);
    if (!loc) { this.log('[runner] attempt.adopt names a log path outside the data home; ignored'); return; }
    const workDir = this.paths.workDir(loc.jobId, loc.n);
    const rec = await readPlanRecord(this.fs, workDir);
    const plan = rec && (rec.plan as { attemptId?: unknown }).attemptId === attemptId ? rec.plan as unknown as AttemptPlan : null;
    const kind: Kind = plan?.kind === 'service' ? 'service' : 'tool';
    const a = this.newState(attemptId, loc.jobId, loc.n, kind, plan, workDir, this.paths.logPath(loc.jobId, loc.n));
    a.adopted = true;
    // A container is this attempt's only when its labels say so (this install's nexus.home and this nexus.attempt);
    // one that is not (or cannot be checked: Docker down) is never stopped or removed through this attempt.
    const owned = async (id: unknown): Promise<boolean> => {
      if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) return false;
      try {
        const f = await this.driver.inspectResource('container', id);
        return !!f && f.labels['nexus.home'] === this.home && f.labels['nexus.attempt'] === attemptId;
      } catch { return false; }
    };
    a.main = (await owned(containerId)) ? containerId : null;
    if (!a.main && typeof containerId === 'string' && containerId) this.log('[runner] attempt.adopt names a container that cannot be confirmed as belonging to the attempt; it is never touched');
    if (a.main) a.containers.push(a.main);
    if (Array.isArray(rec?.containerIds)) {
      for (const c of rec!.containerIds) if (!a.containers.includes(c) && await owned(c)) a.containers.push(c);
    }
    const exitRec = await this.readExit(workDir);
    if (exitRec && exitRec.attemptId === attemptId) {
      // A durable exit: finalized from the data home alone (no Docker needed), heartbeating `exited` meanwhile.
      a.finalizing = true; a.containerState = 'exited';
      this.startHeartbeat(a);
      return this.finalize(a, plan, exitRec);
    }
    let st: Awaited<ReturnType<RunnerDriver['inspect']>> | null = null;
    if (a.main) { try { st = await this.driver.inspect(a.main); } catch { st = null; } }
    if (st?.state === 'exited' && st.exit) {
      a.finalizing = true; a.containerState = 'exited';
      this.startHeartbeat(a);
      const r: ExitRecord = { attemptId, exit: st.exit };
      await this.writeRecord(a, 'exit.json', r);
      return this.finalize(a, plan, r);
    }
    if (st?.state === 'running' && a.main && plan) {
      a.containerState = 'running';
      this.startHeartbeat(a);
      // Where the log stopped: the last frame's ts, read BEFORE anything is written (final review B3; the old order wrote
      // the "picked up again" frame first and followed from that moment, losing what the container printed meanwhile).
      let since: number | undefined = await lastFrameTs(this.fs, a.logPath);
      if (since === undefined) { try { since = (await this.fs.stat(a.logPath)).mtimeMs; } catch { since = undefined; } }
      await this.openLog(a);
      a.log?.nexus('picked up again after a restart');
      const elapsed = typeof rec?.startedAt === 'number' ? Math.max(0, this.now() - rec.startedAt) : 0;
      try {
        if (plan.kind === 'service') {
          const fwd = a.containers.find((c) => c !== a.main) ?? null;
          if (typeof rec?.hostPort === 'number') {
            this.armService(a, plan, a.main, fwd, rec.hostPort, elapsed);
            return await this.waitService(a, a.main, fwd);
          }
        } else if (plan.kind === 'tool') {
          const cid = a.main;
          a.logDone = null;
          this.followLogs(a, cid, since);
          // An approved install's proxy, found by the record and its labels: its decisions are followed again.
          const proxyId = plan.egressProxy ? a.containers.find((c) => c !== cid) ?? null : null;
          if (proxyId) void this.followProxy(a, proxyId, since, true);
          this.armWall(a, plan.container.limits.wallClockMs, () => [cid, ...(proxyId ? [proxyId] : [])], elapsed);
          this.armGuard(a, plan, cid);
          const exit = await this.waitExit(a, cid);
          if (!exit) { if (!a.released && this.vanished(a)) a.settled = true; return; }
          return await this.collect(a, plan, exit);
        }
      } finally { if (a.released && !a.cleaned) await this.cleanup(a); }
    }
    // No exit recorded and nothing running: nothing honest to report (main's lease ends it as runner_lost).
    this.log(`[runner] attempt ${attemptId.slice(0, 10)} cannot be picked up: no recorded exit and no running container`);
    this.end(a);
  }

  private async finalize(a: AttemptState, plan: AttemptPlan | null, rec: ExitRecord): Promise<void> {
    try {
      this.event(a, 'collecting');
      await this.finishFromRecord(a, plan && plan.kind === 'tool' ? plan : null, rec);
    } catch (e) {
      this.log(`[runner] finalizing attempt ${a.id.slice(0, 10)} stopped: ${msgOf(e)}`);
    } finally {
      if (a.released && !a.cleaned) await this.cleanup(a);
    }
  }

  private async onReconcile(list: { attemptId: string; containerId: string; kind: 'tool' | 'service' }[]): Promise<void> {
    if (!this.paths || !this.store) return;
    const ok = (Array.isArray(list) ? list : []).filter((x) => x && typeof x.attemptId === 'string' && ULID_RE.test(x.attemptId)
      && typeof x.containerId === 'string' && (x.kind === 'tool' || x.kind === 'service'));
    const answer = await reconcileAnswer({ driver: this.driver, fs: this.fs, paths: this.paths, store: this.store, home: this.home }, ok);
    this.post(answer);
  }

  private async onRemove(resources: { kind: 'container' | 'volume' | 'network'; id: string }[]): Promise<void> {
    const r = await removeResources({ driver: this.driver, home: this.home, live: new Set(this.attempts.keys()), log: this.log }, resources);
    this.log(`[runner] leftover resources removed=${r.removed} refused=${r.refused}`);
  }

  // ---------- blobs ----------

  private async onVerify(sha256: string): Promise<void> {
    if (typeof sha256 !== 'string' || !SHA_RE.test(sha256)) return;
    const ok = this.store ? await this.store.verify(sha256) : false;
    this.post({ op: 'blob.verified', sha256, ok });
  }

  private async onGcScan(scanId: string, olderThanMs: number): Promise<void> {
    if (typeof scanId !== 'string' || !ULID_RE.test(scanId) || !this.paths) return;
    const cutoff = this.now() - (Number.isSafeInteger(olderThanMs) && olderThanMs >= 0 ? olderThanMs : 24 * 3_600_000);
    const objects: { sha256: string; bytes: number }[] = [];
    const workDirs: { jobId: string; attemptN: number; mtime: number }[] = [];
    let truncated = false;
    const fs = this.fs;
    try {
      for (const shard of (await fs.readdir(this.paths.objectsDir)).sort()) {
        if (!/^[0-9a-f]{2}$/.test(shard)) continue;
        const dir = path.join(this.paths.objectsDir, shard);
        const st = await fs.lstat(dir);
        if (!st.isDirectory() || st.isSymbolicLink()) continue;
        for (const f of (await fs.readdir(dir)).sort()) {
          if (!/^[0-9a-f]{62}$/.test(f)) continue;
          const s = await fs.lstat(path.join(dir, f));
          if (!s.isFile() || s.mtimeMs >= cutoff) continue;
          if (objects.length >= MAX_GC_LIST) { truncated = true; break; }
          objects.push({ sha256: `${shard}${f}`, bytes: s.size });
        }
      }
    } catch (e) { if (errCode(e) !== 'ENOENT') this.log(`[runner] gc scan of objects stopped: ${msgOf(e)}`); }
    try {
      for (const job of (await fs.readdir(this.paths.workRoot)).sort()) {
        if (!ULID_RE.test(job)) continue;
        for (const n of await fs.readdir(path.join(this.paths.workRoot, job))) {
          if (!/^[1-9][0-9]{0,6}$/.test(n)) continue;
          const s = await fs.lstat(path.join(this.paths.workRoot, job, n));
          if (!s.isDirectory() || s.isSymbolicLink() || s.mtimeMs >= cutoff) continue;
          if ([...this.attempts.values()].some((a) => a.jobId === job && a.n === Number(n))) continue;
          if (workDirs.length >= MAX_GC_LIST) { truncated = true; break; }
          workDirs.push({ jobId: job, attemptN: Number(n), mtime: Math.max(0, Math.floor(s.mtimeMs)) });
        }
      }
    } catch (e) { if (errCode(e) !== 'ENOENT') this.log(`[runner] gc scan of work folders stopped: ${msgOf(e)}`); }
    this.post({ op: 'gc.result', scanId, objects, workDirs, truncated });
  }

  /** `gc.apply`: exactly the listed objects, only under objects/ (exclusive store lock), and the listed finished work folders. */
  private async onGcApply(objects: string[], workDirs: { jobId: string; attemptN: number }[]): Promise<void> {
    if (!this.paths || !this.store) return;
    const shas = (Array.isArray(objects) ? objects : []).filter((s) => typeof s === 'string' && SHA_RE.test(s)).slice(0, MAX_GC_LIST);
    const r = await this.store.deleteObjects(shas);
    let dirs = 0;
    for (const w of (Array.isArray(workDirs) ? workDirs : []).slice(0, MAX_GC_LIST)) {
      if (!w || typeof w.jobId !== 'string' || !ULID_RE.test(w.jobId) || !Number.isSafeInteger(w.attemptN) || w.attemptN < 1) continue;
      if ([...this.attempts.values()].some((a) => a.jobId === w.jobId && a.n === w.attemptN)) continue;
      const dir = this.paths.workDir(w.jobId, w.attemptN);
      if (!(await noLinkUnder(this.fs, this.paths.root, dir))) continue;
      try { await this.fs.rm(dir, { recursive: true, force: true }); dirs++; } catch (e) { this.log(`[runner] a work folder was not removed: ${msgOf(e)}`); }
    }
    this.log(`[runner] gc removed objects=${r.removed} failed=${r.failed} workDirs=${dirs}`);
  }

  // ---------- shutdown ----------

  /**
   * App quit: dev deployments' containers are stopped; tool containers keep running (the next start adopts them);
   * nothing is removed (no container, no work folder, no log). Timers end; logs are closed.
   */
  async shutdown(): Promise<void> {
    this.stopped = true;
    this.builder.cancelAll();
    // Agent turns first: each is aborted (its runtime process killed, its container stopped and removed, its bearer
    // unbound) and awaited; one that does not finish in time has its labelled containers stopped and removed here.
    const agents = [...this.attempts.values()].filter((x) => x.kind === 'agent');
    for (const x of agents) x.abort.abort();
    await Promise.all(agents.map(async (x) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finished = await Promise.race([(x.agentDone ?? Promise.resolve()).then(() => true), new Promise<boolean>((r) => { timer = setTimeout(() => r(false), AGENT_SHUTDOWN_WAIT_MS); })]);
      if (timer) clearTimeout(timer);
      if (finished || !this.home) return;
      try {
        const found = await this.driver.listResources({ 'nexus.home': this.home, 'nexus.attempt': x.id });
        for (const c of found.filter((r) => r.kind === 'container')) { await this.stopAndKill(c.id, 2_000); try { await this.driver.remove(c.id); } catch { /* gone */ } }
      } catch (e) { this.log(`[runner] an agent container was not removed at shutdown: ${msgOf(e)}`); }
    }));
    await this.closeMcpServer();
    await this.procTree?.shutdownTrees();
    const all = [...this.attempts.values()];
    await Promise.all(all.filter((a) => a.kind === 'service' && a.containerState === 'running')
      .map((a) => Promise.all(a.containers.map((c) => this.stopAndKill(c, 2_000)))));
    for (const a of all) {
      this.end(a);
      try { await a.log?.close(); } catch { /* closed */ }
    }
  }
}

/** For tests and the runner entry: the version of the plan record the runner writes. */
export type { PlanRecord };
export { findAttemptDir };
