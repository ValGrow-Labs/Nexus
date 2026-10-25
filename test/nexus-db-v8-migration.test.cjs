'use strict';
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { PersistStore, platformFailureMarkerPath } = loadTs('src/main/db.ts');
/** Every log line of every open() in this file, with the folder of its database (M12). */
const ALL_LOGS = [];
const open = (file, o = {}) => { const logs = []; const s = new PersistStore(file);
  s.open({ log: (l) => { logs.push(l); ALL_LOGS.push({ line: l, dir: path.dirname(file) }); },
    backupDir: path.join(path.dirname(file), 'backups'), now: () => h.NOW, ...o });
  return { s, logs }; };
const v7File = () => { const { file } = h.v6Fixture(); open(file, { holdV8: true }).s.close(); return file; };
const inOrder = (logs, keys) => { let at = -1; for (const k of keys) {
  const i = logs.findIndex((l, j) => j > at && l.includes(k)); assert.ok(i > at, `missing or out of order: ${k}`); at = i; } };
const backups = (file) => { try { return fs.readdirSync(path.join(path.dirname(file), 'backups')).filter((f) => f.endsWith('.db')).sort(); } catch { return []; } };
const handoffObjects = (db) => db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'handoff%'
  OR name IN ('ix_versions_project_status', 'ix_artifacts_updated') OR tbl_name LIKE 'handoff%'`).get().n;
const userVersion = (file) => { const db = h.openRaw(file); try { return db.pragma('user_version', { simple: true }); } finally { db.close(); } };

test('M1 v7 -> v8: verified harness-v7 backup, one transaction, record, one activity row, log order, no paths', () => {
  const file = v7File(); const { s, logs } = open(file);
  assert.equal(s.schemaVersion, 8); assert.equal(s.platformAvailable, true); assert.equal(s.handoffsAvailable, true);
  assert.equal(s.lastMigration.state, 'not_needed'); assert.equal(s.lastMigrationV8.state, 'applied');
  assert.equal(s.handoffsUnavailableReason, null);
  inOrder(logs, ['schema version 7', 'v8 precheck ok', 'backup ok file=harness-v7-', 'row counts',
    'v8 migration: start from=7', 'v8 migration: success to=8']);
  // The backup line is the v7 format with from=7 (the brief listed 'from=7' as its own key; it is part of this line).
  assert.ok(logs.some((l) => /\[db\] backup ok file=harness-v7-\d{8}T\d{6}Z\.db bytes=\d+ sha256=[0-9a-f]{64} from=7 writeMs=\d+ verifyMs=\d+ hashMs=\d+$/.test(l)), logs.join('\n'));
  assert.ok(logs.some((l) => /\[db\] v8 migration: success to=8 durationMs=\d+ handoffStates=4 handoffTransitions=3$/.test(l)), logs.join('\n'));
  const db = s.platformDatabase();
  const rec = db.prepare('SELECT * FROM nexus_migrations WHERE version = 8').get();
  assert.equal(rec.from_version, 7); assert.match(rec.backup_file, /^harness-v7-\d{8}T\d{6}Z\.db$/);
  assert.ok(fs.existsSync(path.join(path.dirname(file), 'backups', rec.backup_file)));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM activity WHERE action = 'db.migrated' AND entity_id = '8'").get().n, 1);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  const dir = path.dirname(file);
  for (const l of logs) assert.ok(!l.includes(dir) && !l.includes(dir.replace(/\\/g, '/')), l);
  s.close();
  // The backup is the v7 database: user_version 7 and no v8 object.
  const b = new (require('better-sqlite3'))(path.join(dir, 'backups', rec.backup_file), { readonly: true });
  assert.equal(b.pragma('user_version', { simple: true }), 7); assert.equal(handoffObjects(b), 0); b.close();
  assert.equal(fs.existsSync(platformFailureMarkerPath(file, 8)), false);
});

test('M2 v6 -> v7 -> v8 in one launch: two backups; the v7 lines are unchanged', () => {
  const { file } = h.v6Fixture(); const { s, logs } = open(file);
  const b = fs.readdirSync(path.join(path.dirname(file), 'backups')).filter((f) => f.endsWith('.db')).sort();
  assert.equal(b.length, 2); assert.match(b[0], /^harness-v6-/); assert.match(b[1], /^harness-v7-/);
  assert.ok(logs.some((l) => /\[db\] v7 migration: success to=7 durationMs=\d+ backfilled=\d+ unassigned=\d+$/.test(l)));
  assert.equal(s.schemaVersion, 8);
  // The v8 backup is taken after the v7 COMMIT, and the v7 step's own lines come first.
  inOrder(logs, ['schema version 6', 'v7 precheck ok', 'backup ok file=harness-v6-', 'v7 migration: start from=6',
    'v7 migration: success to=7', 'v8 precheck ok', 'backup ok file=harness-v7-', 'v8 migration: start from=7', 'v8 migration: success to=8']);
  assert.equal(s.lastMigration.state, 'applied'); assert.equal(s.lastMigrationV8.state, 'applied');
  assert.equal(s.platformDatabase().prepare('SELECT COUNT(*) n FROM nexus_migrations').get().n, 2);
  s.close();
});

test('M3 a throw inside the v8 transaction leaves v7 with the platform on and handoffs off; marker 1 of 3', () => {
  const file = v7File();
  const { s, logs } = open(file, { hooks: { beforeCommit: (_db, v) => { if (v === 8) throw new Error('injected'); } } });
  assert.equal(s.schemaVersion, 7); assert.equal(s.platformAvailable, true); assert.equal(s.handoffsAvailable, false);
  assert.equal(s.lastMigrationV8.state, 'failed'); assert.equal(s.handoffsUnavailableReason, 'failed');
  assert.equal(s.platformDatabase().prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'handoff%'").get().n, 0);
  assert.ok(logs.some((l) => l.includes('failure 1 of 3') && l.includes('NEXUS_DB_HOLD_V8=1 to stay on v7')));
  assert.equal(JSON.parse(fs.readFileSync(platformFailureMarkerPath(file, 8), 'utf8')).count, 1);
  assert.equal(fs.existsSync(platformFailureMarkerPath(file, 7)), false);
  const failed = logs.find((l) => l.includes('v8 migration: failed'));
  assert.match(failed, /\[db\] v8 migration: failed from=7 error=injected; database left at v7; backup kept at harness-v7-\d{8}T\d{6}Z\.db$/);
  assert.equal(s.lastMigrationV8.backupFile, failed.match(/backup kept at (\S+)$/)[1]);
  assert.equal(s.platformDatabase().prepare('SELECT COUNT(*) n FROM nexus_migrations WHERE version = 8').get().n, 0);
  // Legacy writes still land.
  s.setKv('after_v8_failure', 1); assert.equal(s.getKv('after_v8_failure'), 1);
  s.close();
  assert.equal(userVersion(file), 7);
});

test('M4 three failures hold v8 at the fourth launch with no new backup; deleting the marker lets v8 apply', () => {
  const file = v7File(); const marker = platformFailureMarkerPath(file, 8);
  let t = h.NOW;
  const launch = (extra = {}) => { t += 60_000; const at = t; return open(file, { now: () => at, ...extra }); };
  const boom = { hooks: { beforeCommit: (_db, v) => { if (v === 8) throw new Error('deterministic'); } } };
  for (let n = 1; n <= 3; n++) {
    const { s, logs } = launch(boom);
    assert.equal(s.lastMigrationV8.state, 'failed'); assert.equal(s.schemaVersion, 7); s.close();
    assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).count, n);
    if (n === 3) assert.ok(logs.some((l) => /\[db\] v8 migration has failed 3 times in a row; it is held from the next launch \(held: repeated_failure\)$/.test(l)));
  }
  const before = backups(file);
  assert.equal(before.filter((f) => f.startsWith('harness-v7-')).length, 3);
  const held = launch(boom);
  assert.equal(held.s.schemaVersion, 7); assert.equal(held.s.platformAvailable, true); assert.equal(held.s.handoffsAvailable, false);
  assert.equal(held.s.lastMigrationV8.state, 'skipped'); assert.equal(held.s.lastMigrationV8.reason, 'held');
  assert.equal(held.s.lastMigrationV8.detail, 'repeated_failure count=3'); assert.equal(held.s.handoffsUnavailableReason, 'auto_held');
  assert.ok(held.logs.some((l) => /\[db\] v8 migration: skipped reason=held: repeated_failure count=3; database stays at v7; no new backup taken$/.test(l)));
  assert.ok(held.logs.some((l) => /\[db\] to retry v8, quit and delete harness\.db\.v8-failures\.json next to harness\.db; existing backups are kept \(restore one with the restore tool, tools\/nexus-db-restore\.cjs, if needed\)$/.test(l)));
  assert.ok(!held.logs.some((l) => /v8 precheck|backup ok|v8 migration: start/.test(l)));
  held.s.close();
  assert.deepEqual(backups(file), before, 'no new backup while held');
  fs.rmSync(marker);
  const ok = launch();
  assert.equal(ok.s.schemaVersion, 8); assert.equal(ok.s.lastMigrationV8.state, 'applied'); assert.equal(ok.s.handoffsAvailable, true);
  ok.s.close();
  assert.equal(fs.existsSync(marker), false);
});

test('M5 holdV8 keeps v7 with the platform on and handoffs off, and takes no backup', () => {
  const file = v7File(); const before = backups(file);
  const { s, logs } = open(file, { holdV8: true });
  assert.equal(s.schemaVersion, 7); assert.equal(s.platformAvailable, true); assert.equal(s.handoffsAvailable, false);
  assert.equal(s.lastMigration.state, 'not_needed'); assert.equal(s.handoffsUnavailableReason, 'held');
  assert.equal(s.lastMigrationV8.state, 'skipped'); assert.equal(s.lastMigrationV8.reason, 'held');
  assert.ok(logs.some((l) => /\[db\] v8 migration: skipped reason=held \(NEXUS_DB_HOLD_V8=1\); database stays at v7$/.test(l)), logs.join('\n'));
  s.close();
  assert.deepEqual(backups(file), before); assert.equal(userVersion(file), 7);
  assert.equal(fs.existsSync(platformFailureMarkerPath(file, 8)), false);
});

test('M5b the hold also comes from NEXUS_DB_HOLD_V8=1 in the environment', () => {
  const file = v7File();
  process.env.NEXUS_DB_HOLD_V8 = '1';
  try {
    const { s, logs } = open(file);
    assert.equal(s.schemaVersion, 7); assert.equal(s.lastMigrationV8.reason, 'held');
    assert.ok(logs.some((l) => /v8 migration: skipped reason=held \(NEXUS_DB_HOLD_V8=1\)/.test(l))); s.close();
  } finally { delete process.env.NEXUS_DB_HOLD_V8; }
});

test('M5c holdV8 on a v6 file: v7 applies, then the v8 hold line is logged; no v7 backup', () => {
  const { file } = h.v6Fixture(); const { s, logs } = open(file, { holdV8: true });
  assert.equal(s.schemaVersion, 7); assert.equal(s.platformAvailable, true); assert.equal(s.handoffsAvailable, false);
  assert.equal(s.lastMigration.state, 'applied');
  assert.equal(s.lastMigrationV8.state, 'skipped'); assert.equal(s.lastMigrationV8.reason, 'held'); assert.equal(s.lastMigrationV8.detail, 'NEXUS_DB_HOLD_V8=1');
  assert.equal(s.handoffsUnavailableReason, 'held');
  inOrder(logs, ['v7 migration: success to=7', 'v8 migration: skipped reason=held (NEXUS_DB_HOLD_V8=1); database stays at v7']);
  assert.ok(/\[db\] v8 migration: skipped reason=held \(NEXUS_DB_HOLD_V8=1\); database stays at v7$/.test(logs[logs.length - 1]), logs.join('\n'));
  assert.equal(logs.filter((l) => /v8/.test(l)).length, 1, logs.join('\n'));
  s.close();
  assert.deepEqual(backups(file).map((f) => f.slice(0, 11)), ['harness-v6-']);
});

test('M6 holdV7 on a v6 file gives v6, platform off, v8 v7_unavailable and no v8 line', () => {
  const { file } = h.v6Fixture(); const { s, logs } = open(file, { holdV7: true });
  assert.equal(s.schemaVersion, 6); assert.equal(s.platformAvailable, false); assert.equal(s.handoffsAvailable, false);
  assert.equal(s.lastMigration.reason, 'held');
  assert.equal(s.lastMigrationV8.state, 'skipped'); assert.equal(s.lastMigrationV8.reason, 'v7_unavailable');
  assert.equal(s.handoffsUnavailableReason, null);   // the whole platform is off: that reason is the v7 side's
  assert.ok(!logs.some((l) => /v8/.test(l)), logs.join('\n'));
  s.close();
  assert.deepEqual(backups(file), []); assert.equal(userVersion(file), 6);
});

test('M6b holdV7 on a v7 file implies the v8 hold: v7 stays, platform on, handoffs off', () => {
  const file = v7File(); const before = backups(file);
  const { s, logs } = open(file, { holdV7: true });
  assert.equal(s.schemaVersion, 7); assert.equal(s.platformAvailable, true); assert.equal(s.handoffsAvailable, false);
  assert.equal(s.lastMigrationV8.reason, 'held'); assert.equal(s.lastMigrationV8.detail, 'NEXUS_DB_HOLD_V7=1');
  assert.ok(logs.some((l) => /\[db\] v8 migration: skipped reason=held \(NEXUS_DB_HOLD_V7=1\); database stays at v7$/.test(l)));
  s.close(); assert.deepEqual(backups(file), before);
});

test('M7 a v7 shape problem gives platform off, v8 v7_unavailable, and no write', () => {
  const file = v7File();
  const pre = h.openRaw(file); pre.exec('DROP INDEX ix_jobs_state'); pre.close();
  const before = backups(file);
  const { s, logs } = open(file);
  assert.equal(s.schemaVersion, 7); assert.equal(s.platformAvailable, false); assert.equal(s.handoffsAvailable, false);
  assert.equal(s.lastMigrationV8.state, 'skipped'); assert.equal(s.lastMigrationV8.reason, 'v7_unavailable');
  assert.ok(logs.some((l) => /v7 shape check failed.*ix_jobs_state/.test(l)));
  assert.ok(!logs.some((l) => /v8/.test(l)), logs.join('\n'));
  s.close();
  assert.deepEqual(backups(file), before);
  const db = h.openRaw(file);
  assert.equal(db.pragma('user_version', { simple: true }), 7); assert.equal(handoffObjects(db), 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM nexus_migrations WHERE version = 8').get().n, 0);
  db.close();
  assert.equal(fs.existsSync(platformFailureMarkerPath(file, 8)), false);
});

test('M8 reopening at v8 is not_needed twice with no new backup; a damaged v8 trigger disables handoffs only', () => {
  const file = v7File(); open(file).s.close();
  const before = backups(file);
  for (let i = 0; i < 2; i++) {
    const { s, logs } = open(file);
    assert.equal(s.schemaVersion, 8); assert.equal(s.lastMigration.state, 'not_needed'); assert.equal(s.lastMigrationV8.state, 'not_needed');
    assert.equal(s.platformAvailable, true); assert.equal(s.handoffsAvailable, true);
    assert.ok(!logs.some((l) => /backup ok|migration: start/.test(l)));
    s.close();
  }
  assert.deepEqual(backups(file), before);
  const db = h.openRaw(file);
  db.exec("DROP TRIGGER tr_handoffs_no_delete; CREATE TRIGGER tr_handoffs_no_delete BEFORE DELETE ON handoffs BEGIN SELECT 1; END;");
  db.close();
  const { s, logs } = open(file);
  assert.equal(s.schemaVersion, 8); assert.equal(s.platformAvailable, true); assert.equal(s.handoffsAvailable, false);
  assert.equal(s.lastMigrationV8.state, 'not_needed'); assert.equal(s.handoffsUnavailableReason, 'shape');
  assert.ok(logs.some((l) => /\[db\] v8 shape check failed: trigger tr_handoffs_no_delete has a different definition; handoffs disabled$/.test(l)), logs.join('\n'));
  s.close();
  assert.deepEqual(backups(file), before);
});

test('M9 a newer schema (v11) is opened for legacy use only: nothing migrated, platform off', () => {
  const file = v7File(); open(file).s.close();
  const pre = h.openRaw(file); pre.pragma('user_version = 11'); pre.close();
  const before = backups(file);
  const { s, logs } = open(file);
  assert.equal(s.schemaVersion, 11); assert.equal(s.platformAvailable, false); assert.equal(s.handoffsAvailable, false);
  assert.equal(s.platformDatabase(), null);
  assert.equal(s.lastMigration.reason, 'newer_schema'); assert.equal(s.lastMigrationV8.reason, 'newer_schema');
  assert.ok(logs.some((l) => l.includes('schema v11 is newer than this build (v10)')), logs.join('\n'));
  assert.equal(s.getKv('window_bounds').width, 1200);
  s.close();
  assert.deepEqual(backups(file), before); assert.equal(userVersion(file), 11);
});

test('M10 a fresh database goes to v8 with no backups', () => {
  const dir = h.tmpDir(); const file = path.join(dir, 'harness.db');
  const { s, logs } = open(file);
  assert.equal(s.schemaVersion, 8); assert.equal(s.handoffsAvailable, true);
  assert.ok(logs.some((l) => l.includes('[db] fresh database: no backup needed')));
  assert.ok(logs.some((l) => l.includes('[db] fresh database: no v8 backup needed')));
  assert.ok(!logs.some((l) => /v8 precheck/.test(l)));
  const rec = s.platformDatabase().prepare('SELECT * FROM nexus_migrations WHERE version = 8').get();
  assert.equal(rec.backup_file, null); assert.equal(rec.from_version, 7);
  assert.equal(s.platformDatabase().prepare('SELECT COUNT(*) n FROM handoff_states').get().n, 4);
  s.close();
  assert.deepEqual(backups(file), []);
});

test('M11 at v8 a project with an artifact has platform records; deleteProject refuses and writes nothing', () => {
  const file = v7File(); const { s } = open(file);
  assert.equal(s.schemaVersion, 8);
  const db = s.platformDatabase();
  const pw = db.prepare("SELECT id, workspace_id FROM project_workspaces WHERE project_id = 'p-ledger' AND is_primary = 1").get();
  db.prepare(`INSERT INTO artifacts (id, project_id, kind, name, owner_participation_id, owner_workspace_id, created_by, created_at, updated_at)
    VALUES ('a-m11', 'p-ledger', 'report', 'notes', ?, ?, 'user:local', ?, ?)`).run(pw.id, pw.workspace_id, h.NOW, h.NOW);
  assert.equal(s.hasPlatformRecords('p-ledger'), true);
  assert.equal(s.hasPlatformRecords('p-sales'), false);
  const snap = h.allRows(db);
  assert.equal(s.deleteProject('p-ledger', { withGraph: true }), false);
  assert.deepEqual(h.allRows(db), snap);
  assert.ok(s.getProject('p-ledger'));
  assert.equal(s.deleteProject('p-sales'), true);   // no platform records: still deletable at v8
  s.close();
});

test('M13 a process killed inside the v8 transaction leaves a v7 file with no v8 object', () => {
  const file = v7File();
  const pre = h.openRaw(file); const beforeRows = h.allRows(pre); pre.close();
  const r = spawnSync(process.execPath, [path.join(__dirname, 'helpers', 'migrate-and-die.cjs'), file, 'v8'],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' });
  assert.ok(r.status !== 0 || r.signal, `the child must be killed, got status=${r.status} signal=${r.signal} ${r.stderr}`);
  const died = /IN_TXN wal=(\d+)/.exec(r.stdout);
  assert.ok(died, `the child reached the open v8 transaction: ${r.stdout} ${r.stderr}`);
  assert.doesNotMatch(r.stdout, /NOT_KILLED/);
  assert.ok(Number(died[1]) > 0, 'uncommitted v8 frames were in the WAL when the process died');
  assert.equal(backups(file).filter((f) => f.startsWith('harness-v7-')).length, 1, 'the child died after its verified v7 backup');
  const db = h.openRaw(file);
  assert.equal(db.pragma('user_version', { simple: true }), 7);
  assert.equal(handoffObjects(db), 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM nexus_migrations WHERE version = 8').get().n, 0);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(h.allRows(db), beforeRows, 'every row of every table is as it was before the kill');
  db.close();
  // The next launch migrates cleanly.
  const { s } = open(file, { now: () => h.NOW + 60_000 }); assert.equal(s.schemaVersion, 8); assert.equal(s.handoffsAvailable, true); s.close();
});

test('M14 a precheck failure and insufficient disk skip v8 and leave v7 running', () => {
  for (const [hook, reason, detail] of [
    [() => { throw new Error('probe failed'); }, 'precheck_failed', /^probe failed$/],
    [() => 1024, 'insufficient_disk', /^free=1024 needed=\d+$/]
  ]) {
    const file = v7File(); const before = backups(file);
    const { s, logs } = open(file, { hooks: { freeBytes: hook } });
    assert.equal(s.schemaVersion, 7); assert.equal(s.platformAvailable, true); assert.equal(s.handoffsAvailable, false);
    assert.equal(s.lastMigrationV8.state, 'skipped'); assert.equal(s.lastMigrationV8.reason, reason);
    assert.match(s.lastMigrationV8.detail, detail); assert.equal(s.handoffsUnavailableReason, 'failed');
    assert.ok(logs.some((l) => new RegExp(`\\[db\\] v8 migration: skipped reason=${reason} detail=.*; database left at v7$`).test(l)), logs.join('\n'));
    s.setKv('still_writable', 1); assert.equal(s.getKv('still_writable'), 1);
    s.close();
    assert.deepEqual(backups(file), before); assert.equal(userVersion(file), 7);
    assert.equal(fs.existsSync(platformFailureMarkerPath(file, 8)), false, 'skips do not count as failures');
  }
});

test('M15 a v8 backup that cannot be written skips v8: v7 stays with the platform on, no marker', () => {
  const file = v7File(); const dir = path.dirname(file);
  const blocker = path.join(dir, 'not-a-dir'); fs.writeFileSync(blocker, 'x');
  const { s, logs } = open(file, { backupDir: path.join(blocker, 'backups') });
  assert.equal(s.schemaVersion, 7); assert.equal(s.platformAvailable, true); assert.equal(s.handoffsAvailable, false);
  assert.equal(s.lastMigration.state, 'not_needed');
  assert.equal(s.lastMigrationV8.state, 'skipped'); assert.equal(s.lastMigrationV8.reason, 'backup_failed');
  assert.equal(s.lastMigrationV8.detail, 'stage=write'); assert.equal(s.handoffsUnavailableReason, 'backup_failed');
  inOrder(logs, ['v8 precheck ok', 'backup failed stage=write error=', 'v8 migration: skipped reason=backup_failed detail=stage=write; database left at v7']);
  assert.ok(!logs.some((l) => /v8 migration: start/.test(l)));
  s.setKv('after_backup_failure', 1); assert.equal(s.getKv('after_backup_failure'), 1);
  s.close();
  assert.equal(fs.existsSync(platformFailureMarkerPath(file, 8)), false, 'a backup failure is a skip, not a counted failure');
  assert.equal(fs.statSync(blocker).isFile(), true);
  const db = h.openRaw(file);
  assert.equal(db.pragma('user_version', { simple: true }), 7); assert.equal(handoffObjects(db), 0); db.close();
});

test('M16 v6 file with a v8-only failure: two backups, v7 applied, v8 failed, marker 1', () => {
  const { file } = h.v6Fixture();
  const { s, logs } = open(file, { hooks: { beforeCommit: (_db, v) => { if (v === 8) throw new Error('v8 only'); } } });
  assert.equal(s.schemaVersion, 7); assert.equal(s.platformAvailable, true); assert.equal(s.handoffsAvailable, false);
  assert.equal(s.lastMigration.state, 'applied'); assert.equal(s.lastMigrationV8.state, 'failed');
  assert.equal(s.handoffsUnavailableReason, 'failed');
  const b = backups(file);
  assert.equal(b.length, 2); assert.match(b[0], /^harness-v6-/); assert.match(b[1], /^harness-v7-/);
  inOrder(logs, ['v7 migration: success to=7', 'v8 migration: start from=7', 'v8 migration: failed from=7 error=v8 only; database left at v7',
    'failure 1 of 3']);
  s.close();
  assert.equal(JSON.parse(fs.readFileSync(platformFailureMarkerPath(file, 8), 'utf8')).count, 1);
  assert.equal(fs.existsSync(platformFailureMarkerPath(file, 7)), false);
  assert.equal(userVersion(file), 7);
});

test('M12 no log line of M1-M16 contains a temp folder', () => {
  assert.ok(ALL_LOGS.length > 30, 'the earlier cases logged');
  const tmp = os.tmpdir();
  for (const { line, dir } of ALL_LOGS) {
    for (const d of [dir, tmp]) {
      for (const form of [d, d.replace(/\\/g, '/'), d.replace(/\//g, '\\')]) assert.ok(!line.includes(form), line);
    }
  }
});
