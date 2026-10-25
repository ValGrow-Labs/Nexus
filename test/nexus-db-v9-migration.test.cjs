'use strict';
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
// B2a Task 10 fix round 3: every store and raw handle this file opens is closed, and its temp dirs removed, by one after hook.
const C = require('./helpers/cleanup.cjs'); C.cleanupAfterAll();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { PersistStore: PersistStoreUntracked, platformFailureMarkerPath, V9_ENABLED_BY_DEFAULT } = loadTs('src/main/db.ts');
/** Every store this file opens is tracked: the cleanup hook closes it even when a test fails before its own close(). */
class PersistStore extends PersistStoreUntracked { constructor(...a) { super(...a); C.track(this); } }
const { createNexusPlatform } = loadTs('src/main/nexus/platform.ts');
/** Every log line of every open() in this file, with the folder of its database (M12). */
const ALL_LOGS = [];
const open = (file, o = {}) => { const logs = []; const s = new PersistStore(file);
  s.open({ log: (l) => { logs.push(l); ALL_LOGS.push({ line: l, dir: path.dirname(file) }); },
    backupDir: path.join(path.dirname(file), 'backups'), now: () => h.NOW, ...o });
  return { s, logs }; };
/** v9 is off until verified: every case that wants the v9 step asks for it. */
const openV9 = (file, o = {}) => open(file, { enableV9: true, ...o });
// holdV9 keeps this a v8 file whatever the default of enableV9 becomes.
const v8File = () => { const { file } = h.v6Fixture(); open(file, { holdV9: true }).s.close(); return file; };
const v9File = () => { const file = v8File(); openV9(file).s.close(); return file; };
const inOrder = (logs, keys) => { let at = -1; for (const k of keys) {
  const i = logs.findIndex((l, j) => j > at && l.includes(k)); assert.ok(i > at, `missing or out of order: ${k}`); at = i; } };
