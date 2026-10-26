/**
 * The integration ref's RECORDED head (B2b Task 9, B6; O25). `refs/nexus/accepted/<branch>` moves in exactly three recorded ways,
 * and every one leaves a durable, append-only record in the database:
 *   - the first worktree creates it at the branch head (`session_worktrees.base_commit` of the project's first row: the initial head);
 *   - an accept moves it from `ref_before` to `ref_after` (`change_set_accepts`);
 *   - a resync moves it forward to a commit on the user's own branch when the branch already holds everything accepted (the
 *     activity row `repo.integration_resync`, details `{ branch, before, after }`; the v10 DDL is frozen, so the record is an
 *     activity row, which is itself append-only and hash-chained). It is written in the same ingest transaction as the
 *     `repo.worktree` job's own row.
 * The recorded head is the end of that chain: the `after` of the one record that no other record starts from. Anything else (no
 * record at all, a record that forks, a ref that is not at the end of the chain) is "not consistent": nothing is accepted or
 * merged on top of it. A ref moved outside these records (by hand, or by an accept that did not finish) is never the baseline.
 */
import type Database from 'better-sqlite3';

export const RESYNC_ACTION = 'repo.integration_resync';
const COMMIT_RE = /^[0-9a-f]{40}$/;

export interface BaselineRecord { kind: 'initial' | 'accept' | 'resync'; before: string | null; after: string; at: number }

const parse = (t: string | null): unknown => { if (t === null) return null; try { return JSON.parse(t) as unknown; } catch { return null; } };

/** Every recorded move of the integration ref of `branch`, oldest first within each kind. */
export function baselineRecords(db: Database.Database, projectId: string, integrationRef: string): BaselineRecord[] {
  const out: BaselineRecord[] = [];
  const first = db.prepare('SELECT base_commit, created_at FROM session_worktrees WHERE project_id = ? AND integration_ref = ? ORDER BY created_at, rowid LIMIT 1')
    .get(projectId, integrationRef) as { base_commit: string; created_at: number } | undefined;
  if (first) out.push({ kind: 'initial', before: null, after: first.base_commit, at: first.created_at });
  for (const r of db.prepare('SELECT ref_before, ref_after, accepted_at FROM change_set_accepts WHERE project_id = ? AND integration_ref = ? ORDER BY rowid')
    .all(projectId, integrationRef) as { ref_before: string; ref_after: string; accepted_at: number }[]) {
    out.push({ kind: 'accept', before: r.ref_before, after: r.ref_after, at: r.accepted_at });
  }
  const branch = integrationRef.replace(/^refs\/nexus\/accepted\//, '');
  for (const r of db.prepare('SELECT ts, details_json FROM activity WHERE project_id = ? AND action = ? AND status = \'succeeded\' ORDER BY seq')
    .all(projectId, RESYNC_ACTION) as { ts: number; details_json: string }[]) {
    const d = parse(r.details_json) as Record<string, unknown> | null;
    if (d && typeof d === 'object' && d.branch === branch && typeof d.before === 'string' && COMMIT_RE.test(d.before)
      && typeof d.after === 'string' && COMMIT_RE.test(d.after)) out.push({ kind: 'resync', before: d.before, after: d.after, at: r.ts });
  }
  return out;
}

/**
 * The recorded head: the end of the chain of records. `head: null` with `known: false` when nothing is recorded or the records
 * do not form one chain (a fork or a cycle); `known: true` otherwise.
 */
export function integrationBaseline(db: Database.Database, projectId: string, integrationRef: string): { head: string | null; known: boolean; records: BaselineRecord[] } {
  const records = baselineRecords(db, projectId, integrationRef);
  if (records.length === 0) return { head: null, known: false, records };
  const befores = new Set(records.map((r) => r.before).filter((b): b is string => b !== null));
  // A record is the end when no other record starts from where it ended.
  const ends = records.filter((r) => !befores.has(r.after));
  const heads = new Set(ends.map((r) => r.after));
  if (heads.size !== 1) return { head: null, known: false, records };
  return { head: [...heads][0], known: true, records };
}
