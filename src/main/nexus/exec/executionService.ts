/**
 * The execution core in main (B2a): it starts recipe jobs for user actions, leases them to
 * attempts under the scheduler's caps, hands each attempt's plan to the runner through a
 * `RunnerPort`, and records what the runner reports. SQLite is the only authority for job
 * state; the runner holds none (constraint 9).
 *
 * - Availability. Built by the platform always; when execution is not enabled (schema v9 off,
 *   held, failed, or the caller's `execution` option false) every user-facing method refuses
 *   with 'platform_unavailable' (`detail.reason` = the sub-reason, default 'not_enabled'),
 *   `tick` and `onRunnerMessage` do nothing, and no v9 table is written (restart recovery's hold mode, on a v9 file
 *   whose execution is off, only reads which jobs have a live attempt; recovery.ts).
 * - Authority. `start` and `retry` authorize `job.create` with the STORED participation
 *   (requireActiveParticipation) before any transaction, so a denial is audited once and
 *   nothing else is written. Inputs must be readable by the caller and be candidate or active
 *   versions of a kind the action's slot accepts (`input_not_allowed`). Params follow the
 *   action's closed schema (`bad_params`) and are refused when secret-shaped
 *   (`secret_in_params`). `cancel` authorizes `job.cancel`, reads `job.read`.
 * - Leases. One IMMEDIATE transaction per lease: the job moves `queued -> leased` as a
 *   compare-and-set (`AND state = 'queued'`, one row), which counts the attempt, and attempt n
 *   is inserted (tr_attempts_insert accepts it only then). A throw between the two rolls both
 *   back. Main refuses to lease or start while blob GC holds its exclusive lock.
 * - Running. A container attempt becomes `running` only on an `attempt.provisioned` report
 *   carrying a passing preflight (constraint 7); a failing or missing report fails the attempt
 *   `limits_not_applied`, the job `failed: infra_error`, and the runner is told to release
 *   (remove) the container. An engine attempt becomes `running` on a container-less report.
 * - Ending. A live attempt is always ended BEFORE its job is requeued or ended (the v9
 *   backstop trigger). A job completes only through the ingest port after its current attempt
 *   succeeded; without an ingest port an exit with its outputs present fails
 *   `ingest_unavailable`: unfinished work is never marked completed (constraint 4).
 * - Ingest (Task 8). An accepted exit is made durable first, in its own transaction (phase
 *   `collecting`, one `attempt.output` event). Then the port's `prepare` may gather facts main
 *   observes itself (async), and `ingestTx` runs in ONE transaction under the BlobIndex shared
 *   ingest lock with a live token: synchronously when no GC holds the lock, else after GC
 *   releases it (never during GC). The attempt and job move in that transaction; the evidence
 *   backstop (a validation or version bound to (job, n)) still applies. A throw that refuses the
 *   outputs deterministically (`invalid`, `input_not_granted`, a stored constraint, ...) fails
 *   `invalid_output` with its reason and is never retried; any other throw is `ingest_error`
 *   (retryable). An exit with more than ASYNC_INGEST_OUTPUTS outputs commits on a later turn.
 *   A replayed exit while collecting is dropped. Recipe checks (`validate` jobs with a recipe)
 *   lease like tool jobs and read `params.versionId` as input. A tree output (a build) is judged
 *   by its validators, not by the bare contract paths. The validation framework's pass runs in
 *   every tick but works only when some is due; a validate job that ends tells it (onJobEnded),
 *   and a runner-wide fault (no attempt named, the port leaving `ready`, a replaced port) errors
 *   outstanding re-hashes.
 * - Runner messages are validated by `parseRunnerMessage`, then: the attempt is known, its
 *   lease owner is this boot, `attempt.event` seq is strictly increasing. Anything else is
 *   dropped with one log line and no write. Each handler is one small transaction.
 * - Cancel cascades to children first (ix_jobs_parent), withdraws a pending approval, ends
 *   the live attempt (`cancelled`), flags the job's drafts `cancelled_partial`, then cancels
 *   the job, all in one transaction; `attempt.cancel` is sent after commit. A later exit of a
 *   cancelled attempt is dropped (cancel wins).
 * - Timeout: the wall clock of the current attempt, counted from its lease and excluding time
 *   the job spent in `awaiting_approval`. An attempt whose exit is durable and whose outputs are being collected is out
 *   of its wall clock (it already ran); collecting has its own deadline (COLLECT_DEADLINE_MS, then `ingest_error`,
 *   retryable), so a blob GC that holds the store never times out finished work (final review A3). Retry: an idempotent
 *   recipe whose attempt failed for an infrastructure reason goes `retry_scheduled` (backoff 10 s, 60 s, 300 s), then
 *   `queued`.
 * - A lease transaction that throws a deterministic PlatformError('invalid') (a record that cannot be stored, ...) is
 *   not retried every tick: the job's attempt fails `bad_plan` in a second transaction (final review A1).
 * - Jobs waiting for git (`waiting:git`, the runner found none) are not leased again while main itself finds no git
 *   binary (`resolveGitBinary`, file system only, at most every GIT_RECHECK_MS): no abandoned attempt per backoff step
 *   (final batch item 3).
 * - `requestProbe()` asks the runner for a fresh probe now, at most once per PROBE_REQUEST_MIN_MS (the setup sheet's
 *   "Check again", #23 with `{ probe: true }`); it never waits for the answer.
 * - Heartbeats extend the lease and set `heartbeat_at` only (no activity, no event). The message
 *   handler keeps the latest one per attempt in memory; the next tick (every second) writes them
 *   all in one transaction before it sweeps leases. A 45 s gap writes one `attempt.heartbeat_gap` event.
 * - A mid-session runner restart (B2a close) holds lease expiry for the attempts this boot held when the runner went
 *   away, while the port is not `ready` or the reconcile requested since then has had no answer; at the answer their
 *   leases move by the downtime before phase B decides. Bounded by the reconcile bound (at most the first request + 15
 *   minutes) and ended at once when the runner is `unavailable` (recovery.ts, `runnerOutageHoldEnded`).
 * - Every job transition writes one activity row (JobService) and one `job_events` row in the
 *   same transaction. Recovery (Task 10, recovery.ts) rebuilds from these rows: live attempts are exactly
 *   the `starting` and `running` ones, each with its lease owner. `recoverPhaseA` runs at platform startup
 *   (database only), `recoverPhaseB` at every runner `ready` with the runner's answer to `reconcileList()`, and
 *   `recoverBlobStore` after it; an attempt adopted for finalization (its container exited while the app was
 *   closed) has no wall clock left and waits, within one fresh lease, for the runner's re-reported exit.
 * - Approvals, image builds and dev deployments (Task 9). An egress recipe's lease asks the approval port for a
 *   pending approval and moves `leased -> running (phase approval) -> awaiting_approval` in the lease transaction; no
 *   plan is built or sent. The user's `once` (ApprovalService.respond) consumes the approval for the current attempt and
 *   resumes the job in its own transaction (resumeApprovedTx); `deny` and expiry fail it `denied` (endAwaitingTx). The
 *   plan of an egress recipe carries only an approval of this job consumed by this attempt (planBuilder refuses any
 *   other). `image.build.*` reports go to the image port; a probe's images are judged against the latest succeeded
 *   build of their profile (a different context label: `image_mismatch`). A dev deployment (`sde.preview.start`) gets
 *   its deployment row at lease (DeploymentPort.startTx), its loopback port from `attempt.provisioned`, its health from
 *   `service.health`; it is never requeued, its exit is judged by the deployment (completed `stopped` only after a
 *   passed health check), and any terminal move of its job ends a deployment that is still live, with the job's cause.
 *   A consumed approval whose job has not started within 15 minutes fails it (`denied`, `approval_stale`); an attempt
 *   another boot owns is never started here (`waiting:runner`). A runner-wide fault interrupts running image builds.
 *   With a repository check configured, the snapshot action starts only through RepoService (its REPOSITORY_CHECKED
 *   token); otherwise the core still keeps one live snapshot job per project.
 * - Diagnosis (B2a Task 12). `sde.diagnose` names a dev deployment or a job of the project by params; it is resolved and
 *   authorized (`job.read` on the subject's job) at start and recorded in the job's capability. At lease main reads the
 *   subject's newest container and the tails of its newest attempt logs from its own rows (no project folder); the
 *   ingest adds main's own probe table and stores the report (`diag.schema`). Every attempt's environment records the
 *   image's `nexus.versions` label.
 */
import type Database from 'better-sqlite3';
import type { ImageStatus, SandboxProfile, SandboxProfileId, StagedOutput, ParsedOutput, ExitInfo, ResourceLimits } from '../../../shared/nexus/execution';
import { DIAGNOSE_MAX_RANGES, SANDBOX_PROFILE_IDS } from '../../../shared/nexus/execution';
import type { Job, JobKind, JobState, Principal, ScopeRef } from '../../../shared/nexus/platform';
import { getUserAction, type UserActionDef } from '../../../shared/nexus/actions';
import type { ParamsSchema } from '../../../shared/nexus/domainSpec';
import { getRecipe, PREVIEW_IDLE_TTL_MS, RETRY_BACKOFF_MS, type RecipeDef } from '../../../shared/nexus/recipes';
import { APPROVAL_TTL_MS, EXPIRY_SWEEP_MS, latestSucceededBuild, withdrawPendingApprovalsTx } from '../approvals/approvalService';
import { previewBlocker, readAppManifest, REPOSITORY_CHECKED, type AppManifest } from '../repo/repoService';
import {
  EPHEMERAL_PORT_MAX, EPHEMERAL_PORT_MIN, parseRunnerMessage, type CancelReason, type McpReplyResult, type RunnerToMain
} from '../../../shared/nexus/runnerProtocol';
import { evaluateGate, leaseFloorBytes, type GateResult } from '../../../shared/nexus/resourceGate';
import type { AuthService } from '../auth/authService';
import { PrincipalResolver } from '../auth/principals';
import { containsSecret, redactText } from '../activity/redact';
import { appendActivityRow } from '../activity/writer';
import type { BlobIndex, IngestToken } from '../blobs/blobIndex';
import { getValidator } from '../../../shared/nexus/validators';
import { newId } from '../db/ids';
import { immediateTx } from '../db/tx';
import { cachedStmt } from '../db/stmtCache';
import { PlatformError } from '../errors';
import { ProjectAccess } from '../project/projectAccess';
import { canRetry, isJobState, TERMINAL_JOB_STATES } from '../jobs/jobRules';
import { JOB_KINDS, requireActiveParticipation, storedWorkspace, validateKey, type JobRow, type JobService } from '../jobs/jobService';
import {
  attemptRow, HEARTBEAT_GAP_MS, LEASE_MS, heartbeatTx, insertAttemptTx, liveAttemptOf, MAX_ENVIRONMENT_JSON_CHARS, transitionAttemptTx, type AttemptRow
} from './attempts';
import { appendJobEventTx, toJobEvent, type JobEvent, type JobEventRow } from './events';
import {
  boundedRecord, buildPlan, depsVolumeName, imageRef, lockfileSha256Of, RECORD_MAX_CHARS, sandboxRecord, underDataHome, type DiagnoseContext,
  type PlanApproval, type PlanInput, type ServiceContext
} from './planBuilder';
import { stat } from 'node:fs/promises';
import { resolveGitBinary } from '../../gitBinary';
import { EGRESS_PROXY_PROFILE } from '../../../shared/nexus/egressPolicy';
import { homeLabel } from '../../../shared/nexus/homeLabel';
import type { RunnerPort } from './runnerPort';
import { backoffMs, DEFAULT_CAPS, leaseGuard, SOLO_MEMORY_SHARE, usableImage, type LiveUse, type ProbeCache, type SchedulerCaps } from './scheduler';
import {
  contractMet, exitFailure, failUnreconciled, reconcileBoundDue, recoverBlobStore, recoverPhaseA, recoverPhaseB, reconcileList, runnerOutageHoldEnded,
  type BlobStoreFiles, type BlobSweepReport, type PhaseAReport, type PhaseBReport, type ReconcileResult, type RecoveryHost
} from './recovery';

export { contractMet };

export interface StartJobRequest {
  projectId: string; workspaceId: string; actionId: string;
  inputs: { versionId: string; slot: string }[]; params: Record<string, unknown>; intentId: string;
}
export interface JobFilter { projectId?: string; workspaceId?: string; states?: JobState[]; jobKind?: JobKind; limit?: number }

export type Headline =
  | 'queued' | 'waiting:runner' | 'waiting:docker' | 'waiting:image' | 'waiting:disk' | 'waiting:slots' | 'waiting:memory'
  | 'waiting:git' | 'waiting:retry' | 'provisioning' | 'running' | 'waiting_for_approval' | 'collecting' | 'validating'
  | 'checks_passed' | 'checks_failed' | 'checks_could_not_run' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';

export interface ExecJob extends Job {
  recipeId: string | null; actionId: string | null; phase: string | null; nextAttemptAt: number | null; headline: Headline;
}
export interface AttemptView {
  id: string; n: number; state: string; outcome: string | null; exitCode: number | null; signal: string | null; oomKilled: boolean | null;
  network: string | null; preflight: { ok: boolean; problems: string[] } | null; error: { code: string; message: string } | null;
  createdAt: number; startedAt: number | null; finishedAt: number | null;
  /** B2a Task 13: the sandbox image and profile the attempt's environment recorded (null for an engine attempt). */
  imageId?: string | null; profile?: string | null;
}
export interface JobDetail extends ExecJob {
  /** Every attempt, oldest first (`attempts` stays the count). */
  attemptHistory: AttemptView[];
  approvals: { id: string; status: string; reason: string; expiresAt: number }[];
  outputs: { versionId: string; status: string; outputPath: string | null }[];
  /** B2a Task 13: the dev deployment the job runs (a preview job), if any. */
  deployment?: { id: string; status: string } | null;
}
export interface HealthSnapshot {
  execution: { available: boolean; reason: string | null };
  runner: { state: string; attached: boolean; faults: number };
  docker: { state: 'unknown' | 'missing' | 'stopped' | 'running'; version?: string; cpus?: number; memoryBytes?: number; os?: string; wsl2?: boolean };
  images: { profile: SandboxProfileId; present: boolean; matches: boolean; sizeBytes?: number; imageId?: string }[];
  disk: { freeBytes: number | null; leaseFloorBytes: number };
  /**
   * The resource gate (ruled, final review C2): its 30 GiB `disk_low` gates image preparation and the verification checks
   * (test:exec) only. Jobs lease while free space is above `disk.leaseFloorBytes`; below 30 GiB `disk_low` is an advisory
   * for them, and `setupAvailability` answers `setup:disk_low` only below the lease floor (or for image preparation).
   */
  gate: GateResult | null;
  checkedAt: number | null;
  /** B2a Task 13: the database file's schema version (PRAGMA user_version), and the GPU line of the last probe. */
  schemaVersion?: number | null;
  gpu?: { detected: boolean; model?: string };
}

/**
 * The approval path for egress recipes (Task 9: ApprovalService). `requestEgressTx` inserts the pending approval row
 * inside the lease transaction; a PlatformError 'invalid' from it fails the job at lease (nothing is asked). When the
 * port also has `expireDue`, the scheduler runs it every EXPIRY_SWEEP_MS.
 */
export interface EgressApprovalPort {
  requestEgressTx(job: { id: string; projectId: string; onBehalfOf: string }, attempt: { id: string; n: number }, recipe: RecipeDef, now: number): string;
  expireDue?(now: number): number;
}

/**
 * Image builds (Task 9: ApprovalService): the runner's `image.build.*` reports, the runner being lost (running builds
 * end `interrupted`), and the scheduler's pass (the build deadline).
 */
export interface ImageBuildPort {
  onImageBuildProgress(m: Extract<RunnerToMain, { op: 'image.build.progress' }>): void;
  onImageBuildDone(m: Extract<RunnerToMain, { op: 'image.build.done' }>): void;
  onRunnerLost?(): number;
  tick?(now: number): void;
}

/** Local dev deployments (Task 9: DeploymentService). Every `...Tx` runs inside the core's transaction. */
export interface DeploymentPort {
  byJob(jobId: string): { id: string } | null;
  prepareStart(jobId: string, subjectVersionId: string | null, now: number): { deploymentId: string; manifest: AppManifest; files: { sha256: string; path: string }[] };
  startTx(j: { id: string; project_id: string; participation_id: string | null; workspace_id: string; on_behalf_of: string },
    attempt: { n: number }, deploymentId: string, subjectVersionId: string, now: number,
    facts?: { buildVersionId: string | null; profile: string | null; appImageId: string | null; forwarderImageId: string | null }): string;
  portHeld(port: number, jobId: string): boolean;
  onProvisionedTx(jobId: string, attemptN: number, hostPort: number, now: number): void;
  onHealth(deploymentId: string, probe: { status: number | null; ms: number | null; container: 'running' | 'exited' | 'missing' }): void;
  onExitedTx(jobId: string, a: { n: number; started_at: number | null; sandbox_json: string | null }, now: number):
    { decision: 'complete' | 'stopped' | 'fail'; cause: string };
  endForJobTx(jobId: string, to: string, now: number, cause?: { outcome: string | null; code: string | null }): void;
  stopForCancelTx(p: Principal, jobId: string, now: number): void;
  tick(now: number): void;
}

/** What the runner reported for an exited attempt (the `attempt.exited` message, validated). */
export interface AttemptExited { exit: ExitInfo; outputs: StagedOutput[]; parsed: ParsedOutput[]; logBytes: number }
export interface IngestContext {
  system: Principal; job: JobRow; attempt: AttemptRow; recipe: RecipeDef;
  exited: AttemptExited;
  /** The live token of the shared blob ingest lock (null only on a platform without a blob index). */
  token?: IngestToken | null;
  /** What `prepare` gathered before the transaction (main's own git answers). */
  facts?: unknown;
}
/** What ingest decided inside its transaction. `ok` completes the job; anything else fails it. */
export type IngestDecision = { ok: true; outcome?: string } | { ok: false; outcome: string; error: { code: string; message: string } };
/**
 * Ingest (Task 8). After the exit is durable (phase `collecting` and an `attempt.output` event, in their own
 * transaction), `prepare` may gather facts main observes itself (async, outside any transaction), then `ingestTx`
 * runs in ONE IMMEDIATE transaction under the shared blob ingest lock and writes versions, blobs and validations;
 * the core then moves the attempt and the job in that same transaction.
 */
export interface IngestPort {
  prepare?(ctx: IngestContext): unknown;
  ingestTx(ctx: IngestContext): IngestDecision;
}
/**
 * B2b (Task 5): the MCP gateway's hooks into the runner messages. `call` runs the whole verify/authorize/run/audit
 * pipeline for one relayed `mcp.call` and resolves with the value ExecutionService sends back as `mcp.reply`; it never
 * throws (a thrown service call is turned into a refusal result by the gateway itself). `onExecDone` records a granted
 * `sandbox_exec`'s reported exit; it returns false for an execId the gateway never granted or that names another
 * attempt, which ExecutionService drops with one log line (F1) and never writes for.
 */
export interface McpGatewayPort {
  call(m: Extract<RunnerToMain, { op: 'mcp.call' }>): Promise<McpReplyResult>;
  onExecDone(m: Extract<RunnerToMain, { op: 'agent.exec.done' }>): boolean;
}

/** The validation framework's hooks into the scheduler and the runner messages (Task 8). */
export interface ValidationHooks {
  /** The scheduler's pass: the framework does work only when some is due. */
  tick(now: number): void;
  runPending(now: number): void;
  onBlobVerified(sha256: string, ok: boolean): void;
  /** Runner-wide: a fault naming no attempt, or the port left `ready` or was replaced. */
  onRunnerFault(): void;
  /** A validate job reached a terminal state (a recipe check may need its result recorded). */
  onJobEnded?(): void;
  /** Restart recovery: a main check interrupted mid-run is queued again (inside the caller's transaction). */
  requeueCheckTx?(system: Principal, jobId: string): string[];
}

/** The data home as the core sees it. The blob store file methods (DataHome has them) serve restart recovery's hygiene pass. */
export interface ExecDataHome extends Partial<BlobStoreFiles> {
  root: string; attemptWorkRel(jobId: string, n: number): string; attemptLogPath(jobId: string, n: number): string;
  /** A stored object's bytes (at most `maxBytes`), read through its confined path: what an install's ingest re-reads. */
  readObjectBytes?(sha256: string, maxBytes: number): Promise<Buffer | 'too_large' | null>;
  /**
   * B2b: the per-job folder main writes an agent turn's own files into (`jobs/<jobId>`), and the data home's
   * confinement, reused by ContextResolver and Skills (agents/contextResolver.ts, agents/skills.ts).
   */
  jobRel(jobId: string): string;
  confineToDataHome(rel: string): Promise<string | null>;
}

