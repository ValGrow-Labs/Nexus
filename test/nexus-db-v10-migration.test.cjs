'use strict';
// B2b Task 3: the v10 migration step (agent records) wired into the store, and every exact-version site in db.ts.
// Mirrors the v9 M-series. Every database here is a temp copy built from the v6 fixture; nothing touches userData.
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
// Every store and raw handle this file opens is closed, and its temp dirs removed, by one after hook.
const C = require('./helpers/cleanup.cjs'); C.cleanupAfterAll();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const {
  PersistStore: PersistStoreUntracked, platformFailureMarkerPath, V10, V10_ENABLED_BY_DEFAULT, V10_FAILURE_LIMIT, V9_ENABLED_BY_DEFAULT
} = loadTs('src/main/db.ts');
/** Every store this file opens is tracked: the cleanup hook closes it even when a test fails before its own close(). */
class PersistStore extends PersistStoreUntracked { constructor(...a) { super(...a); C.track(this); } }
const { readUserVersion, holdHint } = require('../tools/nexus-db-restore.cjs');
const REPO = path.join(__dirname, '..');

/** Every log line of every open() in this file, with the folder of its database (M10-16b). */
const ALL_LOGS = [];
const open = (file, o = {}) => { const logs = []; const s = new PersistStore(file);
  s.open({ log: (l) => { logs.push(l); ALL_LOGS.push({ line: l, dir: path.dirname(file) }); },
    backupDir: path.join(path.dirname(file), 'backups'), now: () => h.NOW, ...o });
  return { s, logs }; };
/** v9 and v10 are both off until verified: every case that wants a step asks for it. */
const openV9 = (file, o = {}) => open(file, { enableV9: true, ...o });
const openV10 = (file, o = {}) => open(file, { enableV9: true, enableV10: true, ...o });
// holdV10 keeps this a v9 file whatever the default of enableV10 becomes.
const v9File = () => { const { file } = h.v6Fixture(); openV9(file, { holdV10: true }).s.close(); return file; };
const v10File = () => { const file = v9File(); openV10(file).s.close(); return file; };
const v8File = () => { const { file } = h.v6Fixture(); open(file, { holdV9: true, holdV10: true }).s.close(); return file; };
const inOrder = (logs, keys) => { let at = -1; for (const k of keys) {
  const i = logs.findIndex((l, j) => j > at && l.includes(k)); assert.ok(i > at, `missing or out of order: ${k}\n${logs.join('\n')}`); at = i; } };
const backups = (file) => { try { return fs.readdirSync(path.join(path.dirname(file), 'backups')).filter((f) => f.endsWith('.db')).sort(); } catch { return []; } };
const userVersion = (file) => { const db = C.openRaw(file); try { return db.pragma('user_version', { simple: true }); } finally { db.close(); } };
const V10_NAMES = ['capability_tokens', 'reviews', 'change_set_accepts', 'repo_merges', 'runtime_consents', 'session_worktrees',
  'ux_consent_live', 'ix_accepts_job'];
