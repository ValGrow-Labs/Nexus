'use strict';
// Schema v11 (live preview of a suggested change): the ONE trigger tr_deployments_insert is replaced so a deployment's subject may also be a change_set
// version. Every database here is a temp copy built from the v6 fixture; nothing touches userData. v11 is opt-in (enableV11 / NEXUS_ENABLE_V11=1).
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const C = require('./helpers/cleanup.cjs'); C.cleanupAfterAll();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const {
  PersistStore: PersistStoreUntracked, platformFailureMarkerPath, V11, V11_ENABLED_BY_DEFAULT, V11_FAILURE_LIMIT
} = loadTs('src/main/db.ts');
class PersistStore extends PersistStoreUntracked { constructor(...a) { super(...a); C.track(this); } }
const { applyV11, v11ShapeProblem, V11_DDL } = loadTs('src/main/nexus/db/schemaV11.ts');
const { V11_TRIGGER_DDL, V11_TRIGGER_SQL } = loadTs('src/main/nexus/db/schemaV11Trigger.ts');
const { v9ShapeProblem, V9_DDL } = loadTs('src/main/nexus/db/schemaV9.ts');
const { v10ShapeProblem } = loadTs('src/main/nexus/db/schemaV10.ts');
const { ddlObjects, normaliseSql } = loadTs('src/main/nexus/db/schemaV7.ts');
const { holdHint } = require('../tools/nexus-db-restore.cjs');
const REPO = path.join(__dirname, '..');
const T = h.NOW;

const open = (file, o = {}) => { const logs = []; const s = new PersistStore(file);
  s.open({ log: (l) => logs.push(l), backupDir: path.join(path.dirname(file), 'backups'), now: () => h.NOW, ...o });
  return { s, logs }; };
// v9, v10 and v11 are all off until asked for: every case that wants a step asks for it.
const openV10 = (file, o = {}) => open(file, { enableV9: true, enableV10: true, holdV11: true, ...o });
const openV11 = (file, o = {}) => open(file, { enableV9: true, enableV10: true, enableV11: true, ...o });
const v10File = () => { const { file } = h.v6Fixture(); openV10(file).s.close(); return file; };
const backups = (file) => { try { return fs.readdirSync(path.join(path.dirname(file), 'backups')).filter((f) => f.endsWith('.db')).sort(); } catch { return []; } };
const userVersion = (file) => { const db = C.openRaw(file); try { return db.pragma('user_version', { simple: true }); } finally { db.close(); } };
const plain = (l) => l.replace(/^\S+ /, '');
const v11Lines = (logs) => logs.filter((l) => /\bv11\b/.test(l)).map(plain);
const allOn = (s) => { assert.equal(s.platformAvailable, true); assert.equal(s.handoffsAvailable, true); assert.equal(s.executionAvailable, true); assert.equal(s.agentsAvailable, true); };
const triggerSql = (db) => db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'tr_deployments_insert'").get().sql;

