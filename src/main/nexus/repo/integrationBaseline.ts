/**
 * The integration ref's RECORDED head (B2b Task 9, B6; O25). `refs/nexus/accepted/<branch>` moves in exactly three recorded ways,
 * and every one leaves a durable, append-only record in the database:
 *   - the first worktree creates it at the branch head (`session_worktrees.base_commit` of the project's first row: the initial head);
 *   - an accept moves it from `ref_before` to `ref_after` (`change_set_accepts`);
 *   - a resync moves it to the head of the user's own branch while nothing is waiting to be merged: forward when the branch holds
 *     the whole ref, or as a REWRITE (`rewrite: true`) when the user amended, rebased or reset and nothing was accepted after the
 *     recorded head. The v10 DDL is frozen, so the record is the activity row `repo.integration_resync`
 *     (`entity_id` = the ref, details `{ branch, before, after, rewrite? }`: commit ids and a flag), which is itself append-only and
 *     hash-chained. It is written in the same ingest transaction as the `repo.worktree` job's own row. The record is found by its
 *     `entity_id`, never by the branch name in the details (a branch named like a secret is stored redacted there).
 * The recorded head is the `after` of the newest record in the log, provided the records chain from the initial head. Anything else
 * (no record at all, a break in the chain, a ref that is not at the recorded head) is "not consistent": nothing is accepted or
 * merged on top of it. A rewrite record may follow only the initial head or a resync, never an accept (it would lose accepted
 * work): one that does makes the chain unknown. A ref moved outside these records (by hand, or by an accept that did not finish)
 * is never the baseline.
 */
import type Database from 'better-sqlite3';
import { endedAcceptJobIds, rollbackNeeded } from './acceptRollback';

export const RESYNC_ACTION = 'repo.integration_resync';
const COMMIT_RE = /^[0-9a-f]{40}$/;
const LIVE = ['queued', 'leased', 'running', 'awaiting_approval', 'retry_scheduled'];

export interface BaselineRecord { kind: 'initial' | 'accept' | 'resync'; before: string | null; after: string; /** Order in the append-only activity log (0 for the initial head). */ seq: number | null; rewrite?: boolean }

const parse = (t: string | null): unknown => { if (t === null) return null; try { return JSON.parse(t) as unknown; } catch { return null; } };

/** Every recorded move of `integrationRef`, in the order of the append-only activity log (the initial head first). */
export function baselineRecords(db: Database.Database, projectId: string, integrationRef: string): BaselineRecord[] {
  const out: BaselineRecord[] = [];
  const first = db.prepare('SELECT session_id, base_commit FROM session_worktrees WHERE project_id = ? AND integration_ref = ? ORDER BY created_at, rowid LIMIT 1')
    .get(projectId, integrationRef) as { session_id: string; base_commit: string } | undefined;
  if (first) out.push({ kind: 'initial', before: null, after: first.base_commit, seq: 0 });
  const acceptSeq = db.prepare("SELECT MIN(seq) AS seq FROM activity WHERE action = 'changeset.accept' AND status = 'succeeded' AND version_id = ?");
  for (const r of db.prepare('SELECT version_id, ref_before, ref_after FROM change_set_accepts WHERE project_id = ? AND integration_ref = ? ORDER BY rowid')
    .all(projectId, integrationRef) as { version_id: string; ref_before: string; ref_after: string }[]) {
    out.push({ kind: 'accept', before: r.ref_before, after: r.ref_after, seq: (acceptSeq.get(r.version_id) as { seq: number | null }).seq });
  }
  for (const r of db.prepare("SELECT seq, details_json FROM activity WHERE project_id = ? AND action = ? AND entity_id = ? AND status = 'succeeded' ORDER BY seq")
    .all(projectId, RESYNC_ACTION, integrationRef) as { seq: number; details_json: string }[]) {
    const d = parse(r.details_json) as Record<string, unknown> | null;
    if (d && typeof d === 'object' && typeof d.before === 'string' && COMMIT_RE.test(d.before) && typeof d.after === 'string' && COMMIT_RE.test(d.after)) {
      out.push({ kind: 'resync', before: d.before, after: d.after, seq: r.seq, ...(d.rewrite === true ? { rewrite: true } : {}) });
    }
  }
  return out.sort((x, y) => (x.seq ?? Number.MAX_SAFE_INTEGER) - (y.seq ?? Number.MAX_SAFE_INTEGER));
}

/**
 * The recorded head: the `after` of the NEWEST record, provided the records chain (each starts from where the one before it ended,
 * the first being the initial head) and every record has its place in the log. A break, a missing place, or a rewrite that follows
 * an accept makes the chain unknown (`known: false`): nothing is then consistent. `endKind` is the kind of the newest record.
 * (Records are ordered by the log, not by what they point at: a reset back to an earlier commit is a legitimate new record.)
 */
export function integrationBaseline(db: Database.Database, projectId: string, integrationRef: string):
  { head: string | null; known: boolean; endKind: BaselineRecord['kind'] | null; records: BaselineRecord[] } {
  const records = baselineRecords(db, projectId, integrationRef);
  const unknown = { head: null, known: false, endKind: null, records };
  if (records.length === 0 || records[0].kind !== 'initial') return unknown;
  for (let i = 1; i < records.length; i++) {
    const r = records[i]; const prev = records[i - 1];
    if (r.seq === null || r.kind === 'initial' || r.before !== prev.after) return unknown;
    // A rewrite never follows an accept: it would lose accepted work.
    if (r.rewrite && prev.kind === 'accept') return unknown;
  }
  const end = records[records.length - 1];
  return { head: end.after, known: true, endKind: end.kind, records };
}

/** True while an accept's rollback for this project and branch is owed: queued, running, failed or not yet queued. */
export function rollbackOutstanding(db: Database.Database, projectId: string, branch: string): boolean {
  const open = db.prepare(`SELECT 1 FROM jobs WHERE recipe_id = 'changeset.accept_rollback' AND project_id = ? AND state <> 'completed'
    AND json_extract(params_json, '$.branch') = ? LIMIT 1`).get(projectId, branch);
  if (open) return true;
  for (const id of endedAcceptJobIds(db)) {
    const n = rollbackNeeded(db, id);
    if (n && n.job.project_id === projectId && n.branch === branch) return true;
  }
  return false;
}

/**
 * Whether the user's amend, rebase or reset may move the integration ref (a REWRITE): the chain is known and ends in the initial head
 * or a resync (no accept after it), no accept is in flight, and no rollback is owed. Computed by main from its own records and handed to
 * the runner as a task field; never from anything an agent said.
 */
export function rewriteAllowed(db: Database.Database, projectId: string, integrationRef: string): boolean {
  const b = integrationBaseline(db, projectId, integrationRef);
  if (!b.known || b.endKind === 'accept') return false;
  const branch = integrationRef.replace(/^refs\/nexus\/accepted\//, '');
  const live = db.prepare(`SELECT 1 FROM jobs WHERE recipe_id = 'changeset.accept' AND project_id = ? AND json_extract(params_json, '$.branch') = ?
    AND state IN (${LIVE.map(() => '?').join(', ')}) LIMIT 1`).get(projectId, branch, ...LIVE);
  return !live && !rollbackOutstanding(db, projectId, branch);
}
