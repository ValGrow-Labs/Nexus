/**
 * User review decisions on change-set candidates (B2b Task 9, F7, F32).
 *
 * `decide(user, versionId, { decision, comment?, intentId })` records one append-only `reviews` row: `approve`,
 * `request_changes` or `reject`. A review is always a stored USER's own decision (`review.decide` is a user-only action:
 * never the system, never an agent, never a token). The version must be a `change_set` candidate; a reject or a request
 * for changes does not change the version's status (the newest review is what accept reads: only an approving newest
 * review lets it be accepted), so a rejected candidate stays a candidate and is simply not accepted.
 *
 * - `request_changes` and `reject` need a comment (1 to 4000 characters, no secret-shaped value: a comment reaches the
 *   agent's next turn); `approve` may carry one.
 * - `request_changes` also asks the TurnStarter to continue the agent session with the review as input, as the REVIEWING
 *   user (F32), in the SAME transaction as the review row: either both happen or neither (a refusal such as
 *   `agents_unavailable` records nothing). The TurnStarter's real implementation is the agent service (Task 10); until it
 *   is wired the platform passes a stub that answers `agents_unavailable`.
 * - `intentId` (the renderer mints one per click) makes the call idempotent: the same intent answers the same review (and
 *   no second turn); an intent re-sent for another version is refused.
 * - Activity: one `review.decide` row, the actor the user; the comment is never in it (only its length and sha256).
 */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Principal } from '../../../shared/nexus/platform';
import { appendActivityRow } from '../activity/writer';
import { containsSecret } from '../activity/redact';
import type { AuthService } from '../auth/authService';
import { requireStoredUser, type PrincipalResolver } from '../auth/principals';
import { newId } from '../db/ids';
import { immediateTx } from '../db/tx';
import { PlatformError } from '../errors';
import { ProjectAccess } from '../project/projectAccess';

export const REVIEW_DECISIONS = ['approve', 'request_changes', 'reject'] as const;
export type ReviewDecision = typeof REVIEW_DECISIONS[number];
export const MAX_REVIEW_COMMENT_CHARS = 4000;

/** Task 10's agent service implements it: starts the next turn of a session with the review as input, as `user`. */
export interface TurnStarter {
  continueWith(user: Principal, sessionId: string, reviewId: string): { job: { id: string } };
}

export interface ReviewView {
  id: string; versionId: string; principalId: string; decision: ReviewDecision; comment: string | null; intentId: string; createdAt: number;
}

export interface ReviewDeps { auth: AuthService; principals: PrincipalResolver; turns: TurnStarter; now: () => number }

interface ReviewRow { id: string; version_id: string; principal_id: string; decision: ReviewDecision; comment: string | null; intent_id: string; created_at: number }
const toView = (r: ReviewRow): ReviewView => ({ id: r.id, versionId: r.version_id, principalId: r.principal_id, decision: r.decision, comment: r.comment,
  intentId: r.intent_id, createdAt: r.created_at });

export class ReviewService {
  private readonly access: ProjectAccess;
  constructor(private readonly db: Database.Database, private readonly deps: ReviewDeps) {
    this.access = new ProjectAccess(db, { auth: deps.auth });
  }

  /** The reviews of a version, oldest first (a reader's view; project read access). */
  list(user: Principal, versionId: string): ReviewView[] {
    const v = this.versionOf(versionId);
    if (!v) { this.deps.auth.require(user, 'project.read', { type: 'platform' }); throw new PlatformError('not_found', 'version not found'); }
    this.access.require(user, v.project_id, 'artifact.read', v.owner_workspace_id ? { workspaceId: v.owner_workspace_id } : undefined);
    return (this.db.prepare('SELECT * FROM reviews WHERE version_id = ? ORDER BY created_at, rowid').all(v.id) as ReviewRow[]).map(toView);
  }

  private versionOf(id: unknown): { id: string; project_id: string; status: string; kind: string; owner_workspace_id: string | null;
    artifact_id: string; produced_by_job_id: string | null } | null {
    if (typeof id !== 'string' || id.length === 0) return null;
    return (this.db.prepare(`SELECT v.id, v.project_id, v.status, a.kind, a.owner_workspace_id, v.artifact_id, v.produced_by_job_id
      FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id WHERE v.id = ?`).get(id) as ReturnType<ReviewService['versionOf']>) ?? null;
  }

