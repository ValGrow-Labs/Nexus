/**
 * Session worktrees and the A3 approval (B2b Task 7; D-B6, D-B13, F23).
 *
 * `ensure(system, sessionId, turnJobId)` is what an agent turn asks before it runs (Task 10): the session's worktree,
 * or what it is waiting for. In order:
 * 1. A live `session_worktrees` row for the session (v10; written only when the `repo.worktree` job is INGESTED, task 2's
 *    ruling) answers `{ ready: { path, gitDir, ref, base } }`: one worktree per session, `wt/<session id lowercased>`
 *    under the data home, its git folder `<repo>/.git/worktrees/<same>`, the ref `refs/nexus/job/<same>`.
 * 2. A3, once per project: without an APPROVED and CONSUMED `repo.write_refs` approval for the project, a pending one is
 *    asked for (or the pending one returned): `{ waiting: 'approval', approvalId }`. Its text names exactly what will be
 *    written: refs under `refs/nexus/job/*` and `refs/nexus/accepted/<branch>`, the worktree entry
 *    `.git/worktrees/<name>`, new objects in `.git/objects`, a locked worktree under the Nexus data folder, and never the
 *    user's branch, index or files. A denial (or an expiry) of the approval asked for THIS turn answers
 *    `{ failed: 'denied' }` (`'expired'`); a later turn asks again. Nothing is written to the repository before A3.
 * 3. Then the system child job `repo.worktree` (parent: the turn, the session's job) with params
 *    `{ sessionId, branch }`: `{ waiting: 'job', jobId }` while it is queued or running, `{ failed: <its error code> }`
 *    when the attempt for this turn failed. The scheduler leases it like any engine job; planBuilder derives every path
 *    and ref from the params and the data home; the runner (src/runner/gitWrite.ts) writes; ingest records the row.
 *
 * The branch is the project repository's recorded one (the snapshot's `metadata.branch`); without a repository
 * snapshot, or on a detached HEAD, the answer is `{ failed: 'branch_unknown' }`. Removing a worktree is a later cleanup
 * (known limitation). Every write is one IMMEDIATE transaction with its activity row and job event.
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import type { Principal } from '../../../shared/nexus/platform';
import { getRecipe } from '../../../shared/nexus/recipes';
import { appendActivityRow } from '../activity/writer';
import { containsSecret } from '../activity/redact';
import { canonicalJson } from '../db/canonical';
import { newId } from '../db/ids';
import { immediateTx } from '../db/tx';
import { PlatformError } from '../errors';
import type { JobService } from '../jobs/jobService';
import { appendJobEventTx } from '../exec/events';
import { GIT_BRANCH_RE, sessionName } from '../exec/planBuilder';

/** How long an A3 request waits for its answer (as every approval: 15 minutes). */
export const A3_TTL_MS = 15 * 60_000;
export const WORKTREE_RETRY = Object.freeze({ idempotent: true, maxAttempts: 2, backoffMs: [10_000, 60_000] });
const LIVE = ['queued', 'leased', 'running', 'awaiting_approval', 'retry_scheduled'];

export type EnsureResult =
  | { ready: { path: string; gitDir: string; ref: string; base: string } }
  | { waiting: 'approval'; approvalId: string }
  | { waiting: 'job'; jobId: string }
  | { failed: string };

export interface WorktreeDeps {
  jobs: JobService;
  now: () => number;
  /** The Nexus data home's root (`<userData>/nexus`). */
  dataHomeRoot: string;
  /** main's acceptance of a stored project folder (index.ts `acceptFsRoot`); null refuses it. */
  acceptFsRoot: ((root: string) => string | null) | null;
  /** Called after a job was queued (the scheduler's next tick leases it). */
  onQueued?: () => void;
}

/** The A3 consent text: exactly what is written, and what never is. */
export function a3Summary(branch: string): string {
  return `Let Nexus write into this project's git repository: hidden refs under refs/nexus/job/* and refs/nexus/accepted/${branch}, `
    + 'a worktree entry in .git/worktrees/<name>, new objects in .git/objects, and a locked worktree under the Nexus data folder. '
    + 'Never your branch, index or files. Asked once for this project.';
}

/** The A3 request record (main's values only). */
export function a3Request(projectId: string, branch: string): Record<string, unknown> {
  return {
    projectId, branch,
    refs: ['refs/nexus/job/*', `refs/nexus/accepted/${branch}`],
    worktreeEntries: '.git/worktrees/<name>',
    objects: 'new objects in .git/objects',
    worktree: 'a locked worktree under the Nexus data folder',
    never: ['your branch', 'your index', 'your files']
  };
}

