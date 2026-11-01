/**
 * Local dev deployments (B2a Task 9): one `deployments` row per `sde.preview.start` job, run by the runner as an app
 * container behind a loopback forwarder. SQLite is the only authority: the status, the probes (`health_json`, the last
 * 50) and whether the deployment ever passed its health check (an `app.preview_health` passed row bound to the job's
 * attempt) are all read from rows, never kept in memory (constraint 9).
 *
 * - Start (`startTx`, inside the execution core's lease transaction): the row starts `starting`, on 127.0.0.1, with no
 *   port. Its subject is the application version (a draft may be previewed); the job's input is the build version the
 *   application was assembled from.
 * - Port (`onProvisionedTx`): the runner picks the forwarder's loopback port from the ephemeral range (49152-65535) and
 *   reports it with `attempt.provisioned`; it is stored once. Two live deployments never share a port: the core refuses
 *   a port another live deployment holds, and `ux_deployments_port_live` is the backstop.
 * - Health (`onHealth`, from the runner's `service.health`): `starting -> healthy` on the first 200 (judged by
 *   `app.preview_health` over the recorded probes: a 200 on the health path within 60 s of the container start, the
 *   container running, bound to 127.0.0.1; the result is recorded on the subject, bound to the job's attempt, and the
 *   subject is finalized: a draft application becomes a candidate). `healthy -> unhealthy` after 3 consecutive failed
 *   probes; `unhealthy -> healthy` after 2 consecutive 200s. A container that is no longer running ends the deployment
 *   `failed` (`exited`).
 * - Start window (`tick`): a deployment still `starting` 60 s after its container started fails `probe_failed`
 *   (`app.preview_health` failed: the application draft fails); one whose container never started within 60 s of the
 *   lease fails `start_timeout` (the check could not run: `error`). The job fails with the same outcome.
 * - Windows across a restart or a stall (final review A2): when restart recovery re-owned the attempt (its `recovery`
 *   event, `adopt` or `finalize`, after the window began), the start window and the stopping wait count from that
 *   decision, and the health check judges probes from it: what happened while main was closed was never observed. A start
 *   window that overlapped main's downtime, or a scheduler stall of SLEEP_GAP_MS or more, ends `errored`
 *   (`start_window_unobserved`: the check could not run), never `failed`; the deployment row keeps `start_timeout` and
 *   the job fails `start_window_unobserved` (nothing blocks the draft; the user starts it again). A stopped deployment
 *   whose attempt waits for its re-reported exit (`awaitingExit`) is not failed `exit_not_reported` before that wait ends.
 * - Lifetime: idle traffic is not measurable in B2a, so a dev deployment has a fixed 2 h lifetime (stated in the UI);
 *   then it is stopped (`idle`).
 * - Stop (`stop`, a stored USER with `deployment.stop`; the system or an agent is `denied`, audited): `stopped`
 *   (`user`), and the runner is told `attempt.cancel { reason: 'user' }`. A deployment that had passed its health check
 *   keeps its job running (phase `stopping`) until the runner reports the exit; then the job completes with outcome
 *   `stopped`. If no exit arrives within STOPPING_LIMIT_MS the job fails `exit_not_reported` (the slot is freed). One
 *   that never passed ends its job `cancelled` at once. A finished deployment cannot be stopped again.
 * - Exit (the core's `attempt.exited` for a service attempt, `onExitedTx`): a live deployment fails (`exited`); the job
 *   completes `stopped` only if the deployment had passed its health check; one stopped before its check (the user,
 *   the lifetime, the app quitting) ends its job `cancelled` with that cause; else the job fails.
 * - Any other end of the job ends a live deployment (`endForJobTx`) with the job's true cause: cancel, timeout,
 *   recovery, a runner refusal (`refused`), a refused preflight (`preflight_failed`), a lost runner (`runner_lost`), an
 *   exit never reported (`exit_not_reported`). The row's `stop_reason` stores that true cause, as do the `reason` of its
 *   `deployment.transition` activity row and of its `deployment` event.
 * - Quitting the app stops every live deployment (`app_quit`) in one bounded transaction (MAX_QUIT_STOPS rows).
 * - Records (constraint 13): `deployment.start` (deployment, job and attempt, subject and build versions, profile and
 *   image ids, local-preview on 127.0.0.1, lifetime), `deployment.transition` (from, to, reason, port, whether it ever
 *   passed its check, the last probe status, the `app.preview_health` result it recorded) and `deployment.stop` (the
 *   user's stop and what happens to the job) activity rows, plus one `deployment` event per change. Nothing secret is
 *   stored: probes are numbers and the container state; the app's environment is refused before a job exists.
 */
import type Database from 'better-sqlite3';
import type { DeploymentStatus, Principal, ScopeRef } from '../../../shared/nexus/platform';
import type { MainToRunner } from '../../../shared/nexus/runnerProtocol';
import { PREVIEW_IDLE_TTL_MS } from '../../../shared/nexus/recipes';
import type { AuthService } from '../auth/authService';
import { PrincipalResolver } from '../auth/principals';
import { appendActivityRow } from '../activity/writer';
import { newId } from '../db/ids';
import { immediateTx } from '../db/tx';
import { PlatformError } from '../errors';
import { ProjectAccess } from '../project/projectAccess';
import { storedWorkspace } from '../jobs/jobService';
import { appendJobEventTx } from '../exec/events';
import type { ValidationService } from '../validation/validationService';
import { errored, type ValidatorOutcome } from '../validation/normalized';
import * as preview from '../validation/validators/appPreviewHealth';
import { readAppManifest, manifestFromJson, previewBlocker, type AppManifest } from '../repo/repoService';
import { requireStoredUser } from '../approvals/approvalService';
import { DEPLOYMENT_STATUSES, LIVE_DEPLOYMENT_STATUSES } from './deploymentRules';