export interface ExecutionDeps {
  auth: AuthService; jobs: JobService; now: () => number; log?: (line: string) => void;
  available: boolean; unavailableReason?: string | null;
  blobs: BlobIndex | null;
  dataHome?: ExecDataHome | null;
  profiles?: readonly SandboxProfile[];
  /** main's acceptance of a stored project folder (index.ts `acceptFsRoot`); null refuses it. */
  acceptFsRoot?: ((root: string) => string | null) | null;
  approvals?: EgressApprovalPort | null;
  /** Image builds (Task 9); null: `image.build.*` reports are dropped. */
  images?: ImageBuildPort | null;
  /** Dev deployments (Task 9); null: the preview action is `not_in_this_build`. */
  deployments?: DeploymentPort | null;
  /**
   * True when snapshot requests go through RepoService's repository check (the platform has `isRepository`): the
   * public `start` then refuses the snapshot action (`repository_check_required`) unless RepoService passes its token.
   */
  snapshotsNeedRepositoryCheck?: boolean;
  ingest?: IngestPort | null;
  validation?: ValidationHooks | null;
  caps?: Partial<SchedulerCaps>;
  hooks?: { afterLeaseTransition?: (jobId: string) => void };
  /** The Nexus app version, recorded in every attempt's environment. */
  appVersion?: string | null;
  /**
   * Main's own look for a git binary (default: `resolveGitBinary` over the file system; no process is started). A job
   * the runner sent back `waiting:git` is leased again only once this finds one (final batch item 3).
   */
  findGit?: (() => Promise<string | null>) | null;
  /**
   * B2b (Task 5): the MCP gateway; null drops `mcp.call` and `agent.exec.done` with one log line each (no agent
   * services in this build). Platform.ts builds this AFTER the execution core (ExecQueries needs `exec`), so it is
   * bound in with `bindMcpGateway` rather than passed here at construction (the same late-binding `validation` uses
   * through `setSender`, in the other direction).
   */
  mcpGateway?: McpGatewayPort | null;
}

interface ExecJobRow extends JobRow {
  capabilities_json: string; limits_json: string; next_attempt_at: number | null; state_json: string | null;
}
interface Capability {
  action: string; recipe: string; recipeVersion: string; executor: string; network: string; profile: SandboxProfileId | null;
  /** A dev deployment: the application version it previews (a draft may be previewed; the job's input is its build). */
  subjectVersionId?: string;
  /**
   * A diagnosis (B2a Task 12): what it diagnoses, resolved and authorized at start (the subject job's id; for a
   * deployment, also the application version it previews, the report's lineage source).
   */
  diagnose?: { target: 'deployment' | 'job'; targetId: string; jobId: string; subjectVersionId: string | null };
}

const PLATFORM: ScopeRef = { type: 'platform' };
const LIVE_JOB_STATES: readonly JobState[] = ['queued', 'leased', 'running', 'awaiting_approval', 'retry_scheduled'];
/** Attempt failures an idempotent recipe is retried for (infrastructure, not the work itself). */
const RETRYABLE = new Set(['docker_resources', 'disk_full', 'container_vanished', 'docker_error', 'io_error', 'ingest_error', 'runner_lost']);
const CANCEL_GRACE_MS = 10_000;
/** A diagnosis reads at most this much of the end of each of its subject's newest two attempt logs. */
export const DIAGNOSE_LOG_TAIL_BYTES = 64 * 1024;
/** A gap between ticks longer than this is a stall of main (or the machine), not silence of the runner. */
export const TICK_STALL_MS = 10_000;
/** A gap this long (machine sleep) is also excluded from wall clocks, up to 1x the attempt's wall clock in all. */
export const SLEEP_GAP_MS = 5 * 60_000;
/** After this many consecutive failed `attempt.start` sends the runner counts as not ready until it reports again. */
export const MAX_SEND_FAILURES = 3;
/** Requeue backoff after a start that never ran (not sent, or refused with a waiting reason): 2 s doubling to 60 s. */
export const REQUEUE_BACKOFF_MIN_MS = 2_000;
export const REQUEUE_BACKOFF_MAX_MS = 60_000;
export const MAX_START_INPUTS = 64;
export const MAX_EXEC_LIST_LIMIT = 500;
export const DEFAULT_EXEC_LIST_LIMIT = 100;
export const MAX_EVENTS_LIMIT = 500;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const REFUSE_TO_FAIL = new Set(['bad_plan', 'network_not_approved', 'unknown_attempt', 'input_changed']);
const REFUSAL_WAIT: Record<string, string> = {
  docker_missing: 'waiting:docker', docker_stopped: 'waiting:docker', image_missing: 'waiting:image', image_mismatch: 'waiting:image',
  disk_low: 'waiting:disk', busy: 'waiting:slots',
  // No git installed (the plan stages a checkout or runs a git engine): the job waits for git, never fails.
  git_missing: 'waiting:git'
};

/** An exit reporting more outputs than this is ingested on a later turn (the exit handler stays short). */
export const ASYNC_INGEST_OUTPUTS = 256;
/** Collecting (the exit is durable, the outputs are being ingested) ends `ingest_error` after this long (final review A3). */
export const COLLECT_DEADLINE_MS = 10 * 60_000;
/** A job waiting for git is not leased again until main finds git; main looks at most this often (final batch item 3). */
export const GIT_RECHECK_MS = 5_000;
/** `requestProbe()` sends at most one probe per this long (#23 `{ probe: true }`, the setup sheet's "Check again"). */
export const PROBE_REQUEST_MIN_MS = 5_000;
/** A dev deployment's job: the fixed 2 h lifetime is ended by the deployment; the job's wall clock is a backstop after it. */
export const SERVICE_WALL_MARGIN_MS = 10 * 60_000;
/** How often the scheduler runs the dev deployments' pass (start windows, lifetime). */
export const DEPLOYMENT_TICK_MS = 5_000;
/** Ingest throws that are the outputs' fault, not the infrastructure's: retrying cannot change them. */
const DETERMINISTIC_INGEST_CODES = new Set(['invalid', 'input_not_granted', 'immutable', 'not_found', 'participation_inactive']);
const LABEL_RE = /^[a-z][a-z0-9_.-]{0,63}$/;

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const parseJson = (text: string | null): unknown => { if (text === null) return null; try { return JSON.parse(text) as unknown; } catch { return null; } };
/** A record over `max` characters even without its argv lists: the record keeps its executor and argv facts only. */
const withoutKey = (r: Record<string, unknown>, max: number): Record<string, unknown> => {
  const b = boundedRecord(r);
  if (JSON.stringify(b).length <= max) return b;
  const keep: Record<string, unknown> = {};
  for (const k of ['executor', 'name', 'profile', 'image', 'argvCount', 'argvSha256', 'network', 'limits', 'containerId', 'preflight']) if (k in b) keep[k] = b[k];
  return keep;
};
const invalid = (reason: string, message: string): never => { throw new PlatformError('invalid', message, { reason }); };

/**
 * A throw out of an ingest that is a deterministic refusal of the outputs, as the error to record (`{ code: reason }`),
 * or null when it may be transient. Its message names the reason only (never a value from the outputs).
 */
export function deterministicIngestRefusal(e: unknown): { code: string; message: string } | null {
  if (e instanceof PlatformError && DETERMINISTIC_INGEST_CODES.has(e.code)) {
    const r = e.detail?.reason;
    const reason = typeof r === 'string' && LABEL_RE.test(r) ? r : e.code;
    const code = reason === 'secret_in_metadata' ? 'secret_in_output' : reason;
    return { code, message: `the outputs were refused: ${code}` };
  }
  const sqlite = (e as { code?: unknown } | null)?.code;
  if (typeof sqlite === 'string' && sqlite.startsWith('SQLITE_CONSTRAINT')) {
    return { code: 'constraint', message: 'the outputs were refused: they break a stored rule' };
  }
  return null;
}

/** Params against an action's closed schema; also refuses paths, `..` and NUL in any string. */
export function checkParams(schema: ParamsSchema, params: unknown): Record<string, unknown> {
  if (!isPlainObject(params)) return invalid('bad_params', 'params must be an object');
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(params)) {
    if (!Object.prototype.hasOwnProperty.call(schema.properties, k)) invalid('bad_params', `unknown parameter ${k.slice(0, 32)}`);
  }
  for (const r of schema.required) if (!Object.prototype.hasOwnProperty.call(params, r)) invalid('bad_params', `parameter ${r} is required`);
  for (const [k, def] of Object.entries(schema.properties)) {
    if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
    const v = params[k];
    if (def.type === 'string') {
      if (typeof v !== 'string' || v.length > def.maxLength) invalid('bad_params', `parameter ${k} must be a string of at most ${def.maxLength}`);
      const s = v as string;
      if (s.includes('\0') || s.includes('/') || s.includes('\\') || s.includes('..')) invalid('bad_params', `parameter ${k} may not hold a path`);
      if (def.pattern !== undefined && !new RegExp(def.pattern).test(s)) invalid('bad_params', `parameter ${k} has a bad shape`);
      if (def.enum !== undefined && !def.enum.includes(s)) invalid('bad_params', `parameter ${k} is not an allowed value`);
    } else if (def.type === 'integer') {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < def.minimum || v > def.maximum) invalid('bad_params', `parameter ${k} is out of range`);
    } else if (typeof v !== 'boolean') {
      invalid('bad_params', `parameter ${k} must be a boolean`);
    }
    out[k] = v;
  }
  if (containsSecret(params)) throw new PlatformError('invalid', 'params hold a secret-shaped key or value', { reason: 'secret_in_params' });
  return out;
}

/** The headline of a job (see ExecutionService.headline): never a bare "completed". */
export function headlineFrom(f: { state: JobState; phase: string | null; liveAttempt: string | null;
  checks?: { failed: number; error: number; passed: number; pending: number }; waitingRunner?: boolean }): Headline {
  if (f.waitingRunner === true && (f.state === 'leased' || (f.state === 'running' && f.phase !== 'approval'))) return 'waiting:runner';
  switch (f.state) {
    case 'queued': return f.phase && /^waiting:(runner|docker|image|disk|slots|memory|git)$/.test(f.phase) ? f.phase as Headline : 'queued';
    case 'retry_scheduled': return 'waiting:retry';
    case 'leased': return 'provisioning';
    case 'awaiting_approval': return 'waiting_for_approval';
    case 'running': return f.phase === 'approval' ? 'waiting_for_approval' : f.liveAttempt === 'running' ? 'running' : 'provisioning';
    case 'completed': case 'partial': {
      const c = f.checks ?? { failed: 0, error: 0, passed: 0, pending: 0 };
      if (c.failed > 0) return 'checks_failed';
      if (c.error > 0) return 'checks_could_not_run';
      if (c.pending > 0) return 'validating';
      return c.passed > 0 ? 'checks_passed' : 'checks_could_not_run';
    }
    default: return f.state as Headline;
  }
}

export class ExecutionService {
  private readonly access: ProjectAccess;
  private readonly principals: PrincipalResolver;
  private readonly log: (line: string) => void;
  private readonly caps: SchedulerCaps;
  private port: RunnerPort | null = null;
  private unsubscribe: (() => void) | null = null;
  private bootId: string | null = null;
  private probe: ProbeCache | null = null;
  private probeSentAt: number | null = null;
  private faults = 0;
  private readonly lastSeq = new Map<string, number>();
  private readonly gapFlagged = new Set<string>();
  /** The latest heartbeat of each attempt, written by the next tick (the message path does no I/O for heartbeats). */
  private readonly hbPending = new Map<string, { at: number; logBytes: number; outBytes: number }>();
  private attemptById: Database.Statement | null = null;
  private lastTickAt: number | null = null;
  /** Recent sleep-like scheduler stalls (in memory; a restart starts clean and recovery decides). */
  private readonly stalls: { from: number; to: number }[] = [];
  /** When the last stall compensation extended the leases (at most once per LEASE_MS). */
  private lastExtensionAt: number | null = null;
  /** Consecutive `attempt.start` sends that failed while the port said ready. */
  private sendFailures = 0;
  /** Attempts whose exit is durable and whose outputs are being ingested (a replayed exit is dropped meanwhile). */
  private readonly collecting = new Set<string>();
  /** When each collecting attempt's exit became durable (COLLECT_DEADLINE_MS counts from it). */
  private readonly collectingSince = new Map<string, { at: number; exited: AttemptExited }>();
  /** Whether main's last look found a git binary (null: not looked yet), when it looked, and a look in flight. */
  private gitPresent: boolean | null = null;
  private gitCheckedAt: number | null = null;
  private gitChecking = false;
  /** When `requestProbe()` last sent a probe. */
  private probeRequestedAt: number | null = null;
  /**
   * Attempts restart recovery adopted for finalization: their container exited while the app was closed, and the runner
   * reports the exit again after re-hashing `/out`. Their wall clock is over (they exited); their lease still runs.
   * In memory only: phase B rebuilds it at every runner `ready`.
   */
  private readonly awaitingExit = new Set<string>();
  /** The boot id phase A re-owned approval waits for (main attaches the runner with the same one). */
  private recoveryBootId: string | null = null;
  /** When phase A ran (the reconcile bound counts from it) and when the bound's pass last ran. */
  private recoveredAt: number | null = null;
  private lastUnreconciledAt: number | null = null;
  /**
   * When main first asked the runner to reconcile after phase A (`reconcileList`; recorded once per phase A, so later
   * requests never move the bound), and whether a request still waits for its phase B.
   */
  private reconcileRequestedAt: number | null = null;
  private reconcileOutstanding = false;
  /** Ingests that went asynchronous (main's git answers, a wait for blob GC, or a large output list). */
  private readonly pendingIngest = new Set<Promise<unknown>>();
  /** B2b (Task 5): the MCP gateway, bound in after construction (bindMcpGateway); null drops mcp.call/agent.exec.done. */
  private mcpGateway: McpGatewayPort | null = null;
  /** In-flight `mcp.call` gateway promises (each resolves to the `mcp.reply` this sends); tracked so a caller may await them in tests. */
  private readonly pendingMcp = new Set<Promise<unknown>>();
  /** The port state the last tick saw (leaving `ready` is a runner-wide fault for outstanding re-hashes). */
  private lastPortState: string | null = null;
  /** The images as the runner last reported them (the cached probe holds them judged against the image builds). */
  private rawImages: ImageStatus[] | null = null;
  /** When the expiry sweep and the dev deployments' pass last ran (cadence only; the rows decide). */
  private lastExpiryAt: number | null = null;
  /**
   * A mid-session runner restart (B2a close, user decision 2026-10-21). `since`: when the scheduler last saw the runner
   * live (the downtime counts from it); `requestedAt`: the first reconcile request during the outage (null: none yet);
   * `held`: the live attempts this boot owned when the outage opened (only their leases are held, never an attempt
   * leased later); `lifted`: the hold ended without an extension (the bound, or the runner is unavailable).
   */
  private outage: { since: number; requestedAt: number | null; held: Set<string>; lifted: boolean } | null = null;
  /** When a tick last saw the port `ready` with no outage open (null: never, so a ready port is the app start). */
  private lastLiveAt: number | null = null;
  private lastDeploymentPassAt: number | null = null;
  private lastImagePassAt: number | null = null;

  constructor(private readonly db: Database.Database, private readonly deps: ExecutionDeps) {
    this.access = new ProjectAccess(db, { auth: deps.auth });
    this.principals = new PrincipalResolver(db);
    this.log = deps.log ?? (() => {});
    this.caps = { ...DEFAULT_CAPS, ...(deps.caps ?? {}) };
    this.mcpGateway = deps.mcpGateway ?? null;
  }

  /** B2b: binds the MCP gateway after construction (platform.ts builds it once the execution core and ExecQueries exist). */
  bindMcpGateway(gateway: McpGatewayPort | null): void { this.mcpGateway = gateway; }

  /** Test-only: resolves once every `mcp.call` reply in flight has been sent. */
  async mcpCallsSettled(): Promise<void> { await Promise.all([...this.pendingMcp]); }

  /**
   * When the scheduler last ran the approval expiry sweep (`approvals.expireDue`), or null when it never has. Read-only:
   * a soundness check passes it as O21's `sweptAt` and never sweeps itself (B2a Task 13 fix round 2).
   */
  get lastExpirySweepAt(): number | null { return this.lastExpiryAt; }

  get available(): boolean { return this.deps.available; }
  /** Why execution is off (the store's reason, `not_enabled`, `registry_invalid`, ...), or null while it is on. */
  get unavailableReason(): string | null { return this.deps.available ? null : (this.deps.unavailableReason ?? 'not_enabled'); }

  private requireAvailable(): void {
    if (!this.deps.available) {
      throw new PlatformError('platform_unavailable', 'execution is not available on this database', { reason: this.deps.unavailableReason ?? 'not_enabled' });
    }
  }

  private system(): Principal { return this.principals.system(); }

  // ---------- runner ----------

  /** Attach (or detach, with null) the runner. Sends `hello` and a `probe`; messages flow to onRunnerMessage. */
  attachRunner(port: RunnerPort | null, bootId: string): void {
    if (this.unsubscribe) { try { this.unsubscribe(); } catch { /* the old port is gone */ } }
    // A replaced or detached port: whatever it was asked to re-hash will not be answered.
    if (this.port) this.runnerWideFault();
    this.unsubscribe = null; this.port = null; this.probe = null; this.probeSentAt = null; this.lastPortState = null;
    if (!this.deps.available) { if (port) this.log('[nexus] exec: runner not attached: execution is not available'); return; }
    if (!port) return;
    if (typeof bootId !== 'string' || !ULID_RE.test(bootId)) throw new PlatformError('invalid', 'bootId must be a ULID');
    this.port = port; this.bootId = bootId;
    if (this.recoveryBootId !== null && bootId !== this.recoveryBootId) {
      this.log('[nexus] exec: the runner is attached with another boot id than restart recovery used; approval waits are re-owned at runner ready');
    }
    this.unsubscribe = port.onMessage((raw) => this.onRunnerMessage(raw));
    const root = this.deps.dataHome?.root ?? '';
    this.send({ op: 'hello', bootId, dataHome: root, home: root ? homeLabel(root) : '', profiles: [...(this.deps.profiles ?? [])] });
    this.sendProbe(this.deps.now());
  }

  private send(msg: Parameters<RunnerPort['send']>[0]): boolean {
    if (!this.port) return false;
    try { this.port.send(msg); return true; } catch (e) {
      this.log(`[nexus] exec: could not send ${msg.op} to the runner (${(e as Error)?.name ?? 'error'})`);
      return false;
    }
  }

  private sendProbe(now: number): void { if (this.send({ op: 'probe' })) this.probeSentAt = now; }

  /** The requeue delay after `k` consecutive starts of a job that never ran (2 s, 4 s, ... 60 s). */
  private requeueBackoffTx(jobId: string, now: number): void {
    const rows = this.db.prepare('SELECT state, outcome FROM job_attempts WHERE job_id = ? ORDER BY n DESC LIMIT 8').all(jobId) as { state: string; outcome: string | null }[];
    let k = 0;
    for (const r of rows) { if (r.state === 'abandoned') k++; else break; }
    const delay = Math.min(REQUEUE_BACKOFF_MIN_MS * 2 ** Math.max(k - 1, 0), REQUEUE_BACKOFF_MAX_MS);
    this.db.prepare('UPDATE jobs SET next_attempt_at = ? WHERE id = ?').run(now + delay, jobId);
  }

  /** The port says ready (probing needs only this). */
  private portReady(): boolean {
    try { return !!this.port && this.port.state() === 'ready' && this.bootId !== null && !!this.deps.dataHome; } catch { return false; }
  }

  /** Leasing also needs the port to have carried our last starts (a `probe.result` or `ready` clears the failure count). */
  private runnerReady(): boolean {
    return this.sendFailures < MAX_SEND_FAILURES && this.portReady();
  }

  private drop(op: string, why: string): void { this.log(`[nexus] exec: dropped runner message ${op}: ${why}`); }

  /** Validates and applies one runner report. Never throws. */
  onRunnerMessage(raw: unknown): void {
    if (!this.deps.available) { this.drop('?', 'execution is not available'); return; }
    const m = parseRunnerMessage(raw);
    if (!m) { this.drop('?', 'malformed'); return; }
    try {
      switch (m.op) {
        case 'ready':
          this.sendFailures = 0;
          this.log(`[nexus] exec: runner ready${m.bootId === this.bootId ? '' : ' (another boot id)'}`); return;
        case 'probe.result':
          this.sendFailures = 0;                       // a fresh report: the port carries messages again
          this.rawImages = m.images;
          this.probe = { probe: m.probe, images: this.judgeImages(m.images), freeBytes: m.freeBytes, at: this.deps.now() };
          return;
        case 'service.health': return this.onServiceHealth(m);
        case 'image.build.progress':
          if (this.deps.images) this.deps.images.onImageBuildProgress(m); else this.drop(m.op, 'no image builds in this build');
          return;
        case 'image.build.done':
          if (this.deps.images) this.deps.images.onImageBuildDone(m); else this.drop(m.op, 'no image builds in this build');
          return;
        case 'attempt.provisioned': return this.onProvisioned(m);
        case 'attempt.refused': return this.onRefused(m);
        case 'attempt.event': return this.onEvent(m);
        case 'attempt.heartbeat': return this.onHeartbeat(m);
        case 'attempt.exited': return this.onExited(m);
        case 'fault': return this.onFault(m);
        case 'blob.verified':
          if (this.deps.validation) this.deps.validation.onBlobVerified(m.sha256, m.ok);
          else this.drop(m.op, 'no validation in this build');
          return;
        case 'mcp.call': return this.onMcpCall(m);
        case 'agent.exec.done':
          if (!this.mcpGateway) { this.drop(m.op, 'no agent mcp gateway in this build'); return; }
          if (!this.mcpGateway.onExecDone(m)) this.drop(m.op, 'unknown exec');
          return;
        default: this.drop(m.op, 'not handled in this build');
      }
    } catch (e) {
      this.log(`[nexus] exec: runner message ${m.op} not applied: ${e instanceof PlatformError ? e.code : (e as Error)?.name ?? 'error'}`);
    }
  }