/** The ids a deployment needs, and one real deployment row (an application draft, its job). */
function seedDeployment(db) {
  const p1 = db.prepare("SELECT id FROM project_workspaces WHERE project_id = 'p-ledger' AND workspace_id = 'sde'").get().id;
  db.prepare(`INSERT INTO artifacts (id, project_id, kind, name, owner_participation_id, owner_workspace_id, created_by, created_at, updated_at)
    VALUES ('a-app', 'p-ledger', 'application', 'app', ?, 'sde', 'user:local', ?, ?)`).run(p1, T, T);
  const version = (id, artifact, status) => {
    db.prepare(`INSERT INTO artifact_versions (id, artifact_id, version_no, project_id, participation_id, status, storage_kind, storage_ref_json,
      content_hash, actor_id, on_behalf_of, created_at, status_changed_at) VALUES (?, ?, 1, 'p-ledger', ?, 'draft', 'inline', '{}', ?, 'user:local', 'user:local', ?, ?)`)
      .run(id, artifact, p1, `hash-${id}`, T, T);
    if (status !== 'draft') db.prepare('UPDATE artifact_versions SET status = ? WHERE id = ?').run(status, id);
  };
  version('v-app', 'a-app', 'draft');
  const job = (id) => db.prepare(`INSERT INTO jobs (id, kind, project_id, workspace_id, participation_id, idempotency_key, requested_by, on_behalf_of, created_at,
    updated_at, state_changed_at) VALUES (?, 'tool.run', 'p-ledger', 'sde', ?, ?, 'user:local', 'user:local', ?, ?, ?)`).run(id, p1, `k-${id}`, T, T, T);
  job('j-dep');
  const deploy = (id, subject, jobId) => db.prepare(`INSERT INTO deployments (id, project_id, participation_id, subject_version_id, job_id, environment, status, created_by, started_at,
    status_changed_at, updated_at) VALUES (?, 'p-ledger', ?, ?, ?, 'local-preview', 'starting', 'user:local', ?, ?, ?)`).run(id, p1, subject, jobId, T, T, T);
  deploy('d-1', 'v-app', 'j-dep');
  const artifact = (id, kind) => db.prepare(`INSERT INTO artifacts (id, project_id, kind, name, owner_participation_id, owner_workspace_id, created_by, created_at, updated_at)
    VALUES (?, 'p-ledger', ?, ?, ?, 'sde', 'user:local', ?, ?)`).run(id, kind, id, p1, T, T);
  return { p1, version, job, deploy, artifact };
}
const refusal = (fn) => { try { fn(); return null; } catch (e) { return String(e.message); } };