const v10Objects = (db) => db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE name IN (${V10_NAMES.map(() => '?').join(',')})`).get(...V10_NAMES).n;
const plain = (l) => l.replace(/^\S+ /, '');
const v10Lines = (logs) => logs.filter((l) => /\bv10\b/.test(l)).map(plain);
const allOn = (s) => { assert.equal(s.platformAvailable, true, 'platform'); assert.equal(s.handoffsAvailable, true, 'handoffs');
  assert.equal(s.executionAvailable, true, 'execution'); assert.equal(s.agentsAvailable, true, 'agents');
  assert.equal(s.executionUnavailableReason, null); assert.equal(s.agentsUnavailableReason, null); };

test('M10-1 v9 -> v10: verified harness-v9 backup, one transaction, record 10, one activity row, log order, no paths', () => {
  const file = v9File(); const { s, logs } = openV10(file);
  assert.equal(s.schemaVersion, 10); assert.equal(V10, 10);
  allOn(s);
  assert.equal(s.lastMigrationV9.state, 'not_needed'); assert.equal(s.lastMigrationV10.state, 'applied');
  assert.equal(s.lastMigrationV10.fromVersion, 9); assert.equal(s.lastMigrationV10.postCheckOk, true);
  inOrder(logs, ['schema version 9', 'v10 precheck ok', 'backup ok file=harness-v9-', 'row counts',
    'v10 migration: start from=9', 'v10 migration: success to=10']);
  assert.ok(logs.some((l) => /\[db\] v10 precheck ok integrity=ok integrityMs=\d+ free=(\d+|unknown) needed=\d+$/.test(l)), logs.join('\n'));
  assert.ok(logs.some((l) => /\[db\] backup ok file=harness-v9-\d{8}T\d{6}Z\.db bytes=\d+ sha256=[0-9a-f]{64} from=9 writeMs=\d+ verifyMs=\d+ hashMs=\d+$/.test(l)), logs.join('\n'));
  assert.ok(logs.some((l) => /\[db\] v10 migration: success to=10 durationMs=\d+ tables=6$/.test(l)), logs.join('\n'));
  // No v9 line at all: the v9 step only re-checked its shape.
  assert.ok(!logs.some((l) => /\bv9 (migration|precheck|shape|step)/.test(l)), logs.join('\n'));
  const db = s.platformDatabase();
  const rec = db.prepare('SELECT * FROM nexus_migrations WHERE version = 10').get();
  assert.equal(rec.from_version, 9); assert.match(rec.backup_file, /^harness-v9-\d{8}T\d{6}Z\.db$/);
  assert.match(rec.backup_sha256, /^[0-9a-f]{64}$/);
  const bak = C.openRaw(path.join(path.dirname(file), 'backups', rec.backup_file));
  assert.equal(bak.pragma('user_version', { simple: true }), 9);
  assert.equal(v10Objects(bak), 0, 'the backup is the v9 database'); bak.close();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM activity WHERE action = 'db.migrated' AND entity_id = '10'").get().n, 1);
  assert.equal(v10Objects(db), V10_NAMES.length);
  for (const t of h.LEGACY_TABLES) assert.equal(h.count(db, t), JSON.parse(rec.row_counts_json)[t], t);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  const dir = path.dirname(file);
  for (const l of logs) assert.ok(!l.includes(dir) && !l.includes(dir.replace(/\\/g, '/')), l);
  s.close();
  assert.equal(fs.existsSync(platformFailureMarkerPath(file, 10)), false);
  assert.equal(userVersion(file), 10);
});

test('M10-2 a fresh database goes to v10 with no backups', () => {
  const dir = h.tmpDir(); const file = path.join(dir, 'harness.db');
  const { s, logs } = openV10(file);
  assert.equal(s.schemaVersion, 10); allOn(s);
  inOrder(logs, ['[db] fresh database: no backup needed', '[db] fresh database: no v8 backup needed', '[db] fresh database: no v9 backup needed',
    '[db] fresh database: no v10 backup needed', 'v10 migration: start from=9', 'v10 migration: success to=10']);
  assert.ok(!logs.some((l) => /precheck/.test(l)));
  const rec = s.platformDatabase().prepare('SELECT * FROM nexus_migrations WHERE version = 10').get();
  assert.equal(rec.backup_file, null); assert.equal(rec.backup_sha256, null); assert.equal(rec.from_version, 9);
  s.close();
  assert.deepEqual(backups(file), []);
});

test('M10-3 holdV10 keeps v9 with agents off (held), execution on, one hold line, no backup; the env switch works too', () => {
  const file = v9File(); const before = backups(file);
  const { s, logs } = openV10(file, { holdV10: true });
  assert.equal(s.schemaVersion, 9); assert.equal(s.executionAvailable, true); assert.equal(s.agentsAvailable, false);
  assert.equal(s.lastMigrationV10.state, 'skipped'); assert.equal(s.lastMigrationV10.reason, 'held'); assert.equal(s.lastMigrationV10.detail, 'NEXUS_DB_HOLD_V10=1');
  assert.equal(s.agentsUnavailableReason, 'held'); assert.equal(s.executionUnavailableReason, null);
  assert.deepEqual(v10Lines(logs), ['[db] v10 migration: skipped reason=held (NEXUS_DB_HOLD_V10=1); database stays at v9']);
  s.close();
  assert.deepEqual(backups(file), before); assert.equal(userVersion(file), 9);
  assert.equal(fs.existsSync(platformFailureMarkerPath(file, 10)), false);
  process.env.NEXUS_DB_HOLD_V10 = '1';
  try {
    const env = openV10(file);
    assert.equal(env.s.schemaVersion, 9); assert.equal(env.s.lastMigrationV10.reason, 'held');
    assert.equal(env.s.lastMigrationV10.detail, 'NEXUS_DB_HOLD_V10=1'); env.s.close();
  } finally { delete process.env.NEXUS_DB_HOLD_V10; }
  assert.deepEqual(backups(file), before);
});

test('M10-4 the hold cascade: holdV9, holdV8 and holdV7 each imply the v10 hold; a held v9 skips v10 without a line', () => {
  const file = v9File(); const before = backups(file);
  for (const [opt, name] of [['holdV9', 'NEXUS_DB_HOLD_V9'], ['holdV8', 'NEXUS_DB_HOLD_V8'], ['holdV7', 'NEXUS_DB_HOLD_V7']]) {
    const { s, logs } = openV10(file, { [opt]: true });
    assert.equal(s.schemaVersion, 9, opt); assert.equal(s.executionAvailable, true, opt); assert.equal(s.agentsAvailable, false, opt);
    assert.equal(s.lastMigrationV10.reason, 'held', opt); assert.equal(s.lastMigrationV10.detail, `${name}=1`, opt);
    assert.equal(s.agentsUnavailableReason, 'held', opt);
    assert.deepEqual(v10Lines(logs), [`[db] v10 migration: skipped reason=held (${name}=1); database stays at v9`], opt);
    s.close();
  }
  // The v10 switch is named first when several are set.
  const both = openV10(file, { holdV10: true, holdV9: true });
  assert.equal(both.s.lastMigrationV10.detail, 'NEXUS_DB_HOLD_V10=1'); both.s.close();
  assert.deepEqual(backups(file), before); assert.equal(userVersion(file), 9);
  // A v8 file with v9 held: v9 never runs, so v10 is skipped (v9_unavailable) silently and agents report the v9 hold.
  const at8 = v8File(); const before8 = backups(at8);
  const held = openV10(at8, { holdV9: true });
  assert.equal(held.s.schemaVersion, 8); assert.equal(held.s.handoffsAvailable, true); assert.equal(held.s.executionAvailable, false);
  assert.equal(held.s.lastMigrationV10.state, 'skipped'); assert.equal(held.s.lastMigrationV10.reason, 'v9_unavailable');
  assert.equal(held.s.lastMigrationV10.detail, 'v9 held');
  assert.equal(held.s.executionUnavailableReason, 'held'); assert.equal(held.s.agentsUnavailableReason, 'held');
  assert.deepEqual(v10Lines(held.logs), []);
  held.s.close();
  assert.deepEqual(backups(at8), before8); assert.equal(userVersion(at8), 8);
  // holdV7 on a v6 file: v6, the platform off, and no v8, v9 or v10 line.
  const { file: v6 } = h.v6Fixture();
  const off = openV10(v6, { holdV7: true });
  assert.equal(off.s.schemaVersion, 6); assert.equal(off.s.platformAvailable, false); assert.equal(off.s.agentsAvailable, false);
  assert.equal(off.s.lastMigrationV10.reason, 'v9_unavailable'); assert.equal(off.s.agentsUnavailableReason, null);
  assert.ok(!off.logs.some((l) => /\bv(8|9|10)\b/.test(l)), off.logs.join('\n'));
  off.s.close();
  assert.deepEqual(backups(v6), []);
});

test('M10-5 v10 is off by default: a v9 file stays at v9 with one line, agents not_enabled, execution on; a hold changes nothing', () => {
  assert.equal(V10_ENABLED_BY_DEFAULT, false); assert.equal(V10_FAILURE_LIMIT, 3); assert.equal(V9_ENABLED_BY_DEFAULT, false);
  const file = v9File(); const before = backups(file);
  const { s, logs } = openV9(file);
  assert.equal(s.schemaVersion, 9); assert.equal(s.platformAvailable, true); assert.equal(s.handoffsAvailable, true);
  assert.equal(s.executionAvailable, true); assert.equal(s.agentsAvailable, false); assert.equal(s.agentsUnavailableReason, 'not_enabled');
  assert.equal(s.lastMigrationV10.state, 'skipped'); assert.equal(s.lastMigrationV10.reason, 'not_enabled');
  assert.equal(s.lastMigrationV10.detail, 'enableV10=false');
  assert.deepEqual(v10Lines(logs), ['[db] v10 migration: not enabled; database stays at v9']);
  s.close();
  const held = openV9(file, { holdV10: true });
  assert.equal(held.s.lastMigrationV10.reason, 'not_enabled'); assert.equal(held.s.agentsUnavailableReason, 'not_enabled');
  held.s.close();
  // An explicit enableV10: false is the same as leaving it out.
  const off = openV9(file, { enableV10: false });
  assert.equal(off.s.lastMigrationV10.reason, 'not_enabled'); off.s.close();
  assert.deepEqual(backups(file), before); assert.equal(userVersion(file), 9);
  assert.equal(fs.existsSync(platformFailureMarkerPath(file, 10)), false);
});

test('M10-6 a throw in the v10 transaction leaves v9 (marker 1 of 3); three failures hold v10 with no new backup; deleting the marker lets it apply', () => {
  const file = v9File(); const marker = platformFailureMarkerPath(file, 10);
  let t = h.NOW;
  const launch = (extra = {}) => { t += 60_000; const at = t; return openV10(file, { now: () => at, ...extra }); };
  const boom = { hooks: { beforeCommit: (_db, v) => { if (v === 10) throw new Error('deterministic'); } } };
  for (let n = 1; n <= 3; n++) {
    const { s, logs } = launch(boom);
    assert.equal(s.lastMigrationV10.state, 'failed'); assert.equal(s.schemaVersion, 9);
    assert.equal(s.executionAvailable, true); assert.equal(s.agentsAvailable, false); assert.equal(s.agentsUnavailableReason, 'failed');
    assert.equal(s.platformDatabase().prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('capability_tokens','reviews')").get().n, 0);
    assert.equal(s.platformDatabase().prepare('SELECT COUNT(*) n FROM nexus_migrations WHERE version = 10').get().n, 0);
    const failed = logs.find((l) => l.includes('v10 migration: failed'));
    assert.match(failed, /\[db\] v10 migration: failed from=9 error=deterministic; database left at v9; backup kept at harness-v9-\d{8}T\d{6}Z\.db$/);
    assert.equal(s.lastMigrationV10.backupFile, failed.match(/backup kept at (\S+)$/)[1]);
    if (n < 3) {
      assert.ok(logs.some((l) => new RegExp(`\\[db\\] v10 migration will be retried at the next launch \\(failure ${n} of 3\\); set NEXUS_DB_HOLD_V10=1 to stay on v9$`).test(l)), logs.join('\n'));
    } else {
      assert.ok(logs.some((l) => /\[db\] v10 migration has failed 3 times in a row; it is held from the next launch \(held: repeated_failure\)$/.test(l)));
    }
    s.setKv('after_v10_failure', n); assert.equal(s.getKv('after_v10_failure'), n);
    s.close();
    assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).count, n);
    assert.equal(fs.existsSync(platformFailureMarkerPath(file, 9)), false);
    assert.equal(userVersion(file), 9);
  }
  const before = backups(file);
  assert.equal(before.filter((f) => f.startsWith('harness-v9-')).length, 3);
  const held = launch(boom);
  assert.equal(held.s.schemaVersion, 9); assert.equal(held.s.executionAvailable, true); assert.equal(held.s.agentsAvailable, false);
  assert.equal(held.s.lastMigrationV10.state, 'skipped'); assert.equal(held.s.lastMigrationV10.reason, 'held');
  assert.equal(held.s.lastMigrationV10.detail, 'repeated_failure count=3'); assert.equal(held.s.agentsUnavailableReason, 'auto_held');
  assert.ok(held.logs.some((l) => /\[db\] v10 migration: skipped reason=held: repeated_failure count=3; database stays at v9; no new backup taken$/.test(l)));
  assert.ok(held.logs.some((l) => /\[db\] to retry v10, quit and delete harness\.db\.v10-failures\.json next to harness\.db; existing backups are kept \(restore one with the restore tool, tools\/nexus-db-restore\.cjs, if needed\)$/.test(l)));
  assert.ok(!held.logs.some((l) => /v10 precheck|backup ok|v10 migration: start/.test(l)));
  held.s.close();
  assert.deepEqual(backups(file), before, 'no new backup while held');
  fs.rmSync(marker);
  const ok = launch();
  assert.equal(ok.s.schemaVersion, 10); assert.equal(ok.s.lastMigrationV10.state, 'applied'); allOn(ok.s);
  ok.s.close();
  assert.equal(fs.existsSync(marker), false);
});

test('M10-7 a v10 backup that cannot be written skips v10: v9 stays with execution on, no marker', () => {
  const file = v9File(); const dir = path.dirname(file);
  const blocker = path.join(dir, 'not-a-dir'); fs.writeFileSync(blocker, 'x');
  const { s, logs } = openV10(file, { backupDir: path.join(blocker, 'backups') });
  assert.equal(s.schemaVersion, 9); assert.equal(s.executionAvailable, true); assert.equal(s.agentsAvailable, false);
  assert.equal(s.lastMigrationV10.state, 'skipped'); assert.equal(s.lastMigrationV10.reason, 'backup_failed');
  assert.equal(s.lastMigrationV10.detail, 'stage=write'); assert.equal(s.agentsUnavailableReason, 'backup_failed');
  inOrder(logs, ['v10 precheck ok', 'backup failed stage=write error=', 'v10 migration: skipped reason=backup_failed detail=stage=write; database left at v9']);
  assert.ok(!logs.some((l) => /v10 migration: start/.test(l)));
  s.close();
  assert.equal(fs.existsSync(platformFailureMarkerPath(file, 10)), false);
  const db = C.openRaw(file);
  assert.equal(db.pragma('user_version', { simple: true }), 9); assert.equal(v10Objects(db), 0); db.close();
});

// The child opens a v9 file with v10 enabled, forces dirty pages into the WAL, and is killed inside the v10 transaction.
const KILL_CHILD = `
const fs = require('node:fs'); const path = require('node:path');
const file = process.env.NX_V10_KILL_FILE;
const loadTs = require(path.join(process.env.NX_V10_REPO, 'test', 'load-ts.cjs'));
const { PersistStore } = loadTs('src/main/db.ts');
new PersistStore(file).open({ backupDir: path.join(path.dirname(file), 'backups'), log: () => {}, enableV9: true, enableV10: true,
  hooks: {
    beforeTransaction: (db) => { db.pragma('cache_size = 1'); },
    beforeCommit: (_db, toVersion) => {
      if (toVersion !== 10) return;
      let wal = 0;
      try { wal = fs.statSync(file + '-wal').size; } catch { /* no WAL */ }
      fs.writeSync(1, 'IN_TXN wal=' + wal + '\\n');
      process.kill(process.pid, 'SIGKILL');
    }
  } });
