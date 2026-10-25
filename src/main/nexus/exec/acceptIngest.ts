/**
 * The ingest rules of the three git jobs whose result is a database record (B2b Task 9): `changeset.accept`,
 * `changeset.accept_rollback` and `repo.ff`. Kept apart from ingest.ts (which dispatches to them) so each rule reads whole.
 *
 * `changeset.accept` (F11, one transaction, the core fails or completes the job in the same one): the runner moved the
 * integration ref `old -> new` by compare-and-swap and reported it. Here, inside a savepoint:
 *   1. the version is still a `candidate` and its newest review still approves it (a reject or a request for changes
 *      recorded since the job started refuses the ingest, RA12);
 *   2. the accept-time `git.applies_cleanly` result is recorded over the same pure validator (the merge did apply:
 *      `clean: true`), bound to (job, attempt); the version is not a draft, so the row is ADVISORY (B2a 38.2);
 *   3. the version is promoted by the USER (compare-and-swap on the artifact's current pointer), never by the system;
 *   4. the `change_set_accepts` row and one `changeset.accept` activity row, the actor the user.
 * If any of it fails, nothing of 1-4 stays (the savepoint rolls back), the SAME transaction enqueues
 * `changeset.accept_rollback { from: new, to: old }` and the job fails `accept_rolled_back`. The version stays what it
 * was (a candidate); the ref goes back. A refusal is never turned into a retry of the accept.
 *
 * `repo.ff`: the runner fast-forwarded the user's branch to the confirmed sha. The `repo_merges` row records it with
 * `sha_confirmed`; the job must carry the dialog's confirmation (`confirmedVia: 'dialog'`) and name a user.
 *
 * `changeset.accept_rollback`: the facts must name the move the job was queued for; one activity row records it.
 */
import type Database from 'better-sqlite3';
import type { Principal } from '../../../shared/nexus/platform';
import { appendActivityRow } from '../activity/writer';
import type { ArtifactService } from '../artifact/artifactService';
import { newId } from '../db/ids';
import { PlatformError } from '../errors';
import type { JobService } from '../jobs/jobService';
import { enqueueAcceptRollbackTx, preparedOf } from '../repo/acceptRollback';
import * as appliesCleanly from '../validation/validators/appliesCleanly';
import type { ValidationService } from '../validation/validationService';
import type { IngestContext, IngestDecision } from './executionService';

const COMMIT_RE = /^[0-9a-f]{40}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const parse = (t: string | null): unknown => { if (t === null) return null; try { return JSON.parse(t) as unknown; } catch { return null; } };
const refuse = (outcome: string, code: string, message: string): IngestDecision => ({ ok: false, outcome, error: { code, message } });
const commitOf = (v: unknown): string | null => (typeof v === 'string' && COMMIT_RE.test(v) ? v : null);

export interface AcceptIngestDeps {
  db: Database.Database;
  artifacts: ArtifactService;
  validation: ValidationService;
  jobs: JobService | null;
  now: () => number;
}

function gitFacts(ctx: IngestContext): Record<string, unknown> | null {
  const f = ctx.exited.parsed.find((p) => p.parser === 'git-facts')?.normalized;
  return isObj(f) && f.ok === true ? f : null;
}

/** The stored user a job names (`params.acceptedBy` / `params.mergedBy`), as a principal; null when it is not a user. */
function userOf(db: Database.Database, id: unknown): Principal | null {
  if (typeof id !== 'string') return null;
  const r = db.prepare('SELECT id, kind, display_name, disabled_at FROM principals WHERE id = ?').get(id) as
    { id: string; kind: string; display_name: string; disabled_at: number | null } | undefined;
  return r && r.kind === 'user' && r.disabled_at === null ? { id: r.id, kind: 'user', displayName: r.display_name } : null;
}