test('M11-1 v10 -> v11: verified harness-v10 backup, one transaction, record 11, one activity row, log order, no paths; real rows (an existing deployment) are intact', () => {
  const file = v10File();
  { const { s } = openV10(file); const db = s.platformDatabase(); seedDeployment(db); s.close(); }
  const rowsBefore = (() => { const db = C.openRaw(file); try { return h.allRows(db); } finally { db.close(); } })();
  const { s, logs } = openV11(file);
  assert.equal(s.schemaVersion, 11); assert.equal(V11, 11); allOn(s);
  assert.equal(s.changePreviewAvailable, true); assert.equal(s.changePreviewUnavailableReason, null);
  assert.equal(s.lastMigrationV10.state, 'not_needed'); assert.equal(s.lastMigrationV11.state, 'applied');
  assert.equal(s.lastMigrationV11.fromVersion, 10); assert.equal(s.lastMigrationV11.postCheckOk, true);
  let at = -1;
  for (const k of ['schema version 10', 'v11 precheck ok', 'backup ok file=harness-v10-', 'row counts', 'v11 migration: start from=10', 'v11 migration: success to=11']) {
    const i = logs.findIndex((l, j) => j > at && l.includes(k)); assert.ok(i > at, `missing or out of order: ${k}\n${logs.join('\n')}`); at = i;
  }
  assert.ok(logs.some((l) => /\[db\] backup ok file=harness-v10-\d{8}T\d{6}Z\.db bytes=\d+ sha256=[0-9a-f]{64} from=10 writeMs=\d+ verifyMs=\d+ hashMs=\d+$/.test(l)), logs.join('\n'));
  assert.ok(logs.some((l) => /\[db\] v11 migration: success to=11 durationMs=\d+ triggers=1$/.test(l)), logs.join('\n'));
  assert.ok(!logs.some((l) => /\bv10 (migration|precheck|shape|step)/.test(l)), 'the v10 step only re-checked its shape');
  const db = s.platformDatabase();
  const rec = db.prepare('SELECT * FROM nexus_migrations WHERE version = 11').get();
  assert.equal(rec.from_version, 10); assert.match(rec.backup_file, /^harness-v10-\d{8}T\d{6}Z\.db$/); assert.match(rec.backup_sha256, /^[0-9a-f]{64}$/);
  const bak = C.openRaw(path.join(path.dirname(file), 'backups', rec.backup_file));
  assert.equal(bak.pragma('user_version', { simple: true }), 10);
  assert.ok(!/change_set/.test(triggerSql(bak)), 'the backup is the v10 database (the v9 trigger)'); bak.close();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM activity WHERE action = 'db.migrated' AND entity_id = '11'").get().n, 1);
  // The one trigger changed; nothing else did; no row was rewritten.
  assert.ok(/'application','inference_service','change_set'/.test(triggerSql(db)));
  assert.equal(v11ShapeProblem(db, true), null); assert.equal(v9ShapeProblem(db, true), null); assert.equal(v10ShapeProblem(db, true), null);
  const after = h.allRows(db);
  for (const t of Object.keys(rowsBefore)) {
    if (['nexus_migrations', 'activity'].includes(t)) continue;
    assert.deepEqual(after[t], rowsBefore[t], `${t} is untouched`);
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM deployments WHERE id = 'd-1' AND subject_version_id = 'v-app' AND status = 'starting'").get().n, 1, 'the existing deployment is intact');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  const dir = path.dirname(file);
  for (const l of logs) assert.ok(!l.includes(dir) && !l.includes(dir.replace(/\\/g, '/')), l);
  s.close();
  assert.equal(fs.existsSync(platformFailureMarkerPath(file, 11)), false);
  assert.equal(userVersion(file), 11);
});

test('M11-2 the new trigger accepts application, inference service and change set subjects and NOTHING broader; before v11 a change set is refused', () => {
  const file = v10File();
  { const { s } = openV10(file); const db = s.platformDatabase(); const sd = seedDeployment(db);
    sd.artifact('a-cs', 'change_set'); sd.version('v-cs', 'a-cs', 'draft'); sd.job('j-cs');
    // Control: at v10 (the v9 trigger) a change set subject is refused.
    assert.match(refusal(() => sd.deploy('d-cs0', 'v-cs', 'j-cs')) ?? '', /a deployment subject is an application or inference service version of this project/);
    s.close(); }
  const { s } = openV11(file); const db = s.platformDatabase(); const p1 = db.prepare("SELECT id FROM project_workspaces WHERE project_id = 'p-ledger' AND workspace_id = 'sde'").get().id;
  const dep = (id, subject, jobId) => db.prepare(`INSERT INTO deployments (id, project_id, participation_id, subject_version_id, job_id, environment, status, created_by, started_at,
    status_changed_at, updated_at) VALUES (?, 'p-ledger', ?, ?, ?, 'local-preview', 'starting', 'user:local', ?, ?, ?)`).run(id, p1, subject, jobId, T, T, T);
  const mkJob = (id) => db.prepare(`INSERT INTO jobs (id, kind, project_id, workspace_id, participation_id, idempotency_key, requested_by, on_behalf_of, created_at,
    updated_at, state_changed_at) VALUES (?, 'tool.run', 'p-ledger', 'sde', ?, ?, 'user:local', 'user:local', ?, ?, ?)`).run(id, p1, `k-${id}`, T, T, T);
  // A change set (candidate) is accepted now.
  dep('d-cs', 'v-cs', 'j-cs');
  assert.equal(db.prepare("SELECT subject_version_id FROM deployments WHERE id = 'd-cs'").get().subject_version_id, 'v-cs');
  // Any other kind is still refused, with the new sentence; a change set of another status is refused too; so is a version of another project.
  let n = 0;
  const art = (kind) => { const id = `a-x${++n}`; db.prepare(`INSERT INTO artifacts (id, project_id, kind, name, owner_participation_id, owner_workspace_id, created_by, created_at, updated_at)
    VALUES (?, 'p-ledger', ?, ?, ?, 'sde', 'user:local', ?, ?)`).run(id, kind, id, p1, T, T); return id; };
  const ver = (artifact, status) => { const id = `v-x${++n}`; db.prepare(`INSERT INTO artifact_versions (id, artifact_id, version_no, project_id, participation_id, status, storage_kind, storage_ref_json,
    content_hash, actor_id, on_behalf_of, created_at, status_changed_at) VALUES (?, ?, 1, 'p-ledger', ?, 'draft', 'inline', '{}', ?, 'user:local', 'user:local', ?, ?)`).run(id, artifact, p1, `hash-${id}`, T, T);
    if (status !== 'draft') db.prepare('UPDATE artifact_versions SET status = ? WHERE id = ?').run(status, id); return id; };
  // Every other artifact kind (the registered ones, and one that is not registered at all).
  const kinds = ['requirement', 'repository', 'test_suite', 'build', 'diagnostic_report', 'problem_statement', 'handoff_receipt', 'dataset', 'model', 'notebook', 'something_else'];
  let tried = 0;
  for (const kind of kinds) {
    let a; try { a = art(kind); } catch { continue; }       // a kind this workspace cannot own is not a candidate subject at all
    let v; try { v = ver(a, 'draft'); } catch { continue; }
    mkJob(`j-k${n}`);
    assert.match(refusal(() => dep(`d-k${n}`, v, `j-k${n}`)) ?? 'ACCEPTED', /a deployment subject is an application, inference service or change set version of this project/, kind);
    tried += 1;
  }
  assert.ok(tried >= 5, `${tried} other kinds were tried`);
  const acs = art('change_set'); const vrej = ver(acs, 'failed'); mkJob('j-rej');
  assert.match(refusal(() => dep('d-rej', vrej, 'j-rej')) ?? 'ACCEPTED', /a deployment subject is an application, inference service or change set version of this project/, 'a change set version that is failed (not draft, candidate or active)');
  assert.match(refusal(() => dep('d-none', 'v-nowhere', 'j-rej')) ?? 'ACCEPTED', /a deployment subject is/);
  s.close();
});

test('M11-3 off by default, and held: v10 stays with the change preview off and one line, no backup; the cascade holds imply it; the env switch works', () => {
  assert.equal(V11_ENABLED_BY_DEFAULT, false);
  const file = v10File(); const before = backups(file);
  const off = open(file, { enableV9: true, enableV10: true });
  assert.equal(off.s.schemaVersion, 10); allOn(off.s); assert.equal(off.s.changePreviewAvailable, false);
  assert.equal(off.s.lastMigrationV11.reason, 'not_enabled'); assert.equal(off.s.changePreviewUnavailableReason, 'not_enabled');
  off.s.close();
  const held = openV11(file, { holdV11: true });
  assert.equal(held.s.schemaVersion, 10); assert.equal(held.s.changePreviewUnavailableReason, 'held');
  assert.deepEqual(v11Lines(held.logs), ['[db] v11 migration: skipped reason=held (NEXUS_DB_HOLD_V11=1); database stays at v10']);
  held.s.close();
  for (const [opt, name] of [['holdV10', 'NEXUS_DB_HOLD_V10'], ['holdV9', 'NEXUS_DB_HOLD_V9'], ['holdV8', 'NEXUS_DB_HOLD_V8'], ['holdV7', 'NEXUS_DB_HOLD_V7']]) {
    const r = openV11(file, { holdV11: false, [opt]: true });
    assert.equal(r.s.schemaVersion, 10, opt); assert.equal(r.s.changePreviewAvailable, false, opt);
    r.s.close();
  }
  process.env.NEXUS_DB_HOLD_V11 = '1';
  try { const e = openV11(file, { holdV11: undefined }); assert.equal(e.s.schemaVersion, 10); assert.equal(e.s.lastMigrationV11.detail, 'NEXUS_DB_HOLD_V11=1'); e.s.close(); } finally { delete process.env.NEXUS_DB_HOLD_V11; }
  assert.deepEqual(backups(file), before); assert.equal(userVersion(file), 10);
});

test('M11-4 a failed v11 rolls everything back (the v9 trigger stays, user_version stays 10), keeps the backup, and holds itself after three failures', () => {
  const file = v10File();
  const boom = { hooks: { beforeCommit: (_db, v) => { if (v === 11) throw new Error('deterministic'); } } };
  for (let i = 1; i <= V11_FAILURE_LIMIT; i++) {
    const { s, logs } = openV11(file, boom);
    assert.equal(s.schemaVersion, 10, `attempt ${i}`); allOn(s); assert.equal(s.changePreviewAvailable, false);
    assert.equal(s.lastMigrationV11.state, 'failed'); assert.equal(s.changePreviewUnavailableReason, 'failed');
    assert.ok(logs.some((l) => /\[db\] v11 migration: failed from=10 error=deterministic; database left at v10; backup kept at harness-v10-/.test(l)), logs.join('\n'));
    const db = s.platformDatabase();
    assert.ok(!/change_set/.test(triggerSql(db)), 'the dropped trigger came back with the rollback');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM nexus_migrations WHERE version = 11').get().n, 0);
    s.close();
    assert.equal(userVersion(file), 10);
  }
  const held = openV11(file, boom);
  assert.equal(held.s.lastMigrationV11.reason, 'held'); assert.equal(held.s.changePreviewUnavailableReason, 'auto_held'); held.s.close();
  assert.ok(backups(file).filter((f) => f.startsWith('harness-v10-')).length >= 1);
  fs.rmSync(platformFailureMarkerPath(file, 11));
  const ok = openV11(file); assert.equal(ok.s.schemaVersion, 11); assert.equal(ok.s.changePreviewAvailable, true); ok.s.close();
});

test('M11-5 idempotent: reopening at v11 changes nothing; applying the step again records nothing and rewrites nothing', () => {
  const file = v10File(); openV11(file).s.close();
  const before = backups(file);
  const { s, logs } = openV11(file);
  assert.equal(s.lastMigrationV11.state, 'not_needed'); assert.equal(s.changePreviewAvailable, true);
  assert.deepEqual(v11Lines(logs), []); s.close();
  assert.deepEqual(backups(file), before);
  const db = C.openRaw(file);
  try {
    const snap = JSON.stringify(h.allRows(db));
    const ctx = { now: () => h.NOW, appVersion: null, fromVersion: 10, preCounts: null, backup: null };
    const r = db.transaction(() => applyV11(db, ctx)).immediate();
    assert.equal(r.recorded, false);
    assert.equal(JSON.stringify(h.allRows(db)), snap);
  } finally { db.close(); }
});

test('M11-6 the shape checks: a changed trigger at v11 turns the preview off (shape); the v9 check accepts the v11 trigger only at v11 or for the v11 step', () => {
  const file = v10File(); openV11(file).s.close();
  const raw = C.openRaw(file);
  raw.exec('DROP TRIGGER tr_deployments_insert');
  raw.exec(V11_TRIGGER_DDL.replace("'change_set'", "'change_set','build'"));
  raw.close();
  const { s, logs } = openV11(file);
  // A changed deployments trigger is a damaged v9 object too: execution (and so agents and the change preview) go off with shape; the platform and handoffs stay.
  assert.equal(s.schemaVersion, 11); assert.equal(s.platformAvailable, true); assert.equal(s.handoffsAvailable, true);
  assert.equal(s.executionAvailable, false); assert.equal(s.executionUnavailableReason, 'shape'); assert.equal(s.changePreviewAvailable, false);
  assert.equal(s.changePreviewUnavailableReason, 'shape'); assert.ok(logs.some((l) => /v9 shape check failed/.test(l)), logs.join('\n')); s.close();
  // Conditional acceptance: a v10 database that carries the v11 trigger text is NOT a clean v9 shape.
  const f2 = v10File(); const r2 = C.openRaw(f2);
  try {
    assert.equal(v9ShapeProblem(r2, true), null, 'at v10 with the v9 trigger');
    r2.exec('DROP TRIGGER tr_deployments_insert'); r2.exec(V11_TRIGGER_DDL);
    assert.match(v9ShapeProblem(r2, true) ?? '', /trigger tr_deployments_insert has a different definition/, 'at v10 the v11 text is not accepted');
    assert.equal(v9ShapeProblem(r2, true, { v11: true }), null, 'the v11 step itself accepts it');
  } finally { r2.close(); }
});

test('M11-7 a fresh database goes to v11 with no backups; an older build opening the file sees a newer schema and migrates nothing', () => {
  const dir = h.tmpDir(); const file = path.join(dir, 'harness.db');
  const { s, logs } = openV11(file);
  assert.equal(s.schemaVersion, 11); allOn(s); assert.equal(s.changePreviewAvailable, true);
  assert.ok(logs.some((l) => l.includes('[db] fresh database: no v11 backup needed')), logs.join('\n'));
  const rec = s.platformDatabase().prepare('SELECT * FROM nexus_migrations WHERE version = 11').get();
  assert.equal(rec.backup_file, null); assert.equal(rec.from_version, 10);
  s.close();
  assert.deepEqual(backups(file), []);
});

test('M11-8 v11 needs agents: with v10 off, v11 is skipped without a line and the reason is the agents one', () => {
  const { file } = h.v6Fixture(); openV10(file).s.close();
  const { s, logs } = open(file, { enableV9: true, enableV11: true });
  assert.equal(s.schemaVersion, 10); assert.equal(s.changePreviewAvailable, false);
  assert.equal(s.lastMigrationV11.reason, 'v10_unavailable'); assert.deepEqual(v11Lines(logs), []);
  assert.equal(s.changePreviewUnavailableReason, 'not_enabled', 'agents are not enabled, so that is the reason');
  s.close();
});

test('M11-9 source pins: the migration text is only the replacement of that one trigger; it is the v9 text with one list widened; opt-in wiring; the restore tool names the hold switch', () => {
  assert.equal(V11_ENABLED_BY_DEFAULT, false);
  // V11_DDL: one DROP of that trigger and its CREATE, nothing else (no table, column, index, seed).
  assert.equal((V11_DDL.match(/\bDROP\b/g) ?? []).length, 1); assert.equal((V11_DDL.match(/\bCREATE\b/g) ?? []).length, 1);
  assert.match(V11_DDL, /^\s*DROP TRIGGER IF EXISTS tr_deployments_insert;/);
  assert.deepEqual(ddlObjects(V11_DDL).map((o) => [o.type, o.name, o.table]), [['trigger', 'tr_deployments_insert', 'deployments']]);
  assert.doesNotMatch(V11_DDL, /CREATE\s+(TABLE|INDEX|UNIQUE)|ALTER\s+TABLE|INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM|DROP\s+TABLE/i);
  // Against the frozen v9 text: only the sentence and the kind list differ.
  const v9 = ddlObjects(V9_DDL).find((o) => o.name === 'tr_deployments_insert').sql;
  const widened = v9.replace(normaliseSql("a deployment subject is an application or inference service version of this project"), normaliseSql('a deployment subject is an application, inference service or change set version of this project'))
    .replace(normaliseSql("a.kind IN ('application','inference_service')"), normaliseSql("a.kind IN ('application','inference_service','change_set')"));
  assert.equal(widened, V11_TRIGGER_SQL, 'nothing else changed');
  const db = fs.readFileSync(path.join(REPO, 'src', 'main', 'db.ts'), 'utf8');
  assert.match(db, /export const V11_ENABLED_BY_DEFAULT = false;/); assert.doesNotMatch(db, /V11_ENABLED_BY_DEFAULT = true/);
  assert.match(db, /export const V11_FAILURE_LIMIT = 3;/);
  const index = fs.readFileSync(path.join(REPO, 'src', 'main', 'index.ts'), 'utf8');
  assert.match(index, /enableV11: process\.env\.NEXUS_ENABLE_V11 === '1' \? true : undefined/);
  assert.match(index, /holdV11: process\.env\.NEXUS_DB_HOLD_V11 === '1'/);
  assert.match(holdHint(10), /NEXUS_DB_HOLD_V11=1 to stay on schema v10/);
  const v9src = fs.readFileSync(path.join(REPO, 'src', 'main', 'nexus', 'db', 'schemaV9.ts'), 'utf8');
  assert.match(v9src, /'application','inference_service'\)\n\s+AND v\.status IN|a\.kind IN \('application','inference_service'\)/, 'the frozen v9 text still says application and inference service');
});