  /**
   * B2b: routes one relayed `mcp.call` to the gateway and sends its answer back as `mcp.reply`. The gateway's own
   * pipeline (verify, authorize, run, audit) never throws; it is still wrapped here because a caller that replaces
   * `onRunnerMessage`'s guarantees ("never throws") must hold even if a future gateway implementation does.
   */
  private onMcpCall(m: Extract<RunnerToMain, { op: 'mcp.call' }>): void {
    if (!this.mcpGateway) { this.drop(m.op, 'no agent mcp gateway in this build'); return; }
    const gateway = this.mcpGateway;
    const p = gateway.call(m)
      .catch((e): McpReplyResult => ({ ok: false, code: 'error', message: e instanceof Error ? e.message.slice(0, 200) : 'the call failed' }))
      .then((result) => { this.send({ op: 'mcp.reply', callId: m.callId, result }); });
    this.pendingMcp.add(p);
    p.finally(() => this.pendingMcp.delete(p));
  }

  /** The attempt a report names, when it is known and owned by this boot; else null (and one log line). */
  private ownAttempt(op: string, attemptId: string): AttemptRow | null {
    // The hot path of every report (heartbeats arrive often): one cached statement.
    this.attemptById ??= this.db.prepare('SELECT * FROM job_attempts WHERE id = ?');
    const a = (this.attemptById.get(attemptId) as AttemptRow | undefined) ?? null;
    if (!a) { this.drop(op, 'unknown attempt'); return null; }
    if (a.lease_owner !== this.bootId) { this.drop(op, 'attempt owned by another boot'); return null; }
    return a;
  }

  private onProvisioned(m: Extract<RunnerToMain, { op: 'attempt.provisioned' }>): void {
    const a = this.ownAttempt(m.op, m.attemptId); if (!a) return;
    if (a.state !== 'starting') {
      this.drop(m.op, `attempt is ${a.state}`);
      // Cancelled (or timed out) while provisioning: the container the runner just made must go.
      if (m.containerId !== undefined && a.state !== 'running') this.send({ op: 'attempt.release', attemptId: a.id });
      return;
    }
    const j = this.row(a.job_id)!;
    const recipe = getRecipe(j.recipe_id ?? '');
    if (!recipe || (j.state !== 'leased' && j.state !== 'running')) { this.drop(m.op, `job is ${j.state}`); return; }
    const now = this.deps.now();
    const sandbox = (parseJson(a.sandbox_json) ?? {}) as Record<string, unknown>;
    if (recipe.executor === 'engine') {
      if (m.containerId !== undefined) { this.drop(m.op, 'an engine attempt reported a container'); return; }
      immediateTx(this.db, () => {
        transitionAttemptTx(this.db, attemptRow(this.db, a.id)!, 'running', now, j.project_id);
        appendJobEventTx(this.db, { type: 'attempt.provisioned', summary: `attempt ${a.n} handed to the runner`, projectId: j.project_id,
          jobId: j.id, attemptN: a.n, data: { engine: true } }, now);
        if (this.row(j.id)!.state === 'leased') this.moveJobTx(j.id, 'running', now, undefined, 'leased');
        this.setPhaseTx(j.id, 'running', now);
      });
      return;
    }
    // A container attempt: only a passing preflight report from the runner lets it run (constraint 7).
    const expected = isPlainObject(sandbox.image) && typeof sandbox.image.id === 'string' ? sandbox.image.id : null;
    const service = recipe.executor === 'service';
    const problems: string[] = [];
    if (!m.preflight || !m.containerId) problems.push('no preflight report for the container');
    else {
      if (!m.preflight.ok) problems.push(...m.preflight.problems);
      if (m.imageDigest !== undefined && expected !== null && m.imageDigest !== expected) problems.push(`image ${m.imageDigest} is not the planned ${expected}`);
      // A dev deployment's forwarder publishes exactly one loopback port, reported here; no other container publishes one.
      if (service) {
        if (m.hostPort === undefined) problems.push('the forwarder reported no loopback port');
        else if (m.hostPort < EPHEMERAL_PORT_MIN || m.hostPort > EPHEMERAL_PORT_MAX) problems.push(`port ${m.hostPort} is outside the ephemeral range`);
        else if (!this.deps.deployments) problems.push('dev deployments are not available in this build');
        else if (this.deps.deployments.portHeld(m.hostPort, j.id)) problems.push(`port ${m.hostPort} is held by another live dev deployment`);
      } else if (m.hostPort !== undefined) problems.push('a tool container reported a published port');
    }
    const preflightOf = (): Record<string, unknown> | null => m.preflight
      ? { ok: problems.length === 0, problems: problems.slice(0, 50), observed: m.preflight.observed } : null;
    const recordOf = (): Record<string, unknown> => {
      const r = boundedRecord({ ...sandbox, containerId: m.containerId ?? null, imageDigest: m.imageDigest ?? null,
        ...(m.hostPort !== undefined ? { hostPort: m.hostPort } : {}), preflight: preflightOf() });
      // Still too large (a huge observed preflight): the plan's record without its argv lists, and the problems only.
      return JSON.stringify(r).length > RECORD_MAX_CHARS
        ? boundedRecord(withoutKey({ ...sandbox, containerId: m.containerId ?? null,
          preflight: { ok: problems.length === 0, problems: problems.slice(0, 20).map((p) => p.slice(0, 300)) } }, RECORD_MAX_CHARS))
        : r;
    };
    let release = false;
    immediateTx(this.db, () => {
      const cur = attemptRow(this.db, a.id)!;
      if (service && problems.length === 0) {
        // The port is stored once; `ux_deployments_port_live` is the backstop against two live deployments on one port.
        try { immediateTx(this.db, () => this.deps.deployments!.onProvisionedTx(j.id, a.n, m.hostPort!, now)); } catch (e) {
          problems.push(`port ${m.hostPort} could not be bound to the dev deployment (${e instanceof PlatformError ? e.code : 'constraint'})`);
        }
      }
      const record = recordOf();
      if (problems.length === 0) {
        transitionAttemptTx(this.db, cur, 'running', now, j.project_id, { containerId: m.containerId, sandbox: record });
        appendJobEventTx(this.db, { type: 'attempt.provisioned', summary: `attempt ${a.n} container passed preflight`, projectId: j.project_id,
          jobId: j.id, attemptN: a.n, data: { preflight: 'ok', container: m.containerId!.slice(0, 12) } }, now);
        appendJobEventTx(this.db, { type: 'preflight', summary: 'preflight passed', projectId: j.project_id, jobId: j.id, attemptN: a.n,
          data: { ok: true } }, now);
        if (this.row(j.id)!.state === 'leased') this.moveJobTx(j.id, 'running', now, undefined, 'leased');
        this.setPhaseTx(j.id, 'running', now);
      } else {
        release = m.containerId !== undefined;
        transitionAttemptTx(this.db, cur, 'failed', now, j.project_id, { outcome: 'limits_not_applied', containerId: m.containerId, sandbox: record,
          error: { code: 'limits_not_applied', message: problems.join('; ') } });
        appendJobEventTx(this.db, { type: 'preflight', summary: `preflight refused the container: ${problems.length} problem(s)`, projectId: j.project_id,
          jobId: j.id, attemptN: a.n, data: { ok: false, problems: problems.slice(0, 20) } }, now);
        this.moveJobTx(j.id, 'failed', now, { outcome: 'infra_error', error: { code: 'limits_not_applied', message: problems.join('; ') } });
      }
    });
    if (release) this.send({ op: 'attempt.release', attemptId: a.id });
  }

  private onRefused(m: Extract<RunnerToMain, { op: 'attempt.refused' }>): void {
    const a = this.ownAttempt(m.op, m.attemptId); if (!a) return;
    if (a.state !== 'starting') { this.drop(m.op, `attempt is ${a.state}`); return; }
    const j = this.row(a.job_id)!;
    const now = this.deps.now();
    // A dev deployment is not requeued: its one deployment row (job_id is unique) would wait as `starting` meanwhile.
    const service = getRecipe(j.recipe_id ?? '')?.executor === 'service';
    immediateTx(this.db, () => {
      const cur = attemptRow(this.db, a.id)!;
      const error = { code: m.reason, message: m.detail ?? `the runner refused: ${m.reason}` };
      if (REFUSE_TO_FAIL.has(m.reason) || j.state !== 'leased' || service) {
        transitionAttemptTx(this.db, cur, 'failed', now, j.project_id, { outcome: m.reason, error });
        this.failJobTx(j.id, 'infra_error', error, now);
        return;
      }
      // Refused before anything ran: the attempt is abandoned and the job waits again (the count is kept).
      transitionAttemptTx(this.db, cur, 'abandoned', now, j.project_id, { outcome: m.reason, error });
      this.moveJobTx(j.id, 'queued', now, undefined, 'leased');
      this.setPhaseTx(j.id, REFUSAL_WAIT[m.reason] ?? 'queued', now);
      this.requeueBackoffTx(j.id, now);
    });
    // No git on the runner's side: main looks for itself now; while it finds none the job is not leased (item 3).
    if (m.reason === 'git_missing') this.gitFound(now, true);
  }

  private onEvent(m: Extract<RunnerToMain, { op: 'attempt.event' }>): void {
    const a = this.ownAttempt(m.op, m.attemptId); if (!a) return;
    if (a.state !== 'starting' && a.state !== 'running') { this.drop(m.op, `attempt is ${a.state}`); return; }
    const last = this.lastSeq.get(a.id);
    if (last !== undefined && m.seq <= last) { this.drop(m.op, `seq ${m.seq} is not after ${last}`); return; }
    this.lastSeq.set(a.id, m.seq);
    const j = this.row(a.job_id)!;
    const now = this.deps.now();
    const ev = m.event;
    immediateTx(this.db, () => {
      appendJobEventTx(this.db, { type: 'attempt.progress', projectId: j.project_id, jobId: j.id, attemptN: a.n,
        summary: ev.t === 'phase' ? `attempt ${a.n}: ${ev.phase}` : ev.t === 'guard' ? `attempt ${a.n}: size guard ${ev.guard}`
          : ev.t === 'accept.prepared' ? `attempt ${a.n}: accept prepared ${ev.old.slice(0, 12)} to ${ev.new.slice(0, 12)}`
          : `attempt ${a.n}: egress ${ev.decision} ${ev.host}:${ev.port}${ev.decision === 'refused' ? ` (${ev.reason})` : ''}`,
        data: ev.t === 'phase' ? { seq: m.seq, phase: ev.phase } : ev.t === 'guard' ? { seq: m.seq, guard: ev.guard, bytes: ev.bytes, limitBytes: ev.limitBytes }
          : ev.t === 'accept.prepared' ? { seq: m.seq, acceptPrepared: { old: ev.old, new: ev.new } }
          : { seq: m.seq, egress: { decision: ev.decision, host: ev.host, port: ev.port, reason: ev.reason } } }, now);
    });
  }

  private onHeartbeat(m: Extract<RunnerToMain, { op: 'attempt.heartbeat' }>): void {
    const a = this.ownAttempt(m.op, m.attemptId); if (!a) return;
    if (a.state !== 'starting' && a.state !== 'running') { this.drop(m.op, `attempt is ${a.state}`); return; }
    const now = this.deps.now();
    if (m.container === 'missing' && a.state === 'running') {
      const j = this.row(a.job_id)!;
      const error = { code: 'container_vanished', message: 'the container disappeared while running' };
      immediateTx(this.db, () => {
        transitionAttemptTx(this.db, attemptRow(this.db, a.id)!, 'failed', now, j.project_id, { outcome: 'container_vanished', error,
          logBytes: m.logBytes, outBytes: m.outBytes });
        this.failJobTx(j.id, 'infra_error', error, now);
      });
      // The runner keeps the attempt's workspace volume, networks and /out until it is released (nothing goes earlier).
      this.send({ op: 'attempt.release', attemptId: a.id });
      return;
    }
    this.gapFlagged.delete(a.id);
    const prev = this.hbPending.get(a.id);
    const hb = { at: now, logBytes: Math.max(m.logBytes, prev?.logBytes ?? 0), outBytes: Math.max(m.outBytes, prev?.outBytes ?? 0) };
    // No I/O on the message path: the next tick writes it (all pending heartbeats in one transaction).
    this.hbPending.set(a.id, hb);
  }

  /** Writes the coalesced heartbeats (one small transaction). */
  private flushHeartbeats(): void {
    if (this.hbPending.size === 0 || this.bootId === null) return;
    const list = [...this.hbPending.entries()];
    this.hbPending.clear();
    immediateTx(this.db, () => {
      for (const [id, hb] of list) heartbeatTx(this.db, id, this.bootId!, hb.at, hb.logBytes, hb.outBytes);
    });
  }

  private onExited(m: Extract<RunnerToMain, { op: 'attempt.exited' }>): void {
    const a = this.ownAttempt(m.op, m.attemptId); if (!a) return;
    if (a.state !== 'running') {
      // Cancel (or a timeout) already ended it: the exit changes nothing, the container may go.
      this.drop(m.op, `attempt is ${a.state}`);
      if (a.state !== 'starting') this.send({ op: 'attempt.release', attemptId: a.id });
      return;
    }
    if (this.collecting.has(a.id)) { this.drop(m.op, 'the exit is already being ingested'); return; }
    const j = this.row(a.job_id)!;
    const recipe = getRecipe(j.recipe_id ?? '');
    if (!recipe) { this.drop(m.op, 'job has no recipe'); return; }
    const now = this.deps.now();
    // An attempt adopted for finalization at restart: this is the exit it was waiting for.
    this.awaitingExit.delete(a.id);
    if (recipe.executor === 'service') { this.serviceExited(a, j, m, now); return; }
    const exit = { code: m.exit.code, signal: m.exit.signal, oomKilled: m.exit.oomKilled };
    // The runner's own wall-clock backstop stopped the container (main's timeout had not fired: a long stall of main):
    // the attempt timed out; nothing it left is ingested.
    if (m.reason === 'timeout') {
      const error = { code: 'timed_out', message: 'the runner stopped the container at its wall-clock backstop' };
      immediateTx(this.db, () => {
        transitionAttemptTx(this.db, attemptRow(this.db, a.id)!, 'timed_out', now, j.project_id, { exit, outcome: 'timed_out', error, logBytes: m.logBytes });
        if (this.row(j.id)!.state === 'running') this.moveJobTx(j.id, 'timed_out', now, { outcome: 'timed_out', error });
      });
      this.send({ op: 'attempt.release', attemptId: a.id });
      this.deps.validation?.runPending(now);
      return;
    }
    // Refused outputs, OOM, a non-zero exit without a test report, a missing contract output (a tree output, a build, is
    // judged by its validators instead): the one rule for every exit, live or recovered (recovery.ts exitFailure).
    let failure: { outcome: string; error: { code: string; message: string } } | null = exitFailure(recipe, m.exit, m.outputs, m.parsed, m.outputError ?? null);
    // The runner names the `/out` entry it refused (already redacted and escaped there); redacted again here.
    if (failure && m.outputError && m.outputErrorEntry) {
      failure = { ...failure, error: { ...failure.error, message: `${failure.error.message} (${redactText(m.outputErrorEntry).slice(0, 200)})` } };
    }
    if (!failure && !this.deps.ingest) {
      failure = { outcome: 'ingest_unavailable', error: { code: 'ingest_unavailable', message: 'outputs cannot be ingested in this build' } };
    }
    if (failure) {
      const fail = failure;
      immediateTx(this.db, () => {
        transitionAttemptTx(this.db, attemptRow(this.db, a.id)!, 'failed', now, j.project_id, { exit, outcome: fail.outcome, error: fail.error, logBytes: m.logBytes });
        this.failJobTx(j.id, fail.outcome, fail.error, now);
      });
      this.send({ op: 'attempt.release', attemptId: a.id });
      this.deps.validation?.runPending(now);
      return;
    }
    // 1. The exit is durable first, in its own transaction: phase `collecting` and one `attempt.output` event.
    immediateTx(this.db, () => {
      this.setPhaseTx(j.id, 'collecting', now);
      appendJobEventTx(this.db, { type: 'attempt.output', summary: `attempt ${a.n} exited (code ${m.exit.code ?? 'none'}); collecting outputs`,
        projectId: j.project_id, jobId: j.id, attemptN: a.n,
        data: { exit: exit.code, signal: exit.signal ?? null, oomKilled: exit.oomKilled, outputs: m.outputs.length,
          parsed: m.parsed.map((p) => p.parser), logBytes: m.logBytes } }, now);
    });
    // 2. Then ingest, under the shared blob ingest lock (never while GC holds it).
    this.runIngest(a.id, { exit: m.exit, outputs: m.outputs, parsed: m.parsed, logBytes: m.logBytes });
  }

  /**
   * A dev deployment's containers exited (stopped, crashed or killed). Its outputs are not ingested: the evidence is the
   * `app.preview_health` result recorded while it ran. The job completes `stopped` only when the deployment had passed
   * its health check and the exit code is known; otherwise it fails (`exited`). The containers may then go.
   */
  private serviceExited(a: AttemptRow, j: ExecJobRow, m: Extract<RunnerToMain, { op: 'attempt.exited' }>, now: number): void {
    const exit = { code: m.exit.code, signal: m.exit.signal, oomKilled: m.exit.oomKilled };
    try {
      immediateTx(this.db, () => {
        const cur = attemptRow(this.db, a.id)!;
        if (cur.state !== 'running') return;
        const { decision, cause } = this.deps.deployments ? this.deps.deployments.onExitedTx(j.id, cur, now) : { decision: 'fail', cause: 'exited' };
        if (decision === 'complete' && exit.code !== null && this.hasEvidence(j.id, cur.n)) {
          transitionAttemptTx(this.db, cur, 'succeeded', now, j.project_id, { exit, outcome: 'stopped', logBytes: m.logBytes });
          this.moveJobTx(j.id, 'completed', now, { outcome: 'stopped' });
        } else if (decision === 'stopped') {
          // Stopped before its health check (the user, the lifetime, the app quitting): the job ends with that cause.
          const error = { code: 'stopped', message: `the dev deployment was stopped (${cause}) before it answered its health check` };
          transitionAttemptTx(this.db, cur, 'cancelled', now, j.project_id, { exit, outcome: cause, error, logBytes: m.logBytes });
          this.moveJobTx(j.id, 'cancelled', now, { outcome: cause, error });
        } else {
          const error = decision === 'complete'
            ? { code: 'exit_unknown', message: 'the dev deployment stopped but its exit code is unknown' }
            : m.exit.oomKilled ? { code: 'oom', message: 'the app container ran out of memory before it answered its health check' }
              : { code: 'exited', message: 'the app container exited before it answered its health check' };
          transitionAttemptTx(this.db, cur, 'failed', now, j.project_id, { exit, outcome: error.code, error, logBytes: m.logBytes });
          this.moveJobTx(j.id, 'failed', now, { outcome: error.code, error });
        }
        this.setPhaseTx(j.id, null, now);
      });
    } catch (e) {
      this.log(`[nexus] exec: dev deployment exit not recorded: ${e instanceof PlatformError ? e.code : (e as Error)?.name ?? 'error'}`);
    }
    this.send({ op: 'attempt.release', attemptId: a.id });
  }

  /** The runner's probe of a running dev deployment (`service.health`), for the deployment service. */
  private onServiceHealth(m: Extract<RunnerToMain, { op: 'service.health' }>): void {
    const a = this.ownAttempt(m.op, m.attemptId); if (!a) return;
    if (a.state !== 'running') { this.drop(m.op, `attempt is ${a.state}`); return; }
    const j = this.row(a.job_id)!;
    const dep = this.deps.deployments;
    if (!dep || getRecipe(j.recipe_id ?? '')?.executor !== 'service' || j.state !== 'running') { this.drop(m.op, 'not a running dev deployment'); return; }
    const d = dep.byJob(j.id);
    if (!d) { this.drop(m.op, 'the job has no dev deployment'); return; }
    dep.onHealth(d.id, { status: m.status, ms: m.ms, container: m.container });
  }

  /**
   * @internal System only (recovery replays an exit the runner reports again): ingest the outputs of a `running`
   * attempt whose exit is durable. Resolves when the ingest has committed (or its failure was recorded).
   */
  async ingestAttempt(system: Principal, attemptId: string, exited: AttemptExited): Promise<void> {
    this.requireAvailable();
    if (system?.kind !== 'system' || this.principals.get(system.id)?.kind !== 'system') {
      throw new PlatformError('denied', 'ingest is performed by the system', { reason: 'system_only' });
    }
    const a = attemptRow(this.db, attemptId);
    if (!a || a.state !== 'running' || this.collecting.has(a.id)) return;
    this.runIngest(a.id, exited);
    await this.settled();
  }