interface SessionRow { id: string; project_id: string; workspace_id: string; participation_id: string; principal_id: string }
interface JobLite { id: string; project_id: string; session_id: string | null; created_at: number; state: string; error_json: string | null; on_behalf_of: string }

export class WorktreeService {
  constructor(private readonly db: Database.Database, private readonly deps: WorktreeDeps) {}

  private isSystem(p: Principal): boolean {
    if (p?.kind !== 'system') return false;
    const r = this.db.prepare('SELECT kind FROM principals WHERE id = ?').get(p.id) as { kind: string } | undefined;
    return r?.kind === 'system';
  }

  private repoPathOf(projectId: string): string | null {
    const accept = this.deps.acceptFsRoot;
    if (!accept) return null;
    const p = this.db.prepare('SELECT root_path FROM projects WHERE id = ?').get(projectId) as { root_path: string | null } | undefined;
    if (!p || typeof p.root_path !== 'string' || p.root_path.length === 0) return null;
    try { return accept(p.root_path); } catch { return null; }
  }

  /** The project repository's recorded branch: its current version's, else its newest live version's. */
  branchOf(projectId: string): string | null {
    const row = this.db.prepare(`SELECT v.metadata_json FROM artifacts a JOIN artifact_versions v ON v.artifact_id = a.id
      WHERE a.project_id = ? AND a.kind = 'repository' AND a.status = 'active' AND v.status IN ('draft','candidate','active')
      ORDER BY (v.id = a.current_version_id) DESC, v.version_no DESC LIMIT 1`).get(projectId) as { metadata_json: string } | undefined;
    let meta: unknown = null;
    try { meta = row ? JSON.parse(row.metadata_json) : null; } catch { meta = null; }
    const b = meta && typeof meta === 'object' ? (meta as Record<string, unknown>).branch : null;
    return typeof b === 'string' && GIT_BRANCH_RE.test(b) ? b : null;
  }

  /** The project's consumed A3, if any. */
  approvedFor(projectId: string): string | null {
    const r = this.db.prepare(`SELECT id FROM approvals WHERE project_id = ? AND reason = 'repo.write_refs' AND status = 'approved'
      AND consumed_at IS NOT NULL ORDER BY decided_at DESC LIMIT 1`).get(projectId) as { id: string } | undefined;
    return r?.id ?? null;
  }

  /** See the module header. Never writes to the repository itself. */
  ensure(system: Principal, sessionId: string, turnJobId: string): EnsureResult {
    if (!this.isSystem(system)) throw new PlatformError('denied', 'worktrees are prepared by the system', { reason: 'system_only' });
    const s = typeof sessionId === 'string'
      ? this.db.prepare('SELECT id, project_id, workspace_id, participation_id, principal_id FROM agent_sessions WHERE id = ?').get(sessionId) as SessionRow | undefined
      : undefined;
    if (!s) return { failed: 'session_missing' };
    const turn = typeof turnJobId === 'string'
      ? this.db.prepare('SELECT id, project_id, session_id, created_at, state, error_json, on_behalf_of FROM jobs WHERE id = ?').get(turnJobId) as JobLite | undefined
      : undefined;
    if (!turn || turn.project_id !== s.project_id || turn.session_id !== s.id) return { failed: 'turn_missing' };
    let name: string;
    try { name = sessionName(s.id); } catch { return { failed: 'session_missing' }; }
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_worktrees'").get()) return { failed: 'unavailable' };
    const repoPath = this.repoPathOf(s.project_id);
    if (!repoPath) return { failed: 'project_folder_unavailable' };
    const ref = `refs/nexus/job/${name}`;
    // 1. The worktree exists (its row is written at ingest).
    const row = this.db.prepare('SELECT rel_path, ref, base_commit FROM session_worktrees WHERE session_id = ? AND removed_at IS NULL').get(s.id) as
      { rel_path: string; ref: string; base_commit: string } | undefined;
    if (row) {
      return { ready: { path: path.join(this.deps.dataHomeRoot, ...row.rel_path.split('/')), gitDir: path.join(repoPath, '.git', 'worktrees', name),
        ref: row.ref, base: row.base_commit } };
    }
    const branch = this.branchOf(s.project_id);
    if (!branch) return { failed: 'branch_unknown' };
    const now = this.deps.now();
    return immediateTx(this.db, (): EnsureResult => {
      // 2. A3, once per project.
      if (!this.approvedFor(s.project_id)) {
        const pending = this.db.prepare(`SELECT id FROM approvals WHERE project_id = ? AND reason = 'repo.write_refs' AND status = 'pending'
          AND expires_at > ? ORDER BY requested_at DESC LIMIT 1`).get(s.project_id, now) as { id: string } | undefined;
        if (pending) return { waiting: 'approval', approvalId: pending.id };
        // This turn's own request was answered no (or ran out): the turn ends; a later turn asks again.
        const mine = this.db.prepare(`SELECT status FROM approvals WHERE project_id = ? AND reason = 'repo.write_refs' AND session_id = ?
          AND requested_at >= ? ORDER BY requested_at DESC, rowid DESC LIMIT 1`).get(s.project_id, s.id, turn.created_at) as { status: string } | undefined;
        if (mine && mine.status === 'denied') return { failed: 'denied' };
        if (mine && (mine.status === 'expired' || mine.status === 'withdrawn')) return { failed: 'expired' };
        return { waiting: 'approval', approvalId: this.requestA3Tx(system, s, turn, branch, now) };
      }
      // 3. The worktree job: one live at a time for the session.
      const jobs = this.db.prepare(`SELECT id, project_id, session_id, created_at, state, error_json, on_behalf_of FROM jobs
        WHERE session_id = ? AND recipe_id = 'repo.worktree' ORDER BY created_at DESC, rowid DESC`).all(s.id) as JobLite[];
      const live = jobs.find((j) => LIVE.includes(j.state));
      if (live) return { waiting: 'job', jobId: live.id };
      const last = jobs[0];
      if (last && last.created_at >= turn.created_at && last.state !== 'completed') {
        let code = 'worktree_failed';
        try { const e = last.error_json ? JSON.parse(last.error_json) as { code?: unknown } : null; if (e && typeof e.code === 'string') code = e.code; } catch { /* kept */ }
        return { failed: code };
      }
      return { waiting: 'job', jobId: this.enqueueTx(system, s, turn, branch, jobs.length + 1, now) };
    });
  }