fs.writeSync(1, 'NOT_KILLED\\n');
`;

test('M10-8 a process killed inside the v10 transaction leaves a v9 file with no v10 object', () => {
  const file = v9File();
  const pre = C.openRaw(file); const beforeRows = h.allRows(pre); pre.close();
  const r = spawnSync(process.execPath, ['-e', KILL_CHILD],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NX_V10_KILL_FILE: file, NX_V10_REPO: REPO }, encoding: 'utf8', timeout: 120_000 });
  assert.ok(r.status !== 0 || r.signal, `the child must be killed, got status=${r.status} signal=${r.signal} ${r.stderr}`);
  const died = /IN_TXN wal=(\d+)/.exec(r.stdout);
  assert.ok(died, `the child reached the open v10 transaction: ${r.stdout} ${r.stderr}`);
  assert.doesNotMatch(r.stdout, /NOT_KILLED/);
  assert.ok(Number(died[1]) > 0, 'uncommitted v10 frames were in the WAL when the process died');
  assert.equal(backups(file).filter((f) => f.startsWith('harness-v9-')).length, 1, 'the child died after its verified v9 backup');
  const db = C.openRaw(file);
  assert.equal(db.pragma('user_version', { simple: true }), 9);
  assert.equal(v10Objects(db), 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM nexus_migrations WHERE version = 10').get().n, 0);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(h.allRows(db), beforeRows, 'every row of every table is as it was before the kill');
  db.close();
  const { s } = openV10(file, { now: () => h.NOW + 60_000 }); assert.equal(s.schemaVersion, 10); allOn(s); s.close();
});

test('M10-9 a failing v10 post-check commits v10 but turns agents off (execution stays on) and names the backup to restore', () => {
  const file = v9File();
  const { s, logs } = openV10(file, { hooks: { postCheck: (_db, v) => (v === 10 ? false : undefined) } });
  assert.equal(s.schemaVersion, 10); assert.equal(s.platformAvailable, true); assert.equal(s.handoffsAvailable, true);
  assert.equal(s.executionAvailable, true); assert.equal(s.agentsAvailable, false); assert.equal(s.agentsUnavailableReason, 'failed');
  assert.equal(s.lastMigrationV10.state, 'applied'); assert.equal(s.lastMigrationV10.postCheckOk, false);
  assert.ok(logs.some((l) => /\[db\] v10 post-check FAILED; agents disabled; restore from backup harness-v9-\d{8}T\d{6}Z\.db$/.test(l)), logs.join('\n'));
  assert.ok(!logs.some((l) => /v10 migration: success/.test(l)));
  s.close();
  assert.equal(userVersion(file), 10);
});

test('M10-10 reopening at v10 is not_needed with no backup; a damaged v10 trigger turns agents off only (shape)', () => {
  const file = v10File(); const before = backups(file);
  for (let i = 0; i < 2; i++) {
    const { s, logs } = openV10(file);
    assert.equal(s.schemaVersion, 10);
    assert.equal(s.lastMigration.state, 'not_needed'); assert.equal(s.lastMigrationV8.state, 'not_needed');
    assert.equal(s.lastMigrationV9.state, 'not_needed'); assert.equal(s.lastMigrationV10.state, 'not_needed');
    allOn(s);
    assert.ok(!logs.some((l) => /backup ok|migration: start|v10 |v9 /.test(l)), logs.join('\n'));
    s.close();
  }
  assert.deepEqual(backups(file), before);
  const db = C.openRaw(file);
  db.exec('DROP TRIGGER tr_reviews_no_delete; CREATE TRIGGER tr_reviews_no_delete BEFORE DELETE ON reviews BEGIN SELECT 1; END;');
  db.close();
  const { s, logs } = openV10(file);
  assert.equal(s.schemaVersion, 10); assert.equal(s.platformAvailable, true); assert.equal(s.handoffsAvailable, true);
  assert.equal(s.executionAvailable, true); assert.equal(s.agentsAvailable, false); assert.equal(s.agentsUnavailableReason, 'shape');
  assert.ok(logs.some((l) => /\[db\] v10 shape check failed: trigger tr_reviews_no_delete has a different definition; agents disabled$/.test(l)), logs.join('\n'));
  s.close();
  assert.deepEqual(backups(file), before); assert.equal(userVersion(file), 10);
});

test('M10-11 a v10 file opened with v9 off keeps the platform and handoffs; execution and agents report not_enabled; nothing written', () => {
  const file = v10File(); const before = backups(file);
  const raw = C.openRaw(file); const snap = h.allRows(raw); raw.close();
  for (const o of [{}, { enableV10: true }]) {
    const { s, logs } = open(file, o);
    assert.equal(s.schemaVersion, 10); assert.equal(s.platformAvailable, true); assert.equal(s.handoffsAvailable, true);
    assert.equal(s.executionAvailable, false); assert.equal(s.executionUnavailableReason, 'not_enabled');
    assert.equal(s.agentsAvailable, false); assert.equal(s.agentsUnavailableReason, 'not_enabled');
    assert.equal(s.lastMigrationV9.state, 'not_needed');
    assert.equal(s.lastMigrationV10.state, 'skipped'); assert.equal(s.lastMigrationV10.reason, 'v9_unavailable');
    assert.equal(s.lastMigrationV10.detail, 'v9 not_enabled');
    assert.ok(!logs.some((l) => /\bv(9|10)\b/.test(l.replace(/schema version 10/, ''))), logs.join('\n'));
    s.close();
  }
  const after = C.openRaw(file); assert.deepEqual(h.allRows(after), snap); after.close();
  assert.deepEqual(backups(file), before); assert.equal(userVersion(file), 10);
});

test('M10-12 v8 -> v9 -> v10 in one launch with a later failure: v9 commits with its backup, v10 rolls back to v9; v6 -> v10 in one launch', () => {
  const file = v8File(); const pre = backups(file);
  assert.deepEqual(pre.map((f) => f.slice(0, 11)), ['harness-v6-', 'harness-v7-'], 'building the v8 file took the v6 and v7 backups');
  const { s, logs } = openV10(file, { hooks: { beforeCommit: (_db, v) => { if (v === 10) throw new Error('late'); } } });
  assert.equal(s.schemaVersion, 9); assert.equal(s.lastMigrationV9.state, 'applied'); assert.equal(s.lastMigrationV10.state, 'failed');
  assert.equal(s.executionAvailable, true); assert.equal(s.agentsAvailable, false); assert.equal(s.agentsUnavailableReason, 'failed');
  inOrder(logs, ['v9 precheck ok', 'backup ok file=harness-v8-', 'v9 migration: start from=8', 'v9 migration: success to=9',
    'v10 precheck ok', 'backup ok file=harness-v9-', 'v10 migration: start from=9', 'v10 migration: failed from=9 error=late; database left at v9']);
  s.close();
  assert.deepEqual(backups(file).filter((f) => !pre.includes(f)).map((f) => f.slice(0, 11)), ['harness-v8-', 'harness-v9-']);
  assert.equal(JSON.parse(fs.readFileSync(platformFailureMarkerPath(file, 10), 'utf8')).count, 1);
  assert.equal(fs.existsSync(platformFailureMarkerPath(file, 9)), false);
  assert.equal(userVersion(file), 9);
  // The next launch retries v10 only, with a fresh harness-v9 backup.
  const again = openV10(file, { now: () => h.NOW + 60_000 });
  assert.equal(again.s.schemaVersion, 10); assert.equal(again.s.lastMigrationV9.state, 'not_needed'); allOn(again.s);
  again.s.close();
  assert.equal(fs.existsSync(platformFailureMarkerPath(file, 10)), false);
  // v6 -> v10 in one launch: four backups, and the v7, v8 and v9 lines keep their pinned forms.
  const { file: v6 } = h.v6Fixture(); const all = openV10(v6);
  const b = backups(v6);
  assert.deepEqual(b.map((f) => f.slice(0, 11)), ['harness-v6-', 'harness-v7-', 'harness-v8-', 'harness-v9-']);
  assert.equal(all.s.schemaVersion, 10); allOn(all.s);
  for (const k of ['lastMigration', 'lastMigrationV8', 'lastMigrationV9', 'lastMigrationV10']) assert.equal(all.s[k].state, 'applied', k);
  const pinned = [
    /\[db\] v7 migration: success to=7 durationMs=\d+ backfilled=\d+ unassigned=\d+$/,
    /\[db\] v8 migration: success to=8 durationMs=\d+ handoffStates=4 handoffTransitions=3$/,
    /\[db\] v9 migration: success to=9 durationMs=\d+ attemptStates=7 approvalStates=5 deploymentStates=5 relationsAdded=4$/,
    /\[db\] backup ok file=harness-v8-\d{8}T\d{6}Z\.db bytes=\d+ sha256=[0-9a-f]{64} from=8 writeMs=\d+ verifyMs=\d+ hashMs=\d+$/,
    /\[db\] v10 migration: success to=10 durationMs=\d+ tables=6$/
  ];
  for (const re of pinned) assert.ok(all.logs.some((l) => re.test(l)), `${re}\n${all.logs.join('\n')}`);
  assert.equal(all.logs.filter((l) => /\[db\] row counts /.test(l)).length, 4);
  assert.deepEqual(all.s.platformDatabase().prepare('SELECT version, from_version FROM nexus_migrations ORDER BY version').all(),
    [{ version: 7, from_version: 6 }, { version: 8, from_version: 7 }, { version: 9, from_version: 8 }, { version: 10, from_version: 9 }]);
  all.s.close();
});

test('M10-13 the restore tool names NEXUS_DB_HOLD_V10 for a real harness-v9 backup (dry run, nothing changed)', () => {
  assert.equal(holdHint(9), 'Next: launch with NEXUS_DB_HOLD_V10=1 to stay on schema v9, or launch normally: a build with schema v10 enabled '
    + 'migrates it again (a new backup is taken first); a build without it stays on v9.');
  assert.doesNotMatch(holdHint(9), /HOLD_V[789]=/);
  // The v8 sentence is unchanged, and the unreadable-header sentence now names the v9 case too.
  assert.match(holdHint(8), /^Next: launch with NEXUS_DB_HOLD_V9=1 to stay on schema v8, /);
  assert.match(holdHint(null), /NEXUS_DB_HOLD_V10=1/);
  assert.match(holdHint(null), /NEXUS_DB_HOLD_V9=1 for a v8 backup/);
  const file = v9File(); const { s } = openV10(file);
  const rec = s.platformDatabase().prepare('SELECT backup_file, backup_sha256 FROM nexus_migrations WHERE version = 10').get();
  s.close();
  const backup = path.join(path.dirname(file), 'backups', rec.backup_file);
  assert.equal(readUserVersion(backup), 9);
  const listing = () => fs.readdirSync(path.dirname(file)).sort();
  const before = listing(); const bytes = fs.readFileSync(file);
  const r = spawnSync(process.execPath, [path.join(REPO, 'tools', 'nexus-db-restore.cjs'), '--db', file, '--backup', backup, '--sha256', rec.backup_sha256],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('NEXUS_DB_HOLD_V10=1 to stay on schema v9'), r.stdout);
  assert.ok(!/NEXUS_DB_HOLD_V[789]=1/.test(r.stdout), 'no other switch is named');
  assert.deepEqual(listing(), before, 'the dry run moves nothing'); assert.deepEqual(fs.readFileSync(file), bytes);
});

test('M10-14 downgrade: the B2a-close build 4aec76f6 opens a v10 file as newer, legacy-only, and its delete guard stays on', () => {
  const { materializeRev } = require('./helpers/materialize-rev.cjs');
  const { file, dir } = h.v6Fixture();
  const cur = openV10(file);
  assert.equal(cur.s.schemaVersion, 10); allOn(cur.s);
  const pdb = cur.s.platformDatabase();
  const pw = pdb.prepare("SELECT id FROM project_workspaces WHERE project_id = 'p-ledger' AND workspace_id = 'sde'").get().id;
  pdb.prepare(`INSERT INTO jobs (id, kind, project_id, workspace_id, participation_id, idempotency_key, requested_by, on_behalf_of, created_at,
    updated_at, state_changed_at) VALUES ('j-down', 'tool.run', 'p-ledger', 'sde', ?, 'k-down', 'user:local', 'user:local', ?, ?, ?)`).run(pw, h.NOW, h.NOW, h.NOW);
  cur.s.close();
  const oldDb = materializeRev('4aec76f6', h.tmpDir('nx-rev-'));
  assert.match(fs.readFileSync(oldDb, 'utf8'), /export const V9 = 9;/);
  assert.doesNotMatch(fs.readFileSync(oldDb, 'utf8'), /V10/, 'the old build knows nothing of v10');
  const { PersistStore: OldStore } = loadTs.loadAbsolute(oldDb);
  const logs = [];
  const o = C.track(new OldStore(file));
  o.open({ log: (l) => logs.push(l), backupDir: path.join(dir, 'b'), now: () => h.NOW, enableV9: true });
  assert.equal(o.lastMigration.state, 'skipped'); assert.equal(o.lastMigration.reason, 'newer_schema');
  assert.equal(o.platformAvailable, false); assert.equal(o.platformDatabase(), null); assert.equal(o.executionAvailable, false);
  assert.ok(logs.some((l) => /schema v10 is newer than this build \(v9\)/.test(l)), logs.join(' | '));
  assert.equal(o.listProjects().length, 5);
  o.saveProject({ ...o.getProject('p-invoice'), name: 'invoice-ocr-2' });
  assert.equal(o.getProject('p-invoice').name, 'invoice-ocr-2');
  assert.equal(o.deleteProject('p-sales'), true);                    // no platform records
  const raw = h.openRaw(file); const snap = h.allRows(raw); raw.close();
  assert.equal(o.hasPlatformRecords('p-ledger'), true, 'the old guard (version >= 7) still sees the job at v10');
  assert.equal(o.deleteProject('p-ledger'), false);
  const after = h.openRaw(file); assert.deepEqual(h.allRows(after), snap, 'the refused delete wrote nothing'); after.close();
  o.close();
  const db = C.openRaw(file);
  assert.equal(db.pragma('user_version', { simple: true }), 10); assert.equal(v10Objects(db), V10_NAMES.length);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  db.close();
  assert.ok(!fs.existsSync(path.join(dir, 'b')), 'the old build took no backup');
  const n = openV10(file);
  assert.equal(n.s.lastMigrationV10.state, 'not_needed'); allOn(n.s);
  assert.equal(n.s.hasPlatformRecords('p-ledger'), true); assert.equal(n.s.deleteProject('p-ledger'), false);
  n.s.close();
});

test('M10-15 legacy rows are unchanged, the five project_plans rows included; a precheck failure or low disk skips v10 and leaves v9', () => {
  const file = v9File();
  const raw = C.openRaw(file);
  const plan = (id) => JSON.stringify({ projectId: id, milestones: [] });
  for (const id of ['proj_a8a7a6adbc58', 'proj_50dd134996e7', 'p-orphan-3']) raw.prepare('INSERT INTO project_plans VALUES (?,?,?)').run(id, plan(id), h.NOW - 1);
  assert.equal(h.count(raw, 'project_plans'), 5);
  const legacy = h.legacySnapshot(raw); const v9Rows = h.allRows(raw); raw.close();
  for (const [hook, reason, detail] of [
    [() => { throw new Error('probe failed'); }, 'precheck_failed', /^probe failed$/],
    [() => 1024, 'insufficient_disk', /^free=1024 needed=\d+$/]
  ]) {
    const before = backups(file);
    const { s, logs } = openV10(file, { hooks: { freeBytes: hook } });
    assert.equal(s.schemaVersion, 9); assert.equal(s.executionAvailable, true); assert.equal(s.agentsAvailable, false);
    assert.equal(s.lastMigrationV10.reason, reason); assert.match(s.lastMigrationV10.detail, detail);
    assert.equal(s.agentsUnavailableReason, 'failed');
    assert.ok(logs.some((l) => new RegExp(`\\[db\\] v10 migration: skipped reason=${reason} detail=.*; database left at v9$`).test(l)), logs.join('\n'));
    s.close();
    assert.deepEqual(backups(file), before); assert.equal(fs.existsSync(platformFailureMarkerPath(file, 10)), false, 'skips are not failures');
    const db = C.openRaw(file); assert.deepEqual(h.allRows(db), v9Rows, 'a skipped v10 writes nothing'); db.close();
  }
  const { s } = openV10(file);
  assert.equal(s.schemaVersion, 10);
  const db = s.platformDatabase();
  assert.deepEqual(h.legacySnapshot(db), legacy, 'every legacy row is byte-identical after v10');
  assert.equal(h.count(db, 'project_plans'), 5);
  const counts = JSON.parse(db.prepare('SELECT row_counts_json FROM nexus_migrations WHERE version = 10').get().row_counts_json);
  assert.equal(counts.project_plans, 5);
  // v10 adds rows to no v1-v9 table except its own record and activity row.
  for (const [t, rows] of Object.entries(v9Rows)) {
    const want = rows.length + (t === 'nexus_migrations' || t === 'activity' ? 1 : 0);
    assert.equal(h.count(db, t), want, t);
  }
  s.close();
});

test('M10-16 agentsUnavailableReason: null when agents are on or the platform is off; v9 not in place gives the execution reason first', () => {
  const off = openV10(h.v6Fixture().file, { holdV7: true });
  assert.equal(off.s.platformAvailable, false); assert.equal(off.s.agentsUnavailableReason, null); off.s.close();
  const on = openV10(v9File()); assert.equal(on.s.agentsAvailable, true); assert.equal(on.s.agentsUnavailableReason, null); on.s.close();
  // not_enabled, held, auto_held, backup_failed, failed and shape are pinned in M10-5, M10-3, M10-6, M10-7, M10-9 and M10-10.
  // v9 not enabled on a v8 file, v10 enabled: v9's not_enabled comes first, and v10 is skipped silently.
  const notV9 = open(v8File(), { enableV10: true });
  assert.equal(notV9.s.schemaVersion, 8); assert.equal(notV9.s.lastMigrationV10.reason, 'v9_unavailable');
  assert.equal(notV9.s.executionUnavailableReason, 'not_enabled'); assert.equal(notV9.s.agentsUnavailableReason, 'not_enabled');
  assert.deepEqual(v10Lines(notV9.logs), []); notV9.s.close();
  // A v9 transaction failure on a v8 file: execution failed, so agents failed.
  const v9failed = openV10(v8File(), { hooks: { beforeCommit: (_db, v) => { if (v === 9) throw new Error('v9 only'); } } });
  assert.equal(v9failed.s.lastMigrationV10.reason, 'v9_unavailable'); assert.equal(v9failed.s.lastMigrationV10.detail, 'v9 failed');
  assert.equal(v9failed.s.executionUnavailableReason, 'failed'); assert.equal(v9failed.s.agentsUnavailableReason, 'failed');
  v9failed.s.close();
  // A v9 shape problem at v9: execution shape, so agents shape, and v10 writes nothing.
  const file = v9File();
  const pre = C.openRaw(file);
  pre.exec('DROP TRIGGER tr_job_events_no_delete; CREATE TRIGGER tr_job_events_no_delete BEFORE DELETE ON job_events BEGIN SELECT 1; END;');
  pre.close();
  const before = backups(file);
  const shape = openV10(file);
  assert.equal(shape.s.schemaVersion, 9); assert.equal(shape.s.executionAvailable, false); assert.equal(shape.s.agentsAvailable, false);
  assert.equal(shape.s.executionUnavailableReason, 'shape'); assert.equal(shape.s.agentsUnavailableReason, 'shape');
  assert.equal(shape.s.lastMigrationV10.reason, 'v9_unavailable'); assert.equal(shape.s.lastMigrationV10.detail, 'v9 shape');
  assert.deepEqual(v10Lines(shape.logs), []);
  shape.s.close();
  assert.deepEqual(backups(file), before); assert.equal(userVersion(file), 9);
  assert.equal(fs.existsSync(platformFailureMarkerPath(file, 10)), false);
});

test('M10-17 at v10 the platform, handoffs, execution and agents are all on, and a reopen runs no step and logs no v9 line', () => {
  const file = v10File(); const before = backups(file);
  const { s, logs } = openV10(file);
  assert.equal(s.schemaVersion, 10); allOn(s);
  assert.equal(s.handoffsUnavailableReason, null);
  for (const k of ['lastMigration', 'lastMigrationV8', 'lastMigrationV9', 'lastMigrationV10']) assert.equal(s[k].state, 'not_needed', k);
  assert.equal(s.lastMigrationV9.version, 9); assert.equal(s.lastMigrationV10.version, 10);
  assert.deepEqual(logs.map(plain), ['[db] schema version 10'], 'the reopen logs only the version line');
  assert.ok(s.platformDatabase());
  s.close();
  assert.deepEqual(backups(file), before);
  // A damaged v9 object at v10 is caught by the reopen v9 check: execution and agents go off with shape; handoffs stay on.
  const raw = C.openRaw(file);
  raw.exec('DROP INDEX ix_jobs_sched');
  raw.close();
  const damaged = openV10(file);
  assert.equal(damaged.s.schemaVersion, 10); assert.equal(damaged.s.handoffsAvailable, true);
  assert.equal(damaged.s.executionAvailable, false); assert.equal(damaged.s.executionUnavailableReason, 'shape');
  assert.equal(damaged.s.agentsAvailable, false); assert.equal(damaged.s.agentsUnavailableReason, 'shape');
  assert.ok(damaged.logs.some((l) => /\[db\] v9 shape check failed: index ix_jobs_sched is missing; execution disabled$/.test(l)), damaged.logs.join('\n'));
  damaged.s.close();
});

test('M10-18 a v10 file with v10 not enabled leaves execution on and agents off (not_enabled), with no v10 line and no write', () => {
  const file = v10File(); const before = backups(file);
  const raw = C.openRaw(file); const snap = h.allRows(raw); raw.close();
  const { s, logs } = openV9(file);
  assert.equal(s.schemaVersion, 10); assert.equal(s.platformAvailable, true); assert.equal(s.handoffsAvailable, true);
  assert.equal(s.executionAvailable, true); assert.equal(s.executionUnavailableReason, null);
  assert.equal(s.agentsAvailable, false); assert.equal(s.agentsUnavailableReason, 'not_enabled');
  assert.equal(s.lastMigrationV10.state, 'not_needed');
  assert.deepEqual(v10Lines(logs.filter((l) => !/schema version/.test(l))), []);
  s.close();
  const after = C.openRaw(file); assert.deepEqual(h.allRows(after), snap); after.close();
  assert.deepEqual(backups(file), before); assert.equal(userVersion(file), 10);
});

test('M10-19 a newer schema (v11) is opened for legacy use only: nothing migrated, every feature off', () => {
  const file = v10File();
  const pre = C.openRaw(file); pre.pragma('user_version = 11'); pre.close();
  const before = backups(file);
  const { s, logs } = openV10(file);
  assert.equal(s.schemaVersion, 11); assert.equal(s.platformAvailable, false); assert.equal(s.platformDatabase(), null);
  assert.equal(s.handoffsAvailable, false); assert.equal(s.executionAvailable, false); assert.equal(s.agentsAvailable, false);
  assert.equal(s.executionUnavailableReason, null); assert.equal(s.agentsUnavailableReason, null);
  for (const k of ['lastMigration', 'lastMigrationV8', 'lastMigrationV9', 'lastMigrationV10']) assert.equal(s[k].reason, 'newer_schema', k);
  assert.ok(logs.some((l) => l.includes('schema v11 is newer than this build (v10)')), logs.join('\n'));
  assert.equal(s.getKv('window_bounds').width, 1200);
  s.close();
  assert.deepEqual(backups(file), before); assert.equal(userVersion(file), 11);
});

test('M10-20 the exact-version sites in db.ts read v10 (source pins)', () => {
  const src = fs.readFileSync(path.join(REPO, 'src', 'main', 'db.ts'), 'utf8');
  assert.match(src, /export const V10_ENABLED_BY_DEFAULT = false;/);
  assert.match(src, /export const V10_FAILURE_LIMIT = 3;/);
  assert.match(src, /this\.version >= V7 && this\.version <= V10 && this\.platformOk/);
  assert.match(src, /this\.version >= V8 && this\.version <= V10 && this\.handoffsOk/);
  assert.match(src, /this\.version >= V9 && this\.version <= V10 && this\.executionOk && this\.v9Enabled/);
  assert.match(src, /if \(from > V10\)/);
  assert.doesNotMatch(src, /this\.version === V9\b/);
  assert.doesNotMatch(src, /version === V8 \|\| this\.version === V9/);
  assert.doesNotMatch(src, /from > V9\b/);
  assert.doesNotMatch(src, /V10_ENABLED_BY_DEFAULT = true/);
});

test('M10-16b no log line of this file contains a temp folder', () => {
  assert.ok(ALL_LOGS.length > 100);
  for (const { line, dir } of ALL_LOGS) {
    assert.ok(!line.includes(dir) && !line.includes(dir.replace(/\\/g, '/')), line);
  }
});
