/**
 * Approvals (B2a A1, A2): a user's once-only consent, recorded in SQLite (schema v9 `approvals`), and the image builds
 * an image approval starts (`image_builds`). SQLite is the only authority: nothing here keeps state in memory that a
 * restart would need (constraint 9); the only in-memory value is a cache of each running build's last recorded
 * progress event, which a fresh process reads back from `job_events`.
 *
 * - A1 egress (dependency install). At the lease of an egress recipe the execution core calls `requestEgressTx` INSIDE
 *   its lease transaction: a pending approval (`egress.deps`) bound to the job, naming the registries the packages are
 *   expected from and the lockfile hash the install must match (`request_json`), with `request_sha256` = sha256 of the
 *   canonical `{ recipeId, recipeVersion, jobId, lockfileSha256, profile }`, expiring in 15 minutes. The core moves the
 *   job `leased -> running (phase approval) -> awaiting_approval` in the same transaction and sends nothing to the
 *   runner. A repository snapshot without a lockfile hash (`metadata.lockfile.sha256`) is refused (`lockfile_missing`):
 *   the job fails at lease, no approval is asked for. The consent text says exactly what is enforced: network access for
 *   this one install job, only through the Nexus egress proxy, to exactly the hosts of the recipe's allow-list (HTTPS,
 *   port 443; src/shared/nexus/egressPolicy.ts, the same list the proxy receives), with every other host, private and
 *   loopback addresses and this computer refused; install scripts disabled; packages matched against the lockfile hashes.
 * - A2 image preparation. `requestImage` (a user, owner of the platform) creates a pending `image.prepare` approval
 *   with the build context, the base digest, the estimated size and the free space now, and no job. It is refused
 *   before any row is written when the resource gate says no (`unavailable`, `setup:disk_low`, Docker missing or
 *   stopped), or while a build of the profile runs (`conflict`). A pending request for the profile is returned again.
 * - `respond(p, id, 'once' | 'deny')` is the only user-facing door. Only a stored USER principal answers (the system or
 *   an agent: `denied`, audited; the database refuses it too, tr_approvals_transition). In ONE transaction:
 *   egress `once` records the decision, consumes the approval for the job's CURRENT attempt and resumes the job
 *   (`awaiting_approval -> running` with the plan carrying this approval, sent after commit). When the scheduler's caps
 *   refuse the start right now the approval stays consumed and the job waits (`phase waiting:<x>`): the scheduler
 *   resumes it on a later tick (ExecutionService.resumeConsumed), and fails it `approval_stale` if it has not started
 *   within 15 minutes of the consent. `deny` fails the job (`denied`) and sends nothing. Image `once` consumes the
 *   approval and inserts the `image_builds` row (`running`) in the same transaction; `image.build.start` goes after
 *   commit. A second answer is `illegal_transition`; an answer after `expires_at` expires the approval (and fails its
 *   job) and is `illegal_transition` (reason `expired`).
 * - `expireDue(now)` moves pending approvals past `expires_at` to `expired`; an egress job waiting for one fails
 *   `denied` (`approval_expired`). The core calls it every 30 s while this service is its egress port.
 * - Image builds always end. A build ends `succeeded` / `failed` / `cancelled` on the runner's `image.build.done`;
 *   `interrupted` when the runner is lost (a runner-wide fault, the port leaving `ready` or being replaced:
 *   `onRunnerLost`, which also tells a still-attached runner `image.build.cancel`); `failed: timeout` after 10 minutes
 *   without progress or 180 minutes in all (the scheduler's pass, `tick`, which also tells the
 *   runner `image.build.cancel`); `cancelled` when the user cancels it (`cancelImageBuild`).
 * - `withdrawForJobTx` (cancel): a pending approval of the job becomes `withdrawn`.
 * - Secrets (constraint 6): `request_json` holds only main-derived values in fixed shapes (ids, enums, registry host
 *   names, hex digests); anything secret-shaped outside the typed digest fields refuses the request
 *   (`secret_in_request`). A build failure's text is stored redacted (redactSecretText). Views name no principal.
 * - Records (constraint 13): every write appends one activity row (`approval.request`, `approval.respond`,
 *   `approval.expire`, `approval.withdraw`, `image_build.start`, `image_build.finish`; digests nested under `sha256`
 *   keys so the redactor keeps them) and one `job_events` row (`approval` or `image_build`) in its transaction.
 */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ApprovalStatus, PlatformAction, Principal, ScopeRef } from '../../../shared/nexus/platform';
import type { RecipeDef } from '../../../shared/nexus/recipes';
import type { MainToRunner, RunnerToMain } from '../../../shared/nexus/runnerProtocol';
import type { SandboxProfileId } from '../../../shared/nexus/execution';
import type { AuthService } from '../auth/authService';
import { PrincipalResolver, requireStoredUser } from '../auth/principals';
import { appendActivityRow } from '../activity/writer';
import { containsSecret } from '../activity/redact';
import { canonicalJson } from '../db/canonical';
import { newId } from '../db/ids';
import { immediateTx } from '../db/tx';
import { PlatformError } from '../errors';
import { ProjectAccess } from '../project/projectAccess';
import { redactedErrorJson, storedWorkspace, validateKey } from '../jobs/jobService';
import { appendJobEventTx } from '../exec/events';
import { APPROVAL_STATUSES } from './approvalRules';
import { egressAllowFor, EGRESS_ALLOWLISTS } from '../../../shared/nexus/egressPolicy';

export const APPROVAL_TTL_MS = 15 * 60_000;
/** How often the execution core runs the expiry sweep and the image builds' pass. */
export const EXPIRY_SWEEP_MS = 30_000;
/** A running image build with no progress for this long is cancelled and failed (`timeout`). */
export const IMAGE_BUILD_INACTIVITY_MS = 10 * 60_000;
/** A running image build is cancelled and failed (`timeout`) after this long, whatever its progress. */
export const IMAGE_BUILD_MAX_MS = 180 * 60_000;
/** While progress keeps arriving in one phase, a progress event is written at least this often (the durable last progress). */
export const PROGRESS_EVENT_MS = 60_000;
export const MAX_EXPIRE_PER_SWEEP = 100;
export const DEFAULT_APPROVAL_LIST = 100;
export const MAX_APPROVAL_LIST = 500;
export type ImageProfileId = 'sde-node' | 'sde-python' | 'nexus-fwd';
export const IMAGE_PROFILES: readonly ImageProfileId[] = Object.freeze(['sde-node', 'sde-python', 'nexus-fwd'] as ImageProfileId[]);
/**
 * The hosts an approved install can reach, by sandbox profile: exactly the egress proxy's allow-list of the profile's
 * install recipe (src/shared/nexus/egressPolicy.ts; enforced since the B2a stabilization round, constraint 5).
 */
