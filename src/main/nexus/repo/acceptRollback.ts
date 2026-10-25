/**
 * The rollback of an accept that did not finish (B2b Task 9, F11). An accept moves the integration ref by compare-and-swap
 * from `old` to `new` and reports `accept.prepared { old, new }` BEFORE it does (a `job_events` row of the accept job). The
 * database part (promote the version, write the accept row) runs later, in the ingest transaction. If that part does not
 * happen, the ref must go back: `changeset.accept_rollback { from: new, to: old }`, a compare-and-swap, idempotent.
 *
 * Three callers enqueue it, each idempotent by the key `changeset.accept_rollback:<accept job id>`:
 *   - ingest, in the SAME transaction that fails the accept job (`accept_rolled_back`);
 *   - restart recovery, for an accept job that ended without an accept row (an interrupted one is never retried);
 *   - the accept service, for a job that failed for any reason that is not a refusal by git itself (a refusal moved nothing).
 * Never a retry of the accept, and never a merge later.
 */
import type Database from 'better-sqlite3';
import type { Principal } from '../../../shared/nexus/platform';
import { getRecipe } from '../../../shared/nexus/recipes';
import { appendJobEventTx } from '../exec/events';
import type { JobService } from '../jobs/jobService';

const COMMIT_RE = /^[0-9a-f]{40}$/;
/** Failures where git itself refused before moving the ref (or its CAS missed): there is nothing to roll back. */
const GIT_REFUSALS: readonly string[] = ['ref_moved', 'merge_conflict', 'bad_task', 'unknown_commit', 'git_missing', 'branch_missing'];
const ENDED_STATES = ['interrupted', 'failed', 'timed_out', 'cancelled'];

interface AcceptJobRow { id: string; project_id: string; workspace_id: string; state: string; params_json: string; error_json: string | null }

export interface PreparedMove { old: string; new: string }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const parse = (t: string | null): unknown => { if (t === null) return null; try { return JSON.parse(t) as unknown; } catch { return null; } };

/** The `accept.prepared` event of an accept job (the newest), or null. */
export function preparedOf(db: Database.Database, jobId: string): PreparedMove | null {
  const r = db.prepare(`SELECT data_json FROM job_events WHERE job_id = ? AND type = 'attempt.progress'
    AND json_extract(data_json, '$.acceptPrepared.new') IS NOT NULL ORDER BY seq DESC LIMIT 1`).get(jobId) as { data_json: string } | undefined;
  const d = r ? parse(r.data_json) : null;
  const p = isObj(d) && isObj(d.acceptPrepared) ? d.acceptPrepared : null;
  return p && typeof p.old === 'string' && COMMIT_RE.test(p.old) && typeof p.new === 'string' && COMMIT_RE.test(p.new) ? { old: p.old, new: p.new } : null;
}

export const rollbackKeyFor = (acceptJobId: string): string => `changeset.accept_rollback:${acceptJobId}`;

/**
 * The move an ended accept job must be rolled back from, or null: the job ended without completing, reported
 * `accept.prepared`, has no accept row and no rollback job yet, and did not end on a refusal by git.
 */
export function rollbackNeeded(db: Database.Database, jobId: string): { job: AcceptJobRow; move: PreparedMove; branch: string; versionId: string | null } | null {
  const job = db.prepare("SELECT id, project_id, workspace_id, state, params_json, error_json FROM jobs WHERE id = ? AND recipe_id = 'changeset.accept'")
    .get(jobId) as AcceptJobRow | undefined;
  if (!job || !ENDED_STATES.includes(job.state)) return null;
  const move = preparedOf(db, job.id);
  if (!move) return null;
  const e = parse(job.error_json);
  if (isObj(e) && typeof e.code === 'string' && GIT_REFUSALS.includes(e.code)) return null;
  if (db.prepare('SELECT 1 FROM change_set_accepts WHERE accept_job_id = ?').get(job.id)) return null;
  if (db.prepare('SELECT 1 FROM jobs WHERE idempotency_key = ?').get(rollbackKeyFor(job.id))) return null;
  const params = parse(job.params_json);
  const branch = isObj(params) && typeof params.branch === 'string' ? params.branch : null;
  if (!branch) return null;
  return { job, move, branch, versionId: isObj(params) && typeof params.versionId === 'string' ? params.versionId : null };
}

/** Accept jobs that ended and may need a rollback (a cheap scan; `rollbackNeeded` decides each). */
export function endedAcceptJobIds(db: Database.Database): string[] {
  return (db.prepare(`SELECT id FROM jobs WHERE recipe_id = 'changeset.accept' AND state IN (${ENDED_STATES.map(() => '?').join(', ')})
    ORDER BY created_at, id`).all(...ENDED_STATES) as { id: string }[]).map((r) => r.id);
}

/**
 * Inside the caller's IMMEDIATE transaction: queues the rollback job of an accept job's move (system child job
 * `changeset.accept_rollback { branch, from: new, to: old }`; idempotent by key). Returns the job id.
 */
export function enqueueAcceptRollbackTx(db: Database.Database, jobs: JobService, system: Principal, now: number,
  a: { jobId: string; projectId: string; workspaceId: string; branch: string; versionId: string | null; move: PreparedMove }): string {
  const recipe = getRecipe('changeset.accept_rollback')!;
  const res = jobs.createTx(system, {
    kind: 'tool.run', projectId: a.projectId, workspaceId: a.workspaceId, idempotencyKey: rollbackKeyFor(a.jobId), recipeId: recipe.id,
    params: { branch: a.branch, from: a.move.new, to: a.move.old, acceptJobId: a.jobId, ...(a.versionId ? { versionId: a.versionId } : {}) },
    retry: { idempotent: true, maxAttempts: 3, backoffMs: [10_000, 60_000] }
  });
  if (res.created) {
    const cap = { action: 'system.changeset.accept_rollback', recipe: recipe.id, recipeVersion: recipe.version, executor: recipe.executor,
      network: recipe.network, profile: null };
    db.prepare('UPDATE jobs SET capabilities_json = ?, limits_json = ? WHERE id = ?')
      .run(JSON.stringify([cap]), JSON.stringify({ wallClockMs: recipe.wallClockMs }), res.job.id);
    appendJobEventTx(db, { type: 'job.transition', summary: 'job queued: roll back an unfinished accept', projectId: a.projectId, jobId: res.job.id,
      data: { from: null, to: 'queued', recipe: recipe.id, acceptJob: a.jobId } }, now);
  }
  return res.job.id;
}
