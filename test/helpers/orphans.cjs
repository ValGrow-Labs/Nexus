'use strict';
// B2a Task 8 adds the execution queries O10-O17 (execOrphans; allOrphans = O1-O17), kept apart so the B1 set and the
// exact-key assertions made on it stay as they were.
// B2a Task 13 adds O18-O22: the invariants of the Task 13 brief that O10-O17 did not already cover (the brief's
// O11, O16 and O17 are the existing O11, O16 and O17). allOrphans = O1-O22.
// B1 Task 7: the orphan queries O1-O9. `orphans(db)` returns { O1: n, ..., O9: n }; after any sequence of normal
// UI operations every count must be 0. `orphanRows(db)` returns the offending rows themselves, for messages.
// Pure reads: nothing here writes. The v8 queries (O3-O6) count 0 on a database without the handoff tables.
const loadTs = require('../load-ts.cjs');

const hasTable = (db, name) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

/** Each query selects the offending rows (one id-like column `id` plus context). */
const QUERIES = {
  // O1 artifacts with no version.
  O1: () => `SELECT a.id FROM artifacts a WHERE NOT EXISTS (SELECT 1 FROM artifact_versions v WHERE v.artifact_id = a.id)`,
  // O2 artifacts whose current_version_id is not an active version of the same artifact.
  O2: () => `SELECT a.id, a.current_version_id AS current FROM artifacts a WHERE a.current_version_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM artifact_versions v WHERE v.id = a.current_version_id AND v.artifact_id = a.id AND v.status = 'active')`,
  // O3 handoffs whose subject count differs from subject_count.
  O3: (v8) => v8 ? `SELECT h.id, h.subject_count AS declared,
      (SELECT COUNT(*) FROM handoff_subjects s WHERE s.handoff_id = h.id) AS actual FROM handoffs h
    WHERE h.subject_count <> (SELECT COUNT(*) FROM handoff_subjects s WHERE s.handoff_id = h.id)` : null,
  // O4 accepted handoffs with no receipt, or a receipt not owned by to_participation_id.
  O4: (v8) => v8 ? `SELECT h.id, h.receipt_version_id AS receipt FROM handoffs h WHERE h.status = 'accepted' AND (
      h.receipt_version_id IS NULL OR NOT EXISTS (SELECT 1 FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id
        WHERE v.id = h.receipt_version_id AND a.kind = 'handoff_receipt' AND a.owner_participation_id = h.to_participation_id))` : null,
  // O5 handoff_receipt artifacts that no handoff points at.
  O5: (v8) => v8 ? `SELECT a.id FROM artifacts a WHERE a.kind = 'handoff_receipt' AND NOT EXISTS (
      SELECT 1 FROM handoffs h JOIN artifact_versions v ON v.id = h.receipt_version_id WHERE v.artifact_id = a.id)`
    : `SELECT a.id FROM artifacts a WHERE a.kind = 'handoff_receipt'`,
  // O6 handoff_convert edges whose from is not the receipt of an accepted handoff, or whose to is not one of its subjects.
  O6: (v8) => v8 ? `SELECT e.id, e.from_version_id AS fromV, e.to_version_id AS toV FROM artifact_edges e
    WHERE e.source = 'handoff_convert' AND NOT EXISTS (SELECT 1 FROM handoffs h JOIN handoff_subjects s ON s.handoff_id = h.id
      WHERE h.status = 'accepted' AND h.receipt_version_id = e.from_version_id AND s.version_id = e.to_version_id)`
    : `SELECT e.id FROM artifact_edges e WHERE e.source = 'handoff_convert'`,
  // O7 versions whose participation_id is not their artifact's owner participation.
  O7: () => `SELECT v.id, v.participation_id AS versionParticipation, a.owner_participation_id AS owner FROM artifact_versions v
    JOIN artifacts a ON a.id = v.artifact_id WHERE v.participation_id IS NOT a.owner_participation_id`,
  // O8 participations, artifacts, versions, handoffs or edges naming a missing project (beside foreign_key_check).
  O8: (v8) => [
    `SELECT 'project_workspaces' AS t, id FROM project_workspaces WHERE project_id NOT IN (SELECT id FROM projects)`,
    `SELECT 'artifacts' AS t, id FROM artifacts WHERE project_id NOT IN (SELECT id FROM projects)`,
    `SELECT 'artifact_versions' AS t, id FROM artifact_versions WHERE project_id NOT IN (SELECT id FROM projects)`,
    `SELECT 'artifact_edges' AS t, e.id FROM artifact_edges e WHERE NOT EXISTS (SELECT 1 FROM artifact_versions v JOIN projects p ON p.id = v.project_id
       WHERE v.id = e.from_version_id) OR NOT EXISTS (SELECT 1 FROM artifact_versions v JOIN projects p ON p.id = v.project_id WHERE v.id = e.to_version_id)`,
    ...(v8 ? [`SELECT 'handoffs' AS t, id FROM handoffs WHERE project_id NOT IN (SELECT id FROM projects)`] : [])
  ].join(' UNION ALL '),
  // O9 succeeded mutation rows in activity whose entity_id names no row in the matching table.
  O9: (v8) => `SELECT a.seq AS id, a.action, a.entity_id AS entity FROM activity a WHERE a.status = 'succeeded' AND (
      (substr(a.action, 1, 9) = 'artifact.' AND NOT EXISTS (SELECT 1 FROM artifacts x WHERE x.id = a.entity_id))
   OR (substr(a.action, 1, 8) = 'version.' AND NOT EXISTS (SELECT 1 FROM artifact_versions x WHERE x.id = a.entity_id))
   OR (a.action = 'lineage.write' AND NOT EXISTS (SELECT 1 FROM artifact_edges x WHERE x.id = a.entity_id))
   OR (substr(a.action, 1, 8) = 'handoff.' AND ${v8 ? 'NOT EXISTS (SELECT 1 FROM handoffs x WHERE x.id = a.entity_id)' : '1'})
   OR (substr(a.action, 1, 14) = 'participation.' AND NOT EXISTS (SELECT 1 FROM project_workspaces x WHERE x.id = a.entity_id)))`
};
const IDS = Object.freeze(Object.keys(QUERIES));