export const EGRESS_REGISTRIES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'sde-node': Object.freeze(EGRESS_ALLOWLISTS['sde.deps.node'].map((e) => e.host)),
  'sde-python': Object.freeze(EGRESS_ALLOWLISTS['sde.deps.python'].map((e) => e.host))
});
export type ApprovalDecision = 'once' | 'deny';

/** The build context of a profile image (B2a Task 12 provides it from infra/images). */
export interface ImageContext { contextSha256: string; baseDigest: string; estimatedBytes: number }

export type ImageBuildStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
/** One image build (schema v9 `image_builds`), as the service reports it. No principal id, no host path. */
export interface ImageBuildRecord {
  id: string; profileId: string; approvalId: string; status: ImageBuildStatus;
  contextSha256: string; baseDigest: string; imageId: string | null; sizeBytes: number | null;
  error: { code: string; message: string } | null; startedAt: number; finishedAt: number | null;
}

/** What the request of an approval shows (known fields only). */
export interface ApprovalRequestView {
  recipeId?: string; profile?: string; profileId?: string; registries?: string[]; lockfileSha256?: string;
  contextSha256?: string; baseDigest?: string; estimatedBytes?: number; freeBytesNow?: number | null;
}
export interface ApprovalView {
  id: string; projectId: string | null; jobId: string | null; reason: string; summary: string; status: ApprovalStatus;
  request: ApprovalRequestView; requestedAt: number; expiresAt: number; decidedAt: number | null; decision: ApprovalDecision | null;
  consumedAt: number | null; imageBuild: ImageBuildRecord | null;
}
export interface ApprovalFilter { projectId?: string; status?: ApprovalStatus; limit?: number }

/** What this service needs from the execution core (late-bound: the core is built after this service). */
export interface ApprovalExecPort {
  /** Inside the caller's transaction: resume a job whose approval was just consumed by its current attempt. */
  resumeApprovedTx(jobId: string, now: number): { send: () => void } | { wait: string } | { failed: string };
  /** Inside the caller's transaction: a job waiting for approval fails `denied` (its attempt first). */
  endAwaitingTx(jobId: string, error: { code: string; message: string }, now: number): void;
  setupAvailability(what: { imagePreparation: true }): { available: boolean; reason: string | null };
  health(): { disk: { freeBytes: number | null } };
  sendToRunner(msg: MainToRunner): boolean;
  /** The image facts changed (a build finished): judge the cached images again and ask the runner for a fresh probe. */
  refreshImages(): void;
}

export interface ApprovalDeps {
  auth: AuthService; now: () => number; log?: (line: string) => void;
  /** The build context of each profile image; null or a missing profile refuses image preparation (`unknown_profile`). */
  imageContext?: ((profileId: string) => ImageContext | null) | null;
}

interface ApprovalRow {
  id: string; project_id: string | null; job_id: string | null; session_id: string | null; reason: string; summary: string;
  request_json: string; request_sha256: string; status: ApprovalStatus; requested_by: string; on_behalf_of: string;
  requested_at: number; expires_at: number; decided_by: string | null; decided_at: number | null; decision: ApprovalDecision | null;
  consumed_at: number | null; consumed_by_job_id: string | null; consumed_by_attempt_n: number | null; status_changed_at: number;
}
interface ImageBuildRow {
  id: string; profile_id: string; approval_id: string; status: ImageBuildStatus; context_sha256: string; base_digest: string;
  image_id: string | null; size_bytes: number | null; log_path: string | null; error_json: string | null; requested_by: string;
  started_at: number; finished_at: number | null;
}
interface JobLite { id: string; project_id: string; workspace_id: string; participation_id: string | null; state: string; on_behalf_of: string }

const PLATFORM: ScopeRef = { type: 'platform' };
const SHA_RE = /^[0-9a-f]{64}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const HOST_RE = /^[a-z0-9][a-z0-9.-]{0,252}$/;
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const parse = (t: string | null): unknown => { if (t === null) return null; try { return JSON.parse(t) as unknown; } catch { return null; } };
const invalid = (reason: string, message: string): PlatformError => new PlatformError('invalid', message, { reason });
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
/** A `sha256:<hex>` digest as `{ sha256: <hex> }` (the activity redactor keeps a hex digest only under a `sha256` key). */
const digestDetail = (d: string | null | undefined): { sha256: string } | null => (typeof d === 'string' && DIGEST_RE.test(d) ? { sha256: d.slice(7) } : null);

// Only a stored, enabled USER answers an approval, asks for an image or stops a dev deployment: requireStoredUser lives
// beside the principal resolver (src/main/nexus/auth/principals.ts) since fix round 1 of Task 13; re-exported here.
export { requireStoredUser };

/**
 * Whether a request holds anything secret-shaped. The typed digest fields must have their exact shape (else the
 * request is refused as well) and are left out of the scan: a hex digest is evidence, not a secret.
 */
export function requestHoldsSecret(request: Record<string, unknown>): boolean {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(request)) {
    if (k === 'lockfileSha256' || k === 'contextSha256') { if (typeof v !== 'string' || !SHA_RE.test(v)) return true; continue; }
    if (k === 'baseDigest') { if (typeof v !== 'string' || !DIGEST_RE.test(v)) return true; continue; }
    rest[k] = v;
  }
  return containsSecret(rest);
}

/** The latest succeeded image build of a profile (ix_image_builds_profile), or null. */
export function latestSucceededBuild(db: Database.Database, profileId: string): ImageBuildRecord | null {
  const r = db.prepare(`SELECT * FROM image_builds WHERE profile_id = ? AND status = 'succeeded' ORDER BY started_at DESC, id DESC LIMIT 1`)
    .get(profileId) as ImageBuildRow | undefined;
  return r ? toImageBuild(r) : null;
}

function toImageBuild(r: ImageBuildRow): ImageBuildRecord {
  const e = parse(r.error_json);
  return {
    id: r.id, profileId: r.profile_id, approvalId: r.approval_id, status: r.status, contextSha256: r.context_sha256, baseDigest: r.base_digest,
    imageId: r.image_id, sizeBytes: r.size_bytes,
    error: isObj(e) && typeof e.code === 'string' && typeof e.message === 'string' ? { code: e.code, message: e.message } : null,
    startedAt: r.started_at, finishedAt: r.finished_at
  };
}

