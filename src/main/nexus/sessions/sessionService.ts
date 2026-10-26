/**
 * Agent sessions: the durable record of one agent conversation in a project's
 * workspace (user decision, Revision 1). Jobs are runs inside a session
 * (jobs.session_id); every agent.run job carries one.
 *
 * Nothing executes in B0b: no runtime is spawned and nothing is scheduled. The
 * service records the session, lets the system principal move it through the
 * state table, lets a user cancel it, and repairs state after a restart.
 *
 * - Principal and participation. principal_id is the calling principal (main
 *   resolves it; the input never names one). The participation is the ACTIVE
 *   (project, workspace) row: no row is 'not_participating', a withdrawn or
 *   complete row is 'participation_inactive'.
 * - Context. contextVersionId is optional and must be a candidate or active
 *   version of the session's project (drafts are mutable) that the caller can read
 *   in its owner's workspace.
 * - Authority. Every operation authorizes BEFORE any transaction, with the
 *   workspace of the STORED participation row (agent_sessions.participation_id),
 *   never a workspace the caller names. An unknown session id is 'not_found' only
 *   for a principal authorized at platform scope; anyone else gets 'denied'.
 *   transition and recoverAfterRestart are system-only.
 * - Idempotency. open is idempotent by `idempotencyKey`; a re-sent intent for a
 *   different project, workspace, principal or context is a 'conflict'.
 * - A session's status is not derived from its jobs; the runtime phase decides how
 *   job outcomes drive it. B0b enforces linkage, place, and the cancel cascade. A
 *   terminal transition does NOT cascade to the session's jobs (accepted for B0b);
 *   a job of an ended session can still finish but can never be queued again.
 * - Every mutation writes its activity row(s) in the same IMMEDIATE transaction,
 *   each carrying the session id.
 */
import type Database from 'better-sqlite3';
import type {
  AgentSession, AgentSessionStatus, Job, JobError, PlatformAction, Principal, ProjectId, SessionId, VersionId, WorkspaceId
} from '../../../shared/nexus/platform';
import type { AuthService } from '../auth/authService';
import { appendActivityRow } from '../activity/writer';
import { newId } from '../db/ids';
import { immediateTx } from '../db/tx';
import { PlatformError } from '../errors';
import {
  cancelJobInTx, listLimit, parseError, redactedErrorJson, requireActiveParticipation, storedWorkspace, validateKey, validateRef, validateRuntime,
  type JobRow, type JobService
} from '../jobs/jobService';
import { TERMINAL_JOB_STATES } from '../jobs/jobRules';
import { NOT_CANCELLABLE_RECIPES } from '../exec/executionService';
import { ProjectAccess } from '../project/projectAccess';
import { canTransitionSession, isSessionStatus, TERMINAL_SESSION_STATES } from './sessionRules';

export interface OpenSessionInput {
  projectId: ProjectId; workspaceId: WorkspaceId; idempotencyKey: string;
  contextVersionId?: VersionId; runtime?: { kind: string; ref?: string };
}

interface SessionRow {
  id: string; project_id: string; workspace_id: string; participation_id: string; context_version_id: string | null;
  principal_id: string; idempotency_key: string; status: AgentSessionStatus; runtime_kind: string | null; runtime_ref: string | null;
  cancel_requested_at: number | null; cancel_requested_by: string | null; error_json: string | null;
  created_at: number; updated_at: number; status_changed_at: number; ended_at: number | null;
}

const PLATFORM = { type: 'platform' } as const;
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const toSession = (r: SessionRow): AgentSession => ({
  id: r.id, projectId: r.project_id, workspaceId: r.workspace_id, participationId: r.participation_id,
  contextVersionId: r.context_version_id, principalId: r.principal_id, idempotencyKey: r.idempotency_key, status: r.status,
  runtimeKind: r.runtime_kind, runtimeRef: r.runtime_ref, cancelRequestedAt: r.cancel_requested_at,
  cancelRequestedBy: r.cancel_requested_by, error: parseError(r.error_json), createdAt: r.created_at, updatedAt: r.updated_at,
  statusChangedAt: r.status_changed_at, endedAt: r.ended_at
});

export class SessionService {
  private readonly access: ProjectAccess;

  constructor(private readonly db: Database.Database, private readonly deps: { auth: AuthService; jobs: JobService; now: () => number }) {
    this.access = new ProjectAccess(db, { auth: deps.auth });
  }