  /** Resolves when every asynchronous ingest started so far has settled (tests and shutdown). */
  async settled(): Promise<void> {
    while (this.pendingIngest.size > 0) await Promise.allSettled([...this.pendingIngest]);
  }

  private trackIngest(p: Promise<unknown>): void {
    this.pendingIngest.add(p);
    void p.finally(() => this.pendingIngest.delete(p));
  }

  /** Prepare (maybe async), then commit under the ingest lock: synchronously when no GC holds it, else after it. */
  private runIngest(attemptId: string, exited: AttemptExited): void {
    this.collecting.add(attemptId);
    if (!this.collectingSince.has(attemptId)) this.collectingSince.set(attemptId, { at: this.deps.now(), exited });
    const ingest = this.deps.ingest!;
    const commit = (facts: unknown): void | Promise<void> => {
      const blobs = this.deps.blobs;
      if (!blobs) { this.commitIngest(attemptId, exited, null, facts); return; }
      const r = blobs.tryWithIngestLockSync((token) => this.commitIngest(attemptId, exited, token, facts));
      if (r.ran) return;
      // Blob GC holds the store: wait for it (a new ingest never runs during GC).
      return blobs.withIngestLock((token) => this.commitIngest(attemptId, exited, token, facts));
    };
    let prepared: unknown = null;
    try {
      const a = attemptRow(this.db, attemptId);
      const j = a ? this.row(a.job_id) : null;
      const recipe = j ? getRecipe(j.recipe_id ?? '') : null;
      prepared = a && j && recipe && ingest.prepare ? ingest.prepare({ system: this.system(), job: j, attempt: a, recipe, exited }) : null;
    } catch (e) {
      this.ingestFailed(attemptId, exited, e);
      return;
    }
    if (prepared && typeof (prepared as { then?: unknown }).then === 'function') {
      this.trackIngest(Promise.resolve(prepared as Promise<unknown>)
        .then((f) => commit(f), (e) => this.ingestFailed(attemptId, exited, e))
        .catch((e) => this.ingestFailed(attemptId, exited, e)));
      return;
    }
    if (exited.outputs.length > ASYNC_INGEST_OUTPUTS) {
      // A large output list: the exit handler returns now (the exit is already durable); the bounded commit runs on
      // a later turn, so the message path never carries a large transaction (constraint 7).
      this.trackIngest(new Promise<void>((resolve) => setImmediate(resolve))
        .then(() => commit(prepared))
        .catch((e) => this.ingestFailed(attemptId, exited, e)));
      return;
    }
    const r = commit(prepared);
    if (r) this.trackIngest(r.catch((e) => this.ingestFailed(attemptId, exited, e)));
  }

  /** The ingest transaction: ingestTx, the evidence backstop, the attempt and job moves. Never throws. */
  private commitIngest(attemptId: string, exited: AttemptExited, token: IngestToken | null, facts: unknown): void {
    const now = this.deps.now();
    let ingestThrew: unknown = null;
    let ran = false;
    try {
      immediateTx(this.db, () => {
        const cur = attemptRow(this.db, attemptId)!;
        const j = this.row(cur.job_id)!;
        // Cancel or a timeout won while the outputs were collected: nothing is ingested.
        if (cur.state !== 'running' || j.state !== 'running') return;
        const recipe = getRecipe(j.recipe_id ?? '')!;
        ran = true;
        const exit = { code: exited.exit.code, signal: exited.exit.signal, oomKilled: exited.exit.oomKilled };
        let d: IngestDecision;
        try {
          d = this.deps.ingest!.ingestTx({ system: this.system(), job: j, attempt: cur, recipe, exited, token, facts });
        } catch (e) {
          ingestThrew = e ?? new Error('ingest threw');
          throw e;                                   // rolls back everything ingest wrote; recorded below
        }
        if (d.ok && !this.hasEvidence(j.id, cur.n)) {
          // Constraint 4 in the core: an ingest that reports success but bound nothing to this attempt completes nothing.
          d = { ok: false, outcome: 'no_evidence', error: { code: 'no_evidence', message: 'ingest bound no version or validation to the attempt' } };
        }
        if (d.ok) {
          // The attempt succeeds first: the job completes only after its current attempt succeeded (backstop trigger).
          transitionAttemptTx(this.db, cur, 'succeeded', now, j.project_id, { exit, outcome: d.outcome ?? 'succeeded', logBytes: exited.logBytes });
          this.moveJobTx(j.id, 'completed', now, { outcome: d.outcome ?? 'completed' });
          this.setPhaseTx(j.id, null, now);
          return;
        }
        transitionAttemptTx(this.db, cur, 'failed', now, j.project_id, { exit, outcome: d.outcome, error: d.error, logBytes: exited.logBytes });
        this.failJobTx(j.id, d.outcome, d.error, now);
      });
    } catch (e) {
      this.ingestFailed(attemptId, exited, ingestThrew ?? e);
      return;
    }
    this.collecting.delete(attemptId);
    this.collectingSince.delete(attemptId);
    this.send({ op: 'attempt.release', attemptId });
    if (!ran || !this.deps.validation) return;
    // The checks the ingest queued run now; after a large ingest, on the next turn (each slice stays bounded).
    if (exited.outputs.length > ASYNC_INGEST_OUTPUTS) {
      const v = this.deps.validation;
      this.trackIngest(new Promise<void>((resolve) => setImmediate(resolve)).then(() => v.runPending(this.deps.now())));
    } else {
      this.deps.validation.runPending(now);
    }
  }

  /**
   * The exit is never lost: a small transaction records the ingest failure. A deterministic refusal (the outputs
   * break a rule: `invalid`, `input_not_granted`, a stored constraint, ...) fails the attempt and the job
   * `invalid_output` with its reason and is never retried; anything else (a crash, a busy store) is `ingest_error`,
   * retryable infrastructure.
   */
  private ingestFailed(attemptId: string, exited: AttemptExited, e: unknown): void {
    this.collecting.delete(attemptId);
    this.collectingSince.delete(attemptId);
    const now = this.deps.now();
    const refused = deterministicIngestRefusal(e);
    const why = e instanceof PlatformError ? e.code : (e as Error)?.name ?? 'error';
    const error = refused ?? { code: 'ingest_error', message: `ingest failed: ${why}` };
    const outcome = refused ? 'invalid_output' : 'ingest_error';
    const exit = { code: exited.exit.code, signal: exited.exit.signal, oomKilled: exited.exit.oomKilled };
    try {
      immediateTx(this.db, () => {
        const cur = attemptRow(this.db, attemptId);
        if (!cur || cur.state !== 'running') return;
        const j = this.row(cur.job_id)!;
        transitionAttemptTx(this.db, cur, 'failed', now, j.project_id, { exit, outcome, error, logBytes: exited.logBytes });
        this.failJobTx(j.id, refused ? 'invalid_output' : 'infra_error', error, now);
      });
    } catch (e2) {
      this.log(`[nexus] exec: ingest failure not recorded: ${e2 instanceof PlatformError ? e2.code : (e2 as Error)?.name ?? 'error'}`);
    }
    this.log(refused ? `[nexus] exec: ingest refused the outputs (${refused.code}); the attempt failed invalid_output`
      : `[nexus] exec: ingest failed (${why}); the attempt failed ingest_error`);
    this.send({ op: 'attempt.release', attemptId });
    this.deps.validation?.runPending(now);
  }

  /**
   * A runner-wide fault (a fault naming no attempt, the port leaving `ready`, the port replaced or detached): re-hashes
   * in flight cannot be answered (their checks could not run) and a `docker build` it ran cannot report (the image
   * builds end `interrupted`).
   */
  private runnerWideFault(): void {
    this.deps.validation?.onRunnerFault();
    try { this.deps.images?.onRunnerLost?.(); } catch (e) {
      this.log(`[nexus] exec: image builds not interrupted: ${e instanceof PlatformError ? e.code : (e as Error)?.name ?? 'error'}`);
    }
  }

  /** @internal For the validation framework (blob.verify): send one message to the runner; false when it did not go. */
  sendToRunner(msg: Parameters<RunnerPort['send']>[0]): boolean { return this.send(msg); }

  private onFault(m: Extract<RunnerToMain, { op: 'fault' }>): void {
    const a = m.attemptId !== undefined ? attemptRow(this.db, m.attemptId) : null;
    // Attributed: a Docker failure of a starting attempt (create, start), or `docker_error` for a running one whose
    // container is still there but whose exit Docker cannot report (the runner keeps its resources until released).
    const running = !!a && a.state === 'running' && m.failureClass === 'docker_error';
    if (!a || !m.failureClass || a.lease_owner !== this.bootId || (a.state !== 'starting' && !running)) {
      this.faults++;
      this.log('[nexus] exec: runner fault (not attributed to an attempt of this boot)');
      // A runner-wide fault (it names no attempt): re-hashes in flight cannot be trusted to answer, so those checks
      // could not run. A fault about one attempt says nothing about the runner's other work.
      if (m.attemptId === undefined) this.runnerWideFault();
      return;
    }
    const cls = m.failureClass;
    const j = this.row(a.job_id)!;
    const now = this.deps.now();
    const error = { code: cls, message: running ? `the container's exit could not be read: ${m.message}` : `the container could not be created: ${m.message}` };
    immediateTx(this.db, () => {
      transitionAttemptTx(this.db, attemptRow(this.db, a.id)!, 'failed', now, j.project_id, { outcome: cls, error });
      this.failJobTx(j.id, 'infra_error', error, now);
    });
    // A running attempt's container, workspace volume, networks and /out stay with the runner until it is released.
    if (running) this.send({ op: 'attempt.release', attemptId: a.id });
  }

  /** Whether a validation or an ingested version is bound to (job, attempt n). */
  private hasEvidence(jobId: string, n: number): boolean {
    return !!this.db.prepare(`SELECT 1 FROM validations WHERE job_id = ? AND attempt_n = ?
      UNION ALL SELECT 1 FROM version_attempts WHERE job_id = ? AND attempt_n = ? LIMIT 1`).get(jobId, n, jobId, n);
  }

  // ---------- job transitions (inside the caller's transaction) ----------

  /** One job transition: JobService's rules and activity row, plus one `job_events` row. */
  private moveJobTx(id: string, to: JobState, now: number, d?: { outcome?: string; error?: { code: string; message: string } }, expect?: JobState): ExecJobRow {
    const before = this.row(id)!;
    this.deps.jobs.transitionTx(this.system(), id, to, d, { expectState: expect, now });
    // A terminal job keeps no requeue backoff (retry_scheduled sets its own next_attempt_at after this).
    if (TERMINAL_JOB_STATES.has(to)) this.db.prepare('UPDATE jobs SET next_attempt_at = NULL WHERE id = ? AND next_attempt_at IS NOT NULL').run(id);
    const after = this.row(id)!;
    // A check that ended: the validation framework records an ended recipe check on its next pass (not every tick).
    if (TERMINAL_JOB_STATES.has(to) && after.kind === 'validate') this.deps.validation?.onJobEnded?.();
    // A dev deployment's job that ends ends its deployment if that is still live (cancel, timeout, any failure).
    if (TERMINAL_JOB_STATES.has(to) && after.recipe_id !== null && this.deps.deployments && getRecipe(after.recipe_id)?.executor === 'service') {
      this.deps.deployments.endForJobTx(id, to, now, { outcome: d?.outcome ?? null, code: d?.error?.code ?? null });
    }
    appendJobEventTx(this.db, { type: 'job.transition', summary: `job ${before.state} -> ${to}${d?.outcome ? ` (${d.outcome})` : ''}`,
      projectId: after.project_id, jobId: id,
      // The event names the current attempt once its row exists (the lease writes this event just before the insert).
      attemptN: after.attempts > 0 && this.db.prepare('SELECT 1 FROM job_attempts WHERE job_id = ? AND n = ?').get(id, after.attempts) ? after.attempts : null,
      data: { from: before.state, to, outcome: after.outcome, error: d?.error?.code ?? null } }, now);
    return after;
  }

  private setPhaseTx(id: string, phase: string | null, now: number): void {
    this.db.prepare('UPDATE jobs SET phase = ?, updated_at = ? WHERE id = ? AND phase IS NOT ?').run(phase, now, id, phase);
  }

  /**
   * The job fails, and is scheduled for another attempt when its recipe is idempotent with attempts left, it may run
   * again (no resurrection) and the failure is retryable: an infrastructure code (RETRYABLE) by default, or any cause
   * with `retry: 'always'` (restart recovery: the attempt was lost to the restart, not failed by its work). With
   * `otherwise: 'interrupted'` a job that is not retried ends `interrupted` instead of `failed`. Returns the end state.
   */
  private failJobTx(id: string, outcome: string, error: { code: string; message: string }, now: number,
    o: { retry?: 'by_code' | 'always'; otherwise?: 'failed' | 'interrupted' } = {}): 'failed' | 'retry_scheduled' | 'interrupted' {
    const j0 = this.row(id)!;
    const retry = this.deps.jobs.toJob(j0).retry;
    const retryable = (o.retry === 'always' || RETRYABLE.has(error.code)) && canRetry({ kind: j0.kind, attempts: j0.attempts, retry })
      && this.deps.jobs.runnableAgain(j0);
    if (!retryable && o.otherwise === 'interrupted') {
      this.moveJobTx(id, 'interrupted', now, { outcome: 'interrupted', error });
      return 'interrupted';
    }
    const j = this.moveJobTx(id, 'failed', now, { outcome, error });
    if (!retryable) return 'failed';
    this.moveJobTx(id, 'retry_scheduled', now);
    this.db.prepare('UPDATE jobs SET next_attempt_at = ?, phase = NULL WHERE id = ?').run(now + backoffMs(retry.backoffMs, j.attempts), id);
    return 'retry_scheduled';
  }

  // ---------- scheduler ----------

  /** One scheduler pass (see scheduler.ts). Called every second and after runner messages. Never throws. */
  tick(now: number): void {
    if (!this.deps.available) return;
    try {
      // A gap since the previous tick longer than TICK_STALL_MS (sleep, a blocked loop) is not the runner's silence:
      // every live lease moves by the gap, no lease expires on this tick,
      // wall clocks exclude the gap, and the runner is probed.
      // The compensation is bounded by time: at most one extension (and one stall probe) per LEASE_MS. A stalled tick
      // within LEASE_MS of the last extension sweeps normally, so slow or alternating ticks cannot keep a dead runner's
      // attempts alive; heartbeats delivered between ticks keep healthy ones alive.
      const gap = this.lastTickAt === null ? 0 : now - this.lastTickAt;
      this.lastTickAt = now;
      const stalled = gap > TICK_STALL_MS;
      const firstOfStreak = stalled && (this.lastExtensionAt === null || now - this.lastExtensionAt >= LEASE_MS);
      if (firstOfStreak) this.lastExtensionAt = now;
      this.flushHeartbeats();
      if (stalled) this.recordStall(gap, now, firstOfStreak);
      this.requeueDue(now);
      this.trackRunnerOutage(now);
      this.sweep(now, firstOfStreak);
      // Probing is independent of leasing: a runner that only answers probes recovers from the send-failure flag.
      if ((firstOfStreak && this.port) || (this.portReady() && (this.probeSentAt === null || now - this.probeSentAt >= this.caps.probeRefreshMs))) this.sendProbe(now);
      // The port left `ready` (crashed, restarting): re-hashes it was asked for will not be answered.
      let portState: string | null = null;
      try { portState = this.port ? this.port.state() : null; } catch { portState = 'unavailable'; }
      if (this.lastPortState === 'ready' && portState !== 'ready') this.runnerWideFault();
      this.lastPortState = portState;
      // The validation framework's pass: it does work only when some is due (queued checks, an ended check job,
      // a re-hash waiting for its timeout, or its periodic safety pass).
      this.deps.validation?.tick(now);
      // Approvals past their 15 minutes expire (their jobs fail `denied`); dev deployments' start windows and lifetime.
      const ap = this.deps.approvals;
      if (ap?.expireDue && (this.lastExpiryAt === null || now - this.lastExpiryAt >= EXPIRY_SWEEP_MS || now < this.lastExpiryAt)) {
        this.lastExpiryAt = now;
        ap.expireDue(now);
      }
      const dep = this.deps.deployments;
      if (dep && (this.lastDeploymentPassAt === null || now - this.lastDeploymentPassAt >= DEPLOYMENT_TICK_MS || now < this.lastDeploymentPassAt)) {
        this.lastDeploymentPassAt = now;
        dep.tick(now);
      }
      // Restart recovery's bound: attempts phase A left for phase B that no phase B reconciled within 10 minutes.
      // It counts from the later of phase A and the last reconcile request, and waits for an outstanding one (capped).
      if (this.recoveredAt !== null
        && reconcileBoundDue({ recoveredAt: this.recoveredAt, requestedAt: this.reconcileRequestedAt, outstanding: this.reconcileOutstanding }, now)
        && (this.lastUnreconciledAt === null || now - this.lastUnreconciledAt >= EXPIRY_SWEEP_MS || now < this.lastUnreconciledAt)) {
        this.lastUnreconciledAt = now;
        const owners = [this.recoveryBootId, this.bootId].filter((x): x is string => x !== null);
        failUnreconciled(this.recoveryHost(), this.system(), owners, now);
      }
      // Image builds past their deadline are cancelled and fail `timeout` (they never stay `running`).
      const img = this.deps.images;
      if (img?.tick && (this.lastImagePassAt === null || now - this.lastImagePassAt >= EXPIRY_SWEEP_MS || now < this.lastImagePassAt)) {
        this.lastImagePassAt = now;
        img.tick(now);
      }
      // The blob store contract: no lease and no start while GC holds its exclusive lock.
      if (this.deps.blobs?.isExclusiveHeld()) return;
      this.resumeConsumed(now);
      this.leaseQueued(now);
    } catch (e) {
      this.log(`[nexus] exec: scheduler pass stopped: ${e instanceof PlatformError ? e.code : (e as Error)?.name ?? 'error'}`);
    }
  }

  private recordStall(gap: number, now: number, extend: boolean): void {
    if (this.bootId === null) return;
    if (gap >= SLEEP_GAP_MS) {
      this.stalls.push({ from: now - gap, to: now });
      if (this.stalls.length > 1000) this.stalls.splice(0, this.stalls.length - 1000);
    }
    if (!extend) return;
    immediateTx(this.db, () => {
      // By the gap only: an attempt keeps the lease it had before the stall, so repeated stalls never add up to a lease
      // that cannot expire. Heartbeats queued during the stall are written by the next tick before it sweeps.
      this.db.prepare(`UPDATE job_attempts SET lease_expires_at = lease_expires_at + ? WHERE state IN ('starting','running') AND lease_owner = ?`)
        .run(gap, this.bootId);
    });
    this.log(`[nexus] exec: scheduler resumed after a ${Math.round(gap / 1000)} s gap; leases extended`);
  }

  /**
   * Wall-clock time of an attempt that does not count: approval waits, plus sleep-like stalls (gaps of at least
   * SLEEP_GAP_MS) that do not overlap an approval wait, the stall part capped at 1x the attempt's wall clock.
   * Main is the authority for timeouts; the in-container timeout (Task 12, the Nexus entry) is a backstop and must be
   * no shorter than limit + cap (2x the wall clock), so it never ends work main still counts as in time.
   */
  private excludedMs(jobId: string, n: number, since: number, now: number, wall: number): number {
    const waits = this.approvalWaits(jobId, n, now);
    const waitTotal = waits.reduce((t, [a, b]) => t + (b - a), 0);
    let stall = 0;
    for (const st of this.stalls) {
      const a = Math.max(st.from, since); const b = Math.min(st.to, now);
      if (b <= a) continue;
      let overlap = 0;
      for (const [wa, wb] of waits) overlap += Math.max(0, Math.min(b, wb) - Math.max(a, wa));
      stall += (b - a) - overlap;
    }
    return waitTotal + Math.min(stall, wall);
  }

  private requeueDue(now: number): void {
    const due = this.db.prepare(`SELECT id FROM jobs WHERE state = 'retry_scheduled' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?
      ORDER BY next_attempt_at, id`).all(now) as { id: string }[];
    for (const { id } of due) {
      try {
        immediateTx(this.db, () => {
          const j = this.row(id)!;
          if (j.state !== 'retry_scheduled') return;
          try {
            this.moveJobTx(id, 'queued', now, undefined, 'retry_scheduled');
          } catch (e) {
            if (!(e instanceof PlatformError) || e.code !== 'illegal_transition') throw e;
            // No resurrection: the participation is gone, so the scheduled retry ends here.
            this.moveJobTx(id, 'cancelled', now, { outcome: 'participation_inactive' }, 'retry_scheduled');
          }
          this.db.prepare('UPDATE jobs SET next_attempt_at = NULL, phase = NULL WHERE id = ?').run(id);
        });
      } catch (e) {
        this.log(`[nexus] exec: retry not requeued: ${e instanceof PlatformError ? e.code : 'error'}`);
      }
    }
  }