/**
 * Inside the caller's transaction (a cancel): every pending approval of the job becomes `withdrawn`, with one activity
 * row and one event each. Returns how many were withdrawn.
 */
export function withdrawPendingApprovalsTx(db: Database.Database, p: Principal, j: { id: string; project_id: string; workspace_id: string;
  on_behalf_of: string }, now: number, reason = 'job_cancelled'): number {
  if (!db.inTransaction) throw new PlatformError('platform_unavailable', 'withdrawPendingApprovalsTx needs an open transaction');
  const pending = db.prepare("SELECT id FROM approvals WHERE job_id = ? AND status = 'pending'").all(j.id) as { id: string }[];
  for (const ap of pending) {
    db.prepare("UPDATE approvals SET status = 'withdrawn', status_changed_at = ? WHERE id = ? AND status = 'pending'").run(now, ap.id);
    appendActivityRow(db, { actorKind: p.kind, actorId: p.id, onBehalfOf: j.on_behalf_of, jobId: j.id, projectId: j.project_id,
      workspaceId: j.workspace_id, entityType: 'approval', entityId: ap.id, action: 'approval.withdraw', status: 'succeeded',
      details: { reason } }, now);
    appendJobEventTx(db, { type: 'approval', summary: 'approval withdrawn: the job was cancelled', projectId: j.project_id, jobId: j.id,
      approvalId: ap.id, data: { status: 'withdrawn' } }, now);
  }
  return pending.length;
}

export class ApprovalService {
  private readonly principals: PrincipalResolver;
  private readonly access: ProjectAccess;
  private readonly log: (line: string) => void;
  private execPort: ApprovalExecPort | null = null;
  /** The last recorded progress per running build: a cache of its newest `image_build` event (not authoritative). */
  private readonly buildProgress = new Map<string, { phase: string | null; at: number }>();

  constructor(private readonly db: Database.Database, private readonly deps: ApprovalDeps) {
    this.principals = new PrincipalResolver(db);
    this.access = new ProjectAccess(db, { auth: deps.auth });
    this.log = deps.log ?? (() => {});
  }

  /** Late binding of the execution core (built after this service). */
  bindExecution(exec: ApprovalExecPort | null): void { this.execPort = exec; }

  private exec(): ApprovalExecPort {
    if (!this.execPort) throw new PlatformError('platform_unavailable', 'approvals need the execution core', { reason: 'not_enabled' });
    return this.execPort;
  }

  private system(): Principal { return this.principals.system(); }

  private row(id: string): ApprovalRow | null {
    return (this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow | undefined) ?? null;
  }

  private job(id: string): JobLite | null {
    return (this.db.prepare('SELECT id, project_id, workspace_id, participation_id, state, on_behalf_of FROM jobs WHERE id = ?').get(id) as JobLite | undefined) ?? null;
  }

  private requireUser(p: Principal, action: PlatformAction): void {
    requireStoredUser(this.principals, this.deps.auth, p, action, 'approval', 'only a user answers an approval');
  }

  /** Authorizes an action on an approval: in its project (with the job's stored workspace), or platform-wide (images). */
  private authorize(p: Principal, a: ApprovalRow, action: PlatformAction): void {
    if (a.project_id === null) { this.deps.auth.require(p, action, PLATFORM, { entityType: 'approval', entityId: a.id }); return; }
    const j = a.job_id ? this.job(a.job_id) : null;
    const ws = j ? storedWorkspace(this.db, j.participation_id) : undefined;
    this.access.require(p, a.project_id, action, ws ? { workspaceId: ws } : undefined);
  }

  // ---------- A1: egress ----------

  /**
   * @internal The execution core's lease transaction (EgressApprovalPort): the pending approval of an egress job's
   * attempt. Reads the profile and lockfile hash from the attempt's environment (what the lease recorded).
   * Throws PlatformError 'invalid' (`lockfile_missing`, `no_registry`, `secret_in_request`, `bad_attempt`); the core
   * then fails the job at lease and asks for nothing.
   */
  requestEgressTx(job: { id: string; projectId: string; onBehalfOf: string }, attempt: { id: string; n: number }, recipe: RecipeDef, now: number): string {
    if (!this.db.inTransaction) throw new PlatformError('platform_unavailable', 'requestEgressTx runs inside the lease transaction');
    if (recipe.network !== 'egress-approved') throw invalid('not_egress', 'only an egress recipe asks for network access');
    const a = this.db.prepare('SELECT job_id, n, environment_json FROM job_attempts WHERE id = ?').get(attempt.id) as
      { job_id: string; n: number; environment_json: string | null } | undefined;
    const j = this.job(job.id);
    if (!a || !j || a.job_id !== job.id || a.n !== attempt.n || j.project_id !== job.projectId) throw invalid('bad_attempt', 'the attempt is not this job\'s');
    const env = parse(a.environment_json);
    const profile = isObj(env) && typeof env.profile === 'string' ? env.profile : null;
    const lock = isObj(env) && typeof env.lockfileSha256 === 'string' ? env.lockfileSha256 : null;
    if (!lock || !SHA_RE.test(lock)) {
      throw invalid('lockfile_missing', 'the repository snapshot records no lockfile hash; dependencies are installed only from a locked list');
    }
    // The hosts the proxy will allow for THIS recipe (the same list main writes into the proxy's environment).
    const allow = egressAllowFor(recipe.id);
    const registries = profile && allow && recipe.profiles.includes(profile as SandboxProfileId) ? allow.map((e) => e.host) : undefined;
    if (!profile || !registries || registries.length === 0 || !registries.every((r) => HOST_RE.test(r))) {
      throw invalid('no_registry', 'no package registry is known for this profile');
    }
    const binding = { recipeId: recipe.id, recipeVersion: recipe.version, jobId: job.id, lockfileSha256: lock, profile };
    const request = { ...binding, registries: [...registries] };
    if (requestHoldsSecret(request)) throw invalid('secret_in_request', 'the approval request would hold a secret-shaped value');
    const id = newId(now);
    const requestSha = sha256(canonicalJson(binding));
    const what = profile === 'sde-python' ? 'Python' : 'Node';
    // Exactly what is enforced (M8): one job; only the allow-listed hosts, over HTTPS, through the Nexus egress proxy (the
    // install container itself has no route out); no install scripts; packages matched against the lockfile hashes.
    const hosts = allow!.map((e) => `${e.host} (HTTPS, port ${e.port})`).join(' and ');
    const summary = `Network access for this one ${what} dependency install job, through the Nexus egress proxy. Only ${hosts} `
      + `can be reached; every other host, private and loopback addresses, cloud metadata and this computer are refused. `
      + `Install scripts are disabled and packages must match the lockfile hashes (${lock.slice(0, 12)}).`;
    this.db.prepare(`INSERT INTO approvals (id, project_id, job_id, session_id, reason, summary, request_json, request_sha256, status,
        requested_by, on_behalf_of, requested_at, expires_at, status_changed_at)
      VALUES (?, ?, ?, NULL, 'egress.deps', ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`)
      .run(id, job.projectId, job.id, summary, JSON.stringify(request), requestSha, this.system().id, job.onBehalfOf,
        now, now + APPROVAL_TTL_MS, now);
    appendActivityRow(this.db, { actorKind: 'system', actorId: this.system().id, onBehalfOf: job.onBehalfOf, jobId: job.id, attemptN: attempt.n,
      projectId: job.projectId, workspaceId: j.workspace_id, entityType: 'approval', entityId: id, action: 'approval.request', status: 'succeeded',
      details: { reason: 'egress.deps', recipeId: recipe.id, recipeVersion: recipe.version, profile, registries: [...registries],
        lockfile: { sha256: lock }, request: { sha256: requestSha }, expiresAt: now + APPROVAL_TTL_MS } }, now);
    // The core writes the `approval` job event of this request in the same transaction.
    return id;
  }

