'use strict';
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { PersistStore, MIGRATIONS } = loadTs('src/main/db.ts');

function openStore(file, extra = {}) {
  const logs = [];
  const s = new PersistStore(file);
  s.open({ backupDir: path.join(path.dirname(file), 'backups'), log: (l) => logs.push(l), now: () => h.NOW, appVersion: 'test', holdV8: true, ...extra });
  return { s, logs };
}
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const tableExists = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

test('1. a fresh database goes to v7 with seeds and no backup', () => {
  const dir = h.tmpDir(); const file = path.join(dir, 'harness.db');
  const { s, logs } = openStore(file);
  assert.equal(s.schemaVersion, 7); assert.equal(s.platformAvailable, true);
  const db = h.openRaw(file);
  assert.deepEqual(db.prepare('SELECT id, kind FROM principals ORDER BY id').all(), [{ id: 'system', kind: 'system' }, { id: 'user:local', kind: 'user' }]);
  assert.equal(db.prepare("SELECT role FROM memberships WHERE principal_id='user:local' AND scope_type='platform' AND scope_id='*'").get().role, 'owner');
  assert.equal(h.count(db, 'workspaces'), 8); assert.equal(h.count(db, 'job_states'), 11);
  assert.equal(h.count(db, 'job_state_transitions'), 23); assert.equal(h.count(db, 'lineage_relations'), 32);
  assert.equal(h.count(db, 'agent_session_states'), 8); assert.equal(h.count(db, 'agent_session_transitions'), 14);
  assert.equal(h.count(db, 'agent_sessions'), 0);
  const rec = db.prepare('SELECT * FROM nexus_migrations').get();
  assert.equal(rec.from_version, 0); assert.equal(rec.backup_file, null);
  assert.ok(!fs.existsSync(path.join(dir, 'backups')));
  assert.ok(logs.some((l) => /\[db\] v7 migration: success to=7/.test(l)));
  db.close(); s.close();
});

test('2. a realistic v6 database goes to v7 and its projects get their primary workspace', () => {
  const { file } = h.v6Fixture(); const { s } = openStore(file);
  assert.equal(s.schemaVersion, 7);
  const db = h.openRaw(file);
  assert.deepEqual(db.prepare(`SELECT project_id, workspace_id, is_primary, status, source, created_by
    FROM project_workspaces ORDER BY project_id`).all(), [
    { project_id: 'p-invoice', workspace_id: 'dl', is_primary: 1, status: 'active', source: 'backfill', created_by: 'system' },
    { project_id: 'p-ledger', workspace_id: 'sde', is_primary: 1, status: 'active', source: 'backfill', created_by: 'system' },
    { project_id: 'p-sales', workspace_id: 'data', is_primary: 1, status: 'active', source: 'backfill', created_by: 'system' }
  ]);   // p-audit (cybersecurity) and p-old (unknown) stay Unassigned; secondary domains create nothing
  assert.deepEqual(JSON.parse(db.prepare('SELECT backfill_json FROM nexus_migrations').get().backfill_json), { inserted: 3, unassigned: 2 });
  db.close(); s.close();
});

