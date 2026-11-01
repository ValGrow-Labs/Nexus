/**
 * "Continue from the earlier suggested change" (a new conversation's working copy starts from the newest suggested change that is not in the project yet).
 *
 * A suggested change (a `change_set` artifact) is a chain of versions; only its newest version counts. It is waiting to be continued when that version is
 * still a candidate, is blocked (`failed`: its checks did not pass), or is `active` without having been accepted. A draft (still being checked), a
 * deprecated one, an accepted one (its work is already on the integration head every new conversation starts from) and an archived artifact are not.
 * When several are waiting, the newest wins. Reads Nexus's own records only; writes nothing.
 */
import type Database from 'better-sqlite3';

const COMMIT_RE = /^[0-9a-f]{40}$/;

export interface Continuation {
  versionId: string;
  artifactId: string;
  status: string;
  commit: string;
  title: string;
  summary: string;
  /** The conversation that made it (the session of the job that collected it), or null. */
  sessionId: string | null;
}

interface Row { id: string; artifact_id: string; status: string; storage_ref_json: string; metadata_json: string; job_id: string | null; name: string }

const parse = (t: string | null | undefined): unknown => { try { return t ? JSON.parse(t) as unknown : null; } catch { return null; } };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function toContinuation(db: Database.Database, r: Row): Continuation | null {
  const storage = parse(r.storage_ref_json);
  const commit = isObj(storage) && typeof storage.commit === 'string' && COMMIT_RE.test(storage.commit) ? storage.commit : null;
  if (!commit) return null;
  const meta = parse(r.metadata_json);
  const title = isObj(meta) && typeof meta.title === 'string' && meta.title.trim() !== '' ? meta.title.trim().slice(0, 200) : r.name;
  const summary = isObj(meta) && typeof meta.summary === 'string' ? meta.summary.slice(0, 4000) : '';
  const sess = r.job_id ? (db.prepare('SELECT session_id FROM jobs WHERE id = ?').get(r.job_id) as { session_id: string | null } | undefined)?.session_id ?? null : null;
  return { versionId: r.id, artifactId: r.artifact_id, status: r.status, commit, title, summary, sessionId: sess };
}

const COLUMNS = 'v.id, v.artifact_id, v.status, v.storage_ref_json, v.metadata_json, v.produced_by_job_id AS job_id, a.name';

/**
 * A blocked change (its checks did not pass) is carried on only right after it was made, as a follow-up ("fix it"). An hour later a new request is
 * most likely about something else, and starting from a stale blocked change would drag its files and its name into it.
 */
export const BLOCKED_CONTINUE_MS = 30 * 60_000;

/** The newest suggested change of the project that a new conversation continues, or null (none waiting, or the records are not those of a change). */
export function newestUnmergedChange(db: Database.Database, projectId: string, now: number = Date.now()): Continuation | null {
  try {
    const r = db.prepare(`SELECT ${COLUMNS} FROM artifacts a JOIN artifact_versions v ON v.artifact_id = a.id
      WHERE a.project_id = ? AND a.kind = 'change_set' AND a.status = 'active'
        AND v.version_no = (SELECT MAX(w.version_no) FROM artifact_versions w WHERE w.artifact_id = a.id)
        AND (v.status = 'candidate'
          OR (v.status = 'failed' AND v.created_at >= ?)
          OR (v.status = 'active' AND NOT EXISTS (SELECT 1 FROM change_set_accepts c WHERE c.version_id = v.id)))
      ORDER BY v.created_at DESC, v.rowid DESC LIMIT 1`).get(projectId, now - BLOCKED_CONTINUE_MS) as Row | undefined;
    return r ? toContinuation(db, r) : null;
  } catch { return null; }
}

/** One version as a continuation (a change set of this project, with a usable commit), or null. */
export function continuationOf(db: Database.Database, projectId: string, versionId: string): Continuation | null {
  try {
    const r = db.prepare(`SELECT ${COLUMNS} FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id
      WHERE v.id = ? AND a.project_id = ? AND a.kind = 'change_set'`).get(versionId, projectId) as Row | undefined;
    return r ? toContinuation(db, r) : null;
  } catch { return null; }
}