/** `changeset.accept` (see the module header). */
export function acceptIngestTx(d: AcceptIngestDeps, ctx: IngestContext): IngestDecision {
  const { db } = d;
  const { job, attempt, system } = ctx;
  const params = parse(job.params_json);
  const f = gitFacts(ctx);
  const versionId = isObj(params) && typeof params.versionId === 'string' ? params.versionId : null;
  const branch = isObj(params) && typeof params.branch === 'string' ? params.branch : null;
  const expectedOld = isObj(params) ? commitOf(params.expectedOld) : null;
  const head = isObj(params) ? commitOf(params.head) : null;
  // What actually moved the ref: the runner's facts, or (facts unusable) its own `accept.prepared` event.
  const factsMove = f && commitOf(f.old) && commitOf(f.new) && f.mergeCommit === f.new ? { old: f.old as string, new: f.new as string } : null;
  const move = factsMove ?? preparedOf(db, job.id);
  if (!versionId || !branch || !expectedOld || !head) return refuse('invalid_output', 'bad_input', 'the accept job is malformed');
  let failed: unknown = null;
  if (!factsMove || factsMove.old !== expectedOld) {
    failed = new PlatformError('invalid', 'the accept facts do not match the job');
  } else {
    try {
      db.transaction(() => {
        const v = db.prepare(`SELECT v.id, v.status, v.project_id, v.artifact_id, v.storage_ref_json, v.metadata_json, a.kind, a.current_version_id, a.owner_workspace_id
          FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id WHERE v.id = ?`).get(versionId) as
          { id: string; status: string; project_id: string; artifact_id: string; storage_ref_json: string; metadata_json: string; kind: string;
            current_version_id: string | null; owner_workspace_id: string | null } | undefined;
        if (!v || v.kind !== 'change_set' || v.project_id !== job.project_id) throw new PlatformError('not_found', 'the change set is not there');
        if (v.status !== 'candidate') throw new PlatformError('illegal_transition', `the change set is ${v.status}, not a candidate`, { reason: 'not_candidate' });
        const storage = parse(v.storage_ref_json); const meta = parse(v.metadata_json);
        if (!isObj(storage) || storage.commit !== head || !isObj(meta) || meta.branch !== branch) {
          throw new PlatformError('conflict', 'the change set is not the one the accept job named', { reason: 'version_changed' });
        }
        const review = db.prepare('SELECT decision FROM reviews WHERE version_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(versionId) as { decision: string } | undefined;
        if (review?.decision !== 'approve') throw new PlatformError('conflict', 'the newest review no longer approves the change set', { reason: 'review_changed' });
        const user = userOf(db, params && (params as Record<string, unknown>).acceptedBy);
        if (!user) throw new PlatformError('denied', 'a change set is accepted by a user', { reason: 'user_only' });
        const now = d.now();
        d.validation.recordOutcomeTx(versionId, appliesCleanly.ID,
          appliesCleanly.run({ head, integrationHead: factsMove.old, clean: true } satisfies appliesCleanly.AppliesCleanlyFacts), { jobId: job.id, attemptN: attempt.n });
        const promoted = d.artifacts.promoteTx(user, versionId, v.current_version_id, now, { onBehalfOf: user.id });
        if (!promoted.ok) throw new PlatformError('conflict', 'the change set\'s artifact moved', { reason: 'current_moved' });
        db.prepare(`INSERT INTO change_set_accepts (version_id, project_id, integration_ref, ref_before, ref_after, merge_commit, accept_job_id, accepted_by, accepted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(versionId, job.project_id, `refs/nexus/accepted/${branch}`, factsMove.old, factsMove.new, factsMove.new, job.id, user.id, now);
        appendActivityRow(db, { actorKind: 'user', actorId: user.id, jobId: job.id, attemptN: attempt.n, projectId: job.project_id, workspaceId: v.owner_workspace_id,
          artifactId: v.artifact_id, versionId, entityType: 'artifact_version', entityId: versionId, action: 'changeset.accept', status: 'succeeded',
          details: { branch } }, now);
      })();
    } catch (e) { failed = e; }
  }
  if (failed === null) return { ok: true };
  // The database part did not happen: put the ref back, in this same transaction (needs the move that was made).
  if (!move) return refuse('invalid_output', 'parser_contract', 'the accept facts were not usable');
  if (!d.jobs) throw new PlatformError('platform_unavailable', 'an unfinished accept cannot be rolled back without the job service');
  const now = d.now();
  const reason = failed instanceof PlatformError ? (typeof failed.detail?.reason === 'string' ? failed.detail.reason : failed.code) : 'ingest_error';
  enqueueAcceptRollbackTx(db, d.jobs, system, now, { jobId: job.id, projectId: job.project_id, workspaceId: job.workspace_id, branch, versionId, move });
  appendActivityRow(db, { actorKind: system.kind, actorId: system.id, jobId: job.id, attemptN: attempt.n, projectId: job.project_id, workspaceId: job.workspace_id,
    versionId, entityType: 'artifact_version', entityId: versionId, action: 'changeset.accept', status: 'failed', details: { reason: 'rolled_back', why: reason } }, now);
  return refuse('accept_rolled_back', 'accept_rolled_back',
    'The accept could not be recorded, so the accepted branch was put back as it was. The change is still waiting for you.');
}

/** `changeset.accept_rollback`: the facts must name the move the job was queued for. */
export function rollbackIngestTx(d: AcceptIngestDeps, ctx: IngestContext): IngestDecision {
  const f = gitFacts(ctx);
  const params = parse(ctx.job.params_json);
  if (!f || !isObj(params) || f.from !== params.from || f.to !== params.to || !commitOf(f.to) || !commitOf(f.from)) {
    return refuse('invalid_output', 'parser_contract', 'the rollback facts do not match the job');
  }
  appendActivityRow(d.db, { actorKind: ctx.system.kind, actorId: ctx.system.id, onBehalfOf: ctx.job.on_behalf_of, jobId: ctx.job.id, attemptN: ctx.attempt.n,
    projectId: ctx.job.project_id, workspaceId: ctx.job.workspace_id, entityType: 'job', entityId: ctx.job.id, action: 'changeset.rollback', status: 'succeeded',
    details: { reason: 'accept_unfinished', already: f.already === true } }, d.now());
  return { ok: true, durableRecord: true };
}

/** `repo.ff`: one `repo_merges` row for a fast-forward to the confirmed sha. */
export function forwardIngestTx(d: AcceptIngestDeps, ctx: IngestContext): IngestDecision {
  const { db } = d;
  const { job, attempt } = ctx;
  const f = gitFacts(ctx);
  const params = parse(job.params_json);
  const branch = isObj(params) && typeof params.branch === 'string' ? params.branch : null;
  const sha = isObj(params) ? commitOf(params.sha) : null;
  const user = isObj(params) ? userOf(db, params.mergedBy) : null;
  if (!branch || !sha || !isObj(params) || params.confirmedVia !== 'dialog') return refuse('invalid_output', 'bad_input', 'the merge job is malformed or was not confirmed in the dialog');
  if (!user) return refuse('invalid_output', 'user_only', 'a merge is confirmed by a user');
  if (!f || f.branch !== branch || f.after !== sha || !commitOf(f.before)) return refuse('invalid_output', 'parser_contract', 'the merge facts do not match the confirmed commit');
  const known = db.prepare('SELECT 1 FROM change_set_accepts WHERE project_id = ? AND integration_ref = ? AND ref_after = ? LIMIT 1')
    .get(job.project_id, `refs/nexus/accepted/${branch}`, sha);
  if (!known) return refuse('invalid_output', 'not_accepted', 'the confirmed commit is not one Nexus accepted');
  const now = d.now();
  const id = newId(now);
  db.prepare(`INSERT INTO repo_merges (id, project_id, branch, before, after, sha_confirmed, merged_by, merged_at, confirmed_via, ff_job_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'dialog', ?)`).run(id, job.project_id, branch, f.before as string, sha, sha, user.id, now, job.id);
  appendActivityRow(db, { actorKind: 'user', actorId: user.id, jobId: job.id, attemptN: attempt.n, projectId: job.project_id, workspaceId: job.workspace_id,
    entityType: 'repo_merge', entityId: id, action: 'repo.merge', status: 'succeeded', details: { branch } }, now);
  return { ok: true, durableRecord: true };
}