  /** The intervals the job spent in awaiting_approval during attempt n (an open wait lasts until now). */
  private approvalWaits(jobId: string, n: number, now: number): [number, number][] {
    const rows = this.db.prepare(`SELECT ts, data_json FROM job_events WHERE job_id = ? AND attempt_n = ? AND type = 'job.transition' ORDER BY seq`)
      .all(jobId, n) as { ts: number; data_json: string }[];
    const out: [number, number][] = []; let since: number | null = null;
    for (const r of rows) {
      const d = parseJson(r.data_json) as { from?: string; to?: string } | null;
      if (d?.to === 'awaiting_approval' && since === null) since = r.ts;
      else if (d?.from === 'awaiting_approval' && since !== null) { out.push([since, r.ts]); since = null; }
    }
    if (since !== null) out.push([since, now]);
    return out;
  }

  private sweep(now: number, stalled = false): void {
    if (this.bootId === null) return;
    const live = this.db.prepare(`SELECT a.id AS attempt_id, a.n, a.state AS attempt_state, a.created_at, a.started_at, a.heartbeat_at,
        a.lease_expires_at, j.id AS job_id, j.state AS job_state, j.phase, j.limits_json, j.project_id FROM job_attempts a JOIN jobs j ON j.id = a.job_id
      WHERE a.state IN ('starting','running') AND a.lease_owner = ?`).all(this.bootId) as
      { attempt_id: string; n: number; attempt_state: string; created_at: number; started_at: number | null; heartbeat_at: number | null;
        lease_expires_at: number; job_id: string; job_state: JobState; phase: string | null; limits_json: string; project_id: string }[];
    // In-memory per-attempt state lives only as long as the attempt does.
    const liveIds = new Set(live.map((r) => r.attempt_id));
    for (const id of [...this.lastSeq.keys()]) if (!liveIds.has(id)) this.lastSeq.delete(id);
    for (const id of [...this.gapFlagged]) if (!liveIds.has(id)) this.gapFlagged.delete(id);
    for (const id of [...this.awaitingExit]) if (!liveIds.has(id)) this.awaitingExit.delete(id);
    for (const [id] of [...this.collectingSince]) if (!liveIds.has(id) && !this.collecting.has(id)) this.collectingSince.delete(id);
    for (const r of live) {
      // Collecting: the work already ran (its exit is durable), so no wall clock and no lease expiry; only the collecting
      // deadline, which ends it `ingest_error` (retryable) when the ingest never finishes (final review A3).
      if (this.collecting.has(r.attempt_id)) {
        const c = this.collectingSince.get(r.attempt_id);
        if (c !== undefined && now - c.at > COLLECT_DEADLINE_MS) this.collectDeadline(r.attempt_id, c.exited);
        continue;
      }
      const limits = parseJson(r.limits_json) as { wallClockMs?: number } | null;
      const wall = typeof limits?.wallClockMs === 'number' ? limits.wallClockMs : null;
      // An attempt adopted for finalization already exited: no wall clock, only its lease (the re-reported exit).
      if (wall !== null && !this.awaitingExit.has(r.attempt_id) && (r.job_state === 'running' || r.job_state === 'leased')) {
        const elapsed = now - r.created_at - this.excludedMs(r.job_id, r.n, r.created_at, now, wall);
        if (elapsed > wall) { this.timeOut(r.job_id, r.attempt_id, now); continue; }
      }
      // A lease that ran out without a heartbeat: the runner is gone for this attempt (an approval wait holds no lease).
      if (stalled) continue;               // the first tick after a stall: no lease expiry and no gap event
      // B2a close: an attempt the runner held when it went away keeps its lease while the runner restarts (bounded).
      const held = this.outage !== null && !this.outage.lifted && this.outage.held.has(r.attempt_id);
      if (!held && r.lease_expires_at < now && r.job_state !== 'awaiting_approval' && r.phase !== 'approval') { this.runnerLost(r.attempt_id, now); continue; }
      if (r.attempt_state === 'running') {
        const last = r.heartbeat_at ?? r.started_at ?? r.created_at;
        if (now - last >= HEARTBEAT_GAP_MS && !this.gapFlagged.has(r.attempt_id)) {
          this.gapFlagged.add(r.attempt_id);
          immediateTx(this.db, () => appendJobEventTx(this.db, { type: 'attempt.heartbeat_gap', summary: `attempt ${r.n}: no heartbeat for ${Math.round((now - last) / 1000)} s`,
            projectId: r.project_id, jobId: r.job_id, attemptN: r.n, data: { gapMs: now - last } }, now));
        }
      }
    }
  }

  // ---------- a mid-session runner restart (B2a close) ----------

  /** The port's state as a tick sees it (null: no port attached). */
  private portStateNow(): string | null {
    try { return this.port ? this.port.state() : null; } catch { return 'unavailable'; }
  }

  /**
   * Opens the outage of a runner the scheduler saw live (never at the app start: `lastLiveAt` is null until a tick saw
   * the port ready), holding the leases of the attempts this boot owns now. With no such attempt there is nothing to hold.
   */
  private openOutage(now: number, requested: boolean): void {
    if (this.outage !== null || this.bootId === null || this.lastLiveAt === null) return;
    const held = new Set((cachedStmt(this.db, "SELECT id FROM job_attempts WHERE state IN ('starting','running') AND lease_owner = ?")
      .all(this.bootId) as { id: string }[]).map((r) => r.id));
    if (held.size === 0) return;
    this.outage = { since: Math.min(this.lastLiveAt, now), requestedAt: requested ? now : null, held, lifted: false };
    this.log(`[nexus] exec: the runner is restarting; the leases of ${held.size} live attempt(s) are held until it reconciles (bounded)`);
  }

  /** Once per tick, before the sweep: opens, ends or lifts the hold from the port's state and the reconcile bound. */
  private trackRunnerOutage(now: number): void {
    if (this.bootId === null) return;
    const st = this.portStateNow();
    const o = this.outage;
    if (o === null) {
      if (st === 'ready') this.lastLiveAt = now;
      else if (st !== 'unavailable') this.openOutage(now, false);   // crashed, starting, or no port attached
      return;
    }
    // Ready again without a reconcile request: no answer is coming, so the held attempts' own heartbeats decide.
    if (st === 'ready' && o.requestedAt === null) { this.endOutage(now, 'ready without a reconcile'); this.lastLiveAt = now; return; }
    if (o.lifted) return;
    if (st === 'unavailable') { this.liftOutage('the runner is unavailable'); return; }
    if (runnerOutageHoldEnded({ since: o.since, requestedAt: o.requestedAt, answered: false }, now)) this.liftOutage('the runner did not reconcile within the bound');
  }

  /** The hold ends without an extension: the sweep fails the held attempts whose lease ran out `runner_lost`. */
  private liftOutage(why: string): void {
    if (!this.outage || this.outage.lifted) return;
    this.outage.lifted = true;
    this.log(`[nexus] exec: lease hold ended (${why}); ${this.outage.held.size} held lease(s) run out`);
  }

  /**
   * The runner is back (its reconcile answer, or ready with no request): the held attempts that are still live and this
   * boot's get their leases moved by the downtime, so each keeps what it had left when the runner went away. A lifted
   * hold extends nothing. Runs BEFORE phase B decides, so an adopted attempt still gets exactly one fresh lease.
   */
  private endOutage(now: number, why: string): void {
    const o = this.outage;
    this.outage = null;
    this.lastLiveAt = now;
    if (!o || o.lifted || this.bootId === null) return;
    const boot = this.bootId;
    const downtime = Math.max(0, now - o.since);
    let n = 0;
    immediateTx(this.db, () => {
      const st = cachedStmt(this.db, "UPDATE job_attempts SET lease_expires_at = lease_expires_at + ? WHERE id = ? AND state IN ('starting','running') AND lease_owner = ?");
      for (const id of o.held) n += st.run(downtime, id, boot).changes;
    });
    this.log(`[nexus] exec: the runner is back after ${Math.round(downtime / 1000)} s (${why}); ${n} held lease(s) moved by the downtime`);
  }

  /**
   * The collecting deadline passed (final review A3): the ingest that never finished (a blob GC that never released the
   * store, a hung prepare) ends the attempt `ingest_error`, retryable infrastructure; a late commit then finds the attempt
   * ended and ingests nothing.
   */
  private collectDeadline(attemptId: string, exited: AttemptExited): void {
    const a = attemptRow(this.db, attemptId);
    if (!a || a.state !== 'running') { this.collecting.delete(attemptId); this.collectingSince.delete(attemptId); return; }
    this.log('[nexus] exec: collecting outputs ran past its deadline; the attempt failed ingest_error');
    this.ingestFailed(attemptId, exited, new PlatformError('unavailable', 'collecting ran past its deadline', { reason: 'collect_deadline' }));
  }

  private runnerLost(attemptId: string, now: number): void {
    immediateTx(this.db, () => {
      const a = attemptRow(this.db, attemptId)!;
      const j = this.row(a.job_id)!;
      const error = { code: 'runner_lost', message: 'the lease ran out without a heartbeat from the runner' };
      transitionAttemptTx(this.db, a, 'failed', now, j.project_id, { outcome: 'runner_lost', error });
      this.failJobTx(j.id, 'infra_error', error, now);
    });
  }

  private timeOut(jobId: string, attemptId: string, now: number): void {
    immediateTx(this.db, () => {
      const a = attemptRow(this.db, attemptId)!;
      const j = this.row(jobId)!;
      const error = { code: 'timed_out', message: 'the wall clock of the attempt ran out' };
      if (a.state === 'running') transitionAttemptTx(this.db, a, 'timed_out', now, j.project_id, { outcome: 'timed_out', error });
      else transitionAttemptTx(this.db, a, 'failed', now, j.project_id, { outcome: 'timed_out', error });
      if (j.state === 'running') this.moveJobTx(jobId, 'timed_out', now, { outcome: 'timed_out', error });
      else this.moveJobTx(jobId, 'failed', now, { outcome: 'timed_out', error });
    });
    this.send({ op: 'attempt.cancel', attemptId, graceMs: CANCEL_GRACE_MS, reason: 'timeout' });
  }

  private liveUse(): LiveUse {
    // A job waiting for approval holds no container yet, so it holds no slot and no memory.
    const rows = this.db.prepare(`SELECT j.recipe_id, j.limits_json FROM job_attempts a JOIN jobs j ON j.id = a.job_id
      WHERE a.state IN ('starting','running') AND j.state <> 'awaiting_approval' AND j.phase IS NOT 'approval'`).all() as { recipe_id: string | null; limits_json: string }[];
    const use: LiveUse = { jobContainers: 0, serviceContainers: 0, reservedMemoryMb: 0 };
    for (const r of rows) {
      const recipe = getRecipe(r.recipe_id ?? '');
      if (!recipe || recipe.executor === 'engine') continue;
      if (recipe.executor === 'service') use.serviceContainers++; else use.jobContainers++;
      const l = parseJson(r.limits_json) as { memoryMb?: number } | null;
      use.reservedMemoryMb += typeof l?.memoryMb === 'number' ? l.memoryMb : 0;
    }
    return use;
  }

  private leaseQueued(now: number): void {
    // Tool jobs and recipe checks (a `validate` job with a recipe, e.g. sde.tests_pass) lease the same way.
    const queued = this.db.prepare(`SELECT * FROM jobs WHERE state = 'queued' AND kind IN ('tool.run','validate') AND recipe_id IS NOT NULL
      ORDER BY priority, created_at, rowid`).all() as ExecJobRow[];
    if (queued.length === 0) return;
    const ready = this.runnerReady();
    const use = this.liveUse();
    for (const j of queued) {
      const recipe = getRecipe(j.recipe_id ?? '');
      const cap = this.capabilityOf(j);
      if (!recipe || !cap) continue;
      if (j.next_attempt_at !== null && j.next_attempt_at > now) continue;   // requeue backoff (phase keeps its reason)
      // The runner found no git: the job waits (no attempt) until main itself finds one (final batch item 3).
      if (j.phase === 'waiting:git' && !this.gitFound(now)) continue;
      const limits = parseJson(j.limits_json) as Partial<ResourceLimits> | null;
      const memoryMb = typeof limits?.memoryMb === 'number' ? limits.memoryMb : 0;
      const wait = leaseGuard({ recipe, profile: cap.profile, memoryMb }, ready, this.probe, use, this.caps);
      if (wait !== null) {
        if (j.phase !== wait) immediateTx(this.db, () => this.setPhaseTx(j.id, wait, now));
        continue;
      }
      try {
        if (this.lease(j, recipe, cap, now)) {
          if (recipe.executor === 'service') use.serviceContainers++;
          else if (recipe.executor === 'tool') use.jobContainers++;
          use.reservedMemoryMb += recipe.executor === 'engine' ? 0 : memoryMb;
        }
      } catch (e) {
        this.log(`[nexus] exec: lease not taken: ${e instanceof PlatformError ? e.code : (e as Error)?.name ?? 'error'}`);
      }
    }
  }

  /**
   * Whether a job waiting for git may be leased: false only while main's last look answered "no git". A look (file
   * system only, async) starts at most every GIT_RECHECK_MS (at once with `force`: the runner just refused for git);
   * until its first answer the job may lease as before, so a git installed meanwhile is used at once.
   */
  private gitFound(now: number, force = false): boolean {
    if (!this.gitChecking && (force || this.gitCheckedAt === null || now - this.gitCheckedAt >= GIT_RECHECK_MS || now < this.gitCheckedAt)) {
      this.gitChecking = true; this.gitCheckedAt = now;
      const find = this.deps.findGit ?? (() => resolveGitBinary({ stat }));
      void Promise.resolve().then(find).then((bin) => { this.gitPresent = typeof bin === 'string' && bin.length > 0; }, () => { this.gitPresent = false; })
        .finally(() => { this.gitChecking = false; });
    }
    return this.gitPresent !== false;
  }

  /** @internal Tests: resolves when main's look for git (if one is in flight) has answered. */
  async gitLookSettled(): Promise<void> { for (let i = 0; i < 50 && this.gitChecking; i++) await new Promise((r) => setImmediate(r)); }

  /**
   * The setup sheet's "Check again" (#23 with `{ probe: true }`): asks the runner for a fresh probe now, without waiting
   * for it (the cache answers until the result arrives). At most one per PROBE_REQUEST_MIN_MS; `requested: false` when
   * it was not sent (too soon, no ready runner, execution off).
   */
  requestProbe(): { requested: boolean } {
    if (!this.deps.available || !this.portReady()) return { requested: false };
    const now = this.deps.now();
    if (this.probeRequestedAt !== null && now >= this.probeRequestedAt && now - this.probeRequestedAt < PROBE_REQUEST_MIN_MS) return { requested: false };
    if (!this.send({ op: 'probe' })) return { requested: false };
    this.probeRequestedAt = now; this.probeSentAt = now;
    return { requested: true };
  }

  /**
   * The plan inputs of a job: its job_inputs joined to their versions. A recipe check (`validate` job) has no
   * job_inputs (it may check a draft): the system reads its `params.versionId` as the recipe's one input slot.
   */
  private planInputs(jobId: string): PlanInput[] {
    let rows = this.db.prepare(`SELECT ji.version_id, ji.role, ji.content_hash, v.storage_ref_json, v.metadata_json FROM job_inputs ji
      JOIN artifact_versions v ON v.id = ji.version_id WHERE ji.job_id = ? ORDER BY ji.rowid`).all(jobId) as
      { version_id: string; role: string; content_hash: string; storage_ref_json: string; metadata_json: string }[];
    if (rows.length === 0) {
      const j = this.row(jobId);
      const params = j && j.kind === 'validate' ? parseJson(j.params_json) : null;
      const versionId = isPlainObject(params) && typeof params.versionId === 'string' ? params.versionId : null;
      if (versionId) {
        rows = this.db.prepare(`SELECT id AS version_id, 'suite' AS role, content_hash, storage_ref_json, metadata_json FROM artifact_versions
          WHERE id = ? AND project_id = ?`).all(versionId, j!.project_id) as typeof rows;
      }
    }
    return rows.map((r) => ({ versionId: r.version_id, slot: r.role, contentHash: r.content_hash,
      storage: (parseJson(r.storage_ref_json) ?? { kind: 'unknown' }) as PlanInput['storage'], metadata: parseJson(r.metadata_json) }));
  }

  private repoPathOf(projectId: string): string | null {
    const accept = this.deps.acceptFsRoot;
    if (!accept) return null;
    const p = this.db.prepare('SELECT root_path FROM projects WHERE id = ?').get(projectId) as { root_path: string | null } | undefined;
    if (!p || typeof p.root_path !== 'string' || p.root_path.length === 0) return null;
    try { return accept(p.root_path); } catch { return null; }
  }

  /** One IMMEDIATE lease transaction. Returns true when the job was leased. */
  private lease(j: ExecJobRow, recipe: RecipeDef, cap: Capability, now: number): boolean {
    const home = this.deps.dataHome!;
    const n = j.attempts + 1;
    const attemptId = newId(now);
    const egress = recipe.network === 'egress-approved';
    const profile = (this.deps.profiles ?? []).find((p) => p.id === cap.profile) ?? null;
    const image = usableImage(this.probe, cap.profile);
    const inputs = this.planInputs(j.id);
    // A dev deployment stages the commit its build was made from, beside the build's files.
    // A diagnosis reads Docker and the data home only: no project folder.
    const needsRepo = (recipe.executor === 'engine' && recipe.id !== 'sde.diagnose') || recipe.executor === 'service' || inputs.some((i) => i.storage?.kind === 'git');
    const repoPath = needsRepo ? this.repoPathOf(j.project_id) : null;
    const workRel = home.attemptWorkRel(j.id, n);
    const logRel = home.attemptLogPath(j.id, n);
    // Egress plans are built only after the approval is consumed; every other plan is built now.
    let plan: ReturnType<typeof buildPlan> | null = null;
    let planError: { code: string; message: string } | null = null;
    const refused = (e: unknown): { code: string; message: string } => {
      if (!(e instanceof PlatformError)) throw e;
      return { code: String(e.detail?.reason ?? 'bad_plan'), message: e.message };
    };
    // A dev deployment: its manifest, the build's files and its deployment row's id (Task 9).
    let service: ServiceContext | null = null;
    if (recipe.executor === 'service') {
      const dep = this.deps.deployments;
      if (!dep || !cap.subjectVersionId) planError = { code: 'not_in_this_build', message: 'dev deployments are not available in this build' };
      else {
        try {
          const pre = dep.prepareStart(j.id, cap.subjectVersionId, now);
          const fwd = usableImage(this.probe, 'nexus-fwd');
          service = { deploymentId: pre.deploymentId, manifest: pre.manifest, files: pre.files, lifetimeMs: PREVIEW_IDLE_TTL_MS,
            forwarder: (this.deps.profiles ?? []).find((p) => p.id === 'nexus-fwd') ?? null,
            forwarderImageId: (fwd?.imageId as `sha256:${string}` | undefined) ?? null };
        } catch (e) { planError = refused(e); }
      }
    }
    let diagnose: DiagnoseContext | null = null;
    if (recipe.id === 'sde.diagnose' && !planError) {
      try { diagnose = this.diagnoseContext(cap); } catch (e) { planError = refused(e); }
    }
    if (!egress && !planError) {
      try {
        plan = buildPlan({ job: { id: j.id, projectId: j.project_id }, attempt: { id: attemptId, n }, bootId: this.bootId!, recipe,
          profile, imageId: (image?.imageId as `sha256:${string}` | undefined) ?? null, dataHomeRoot: home.root, workRel, logRel, inputs, repoPath,
          // B2b Task 7: the git write recipes plan from the params the system stored when it queued them.
          approval: null, service, diagnose, params: parseJson(j.params_json) });
      } catch (e) {
        planError = refused(e);
      }
    }
    const environment = {
      recipeId: recipe.id, recipeVersion: recipe.version, executor: recipe.executor, profile: cap.profile,
      // The reference the container is created from (a built image's local id; planBuilder.imageRef), and its base.
      imageRef: profile && image?.imageId ? imageRef(profile, image.imageId as `sha256:${string}`) : null, imageId: image?.imageId ?? null,
      baseDigest: profile?.image.digest ?? null, contextSha256: image?.contextSha256 ?? null,
      // The image's own record of its tool versions (its `nexus.versions` label, checked by its build self-test; constraint 8).
      imageVersions: image?.versions ?? null,
      dockerVersion: this.probe?.probe.version ?? null, runnerBootId: this.bootId, nexusVersion: this.deps.appVersion ?? null,
      lockfileSha256: lockfileSha256Of(inputs),
      // The dependency cache this attempt mounts (`nexus-deps-<profile>-<lock12>`; an install writes it), or null.
      depsVolume: depsVolumeName(cap.profile, inputs)
    };
    let leased: boolean;
    try {
      leased = this.leaseTx(j, recipe, cap, now, { attemptId, n, logRel, plan, environment, egress, inputs, image, service },
        () => planError, (e) => { planError = e; });
    } catch (e) {
      // A deterministic refusal inside the lease transaction (a record the store refuses, ...) would roll back on every
      // tick and leave the job queued forever: the attempt fails `bad_plan` in a transaction of its own (final review A1).
      if (!(e instanceof PlatformError) || e.code !== 'invalid') throw e;
      const error = { code: 'bad_plan', message: `the plan could not be recorded: ${e.message}`.slice(0, 300) };
      plan = null; planError = error;
      const env = JSON.stringify(environment).length <= MAX_ENVIRONMENT_JSON_CHARS ? environment : undefined;
      leased = this.leaseTx(j, recipe, cap, now, { attemptId, n, logRel, plan: null, environment: env, egress: false, inputs, image, service: null },
        () => error, () => {});
      this.log(`[nexus] exec: the lease of a job was refused (${String(e.detail?.field ?? e.detail?.reason ?? 'invalid')}); its attempt failed bad_plan`);
    }
    if (leased && plan && !planError) {
      if (this.send({ op: 'attempt.start', attemptId, plan })) this.sendFailures = 0;
      else { this.sendFailures++; this.unsent(attemptId, now); }
    }
    return leased;
  }