// ---------- B2a Task 8: execution orphan queries O10-O17 ----------
// Each is a pure SELECT of the offending rows; every one is null (0 rows) on a database without the v9 tables.
const TERMINAL_JOBS = "('completed','partial','failed','cancelled','timed_out','interrupted')";

/** (kind, validator) for every blocking register or candidate validator (the finalize rule's set). */
function blockingPairs() {
  const { VALIDATORS } = loadTs('src/shared/nexus/validators.ts');
  const out = [];
  for (const v of VALIDATORS) {
    if (!v.blocking || (v.stage !== 'register' && v.stage !== 'candidate')) continue;
    for (const k of v.kinds) out.push([k, v.id]);
  }
  return out;
}
const sqlText = (s) => `'${String(s).replace(/'/g, "''")}'`;

const EXEC_QUERIES = {
  // O10 attempts whose job is missing, or whose n is above the job's attempt count.
  O10: (v9) => v9 ? `SELECT a.id, a.job_id AS job, a.n FROM job_attempts a LEFT JOIN jobs j ON j.id = a.job_id
    WHERE j.id IS NULL OR a.n > j.attempts` : null,
  // O11 jobs with more than one live (starting or running) attempt.
  O11: (v9) => v9 ? `SELECT a.job_id AS id, COUNT(*) AS live FROM job_attempts a WHERE a.state IN ('starting','running')
    GROUP BY a.job_id HAVING COUNT(*) > 1` : null,
  // O12 terminal jobs that still have a live attempt.
  O12: (v9) => v9 ? `SELECT j.id, j.state, a.id AS attempt FROM jobs j JOIN job_attempts a ON a.job_id = j.id AND a.state IN ('starting','running')
    WHERE j.state IN ${TERMINAL_JOBS}` : null,
  // O13 succeeded attempts missing exit_code, outcome, environment_json or sandbox_json.
  O13: (v9) => v9 ? `SELECT a.id FROM job_attempts a WHERE a.state = 'succeeded'
    AND (a.exit_code IS NULL OR a.outcome IS NULL OR a.environment_json IS NULL OR a.sandbox_json IS NULL)` : null,
  // O14 version_blobs, or blob storage references, naming a missing blob.
  O14: (v9) => v9 ? `SELECT vb.version_id AS id, vb.sha256 FROM version_blobs vb WHERE NOT EXISTS (SELECT 1 FROM blobs b WHERE b.sha256 = vb.sha256)
    UNION ALL SELECT v.id, json_extract(v.storage_ref_json, '$.sha256') FROM artifact_versions v WHERE v.storage_kind = 'blob'
      AND NOT EXISTS (SELECT 1 FROM blobs b WHERE b.sha256 = json_extract(v.storage_ref_json, '$.sha256'))` : null,
  // O15 validations naming a missing version, job or attempt.
  O15: (v9) => v9 ? `SELECT x.id FROM validations x WHERE NOT EXISTS (SELECT 1 FROM artifact_versions v WHERE v.id = x.version_id)
    OR (x.job_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = x.job_id))
    OR (x.attempt_n IS NOT NULL AND NOT EXISTS (SELECT 1 FROM job_attempts a WHERE a.job_id = x.job_id AND a.n = x.attempt_n))` : null,
  // O16 job-produced candidate or active versions whose LATEST blocking row is not `passed` for some blocking
  // validator of their kind (none at all, or a newer failed / error row: a passed row in history is not enough).
  O16: (v9) => {
    if (!v9) return null;
    const pairs = blockingPairs();
    if (pairs.length === 0) return null;
    return `WITH req(kind, validator) AS (VALUES ${pairs.map(([k, v]) => `(${sqlText(k)}, ${sqlText(v)})`).join(', ')})
      SELECT v.id, r.validator FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id JOIN req r ON r.kind = a.kind
      WHERE v.produced_by_job_id IS NOT NULL AND v.status IN ('candidate','active')
        AND NOT EXISTS (SELECT 1 FROM validations x WHERE x.version_id = v.id AND x.validator_id = r.validator AND x.status = 'passed' AND x.blocking = 1
          AND NOT EXISTS (SELECT 1 FROM validations y WHERE y.version_id = x.version_id AND y.validator_id = x.validator_id AND y.blocking = 1
            AND (y.finished_at > x.finished_at OR (y.finished_at = x.finished_at AND y.rowid > x.rowid))))`;
  },
  // O17 completed tool.run or validate jobs whose current attempt has neither an ingested output version nor a (job, n) validation.
  // B2b (Task 16): the git recipes whose result is a durable RECORD, not a version (RECORD_ONLY_RECIPES) stand on that record, which
  // must exist: a worktree's `session_worktrees` row, a fast-forward's `repo_merges` row, a rollback's `changeset.rollback` activity row.
  O17: (v9, o) => v9 ? `SELECT j.id FROM jobs j WHERE j.state = 'completed' AND j.kind IN ('tool.run','validate')
    AND NOT EXISTS (SELECT 1 FROM version_attempts va WHERE va.job_id = j.id AND va.attempt_n = j.attempts)
    AND NOT EXISTS (SELECT 1 FROM validations x WHERE x.job_id = j.id AND x.attempt_n = j.attempts)${o && o.v10 ? `
    AND NOT (j.recipe_id = 'repo.worktree' AND EXISTS (SELECT 1 FROM session_worktrees sw WHERE sw.session_id = j.session_id))
    AND NOT (j.recipe_id = 'repo.ff' AND EXISTS (SELECT 1 FROM repo_merges m WHERE m.ff_job_id = j.id))
    AND NOT (j.recipe_id = 'changeset.accept_rollback' AND EXISTS (SELECT 1 FROM activity a WHERE a.job_id = j.id AND a.action = 'changeset.rollback' AND a.status = 'succeeded'))` : ''}` : null
};