  // ---------- A2: image preparation ----------

  /**
   * A user asks to prepare a profile image. Refused before any row when the gate says no (`unavailable` with its
   * `setup:*` reason), while a build of the profile runs (`conflict`, `build_running`), or for a profile without a
   * build context (`invalid`, `unknown_profile`). A pending request for the profile is returned (`created: false`).
   */
  requestImage(p: Principal, profileId: string, intentId: string): { approval: ApprovalView; created: boolean } {
    this.requireUser(p, 'approval.respond');
    this.deps.auth.require(p, 'approval.respond', PLATFORM, { entityType: 'approval' });
    validateKey(intentId);
    if (typeof profileId !== 'string' || !(IMAGE_PROFILES as readonly string[]).includes(profileId)) throw invalid('unknown_profile', 'unknown image profile');
    const ctx = this.deps.imageContext ? this.deps.imageContext(profileId) : null;
    if (!ctx) throw invalid('unknown_profile', 'this build has no image context for the profile');
    if (typeof ctx.contextSha256 !== 'string' || !SHA_RE.test(ctx.contextSha256) || typeof ctx.baseDigest !== 'string' || !DIGEST_RE.test(ctx.baseDigest)
      || !Number.isSafeInteger(ctx.estimatedBytes) || ctx.estimatedBytes < 0) {
      throw invalid('bad_image_context', 'the image context is not usable');
    }
    const exec = this.exec();
    const setup = exec.setupAvailability({ imagePreparation: true });
    if (!setup.available) {
      throw new PlatformError('unavailable', `image preparation is not available now (${setup.reason ?? 'setup'})`, { reason: setup.reason ?? 'setup:runner_unavailable' });
    }
    const free = exec.health().disk.freeBytes;
    const freeBytesNow = typeof free === 'number' && Number.isSafeInteger(free) && free >= 0 ? free : null;
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      if (this.runningBuild(profileId)) throw new PlatformError('conflict', 'an image build of this profile is running', { reason: 'build_running' });
      const pending = this.db.prepare(`SELECT * FROM approvals WHERE reason = 'image.prepare' AND status = 'pending' AND expires_at > ?
        AND json_extract(request_json, '$.profileId') = ? ORDER BY requested_at DESC LIMIT 1`).get(now, profileId) as ApprovalRow | undefined;
      if (pending) return { approval: this.view(pending), created: false };
      const binding = { profileId, contextSha256: ctx.contextSha256, baseDigest: ctx.baseDigest, estimatedBytes: ctx.estimatedBytes };
      const request = { ...binding, freeBytesNow };
      if (requestHoldsSecret(request)) throw invalid('secret_in_request', 'the approval request would hold a secret-shaped value');
      const id = newId(now);
      const requestSha = sha256(canonicalJson(binding));
      const gib = (ctx.estimatedBytes / 2 ** 30).toFixed(1);
      const summary = `Prepare the ${profileId} sandbox image once: Docker downloads its pinned base image and installs its pinned packages `
        + `(about ${gib} GiB). Network access for this build is not limited to particular hosts in this release.`;
      this.db.prepare(`INSERT INTO approvals (id, project_id, job_id, session_id, reason, summary, request_json, request_sha256, status,
          requested_by, on_behalf_of, requested_at, expires_at, status_changed_at)
        VALUES (?, NULL, NULL, NULL, 'image.prepare', ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`)
        .run(id, summary, JSON.stringify(request), requestSha, p.id, p.id, now, now + APPROVAL_TTL_MS, now);
      appendActivityRow(this.db, { actorKind: p.kind, actorId: p.id, onBehalfOf: p.id, entityType: 'approval', entityId: id, action: 'approval.request',
        status: 'succeeded', details: { reason: 'image.prepare', profileId, context: { sha256: ctx.contextSha256 }, base: digestDetail(ctx.baseDigest),
          estimatedBytes: ctx.estimatedBytes, freeBytesNow, request: { sha256: requestSha }, expiresAt: now + APPROVAL_TTL_MS } }, now);
      appendJobEventTx(this.db, { type: 'approval', summary: `image preparation of ${profileId} waits for approval`, projectId: null, approvalId: id,
        data: { status: 'pending', profileId } }, now);
      return { approval: this.view(this.row(id)!), created: true };
    });
  }

  private runningBuild(profileId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM image_builds WHERE profile_id = ? AND status = 'running' LIMIT 1").get(profileId);
  }

  // ---------- the user's answer ----------

  /** The user-facing door (see the module header). Returns the approval as it stands after the answer. */
  respond(p: Principal, approvalId: string, decision: ApprovalDecision): ApprovalView {
    if (decision !== 'once' && decision !== 'deny') throw invalid('bad_decision', "the answer is 'once' or 'deny'");
    this.requireUser(p, 'approval.respond');
    const found = isStr(approvalId) ? this.row(approvalId) : null;
    if (!found) {
      this.deps.auth.require(p, 'approval.respond', PLATFORM, { entityType: 'approval' });
      throw new PlatformError('not_found', 'approval not found');
    }
    this.authorize(p, found, 'approval.respond');
    const exec = this.exec();
    if (found.reason === 'image.prepare' && decision === 'once' && found.status === 'pending') {
      const setup = exec.setupAvailability({ imagePreparation: true });
      if (!setup.available) {
        throw new PlatformError('unavailable', `image preparation is not available now (${setup.reason ?? 'setup'})`, { reason: setup.reason ?? 'setup:runner_unavailable' });
      }
    }
    const now = this.deps.now();
    const out = immediateTx(this.db, (): { expired: boolean; after: (() => void) | null } => {
      const a = this.row(found.id)!;
      if (a.status !== 'pending') throw new PlatformError('illegal_transition', `the approval is ${a.status}`, { from: a.status });
      if (a.expires_at <= now) { this.expireTx(a, now); return { expired: true, after: null }; }
      if (a.reason === 'egress.deps' || a.reason === 'egress.weights') return { expired: false, after: this.answerEgressTx(p, a, decision, now) };
      if (a.reason === 'image.prepare') return { expired: false, after: this.answerImageTx(p, a, decision, now) };
      if (a.reason === 'repo.write_refs') { this.answerRepoWritesTx(p, a, decision, now); return { expired: false, after: null }; }
      throw invalid('reason_not_in_this_build', 'this approval is not answered in this build');
    });
    if (out.expired) throw new PlatformError('illegal_transition', 'the approval expired before it was answered', { from: 'expired', reason: 'expired' });
    // After commit: the plan (egress) or the build request (image) goes to the runner.
    if (out.after) out.after();
    return this.view(this.row(found.id)!);
  }

  private decideTx(p: Principal, a: ApprovalRow, decision: ApprovalDecision, now: number, consumedBy: { jobId: string | null; n: number | null } | null): void {
    const r = decision === 'deny'
      ? this.db.prepare(`UPDATE approvals SET status = 'denied', decided_by = ?, decided_at = ?, decision = 'deny', status_changed_at = ?
          WHERE id = ? AND status = 'pending'`).run(p.id, now, now, a.id)
      : this.db.prepare(`UPDATE approvals SET status = 'approved', decided_by = ?, decided_at = ?, decision = 'once', consumed_at = ?,
          consumed_by_job_id = ?, consumed_by_attempt_n = ?, status_changed_at = ? WHERE id = ? AND status = 'pending'`)
        .run(p.id, now, now, consumedBy?.jobId ?? null, consumedBy?.n ?? null, now, a.id);
    if (r.changes !== 1) throw new PlatformError('conflict', 'the approval changed before the answer', { approvalId: a.id });
  }

  /** Egress: once -> consume for the current attempt and resume the job; deny -> the job fails `denied`. */
  private answerEgressTx(p: Principal, a: ApprovalRow, decision: ApprovalDecision, now: number): (() => void) | null {
    const exec = this.exec();
    const j = a.job_id ? this.job(a.job_id) : null;
    const live = j ? this.db.prepare(`SELECT n FROM job_attempts WHERE job_id = ? AND state IN ('starting','running')`).get(j.id) as { n: number } | undefined : undefined;
    const current = j ? (this.db.prepare('SELECT attempts FROM jobs WHERE id = ?').get(j.id) as { attempts: number }).attempts : null;
    if (!j || j.state !== 'awaiting_approval' || !live || live.n !== current) {
      throw new PlatformError('illegal_transition', 'the job is not waiting for this approval', { from: j?.state ?? 'missing' });
    }
    this.decideTx(p, a, decision, now, decision === 'once' ? { jobId: j.id, n: live.n } : null);
    appendJobEventTx(this.db, { type: 'approval', summary: decision === 'once' ? 'network access approved once' : 'network access denied',
      projectId: j.project_id, jobId: j.id, attemptN: live.n, approvalId: a.id, data: { status: decision === 'once' ? 'approved' : 'denied' } }, now);
    let effect: string;
    let after: (() => void) | null = null;
    if (decision === 'deny') {
      exec.endAwaitingTx(j.id, { code: 'approval_denied', message: 'network access was denied' }, now);
      effect = 'job_failed_denied';
    } else {
      const r = exec.resumeApprovedTx(j.id, now);
      if ('send' in r) { after = r.send; effect = 'started'; } else if ('wait' in r) effect = r.wait; else effect = `failed:${r.failed}`;
    }
    appendActivityRow(this.db, { actorKind: p.kind, actorId: p.id, onBehalfOf: j.on_behalf_of, jobId: j.id, attemptN: live.n, projectId: j.project_id,
      workspaceId: j.workspace_id, entityType: 'approval', entityId: a.id, action: 'approval.respond', status: 'succeeded',
      details: { reason: a.reason, decision, consumedBy: decision === 'once' ? { jobId: j.id, attemptN: live.n } : null, effect } }, now);
    return after;
  }

  /**
   * A3, repository writes (B2b Task 7, D-B6): once -> approved and consumed for the PROJECT (no job: it is asked once per
   * project, WorktreeService then queues the worktree job); deny -> denied (the turn that asked ends; nothing was written).
   */
  private answerRepoWritesTx(p: Principal, a: ApprovalRow, decision: ApprovalDecision, now: number): void {
    if (a.project_id === null || a.job_id !== null) throw invalid('bad_request', 'the repository write request is not usable');
    this.decideTx(p, a, decision, now, decision === 'once' ? { jobId: null, n: null } : null);
    appendJobEventTx(this.db, { type: 'approval', summary: decision === 'once' ? 'repository writes approved for this project' : 'repository writes denied',
      projectId: a.project_id, approvalId: a.id, data: { status: decision === 'once' ? 'approved' : 'denied', reason: a.reason } }, now);
    appendActivityRow(this.db, { actorKind: p.kind, actorId: p.id, onBehalfOf: a.on_behalf_of, sessionId: a.session_id, projectId: a.project_id,
      entityType: 'approval', entityId: a.id, action: 'approval.respond', status: 'succeeded', details: { reason: a.reason, decision } }, now);
  }

  /** Image: once -> consume and insert the running build (sent after commit); deny -> denied. */
  private answerImageTx(p: Principal, a: ApprovalRow, decision: ApprovalDecision, now: number): (() => void) | null {
    const req = parse(a.request_json);
    const profileId = isObj(req) && typeof req.profileId === 'string' ? req.profileId : null;
    const contextSha256 = isObj(req) && typeof req.contextSha256 === 'string' ? req.contextSha256 : null;
    const baseDigest = isObj(req) && typeof req.baseDigest === 'string' ? req.baseDigest : null;
    if (!profileId || !contextSha256 || !baseDigest) throw invalid('bad_request', 'the image request is not usable');
    if (decision === 'once' && this.runningBuild(profileId)) throw new PlatformError('conflict', 'an image build of this profile is running', { reason: 'build_running' });
    this.decideTx(p, a, decision, now, decision === 'once' ? { jobId: null, n: null } : null);
    appendJobEventTx(this.db, { type: 'approval', summary: decision === 'once' ? `image preparation of ${profileId} approved once`
      : `image preparation of ${profileId} denied`, projectId: null, approvalId: a.id, data: { status: decision === 'once' ? 'approved' : 'denied' } }, now);
    const buildId = decision === 'once' ? newId(now) : null;
    appendActivityRow(this.db, { actorKind: p.kind, actorId: p.id, onBehalfOf: a.on_behalf_of, entityType: 'approval', entityId: a.id,
      action: 'approval.respond', status: 'succeeded', details: { reason: a.reason, decision, profileId, buildId } }, now);
    if (!buildId) return null;
    this.db.prepare(`INSERT INTO image_builds (id, profile_id, approval_id, status, context_sha256, base_digest, log_path, requested_by, started_at)
      VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)`).run(buildId, profileId, a.id, contextSha256, baseDigest, `logs/images/${buildId}.log`, a.on_behalf_of, now);
    appendActivityRow(this.db, { actorKind: p.kind, actorId: p.id, onBehalfOf: a.on_behalf_of, entityType: 'image_build', entityId: buildId,
      action: 'image_build.start', status: 'started', details: { buildId, profileId, approvalId: a.id, context: { sha256: contextSha256 },
        base: digestDetail(baseDigest) } }, now);
    appendJobEventTx(this.db, { type: 'image_build', summary: `image build of ${profileId} started`, projectId: null, imageBuildId: buildId,
      approvalId: a.id, data: { status: 'running', profileId } }, now);
    const exec = this.exec();
    return () => {
      const sent = exec.sendToRunner({ op: 'image.build.start', buildId, profile: profileId as SandboxProfileId, approvalId: a.id, contextSha256 });
      if (!sent) this.finishBuild(buildId, 'failed', { error: { code: 'not_sent', message: 'the build request did not reach the runner' } });
    };
  }

  // ---------- expiry and withdrawal ----------

  /** Inside the caller's transaction: a pending approval past its time becomes `expired`; its waiting job fails `denied`. */
  private expireTx(a: ApprovalRow, now: number): void {
    const r = this.db.prepare("UPDATE approvals SET status = 'expired', status_changed_at = ? WHERE id = ? AND status = 'pending'").run(now, a.id);
    if (r.changes !== 1) return;
    const j = a.job_id ? this.job(a.job_id) : null;
    appendJobEventTx(this.db, { type: 'approval', summary: 'approval expired: it was not answered in 15 minutes', projectId: a.project_id,
      jobId: j?.id ?? null, approvalId: a.id, data: { status: 'expired' } }, now);
    const failsJob = !!j && j.state === 'awaiting_approval';
    if (failsJob) this.exec().endAwaitingTx(j!.id, { code: 'approval_expired', message: 'the approval was not answered in time' }, now);
    appendActivityRow(this.db, { actorKind: 'system', actorId: this.system().id, onBehalfOf: a.on_behalf_of, jobId: j?.id ?? null,
      projectId: a.project_id, workspaceId: j?.workspace_id ?? null, entityType: 'approval', entityId: a.id, action: 'approval.expire',
      status: 'succeeded', details: { approvalId: a.id, reason: a.reason, expiredAt: a.expires_at,
        job: failsJob ? { outcome: 'denied', error: 'approval_expired' } : null } }, now);
  }

  /** Expires every pending approval past `expires_at` (at most MAX_EXPIRE_PER_SWEEP per call). Returns how many. Never throws. */
  expireDue(now: number): number {
    let n = 0;
    try {
      const due = this.db.prepare(`SELECT * FROM approvals WHERE status = 'pending' AND expires_at <= ? ORDER BY expires_at, id LIMIT ?`)
        .all(now, MAX_EXPIRE_PER_SWEEP) as ApprovalRow[];
      for (const a of due) {
        try {
          immediateTx(this.db, () => {
            const cur = this.row(a.id);
            if (cur && cur.status === 'pending' && cur.expires_at <= now) { this.expireTx(cur, now); n++; }
          });
        } catch (e) {
          this.log(`[nexus] approvals: expiry not recorded: ${e instanceof PlatformError ? e.code : (e as Error)?.name ?? 'error'}`);
        }
      }
    } catch (e) {
      this.log(`[nexus] approvals: expiry sweep stopped: ${(e as Error)?.name ?? 'error'}`);
    }
    return n;
  }

  /** @internal Inside the caller's transaction (a cancel): the job's pending approvals become `withdrawn`. */
  withdrawForJobTx(p: Principal, jobId: string, now: number, reason = 'job_cancelled'): number {
    const j = this.job(jobId);
    if (!j) return 0;
    return withdrawPendingApprovalsTx(this.db, p, j, now, reason);
  }

  // ---------- image builds (runner reports, the scheduler's pass, the user's cancel) ----------

  /**
   * `image.build.progress`: an event per new phase of a running build, and at least one per PROGRESS_EVENT_MS while
   * progress keeps arriving in the same phase, so the build's last progress is durable (the inactivity deadline reads it).
   */
  onImageBuildProgress(m: Extract<RunnerToMain, { op: 'image.build.progress' }>): void {
    const b = this.db.prepare('SELECT * FROM image_builds WHERE id = ?').get(m.buildId) as ImageBuildRow | undefined;
    if (!b || b.status !== 'running') { this.log('[nexus] approvals: dropped image.build.progress for a build that is not running'); return; }
    const phase = m.phase.slice(0, 64);
    const now = this.deps.now();
    const last = this.lastProgress(b);
    if (last.phase === phase && now - last.at < PROGRESS_EVENT_MS) return;
    immediateTx(this.db, () => appendJobEventTx(this.db, { type: 'image_build', summary: `image build of ${b.profile_id}: ${phase}`, projectId: null,
      imageBuildId: b.id, approvalId: b.approval_id, data: { phase, bytes: m.bytes ?? null } }, now));
    this.buildProgress.set(b.id, { phase, at: now });
  }

  /**
   * The last recorded progress of a running build: its newest `image_build` event (the start event at the latest).
   * Kept in memory only as a cache of that row; a fresh process reads it back from `job_events`.
   */
  private lastProgress(b: ImageBuildRow): { phase: string | null; at: number } {
    const cached = this.buildProgress.get(b.id);
    if (cached) return cached;
    const r = this.db.prepare("SELECT ts, data_json FROM job_events WHERE image_build_id = ? AND type = 'image_build' ORDER BY seq DESC LIMIT 1")
      .get(b.id) as { ts: number; data_json: string } | undefined;
    const data = parse(r?.data_json ?? null);
    const out = { phase: isObj(data) && typeof data.phase === 'string' ? data.phase : null, at: Math.max(r?.ts ?? b.started_at, b.started_at) };
    this.buildProgress.set(b.id, out);
    return out;
  }

  /** `image.build.done`: the running build ends succeeded (with its image id and size), failed (error stored redacted) or cancelled. */
  onImageBuildDone(m: Extract<RunnerToMain, { op: 'image.build.done' }>): void {
    const b = this.db.prepare('SELECT * FROM image_builds WHERE id = ?').get(m.buildId) as ImageBuildRow | undefined;
    if (!b || b.status !== 'running') { this.log('[nexus] approvals: dropped image.build.done for a build that is not running'); return; }
    if (m.outcome === 'succeeded') this.finishBuild(b.id, 'succeeded', { imageId: m.imageId, sizeBytes: m.sizeBytes });
    else if (m.outcome === 'failed') this.finishBuild(b.id, 'failed', { error: { code: 'build_failed', message: m.error ?? 'the image build failed' } });
    else this.finishBuild(b.id, 'cancelled', { error: { code: 'cancelled', message: 'the image build was cancelled' } });
  }

  /**
   * The runner is lost (a runner-wide fault, the port left `ready` or was replaced): a `docker build` it ran cannot
   * report, so every running build ends `interrupted` in one transaction. A port that is still attached is then told
   * `image.build.cancel` for each (best effort), so an interrupted build never keeps running beside a new one of its
   * profile. Returns how many. Never throws.
   */
  onRunnerLost(): number {
    const now = this.deps.now();
    let ids: string[] = [];
    try {
      ids = immediateTx(this.db, () => {
        const rows = this.db.prepare("SELECT * FROM image_builds WHERE status = 'running' ORDER BY started_at, id").all() as ImageBuildRow[];
        for (const b of rows) this.finishBuildTx(b, 'interrupted', { error: { code: 'runner_lost', message: 'the runner stopped while the image was being built' } }, now);
        return rows.map((b) => b.id);
      });
    } catch (e) {
      this.log(`[nexus] approvals: interrupted builds not recorded: ${e instanceof PlatformError ? e.code : (e as Error)?.name ?? 'error'}`);
      return 0;
    }
    for (const id of ids) this.sendBuildCancel(id);
    this.afterBuildsEnded(ids);
    return ids.length;
  }

  /**
   * The scheduler's pass: a running build with no progress for IMAGE_BUILD_INACTIVITY_MS, or running for
   * IMAGE_BUILD_MAX_MS whatever its progress, is cancelled at the runner and fails `timeout`. Never throws.
   */
  tick(now: number): void {
    let ids: string[] = [];
    try {
      ids = immediateTx(this.db, () => {
        const rows = this.db.prepare("SELECT * FROM image_builds WHERE status = 'running' ORDER BY started_at, id").all() as ImageBuildRow[];
        const ended: string[] = [];
        for (const b of rows) {
          const message = now - b.started_at >= IMAGE_BUILD_MAX_MS ? 'the image build ran longer than 180 minutes'
            : now - this.lastProgress(b).at >= IMAGE_BUILD_INACTIVITY_MS ? 'the image build reported no progress for 10 minutes' : null;
          if (!message) continue;
          this.finishBuildTx(b, 'failed', { error: { code: 'timeout', message } }, now);
          ended.push(b.id);
        }
        return ended;
      });
    } catch (e) {
      this.log(`[nexus] approvals: image build deadline not applied: ${e instanceof PlatformError ? e.code : (e as Error)?.name ?? 'error'}`);
      return;
    }
    for (const id of ids) this.sendBuildCancel(id);
    this.afterBuildsEnded(ids);
  }

  /** A user (owner) cancels a running build: `cancelled` now, and the runner is told `image.build.cancel`. */
  cancelImageBuild(p: Principal, buildId: string): ImageBuildRecord {
    requireStoredUser(this.principals, this.deps.auth, p, 'approval.respond', 'image_build', 'only a user cancels an image build');
    this.deps.auth.require(p, 'approval.respond', PLATFORM, { entityType: 'image_build' });
    const b = isStr(buildId) ? this.db.prepare('SELECT * FROM image_builds WHERE id = ?').get(buildId) as ImageBuildRow | undefined : undefined;
    if (!b) throw new PlatformError('not_found', 'image build not found');
    const now = this.deps.now();
    immediateTx(this.db, () => {
      const cur = this.db.prepare('SELECT * FROM image_builds WHERE id = ?').get(b.id) as ImageBuildRow;
      if (cur.status !== 'running') throw new PlatformError('illegal_transition', `a ${cur.status} image build cannot be cancelled`, { from: cur.status });
      this.finishBuildTx(cur, 'cancelled', { error: { code: 'cancelled', message: 'cancelled by the user' } }, now, p);
    });
    this.sendBuildCancel(b.id);
    this.afterBuildsEnded([b.id]);
    return toImageBuild(this.db.prepare('SELECT * FROM image_builds WHERE id = ?').get(b.id) as ImageBuildRow);
  }

  private sendBuildCancel(buildId: string): void {
    try { this.execPort?.sendToRunner({ op: 'image.build.cancel', buildId }); } catch { /* the runner is gone; nothing more to stop */ }
  }

  private afterBuildsEnded(ids: readonly string[]): void {
    if (ids.length === 0) return;
    for (const id of ids) this.buildProgress.delete(id);
    try { this.execPort?.refreshImages(); } catch { /* the next probe judges the images again */ }
  }

  private finishBuild(buildId: string, status: 'succeeded' | 'failed' | 'cancelled',
    o: { imageId?: string; sizeBytes?: number; error?: { code: string; message: string } }): void {
    const now = this.deps.now();
    try {
      immediateTx(this.db, () => {
        const b = this.db.prepare('SELECT * FROM image_builds WHERE id = ?').get(buildId) as ImageBuildRow | undefined;
        if (b && b.status === 'running') this.finishBuildTx(b, status, o, now);
      });
    } catch (e) {
      this.log(`[nexus] approvals: image build end not recorded: ${e instanceof PlatformError ? e.code : (e as Error)?.name ?? 'error'}`);
      return;
    }
    this.afterBuildsEnded([buildId]);
  }

  /** Inside a transaction: a running build ends, with its activity row and event. */
  private finishBuildTx(b: ImageBuildRow, status: Exclude<ImageBuildStatus, 'running'>,
    o: { imageId?: string; sizeBytes?: number; error?: { code: string; message: string } }, now: number, by?: Principal): void {
    const errorJson = o.error ? redactedErrorJson(o.error) : null;
    const ok = status === 'succeeded';
    const r = this.db.prepare(`UPDATE image_builds SET status = ?, image_id = ?, size_bytes = ?, error_json = ?, finished_at = ? WHERE id = ? AND status = 'running'`)
      .run(status, ok ? o.imageId ?? null : null, ok ? o.sizeBytes ?? null : null, errorJson, now, b.id);
    if (r.changes !== 1) return;
    const code = o.error?.code ?? null;
    const actor = by ?? this.system();
    appendActivityRow(this.db, { actorKind: actor.kind, actorId: actor.id, onBehalfOf: b.requested_by, entityType: 'image_build', entityId: b.id,
      action: 'image_build.finish', status: ok ? 'succeeded' : status === 'cancelled' ? 'cancelled' : 'failed',
      details: { buildId: b.id, profileId: b.profile_id, status, image: ok ? digestDetail(o.imageId) : null, sizeBytes: ok ? o.sizeBytes ?? null : null,
        error: code, durationMs: Math.max(0, now - b.started_at) } }, now);
    appendJobEventTx(this.db, { type: 'image_build', summary: `image build of ${b.profile_id} ${status}`, projectId: null, imageBuildId: b.id,
      approvalId: b.approval_id, data: { status, error: code, sizeBytes: ok ? o.sizeBytes ?? null : null } }, now);
  }

  // ---------- reads ----------

  /** Approvals the caller may read, newest first: one project's (`approval.read` there) or every one (platform-wide). */
  list(p: Principal, f: ApprovalFilter = {}): { approvals: ApprovalView[]; truncated: boolean } {
    if (!isObj(f)) throw new PlatformError('invalid', 'filter must be an object');
    const limit = f.limit === undefined ? DEFAULT_APPROVAL_LIST : f.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_APPROVAL_LIST) {
      throw new PlatformError('invalid', `limit must be 1 to ${MAX_APPROVAL_LIST}`);
    }
    if (f.status !== undefined && (typeof f.status !== 'string' || !(APPROVAL_STATUSES as readonly string[]).includes(f.status))) {
      throw new PlatformError('invalid', 'unknown approval status');
    }
    const where: string[] = []; const args: unknown[] = [];
    if (f.projectId !== undefined) {
      if (!isStr(f.projectId)) throw new PlatformError('invalid', 'projectId must be an id');
      this.access.require(p, f.projectId, 'approval.read');
      where.push('project_id = ?'); args.push(f.projectId);
    } else {
      this.deps.auth.require(p, 'approval.read', PLATFORM, { entityType: 'approval' });
    }
    if (f.status !== undefined) { where.push('status = ?'); args.push(f.status); }
    const rows = this.db.prepare(`SELECT * FROM approvals ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY requested_at DESC, id DESC LIMIT ?`).all(...args, limit + 1) as ApprovalRow[];
    return { approvals: rows.slice(0, limit).map((r) => this.view(r)), truncated: rows.length > limit };
  }

  /** Image builds, newest first (platform health readers). */
  imageBuilds(p: Principal, o: { profileId?: string; limit?: number } = {}): ImageBuildRecord[] {
    this.deps.auth.require(p, 'platform.health', PLATFORM, { entityType: 'image_build' });
    const limit = o.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_APPROVAL_LIST) throw new PlatformError('invalid', `limit must be 1 to ${MAX_APPROVAL_LIST}`);
    const rows = (o.profileId !== undefined
      ? this.db.prepare('SELECT * FROM image_builds WHERE profile_id = ? ORDER BY started_at DESC, id DESC LIMIT ?').all(String(o.profileId), limit)
      : this.db.prepare('SELECT * FROM image_builds ORDER BY started_at DESC, id DESC LIMIT ?').all(limit)) as ImageBuildRow[];
    return rows.map(toImageBuild);
  }

  latestSucceededBuild(profileId: string): ImageBuildRecord | null { return latestSucceededBuild(this.db, profileId); }

  private view(r: ApprovalRow): ApprovalView {
    const req = parse(r.request_json);
    const request: ApprovalRequestView = {};
    if (isObj(req)) {
      for (const k of ['recipeId', 'profile', 'profileId', 'lockfileSha256', 'contextSha256', 'baseDigest'] as const) {
        if (typeof req[k] === 'string') request[k] = req[k] as string;
      }
      if (Array.isArray(req.registries)) request.registries = req.registries.filter((x): x is string => typeof x === 'string').slice(0, 8);
      if (typeof req.estimatedBytes === 'number') request.estimatedBytes = req.estimatedBytes;
      if (typeof req.freeBytesNow === 'number' || req.freeBytesNow === null) request.freeBytesNow = req.freeBytesNow as number | null;
    }
    const b = r.reason === 'image.prepare'
      ? this.db.prepare('SELECT * FROM image_builds WHERE approval_id = ?').get(r.id) as ImageBuildRow | undefined : undefined;
    return {
      id: r.id, projectId: r.project_id, jobId: r.job_id, reason: r.reason, summary: r.summary, status: r.status, request,
      requestedAt: r.requested_at, expiresAt: r.expires_at, decidedAt: r.decided_at, decision: r.decision, consumedAt: r.consumed_at,
      imageBuild: b ? toImageBuild(b) : null
    };
  }
}