  /** The lease transaction itself (see `lease`). `getError` / `setError` share the plan error with the caller. */
  private leaseTx(j: ExecJobRow, recipe: RecipeDef, cap: Capability, now: number,
    t: { attemptId: string; n: number; logRel: string; plan: ReturnType<typeof buildPlan> | null; environment: unknown; egress: boolean;
      inputs: PlanInput[]; image: ReturnType<typeof usableImage>; service: ServiceContext | null },
    getError: () => { code: string; message: string } | null, setError: (e: { code: string; message: string }) => void): boolean {
    const { attemptId, n, logRel, plan, environment, egress, inputs, image, service } = t;
    const refused = (e: unknown): { code: string; message: string } => {
      if (!(e instanceof PlatformError)) throw e;
      return { code: String(e.detail?.reason ?? 'bad_plan'), message: e.message };
    };
    return immediateTx(this.db, () => {
      const cur = this.row(j.id);
      if (!cur || cur.state !== 'queued') return false;
      this.moveJobTx(j.id, 'leased', now, undefined, 'queued');
      this.deps.hooks?.afterLeaseTransition?.(j.id);
      insertAttemptTx(this.db, { id: attemptId, jobId: j.id, projectId: j.project_id, n, bootId: this.bootId!, now, logPath: logRel,
        sandbox: plan ? sandboxRecord(plan) : undefined, environment });
      this.setPhaseTx(j.id, 'provisioning', now);
      this.db.prepare('UPDATE jobs SET next_attempt_at = NULL WHERE id = ? AND next_attempt_at IS NOT NULL').run(j.id);
      if (egress && !getError()) {
        const approvals = this.deps.approvals;
        if (!approvals) {
          setError({ code: 'approvals_unavailable', message: 'network approvals are not available in this build' });
        } else {
          // The pending approval, then leased -> running (phase approval) -> awaiting_approval, all in this transaction.
          // A request the approval path refuses (no lockfile hash, ...) fails the job now: nothing is asked, nothing runs.
          let approvalId: string | null = null;
          try {
            approvalId = immediateTx(this.db, () => approvals.requestEgressTx({ id: j.id, projectId: j.project_id, onBehalfOf: j.on_behalf_of },
              { id: attemptId, n }, recipe, now));
          } catch (e) {
            setError(e instanceof PlatformError ? refused(e) : { code: 'approval_refused', message: 'the approval request could not be recorded' });
          }
          if (approvalId !== null) {
            this.moveJobTx(j.id, 'running', now, undefined, 'leased');
            this.setPhaseTx(j.id, 'approval', now);
            this.moveJobTx(j.id, 'awaiting_approval', now, undefined, 'running');
            appendJobEventTx(this.db, { type: 'approval', summary: 'waiting for approval of network access', projectId: j.project_id, jobId: j.id,
              attemptN: n, approvalId, data: { approvalId } }, now);
            return true;
          }
        }
      }
      if (service && plan && !getError()) {
        try {
          const facts = { buildVersionId: inputs.find((i) => i.slot === 'build')?.versionId ?? null, profile: cap.profile,
            appImageId: image?.imageId ?? null, forwarderImageId: service.forwarderImageId };
          immediateTx(this.db, () => this.deps.deployments!.startTx(this.row(j.id)!, { n }, service.deploymentId, cap.subjectVersionId!, now, facts));
        } catch (e) {
          setError(e instanceof PlatformError ? refused(e) : { code: 'deployment_refused', message: 'the dev deployment could not be recorded' });
        }
      }
      const planError = getError();
      if (planError) {
        transitionAttemptTx(this.db, attemptRow(this.db, attemptId)!, 'failed', now, j.project_id, { outcome: 'bad_plan', error: planError });
        this.moveJobTx(j.id, 'failed', now, { outcome: 'infra_error', error: planError });
      }
      return true;
    });
  }

  /** `attempt.start` did not reach the runner: nothing ran, so the attempt is abandoned and the job waits again (as on a refusal). */
  private unsent(attemptId: string, now: number): void {
    immediateTx(this.db, () => {
      const a = attemptRow(this.db, attemptId);
      if (!a || a.state !== 'starting') return;
      const j = this.row(a.job_id)!;
      const error = { code: 'not_sent', message: 'the plan did not reach the runner' };
      transitionAttemptTx(this.db, a, 'abandoned', now, j.project_id, { outcome: 'not_sent', error });
      if (j.state === 'leased' && getRecipe(j.recipe_id ?? '')?.executor !== 'service') {
        this.moveJobTx(j.id, 'queued', now, undefined, 'leased');
        this.setPhaseTx(j.id, 'waiting:runner', now);
        this.requeueBackoffTx(j.id, now);
      } else {
        this.failJobTx(j.id, 'infra_error', { code: 'runner_lost', message: 'the plan did not reach the runner' }, now);
      }
    });
  }

  /**
   * @internal For the approval service (Task 9): after the user's `once` was recorded and the approval
   * consumed by this job's current attempt, the job moves `awaiting_approval -> running` and the plan
   * (now carrying the approval) is built. Runs in the caller's transaction (or its own); returns the send
   * to perform AFTER the caller commits.
   */
  resumeApproved(jobId: string): () => void {
    // Task 9: ApprovalService.respond('once') records the decision, consumes the approval and resumes the job in ONE
    // transaction (resumeApprovedTx). When the caps refuse now ('conflict', reason waiting:<x>), the approval stays
    // consumed and the scheduler resumes the job on a later tick once the guards pass (resumeConsumed).
    this.requireAvailable();
    const r = this.resumeTx(jobId, this.deps.now());
    if ('stale' in r) throw new PlatformError('illegal_transition', 'the approval is stale: the job did not start within 15 minutes of it', { reason: 'approval_stale' });
    if ('wait' in r) throw new PlatformError('conflict', `the job cannot start now (${r.wait})`, { reason: r.wait });
    return r.send;
  }