// ---------- B2a Task 13: O18-O22 (the brief's O10, O12, O13, O14 and O15 under new numbers) ----------
// Kept apart from O10-O17 so Task 8's exact-key assertions on execOrphans / EXEC_ZERO stay as they were; allOrphans
// and ALL_ZERO hold all of them.
const T13_QUERIES = {
  // O18 live (starting or running) attempts whose job is not leased, running or awaiting approval (brief O10; the
  // existing O12 covers terminal jobs only: this adds a queued, retry_scheduled or missing job).
  O18: (v9) => v9 ? `SELECT a.id, a.job_id AS job, j.state FROM job_attempts a LEFT JOIN jobs j ON j.id = a.job_id
    WHERE a.state IN ('starting','running') AND (j.id IS NULL OR j.state NOT IN ('leased','running','awaiting_approval'))` : null,
  // O19 storage without its blobs (brief O12, as this schema stores them): a blob version with no 'content' version
  // blob of its sha256, and a tree version whose 'file' version blobs do not number its manifest's files (a tree's
  // manifest is the hash of its file list, kept in storage_ref_json, not a stored blob).
  O19: (v9) => v9 ? `SELECT v.id, v.storage_kind AS kind FROM artifact_versions v WHERE v.storage_kind = 'blob' AND NOT EXISTS (SELECT 1 FROM version_blobs vb
      WHERE vb.version_id = v.id AND vb.role = 'content' AND vb.sha256 = json_extract(v.storage_ref_json, '$.sha256'))
    UNION ALL SELECT v.id, v.storage_kind FROM artifact_versions v WHERE v.storage_kind = 'tree'
      AND COALESCE(json_extract(v.storage_ref_json, '$.files'), -1) <> (SELECT COUNT(*) FROM version_blobs vb WHERE vb.version_id = v.id AND vb.role = 'file')` : null,
  // O20 live deployments (starting, healthy, unhealthy) whose job is terminal (brief O13).
  O20: (v9) => v9 ? `SELECT d.id, d.status, j.state FROM deployments d JOIN jobs j ON j.id = d.job_id
    WHERE d.status IN ('starting','healthy','unhealthy') AND j.state IN ${TERMINAL_JOBS}` : null,
  // O21 pending approvals past their expiry after a sweep (brief O14): `o.sweptAt` is when the caller last ran the
  // expiry sweep (ApprovalService.expireDue); without it there is no sweep to hold the store to, and nothing counts.
  O21: (v9, o) => v9 && Number.isSafeInteger(o?.sweptAt) ? `SELECT a.id, a.expires_at AS expiresAt FROM approvals a
    WHERE a.status = 'pending' AND a.expires_at <= ${o.sweptAt}` : null,
  // O22 validations bound to a job of another project than their version's (brief O15).
  O22: (v9) => v9 ? `SELECT x.id, x.job_id AS job FROM validations x JOIN jobs j ON j.id = x.job_id JOIN artifact_versions v ON v.id = x.version_id
    WHERE j.project_id <> v.project_id` : null
};
const T13_IDS = Object.freeze(Object.keys(T13_QUERIES));
const EXEC_IDS = Object.freeze(Object.keys(EXEC_QUERIES));
const hasV9 = (db) => ['job_attempts', 'validations', 'version_blobs', 'blobs', 'version_attempts', 'deployments', 'approvals'].every((t) => hasTable(db, t));