/** The fixed lifetime of a dev deployment in B2a (idle traffic is not measurable). */
/**
 * The validators a dev deployment records while it runs (its health check), read by the registry check (B2a Task 13 fix
 * round 1); `judgeTx` records exactly this one.
 */
export const DEPLOYMENT_VALIDATORS: readonly string[] = Object.freeze([preview.ID]);
export const PREVIEW_LIFETIME_MS = PREVIEW_IDLE_TTL_MS;
export const START_WINDOW_MS = preview.START_WINDOW_MS;
export const HEALTH_KEEP = 50;
export const UNHEALTHY_AFTER = 3;
export const HEALTHY_AFTER = 2;
export const MAX_QUIT_STOPS = 100;
export const MAX_DEPLOYMENT_LIST = 500;
/** The most build files a dev deployment stages (the build ingest's tree bound). */
export const MAX_STAGED_FILES = 5000;
const CANCEL_GRACE_MS = 10_000;
/** A stopped deployment's job waits this long for the runner's exit report (the cancel grace plus a margin). */
export const STOPPING_LIMIT_MS = CANCEL_GRACE_MS + 50_000;

export type StopReason = 'user' | 'idle' | 'cancel' | 'app_quit' | 'recovery' | 'exited' | 'probe_failed' | 'start_timeout'
  | 'refused' | 'preflight_failed' | 'runner_lost' | 'exit_not_reported';
/** The true cause of an end: the row's `stop_reason`, and the activity and event `reason`. */
export type EndCause = StopReason;
export interface HealthProbeReport { status: number | null; ms: number | null; container: 'running' | 'exited' | 'missing' }
interface StoredProbe { at: number; status: number | null; ms: number | null; container: string }

export interface DeploymentView {
  id: string; projectId: string; subjectVersionId: string; jobId: string; environment: string; bindAddress: string;
  hostPort: number | null; url: string | null; healthPath: string | null; status: DeploymentStatus; stopReason: StopReason | null;
  lastProbe: { at: number; status: number | null; ms: number | null } | null; probes: number;
  startedAt: number; stoppedAt: number | null; lifetimeMs: number; endsAt: number;
}

/** What the lease knows about a dev deployment's start (recorded on `deployment.start`). */
export interface DeploymentStartFacts { buildVersionId: string | null; profile: string | null; appImageId: string | null; forwarderImageId: string | null }

/** What this service needs from the execution core (late-bound: the core is built after this service). */
export interface DeploymentExecPort {
  sendToRunner(msg: MainToRunner): boolean;
  /** Inside the caller's transaction: the deployment's job ends now, its live attempt first. */
  endServiceJobTx(jobId: string, end: { state: 'failed' | 'cancelled'; outcome: string; error: { code: string; message: string } }, now: number): void;
  /** Inside the caller's transaction: the job's phase (`stopping` while the runner stops the containers). */
  setJobPhaseTx(jobId: string, phase: string | null, now: number): void;
  /** Whether restart recovery adopted this attempt for finalization and its re-reported exit is still awaited. */
  awaitingExitOf?(attemptId: string): boolean;
  /** The boot id this process leases with (null before a runner is attached). */
  currentBootId?(): string | null;
}

/** A gap this long between deployment passes is a stall of main (sleep, a blocked loop): a window it covers was not observed. */
export const DEPLOYMENT_STALL_MS = 5 * 60_000;
/** How long a re-owned attempt waits for its re-reported exit (one lease, attempts.ts LEASE_MS). */
export const REREPORT_WAIT_MS = 60_000;

export interface DeploymentDeps { auth: AuthService; now: () => number; log?: (line: string) => void; validation: ValidationService }

interface DeploymentRow {
  id: string; project_id: string; participation_id: string; subject_version_id: string; job_id: string; environment: string;
  bind_address: string; host_port: number | null; status: DeploymentStatus; health_json: string; stop_reason: StopReason | null;
  stopped_by: string | null; created_by: string; started_at: number; stopped_at: number | null; status_changed_at: number; updated_at: number;
}
interface LiveAttempt { id: string; n: number; state: string; started_at: number | null; sandbox_json: string | null }
type AttemptFacts = { n: number; started_at: number | null; sandbox_json: string | null };
interface MoveOptions { reason?: StopReason; cause?: EndCause; by?: Principal; check?: { id: string; status: string } | null; job?: string }

const PLATFORM: ScopeRef = { type: 'platform' };
const LIVE = new Set<string>(LIVE_DEPLOYMENT_STATUSES);
const LIVE_SQL = `('${LIVE_DEPLOYMENT_STATUSES.join("','")}')`;
/** The runner's refusals of a start (runnerProtocol REFUSAL_REASONS) and the core's own "not sent". */
const REFUSED_CODES = new Set(['docker_missing', 'docker_stopped', 'image_missing', 'image_mismatch', 'disk_low', 'network_not_approved',
  'bad_plan', 'busy', 'unknown_attempt', 'input_changed', 'git_missing']);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const parse = (t: string | null): unknown => { if (t === null) return null; try { return JSON.parse(t) as unknown; } catch { return null; } };
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
/** A `sha256:<hex>` image id as `{ sha256: <hex> }` (the activity redactor keeps a hex digest only under a `sha256` key). */
const digestDetail = (d: string | null | undefined): { sha256: string } | null => (typeof d === 'string' && DIGEST_RE.test(d) ? { sha256: d.slice(7) } : null);

function probesOf(healthJson: string): StoredProbe[] {
  const v = parse(healthJson);
  if (!Array.isArray(v)) return [];
  return v.filter((p): p is StoredProbe => isObj(p) && typeof p.at === 'number');
}

/** How many probes at the end of the list satisfy `pred`, in a row. */
export function trailing(probes: readonly { status: number | null }[], pred: (p: { status: number | null }) => boolean): number {
  let n = 0;
  for (let i = probes.length - 1; i >= 0 && pred(probes[i]); i--) n++;
  return n;
}