  decide(user: Principal, versionId: string, i: { decision: ReviewDecision; comment?: string; intentId: string }): { review: ReviewView; job?: { id: string } } {
    requireStoredUser(this.deps.principals, this.deps.auth, user, 'review.decide', 'review', 'a review is decided by a user');
    const v = this.versionOf(versionId);
    if (!v) { this.deps.auth.require(user, 'review.decide', { type: 'platform' }); throw new PlatformError('not_found', 'version not found'); }
    this.access.require(user, v.project_id, 'review.decide', v.owner_workspace_id ? { workspaceId: v.owner_workspace_id } : undefined);
    if (typeof i !== 'object' || i === null || !REVIEW_DECISIONS.includes(i.decision)) throw new PlatformError('invalid', 'decision must be approve, request_changes or reject');
    if (typeof i.intentId !== 'string' || i.intentId.length < 1 || i.intentId.length > 128) throw new PlatformError('invalid', 'intentId is required', { reason: 'intent_required' });
    const comment = i.comment === undefined || i.comment === null ? null : i.comment;
    if (comment !== null && (typeof comment !== 'string' || comment.length > MAX_REVIEW_COMMENT_CHARS)) {
      throw new PlatformError('invalid', `a comment is at most ${MAX_REVIEW_COMMENT_CHARS} characters`, { reason: 'comment_too_long' });
    }
    const text = comment !== null && comment.trim().length === 0 ? null : comment;
    if (i.decision !== 'approve' && text === null) throw new PlatformError('invalid', 'this decision needs a comment', { reason: 'comment_required' });
    if (text !== null && containsSecret(text)) throw new PlatformError('invalid', 'the comment holds a secret-shaped value; nothing was recorded', { reason: 'secret_in_comment' });
    // A re-sent intent answers the review it made (never a second turn); for another version it is refused.
    const prior = this.db.prepare('SELECT * FROM reviews WHERE intent_id = ?').get(i.intentId) as ReviewRow | undefined;
    if (prior) {
      if (prior.version_id !== v.id || prior.decision !== i.decision) throw new PlatformError('invalid', 'the intent belongs to another decision', { reason: 'intent_mismatch' });
      return { review: toView(prior) };
    }
    if (v.kind !== 'change_set') throw new PlatformError('invalid', 'only a change set is reviewed', { reason: 'not_a_change_set' });
    if (v.status !== 'candidate') throw new PlatformError('illegal_transition', `a ${v.status} change set cannot be reviewed`, { reason: 'not_candidate' });
    const now = this.deps.now();
    return immediateTx(this.db, () => {
      const cur = this.db.prepare('SELECT status FROM artifact_versions WHERE id = ?').get(v.id) as { status: string } | undefined;
      if (cur?.status !== 'candidate') throw new PlatformError('illegal_transition', 'the change set is no longer a candidate', { reason: 'not_candidate' });
      const id = newId(now);
      const sha = text === null ? null : createHash('sha256').update(text, 'utf8').digest('hex');
      this.db.prepare(`INSERT INTO reviews (id, version_id, principal_id, decision, comment, comment_sha256, intent_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, v.id, user.id, i.decision, text, sha, i.intentId, now);
      appendActivityRow(this.db, { actorKind: 'user', actorId: user.id, projectId: v.project_id, workspaceId: v.owner_workspace_id, artifactId: v.artifact_id,
        versionId: v.id, entityType: 'review', entityId: id, action: 'review.decide', status: 'succeeded',
        details: { decision: i.decision, commentChars: text === null ? 0 : text.length, commentSha256: sha } }, now);
      const review = toView(this.db.prepare('SELECT * FROM reviews WHERE id = ?').get(id) as ReviewRow);
      if (i.decision !== 'request_changes') return { review };
      const session = v.produced_by_job_id
        ? (this.db.prepare('SELECT session_id FROM jobs WHERE id = ?').get(v.produced_by_job_id) as { session_id: string | null } | undefined)?.session_id ?? null
        : null;
      if (!session) throw new PlatformError('invalid', 'the change set was not made in an agent session', { reason: 'no_session' });
      // The reviewing user, never the system or the agent (F32). A refusal rolls the review row back with it.
      const started = this.deps.turns.continueWith(user, session, id);
      return { review, job: started.job };
    });
  }
}