  private requestA3Tx(system: Principal, s: SessionRow, turn: JobLite, branch: string, now: number): string {
    const request = a3Request(s.project_id, branch);
    if (containsSecret(request)) throw new PlatformError('invalid', 'the approval request would hold a secret-shaped value', { reason: 'secret_in_request' });
    const id = newId(now);
    const sha = createHash('sha256').update(canonicalJson(request)).digest('hex');
    this.db.prepare(`INSERT INTO approvals (id, project_id, job_id, session_id, reason, summary, request_json, request_sha256, status,
        requested_by, on_behalf_of, requested_at, expires_at, status_changed_at)
      VALUES (?, ?, NULL, ?, 'repo.write_refs', ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`)
      .run(id, s.project_id, s.id, a3Summary(branch), JSON.stringify(request), sha, system.id, turn.on_behalf_of, now, now + A3_TTL_MS, now);
    appendActivityRow(this.db, { actorKind: 'system', actorId: system.id, onBehalfOf: turn.on_behalf_of, sessionId: s.id, jobId: turn.id,
      projectId: s.project_id, workspaceId: s.workspace_id, entityType: 'approval', entityId: id, action: 'approval.request', status: 'succeeded',
      details: { reason: 'repo.write_refs', branch, request: { sha256: sha }, expiresAt: now + A3_TTL_MS } }, now);
    appendJobEventTx(this.db, { type: 'approval', summary: 'repository write approval requested', projectId: s.project_id, approvalId: id,
      data: { status: 'pending', reason: 'repo.write_refs' } }, now);
    return id;
  }

  private enqueueTx(system: Principal, s: SessionRow, turn: JobLite, branch: string, seq: number, now: number): string {
    const recipe = getRecipe('repo.worktree')!;
    const res = this.deps.jobs.createTx(system, {
      kind: 'tool.run', projectId: s.project_id, workspaceId: s.workspace_id, sessionId: s.id, parentJobId: turn.id,
      idempotencyKey: `repo.worktree:${s.id}:${seq}`, recipeId: recipe.id, params: { sessionId: s.id, branch },
      retry: { ...WORKTREE_RETRY, backoffMs: [...WORKTREE_RETRY.backoffMs] }
    });
    const cap = { action: 'system.repo.worktree', recipe: recipe.id, recipeVersion: recipe.version, executor: recipe.executor, network: recipe.network, profile: null };
    this.db.prepare('UPDATE jobs SET capabilities_json = ?, limits_json = ? WHERE id = ?')
      .run(JSON.stringify([cap]), JSON.stringify({ wallClockMs: recipe.wallClockMs }), res.job.id);
    appendJobEventTx(this.db, { type: 'job.transition', summary: 'job queued: session worktree', projectId: s.project_id, jobId: res.job.id,
      data: { from: null, to: 'queued', recipe: recipe.id, parent: turn.id } }, now);
    this.deps.onQueued?.();
    return res.job.id;
  }
}