  open(p: Principal, i: OpenSessionInput): { session: AgentSession; created: boolean } {
    if (!isPlainObject(i)) throw new PlatformError('invalid', 'input must be an object');
    if (!isStr(i.projectId) || !isStr(i.workspaceId)) throw new PlatformError('invalid', 'projectId and workspaceId are required');
    const key = validateKey(i.idempotencyKey);
    const contextVersionId = i.contextVersionId === undefined ? null : i.contextVersionId;
    if (contextVersionId !== null && (!isStr(contextVersionId) || contextVersionId.length > 128)) {
      throw new PlatformError('invalid', 'contextVersionId must be an id');
    }
    const runtime = validateRuntime(i.runtime);

    // A re-sent open must name the same session: project, workspace and principal always; context and runtime when supplied.
    const requireSame = (r: SessionRow): void => {
      const same = r.project_id === i.projectId && r.workspace_id === i.workspaceId && r.principal_id === p.id
        && (contextVersionId === null || r.context_version_id === contextVersionId)
        && (runtime === null || (r.runtime_kind === runtime.kind && (runtime.ref === null || r.runtime_ref === runtime.ref)));
      if (!same) throw new PlatformError('conflict', 'that idempotency key already opened a different session', { sessionId: r.id });
    };
    const prior = this.rowByKey(key);
    if (prior) {
      this.authorizeRow(p, prior, 'session.open');
      requireSame(prior);
      return { session: toSession(prior), created: false };
    }

    const pw = requireActiveParticipation(this.access, this.db, p, i.projectId, i.workspaceId, 'session.open');
    // The context must be readable by the caller in its owner's workspace ('denied', audited).
    if (contextVersionId !== null) this.access.requireVersionReadable(p, contextVersionId, pw.project_id, 'context');
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const again = this.rowByKey(key);
      if (again) {
        requireSame(again);
        return { session: toSession(again), created: false };
      }
      const live = this.db.prepare('SELECT status FROM project_workspaces WHERE id = ?').get(pw.id) as { status: string } | undefined;
      if (!live || live.status !== 'active') throw new PlatformError('participation_inactive', 'the participation is no longer active');
      if (contextVersionId !== null) this.requireContextVersion(contextVersionId, pw.project_id);
      const id = newId(now);
      this.db.prepare(`INSERT INTO agent_sessions (id, project_id, workspace_id, participation_id, context_version_id, principal_id,
          idempotency_key, status, runtime_kind, runtime_ref, created_at, updated_at, status_changed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`)
        .run(id, pw.project_id, pw.workspace_id, pw.id, contextVersionId, p.id, key, runtime?.kind ?? null, runtime?.ref ?? null, now, now, now);
      appendActivityRow(this.db, { actorKind: p.kind, actorId: p.id, onBehalfOf: p.id, sessionId: id, projectId: pw.project_id,
        workspaceId: pw.workspace_id, versionId: contextVersionId, entityType: 'agent_session', entityId: id, action: 'session.open',
        status: 'succeeded', details: { runtimeKind: runtime?.kind ?? null, context: contextVersionId !== null } }, now);
      return { session: toSession(this.row(id)!), created: true };
    });
  }

  get(p: Principal, id: SessionId): AgentSession {
    return toSession(this.load(p, id, 'session.read'));
  }

  listByProject(p: Principal, projectId: ProjectId, o?: { statuses?: AgentSessionStatus[]; limit?: number }): AgentSession[] {
    const limit = listLimit(o?.limit);
    const statuses = o?.statuses;
    if (statuses !== undefined && (!Array.isArray(statuses) || statuses.length === 0 || !statuses.every(isSessionStatus))) {
      throw new PlatformError('invalid', 'statuses must be a non-empty list of session states');
    }
    // Project scope: a list spans every participation, so no single stored workspace applies.
    this.access.require(p, projectId, 'session.read');
    const where = ['project_id = ?']; const args: unknown[] = [projectId];
    if (statuses !== undefined) { where.push(`status IN (${statuses.map(() => '?').join(', ')})`); args.push(...statuses); }
    return (this.db.prepare(`SELECT * FROM agent_sessions WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...args, limit) as SessionRow[]).map(toSession);
  }

  /** The jobs of the session, oldest first (ix_jobs_session). */
  jobsOf(p: Principal, id: SessionId): Job[] {
    return this.deps.jobs.listBySession(p, id);
  }

  /** System only. Table-checked; a terminal status sets ended_at; the error is stored redacted. */
  transition(system: Principal, id: SessionId, to: AgentSessionStatus, d?: { error?: JobError; runtimeRef?: string }): AgentSession {
    if (!isSessionStatus(to)) throw new PlatformError('invalid', 'unknown session state');
    if (d !== undefined && !isPlainObject(d)) throw new PlatformError('invalid', 'details must be an object');
    const errorJson = d?.error === undefined ? null : redactedErrorJson(d.error);
    const runtimeRef = d?.runtimeRef === undefined ? null : validateRef(d.runtimeRef);
    const stored = this.load(system, id, 'session.transition');
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const s = this.row(stored.id)!;
      this.applyTransition(system, s, to, now, { errorJson, runtimeRef, action: 'session.transition' });
      return toSession(this.row(s.id)!);
    });
  }

  /**
   * One IMMEDIATE transaction: record who asked and when, cancel every non-terminal
   * job of the session (children before parents, J.5), then move the session to
   * cancelled. One activity row per change, each with the session id. A terminal
   * session is returned unchanged.
   *
   * EXECUTOR HAND-OFF (J.5): with no executor in B0b, jobs and the session go
   * straight to cancelled (see cancelJobInTx in jobService.ts). When execution lands, the
   * runtime is signalled after cancel_requested_at/by are persisted, and the
   * terminal moves follow its confirmation.
   */
  cancel(p: Principal, id: SessionId): AgentSession {
    const stored = this.load(p, id, 'session.cancel');
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const s = this.row(stored.id)!;
      if (TERMINAL_SESSION_STATES.has(s.status)) return toSession(s);
      // B2b Task 10: a turn that is running owns a live attempt (a container, a runtime process, a token): ending the session
      // under it would leave all three. The user cancels the turn first (AgentService.cancel / end, through the execution core).
      // (Nexus's own non-cancellable git jobs are not a turn: a running worktree job never blocks ending the conversation.)
      if (this.hasLiveAttempt(s.id)) throw new PlatformError('conflict', 'cancel the running turn first', { reason: 'turn_running' });
      if (s.cancel_requested_at === null) {
        this.db.prepare('UPDATE agent_sessions SET cancel_requested_at = ?, cancel_requested_by = ?, updated_at = ? WHERE id = ?')
          .run(now, p.id, now, s.id);
      }
      for (const j of this.liveJobsChildrenFirst(s.id)) cancelJobInTx(this.db, p, j, now, s.id);
      // <- runtime hand-off for the session goes here (J.5).
      this.db.prepare("UPDATE agent_sessions SET status = 'cancelled', status_changed_at = ?, updated_at = ?, ended_at = ? WHERE id = ?")
        .run(now, now, now, s.id);
      appendActivityRow(this.db, { actorKind: p.kind, actorId: p.id, onBehalfOf: s.principal_id, sessionId: s.id, projectId: s.project_id,
        workspaceId: s.workspace_id, entityType: 'agent_session', entityId: s.id, action: 'session.cancel', status: 'cancelled',
        details: { from: s.status, to: 'cancelled' } }, now);
      return toSession(this.row(s.id)!);
    });
  }

  /** Whether a job of the session has a live attempt (schema v9 and later; false below it). */
  private hasLiveAttempt(sessionId: string): boolean {
    try {
      return this.db.prepare(`SELECT 1 FROM job_attempts a JOIN jobs j ON j.id = a.job_id WHERE j.session_id = ? AND a.state IN ('starting','running')
        AND (j.recipe_id IS NULL OR j.recipe_id NOT IN (${NOT_CANCELLABLE_RECIPES.map(() => '?').join(', ')})) LIMIT 1`)
        .get(sessionId, ...NOT_CANCELLABLE_RECIPES) !== undefined;
    } catch { return false; }
  }

  /**
   * After a restart no runtime is attached: running and awaiting_approval sessions
   * become interrupted; open sessions are untouched. System only; idempotent.
   */
  recoverAfterRestart(system: Principal): { interrupted: number } {
    this.deps.auth.require(system, 'session.transition', PLATFORM, { entityType: 'agent_session', details: { op: 'recover_after_restart' } });
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const rows = this.db.prepare("SELECT * FROM agent_sessions WHERE status IN ('running', 'awaiting_approval') ORDER BY created_at, id")
        .all() as SessionRow[];
      for (const s of rows) this.applyTransition(system, s, 'interrupted', now, { errorJson: null, runtimeRef: null, action: 'session.recover' });
      return { interrupted: rows.length };
    });
  }

  // ---------- helpers ----------

  private applyTransition(actor: Principal, s: SessionRow, to: AgentSessionStatus, now: number,
    o: { errorJson: string | null; runtimeRef: string | null; action: string }): void {
    if (!canTransitionSession(s.status, to)) {
      throw new PlatformError('illegal_transition', `a ${s.status} session cannot move to ${to}`, { from: s.status, to });
    }
    const sets = ['status = ?', 'status_changed_at = ?', 'updated_at = ?']; const args: unknown[] = [to, now, now];
    if (TERMINAL_SESSION_STATES.has(to)) { sets.push('ended_at = ?'); args.push(now); }
    if (o.errorJson !== null) { sets.push('error_json = ?'); args.push(o.errorJson); }
    if (o.runtimeRef !== null) { sets.push('runtime_ref = ?'); args.push(o.runtimeRef); }
    this.db.prepare(`UPDATE agent_sessions SET ${sets.join(', ')} WHERE id = ?`).run(...args, s.id);
    appendActivityRow(this.db, { actorKind: actor.kind, actorId: actor.id, onBehalfOf: s.principal_id, sessionId: s.id,
      projectId: s.project_id, workspaceId: s.workspace_id, entityType: 'agent_session', entityId: s.id, action: o.action,
      status: 'succeeded', details: { from: s.status, to, error: o.errorJson !== null ? parseError(o.errorJson)?.code : undefined } }, now);
  }

  /**
   * The session's non-terminal jobs, ordered so every job comes before its parent
   * (deepest first by parent_job_id), then oldest first.
   */
  private liveJobsChildrenFirst(sessionId: string): JobRow[] {
    // Nexus's own git jobs (a worktree, an accept, a rollback, a fast-forward) are never cancelled from outside: they end through
    // ingest, which records what they did whether or not the conversation has ended.
    const rows = (this.db.prepare('SELECT * FROM jobs WHERE session_id = ? ORDER BY created_at, id').all(sessionId) as JobRow[])
      .filter((j) => !TERMINAL_JOB_STATES.has(j.state) && !(j.recipe_id !== null && NOT_CANCELLABLE_RECIPES.includes(j.recipe_id)));
    const byId = new Map(rows.map((j) => [j.id, j]));
    const depth = new Map<string, number>();
    const depthOf = (j: JobRow): number => {
      const known = depth.get(j.id);
      if (known !== undefined) return known;
      depth.set(j.id, 0);                           // guards a (database-impossible) parent cycle
      const parent = j.parent_job_id !== null ? byId.get(j.parent_job_id) : undefined;
      const d = parent ? depthOf(parent) + 1 : 0;
      depth.set(j.id, d);
      return d;
    };
    return rows.map((j, i) => ({ j, i, d: depthOf(j) })).sort((a, b) => b.d - a.d || a.i - b.i).map((x) => x.j);
  }

  private row(id: string): SessionRow | null {
    return (this.db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(id) as SessionRow | undefined) ?? null;
  }

  private rowByKey(key: string): SessionRow | null {
    return (this.db.prepare('SELECT * FROM agent_sessions WHERE idempotency_key = ?').get(key) as SessionRow | undefined) ?? null;
  }

  /** Loads a session and authorizes `action` with its STORED participation's workspace. Outside any transaction. */
  private load(p: Principal, id: SessionId, action: PlatformAction): SessionRow {
    const s = isStr(id) ? this.row(id) : null;
    if (!s) {
      this.deps.auth.require(p, action, PLATFORM);
      throw new PlatformError('not_found', 'session not found');
    }
    this.authorizeRow(p, s, action);
    return s;
  }

  private authorizeRow(p: Principal, s: SessionRow, action: PlatformAction): void {
    const ws = storedWorkspace(this.db, s.participation_id);
    this.access.require(p, s.project_id, action, ws ? { workspaceId: ws } : undefined);
  }

  /** Inside the transaction: the context is a candidate or active version of the session's project. */
  private requireContextVersion(versionId: string, projectId: string): void {
    const v = this.db.prepare('SELECT project_id, status FROM artifact_versions WHERE id = ?').get(versionId) as
      { project_id: string; status: string } | undefined;
    if (!v) throw new PlatformError('not_found', 'context version not found');
    if (v.project_id !== projectId) throw new PlatformError('invalid', 'the context version belongs to another project');
    if (v.status !== 'candidate' && v.status !== 'active') throw new PlatformError('invalid', 'the context must be a candidate or active version');
  }
}
