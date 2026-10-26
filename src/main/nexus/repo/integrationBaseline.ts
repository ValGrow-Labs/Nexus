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

/**
 * Every recorded move of `integrationRef`, in the order of the append-only activity log (the initial head first). Looked up by JOB
 * (the accept's own job, the worktree jobs of the project), never by scanning the project's activity: the log grows with every
 * tool call of every turn, and these jobs are few.
 */
export function baselineRecords(db: Database.Database, projectId: string, integrationRef: string): BaselineRecord[] {
  const out: BaselineRecord[] = [];
  const first = db.prepare('SELECT session_id, base_commit FROM session_worktrees WHERE project_id = ? AND integration_ref = ? ORDER BY created_at, rowid LIMIT 1')
    .get(projectId, integrationRef) as { session_id: string; base_commit: string } | undefined;
  if (first) out.push({ kind: 'initial', before: null, after: first.base_commit, seq: 0 });
  const acceptSeq = db.prepare("SELECT MIN(seq) AS seq FROM activity WHERE job_id = ? AND action = 'changeset.accept' AND status = 'succeeded'");
  for (const r of db.prepare('SELECT accept_job_id, ref_before, ref_after FROM change_set_accepts WHERE project_id = ? AND integration_ref = ? ORDER BY rowid')
    .all(projectId, integrationRef) as { accept_job_id: string; ref_before: string; ref_after: string }[]) {
    out.push({ kind: 'accept', before: r.ref_before, after: r.ref_after, seq: (acceptSeq.get(r.accept_job_id) as { seq: number | null }).seq });
  }
  const byJob = db.prepare("SELECT seq, details_json FROM activity WHERE job_id = ? AND action = ? AND entity_id = ? AND status = 'succeeded' ORDER BY seq");
  const jobs = db.prepare("SELECT id FROM jobs WHERE project_id = ? AND recipe_id = 'repo.worktree'").all(projectId) as { id: string }[];
  for (const j of jobs) {
    for (const r of byJob.all(j.id, RESYNC_ACTION, integrationRef) as { seq: number; details_json: string }[]) {
      const d = parse(r.details_json) as Record<string, unknown> | null;
      if (d && typeof d === 'object' && typeof d.before === 'string' && COMMIT_RE.test(d.before) && typeof d.after === 'string' && COMMIT_RE.test(d.after)) {
        out.push({ kind: 'resync', before: d.before, after: d.after, seq: r.seq, ...(d.rewrite === true ? { rewrite: true } : {}) });
      }
    }
  }
  return out.sort((x, y) => (x.seq ?? Number.MAX_SAFE_INTEGER) - (y.seq ?? Number.MAX_SAFE_INTEGER));
}

/** True when the accept that ended at `sha` was merged into the user's branch by "Merge accepted work" (a `repo_merges` row confirms that sha). */
function acceptMerged(db: Database.Database, projectId: string, branch: string, sha: string): boolean {
  return db.prepare('SELECT 1 FROM repo_merges WHERE project_id = ? AND branch = ? AND sha_confirmed = ? LIMIT 1').get(projectId, branch, sha) !== undefined;
}

export interface Baseline {
  head: string | null; known: boolean; endKind: BaselineRecord['kind'] | null;
  /** The newest record is an accept that "Merge accepted work" has merged: the branch holds all of it, so a rewrite loses nothing. */
  endMerged: boolean;
  records: BaselineRecord[];
}

/**
 * The recorded head: the `after` of the NEWEST record, provided the records chain (each starts from where the one before it ended,
 * the first being the initial head) and every record has its place in the log. A break, a missing place, or a rewrite that follows
 * an UNMERGED accept makes the chain unknown (`known: false`): nothing is then consistent. A rewrite may follow an accept that was
 * confirmed merged (a `repo_merges` row for that sha): the user's branch held it, so rewriting the branch loses nothing accepted.
 * `endKind` is the kind of the newest record. (Records are ordered by the log, not by what they point at: a reset back to an
 * earlier commit is a legitimate new record.)
 *
 * Cached per (database, project, ref) and keyed by the newest activity row of the project (its seq AND hash, so a rolled-back and
 * reused sequence number never matches) with the counts of the other record sources: a status read with nothing new is O(1).
 */
const CACHE = new WeakMap<object, Map<string, { key: string; value: Baseline }>>();

export function integrationBaseline(db: Database.Database, projectId: string, integrationRef: string): Baseline {
  const newest = db.prepare('SELECT seq, hash FROM activity WHERE project_id = ? ORDER BY seq DESC LIMIT 1').get(projectId) as { seq: number; hash: string } | undefined;
  const n = (sql: string): number => (db.prepare(sql).get(projectId) as { n: number }).n;
  const key = [newest?.seq ?? 0, newest?.hash ?? '', n('SELECT COUNT(*) AS n FROM change_set_accepts WHERE project_id = ?'),
    n('SELECT COUNT(*) AS n FROM session_worktrees WHERE project_id = ?'), n('SELECT COUNT(*) AS n FROM repo_merges WHERE project_id = ?')].join(':');
  let perDb = CACHE.get(db);
  if (!perDb) { perDb = new Map(); CACHE.set(db, perDb); }
  const slot = `${projectId}|${integrationRef}`;
  const hit = perDb.get(slot);
  if (hit && hit.key === key) return hit.value;
  const value = computeBaseline(db, projectId, integrationRef);
  perDb.set(slot, { key, value });
  return value;
}

function computeBaseline(db: Database.Database, projectId: string, integrationRef: string): Baseline {
  const branch = integrationRef.replace(/^refs\/nexus\/accepted\//, '');
  const records = baselineRecords(db, projectId, integrationRef);
  const unknown: Baseline = { head: null, known: false, endKind: null, endMerged: false, records };
  if (records.length === 0 || records[0].kind !== 'initial') return unknown;
  for (let i = 1; i < records.length; i++) {
    const r = records[i]; const prev = records[i - 1];
    if (r.seq === null || r.kind === 'initial' || r.before !== prev.after) return unknown;
    // A rewrite never follows accepted work that still waits to be merged: it would lose it.
    if (r.rewrite && prev.kind === 'accept' && !acceptMerged(db, projectId, branch, prev.after)) return unknown;
  }
  const end = records[records.length - 1];
  return { head: end.after, known: true, endKind: end.kind, endMerged: end.kind === 'accept' && acceptMerged(db, projectId, branch, end.after), records };
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
 * Whether the user's amend, rebase or reset may move the integration ref (a REWRITE): the chain is known and ends in the initial head,
 * a resync, or an accept that was merged into the branch (never an accept still waiting), no accept is in flight, and no rollback is owed. Computed by main from its own records and handed to
 * the runner as a task field; never from anything an agent said.
 */
export function rewriteAllowed(db: Database.Database, projectId: string, integrationRef: string): boolean {
  const b = integrationBaseline(db, projectId, integrationRef);
  // An accept that is not merged yet would be lost; one that was merged (the branch holds it) is not.
  if (!b.known || (b.endKind === 'accept' && !b.endMerged)) return false;
  const branch = integrationRef.replace(/^refs\/nexus\/accepted\//, '');
  const live = db.prepare(`SELECT 1 FROM jobs WHERE recipe_id = 'changeset.accept' AND project_id = ? AND json_extract(params_json, '$.branch') = ?
    AND state IN (${LIVE.map(() => '?').join(', ')}) LIMIT 1`).get(projectId, branch, ...LIVE);
  return !live && !rollbackOutstanding(db, projectId, branch);
}