test('3. applied exactly once: one record, one backup, one migration activity row', () => {
  const { dir, file } = h.v6Fixture();
  openStore(file).s.close(); openStore(file).s.close(); openStore(file).s.close();
  const db = h.openRaw(file);
  assert.equal(h.count(db, 'nexus_migrations'), 1);
  assert.equal(fs.readdirSync(path.join(dir, 'backups')).length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activity WHERE action='db.migrated'").get().n, 1);
  assert.equal(h.count(db, 'project_workspaces'), 3);
  db.close();
});

test('4. re-running the v7 step on a v7 database changes nothing at all', () => {
  const { file } = h.v6Fixture(); openStore(file).s.close();
  const db = h.openRaw(file);
  const before = { schema: h.schemaObjects(db), rows: h.allRows(db), v: db.pragma('user_version', { simple: true }) };
  db.transaction(() => MIGRATIONS[6](db, { now: () => h.NOW + 1, appVersion: 'test', fromVersion: 7, preCounts: null, backup: null }))();
  assert.deepEqual({ schema: h.schemaObjects(db), rows: h.allRows(db), v: db.pragma('user_version', { simple: true }) }, before);
  db.close();
});

test('5. projects are intact, byte for byte, and readable through the store', () => {
  const { file, snap } = h.v6Fixture(); const { s } = openStore(file);
  const db = h.openRaw(file); assert.deepEqual(db.prepare('SELECT * FROM projects ORDER BY rowid').all(), snap.projects); db.close();
  assert.deepEqual(s.listProjects().map((p) => p.id).sort(), ['p-audit', 'p-invoice', 'p-ledger', 'p-old', 'p-sales']);
  assert.equal(s.getProject('p-ledger').domainId, 'software-engineering');
  assert.deepEqual(s.getProject('p-ledger').secondaryDomains, ['devops-cloud']);
  s.close();
});

test('6. plans, gaps and goals stay readable, orphans included and untouched', () => {
  const { file, snap } = h.v6Fixture(); const { s } = openStore(file);
  const db = h.openRaw(file);
  for (const t of ['project_plans', 'project_gaps', 'project_goals']) assert.deepEqual(db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all(), snap[t], t);
  db.close();
  assert.equal(s.getProjectPlan('p-ledger').projectId, 'p-ledger');
  assert.equal(s.getProjectPlan('p-gone').projectId, 'p-gone');
  assert.equal(s.getProjectGapAnalysis('p-gone').projectId, 'p-gone');
  assert.equal(s.getProjectGoal('p-invoice').title, 'Read invoice totals');
  s.close();
});

test('7. the knowledge graph is intact and traversable', () => {
  const { file, snap } = h.v6Fixture(); const { s } = openStore(file);
  const db = h.openRaw(file);
  assert.deepEqual(db.prepare('SELECT * FROM project_graph_nodes ORDER BY rowid').all(), snap.project_graph_nodes);
  assert.deepEqual(db.prepare('SELECT * FROM project_graph_edges ORDER BY rowid').all(), snap.project_graph_edges);
  db.close();
  assert.equal(s.getProjectGraphStats('p-ledger').nodeCount, 3);
  assert.equal(s.getProjectSubgraph('p-ledger', 'n-api', 2).edges.length, 2);
  s.close();
});

test('8. kv settings and command history are intact', () => {
  const { file, snap } = h.v6Fixture(); const { s } = openStore(file);
  const db = h.openRaw(file);
  assert.deepEqual(db.prepare('SELECT * FROM kv ORDER BY rowid').all(), snap.kv);
  assert.deepEqual(db.prepare('SELECT * FROM command_history ORDER BY rowid').all(), snap.command_history);
  db.close();
  assert.deepEqual(s.getKv('window_bounds'), { x: 10, y: 20, width: 1200, height: 800 });
  assert.equal(s.getActiveProjectId(), 'p-ledger');
  assert.equal(s.searchHistory('unit tests').length, 1);
  s.close();
});

test('9. a verified backup of the v6 data exists, was taken before the change, and is recorded', () => {
  const { dir, file, snap } = h.v6Fixture(); const { s, logs } = openStore(file); s.close();
  const db = h.openRaw(file); const rec = db.prepare('SELECT * FROM nexus_migrations').get(); db.close();
  const bpath = path.join(dir, 'backups', rec.backup_file);
  assert.equal(sha(bpath), rec.backup_sha256);
  assert.equal(fs.statSync(bpath).size, rec.backup_bytes);
  const Database = require('better-sqlite3'); const b = new Database(bpath, { readonly: true });
  assert.equal(b.pragma('user_version', { simple: true }), 6);
  assert.equal(tableExists(b, 'artifacts'), false);
  assert.deepEqual(h.legacySnapshot(b), snap);
  b.close();
  assert.deepEqual(JSON.parse(rec.row_counts_json).projects, 5);
  const at = (re) => logs.findIndex((l) => re.test(l));
  assert.ok(at(/\[db\] backup ok/) >= 0 && at(/\[db\] backup ok/) < at(/v7 migration: start from=6/));
  assert.ok(at(/v7 migration: start/) < at(/v7 migration: success to=7/));
  assert.ok(!logs.some((l) => l.includes(dir)), 'logs carry basenames only');
});

test('10a. a failure inside the transaction leaves v6 exactly as it was, and the store keeps working', () => {
  const { file, snap } = h.v6Fixture();
  const pre = h.openRaw(file); const schema = h.schemaObjects(pre); pre.close();
  const { s, logs } = openStore(file, { hooks: { beforeCommit: () => { throw new Error('injected failure'); } } });
  assert.equal(s.isOpen, true); assert.equal(s.schemaVersion, 6); assert.equal(s.platformAvailable, false);
  assert.equal(s.lastMigration.state, 'failed');
  assert.ok(logs.some((l) => /v7 migration: failed from=6 .*injected failure.*left at v6/.test(l)));
  s.setKv('after_failure', 1); assert.equal(s.getKv('after_failure'), 1);   // legacy writes still work
  s.close();
  const db = h.openRaw(file);
  assert.deepEqual(h.schemaObjects(db), schema);
  assert.equal(db.pragma('user_version', { simple: true }), 6);
  const now = h.legacySnapshot(db); now.kv = now.kv.filter((r) => r.key !== 'after_failure');
  assert.deepEqual(now, snap);
  db.close();
  const again = openStore(file); assert.equal(again.s.schemaVersion, 7); again.s.close();   // a clean retry succeeds
});

test('10b. a process killed mid-transaction leaves no half-upgraded state', () => {
  const { file, snap } = h.v6Fixture();
  const r = spawnSync(process.execPath, [path.join(__dirname, 'helpers', 'migrate-and-die.cjs'), file],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' });
  assert.ok(r.status !== 0 || r.signal, `the child must be killed, got status=${r.status} signal=${r.signal} ${r.stderr}`);
  const died = /IN_TXN wal=(\d+)/.exec(r.stdout);
  assert.ok(died, `the child reached the open transaction: ${r.stdout} ${r.stderr}`);
  assert.doesNotMatch(r.stdout, /NOT_KILLED/);
  assert.ok(Number(died[1]) > 0, 'uncommitted v7 frames were in the WAL when the process died');
  assert.equal(fs.readdirSync(path.join(path.dirname(file), 'backups')).length, 1, 'the child died after its verified backup, inside the transaction');
  const db = h.openRaw(file);
  assert.equal(db.pragma('user_version', { simple: true }), 6);
  for (const t of ['principals', 'project_workspaces', 'agent_sessions', 'artifacts', 'jobs', 'activity', 'nexus_migrations']) assert.equal(tableExists(db, t), false, t);
  assert.deepEqual(h.legacySnapshot(db), snap);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  db.close();
});

test('10c. a failed backup skips v7 and touches nothing', () => {
  const { dir, file, snap } = h.v6Fixture();
  const blocker = path.join(dir, 'not-a-dir'); fs.writeFileSync(blocker, 'x');
  const { s, logs } = openStore(file, { backupDir: blocker });
  assert.equal(s.schemaVersion, 6); assert.equal(s.lastMigration.reason, 'backup_failed');
  assert.ok(logs.some((l) => /skipped reason=backup_failed/.test(l)));
  s.close();
  const db = h.openRaw(file); assert.deepEqual(h.legacySnapshot(db), snap); db.close();
});

test('held: NEXUS_DB_HOLD_V7 keeps the database at v6 and takes no backup', () => {
  const { dir, file } = h.v6Fixture(); const { s } = openStore(file, { holdV7: true });
  assert.equal(s.schemaVersion, 6); assert.equal(s.lastMigration.reason, 'held');
  assert.ok(!fs.existsSync(path.join(dir, 'backups'))); s.close();
});

test('an older v3 database is backed up first, then migrated through v6 to v7', () => {
  const dir = h.tmpDir(); const file = path.join(dir, 'harness.db');
  const db = h.openRaw(file);
  for (let i = 0; i < 3; i++) db.transaction(() => { MIGRATIONS[i](db, null); db.pragma(`user_version = ${i + 1}`); })();
  db.prepare("INSERT INTO kv VALUES ('k', '1', 1)").run(); db.close();
  const { s } = openStore(file); assert.equal(s.schemaVersion, 7); s.close();
  assert.match(fs.readdirSync(path.join(dir, 'backups'))[0], /^harness-v3-/);
});

test('a pre-existing table with a v7 name but the wrong shape fails verification and rolls back', () => {
  const { file } = h.v6Fixture();
  const pre = h.openRaw(file); pre.exec('CREATE TABLE artifacts (x TEXT)'); pre.close();
  const { s, logs } = openStore(file);
  assert.equal(s.schemaVersion, 6); assert.ok(logs.some((l) => /failed from=6 .*artifacts/.test(l))); s.close();
  const db = h.openRaw(file);
  assert.deepEqual(db.prepare('PRAGMA table_info(artifacts)').all().map((c) => c.name), ['x']);
  assert.equal(tableExists(db, 'principals'), false); db.close();
});

test('logs never carry row contents or secrets', () => {
  const { file } = h.v6Fixture();
  const pre = h.openRaw(file); pre.prepare("INSERT INTO kv VALUES ('integration', ?, 1)").run(JSON.stringify({ token: 'sk-ant-abcdefghijklmnopqrstuv' })); pre.close();
  const { s, logs } = openStore(file); s.close();
  const text = logs.join('\n');
  assert.doesNotMatch(text, /sk-ant-|ledger-api|run the unit tests|C:\/work/);
  assert.match(text, /row counts .*projects=5/);
});

test('foreign keys hold and nothing references a missing row after migration', () => {
  const { file } = h.v6Fixture(); openStore(file).s.close();
  const db = h.openRaw(file);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  db.close();
});

// ─── additional coverage (plan: downgrade safety, record, activity, observability) ───

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;

test('the log is the exact observable sequence, every line ISO-stamped and basename-only', () => {
  const { dir, file } = h.v6Fixture(); const { s, logs } = openStore(file); s.close();
  for (const l of logs) assert.match(l, ISO, l);
  const body = logs.map((l) => l.replace(ISO, ''));
  const db = h.openRaw(file); const rec = db.prepare('SELECT * FROM nexus_migrations').get(); db.close();
  const expect = [
    /^\[db\] schema version 6$/,
    /^\[db\] v7 precheck ok integrity=ok integrityMs=\d+ free=\d+ needed=\d+$/,
    new RegExp(`^\\[db\\] backup ok file=${rec.backup_file.replace(/\./g, '\\.')} bytes=${rec.backup_bytes} sha256=${rec.backup_sha256} from=6 writeMs=\\d+ verifyMs=\\d+ hashMs=\\d+$`),
    /^\[db\] row counts command_history=2 kv=3 project_gaps=2 project_goals=1 project_graph_edges=2 project_graph_nodes=3 project_plans=2 projects=5$/,
    /^\[db\] v7 migration: start from=6$/,
    /^\[db\] v7 migration: success to=7 durationMs=\d+ backfilled=3 unassigned=2$/,
    /^\[db\] v8 migration: skipped reason=held \(NEXUS_DB_HOLD_V8=1\); database stays at v7$/
  ];
  assert.equal(body.length, expect.length, body.join('\n'));
  expect.forEach((re, i) => assert.match(body[i], re));
  const text = logs.join('\n');
  assert.ok(!text.includes(dir) && !text.includes(dir.replace(/\\/g, '/')), 'no directory in any line');
  assert.doesNotMatch(text, /window_bounds|p-ledger|First release/);
});

test('a failure line names the redacted error, the version kept and the backup basename only', () => {
  const { dir, file } = h.v6Fixture();
  const { s, logs } = openStore(file, { hooks: { beforeCommit: () => {
    throw new Error(`boom token=sk-ant-abcdefghijklmnopqrstuv at ${path.join(dir, 'harness.db')}`);
  } } });
  s.close();
  const line = logs.find((l) => /v7 migration: failed/.test(l));
  assert.ok(line, logs.join('\n'));
  assert.match(line, ISO);
  assert.match(line, /failed from=6 error=.*; database left at v6; backup kept at harness-v6-\d{8}T\d{6}Z\.db$/);
  assert.doesNotMatch(line, /sk-ant-/);
  assert.ok(!line.includes(dir), line);
  assert.equal(s.lastMigration.backupFile, line.match(/backup kept at (\S+)$/)[1]);
});

test('the migration record and the activity row describe the change and chain from genesis', () => {
  const { dir, file } = h.v6Fixture(); openStore(file).s.close();
  const db = h.openRaw(file);
  const rec = db.prepare('SELECT * FROM nexus_migrations').get();
  const backups = fs.readdirSync(path.join(dir, 'backups'));
  assert.deepEqual(backups, [rec.backup_file]);
  assert.equal(rec.version, 7); assert.equal(rec.from_version, 6); assert.equal(rec.applied_at, h.NOW);
  assert.equal(rec.app_version, 'test');
  assert.deepEqual(JSON.parse(rec.row_counts_json), { command_history: 2, kv: 3, project_gaps: 2, project_goals: 1,
    project_graph_edges: 2, project_graph_nodes: 3, project_plans: 2, projects: 5 });
  const rows = db.prepare('SELECT * FROM activity ORDER BY seq').all();
  assert.equal(rows.length, 1);
  const a = rows[0];
  assert.equal(a.action, 'db.migrated'); assert.equal(a.status, 'succeeded');
  assert.equal(a.actor_kind, 'system'); assert.equal(a.actor_id, 'system'); assert.equal(a.ts, h.NOW);
  assert.equal(a.prev_hash, '0'.repeat(64)); assert.match(a.hash, /^[0-9a-f]{64}$/); assert.match(a.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.deepEqual(JSON.parse(a.details_json), { from: 6, to: 7, backupFile: rec.backup_file, backupSha256: rec.backup_sha256, backfilled: 3, unassigned: 2 });
  const { activityHash } = loadTs('src/main/nexus/activity/writer.ts');
  assert.equal(activityHash(a.prev_hash, { id: a.id, ts: a.ts, actorKind: a.actor_kind, actorId: a.actor_id, onBehalfOf: a.on_behalf_of,
    sessionId: a.session_id, jobId: a.job_id, workspaceId: a.workspace_id, projectId: a.project_id, artifactId: a.artifact_id,
    versionId: a.version_id, entityType: a.entity_type, entityId: a.entity_id, action: a.action, status: a.status, detailsJson: a.details_json }), a.hash);
  db.close();
});

test('the v7 objects match the plan DDL exactly (17 tables, 17 indexes, 27 triggers)', () => {
  const { V7_EXPECTED, V7_DDL, v7DdlObjects } = loadTs('src/main/nexus/db/schemaV7.ts');
  const objs = v7DdlObjects(V7_DDL);
  assert.equal(Object.keys(V7_EXPECTED.tables).length, 17);
  assert.equal(V7_EXPECTED.indexes.length, 17); assert.equal(V7_EXPECTED.triggers.length, 27);
  assert.deepEqual(objs.filter((o) => o.type === 'table').map((o) => o.name).sort(), Object.keys(V7_EXPECTED.tables).sort());
  assert.deepEqual(objs.filter((o) => o.type === 'index').map((o) => o.name).sort(), [...V7_EXPECTED.indexes].sort());
  assert.deepEqual(objs.filter((o) => o.type === 'trigger').map((o) => o.name).sort(), [...V7_EXPECTED.triggers].sort());
  assert.doesNotMatch(V7_DDL, /\bDROP\b|\bDELETE\s+FROM\b|\bALTER\b|\bRENAME\b/i);
  const dir = h.tmpDir(); const file = path.join(dir, 'harness.db'); openStore(file).s.close();
  const db = h.openRaw(file);
  for (const [t, cols] of Object.entries(V7_EXPECTED.tables)) assert.deepEqual(db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name), cols, t);
  db.close();
});

test('the seeds are exactly the frozen v7 seed', () => {
  const seed = loadTs('src/main/nexus/db/v7Seed.ts');
  const dir = h.tmpDir(); const file = path.join(dir, 'harness.db'); openStore(file).s.close();
  const db = h.openRaw(file);
  assert.deepEqual(db.prepare('SELECT id, kind, display_name AS displayName, disabled_at, created_at FROM principals ORDER BY id').all(),
    [...seed.V7_PRINCIPALS].map((p) => ({ ...p, disabled_at: null, created_at: h.NOW })).sort((a, b) => a.id.localeCompare(b.id)));
  assert.deepEqual(db.prepare('SELECT principal_id AS principalId, role FROM memberships WHERE scope_type=\'platform\' AND scope_id=\'*\' ORDER BY principal_id').all(),
    [...seed.V7_MEMBERSHIPS].sort((a, b) => a.principalId.localeCompare(b.principalId)));
  assert.equal(h.count(db, 'memberships'), 2);
  assert.deepEqual(db.prepare('SELECT id FROM workspaces ORDER BY rowid').all().map((r) => r.id), [...seed.V7_WORKSPACE_IDS]);
  assert.deepEqual(db.prepare('SELECT state, terminal FROM job_states ORDER BY rowid').all(), [...seed.V7_JOB_STATES]);
  assert.deepEqual(db.prepare('SELECT from_state, to_state FROM job_state_transitions ORDER BY rowid').all().map((r) => [r.from_state, r.to_state]), seed.V7_JOB_TRANSITIONS.map((t) => [...t]));
  assert.deepEqual(db.prepare('SELECT state, terminal FROM agent_session_states ORDER BY rowid').all(), [...seed.V7_SESSION_STATES]);
  assert.deepEqual(db.prepare('SELECT from_state, to_state FROM agent_session_transitions ORDER BY rowid').all().map((r) => [r.from_state, r.to_state]), seed.V7_SESSION_TRANSITIONS.map((t) => [...t]));
  assert.deepEqual(db.prepare('SELECT relation, description, planned_phase AS plannedPhase FROM lineage_relations ORDER BY rowid').all(), [...seed.V7_LINEAGE_RELATIONS]);
  db.close();
});

test('downgrade safety: the e1fd80f store opens a v7 database and its reads and writes still work', () => {
  const { file, snap } = h.v6Fixture(); openStore(file).s.close();
  const ts = require('typescript');
  const src = spawnSync('git', ['show', 'e1fd80f:src/main/db.ts'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(src.status, 0, src.stderr);
  const js = ts.transpileModule(src.stdout, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  const req = (r) => r.startsWith('.') ? loadTs(path.join('src/main', `${r}.ts`)) : require(r);
  new Function('module', 'exports', 'require', js)(mod, mod.exports, req);
  const old = new mod.exports.PersistStore(file); old.open();
  assert.deepEqual(old.listProjects().map((p) => p.id).sort(), ['p-audit', 'p-invoice', 'p-ledger', 'p-old', 'p-sales']);
  assert.deepEqual(old.getKv('window_bounds'), { x: 10, y: 20, width: 1200, height: 800 });
  assert.equal(old.getProjectPlan('p-gone').projectId, 'p-gone');
  old.setKv('old_build', 1); assert.equal(old.getKv('old_build'), 1);
  const p = old.getProject('p-sales');
  old.saveProject({ ...p, name: 'renamed', updatedAt: h.NOW + 5 }); assert.equal(old.getProject('p-sales').name, 'renamed');
  assert.equal(old.deleteProject('p-ledger'), true);   // participation cascades with the project
  assert.equal(old.getProject('p-ledger'), null);
  old.close();
  const db = h.openRaw(file);
  assert.equal(db.pragma('user_version', { simple: true }), 7);
  assert.deepEqual(db.prepare('SELECT project_id FROM project_workspaces ORDER BY project_id').all().map((r) => r.project_id), ['p-invoice', 'p-sales']);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.deepEqual(db.prepare('SELECT * FROM project_plans ORDER BY rowid').all(), snap.project_plans);
  db.close();
  const again = openStore(file); assert.equal(again.s.lastMigration.state, 'not_needed'); assert.equal(again.s.platformAvailable, true); again.s.close();
});

test('a newer schema is opened for legacy use only, never migrated or downgraded', () => {
  const { file } = h.v6Fixture(); openStore(file).s.close();
  const pre = h.openRaw(file); pre.pragma('user_version = 11'); pre.close();
  const { s, logs } = openStore(file);
  assert.equal(s.isOpen, true); assert.equal(s.schemaVersion, 11); assert.equal(s.platformAvailable, false);
  assert.equal(s.platformDatabase(), null);
  assert.equal(s.lastMigration.reason, 'newer_schema');
  assert.ok(logs.some((l) => /schema v11 is newer than this build \(v10\)/.test(l)));
  assert.equal(s.getKv('window_bounds').width, 1200);
  s.close();
});

test('the hold also comes from NEXUS_DB_HOLD_V7=1 in the environment', () => {
  const { file } = h.v6Fixture();
  process.env.NEXUS_DB_HOLD_V7 = '1';
  try {
    const { s, logs } = openStore(file);
    assert.equal(s.schemaVersion, 6); assert.equal(s.lastMigration.reason, 'held');
    assert.ok(logs.some((l) => /skipped reason=held/.test(l))); s.close();
  } finally { delete process.env.NEXUS_DB_HOLD_V7; }
});

test('writes submitted before open wait in the legacy queue and land after the migration', () => {
  const { file } = h.v6Fixture();
  const s = new PersistStore(file);
  s.setKv('early', { a: 1 });
  assert.equal(s.pendingWrites, 1);
  s.open({ backupDir: path.join(path.dirname(file), 'backups'), log: () => {}, now: () => h.NOW, holdV8: true });
  assert.equal(s.schemaVersion, 7); assert.equal(s.pendingWrites, 0);
  assert.deepEqual(s.getKv('early'), { a: 1 });
  s.close();
  const b = new (require('better-sqlite3'))(path.join(path.dirname(file), 'backups', fs.readdirSync(path.join(path.dirname(file), 'backups'))[0]), { readonly: true });
  assert.equal(b.prepare("SELECT COUNT(*) AS n FROM kv WHERE key='early'").get().n, 0, 'the backup is the pre-write state');
  b.close();
});

test('a v7 database whose v7 objects were altered opens with the platform disabled', () => {
  const { file } = h.v6Fixture(); openStore(file).s.close();
  const pre = h.openRaw(file); pre.exec('DROP INDEX ix_jobs_state'); pre.close();
  const { s, logs } = openStore(file);
  assert.equal(s.schemaVersion, 7); assert.equal(s.platformAvailable, false); assert.equal(s.platformDatabase(), null);
  assert.ok(logs.some((l) => /v7 shape check failed.*ix_jobs_state/.test(l)), logs.join('\n'));
  assert.equal(s.getKv('window_bounds').width, 1200);
  s.close();
});

test('platformDatabase is the open connection once v7 is in place', () => {
  const dir = h.tmpDir(); const { s } = openStore(path.join(dir, 'harness.db'));
  const db = s.platformDatabase();
  assert.ok(db); assert.equal(db.pragma('user_version', { simple: true }), 7);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  s.close(); assert.equal(s.platformDatabase(), null);
});

test('ids and canonical JSON', () => {
  const { newId } = loadTs('src/main/nexus/db/ids.ts');
  const { canonicalJson } = loadTs('src/main/nexus/db/canonical.ts');
  const ids = Array.from({ length: 50 }, () => newId());
  for (const id of ids) assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(new Set(ids).size, 50);
  assert.ok(newId(0) < newId(Date.now()), 'time-ordered prefix');
  assert.equal(newId(0).slice(0, 10), '0000000000');
  assert.equal(canonicalJson({ b: 1, a: [3, { d: undefined, c: null }], e: NaN }), '{"a":[3,{"c":null}],"b":1,"e":null}');
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
});

// ─── fix round 1: the two untested skip paths, repeated-failure hold, streamed hash ───

function legacyStillUsable(s) {
  assert.equal(s.isOpen, true); assert.equal(s.platformAvailable, false); assert.equal(s.platformDatabase(), null);
  assert.equal(s.getKv('window_bounds').width, 1200);
  assert.equal(s.listProjects().length, 5);
  s.setKv('after_skip', 2); assert.equal(s.getKv('after_skip'), 2);
}

test('precheck_failed: a database whose integrity_check is not ok is left at v6, untouched and usable', () => {
  const { dir, file } = h.v6Fixture();
  const pre = h.openRaw(file);
  const pageSize = pre.pragma('page_size', { simple: true });
  const root = pre.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'idx_graph_edges_kind'").get().rootpage;
  pre.close();
  assert.ok(!fs.existsSync(`${file}-wal`), 'fixture fully checkpointed');
  // One byte of one index key: 'imports' -> 'jmports' in the index only. The file still opens and
  // legacy reads work, but the index no longer matches its table.
  const fd = fs.openSync(file, 'r+'); const page = Buffer.alloc(pageSize);
  fs.readSync(fd, page, 0, pageSize, (root - 1) * pageSize);
  const at = page.indexOf(Buffer.from('imports'), page.readUInt16BE(5)); assert.ok(at > 0);
  page[at] = 0x6a; fs.writeSync(fd, page, 0, pageSize, (root - 1) * pageSize); fs.closeSync(fd);
  const raw = h.openRaw(file); assert.notEqual(raw.pragma('integrity_check', { simple: true }), 'ok');
  const before = { schema: h.schemaObjects(raw), legacy: h.legacySnapshot(raw) }; raw.close();
  const { s, logs } = openStore(file);
  assert.equal(s.lastMigration.state, 'skipped'); assert.equal(s.lastMigration.reason, 'precheck_failed');
  assert.equal(s.schemaVersion, 6);
  assert.ok(logs.some((l) => /v7 migration: skipped reason=precheck_failed detail=integrity_check is not ok; database left at v6/.test(l)), logs.join('\n'));
  assert.ok(!fs.existsSync(path.join(dir, 'backups')), 'no backup of a corrupt database');
  legacyStillUsable(s);
  s.close();
  const db = h.openRaw(file);
  assert.equal(db.pragma('user_version', { simple: true }), 6);
  assert.deepEqual(h.schemaObjects(db), before.schema);
  const now = h.legacySnapshot(db); now.kv = now.kv.filter((r) => r.key !== 'after_skip');
  assert.deepEqual(now, before.legacy);
  db.close();
});

test('insufficient_disk: too little free space skips v7 before any backup, and the store stays usable', () => {
  const { dir, file, snap } = h.v6Fixture();
  const { s, logs } = openStore(file, { hooks: { freeBytes: () => 1024 } });
  assert.equal(s.lastMigration.state, 'skipped'); assert.equal(s.lastMigration.reason, 'insufficient_disk');
  assert.match(s.lastMigration.detail, /^free=1024 needed=\d+$/);
  assert.equal(s.schemaVersion, 6);
  assert.ok(logs.some((l) => /v7 migration: skipped reason=insufficient_disk detail=free=1024 needed=\d+; database left at v6/.test(l)), logs.join('\n'));
  assert.ok(!fs.existsSync(path.join(dir, 'backups')));
  legacyStillUsable(s);
  s.close();
  const db = h.openRaw(file);
  assert.equal(db.pragma('user_version', { simple: true }), 6);
  assert.equal(tableExists(db, 'principals'), false);
  const now = h.legacySnapshot(db); now.kv = now.kv.filter((r) => r.key !== 'after_skip');
  assert.deepEqual(now, snap);
  db.close();
});

test('repeated failure: after 3 failed launches v7 holds itself, takes no more backups, keeps the old ones, and clears on success', () => {
  const { dir, file, snap } = h.v6Fixture();
  const { v7FailureMarkerPath, V7_FAILURE_LIMIT } = loadTs('src/main/db.ts');
  assert.equal(V7_FAILURE_LIMIT, 3);
  const marker = v7FailureMarkerPath(file);
  const boom = { hooks: { beforeCommit: () => { throw new Error('deterministic failure'); } } };
  let t = h.NOW;
  const launch = (extra = {}) => { t += 60_000; const at = t; return openStore(file, { now: () => at, ...extra }); };
  for (let i = 1; i <= 3; i++) {
    const { s, logs } = launch(boom);
    assert.equal(s.lastMigration.state, 'failed'); s.close();
    assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).count, i);
    assert.equal(fs.readdirSync(path.join(dir, 'backups')).length, i);
    if (i === 3) assert.ok(logs.some((l) => /failed 3 times in a row; it is held from the next launch \(held: repeated_failure\)/.test(l)), logs.join('\n'));
  }
  const backups = fs.readdirSync(path.join(dir, 'backups')).sort();
  // Fourth launch: held, no backup, even without the failing hook.
  const held = launch();
  assert.equal(held.s.schemaVersion, 6); assert.equal(held.s.lastMigration.reason, 'held');
  assert.equal(held.s.lastMigration.detail, 'repeated_failure count=3');
  assert.ok(held.logs.some((l) => /v7 migration: skipped reason=held: repeated_failure count=3; database stays at v6; no new backup taken/.test(l)), held.logs.join('\n'));
  const how = held.logs.find((l) => /to retry v7/.test(l));
  assert.ok(how && how.includes(path.basename(marker)) && /restore tool/.test(how) && !how.includes(dir), how);
  legacyStillUsable(held.s); held.s.close();
  assert.deepEqual(fs.readdirSync(path.join(dir, 'backups')).sort(), backups, 'no new backup and none deleted');
  // The user clears the marker: the next launch migrates, and success removes the marker.
  fs.rmSync(marker);
  const ok = launch();
  assert.equal(ok.s.schemaVersion, 7); assert.equal(ok.s.lastMigration.state, 'applied'); ok.s.close();
  assert.ok(!fs.existsSync(marker));
  assert.equal(fs.readdirSync(path.join(dir, 'backups')).length, 4);
  for (const b of backups) assert.ok(fs.existsSync(path.join(dir, 'backups', b)), `kept ${b}`);
  const db = h.openRaw(file);
  const now = h.legacySnapshot(db); now.kv = now.kv.filter((r) => r.key !== 'after_skip');
  assert.deepEqual(now, snap); db.close();
});

test('a single failure followed by success resets the failure count', () => {
  const { file } = h.v6Fixture();
  const { v7FailureMarkerPath } = loadTs('src/main/db.ts');
  openStore(file, { hooks: { beforeCommit: () => { throw new Error('once'); } } }).s.close();
  assert.equal(JSON.parse(fs.readFileSync(v7FailureMarkerPath(file), 'utf8')).count, 1);
  const { s } = openStore(file, { now: () => h.NOW + 60_000 }); assert.equal(s.schemaVersion, 7); s.close();
  assert.ok(!fs.existsSync(v7FailureMarkerPath(file)));
});

test('the backup hash is streamed in chunks and equals the whole-file sha256', () => {
  const { sha256File } = loadTs('src/main/nexus/db/backup.ts');
  const f = path.join(h.tmpDir(), 'big.bin');
  const buf = crypto.randomBytes(3 * 1024 * 1024 + 12345); fs.writeFileSync(f, buf);
  assert.equal(sha256File(f), crypto.createHash('sha256').update(buf).digest('hex'));
  const empty = path.join(h.tmpDir(), 'empty.bin'); fs.writeFileSync(empty, '');
  assert.equal(sha256File(empty), crypto.createHash('sha256').update('').digest('hex'));
});