/** The true cause of a dev deployment's end from its job's end (`to`, the job error code) and whether its container started. */
export function endCause(to: string, code: string | null, started: boolean): EndCause {
  if (to === 'cancelled') return 'cancel';
  if (to === 'timed_out') return 'idle';
  if (to === 'interrupted') return 'recovery';
  if (code === 'limits_not_applied') return 'preflight_failed';
  if (code !== null && REFUSED_CODES.has(code)) return 'refused';
  if (code === 'not_sent' || code === 'runner_lost') return 'runner_lost';
  if (code === 'exit_not_reported') return 'exit_not_reported';
  return started ? 'exited' : 'start_timeout';
}

export class DeploymentService {
  private readonly principals: PrincipalResolver;
  private readonly access: ProjectAccess;
  private readonly log: (line: string) => void;
  private execPort: DeploymentExecPort | null = null;
  /** The last deployment pass, and recent stalls of main between passes (in memory: a restart is recovery's re-own). */
  private lastTickAt: number | null = null;
  private readonly stalls: { from: number; to: number }[] = [];

  constructor(private readonly db: Database.Database, private readonly deps: DeploymentDeps) {
    this.principals = new PrincipalResolver(db);
    this.access = new ProjectAccess(db, { auth: deps.auth });
    this.log = deps.log ?? (() => {});
  }

  bindExecution(exec: DeploymentExecPort | null): void { this.execPort = exec; }

  private exec(): DeploymentExecPort {
    if (!this.execPort) throw new PlatformError('platform_unavailable', 'dev deployments need the execution core', { reason: 'not_enabled' });
    return this.execPort;
  }

  private system(): Principal { return this.principals.system(); }

  private row(id: string): DeploymentRow | null {
    return (this.db.prepare('SELECT * FROM deployments WHERE id = ?').get(id) as DeploymentRow | undefined) ?? null;
  }

  /** The deployment of a job (`job_id` is unique), or null. */
  byJob(jobId: string): DeploymentRow | null {
    return (this.db.prepare('SELECT * FROM deployments WHERE job_id = ?').get(jobId) as DeploymentRow | undefined) ?? null;
  }

  private liveAttempt(jobId: string): LiveAttempt | null {
    return (this.db.prepare(`SELECT id, n, state, started_at, sandbox_json FROM job_attempts WHERE job_id = ? AND state IN ('starting','running')`)
      .get(jobId) as LiveAttempt | undefined) ?? null;
  }

  /** Whether the job's attempt n passed its health check (an `app.preview_health` passed row bound to it). */
  healthyEver(jobId: string, n: number | null): boolean {
    if (n === null) return false;
    return !!this.db.prepare(`SELECT 1 FROM validations WHERE job_id = ? AND attempt_n = ? AND validator_id = ? AND status = 'passed' LIMIT 1`)
      .get(jobId, n, preview.ID);
  }

  /**
   * When restart recovery last re-owned the job's attempt n (`adopt` or `finalize`: its `recovery` event), or null. A window
   * that began before it was not observed while main was closed (final review A2).
   */
  reownedAt(jobId: string, n: number | null): number | null {
    if (n === null) return null;
    const r = this.db.prepare(`SELECT MAX(ts) AS ts FROM job_events WHERE job_id = ? AND attempt_n = ? AND type = 'recovery'
      AND json_extract(data_json, '$.decision') IN ('adopt','finalize')`).get(jobId, n) as { ts: number | null } | undefined;
    return typeof r?.ts === 'number' ? r.ts : null;
  }

  /** Whether a stall of main (a pass gap of DEPLOYMENT_STALL_MS or more) overlaps [from, to]. */
  private stalledDuring(from: number, to: number): boolean {
    return this.stalls.some((st) => st.to > from && st.from < to);
  }

  // ---------- start ----------

  /**
   * Before the lease transaction (the plan needs it): the subject's manifest, the build's files and the deployment id
   * (the job's existing `starting` row, or a new id). Throws PlatformError 'invalid' (`subject_unavailable`,
   * `bad_manifest`, `deployment_ended`, `tree_too_large`) or 'unavailable' (`secrets_not_supported`).
   */
  prepareStart(jobId: string, subjectVersionId: string | null, now: number): { deploymentId: string; manifest: AppManifest; files: { sha256: string; path: string }[]; buildArgv: string[] | null } {
    const subject = isStr(subjectVersionId) ? this.db.prepare(`SELECT v.id, v.status, v.storage_ref_json, a.kind FROM artifact_versions v
      JOIN artifacts a ON a.id = v.artifact_id WHERE v.id = ?`).get(subjectVersionId) as { id: string; status: string; storage_ref_json: string; kind: string } | undefined : undefined;
    if (!subject || (subject.kind !== 'application' && subject.kind !== 'change_set') || !['draft', 'candidate', 'active'].includes(subject.status)) {
      throw new PlatformError('invalid', 'the application version is not available for a dev deployment', { reason: 'subject_unavailable' });
    }
    // A suggested change (a live preview): its manifest and build step are in the job's params, which main wrote after reading them from the change's own commit.
    const live = subject.kind === 'change_set'
      ? (parse((this.db.prepare('SELECT params_json FROM jobs WHERE id = ?').get(jobId) as { params_json: string } | undefined)?.params_json ?? null) as { manifest?: unknown; buildArgv?: unknown } | null) : null;
    const manifest = subject.kind === 'change_set' ? manifestFromJson(isObj(live) ? live.manifest : undefined) : readAppManifest(subject.storage_ref_json);
    if (!manifest) throw new PlatformError('invalid', 'the application manifest is not valid', { reason: 'bad_manifest' });
    const buildArgv = isObj(live) && Array.isArray(live.buildArgv) && live.buildArgv.every((x) => typeof x === 'string') ? (live.buildArgv as string[]) : null;
    const blocker = previewBlocker(manifest);
    if (blocker) throw new PlatformError('unavailable', blocker.message, { reason: blocker.reason });
    const build = this.db.prepare("SELECT version_id FROM job_inputs WHERE job_id = ? AND role = 'build' ORDER BY rowid LIMIT 1").get(jobId) as { version_id: string } | undefined;
    const files = build ? this.db.prepare(`SELECT sha256, path FROM version_blobs WHERE version_id = ? AND role = 'file' ORDER BY path LIMIT ?`)
      .all(build.version_id, MAX_STAGED_FILES + 1) as { sha256: string; path: string }[] : [];
    if (files.length > MAX_STAGED_FILES) throw new PlatformError('invalid', 'the build holds too many files for a dev deployment', { reason: 'tree_too_large' });
    const existing = this.byJob(jobId);
    if (existing && (existing.status !== 'starting' || existing.host_port !== null)) {
      throw new PlatformError('invalid', 'the dev deployment of this job has already run', { reason: 'deployment_ended' });
    }
    return { deploymentId: existing?.id ?? newId(now), manifest, files, buildArgv };
  }