  /** awaiting_approval -> running with the consumed approval in the plan, when the guards pass; else the wait reason. */
  private resumeTx(jobId: string, now: number): { send: () => void } | { wait: string } | { stale: true } {
    return immediateTx(this.db, (): { send: () => void } | { wait: string } | { stale: true } => {
      const j = this.row(jobId);
      if (!j || j.state !== 'awaiting_approval') throw new PlatformError('illegal_transition', 'the job is not waiting for approval');
      const a = liveAttemptOf(this.db, j.id);
      const recipe = getRecipe(j.recipe_id ?? '');
      const cap = this.capabilityOf(j);
      if (!a || !recipe || !cap || !this.deps.dataHome) throw new PlatformError('illegal_transition', 'the job has no attempt to resume');
      // Only an approval of THIS job consumed by its CURRENT attempt can carry its plan (the plan builder checks it again).
      const approval = this.db.prepare(`SELECT id, job_id, status, consumed_at, consumed_by_job_id, consumed_by_attempt_n FROM approvals
        WHERE job_id = ? AND status = 'approved' AND consumed_by_job_id = ? AND consumed_by_attempt_n = ?
        ORDER BY status_changed_at DESC LIMIT 1`).get(j.id, j.id, a.n) as PlanApproval | undefined;
      // A consent is for now, not for later: a job that could not start within the approval's 15 minutes after it was
      // consumed fails `denied` (approval_stale); the user asks again. A consumed approval never starts network work later.
      if (approval && approval.consumed_at !== null && now - approval.consumed_at >= APPROVAL_TTL_MS) {
        this.endAwaitingTx(j.id, { code: 'approval_stale', message: 'the job did not start within 15 minutes of the approval' }, now);
        return { stale: true };
      }
      // An attempt another boot owns is not this process's to start (restart recovery re-owns it first).
      if (a.lease_owner !== this.bootId) return { wait: 'waiting:runner' };
      // A job waiting for approval held no slot or memory: the caps are checked again before it starts.
      const limits = parseJson(j.limits_json) as Partial<ResourceLimits> | null;
      const wait = this.deps.blobs?.isExclusiveHeld() ? 'waiting:gc'
        : leaseGuard({ recipe, profile: cap.profile, memoryMb: typeof limits?.memoryMb === 'number' ? limits.memoryMb : 0 },
          this.runnerReady(), this.probe, this.liveUse(), this.caps);
      if (wait !== null) return { wait };
      const profile = (this.deps.profiles ?? []).find((pr) => pr.id === cap.profile) ?? null;
      const image = usableImage(this.probe, cap.profile);
      const plan = buildPlan({ job: { id: j.id, projectId: j.project_id }, attempt: { id: a.id, n: a.n }, bootId: this.bootId ?? '', recipe,
        profile, imageId: (image?.imageId as `sha256:${string}` | undefined) ?? null, dataHomeRoot: this.deps.dataHome.root,
        workRel: this.deps.dataHome.attemptWorkRel(j.id, a.n), logRel: this.deps.dataHome.attemptLogPath(j.id, a.n),
        inputs: this.planInputs(j.id), repoPath: this.repoPathOf(j.project_id), approval: approval ?? null, params: parseJson(j.params_json),
        // B2a stabilization (constraint 5): the install reaches its registries only through the job's egress proxy (sde-node image).
        egressProxy: { profile: (this.deps.profiles ?? []).find((pr) => pr.id === EGRESS_PROXY_PROFILE) ?? null,
          imageId: (usableImage(this.probe, EGRESS_PROXY_PROFILE)?.imageId as `sha256:${string}` | undefined) ?? null } });
      this.db.prepare('UPDATE job_attempts SET sandbox_json = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(sandboxRecord(plan)), now + LEASE_MS, now, a.id);
      this.moveJobTx(j.id, 'running', now, undefined, 'awaiting_approval');
      this.setPhaseTx(j.id, 'provisioning', now);
      return { send: () => { if (!this.send({ op: 'attempt.start', attemptId: a.id, plan })) this.unsent(a.id, this.deps.now()); } };
    });
  }

  /**
   * @internal ApprovalService.respond only, INSIDE its transaction, right after the user's `once` consumed the approval
   * for the job's current attempt: the job resumes (`awaiting_approval -> running`, the plan carrying this approval;
   * the returned `send` goes after commit). When the caps refuse now, the job keeps waiting with `phase` set to the
   * reason (the approval stays consumed; resumeConsumed starts it on a later tick). A refused plan fails the job now.
   * Never mapped to a transport: the user's door is `respond`.
   */
  resumeApprovedTx(jobId: string, now: number): { send: () => void } | { wait: string } | { failed: string } {
    this.requireAvailable();
    if (!this.db.inTransaction) throw new PlatformError('platform_unavailable', 'resumeApprovedTx runs inside the approval transaction');
    try {
      const r = this.resumeTx(jobId, now);
      if ('stale' in r) return { failed: 'approval_stale' };
      if ('wait' in r) this.setPhaseTx(jobId, r.wait, now);
      return r;
    } catch (e) {
      if (!(e instanceof PlatformError) || e.code !== 'invalid') throw e;
      const j = this.row(jobId)!;
      const error = { code: String(e.detail?.reason ?? 'bad_plan'), message: e.message };
      const a = liveAttemptOf(this.db, jobId);
      if (a) transitionAttemptTx(this.db, a, 'failed', now, j.project_id, { outcome: 'bad_plan', error });
      this.moveJobTx(jobId, 'failed', now, { outcome: 'infra_error', error });
      this.setPhaseTx(jobId, null, now);
      return { failed: error.code };
    }
  }

  /**
   * @internal ApprovalService only, INSIDE its transaction: a job waiting for approval that was denied or expired fails
   * `denied` (its starting attempt first). Nothing was sent to the runner and nothing is retried.
   */
  endAwaitingTx(jobId: string, error: { code: string; message: string }, now: number): void {
    if (!this.db.inTransaction) throw new PlatformError('platform_unavailable', 'endAwaitingTx runs inside the approval transaction');
    const j = this.row(jobId);
    if (!j || j.state !== 'awaiting_approval') return;
    const a = liveAttemptOf(this.db, jobId);
    if (a) transitionAttemptTx(this.db, a, 'failed', now, j.project_id, { outcome: 'denied', error });
    this.moveJobTx(jobId, 'failed', now, { outcome: 'denied', error });
    this.setPhaseTx(jobId, null, now);
  }

  /**
   * @internal DeploymentService only, INSIDE its transaction: a dev deployment's job ends now (failed, or cancelled when
   * it never started or was stopped before its health check), its live attempt first. Never retried.
   */
  endServiceJobTx(jobId: string, end: { state: 'failed' | 'cancelled'; outcome: string; error: { code: string; message: string } }, now: number): void {
    if (!this.db.inTransaction) throw new PlatformError('platform_unavailable', 'endServiceJobTx runs inside the deployment transaction');
    const j = this.requireServiceJob(jobId);
    if (TERMINAL_JOB_STATES.has(j.state)) return;
    const a = liveAttemptOf(this.db, jobId);
    if (a) transitionAttemptTx(this.db, a, end.state === 'cancelled' ? 'cancelled' : 'failed', now, j.project_id, { outcome: end.outcome, error: end.error });
    const to: JobState = end.state === 'cancelled' || j.state === 'queued' || j.state === 'retry_scheduled' ? 'cancelled' : 'failed';
    this.moveJobTx(jobId, to, now, { outcome: end.outcome, error: end.error });
    this.setPhaseTx(jobId, null, now);
  }

  /** @internal DeploymentService: whether restart recovery adopted this attempt for finalization and still awaits its exit. */
  awaitingExitOf(attemptId: string): boolean { return this.awaitingExit.has(attemptId); }

  /** @internal DeploymentService: the boot id this process leases with (null before a runner is attached). */
  currentBootId(): string | null { return this.bootId; }

  /** @internal DeploymentService only, INSIDE its transaction: a job's phase (e.g. `stopping`). */
  setJobPhaseTx(jobId: string, phase: string | null, now: number): void {
    if (!this.db.inTransaction) throw new PlatformError('platform_unavailable', 'setJobPhaseTx runs inside a transaction');
    this.requireServiceJob(jobId);
    this.setPhaseTx(jobId, phase, now);
  }

  /** The deployment service's helpers act on dev deployment jobs only (a service recipe); anything else is refused. */
  private requireServiceJob(jobId: string): ExecJobRow {
    const j = this.row(jobId);
    if (!j) throw new PlatformError('not_found', 'job not found');
    if (getRecipe(j.recipe_id ?? '')?.executor !== 'service') {
      throw new PlatformError('invalid', 'only a dev deployment job is ended by the deployment service', { reason: 'not_a_service_job' });
    }
    return j;
  }

  /**
   * The images as the runner reported them, judged against the image builds (A10): an image whose context label differs
   * from the latest succeeded build of its profile does not match (`image_mismatch`), whatever its digest says. B2a Task 12
   * (A2): with a succeeded build recorded, the image a container is created from is that build's local id: an image of
   * the profile with another id (built elsewhere, or older) does not match either.
   */
  private judgeImages(images: readonly ImageStatus[]): ImageStatus[] {
    return images.map((i) => {
      if (i.present !== true || i.digestMatches !== true) return i;
      const b = latestSucceededBuild(this.db, i.profile);
      const same = !b || (i.contextSha256 === b.contextSha256 && (b.imageId === null || i.imageId === b.imageId));
      return same ? i : { ...i, digestMatches: false };
    });
  }

  /** @internal ApprovalService: an image build finished; judge the cached images again and ask for a fresh probe. */
  refreshImages(): void {
    if (!this.deps.available) return;
    if (this.probe && this.rawImages) this.probe = { ...this.probe, images: this.judgeImages(this.rawImages) };
    if (this.portReady()) this.sendProbe(this.deps.now());
  }

  /** Jobs whose approval was approved and consumed by their current attempt but could not start then: start them now. */
  private resumeConsumed(now: number): void {
    const ids = this.db.prepare(`SELECT j.id FROM jobs j JOIN job_attempts a ON a.job_id = j.id AND a.n = j.attempts
        AND a.state IN ('starting','running')
      JOIN approvals ap ON ap.job_id = j.id AND ap.status = 'approved' AND ap.consumed_by_job_id = j.id AND ap.consumed_by_attempt_n = a.n
      WHERE j.state = 'awaiting_approval' ORDER BY j.priority, j.created_at, j.rowid`).all() as { id: string }[];
    for (const { id } of ids) {
      try {
        const r = this.resumeTx(id, now);
        if ('send' in r) r.send();
        else if ('wait' in r) this.setPhaseIfChanged(id, r.wait, now);
      } catch (e) {
        this.log(`[nexus] exec: approved job not resumed: ${e instanceof PlatformError ? e.code : (e as Error)?.name ?? 'error'}`);
      }
    }
  }

  private setPhaseIfChanged(id: string, phase: string, now: number): void {
    const j = this.row(id);
    if (j && j.phase !== phase) immediateTx(this.db, () => this.setPhaseTx(id, phase, now));
  }

  // ---------- restart recovery (recovery.ts) ----------

  /** The core's own helpers, for restart recovery (each runs inside the decision's transaction). */
  private recoveryHost(): RecoveryHost {
    const dh = this.deps.dataHome;
    const files: BlobStoreFiles | null = dh && dh.listObjectFiles && dh.sweepObjectsTmp && dh.deleteObjects
      ? { listObjectFiles: (l) => dh.listObjectFiles!(l), sweepObjectsTmp: (c) => dh.sweepObjectsTmp!(c), deleteObjects: (s) => dh.deleteObjects!(s) }
      : null;
    const v = this.deps.validation;
    return {
      db: this.db, auth: this.deps.auth, jobs: this.deps.jobs, available: this.deps.available, log: this.log, blobs: this.deps.blobs, files,
      home: dh ? homeLabel(dh.root) : null,
      requeueCheckTx: v && v.requeueCheckTx ? (system, jobId) => v.requeueCheckTx!(system, jobId) : null,
      moveJobTx: (id, to, now, d, expect) => { this.moveJobTx(id, to, now, d, expect); },
      failJobTx: (id, outcome, error, now, o) => this.failJobTx(id, outcome, error, now, o),
      isCollecting: (id) => this.collecting.has(id),
      setPhaseTx: (id, phase, now) => this.setPhaseTx(id, phase, now),
      endAwaitingTx: (jobId, error, now) => this.endAwaitingTx(jobId, error, now),
      send: (msg) => this.send(msg),
      logPathOf: (a) => this.adoptLogPath(a),
      awaitExit: (id) => { this.awaitingExit.add(id); }
    };
  }

  /** The log path an `attempt.adopt` carries: the attempt's stored path under the data home, as in its plan. */
  private adoptLogPath(a: AttemptRow): string {
    const home = this.deps.dataHome;
    const rel = a.log_path ?? (home ? home.attemptLogPath(a.job_id, a.n) : `logs/jobs/${a.job_id}/${a.n}.log`);
    if (!home) return rel;
    try { return underDataHome(home.root, rel); } catch { return rel; }
  }

  private requireRecoveryBoot(bootId: string): void {
    // Adopting for a boot other than the attached runner's would make every adopted attempt's reports "another boot's".
    if (this.port && this.bootId !== null && bootId !== this.bootId) {
      throw new PlatformError('invalid', 'recovery runs for the boot id the runner is attached with', { reason: 'boot_mismatch' });
    }
  }

  /**
   * Restart recovery, phase A (recovery.ts): at platform startup, from the database alone. System only. With execution
   * off on a v9 database it runs in hold mode (only jobs without a live attempt, by B1's rule). Never throws past its
   * checks: a decision that fails is logged and left as it was.
   */
  recoverPhaseA(system: Principal, bootId: string, now: number = this.deps.now()): PhaseAReport {
    this.requireRecoveryBoot(bootId);
    const r = recoverPhaseA(this.recoveryHost(), system, bootId, now);
    if (this.deps.available) {
      this.recoveryBootId = bootId; this.recoveredAt = now; this.lastUnreconciledAt = null;
      this.reconcileRequestedAt = null; this.reconcileOutstanding = false;
    }
    return r;
  }

  /**
   * Restart recovery, phase B (recovery.ts): at every runner `ready`, with the runner's answer to `reconcileList()`.
   * System only; needs execution and the boot id the runner is attached with. Sends `attempt.adopt` / `attempt.release`
   * / `attempt.cancel` after each decision commits; returns the labelled resources to remove.
   */
  recoverPhaseB(system: Principal, bootId: string, reconcile: ReconcileResult): PhaseBReport {
    this.requireRecoveryBoot(bootId);
    const now = this.deps.now();
    // B2a close: the runner answered; the held leases move by the downtime before phase B decides (even when the answer
    // turns out malformed: the runner is back, so what it does not pick up runs out within its remaining lease).
    if (this.outage !== null) this.endOutage(now, 'reconciled');
    const report = recoverPhaseB(this.recoveryHost(), system, bootId, reconcile, now);
    // The answer to the outstanding reconcile request has been applied.
    this.reconcileOutstanding = false;
    return report;
  }

  /**
   * Restart recovery's removal list was handed to the runner (`reconcile.remove`, B2a Task 11): one `exec.orphan_removed`
   * activity row with the counts by kind. The row records the request; the runner removes only resources labelled with
   * this install's `nexus.home` and a `nexus.attempt`. System only. Never throws past its checks.
   */
  recordOrphanRemoval(system: Principal, resources: readonly { kind: string; id: string }[]): void {
    this.requireAvailable();
    if (system?.kind !== 'system' || this.principals.get(system.id)?.kind !== 'system') {
      throw new PlatformError('denied', 'orphan removal is recorded by the system', { reason: 'system_only' });
    }
    const list = Array.isArray(resources) ? resources : [];
    if (list.length === 0) return;
    const n = (k: string): number => list.filter((r) => r?.kind === k).length;
    const now = this.deps.now();
    try {
      immediateTx(this.db, () => appendActivityRow(this.db, { actorKind: system.kind, actorId: system.id, entityType: 'execution',
        action: 'exec.orphan_removed', status: 'succeeded',
        details: { requested: list.length, containers: n('container'), volumes: n('volume'), networks: n('network') } }, now));
    } catch (e) {
      this.log(`[nexus] exec: the orphan removal was not recorded: ${e instanceof PlatformError ? e.code : (e as Error)?.name ?? 'error'}`);
    }
  }

  /** The newest `job_events.seq` (0 with none): the renderer hint push carries it (execWiring coalesces it). */
  lastEventSeq(): number {
    if (!this.deps.available) return 0;
    try {
      const r = this.db.prepare('SELECT MAX(seq) AS s FROM job_events').get() as { s: number | null } | undefined;
      return typeof r?.s === 'number' ? r.s : 0;
    } catch { return 0; }
  }

  /**
   * The attempts a `reconcile.list` would carry, WITHOUT recording a request (execWiring builds the message with it, and
   * calls `reconcileList()` only once the send succeeded: a request that never left is never waited for).
   */
  reconcileCandidates(): { attemptId: string; containerId: string; kind: 'tool' | 'service' }[] {
    if (!this.deps.available) return [];
    return reconcileList(this.db);
  }

  /** What main sends in `reconcile.list` at runner `ready`: every live attempt whose container is recorded. */
  reconcileList(): { attemptId: string; containerId: string; kind: 'tool' | 'service' }[] {
    if (!this.deps.available) return [];
    // Main calls this exactly when it sends `reconcile.list`: the reconcile bound waits for the answer.
    // Only the first request after phase A anchors the bound: a crash-looping runner's later requests never move it.
    const now = this.deps.now();
    if (this.reconcileRequestedAt === null) this.reconcileRequestedAt = now;
    this.reconcileOutstanding = true;
    // B2a close: a request at a runner restart the scheduler did not see (crash and ready between two ticks) opens the
    // hold; the first request during an outage anchors its bound.
    if (this.outage === null) this.openOutage(now, true);
    else if (this.outage.requestedAt === null) this.outage.requestedAt = now;
    return reconcileList(this.db);
  }

  /**
   * Restart recovery's blob store hygiene (recovery.ts): stale `objects/tmp` files, unindexed objects older than 24 h
   * (only while no attempt is live), an unfinished GC closed, undeletable files reported. Runs under the blob store's
   * exclusive lock; `busy` when an ingest or a GC holds it. Main calls it after phase B, before the scheduler's first tick.
   */
  recoverBlobStore(system: Principal, now: number = this.deps.now()): Promise<BlobSweepReport> {
    return recoverBlobStore(this.recoveryHost(), system, now);
  }

  // ---------- user operations ----------

  /**
   * Starts a recipe action. With a repository check configured (`snapshotsNeedRepositoryCheck`), the snapshot action
   * is refused here (`repository_check_required`) unless RepoService passes its REPOSITORY_CHECKED token: a snapshot
   * never starts without main's own check that the project folder is a git repository.
   */
  start(p: Principal, r: StartJobRequest, checked?: symbol): { job: ExecJob; created: boolean } {
    this.requireAvailable();
    if (!isPlainObject(r)) throw new PlatformError('invalid', 'request must be an object');
    if (!isStr(r.projectId) || !isStr(r.workspaceId)) throw new PlatformError('invalid', 'projectId and workspaceId are required');
    // Authorization first, so every denial is audited whatever else is wrong with the request.
    const pw = requireActiveParticipation(this.access, this.db, p, r.projectId, r.workspaceId, 'job.create');
    const key = validateKey(r.intentId);
    const action = typeof r.actionId === 'string' ? getUserAction(r.actionId) : null;
    if (!action || !('recipes' in action.run)) return invalid('unknown_action', 'unknown action');
    if (action.domain !== r.workspaceId) return invalid('action_not_in_domain', 'the action belongs to another domain');
    if (this.needsRepositoryCheck(action) && checked !== REPOSITORY_CHECKED) {
      return invalid('repository_check_required', 'a repository snapshot is requested through the snapshot request, which checks the folder first');
    }
    const params = checkParams(action.params, r.params ?? {});
    const inputs = this.validateInputShape(action, r.inputs);
    return this.createExecJob(p, { action, projectId: pw.project_id, workspaceId: pw.workspace_id, key, params, inputs, retryOf: null });
  }

  retry(p: Principal, jobId: string, intentId: string): { job: ExecJob } {
    this.requireAvailable();
    const key = validateKey(intentId);
    const j = this.load(p, jobId, 'job.create');
    const cap = this.capabilityOf(j);
    const action = cap ? getUserAction(cap.action) : null;
    if (!action || !('recipes' in action.run)) throw new PlatformError('invalid', 'only a job started from an action can be retried', { reason: 'unknown_action' });
    // A snapshot is requested again through the snapshot request (the folder is checked again), never retried blind.
    if (this.needsRepositoryCheck(action)) {
      throw new PlatformError('invalid', 'a repository snapshot is requested again through the snapshot request', { reason: 'repository_check_required' });
    }
    if (!['failed', 'timed_out', 'cancelled', 'interrupted'].includes(j.state)) {
      throw new PlatformError('illegal_transition', `a ${j.state} job is not retried`, { from: j.state });
    }
    const pwRow = this.db.prepare('SELECT project_id, workspace_id FROM project_workspaces WHERE id = ?').get(j.participation_id) as
      { project_id: string; workspace_id: string } | undefined;
    if (!pwRow) throw new PlatformError('participation_inactive', 'the participation is gone');
    const pw = requireActiveParticipation(this.access, this.db, p, pwRow.project_id, pwRow.workspace_id, 'job.create');
    // A dev deployment is retried for the application it previewed (its job input is that application's build).
    const inputs = cap?.subjectVersionId && getRecipe(cap.recipe)?.executor === 'service'
      ? [{ versionId: cap.subjectVersionId, slot: 'application' }]
      : (this.db.prepare('SELECT version_id AS versionId, role AS slot FROM job_inputs WHERE job_id = ? ORDER BY rowid').all(j.id) as
        { versionId: string; slot: string }[]).map((x) => ({ ...x }));
    const params = (parseJson(j.params_json) ?? {}) as Record<string, unknown>;
    return { job: this.createExecJob(p, { action, projectId: pw.project_id, workspaceId: pw.workspace_id, key, params, inputs, retryOf: j.id }).job };
  }

  private needsRepositoryCheck(action: UserActionDef): boolean {
    return this.deps.snapshotsNeedRepositoryCheck === true && 'recipes' in action.run && action.run.recipes.includes('repo.snapshot');
  }

  private validateInputShape(action: UserActionDef, raw: unknown): { versionId: string; slot: string }[] {
    const list = raw === undefined ? [] : raw;
    if (!Array.isArray(list) || list.length > MAX_START_INPUTS) return invalid('input_not_allowed', `inputs must be a list of at most ${MAX_START_INPUTS}`);
    const seen = new Set<string>();
    const out = list.map((x: unknown) => {
      if (!isPlainObject(x) || !isStr(x.versionId) || !isStr(x.slot) || Object.keys(x).some((k) => k !== 'versionId' && k !== 'slot')) {
        return invalid('input_not_allowed', 'each input is { versionId, slot }');
      }
      if (!action.inputs.some((s) => s.slot === x.slot)) invalid('input_not_allowed', `the action has no input slot ${String(x.slot).slice(0, 32)}`);
      const k = `${x.versionId}\u0000${x.slot}`;
      if (seen.has(k)) invalid('input_not_allowed', 'duplicate input');
      seen.add(k);
      return { versionId: x.versionId as string, slot: x.slot as string };
    });
    for (const s of action.inputs) {
      const n = out.filter((x) => x.slot === s.slot).length;
      if (n < s.min || n > s.max) invalid('input_not_allowed', `slot ${s.slot} takes ${s.min} to ${s.max} input(s)`);
    }
    return out;
  }

  /** Authorization is done; checks inputs (readable, candidate or active, an accepted kind), picks the recipe, creates the job. */
  private createExecJob(p: Principal, o: { action: UserActionDef; projectId: string; workspaceId: string; key: string;
    params: Record<string, unknown>; inputs: { versionId: string; slot: string }[]; retryOf: string | null }): { job: ExecJob; created: boolean } {
    const prior = this.db.prepare('SELECT id FROM jobs WHERE idempotency_key = ?').get(o.key) as { id: string } | undefined;
    const recipes = ('recipes' in o.action.run ? o.action.run.recipes : []).map((id) => getRecipe(id)).filter((x): x is RecipeDef => x !== null);
    const serviceRecipe = recipes.find((rc) => rc.executor === 'service');
    if (serviceRecipe) return this.createPreviewJob(p, o, serviceRecipe, !!prior);
    // One live snapshot job per project (Task 9; RepoService also checks the folder first): a new request returns it.
    if (!prior && recipes.length === 1 && recipes[0].id === 'repo.snapshot') {
      const live = this.db.prepare(`SELECT * FROM jobs WHERE project_id = ? AND recipe_id = 'repo.snapshot'
        AND state IN (${LIVE_JOB_STATES.map(() => '?').join(', ')}) ORDER BY created_at, rowid LIMIT 1`).get(o.projectId, ...LIVE_JOB_STATES) as ExecJobRow | undefined;
      if (live) return { job: this.toExecJob(live), created: false };
    }
    const facts: { kind: string; metadata: unknown }[] = [];
    for (const x of o.inputs) {
      try {
        this.access.requireVersionReadable(p, x.versionId, o.projectId);
      } catch (e) {
        if (e instanceof PlatformError && e.code === 'invalid') throw new PlatformError('invalid', 'the input is not allowed', { reason: 'input_not_allowed' });
        throw e;
      }
      const v = this.db.prepare(`SELECT v.status, v.metadata_json, a.kind FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id WHERE v.id = ?`)
        .get(x.versionId) as { status: string; metadata_json: string; kind: string };
      const slot = o.action.inputs.find((s) => s.slot === x.slot)!;
      if ((v.status !== 'candidate' && v.status !== 'active') || !slot.kinds.includes(v.kind as never)) {
        throw new PlatformError('invalid', 'the input is not allowed', { reason: 'input_not_allowed' });
      }
      facts.push({ kind: v.kind, metadata: parseJson(v.metadata_json) });
    }
    const profile = this.profileFor(o.projectId, facts);
    const recipe = recipes.find((rc) => rc.executor === 'engine' || rc.profiles.includes(profile)) ?? null;
    if (!recipe) return invalid('no_recipe', 'no recipe of this action fits the repository');
    if (recipe.executor === 'service') return invalid('not_in_this_build', 'this action arrives with dev deployments');
    // A diagnosis names its subject by params; it is resolved in this project and authorized (job.read) now.
    const diagnose = recipe.id === 'sde.diagnose' ? this.diagnoseSubject(p, o.projectId, o.params) : undefined;
    if (recipe.network === 'egress-approved' && !this.deps.approvals) return invalid('approvals_unavailable', 'network approvals are not available in this build');
    const cap: Capability = { action: o.action.id, recipe: recipe.id, recipeVersion: recipe.version, executor: recipe.executor, network: recipe.network,
      profile: recipe.executor === 'engine' ? null : profile, ...(diagnose ? { diagnose } : {}) };
    const limits = recipe.limits
      ? { cpus: recipe.limits.cpus, memoryMb: recipe.limits.memoryMb, pids: 512, wallClockMs: recipe.wallClockMs, outputMaxBytes: recipe.limits.outputMaxBytes, tmpfsMb: 512 }
      : { wallClockMs: recipe.wallClockMs };
    const create = {
      kind: 'tool.run' as const, projectId: o.projectId, workspaceId: o.workspaceId, idempotencyKey: o.key, recipeId: recipe.id,
      ...(o.retryOf ? { retryOf: o.retryOf } : {}),
      params: o.params, inputs: o.inputs.map((x) => ({ versionId: x.versionId, role: x.slot })),
      retry: { idempotent: recipe.retry.idempotent, maxAttempts: recipe.retry.maxAttempts, backoffMs: RETRY_BACKOFF_MS.slice(0, Math.max(recipe.retry.maxAttempts - 1, 0)) }
    };
    return this.insertExecJob(p, o, recipe, cap, limits, create, !!prior);
  }

  /** The job row with its capability and limits, one `job.transition` event (shared by every recipe action). */
  private insertExecJob(p: Principal, o: { action: UserActionDef; projectId: string; key: string; retryOf: string | null }, recipe: RecipeDef,
    cap: Capability, limits: Record<string, unknown>, create: Parameters<JobService['createTx']>[1], hasPrior: boolean): { job: ExecJob; created: boolean } {
    if (!hasPrior) this.requireQueueRoom(o.projectId);
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      if (!this.db.prepare('SELECT 1 FROM jobs WHERE idempotency_key = ?').get(o.key)) this.requireQueueRoom(o.projectId);
      const res = this.deps.jobs.createTx(p, create);
      if (res.created) {
        this.db.prepare('UPDATE jobs SET capabilities_json = ?, limits_json = ?, phase = NULL WHERE id = ?')
          .run(JSON.stringify([cap]), JSON.stringify(limits), res.job.id);
        appendJobEventTx(this.db, { type: 'job.transition', summary: `job queued: ${o.action.label}`, projectId: o.projectId, jobId: res.job.id,
          data: { from: null, to: 'queued', action: o.action.id, recipe: recipe.id, retryOf: o.retryOf,
            ...(cap.subjectVersionId ? { subjectVersionId: cap.subjectVersionId } : {}) } }, now);
      }
      return { job: this.toExecJob(this.row(res.job.id)!), created: res.created };
    });
  }

  /**
   * A dev deployment of an application version (Task 9). The application may be a draft: it is the deployment's
   * SUBJECT (recorded in the job's capability), while the job's input is the build version it was assembled from
   * (candidate or active, as every job input). A manifest that names environment variables is refused before any job
   * exists (`unavailable`: secrets for dev deployments are not supported yet).
   */
  private createPreviewJob(p: Principal, o: { action: UserActionDef; projectId: string; workspaceId: string; key: string;
    params: Record<string, unknown>; inputs: { versionId: string; slot: string }[]; retryOf: string | null }, recipe: RecipeDef, hasPrior: boolean): { job: ExecJob; created: boolean } {
    if (!this.deps.deployments) return invalid('not_in_this_build', 'dev deployments are not available in this build');
    const appIn = o.inputs.length === 1 && o.inputs[0].slot === 'application' ? o.inputs[0] : null;
    if (!appIn) return invalid('input_not_allowed', 'a dev deployment previews one application version');
    const readable = (versionId: string): void => {
      try { this.access.requireVersionReadable(p, versionId, o.projectId); } catch (e) {
        if (e instanceof PlatformError && e.code === 'invalid') throw new PlatformError('invalid', 'the input is not allowed', { reason: 'input_not_allowed' });
        throw e;
      }
    };
    readable(appIn.versionId);
    const app = this.db.prepare(`SELECT v.status, v.storage_ref_json, a.kind FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id WHERE v.id = ?`)
      .get(appIn.versionId) as { status: string; storage_ref_json: string; kind: string };
    if (app.kind !== 'application' || !['draft', 'candidate', 'active'].includes(app.status)) return invalid('input_not_allowed', 'the input is not allowed');
    const manifest = readAppManifest(app.storage_ref_json);
    if (!manifest) return invalid('bad_manifest', 'the application manifest is not valid');
    const blocker = previewBlocker(manifest);
    if (blocker) throw new PlatformError('unavailable', blocker.message, { reason: blocker.reason, names: blocker.names });
    if (!recipe.profiles.includes(manifest.profile)) return invalid('no_recipe', 'no recipe of this action fits the application');
    // The build the application was assembled from (its job_input lineage edge).
    const edge = this.db.prepare(`SELECT to_version_id AS id FROM artifact_edges WHERE from_version_id = ? AND relation = 'assembled_from'
      AND source = 'job_input' ORDER BY created_at, id LIMIT 1`).get(appIn.versionId) as { id: string } | undefined;
    if (!edge) return invalid('input_not_allowed', 'the application has no build to run');
    readable(edge.id);
    const build = this.db.prepare('SELECT status FROM artifact_versions WHERE id = ?').get(edge.id) as { status: string };
    if (build.status !== 'candidate' && build.status !== 'active') return invalid('input_not_allowed', 'the build of this application is not a candidate');
    // One live dev deployment per application version: while one is starting, healthy or not answering yet, or a
    // preview job for it is still live, a second start is refused before anything is written (a repeated intent still
    // answers its own job). Main runs this check and the insert below in one synchronous call, so nothing slips between.
    if (!hasPrior && this.previewLive(recipe.id, appIn.versionId)) {
      throw new PlatformError('conflict', 'a dev deployment of this application version is already live', { reason: 'deployment_live' });
    }
    const cap: Capability = { action: o.action.id, recipe: recipe.id, recipeVersion: recipe.version, executor: recipe.executor, network: recipe.network,
      profile: manifest.profile, subjectVersionId: appIn.versionId };
    const l = recipe.limits!;
    // The deployment ends itself after its fixed 2 h lifetime; the job's wall clock is only a backstop after that.
    const limits = { cpus: l.cpus, memoryMb: l.memoryMb, pids: 512, wallClockMs: PREVIEW_IDLE_TTL_MS + SERVICE_WALL_MARGIN_MS,
      outputMaxBytes: l.outputMaxBytes, tmpfsMb: 512 };
    const create = {
      kind: 'tool.run' as const, projectId: o.projectId, workspaceId: o.workspaceId, idempotencyKey: o.key, recipeId: recipe.id,
      ...(o.retryOf ? { retryOf: o.retryOf } : {}), params: o.params, inputs: [{ versionId: edge.id, role: 'build' }],
      retry: { idempotent: false, maxAttempts: 1, backoffMs: [] }
    };
    return this.insertExecJob(p, o, recipe, cap, limits, create, hasPrior);
  }

  /** Whether this application version has a live dev deployment, or a live preview job whose subject it is. */
  private previewLive(recipeId: string, versionId: string): boolean {
    if (this.db.prepare(`SELECT 1 FROM deployments WHERE subject_version_id = ? AND status IN ('starting','healthy','unhealthy') LIMIT 1`).get(versionId)) return true;
    return !!this.db.prepare(`SELECT 1 FROM jobs WHERE recipe_id = ? AND state IN (${LIVE_JOB_STATES.map(() => '?').join(', ')})
      AND (CASE WHEN json_valid(capabilities_json) THEN json_extract(capabilities_json, '$[0].subjectVersionId') END) = ? LIMIT 1`).get(recipeId, ...LIVE_JOB_STATES, versionId);
  }

  private requireQueueRoom(projectId: string): void {
    // Checks the system queues (validate jobs) are not counted against the user's queue.
    const n = (this.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE project_id = ? AND kind <> 'validate' AND state IN (${LIVE_JOB_STATES.map(() => '?').join(', ')})`)
      .get(projectId, ...LIVE_JOB_STATES) as { n: number }).n;
    if (n >= this.caps.perProjectQueue) invalid('queue_full', `a project holds at most ${this.caps.perProjectQueue} waiting or running jobs`);
  }

  /** The sandbox profile for this project's repository: an input's recorded profile, else the project's languages, else node. */
  private profileFor(projectId: string, facts: { kind: string; metadata: unknown }[]): SandboxProfileId {
    for (const f of facts) {
      const m = isPlainObject(f.metadata) ? f.metadata.profile : undefined;
      if (typeof m === 'string' && (SANDBOX_PROFILE_IDS as readonly string[]).includes(m)) return m as SandboxProfileId;
    }
    const row = this.db.prepare('SELECT metadata_json FROM projects WHERE id = ?').get(projectId) as { metadata_json: string | null } | undefined;
    const meta = parseJson(row?.metadata_json ?? null);
    const langs = isPlainObject(meta) && Array.isArray(meta.detectedLanguages) ? meta.detectedLanguages.map((x) => String(x).toLowerCase()) : [];
    if (langs.includes('python') && !langs.some((l) => l === 'javascript' || l === 'typescript')) return 'sde-python';
    return 'sde-node';
  }

  /**
   * The subject of a diagnosis (B2a Task 12): a dev deployment or a job of THIS project, which the caller may read
   * (`job.read` on the subject's job, audited when denied). Anything else is `input_not_allowed`.
   */
  private diagnoseSubject(p: Principal, projectId: string, params: Record<string, unknown>): NonNullable<Capability['diagnose']> {
    const target = params.target === 'deployment' ? 'deployment' : params.target === 'job' ? 'job' : null;
    const targetId = typeof params.targetId === 'string' ? params.targetId : null;
    if (!target || !targetId) return invalid('bad_params', 'a diagnosis names a deployment or a job');
    if (target === 'deployment') {
      const d = this.db.prepare('SELECT id, job_id, subject_version_id FROM deployments WHERE id = ? AND project_id = ?').get(targetId, projectId) as
        { id: string; job_id: string; subject_version_id: string } | undefined;
      if (!d) return invalid('input_not_allowed', 'the deployment to diagnose is not in this project');
      this.load(p, d.job_id, 'job.read');
      return { target, targetId, jobId: d.job_id, subjectVersionId: d.subject_version_id };
    }
    const j = this.row(targetId);
    if (!j || j.project_id !== projectId) return invalid('input_not_allowed', 'the job to diagnose is not in this project');
    this.load(p, j.id, 'job.read');
    return { target, targetId, jobId: j.id, subjectVersionId: null };
  }

  /**
   * What a diagnosis reads, from main's own rows at lease: the subject job's newest attempt container (a dev deployment's
   * app container, or a job's container while it exists), and the tail of its newest attempts' logs.
   */
  private diagnoseContext(cap: Capability): DiagnoseContext {
    const d = cap.diagnose;
    if (!d) throw new PlatformError('invalid', 'a diagnosis needs its subject', { reason: 'bad_input' });
    const attempts = this.db.prepare(`SELECT id, n, container_id, log_path FROM job_attempts WHERE job_id = ? ORDER BY n DESC LIMIT ?`)
      .all(d.jobId, DIAGNOSE_MAX_RANGES) as { id: string; n: number; container_id: string | null; log_path: string | null }[];
    const withContainer = attempts.find((a) => a.container_id !== null);
    const logRanges = attempts.filter((a) => a.log_path !== null).slice(0, 2)
      .map((a) => ({ attemptId: a.id, logRel: a.log_path!, offset: 0, length: DIAGNOSE_LOG_TAIL_BYTES, tail: true }));
    return { target: d.target, containerIds: withContainer ? [withContainer.container_id!] : [], logRanges };
  }

  cancel(p: Principal, jobId: string): ExecJob {
    this.requireAvailable();
    const j = this.load(p, jobId, 'job.cancel');
    if (TERMINAL_JOB_STATES.has(j.state)) throw new PlatformError('illegal_transition', `a ${j.state} job cannot be cancelled`, { from: j.state });
    const now = this.deps.now();
    const toCancel: { attemptId: string; reason: CancelReason }[] = [];
    immediateTx(this.db, () => {
      // Children first (deepest first), then the job itself.
      const tree = this.db.prepare(`WITH RECURSIVE t(id, depth) AS (SELECT id, 1 FROM jobs WHERE parent_job_id = ?
          UNION ALL SELECT j.id, t.depth + 1 FROM jobs j JOIN t ON j.parent_job_id = t.id WHERE t.depth < 16)
        SELECT id, MAX(depth) AS depth FROM t GROUP BY id ORDER BY depth DESC, id`).all(j.id) as { id: string }[];
      for (const c of tree) this.cancelOneTx(p, c.id, 'parent', now, toCancel);
      this.cancelOneTx(p, j.id, 'user', now, toCancel);
    });
    for (const c of toCancel) this.send({ op: 'attempt.cancel', attemptId: c.attemptId, graceMs: CANCEL_GRACE_MS, reason: c.reason });
    return this.toExecJob(this.row(j.id)!);
  }

  private cancelOneTx(p: Principal, id: string, reason: CancelReason, now: number, out: { attemptId: string; reason: CancelReason }[]): void {
    const j = this.row(id)!;
    if (TERMINAL_JOB_STATES.has(j.state)) return;
    if (j.cancel_requested_at === null) this.db.prepare('UPDATE jobs SET cancel_requested_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
    const a = liveAttemptOf(this.db, id);
    if (a) {
      transitionAttemptTx(this.db, a, 'cancelled', now, j.project_id, { outcome: 'cancelled', error: { code: 'cancelled', message: `cancelled (${reason})` } });
      out.push({ attemptId: a.id, reason });
    }
    // A pending approval of the job is withdrawn: a cancelled job never reaches the network.
    withdrawPendingApprovalsTx(this.db, p, j, now);
    // A dev deployment still live stops with its job, recorded as the canceller's act.
    this.deps.deployments?.stopForCancelTx(p, id, now);
    this.db.prepare("UPDATE artifact_versions SET draft_flag = 'cancelled_partial' WHERE produced_by_job_id = ? AND status = 'draft' AND draft_flag IS NULL")
      .run(id);
    this.moveJobTx(id, 'cancelled', now, { outcome: 'cancelled' });
    this.setPhaseTx(id, null, now);
  }

  list(p: Principal, f: JobFilter = {}): { jobs: ExecJob[]; truncated: boolean } {
    this.requireAvailable();
    if (!isPlainObject(f)) throw new PlatformError('invalid', 'filter must be an object');
    const limit = f.limit === undefined ? DEFAULT_EXEC_LIST_LIMIT : f.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_EXEC_LIST_LIMIT) {
      throw new PlatformError('invalid', `limit must be 1 to ${MAX_EXEC_LIST_LIMIT}`);
    }
    if (f.states !== undefined && (!Array.isArray(f.states) || f.states.length === 0 || !f.states.every(isJobState))) {
      throw new PlatformError('invalid', 'states must be a non-empty list of job states');
    }
    if (f.jobKind !== undefined && !JOB_KINDS.includes(f.jobKind as JobKind)) throw new PlatformError('invalid', 'unknown job kind');
    if (f.projectId !== undefined) {
      if (!isStr(f.projectId)) throw new PlatformError('invalid', 'projectId must be an id');
      this.access.require(p, f.projectId, 'job.read');
    } else {
      this.deps.auth.require(p, 'job.read', PLATFORM, { entityType: 'job' });
    }
    const where: string[] = []; const args: unknown[] = [];
    if (f.projectId !== undefined) { where.push('project_id = ?'); args.push(f.projectId); }
    if (f.workspaceId !== undefined) { if (!isStr(f.workspaceId)) throw new PlatformError('invalid', 'workspaceId must be an id'); where.push('workspace_id = ?'); args.push(f.workspaceId); }
    if (f.states !== undefined) { where.push(`state IN (${f.states.map(() => '?').join(', ')})`); args.push(...f.states); }
    if (f.jobKind !== undefined) { where.push('kind = ?'); args.push(f.jobKind); }
    // One read transaction (one snapshot) for the page and every per-job read of it, after authorization (a denial's
    // audit row is never inside it). The SQL shapes are bounded (the filters above), so the statement is cached.
    return this.readTx(() => {
      const rows = cachedStmt(this.db, `SELECT * FROM jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(...args, limit + 1) as ExecJobRow[];
      return { jobs: rows.slice(0, limit).map((r) => this.toExecJob(r)), truncated: rows.length > limit };
    });
  }

  get(p: Principal, jobId: string): JobDetail {
    this.requireAvailable();
    const j0 = this.load(p, jobId, 'job.read');
    // Authorized: the rest is one read transaction (the job row re-read in it, so the detail is one snapshot).
    return this.readTx(() => {
      const j = this.row(j0.id) ?? j0;
      const attempts = (cachedStmt(this.db, 'SELECT * FROM job_attempts WHERE job_id = ? ORDER BY n').all(j.id) as AttemptRow[]).map((a) => {
        const sb = parseJson(a.sandbox_json) as Record<string, unknown> | null;
        const net = sb && isPlainObject(sb.network) && typeof sb.network.mode === 'string' ? sb.network.mode : sb && typeof sb.network === 'string' ? sb.network : null;
        const pf = sb && isPlainObject(sb.preflight) ? { ok: sb.preflight.ok === true, problems: Array.isArray(sb.preflight.problems) ? (sb.preflight.problems as unknown[]).map(String).slice(0, 20) : [] } : null;
        const err = parseJson(a.error_json) as { code?: string; message?: string } | null;
        const env = parseJson(a.environment_json) as Record<string, unknown> | null;
        return { id: a.id, n: a.n, state: a.state, outcome: a.outcome, exitCode: a.exit_code, signal: a.signal,
          oomKilled: a.oom_killed === null ? null : a.oom_killed === 1, network: net, preflight: pf,
          error: err && typeof err.code === 'string' && typeof err.message === 'string' ? { code: err.code, message: err.message } : null,
          createdAt: a.created_at, startedAt: a.started_at, finishedAt: a.finished_at,
          imageId: env && typeof env.imageId === 'string' ? env.imageId : null, profile: env && typeof env.profile === 'string' ? env.profile : null };
      });
      const approvals = (cachedStmt(this.db, 'SELECT id, status, reason, expires_at FROM approvals WHERE job_id = ? ORDER BY requested_at').all(j.id) as
        { id: string; status: string; reason: string; expires_at: number }[]).map((x) => ({ id: x.id, status: x.status, reason: x.reason, expiresAt: x.expires_at }));
      const outputs = (cachedStmt(this.db, 'SELECT id, status, output_path FROM artifact_versions WHERE produced_by_job_id = ? ORDER BY created_at, id').all(j.id) as
        { id: string; status: string; output_path: string | null }[]).map((x) => ({ versionId: x.id, status: x.status, outputPath: x.output_path }));
      const dep = cachedStmt(this.db, 'SELECT id, status FROM deployments WHERE job_id = ? ORDER BY started_at DESC, id DESC LIMIT 1').get(j.id) as
        { id: string; status: string } | undefined;
      return { ...this.toExecJob(j), attemptHistory: attempts, approvals, outputs, deployment: dep ? { id: dep.id, status: dep.status } : null };
    });
  }

  /**
   * A read-only unit of reads in one deferred transaction: one snapshot, and one read lock instead of one per statement.
   * Inside a caller's transaction it is a savepoint of it. Nothing in `fn` writes.
   */
  private readTx<T>(fn: () => T): T {
    return this.db.inTransaction ? fn() : this.db.transaction(fn).deferred();
  }

  eventsSince(p: Principal, q: { sinceSeq: number; projectId?: string; limit?: number }): { events: JobEvent[]; lastSeq: number } {
    this.requireAvailable();
    if (!isPlainObject(q) || typeof q.sinceSeq !== 'number' || !Number.isSafeInteger(q.sinceSeq) || q.sinceSeq < 0) {
      throw new PlatformError('invalid', 'sinceSeq must be a non-negative integer');
    }
    const limit = q.limit === undefined ? 200 : q.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_EVENTS_LIMIT) throw new PlatformError('invalid', `limit must be 1 to ${MAX_EVENTS_LIMIT}`);
    let rows: JobEventRow[];
    if (q.projectId !== undefined) {
      if (!isStr(q.projectId)) throw new PlatformError('invalid', 'projectId must be an id');
      this.access.require(p, q.projectId, 'job.read');
      rows = this.db.prepare('SELECT * FROM job_events WHERE project_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(q.projectId, q.sinceSeq, limit) as JobEventRow[];
    } else {
      this.deps.auth.require(p, 'job.read', PLATFORM, { entityType: 'job' });
      rows = this.db.prepare('SELECT * FROM job_events WHERE seq > ? ORDER BY seq LIMIT ?').all(q.sinceSeq, limit) as JobEventRow[];
    }
    const events = rows.map(toJobEvent);
    return { events, lastSeq: events.length ? events[events.length - 1].seq : q.sinceSeq };
  }

  /** The cached probe and the resource gate; never waits on the runner or Docker, never throws. */
  health(): HealthSnapshot {
    let runnerState = 'unavailable';
    try { if (this.port) runnerState = this.port.state(); } catch { runnerState = 'unavailable'; }
    const c = this.probe;
    const floor = leaseFloorBytes(0);
    let schemaVersion: number | null = null;
    try { const v = this.db.pragma('user_version', { simple: true }); schemaVersion = typeof v === 'number' ? v : null; } catch { schemaVersion = null; }
    return {
      execution: { available: this.deps.available, reason: this.deps.available ? null : (this.deps.unavailableReason ?? 'not_enabled') },
      runner: { state: runnerState, attached: this.port !== null, faults: this.faults },
      docker: c ? { state: c.probe.docker, version: c.probe.version, cpus: c.probe.cpus, memoryBytes: c.probe.memoryBytes,
        ...(c.probe.os !== undefined ? { os: c.probe.os } : {}), ...(c.probe.wsl2 !== undefined ? { wsl2: c.probe.wsl2 } : {}) } : { state: 'unknown' },
      images: c ? c.images.map((i) => ({ profile: i.profile, present: i.present, matches: i.digestMatches,
        ...(typeof i.sizeBytes === 'number' ? { sizeBytes: i.sizeBytes } : {}), ...(typeof i.imageId === 'string' ? { imageId: i.imageId } : {}) })) : [],
      disk: { freeBytes: c ? c.freeBytes : null, leaseFloorBytes: floor },
      gate: c ? evaluateGate(c.probe, c.freeBytes ?? -1, c.images) : null,
      checkedAt: c ? c.at : null,
      schemaVersion,
      gpu: c && c.probe.gpu ? { detected: c.probe.gpu.detected === true, ...(typeof c.probe.gpu.model === 'string' ? { model: c.probe.gpu.model } : {}) }
        : { detected: false }
    };
  }

  /**
   * Whether a container action could run on this machine now, as a `setup:*` reason (the IPC layer maps
   * it to `unavailable`). Image preparation additionally needs the full 30 GiB gate (`setup:disk_low`).
   */
  setupAvailability(what: { actionId: string } | { imagePreparation: true }): { available: boolean; reason: string | null } {
    if (!this.deps.available) return { available: false, reason: `execution:${this.deps.unavailableReason ?? 'not_enabled'}` };
    if (!this.runnerReady()) return { available: false, reason: 'setup:runner_unavailable' };
    const c = this.probe;
    if (!c) return { available: false, reason: 'setup:runner_unavailable' };
    if (c.probe.docker !== 'running') return { available: false, reason: c.probe.docker === 'stopped' ? 'setup:docker_stopped' : 'setup:docker_missing' };
    if ('imagePreparation' in what) {
      const g = evaluateGate(c.probe, c.freeBytes ?? -1, []);
      return g.problems.some((x) => x.id === 'disk_low') ? { available: false, reason: 'setup:disk_low' } : { available: true, reason: null };
    }
    const action = getUserAction(what.actionId);
    if (!action || !('recipes' in action.run)) return { available: false, reason: 'not_applicable' };
    const recipes = action.run.recipes.map((id) => getRecipe(id)).filter((x): x is RecipeDef => x !== null).filter((x) => x.executor !== 'engine');
    if (recipes.length === 0) return { available: true, reason: null };
    const profiles: SandboxProfileId[] = [...new Set(recipes.flatMap((x) => x.profiles))].filter((x) => x !== 'nexus-fwd');
    // A dev deployment also runs the loopback forwarder.
    if (recipes.some((x) => x.executor === 'service')) profiles.push('nexus-fwd');
    for (const pr of profiles) {
      const s = c.images.find((i) => i.profile === pr);
      if (!s || s.present !== true) return { available: false, reason: 'setup:image_missing' };
      if (s.digestMatches !== true) return { available: false, reason: 'setup:image_mismatch' };
    }
    const needMb = Math.max(...recipes.map((x) => x.limits?.memoryMb ?? 0));
    if (typeof c.probe.memoryBytes !== 'number' || needMb > (c.probe.memoryBytes / 2 ** 20) * SOLO_MEMORY_SHARE) {
      return { available: false, reason: 'setup:docker_memory_low' };
    }
    const floor = leaseFloorBytes(Math.max(...recipes.map((x) => x.limits?.outputMaxBytes ?? 0)));
    if (c.freeBytes === null || c.freeBytes < floor) return { available: false, reason: 'setup:disk_low' };
    return { available: true, reason: null };
  }

  // ---------- reads ----------

  private row(id: string): ExecJobRow | null {
    return (cachedStmt(this.db, 'SELECT * FROM jobs WHERE id = ?').get(id) as ExecJobRow | undefined) ?? null;
  }

  private capabilityOf(j: ExecJobRow): Capability | null {
    const c = parseJson(j.capabilities_json);
    const first = Array.isArray(c) ? c[0] : null;
    return isPlainObject(first) && typeof first.action === 'string' && typeof first.recipe === 'string' ? first as unknown as Capability : null;
  }

  /** Loads a job and authorizes `action` with its STORED participation (unknown: 'not_found' only for a platform-wide reader). */
  private load(p: Principal, id: string, action: 'job.read' | 'job.cancel' | 'job.create'): ExecJobRow {
    const j = isStr(id) ? this.row(id) : null;
    if (!j) {
      this.deps.auth.require(p, action, PLATFORM, { entityType: 'job' });
      throw new PlatformError('not_found', 'job not found');
    }
    const ws = storedWorkspace(this.db, j.participation_id);
    this.access.require(p, j.project_id, action, ws ? { workspaceId: ws } : undefined);
    return j;
  }

  /** The headline of a job, from the job, its live attempt and the validations of its outputs. */
  headline(j: ExecJobRow): Headline {
    const live = liveAttemptOf(this.db, j.id);
    let checks: { failed: number; error: number; passed: number; pending: number } | undefined;
    if (j.state === 'completed' || j.state === 'partial') {
      const rel = `(v.job_id = @id OR v.job_id IN (SELECT id FROM jobs WHERE parent_job_id = @id)
        OR v.version_id IN (SELECT id FROM artifact_versions WHERE produced_by_job_id = @id))`;
      // The latest blocking row per (version, validator) of what the job made or checked, plus the job's own evidence
      // recorded on a version that was no longer a draft (a deduplicated output, a run on a candidate): those rows
      // are advisory for the version but are this job's result.
      const blocking = cachedStmt(this.db, `SELECT v.status FROM validations v WHERE v.blocking = 1 AND ${rel}
        AND NOT EXISTS (SELECT 1 FROM validations w WHERE w.version_id = v.version_id AND w.validator_id = v.validator_id AND w.blocking = 1
          AND (w.finished_at > v.finished_at OR (w.finished_at = v.finished_at AND w.rowid > v.rowid)))`).all({ id: j.id }) as { status: string }[];
      const own = (cachedStmt(this.db, `SELECT v.status, v.validator_id FROM validations v WHERE v.job_id = @id AND v.blocking = 0
        AND NOT EXISTS (SELECT 1 FROM validations w WHERE w.job_id = v.job_id AND w.version_id = v.version_id AND w.validator_id = v.validator_id
          AND w.blocking = 0 AND (w.finished_at > v.finished_at OR (w.finished_at = v.finished_at AND w.rowid > v.rowid)))`).all({ id: j.id }) as
        { status: string; validator_id: string }[]).filter((x) => getValidator(x.validator_id) !== null);
      // (Any registered validator: an advisory one, sde.deps.lock_matches, is an install's own result.)
      const latest = [...blocking, ...own];
      const outs = cachedStmt(this.db, 'SELECT status FROM artifact_versions WHERE produced_by_job_id = ?').all(j.id) as { status: string }[];
      const liveChildren = (cachedStmt(this.db, `SELECT COUNT(*) AS n FROM jobs WHERE parent_job_id = ? AND state IN (${LIVE_JOB_STATES.map(() => '?').join(', ')})`)
        .get(j.id, ...LIVE_JOB_STATES) as { n: number }).n;
      checks = {
        failed: latest.filter((x) => x.status === 'failed').length + outs.filter((x) => x.status === 'failed').length,
        error: latest.filter((x) => x.status === 'error').length,
        passed: latest.filter((x) => x.status === 'passed').length,
        pending: outs.filter((x) => x.status === 'draft').length + liveChildren
      };
    }
    // A live attempt this process does not own yet (left for restart recovery's phase B): it waits for the runner.
    const waitingRunner = !!live && live.lease_owner !== this.bootId && (j.state === 'running' || j.state === 'leased');
    return headlineFrom({ state: j.state, phase: j.phase, liveAttempt: live?.state ?? null, checks, waitingRunner });
  }

  private toExecJob(j: ExecJobRow): ExecJob {
    const cap = this.capabilityOf(j);
    return { ...this.deps.jobs.toJob(j), recipeId: j.recipe_id, actionId: cap?.action ?? null, phase: j.phase, nextAttemptAt: j.next_attempt_at,
      headline: this.headline(j) };
  }
}