function execOrphanRows(db) {
  const v9 = hasV9(db);
  const v10 = hasTable(db, 'session_worktrees') && hasTable(db, 'repo_merges');
  const out = {};
  for (const id of EXEC_IDS) {
    const sql = EXEC_QUERIES[id](v9, { v10 });
    out[id] = sql ? db.prepare(sql).all() : [];
  }
  return out;
}

function execOrphans(db) {
  const rows = execOrphanRows(db);
  return Object.fromEntries(EXEC_IDS.map((id) => [id, rows[id].length]));
}

/** O18-O22 rows. `o.sweptAt`: when the caller last ran the approval expiry sweep (O21). */
function t13OrphanRows(db, o = {}) {
  const v9 = hasV9(db);
  const out = {};
  for (const id of T13_IDS) {
    const sql = T13_QUERIES[id](v9, o);
    out[id] = sql ? db.prepare(sql).all() : [];
  }
  return out;
}

function t13Orphans(db, o = {}) {
  const rows = t13OrphanRows(db, o);
  return Object.fromEntries(T13_IDS.map((id) => [id, rows[id].length]));
}

/** O1-O22 in one object (`o.sweptAt` for O21). */
function allOrphans(db, o = {}) { return { ...orphans(db), ...execOrphans(db), ...t13Orphans(db, o) }; }

function orphanRows(db) {
  const v8 = hasTable(db, 'handoffs') && hasTable(db, 'handoff_subjects');
  const out = {};
  for (const id of IDS) {
    const sql = QUERIES[id](v8);
    out[id] = sql ? db.prepare(sql).all() : [];
  }
  return out;
}

function orphans(db) {
  const rows = orphanRows(db);
  return Object.fromEntries(IDS.map((id) => [id, rows[id].length]));
}

/** Every check the flows end with: orphans all 0, foreign_key_check empty, integrity_check ok, the activity chain verifies. */
function storeHealth(db) {
  const { verifyActivityChain } = loadTs('src/main/nexus/activity/writer.ts');
  return {
    orphans: orphans(db),
    execOrphans: execOrphans(db),
    foreignKeys: db.prepare('PRAGMA foreign_key_check').all(),
    integrity: db.pragma('integrity_check', { simple: true }),
    chain: verifyActivityChain(db)
  };
}

const ZERO = Object.freeze(Object.fromEntries(IDS.map((id) => [id, 0])));

const EXEC_ZERO = Object.freeze(Object.fromEntries(EXEC_IDS.map((id) => [id, 0])));
const T13_ZERO = Object.freeze(Object.fromEntries(T13_IDS.map((id) => [id, 0])));
const ALL_ZERO = Object.freeze({ ...ZERO, ...EXEC_ZERO, ...T13_ZERO });

module.exports = { orphans, orphanRows, storeHealth, ORPHAN_IDS: IDS, ZERO,
  execOrphans, execOrphanRows, allOrphans, EXEC_ORPHAN_IDS: EXEC_IDS, EXEC_ZERO, ALL_ZERO,
  t13Orphans, t13OrphanRows, T13_ORPHAN_IDS: T13_IDS, T13_ZERO };