  /** @internal Inside the lease transaction: the job's deployment row (`starting`, no port), with its activity row. */
  startTx(j: { id: string; project_id: string; participation_id: string | null; workspace_id: string; on_behalf_of: string },
    attempt: { n: number }, deploymentId: string, subjectVersionId: string, now: number, facts?: DeploymentStartFacts): string {
    if (!this.db.inTransaction) throw new PlatformError('platform_unavailable', 'startTx runs inside the lease transaction');
    const existing = this.byJob(j.id);
    if (existing) {
      if (existing.id !== deploymentId || existing.status !== 'starting' || existing.host_port !== null) {
        throw new PlatformError('invalid', 'the dev deployment of this job has already run', { reason: 'deployment_ended' });
      }
      appendJobEventTx(this.db, { type: 'deployment', summary: `dev deployment starting again (attempt ${attempt.n})`, projectId: j.project_id,
        jobId: j.id, attemptN: attempt.n, deploymentId, data: { status: 'starting' } }, now);
      return existing.id;
    }
    if (!isStr(j.participation_id)) throw new PlatformError('invalid', 'a dev deployment runs in a participation', { reason: 'bad_input' });
    this.db.prepare(`INSERT INTO deployments (id, project_id, participation_id, subject_version_id, job_id, environment, bind_address, host_port,
        status, health_json, created_by, started_at, status_changed_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'local-preview', '127.0.0.1', NULL, 'starting', '[]', ?, ?, ?, ?)`)
      .run(deploymentId, j.project_id, j.participation_id, subjectVersionId, j.id, j.on_behalf_of, now, now, now);
    appendActivityRow(this.db, { actorKind: 'system', actorId: this.system().id, onBehalfOf: j.on_behalf_of, jobId: j.id, attemptN: attempt.n,
      projectId: j.project_id, workspaceId: j.workspace_id, artifactId: this.artifactOf(subjectVersionId), versionId: subjectVersionId,
      entityType: 'deployment', entityId: deploymentId, action: 'deployment.start', status: 'started',
      details: { deploymentId, jobId: j.id, attemptN: attempt.n, subjectVersionId, buildVersionId: facts?.buildVersionId ?? null,
        profile: facts?.profile ?? null, image: digestDetail(facts?.appImageId), forwarderImage: digestDetail(facts?.forwarderImageId),
        environment: 'local-preview', bindAddress: '127.0.0.1', lifetimeMs: PREVIEW_LIFETIME_MS } }, now);
    appendJobEventTx(this.db, { type: 'deployment', summary: 'dev deployment starting on 127.0.0.1', projectId: j.project_id, jobId: j.id,
      attemptN: attempt.n, deploymentId, data: { status: 'starting', subjectVersionId, environment: 'local-preview', lifetimeMs: PREVIEW_LIFETIME_MS } }, now);
    return deploymentId;
  }

  private artifactOf(versionId: string): string | null {
    return (this.db.prepare('SELECT artifact_id FROM artifact_versions WHERE id = ?').get(versionId) as { artifact_id: string } | undefined)?.artifact_id ?? null;
  }