const backups = (file) => { try { return fs.readdirSync(path.join(path.dirname(file), 'backups')).filter((f) => f.endsWith('.db')).sort(); } catch { return []; } };
const userVersion = (file) => { const db = C.openRaw(file); try { return db.pragma('user_version', { simple: true }); } finally { db.close(); } };
const v9Objects = (db) => db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('job_attempts', 'blobs', 'approvals', 'deployments',
  'job_events', 'validations', 'tr_jobs_completed_needs_attempt', 'ix_jobs_sched')`).get().n;

test('M0 v9 is off by default: a v8 file stays at v8 with one line, execution not_enabled, platform and handoffs on', () => {
  assert.equal(V9_ENABLED_BY_DEFAULT, false);
  const file = v8File(); const before = backups(file);
  const { s, logs } = open(file);
  assert.equal(s.schemaVersion, 8); assert.equal(s.platformAvailable, true); assert.equal(s.handoffsAvailable, true);
  assert.equal(s.executionAvailable, false); assert.equal(s.executionUnavailableReason, 'not_enabled');
  assert.equal(s.lastMigrationV9.state, 'skipped'); assert.equal(s.lastMigrationV9.reason, 'not_enabled');
  assert.deepEqual(logs.filter((l) => /v9/.test(l)).map((l) => l.replace(/^\S+ /, '')), ['[db] v9 migration: not enabled; database stays at v8']);
  // A hold switch changes nothing while v9 is off: the not-enabled line still says why.
  s.close();
  const held = open(file, { holdV9: true });
  assert.equal(held.s.lastMigrationV9.reason, 'not_enabled'); assert.equal(held.s.executionUnavailableReason, 'not_enabled');
  held.s.close();
  assert.deepEqual(backups(file), before); assert.equal(userVersion(file), 8);
  assert.equal(fs.existsSync(platformFailureMarkerPath(file, 9)), false);
});

test('M1 v8 -> v9: verified harness-v8 backup, one transaction, record 9, one activity row, log order, no paths', () => {
  const file = v8File(); const { s, logs } = openV9(file);
  assert.equal(s.schemaVersion, 9); assert.equal(s.platformAvailable, true);
  assert.equal(s.handoffsAvailable, true); assert.equal(s.executionAvailable, true);
  assert.equal(s.executionUnavailableReason, null);
  assert.equal(s.lastMigrationV8.state, 'not_needed'); assert.equal(s.lastMigrationV9.state, 'applied');
  inOrder(logs, ['schema version 8', 'v9 precheck ok', 'backup ok file=harness-v8-', 'row counts',
    'v9 migration: start from=8', 'v9 migration: success to=9']);
  assert.ok(logs.some((l) => /\[db\] v9 precheck ok integrity=ok integrityMs=\d+ free=(\d+|unknown) needed=\d+$/.test(l)), logs.join('\n'));
  assert.ok(logs.some((l) => /\[db\] backup ok file=harness-v8-\d{8}T\d{6}Z\.db bytes=\d+ sha256=[0-9a-f]{64} from=8 writeMs=\d+ verifyMs=\d+ hashMs=\d+$/.test(l)), logs.join('\n'));
  assert.ok(logs.some((l) => /\[db\] v9 migration: success to=9 durationMs=\d+ attemptStates=7 approvalStates=5 deploymentStates=5 relationsAdded=4$/.test(l)), logs.join('\n'));
  const db = s.platformDatabase();
  const rec = db.prepare('SELECT * FROM nexus_migrations WHERE version = 9').get();
  assert.equal(rec.from_version, 8); assert.match(rec.backup_file, /^harness-v8-\d{8}T\d{6}Z\.db$/);
  const bak = C.openRaw(path.join(path.dirname(file), 'backups', rec.backup_file));
  assert.equal(bak.pragma('user_version', { simple: true }), 8);
  assert.equal(bak.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'job_attempts'").get().n, 0); bak.close();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM activity WHERE action = 'db.migrated' AND entity_id = '9'").get().n, 1);
  for (const t of h.LEGACY_TABLES) assert.equal(h.count(db, t), JSON.parse(rec.row_counts_json)[t], t);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  const dir = path.dirname(file);
  for (const l of logs) assert.ok(!l.includes(dir) && !l.includes(dir.replace(/\\/g, '/')), l);
  s.close();
  assert.equal(fs.existsSync(platformFailureMarkerPath(file, 9)), false);
});

test('M2 v6 -> v7 -> v8 -> v9 in one launch: three backups; the v7 and v8 lines keep their pinned forms', () => {
  const { file } = h.v6Fixture(); const { s, logs } = openV9(file);
  const b = backups(file);
  assert.equal(b.length, 3);
  assert.match(b[0], /^harness-v6-/); assert.match(b[1], /^harness-v7-/); assert.match(b[2], /^harness-v8-/);
  assert.equal(s.schemaVersion, 9); assert.equal(s.executionAvailable, true);
  assert.equal(s.lastMigration.state, 'applied'); assert.equal(s.lastMigrationV8.state, 'applied'); assert.equal(s.lastMigrationV9.state, 'applied');
  inOrder(logs, ['schema version 6', 'v7 precheck ok', 'backup ok file=harness-v6-', 'v7 migration: start from=6', 'v7 migration: success to=7',
    'v8 precheck ok', 'backup ok file=harness-v7-', 'v8 migration: start from=7', 'v8 migration: success to=8',
    'v9 precheck ok', 'backup ok file=harness-v8-', 'v9 migration: start from=8', 'v9 migration: success to=9']);
  const pinned = [
    /\[db\] v7 precheck ok integrity=ok integrityMs=\d+ free=(\d+|unknown) needed=\d+$/,
    /\[db\] backup ok file=harness-v6-\d{8}T\d{6}Z\.db bytes=\d+ sha256=[0-9a-f]{64} from=6 writeMs=\d+ verifyMs=\d+ hashMs=\d+$/,
    /\[db\] v7 migration: start from=6$/,
    /\[db\] v7 migration: success to=7 durationMs=\d+ backfilled=\d+ unassigned=\d+$/,
    /\[db\] v8 precheck ok integrity=ok integrityMs=\d+ free=(\d+|unknown) needed=\d+$/,
    /\[db\] backup ok file=harness-v7-\d{8}T\d{6}Z\.db bytes=\d+ sha256=[0-9a-f]{64} from=7 writeMs=\d+ verifyMs=\d+ hashMs=\d+$/,
    /\[db\] v8 migration: start from=7$/,
    /\[db\] v8 migration: success to=8 durationMs=\d+ handoffStates=4 handoffTransitions=3$/
  ];
  for (const re of pinned) assert.ok(logs.some((l) => re.test(l)), `${re}\n${logs.join('\n')}`);
  assert.equal(logs.filter((l) => /\[db\] row counts /.test(l)).length, 3);
  assert.equal(s.platformDatabase().prepare('SELECT COUNT(*) n FROM nexus_migrations').get().n, 3);
  s.close();
});

test('M3 a throw inside the v9 transaction leaves v8 with platform and handoffs on, execution off; marker 1 of 3', () => {
  const file = v8File();
  const { s, logs } = openV9(file, { hooks: { beforeCommit: (_db, v) => { if (v === 9) throw new Error('injected'); } } });
  assert.equal(s.schemaVersion, 8); assert.equal(s.platformAvailable, true); assert.equal(s.handoffsAvailable, true);
  assert.equal(s.executionAvailable, false); assert.equal(s.executionUnavailableReason, 'failed');
  assert.equal(s.lastMigrationV9.state, 'failed');
  assert.equal(s.platformDatabase().prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('job_attempts','blobs')").get().n, 0);
  const failed = logs.find((l) => l.includes('v9 migration: failed'));
  assert.match(failed, /\[db\] v9 migration: failed from=8 error=injected; database left at v8; backup kept at harness-v8-\d{8}T\d{6}Z\.db$/);
  assert.equal(s.lastMigrationV9.backupFile, failed.match(/backup kept at (\S+)$/)[1]);
  assert.ok(logs.some((l) => /\[db\] v9 migration will be retried at the next launch \(failure 1 of 3\); set NEXUS_DB_HOLD_V9=1 to stay on v8$/.test(l)), logs.join('\n'));
  assert.equal(JSON.parse(fs.readFileSync(platformFailureMarkerPath(file, 9), 'utf8')).count, 1);
  assert.equal(fs.existsSync(platformFailureMarkerPath(file, 8)), false);
  assert.equal(s.platformDatabase().prepare('SELECT COUNT(*) n FROM nexus_migrations WHERE version = 9').get().n, 0);
  s.setKv('after_v9_failure', 1); assert.equal(s.getKv('after_v9_failure'), 1);
  s.close();
  assert.equal(userVersion(file), 8);
});

test('M4 three failures hold v9 at the fourth launch with no new backup; deleting the marker lets v9 apply', () => {
  const file = v8File(); const marker = platformFailureMarkerPath(file, 9);
  let t = h.NOW;
  const launch = (extra = {}) => { t += 60_000; const at = t; return openV9(file, { now: () => at, ...extra }); };
  const boom = { hooks: { beforeCommit: (_db, v) => { if (v === 9) throw new Error('deterministic'); } } };
  for (let n = 1; n <= 3; n++) {
    const { s, logs } = launch(boom);
    assert.equal(s.lastMigrationV9.state, 'failed'); assert.equal(s.schemaVersion, 8); s.close();
    assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).count, n);
    if (n === 3) assert.ok(logs.some((l) => /\[db\] v9 migration has failed 3 times in a row; it is held from the next launch \(held: repeated_failure\)$/.test(l)));
  }
  const before = backups(file);
  assert.equal(before.filter((f) => f.startsWith('harness-v8-')).length, 3);
  const held = launch(boom);
  assert.equal(held.s.schemaVersion, 8); assert.equal(held.s.handoffsAvailable, true); assert.equal(held.s.executionAvailable, false);
  assert.equal(held.s.lastMigrationV9.state, 'skipped'); assert.equal(held.s.lastMigrationV9.reason, 'held');
  assert.equal(held.s.lastMigrationV9.detail, 'repeated_failure count=3'); assert.equal(held.s.executionUnavailableReason, 'auto_held');
  assert.ok(held.logs.some((l) => /\[db\] v9 migration: skipped reason=held: repeated_failure count=3; database stays at v8; no new backup taken$/.test(l)));
  assert.ok(held.logs.some((l) => /\[db\] to retry v9, quit and delete harness\.db\.v9-failures\.json next to harness\.db; existing backups are kept \(restore one with the restore tool, tools\/nexus-db-restore\.cjs, if needed\)$/.test(l)));
  assert.ok(!held.logs.some((l) => /v9 precheck|backup ok|v9 migration: start/.test(l)));
  held.s.close();
  assert.deepEqual(backups(file), before, 'no new backup while held');
  fs.rmSync(marker);
  const ok = launch();
  assert.equal(ok.s.schemaVersion, 9); assert.equal(ok.s.lastMigrationV9.state, 'applied'); assert.equal(ok.s.executionAvailable, true);
  ok.s.close();
  assert.equal(fs.existsSync(marker), false);
});

test('M5 holdV9 keeps v8 with execution off (held), one hold line, no backup', () => {
  const file = v8File(); const before = backups(file);
  const { s, logs } = openV9(file, { holdV9: true });
  assert.equal(s.schemaVersion, 8); assert.equal(s.handoffsAvailable, true); assert.equal(s.executionAvailable, false);
  assert.equal(s.lastMigrationV9.state, 'skipped'); assert.equal(s.lastMigrationV9.reason, 'held'); assert.equal(s.lastMigrationV9.detail, 'NEXUS_DB_HOLD_V9=1');
  assert.equal(s.executionUnavailableReason, 'held');
  assert.ok(/\[db\] v9 migration: skipped reason=held \(NEXUS_DB_HOLD_V9=1\); database stays at v8$/.test(logs[logs.length - 1]), logs.join('\n'));
  assert.equal(logs.filter((l) => /v9/.test(l)).length, 1, logs.join('\n'));
  s.close();
  assert.deepEqual(backups(file), before); assert.equal(userVersion(file), 8);
  assert.equal(fs.existsSync(platformFailureMarkerPath(file, 9)), false);
});

test('M5a the hold also comes from NEXUS_DB_HOLD_V9=1 in the environment', () => {
  const file = v8File();
  process.env.NEXUS_DB_HOLD_V9 = '1';
  try {
    const { s, logs } = openV9(file);
    assert.equal(s.schemaVersion, 8); assert.equal(s.lastMigrationV9.reason, 'held');
    assert.ok(logs.some((l) => /v9 migration: skipped reason=held \(NEXUS_DB_HOLD_V9=1\)/.test(l))); s.close();
  } finally { delete process.env.NEXUS_DB_HOLD_V9; }
});

test('M5b holdV8 on a v8 file implies the v9 hold, and the line names NEXUS_DB_HOLD_V8=1', () => {
  const file = v8File(); const before = backups(file);
  const { s, logs } = openV9(file, { holdV8: true });
  assert.equal(s.schemaVersion, 8); assert.equal(s.handoffsAvailable, true); assert.equal(s.executionAvailable, false);
  assert.equal(s.lastMigrationV8.state, 'not_needed');
  assert.equal(s.lastMigrationV9.reason, 'held'); assert.equal(s.lastMigrationV9.detail, 'NEXUS_DB_HOLD_V8=1');
  assert.ok(logs.some((l) => /\[db\] v9 migration: skipped reason=held \(NEXUS_DB_HOLD_V8=1\); database stays at v8$/.test(l)), logs.join('\n'));
  s.close(); assert.deepEqual(backups(file), before);
  const v7held = openV9(file, { holdV7: true });
  assert.equal(v7held.s.lastMigrationV9.detail, 'NEXUS_DB_HOLD_V7=1');
  assert.ok(v7held.logs.some((l) => /\[db\] v9 migration: skipped reason=held \(NEXUS_DB_HOLD_V7=1\); database stays at v8$/.test(l)));
  v7held.s.close();
});

test('M5c holdV7 on a v6 file gives v6; v8 and v9 are both skipped without a line', () => {
  const { file } = h.v6Fixture(); const { s, logs } = openV9(file, { holdV7: true });
  assert.equal(s.schemaVersion, 6); assert.equal(s.platformAvailable, false); assert.equal(s.executionAvailable, false);
  assert.equal(s.lastMigrationV8.reason, 'v7_unavailable');
  assert.equal(s.lastMigrationV9.state, 'skipped'); assert.equal(s.lastMigrationV9.reason, 'v8_unavailable');
  assert.equal(s.executionUnavailableReason, null);
  assert.ok(!logs.some((l) => /v8|v9/.test(l)), logs.join('\n'));
  s.close();
  assert.deepEqual(backups(file), []); assert.equal(userVersion(file), 6);
});

test('M5d holdV8 on a v6 file gives v7; v9 is skipped without a line and execution reports the v8 hold', () => {
  const { file } = h.v6Fixture(); const { s, logs } = openV9(file, { holdV8: true });
  assert.equal(s.schemaVersion, 7); assert.equal(s.platformAvailable, true); assert.equal(s.handoffsAvailable, false);
  assert.equal(s.lastMigrationV9.reason, 'v8_unavailable'); assert.equal(s.lastMigrationV9.detail, 'v8 held');
  assert.equal(s.executionUnavailableReason, 'held');
  assert.ok(!logs.some((l) => /v9/.test(l)), logs.join('\n'));
  s.close();
  assert.deepEqual(backups(file).map((f) => f.slice(0, 11)), ['harness-v6-']);
});

test('M6 a v8 shape problem turns handoffs off and skips v9 (v8_unavailable) with no v9 write', () => {
  const file = v8File();
  const pre = C.openRaw(file);
  pre.exec('DROP TRIGGER tr_handoffs_no_delete; CREATE TRIGGER tr_handoffs_no_delete BEFORE DELETE ON handoffs BEGIN SELECT 1; END;');
  pre.close();
  const before = backups(file);
  const { s, logs } = openV9(file);
  assert.equal(s.schemaVersion, 8); assert.equal(s.platformAvailable, true); assert.equal(s.handoffsAvailable, false);
  assert.equal(s.executionAvailable, false); assert.equal(s.executionUnavailableReason, 'shape');
  assert.equal(s.lastMigrationV9.state, 'skipped'); assert.equal(s.lastMigrationV9.reason, 'v8_unavailable');
  assert.ok(logs.some((l) => /v8 shape check failed/.test(l)));
  assert.ok(!logs.some((l) => /v9/.test(l)), logs.join('\n'));
  s.close();
  assert.deepEqual(backups(file), before);
  const db = C.openRaw(file);
  assert.equal(db.pragma('user_version', { simple: true }), 8); assert.equal(v9Objects(db), 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM nexus_migrations WHERE version = 9').get().n, 0);
  db.close();
  assert.equal(fs.existsSync(platformFailureMarkerPath(file, 9)), false);
});

test('M7 reopening at v9 is not_needed three times over with no backup; a damaged v9 trigger turns execution off only', () => {
  const file = v9File(); const before = backups(file);
  for (let i = 0; i < 2; i++) {
    const { s, logs } = openV9(file);
    assert.equal(s.schemaVersion, 9);
    assert.equal(s.lastMigration.state, 'not_needed'); assert.equal(s.lastMigrationV8.state, 'not_needed'); assert.equal(s.lastMigrationV9.state, 'not_needed');
    assert.equal(s.platformAvailable, true); assert.equal(s.handoffsAvailable, true); assert.equal(s.executionAvailable, true);
    assert.ok(!logs.some((l) => /backup ok|migration: start|v9 migration/.test(l)), logs.join('\n'));
    s.close();
  }
  // Opened without enableV9, a v9 file keeps the platform and handoffs; execution reports not_enabled.
  const off = open(file);
  assert.equal(off.s.schemaVersion, 9); assert.equal(off.s.platformAvailable, true); assert.equal(off.s.handoffsAvailable, true);
  assert.equal(off.s.executionAvailable, false); assert.equal(off.s.executionUnavailableReason, 'not_enabled');
  assert.equal(off.s.lastMigrationV9.state, 'not_needed');
  off.s.close();
  assert.deepEqual(backups(file), before);
  const db = C.openRaw(file);
  db.exec('DROP TRIGGER tr_job_events_no_delete; CREATE TRIGGER tr_job_events_no_delete BEFORE DELETE ON job_events BEGIN SELECT 1; END;');
  db.close();
  const { s, logs } = openV9(file);
  assert.equal(s.schemaVersion, 9); assert.equal(s.platformAvailable, true); assert.equal(s.handoffsAvailable, true);
  assert.equal(s.executionAvailable, false); assert.equal(s.executionUnavailableReason, 'shape');
  assert.ok(logs.some((l) => /\[db\] v9 shape check failed: trigger tr_job_events_no_delete has a different definition; execution disabled$/.test(l)), logs.join('\n'));
  s.close();
  assert.deepEqual(backups(file), before);
});

test('M8 a newer schema (v11) is opened for legacy use only: nothing migrated, platform off', () => {
  const file = v9File();
  const pre = C.openRaw(file); pre.pragma('user_version = 11'); pre.close();
  const before = backups(file);
  const { s, logs } = openV9(file);
  assert.equal(s.schemaVersion, 11); assert.equal(s.platformAvailable, false); assert.equal(s.platformDatabase(), null);
  assert.equal(s.executionAvailable, false); assert.equal(s.executionUnavailableReason, null);
  assert.equal(s.lastMigration.reason, 'newer_schema'); assert.equal(s.lastMigrationV8.reason, 'newer_schema'); assert.equal(s.lastMigrationV9.reason, 'newer_schema');
  assert.ok(logs.some((l) => l.includes('schema v11 is newer than this build (v10)')), logs.join('\n'));
  assert.equal(s.getKv('window_bounds').width, 1200);
  s.close();
  assert.deepEqual(backups(file), before); assert.equal(userVersion(file), 11);
});

test('M9 a fresh database goes to v9 with no backups', () => {
  const dir = h.tmpDir(); const file = path.join(dir, 'harness.db');
  const { s, logs } = openV9(file);
  assert.equal(s.schemaVersion, 9); assert.equal(s.executionAvailable, true);
  inOrder(logs, ['[db] fresh database: no backup needed', '[db] fresh database: no v8 backup needed', '[db] fresh database: no v9 backup needed',
    'v9 migration: start from=8', 'v9 migration: success to=9']);
  assert.ok(!logs.some((l) => /precheck/.test(l)));
  const rec = s.platformDatabase().prepare('SELECT * FROM nexus_migrations WHERE version = 9').get();
  assert.equal(rec.backup_file, null); assert.equal(rec.from_version, 8);
  s.close();
  assert.deepEqual(backups(file), []);
});

test('M10 at v9 a project with a deployment and its job has platform records; deleteProject refuses and writes nothing', () => {
  const file = v8File(); const { s } = openV9(file);
  assert.equal(s.schemaVersion, 9);
  const db = s.platformDatabase();
  const p1 = db.prepare("SELECT id FROM project_workspaces WHERE project_id = 'p-ledger' AND workspace_id = 'sde'").get().id;
  const T = h.NOW;
  db.prepare(`INSERT INTO artifacts (id, project_id, kind, name, owner_participation_id, owner_workspace_id, created_by, created_at, updated_at)
    VALUES ('a-app', 'p-ledger', 'application', 'app', ?, 'sde', 'user:local', ?, ?)`).run(p1, T, T);
  db.prepare(`INSERT INTO artifact_versions (id, artifact_id, version_no, project_id, participation_id, status, storage_kind, storage_ref_json,
    content_hash, actor_id, on_behalf_of, created_at, status_changed_at) VALUES ('v-app', 'a-app', 1, 'p-ledger', ?, 'draft', 'inline', '{}',
    'hash-v-app', 'user:local', 'user:local', ?, ?)`).run(p1, T, T);
  db.prepare(`INSERT INTO jobs (id, kind, project_id, workspace_id, participation_id, idempotency_key, requested_by, on_behalf_of, created_at,
    updated_at, state_changed_at) VALUES ('j-dep', 'tool.run', 'p-ledger', 'sde', ?, 'k-dep', 'user:local', 'user:local', ?, ?, ?)`).run(p1, T, T, T);
  db.prepare(`INSERT INTO deployments (id, project_id, participation_id, subject_version_id, job_id, environment, status, created_by, started_at,
    status_changed_at, updated_at) VALUES ('d-1', 'p-ledger', ?, 'v-app', 'j-dep', 'local-preview', 'starting', 'user:local', ?, ?, ?)`).run(p1, T, T, T);
  assert.equal(s.hasPlatformRecords('p-ledger'), true);
  assert.equal(s.hasPlatformRecords('p-sales'), false);
  const snap = h.allRows(db);
  assert.equal(s.deleteProject('p-ledger', { withGraph: true }), false);
  assert.deepEqual(h.allRows(db), snap);
  assert.equal(s.deleteProject('p-sales'), true);
  s.close();
});

test('M11 a precheck failure and insufficient disk skip v9 and leave v8 running', () => {
  for (const [hook, reason, detail] of [
    [() => { throw new Error('probe failed'); }, 'precheck_failed', /^probe failed$/],
    [() => 1024, 'insufficient_disk', /^free=1024 needed=\d+$/]
  ]) {
    const file = v8File(); const before = backups(file);
    const { s, logs } = openV9(file, { hooks: { freeBytes: hook } });
    assert.equal(s.schemaVersion, 8); assert.equal(s.handoffsAvailable, true); assert.equal(s.executionAvailable, false);
    assert.equal(s.lastMigrationV9.state, 'skipped'); assert.equal(s.lastMigrationV9.reason, reason);
    assert.match(s.lastMigrationV9.detail, detail); assert.equal(s.executionUnavailableReason, 'failed');
    assert.ok(logs.some((l) => new RegExp(`\\[db\\] v9 migration: skipped reason=${reason} detail=.*; database left at v8$`).test(l)), logs.join('\n'));
    s.setKv('still_writable', 1); assert.equal(s.getKv('still_writable'), 1);
    s.close();
    assert.deepEqual(backups(file), before); assert.equal(userVersion(file), 8);
    assert.equal(fs.existsSync(platformFailureMarkerPath(file, 9)), false, 'skips do not count as failures');
  }
});

test('M13 a process killed inside the v9 transaction leaves a v8 file with no v9 object', () => {
  const file = v8File();
  const pre = C.openRaw(file); const beforeRows = h.allRows(pre); pre.close();
  const r = spawnSync(process.execPath, [path.join(__dirname, 'helpers', 'migrate-and-die.cjs'), file, 'v9'],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' });
  assert.ok(r.status !== 0 || r.signal, `the child must be killed, got status=${r.status} signal=${r.signal} ${r.stderr}`);
  const died = /IN_TXN wal=(\d+)/.exec(r.stdout);
  assert.ok(died, `the child reached the open v9 transaction: ${r.stdout} ${r.stderr}`);
  assert.doesNotMatch(r.stdout, /NOT_KILLED/);
  assert.ok(Number(died[1]) > 0, 'uncommitted v9 frames were in the WAL when the process died');
  assert.equal(backups(file).filter((f) => f.startsWith('harness-v8-')).length, 1, 'the child died after its verified v8 backup');
  const db = C.openRaw(file);
  assert.equal(db.pragma('user_version', { simple: true }), 8);
  assert.equal(v9Objects(db), 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM nexus_migrations WHERE version = 9').get().n, 0);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(h.allRows(db), beforeRows, 'every row of every table is as it was before the kill');
  db.close();
  const { s } = openV9(file, { now: () => h.NOW + 60_000 }); assert.equal(s.schemaVersion, 9); assert.equal(s.executionAvailable, true); s.close();
});

test('M14 a v9 backup that cannot be written skips v9: v8 stays with handoffs on, no marker', () => {
  const file = v8File(); const dir = path.dirname(file);
  const blocker = path.join(dir, 'not-a-dir'); fs.writeFileSync(blocker, 'x');
  const { s, logs } = openV9(file, { backupDir: path.join(blocker, 'backups') });
  assert.equal(s.schemaVersion, 8); assert.equal(s.handoffsAvailable, true); assert.equal(s.executionAvailable, false);
  assert.equal(s.lastMigrationV9.state, 'skipped'); assert.equal(s.lastMigrationV9.reason, 'backup_failed');
  assert.equal(s.lastMigrationV9.detail, 'stage=write'); assert.equal(s.executionUnavailableReason, 'backup_failed');
  inOrder(logs, ['v9 precheck ok', 'backup failed stage=write error=', 'v9 migration: skipped reason=backup_failed detail=stage=write; database left at v8']);
  assert.ok(!logs.some((l) => /v9 migration: start/.test(l)));
  s.close();
  assert.equal(fs.existsSync(platformFailureMarkerPath(file, 9)), false);
  const db = C.openRaw(file);
  assert.equal(db.pragma('user_version', { simple: true }), 8); assert.equal(v9Objects(db), 0); db.close();
});

test('M15 a failing v9 post-check commits v9 but turns execution off and names the backup to restore', () => {
  const file = v8File();
  const { s, logs } = openV9(file, { hooks: { postCheck: (_db, v) => (v === 9 ? false : undefined) } });
  assert.equal(s.schemaVersion, 9); assert.equal(s.platformAvailable, true); assert.equal(s.handoffsAvailable, true);
  assert.equal(s.executionAvailable, false); assert.equal(s.executionUnavailableReason, 'failed');
  assert.equal(s.lastMigrationV9.state, 'applied'); assert.equal(s.lastMigrationV9.postCheckOk, false);
  assert.ok(logs.some((l) => /\[db\] v9 post-check FAILED; execution disabled; restore from backup harness-v8-\d{8}T\d{6}Z\.db$/.test(l)), logs.join('\n'));
  assert.ok(!logs.some((l) => /v9 migration: success/.test(l)));
  s.close();
  assert.equal(userVersion(file), 9);
});

test('M16 executionUnavailableReason: null when execution is on or the whole platform is off; every sub-reason as documented', () => {
  // Platform off (v7 held on a v6 file): the reason is the v7 side's.
  const off = openV9(h.v6Fixture().file, { holdV7: true });
  assert.equal(off.s.platformAvailable, false); assert.equal(off.s.executionUnavailableReason, null); off.s.close();
  // Execution on.
  const on = openV9(v8File());
  assert.equal(on.s.executionAvailable, true); assert.equal(on.s.executionUnavailableReason, null); on.s.close();
  // not enabled, held, failed (transaction), backup_failed, auto_held and shape are pinned in M0, M5, M3, M14, M4 and M7.
  const notEnabled = open(v8File()); assert.equal(notEnabled.s.executionUnavailableReason, 'not_enabled'); notEnabled.s.close();
  const held = openV9(v8File(), { holdV9: true }); assert.equal(held.s.executionUnavailableReason, 'held'); held.s.close();
  // v8 not in place: the handoffs reason (here the v8 transaction failed on a v7 file).
  const v7 = h.v6Fixture().file; open(v7, { holdV8: true }).s.close();
  const v8failed = openV9(v7, { hooks: { beforeCommit: (_db, v) => { if (v === 8) throw new Error('v8 only'); } } });
  assert.equal(v8failed.s.lastMigrationV9.reason, 'v8_unavailable'); assert.equal(v8failed.s.lastMigrationV9.detail, 'v8 failed');
  assert.equal(v8failed.s.handoffsUnavailableReason, 'failed'); assert.equal(v8failed.s.executionUnavailableReason, 'failed');
  v8failed.s.close();
});

test('M16b with v9 off, v8 not in place reports the v8 reason before not_enabled', () => {
  // A v7 file held at v7 (NEXUS_DB_HOLD_V8): the reason is the v8 hold, not not_enabled.
  const v7 = h.v6Fixture().file; open(v7, { holdV8: true }).s.close();
  const held = open(v7, { holdV8: true });
  assert.equal(held.s.schemaVersion, 7); assert.equal(held.s.lastMigrationV9.reason, 'v8_unavailable');
  assert.equal(held.s.executionUnavailableReason, 'held'); held.s.close();
  // A v8 shape problem with v9 off: shape, not not_enabled.
  const file = v8File();
  const pre = C.openRaw(file);
  pre.exec('DROP TRIGGER tr_handoffs_no_delete; CREATE TRIGGER tr_handoffs_no_delete BEFORE DELETE ON handoffs BEGIN SELECT 1; END;');
  pre.close();
  const shape = open(file);
  assert.equal(shape.s.handoffsAvailable, false); assert.equal(shape.s.executionUnavailableReason, 'shape'); shape.s.close();
  // v8 in place with v9 off: not_enabled.
  const ok = open(v8File()); assert.equal(ok.s.executionUnavailableReason, 'not_enabled'); ok.s.close();
});

test('M17 createNexusPlatform: execution is off unless the caller turns it on, and on only at v9 with the v9 shape', () => {
  const at8 = open(v8File());
  const p8 = createNexusPlatform(at8.s.platformDatabase(), { handoffs: at8.s.handoffsAvailable, execution: true });
  assert.equal(p8.executionAvailable, false, 'a forced true on a v8 database is refused');
  at8.s.close();
  const at9 = openV9(v8File());
  const db = at9.s.platformDatabase();
  assert.equal(createNexusPlatform(db, { handoffs: true }).executionAvailable, false, 'off by default');
  assert.equal(createNexusPlatform(db, { handoffs: true, execution: at9.s.executionAvailable }).executionAvailable, true);
  assert.equal(createNexusPlatform(db, { handoffs: false, execution: true }).executionAvailable, false, 'needs handoffs');
  at9.s.close();
});

// ─── the constraint-4 backstop through JobService at v9 (the B0b v8 cases stay as they are) ───

const T0 = h.NOW;
const BOOT = 'b'.repeat(26);
function v9Jobs() {
  const { s } = openV9(v8File());
  const db = s.platformDatabase();
  const nx = createNexusPlatform(db, { now: () => T0, handoffs: s.handoffsAvailable, execution: s.executionAvailable });
  return { s, db, nx, me: nx.principals.localUser(), sys: nx.principals.system() };
}
let k = 0;
const toolJob = (nx, me) => nx.jobs.create(me, { kind: 'tool.run', projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: `v9-intent-${++k}` }).job;
const insAttempt = (db, jobId, n) => db.prepare(`INSERT INTO job_attempts (id, job_id, n, state, boot_id, lease_owner, lease_expires_at, created_at, updated_at)
  VALUES (?, ?, ?, 'starting', ?, ?, ?, ?, ?)`).run(`att-${jobId}-${n}`, jobId, n, BOOT, BOOT, T0 + 60_000, T0, T0);
const runAttempt = (db, jobId, n) => db.prepare(`UPDATE job_attempts SET state = 'running', started_at = ?, sandbox_json = '{"network":"none"}',
  environment_json = '{"profile":"sde-node"}' WHERE job_id = ? AND n = ?`).run(T0 + 1, jobId, n);
const endAttempt = (db, jobId, n, state) => db.prepare(`UPDATE job_attempts SET state = ?, finished_at = ?, exit_code = ?, outcome = ?
  WHERE job_id = ? AND n = ?`).run(state, T0 + 2, state === 'succeeded' ? 0 : 1, state === 'succeeded' ? 'ok' : 'error', jobId, n);

test('B1 at v9 a tool.run job cannot complete or end partial through JobService without an attempt', () => {
  const { s, nx, me, sys } = v9Jobs();
  for (const [to, msg] of [['completed', /completes only when its current attempt succeeded/], ['partial', /ends partial only when its current attempt finished/]]) {
    const j = toolJob(nx, me);
    nx.jobs.transition(sys, j.id, 'leased'); nx.jobs.transition(sys, j.id, 'running');
    assert.throws(() => nx.jobs.transition(sys, j.id, to), (e) => msg.test(String(e && e.message)), to);
    assert.equal(nx.jobs.get(me, j.id).state, 'running', `${to} was refused and nothing changed`);
  }
  s.close();
});

test('B2 at v9 completion needs a succeeded current attempt; partial needs a finished one; a live attempt blocks both', () => {
  const { s, db, nx, me, sys } = v9Jobs();
  // A live attempt blocks the end.
  const live = toolJob(nx, me);
  nx.jobs.transition(sys, live.id, 'leased'); insAttempt(db, live.id, 1); nx.jobs.transition(sys, live.id, 'running'); runAttempt(db, live.id, 1);
  assert.throws(() => nx.jobs.transition(sys, live.id, 'completed'), (e) => /after its live attempt has ended|completes only when/.test(String(e && e.message)));
  // A failed attempt: completed is refused, partial is allowed.
  const failed = toolJob(nx, me);
  nx.jobs.transition(sys, failed.id, 'leased'); insAttempt(db, failed.id, 1); nx.jobs.transition(sys, failed.id, 'running');
  runAttempt(db, failed.id, 1); endAttempt(db, failed.id, 1, 'failed');
  assert.throws(() => nx.jobs.transition(sys, failed.id, 'completed'), (e) => /completes only when its current attempt succeeded/.test(String(e && e.message)));
  assert.equal(nx.jobs.transition(sys, failed.id, 'partial').state, 'partial');
  // A succeeded attempt: completed is allowed.
  const ok = toolJob(nx, me);
  nx.jobs.transition(sys, ok.id, 'leased'); insAttempt(db, ok.id, 1); nx.jobs.transition(sys, ok.id, 'running');
  runAttempt(db, ok.id, 1); endAttempt(db, ok.id, 1, 'succeeded');
  assert.equal(nx.jobs.transition(sys, ok.id, 'completed').state, 'completed');
  s.close();
});

test('M12 no log line of M0-M17 contains a temp folder', () => {
  assert.ok(ALL_LOGS.length > 30, 'the earlier cases logged');
  const tmp = os.tmpdir();
  for (const { line, dir } of ALL_LOGS) {
    for (const d of [dir, tmp]) {
      for (const form of [d, d.replace(/\\/g, '/'), d.replace(/\//g, '\\')]) assert.ok(!line.includes(form), line);
    }
  }
});