  /** Whether another live deployment holds this port. */
  portHeld(port: number, jobId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM deployments WHERE host_port = ? AND status IN ${LIVE_SQL} AND job_id <> ? LIMIT 1`).get(port, jobId);
  }

  /** @internal Inside the core's provisioned transaction: the reported loopback port, stored once (the unique index backstops it). */
  onProvisionedTx(jobId: string, attemptN: number, hostPort: number, now: number): void {
    const d = this.byJob(jobId);
    if (!d || d.status !== 'starting' || d.host_port !== null) throw new PlatformError('conflict', 'the dev deployment is not waiting for its port', { reason: 'not_starting' });
    this.db.prepare(`UPDATE deployments SET host_port = ?, updated_at = ? WHERE id = ? AND status = 'starting' AND host_port IS NULL`).run(hostPort, now, d.id);
    appendJobEventTx(this.db, { type: 'deployment', summary: `dev deployment listening on 127.0.0.1:${hostPort}`, projectId: d.project_id,
      jobId, attemptN, deploymentId: d.id, data: { hostPort, bindAddress: d.bind_address } }, now);
  }

  // ---------- transitions ----------

  /**
   * One deployment transition (inside the caller's transaction) with its activity row (`deployment.stop` for a user's
   * stop, else `deployment.transition`) and its event. Who stopped it is also the row's `stopped_by`.
   */
  private moveTx(d: DeploymentRow, to: DeploymentStatus, now: number, o: MoveOptions = {}): void {
    const ending = to === 'stopped' || to === 'failed';
    const by = o.by ?? this.system();
    const r = ending
      ? this.db.prepare(`UPDATE deployments SET status = ?, stop_reason = ?, stopped_by = ?, stopped_at = ?, status_changed_at = ?, updated_at = ?
          WHERE id = ? AND status = ?`).run(to, o.reason ?? 'exited', to === 'stopped' ? by.id : null, now, now, now, d.id, d.status)
      : this.db.prepare('UPDATE deployments SET status = ?, status_changed_at = ?, updated_at = ? WHERE id = ? AND status = ?').run(to, now, now, d.id, d.status);
    if (r.changes !== 1) throw new PlatformError('conflict', 'the dev deployment changed before the update', { deploymentId: d.id });
    const j = this.db.prepare('SELECT workspace_id, on_behalf_of, attempts FROM jobs WHERE id = ?').get(d.job_id) as { workspace_id: string; on_behalf_of: string; attempts: number };
    const n = j.attempts > 0 ? j.attempts : null;
    const reason: EndCause | null = o.cause ?? o.reason ?? null;
    const probes = probesOf(d.health_json);
    // `deployment.stop` is a user's stop of the deployment itself; any other end, a user's cancel of its job included,
    // is a `deployment.transition` whose reason is the row's stop_reason.
    const userStop = to === 'stopped' && by.kind === 'user' && o.reason === 'user';
    appendActivityRow(this.db, { actorKind: by.kind, actorId: by.id, onBehalfOf: j.on_behalf_of, jobId: d.job_id, attemptN: n, projectId: d.project_id,
      workspaceId: j.workspace_id, artifactId: this.artifactOf(d.subject_version_id), versionId: d.subject_version_id, entityType: 'deployment',
      entityId: d.id, action: userStop ? 'deployment.stop' : 'deployment.transition', status: 'succeeded',
      details: userStop
        ? { deploymentId: d.id, from: d.status, to, reason: 'user', job: o.job ?? null, hostPort: d.host_port }
        : { deploymentId: d.id, from: d.status, to, reason, hostPort: d.host_port, healthyEver: this.healthyEver(d.job_id, n),
          lastProbeStatus: probes.length ? probes[probes.length - 1].status : null, check: o.check ?? null } }, now);
    appendJobEventTx(this.db, { type: 'deployment', summary: `dev deployment ${d.status} -> ${to}${reason ? ` (${reason})` : ''}`,
      projectId: d.project_id, jobId: d.job_id, attemptN: n, deploymentId: d.id,
      data: { from: d.status, to, reason, hostPort: d.host_port, by: by.kind } }, now);
  }

  /**
   * `app.preview_health` over the recorded facts (or a given outcome), recorded on the subject bound to the job's
   * attempt, then the subject is finalized. Inside the caller's transaction. Returns the outcome and the result row.
   */
  private subjectKind(versionId: string): string | null {
    return (this.db.prepare('SELECT a.kind FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id WHERE v.id = ?').get(versionId) as { kind: string } | undefined)?.kind ?? null;
  }

  private judgeTx(d: DeploymentRow, a: AttemptFacts, container: string, now: number, given?: ValidatorOutcome):
    { outcome: ValidatorOutcome; check: { id: string; status: string } } {
    const sb = parse(a.sandbox_json);
    const sbPath = isObj(sb) && isObj(sb.health) && typeof sb.health.path === 'string' ? sb.health.path : null;
    const subject = this.db.prepare('SELECT storage_ref_json FROM artifact_versions WHERE id = ?').get(d.subject_version_id) as { storage_ref_json: string } | undefined;
    const path = sbPath ?? readAppManifest(subject?.storage_ref_json ?? null)?.healthPath ?? '/';
    // Re-owned by restart recovery after the container started: the window counts from the re-own (final review A2).
    const started0 = a.started_at ?? d.started_at;
    const reowned = this.reownedAt(d.job_id, a.n);
    const startedAt = reowned !== null && reowned > started0 ? reowned : started0;
    const facts = { path, startedAt, container, bindAddress: d.bind_address,
      probes: probesOf(d.health_json).map((p) => ({ at: p.at, status: p.status, ms: p.ms })) };
    const outcome = given ?? preview.run(facts);
    const res = this.deps.validation.recordOutcomeTx(d.subject_version_id, DEPLOYMENT_VALIDATORS[0], outcome, { jobId: d.job_id, attemptN: a.n, startedAt });
    // An application draft is finalized by its health check; a suggested change keeps its own checks (the health result is advisory evidence on it).
    if (this.subjectKind(d.subject_version_id) === 'application') this.deps.validation.finalizeIfReady(this.system(), d.subject_version_id);
    return { outcome, check: { id: res.id, status: res.status } };
  }

  /** The health of a running deployment from the runner's `service.health` (see the module header). Never throws. */
  onHealth(deploymentId: string, probe: HealthProbeReport): void {
    const now = this.deps.now();
    let cancel: string | null = null;
    try {
      immediateTx(this.db, () => {
        const d0 = this.row(deploymentId);
        if (!d0 || !LIVE.has(d0.status)) return;
        const a = this.liveAttempt(d0.job_id);
        if (!a || a.state !== 'running') return;
        const probes = [...probesOf(d0.health_json), { at: now, status: probe.status, ms: probe.ms, container: probe.container }].slice(-HEALTH_KEEP);
        const healthJson = JSON.stringify(probes);
        this.db.prepare('UPDATE deployments SET health_json = ?, updated_at = ? WHERE id = ? AND status = ?').run(healthJson, now, d0.id, d0.status);
        const d: DeploymentRow = { ...d0, health_json: healthJson, updated_at: now };
        if (probe.container !== 'running') { this.containerGoneTx(d, a, probe.container, now); return; }
        if (d.status === 'starting') {
          if (probe.status !== 200) return;
          const j = this.judgeTx(d, a, 'running', now);
          if (j.outcome.status === 'passed') { this.moveTx(d, 'healthy', now, { check: j.check }); return; }
          this.moveTx(d, 'failed', now, { reason: 'probe_failed', check: j.check });
          this.exec().endServiceJobTx(d.job_id, { state: 'failed', outcome: 'probe_failed',
            error: { code: 'probe_failed', message: 'the app did not answer its health check within 60 s' } }, now);
          cancel = a.id;
          return;
        }
        if (d.status === 'healthy' && trailing(probes, (p) => p.status !== 200) >= UNHEALTHY_AFTER) this.moveTx(d, 'unhealthy', now);
        else if (d.status === 'unhealthy' && trailing(probes, (p) => p.status === 200) >= HEALTHY_AFTER) this.moveTx(d, 'healthy', now);
      });
    } catch (e) {
      this.log(`[nexus] deployments: health not recorded: ${e instanceof PlatformError ? e.code : (e as Error)?.name ?? 'error'}`);
    }
    if (cancel) this.sendCancel(cancel, 'timeout');
  }

  /** The app container is no longer running: the deployment fails (`exited`). */
  private containerGoneTx(d: DeploymentRow, a: LiveAttempt, container: string, now: number): void {
    if (this.healthyEver(d.job_id, a.n)) {
      // It had passed its health check: the job completes `stopped` when the runner reports the exit.
      this.moveTx(d, 'failed', now, { reason: 'exited' });
      this.exec().setJobPhaseTx(d.job_id, 'stopping', now);
      return;
    }
    const j = this.judgeTx(d, a, container, now);
    this.moveTx(d, 'failed', now, { reason: 'exited', check: j.check });
    this.exec().endServiceJobTx(d.job_id, { state: 'failed', outcome: 'exited',
      error: { code: 'exited', message: 'the app container exited before it answered its health check' } }, now);
  }

  /**
   * @internal Inside the core's exit transaction for a service attempt. A live deployment fails (`exited`).
   * `complete`: it had passed its health check (the job completes `stopped`). `stopped`: it was stopped before its check
   * (the user, the lifetime, the app quitting); the job ends `cancelled` with that cause. `fail`: it exited on its own.
   */
  onExitedTx(jobId: string, a: AttemptFacts, now: number): { decision: 'complete' | 'stopped' | 'fail'; cause: string } {
    const d = this.byJob(jobId);
    const healthy = this.healthyEver(jobId, a.n);
    if (d && LIVE.has(d.status)) {
      if (healthy) this.moveTx(d, 'failed', now, { reason: 'exited' });
      else {
        const j = this.judgeTx(d, a, 'exited', now);
        this.moveTx(d, 'failed', now, { reason: 'exited', check: j.check });
      }
      return { decision: healthy ? 'complete' : 'fail', cause: 'exited' };
    }
    if (healthy) return { decision: 'complete', cause: d?.stop_reason ?? 'exited' };
    if (d && d.status === 'stopped' && d.stop_reason) return { decision: 'stopped', cause: d.stop_reason };
    return { decision: 'fail', cause: 'exited' };
  }

  /**
   * @internal The core's hook on every terminal move of a dev deployment's job: a deployment still live ends with the
   * job's true cause (`endCause`). One that never passed its health check and did not end by a cancel records that
   * the check could not run.
   */
  endForJobTx(jobId: string, to: string, now: number, cause?: { outcome: string | null; code: string | null }): void {
    const d = this.byJob(jobId);
    if (!d || !LIVE.has(d.status)) return;
    const a = this.db.prepare('SELECT a.n, a.started_at, a.sandbox_json FROM job_attempts a JOIN jobs j ON j.id = a.job_id AND a.n = j.attempts WHERE j.id = ?')
      .get(jobId) as AttemptFacts | undefined;
    const started = !!a && a.started_at !== null;
    const why = endCause(to, cause?.code ?? null, started);
    if (to === 'cancelled' || to === 'timed_out' || to === 'interrupted') {
      this.moveTx(d, 'stopped', now, { reason: why });
      return;
    }
    const check = a && !this.healthyEver(jobId, a.n)
      ? this.judgeTx(d, a, started ? 'exited' : 'missing', now, errored('preview_not_run', 'Checks could not run: the dev deployment ended before its health check.')).check
      : null;
    this.moveTx(d, 'failed', now, { reason: why, check });
  }

  /** @internal The core's cancel (a user cancelled the job): a live deployment stops (`cancel`), recorded as that user's act. */
  stopForCancelTx(p: Principal, jobId: string, now: number): void {
    const d = this.byJob(jobId);
    if (d && LIVE.has(d.status)) this.moveTx(d, 'stopped', now, { reason: 'cancel', by: p, job: 'cancelled' });
  }

  // ---------- the scheduler's pass ----------

  /** Start windows, the fixed lifetime and the bounded wait for an exit after a stop (see the module header). Never throws. */
  tick(now: number): void {
    let rows: (DeploymentRow & { attempt_id: string | null; attempt_n: number | null; attempt_state: string | null; attempt_started_at: number | null;
      attempt_sandbox: string | null; attempt_owner: string | null })[];
    let stopping: { deployment_id: string; job_id: string; stopped_at: number; attempt_id: string | null; attempt_owner: string | null }[];
    try {
      rows = this.db.prepare(`SELECT d.*, a.id AS attempt_id, a.n AS attempt_n, a.state AS attempt_state, a.started_at AS attempt_started_at,
          a.sandbox_json AS attempt_sandbox, a.lease_owner AS attempt_owner FROM deployments d
          LEFT JOIN job_attempts a ON a.job_id = d.job_id AND a.state IN ('starting','running')
        WHERE d.status IN ${LIVE_SQL} ORDER BY d.started_at, d.id`).all() as typeof rows;
      stopping = this.db.prepare(`SELECT d.id AS deployment_id, d.job_id, d.stopped_at, a.id AS attempt_id, a.lease_owner AS attempt_owner
          FROM jobs j JOIN deployments d ON d.job_id = j.id
          LEFT JOIN job_attempts a ON a.job_id = j.id AND a.state IN ('starting','running')
        WHERE j.state = 'running' AND j.phase = 'stopping' AND d.status IN ('stopped','failed') AND d.stopped_at <= ?`)
        .all(now - STOPPING_LIMIT_MS) as typeof stopping;
    } catch (e) {
      this.log(`[nexus] deployments: pass stopped: ${(e as Error)?.name ?? 'error'}`);
      return;
    }
    // A long gap since the last pass is a stall of main: windows it covers were not observed.
    if (this.lastTickAt !== null && now - this.lastTickAt >= DEPLOYMENT_STALL_MS) {
      this.stalls.push({ from: this.lastTickAt, to: now });
      if (this.stalls.length > 100) this.stalls.splice(0, this.stalls.length - 100);
    }
    this.lastTickAt = now;
    // An attempt another boot still owns waits for restart recovery's phase B (adopt or finalize): its windows are not
    // judged by a process that never observed them (final review A2; the reconcile bound ends it if no phase B comes).
    const port = this.execPort;
    const boot: string | null | undefined = port && typeof port.currentBootId === 'function' ? port.currentBootId() : undefined;
    const foreign = (owner: string | null): boolean => boot !== undefined && owner !== null && owner !== boot;
    for (const r of rows) {
      try {
        if (foreign(r.attempt_owner)) continue;
        if (now - r.started_at >= PREVIEW_LIFETIME_MS) { this.endLifetime(r.id, now); continue; }
        if (r.status !== 'starting') continue;
        const running = r.attempt_state === 'running' && r.attempt_started_at !== null;
        const base = running ? r.attempt_started_at! : r.started_at;
        // Re-owned by restart recovery after the window began: the window counts from the re-own (final review A2).
        const reowned = this.reownedAt(r.job_id, r.attempt_n);
        const since = reowned !== null && reowned > base ? reowned : base;
        if (now - since > START_WINDOW_MS) {
          const unobserved = since !== base || this.stalledDuring(base, now);
          this.failStart(r.id, running ? 'probe_failed' : 'start_timeout', now, unobserved);
        }
      } catch (e) {
        this.log(`[nexus] deployments: ${r.id.slice(0, 8)} not moved: ${e instanceof PlatformError ? e.code : (e as Error)?.name ?? 'error'}`);
      }
    }
    for (const s of stopping) {
      try {
        if (foreign(s.attempt_owner)) continue;
        // Re-owned after the stop (a restart): the wait counts from the re-own; an attempt adopted for finalization waits
        // for its re-reported exit until that deadline (final review A2).
        const n = (this.db.prepare('SELECT attempts FROM jobs WHERE id = ?').get(s.job_id) as { attempts: number } | undefined)?.attempts ?? null;
        const reowned = this.reownedAt(s.job_id, n);
        if (reowned !== null && reowned > s.stopped_at && now - reowned < Math.max(STOPPING_LIMIT_MS, REREPORT_WAIT_MS)) continue;
        if (s.attempt_id && this.execPort?.awaitingExitOf?.(s.attempt_id) === true && (reowned === null || now - reowned < REREPORT_WAIT_MS)) continue;
        // The runner never reported the exit after the stop: the job ends now and its slot is freed.
        immediateTx(this.db, () => this.exec().endServiceJobTx(s.job_id, { state: 'failed', outcome: 'exit_not_reported',
          error: { code: 'exit_not_reported', message: 'the runner did not report the exit of the stopped dev deployment' } }, now));
        if (s.attempt_id) this.sendCancel(s.attempt_id, 'timeout');
      } catch (e) {
        this.log(`[nexus] deployments: stopped job not ended: ${e instanceof PlatformError ? e.code : (e as Error)?.name ?? 'error'}`);
      }
    }
  }

  /**
   * No 200 within the start window: `probe_failed` (judged: the draft fails) or `start_timeout` (the check could not run).
   * A window main did not observe (`unobserved`: it overlapped main's downtime or a stall) is never a failure of the app:
   * `errored('start_window_unobserved')`, the row keeps `start_timeout`, the job fails `start_window_unobserved`.
   */
  private failStart(deploymentId: string, reason: 'probe_failed' | 'start_timeout', now: number, unobserved = false): void {
    let cancel: string | null = null;
    immediateTx(this.db, () => {
      const d = this.row(deploymentId);
      if (!d || d.status !== 'starting') return;
      const a = this.liveAttempt(d.job_id);
      const given = unobserved
        ? errored('start_window_unobserved', 'Checks could not run: Nexus was closed or stalled during the start window, so the start was not observed.')
        : reason === 'start_timeout' ? errored('start_timeout', 'Checks could not run: the dev deployment did not start within 60 s.') : undefined;
      const check = a ? this.judgeTx(d, a, 'running', now, given).check : null;
      this.moveTx(d, 'failed', now, { reason: unobserved ? 'start_timeout' : reason, check });
      if (a) cancel = a.id;
      const code = unobserved ? 'start_window_unobserved' : reason;
      const message = unobserved ? 'the start window of the dev deployment was not observed (Nexus was closed or stalled); start it again'
        : reason === 'probe_failed' ? 'the app did not answer 200 on its health path within 60 s' : 'the dev deployment did not start within 60 s';
      this.exec().endServiceJobTx(d.job_id, { state: 'failed', outcome: code, error: { code, message } }, now);
    });
    if (cancel) this.sendCancel(cancel, 'timeout');
  }

  /** The fixed 2 h lifetime is over: stopped (`idle`). */
  private endLifetime(deploymentId: string, now: number): void {
    const cancel = immediateTx(this.db, () => this.stopTx(deploymentId, 'idle', this.system(), now));
    if (cancel) this.sendCancel(cancel, 'timeout');
  }

  /**
   * Inside a transaction: a live deployment stops. A deployment that had passed its health check keeps its job running
   * until the runner reports the exit (phase `stopping`); one that never did ends its job `cancelled` now. Returns the
   * live attempt to cancel, or null.
   */
  private stopTx(deploymentId: string, reason: StopReason, by: Principal, now: number): string | null {
    const d = this.row(deploymentId);
    if (!d) throw new PlatformError('not_found', 'deployment not found');
    if (!LIVE.has(d.status)) throw new PlatformError('illegal_transition', `a ${d.status} deployment cannot be stopped`, { from: d.status });
    const a = this.liveAttempt(d.job_id);
    const healthy = !!a && this.healthyEver(d.job_id, a.n);
    this.moveTx(d, 'stopped', now, { reason, by, job: !a ? 'none' : healthy ? 'completes_on_exit' : 'cancelled' });
    if (!a) return null;
    if (healthy) this.exec().setJobPhaseTx(d.job_id, 'stopping', now);
    else {
      this.exec().endServiceJobTx(d.job_id, { state: 'cancelled', outcome: 'stopped',
        error: { code: 'stopped', message: 'the dev deployment was stopped before it answered its health check' } }, now);
    }
    return a.id;
  }

  private sendCancel(attemptId: string, reason: 'user' | 'timeout' | 'shutdown'): void {
    try { this.execPort?.sendToRunner({ op: 'attempt.cancel', attemptId, graceMs: CANCEL_GRACE_MS, reason }); } catch { /* the runner is gone; recovery reconciles */ }
  }

  // ---------- user operations ----------

  /** A user stops a live deployment (`deployment.stop`); a finished one is `illegal_transition`. The system and agents are `denied`. */
  stop(p: Principal, deploymentId: string): DeploymentView {
    requireStoredUser(this.principals, this.deps.auth, p, 'deployment.stop', 'deployment', 'only a user stops a dev deployment');
    const d = isStr(deploymentId) ? this.row(deploymentId) : null;
    if (!d) {
      this.deps.auth.require(p, 'deployment.stop', PLATFORM, { entityType: 'deployment' });
      throw new PlatformError('not_found', 'deployment not found');
    }
    const ws = storedWorkspace(this.db, d.participation_id);
    this.access.require(p, d.project_id, 'deployment.stop', ws ? { workspaceId: ws } : undefined);
    const now = this.deps.now();
    const cancel = immediateTx(this.db, () => this.stopTx(d.id, 'user', p, now));
    if (cancel) this.sendCancel(cancel, 'user');
    return this.view(this.row(d.id)!);
  }

  /**
   * App quit: every live deployment `stopped` (`app_quit`) in ONE bounded transaction (at most MAX_QUIT_STOPS rows),
   * then `attempt.cancel { reason: 'shutdown' }` for their attempts. Jobs are left to restart recovery. Never throws.
   */
  stopAllForQuit(): number {
    const now = this.deps.now();
    let out: { stopped: number; attempts: string[] } = { stopped: 0, attempts: [] };
    try {
      out = immediateTx(this.db, () => {
        const rows = this.db.prepare(`SELECT * FROM deployments WHERE status IN ${LIVE_SQL} ORDER BY started_at, id LIMIT ?`).all(MAX_QUIT_STOPS) as DeploymentRow[];
        const attempts: string[] = [];
        for (const d of rows) {
          this.moveTx(d, 'stopped', now, { reason: 'app_quit' });
          const a = this.liveAttempt(d.job_id);
          if (a) attempts.push(a.id);
        }
        return { stopped: rows.length, attempts };
      });
    } catch (e) {
      this.log(`[nexus] deployments: quit stop not recorded: ${e instanceof PlatformError ? e.code : (e as Error)?.name ?? 'error'}`);
      return 0;
    }
    for (const id of out.attempts) this.sendCancel(id, 'shutdown');
    return out.stopped;
  }

  /** Deployments the caller may read (`job.read`), newest first. */
  list(p: Principal, f: { projectId?: string; status?: DeploymentStatus; limit?: number } = {}): { deployments: DeploymentView[]; truncated: boolean } {
    if (!isObj(f)) throw new PlatformError('invalid', 'filter must be an object');
    const limit = f.limit === undefined ? 100 : f.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_DEPLOYMENT_LIST) throw new PlatformError('invalid', `limit must be 1 to ${MAX_DEPLOYMENT_LIST}`);
    if (f.status !== undefined && !(DEPLOYMENT_STATUSES as readonly string[]).includes(f.status)) throw new PlatformError('invalid', 'unknown deployment status');
    const where: string[] = []; const args: unknown[] = [];
    if (f.projectId !== undefined) {
      if (!isStr(f.projectId)) throw new PlatformError('invalid', 'projectId must be an id');
      this.access.require(p, f.projectId, 'job.read');
      where.push('project_id = ?'); args.push(f.projectId);
    } else {
      this.deps.auth.require(p, 'job.read', PLATFORM, { entityType: 'deployment' });
    }
    if (f.status !== undefined) { where.push('status = ?'); args.push(f.status); }
    const rows = this.db.prepare(`SELECT * FROM deployments ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC, id DESC LIMIT ?`)
      .all(...args, limit + 1) as DeploymentRow[];
    return { deployments: rows.slice(0, limit).map((r) => this.view(r)), truncated: rows.length > limit };
  }

  private view(d: DeploymentRow): DeploymentView {
    const probes = probesOf(d.health_json);
    const last = probes[probes.length - 1];
    const subject = this.db.prepare('SELECT storage_ref_json FROM artifact_versions WHERE id = ?').get(d.subject_version_id) as { storage_ref_json: string } | undefined;
    const healthPath = readAppManifest(subject?.storage_ref_json ?? null)?.healthPath ?? null;
    return {
      id: d.id, projectId: d.project_id, subjectVersionId: d.subject_version_id, jobId: d.job_id, environment: d.environment,
      bindAddress: d.bind_address, hostPort: d.host_port,
      url: d.host_port !== null && LIVE.has(d.status) ? `http://${d.bind_address}:${d.host_port}${healthPath ?? '/'}` : null,
      healthPath, status: d.status, stopReason: d.stop_reason,
      lastProbe: last ? { at: last.at, status: last.status, ms: last.ms } : null, probes: probes.length,
      startedAt: d.started_at, stoppedAt: d.stopped_at, lifetimeMs: PREVIEW_LIFETIME_MS, endsAt: d.started_at + PREVIEW_LIFETIME_MS
    };
  }
}
