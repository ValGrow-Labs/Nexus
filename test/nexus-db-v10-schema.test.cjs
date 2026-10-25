'use strict';
// B2b Task 2: the schema v10 module (not wired). S10-1 names and counts, S10-2 every refusal, S10-3 the append-only pin,
// S10-4 the frozen V7_DDL, V8_DDL and V9_DDL texts. Everything runs on temp databases only.
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const C = require('./helpers/cleanup.cjs'); C.cleanupAfterAll();
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { PersistStore: PersistStoreUntracked } = loadTs('src/main/db.ts');
class PersistStore extends PersistStoreUntracked { constructor(...a) { super(...a); C.track(this); } }
const { applyV10, verifyV10, V10_DDL, V10_EXPECTED, v10ShapeProblem } = loadTs('src/main/nexus/db/schemaV10.ts');
const seed = loadTs('src/main/nexus/db/v10Seed.ts');
const { ddlObjects } = loadTs('src/main/nexus/db/schemaV7.ts');

const ctx = (over) => ({ now: () => h.NOW, appVersion: 't', fromVersion: 9, preCounts: null, backup: null, ...over });

// One exact v9 file is built once (the store's own v9 step) and copied for each test.
// holdV10 keeps it a v9 file once Task 3 wires v10 into the store (an unknown option is ignored before that).
let template = null;
function v9file() {
  if (!template) {
    const { file } = h.v6Fixture();
    const s = new PersistStore(file);
    s.open({ log: () => {}, backupDir: path.join(path.dirname(file), 'b'), now: () => h.NOW, enableV9: true, holdV10: true });
    s.close();
    template = file;
  }
  const dir = h.tmpDir('nx-v10-'); const file = path.join(dir, 'harness.db');
  fs.copyFileSync(template, file);
  return file;
}
const v9db = () => C.openRaw(v9file());
function v10db() { const db = v9db(); db.transaction(() => applyV10(db, ctx()))(); return db; }
const names = (db, type) => db.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%'").all(type).map((r) => r.name);
const V10_TABLES = Object.keys(V10_EXPECTED.tables);

// ---------- S10-1: names and counts ----------

test('S10-1a: six tables, seven indexes, eighteen triggers; the parser finds exactly V10_EXPECTED; the shape is clean', () => {
  const db = v9db();
  assert.equal(db.pragma('user_version', { simple: true }), 9, 'the fixture is a v9 file');
  assert.match(v10ShapeProblem(db, true), /missing/);
  assert.equal(v10ShapeProblem(db, false), null);
  db.transaction(() => applyV10(db, ctx()))();
  assert.deepEqual(V10_TABLES, ['capability_tokens', 'reviews', 'change_set_accepts', 'repo_merges', 'runtime_consents', 'session_worktrees']);
  // Revision 0's six indexes plus ix_accepts_job, in DDL order (each after its table).
  assert.deepEqual(V10_EXPECTED.indexes, ['ix_tokens_job', 'ix_reviews_version', 'ix_accepts_project', 'ix_accepts_job', 'ix_merges_project',
    'ux_consent_live', 'ix_worktrees_project']);
  assert.equal(V10_EXPECTED.triggers.length, 18);
  const objs = ddlObjects(V10_DDL);
  assert.deepEqual(objs.filter((o) => o.type === 'table').map((o) => o.name), V10_TABLES);
  assert.deepEqual(objs.filter((o) => o.type === 'index').map((o) => o.name), V10_EXPECTED.indexes);
  assert.deepEqual(objs.filter((o) => o.type === 'trigger').map((o) => o.name), V10_EXPECTED.triggers);
  for (const t of V10_TABLES) assert.ok(names(db, 'table').includes(t), t);
  for (const i of V10_EXPECTED.indexes) assert.ok(names(db, 'index').includes(i), i);
  for (const t of V10_EXPECTED.triggers) assert.ok(names(db, 'trigger').includes(t), t);
  for (const [t, cols] of Object.entries(V10_EXPECTED.tables)) {
    assert.deepEqual(db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name), cols, t);
  }
  assert.equal(v10ShapeProblem(db, true), null);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  // No v10 object sits on a v1-v9 table: every index and trigger is on a v10 table.
  for (const o of objs.filter((x) => x.type !== 'table')) assert.ok(V10_TABLES.includes(o.table), `${o.name} is on ${o.table}`);
});

test('S10-1b: the columns named by the brief, in order; no token text and no MAC column', () => {
  const t = V10_EXPECTED.tables;
  assert.deepEqual(t.capability_tokens, ['jti', 'job_id', 'session_id', 'principal_id', 'on_behalf_of', 'caps_json', 'inputs_json', 'tools_json',
    'caps_sha256', 'issued_at', 'expires_at', 'revoked_at', 'revoke_reason']);
  assert.deepEqual(t.reviews, ['id', 'version_id', 'principal_id', 'decision', 'comment', 'comment_sha256', 'intent_id', 'created_at']);
  assert.deepEqual(t.change_set_accepts, ['version_id', 'project_id', 'integration_ref', 'ref_before', 'ref_after', 'merge_commit',
    'accept_job_id', 'accepted_by', 'accepted_at']);
  assert.deepEqual(t.repo_merges, ['id', 'project_id', 'branch', 'before', 'after', 'sha_confirmed', 'merged_by', 'merged_at', 'confirmed_via',
    'ff_job_id']);
  assert.deepEqual(t.runtime_consents, ['id', 'runtime_kind', 'hosts_json', 'hosts_sha256', 'turn_usd_cents', 'day_usd_cents', 'turns_per_hour',
    'concurrent_turns', 'turn_tokens', 'tool_calls', 'granted_by', 'granted_at', 'revoked_at', 'revoked_by']);
  assert.deepEqual(t.session_worktrees, ['session_id', 'project_id', 'rel_path', 'ref', 'integration_ref', 'base_commit', 'locked', 'created_at',
    'removed_at', 'reused_from_session_id']);
  for (const c of t.capability_tokens) assert.doesNotMatch(c, /token|mac|bearer|secret|key|raw|sig/i, c);
  const tokenTable = ddlObjects(V10_DDL).find((o) => o.name === 'capability_tokens').sql;
  assert.doesNotMatch(tokenTable, /\bmac\b|\btoken_text\b|\bbearer\b|\bsecret\b/i);
});

test('S10-1c: the DDL is additive and frozen-style: CREATE ... IF NOT EXISTS only, no DROP, ALTER or OR REPLACE, no interpolation', () => {
  assert.doesNotMatch(V10_DDL, /\b(DROP|ALTER)\b/i);
  assert.doesNotMatch(V10_DDL, /OR\s+REPLACE/i);
  assert.doesNotMatch(V10_DDL, /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\b/i, 'v10 seeds no rows');
  assert.equal((V10_DDL.match(/\bCREATE\b/g) || []).length,
    (V10_DDL.match(/\bCREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER)\s+IF\s+NOT\s+EXISTS\b/g) || []).length);
  for (const o of ddlObjects(V10_DDL).filter((x) => x.type === 'trigger')) assert.match(o.sql, /END$/, o.name);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'nexus', 'db', 'schemaV10.ts'), 'utf8');
  const start = src.indexOf('export const V10_DDL: string = `');
  assert.ok(start >= 0, 'V10_DDL is declared as a plain template literal');
  const body = src.slice(src.indexOf('`', start) + 1, src.indexOf('`;', start));
  assert.equal(body.includes('${'), false, 'no interpolation in the shipped DDL text');
  assert.equal((V10_DDL.match(/NOT LIKE '%\\%'/g) || []).length, 1, 'the B2a path CHECK keeps its backslash pattern');
});

test('S10-1d: every table has a no-delete trigger, and every v10 table is guarded', () => {
  const objs = ddlObjects(V10_DDL);
  for (const t of V10_TABLES) {
    const del = objs.filter((o) => o.type === 'trigger' && o.table === t && /\bBEFORE DELETE ON\b/.test(o.sql));
    assert.equal(del.length, 1, `${t} has exactly one BEFORE DELETE trigger`);
    assert.match(del[0].sql, new RegExp(`BEFORE DELETE ON ${t} BEGIN SELECT RAISE\\(ABORT,'[^']+'\\); ?END$`), `${t}: the delete guard is unconditional`);
  }
});

test('S10-1e: applyV10 writes one migration record and one db.migrated row, keeps v7, v8 and v9 exact, and is a no-op on re-run', () => {
  const { v7ShapeProblem } = loadTs('src/main/nexus/db/schemaV7.ts');
  const { v8ShapeProblem } = loadTs('src/main/nexus/db/schemaV8.ts');
  const { v9ShapeProblem } = loadTs('src/main/nexus/db/schemaV9.ts');
  const db = v9db();
  const before = h.count(db, 'activity');
  const pre = { projects: h.count(db, 'projects'), activity: before, jobs: h.count(db, 'jobs'), lineage_relations: h.count(db, 'lineage_relations') };
  const out = db.transaction(() => applyV10(db, ctx({ preCounts: pre })))();
  assert.deepEqual(out, { tables: 6, recorded: true });
  const rec = db.prepare('SELECT * FROM nexus_migrations WHERE version = 10').get();
  assert.equal(rec.from_version, 9); assert.equal(rec.backfill_json, '{}'); assert.equal(rec.applied_at, h.NOW);
  assert.deepEqual(JSON.parse(rec.row_counts_json), pre);
  assert.equal(h.count(db, 'activity'), before + 1);
  const row = db.prepare('SELECT * FROM activity ORDER BY seq DESC LIMIT 1').get();
  assert.equal(row.action, 'db.migrated'); assert.equal(row.entity_id, '10'); assert.equal(row.actor_kind, 'system');
  assert.deepEqual(JSON.parse(row.details_json), { from: 9, to: 10, backupFile: null, backupSha256: null });
  assert.equal(v7ShapeProblem(db, true), null); assert.equal(v8ShapeProblem(db, true), null); assert.equal(v9ShapeProblem(db, true), null);
  for (const t of V10_TABLES) assert.equal(h.count(db, t), 0, `${t} starts empty`);
  const again = db.transaction(() => applyV10(db, ctx()))();
  assert.deepEqual(again, { tables: 6, recorded: false });
  assert.equal(h.count(db, 'activity'), before + 1);
  assert.equal(db.pragma('user_version', { simple: true }), 9, 'the module never sets user_version (the store does, in Task 3)');
});

test('S10-1f: applyV10 refuses a wrong pre-existing object and a non-exact v9 shape; verifyV10 rolls back on a pre-count mismatch', () => {
  const bad = v9db(); bad.exec('CREATE TABLE reviews (id TEXT PRIMARY KEY)');
  assert.throws(() => bad.transaction(() => applyV10(bad, ctx()))(), /v10 cannot be applied over an existing object: table reviews has columns/);
  const v9bad = v9db(); v9bad.exec('DROP TRIGGER tr_job_events_no_update');   // temp copy only
  assert.throws(() => v9bad.transaction(() => applyV10(v9bad, ctx()))(), /v10 needs an exact v9 shape/);
  const v8bad = v9db(); v8bad.exec('DROP TRIGGER tr_handoffs_no_delete');
  assert.throws(() => v8bad.transaction(() => applyV10(v8bad, ctx()))(), /v10 needs an exact v8 shape/);
  const db = v9db();
  assert.throws(() => db.transaction(() => applyV10(db, ctx({ preCounts: { projects: 999 } })))(), /v10 verification failed: projects has \d+ rows, expected 999/);
  for (const t of V10_TABLES) assert.equal(names(db, 'table').includes(t), false, `${t} rolled back`);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM nexus_migrations WHERE version = 10').get().n, 0);
  assert.throws(() => db.transaction(() => applyV10(db, ctx({ preCounts: { no_such_table: 1 } })))(), /table no_such_table is missing/);
  // verifyV10 on its own: a dropped v10 index is a failure.
  const v = v10db(); v.exec('DROP INDEX ix_accepts_job');
  assert.throws(() => verifyV10(v, ctx()), /v10 verification failed: index ix_accepts_job is missing/);
});

test('S10-1g: v10ShapeProblem reports a changed definition and a missing object', () => {
  const db = v10db();
  db.exec('DROP INDEX ix_worktrees_project; CREATE INDEX ix_worktrees_project ON session_worktrees(created_at)');
  assert.match(v10ShapeProblem(db, true), /index ix_worktrees_project has a different definition/);
  assert.match(v10ShapeProblem(db, false), /index ix_worktrees_project has a different definition/);
  db.exec('DROP INDEX ix_worktrees_project');
  assert.match(v10ShapeProblem(db, true), /index ix_worktrees_project is missing/);
  assert.equal(v10ShapeProblem(db, false), null);
});

test('S10-1h: v10Seed holds the D-B4 ceilings and the vocabularies, frozen, and the DDL CHECKs use exactly those values', () => {
  assert.deepEqual({ ...seed.V10_CONSENT_CEILINGS }, { turnUsdCents: 200, dayUsdCents: 1000, turnsPerHour: 6, concurrentTurns: 1,
    turnTokens: 400000, toolCalls: 200 });
  assert.deepEqual([...seed.V10_REVOKE_REASONS], ['job_ended', 'session_cancelled', 'restart', 'runner_restart', 'budget']);
  assert.deepEqual([...seed.V10_REVIEW_DECISIONS], ['approve', 'request_changes', 'reject']);
  assert.deepEqual({ ...seed.V10_TEXT_LIMITS }, { capsJson: 8192, inputsJson: 8192, toolsJson: 2048, hostsJson: 1024, reviewComment: 4000 });
  for (const x of [seed.V10_CONSENT_CEILINGS, seed.V10_REVOKE_REASONS, seed.V10_REVIEW_DECISIONS, seed.V10_TEXT_LIMITS]) assert.ok(Object.isFrozen(x));
  const c = seed.V10_CONSENT_CEILINGS;
  for (const [col, max] of [['turn_usd_cents', c.turnUsdCents], ['day_usd_cents', c.dayUsdCents], ['turns_per_hour', c.turnsPerHour],
    ['turn_tokens', c.turnTokens], ['tool_calls', c.toolCalls]]) {
    assert.match(V10_DDL, new RegExp(`${col}\\s+INTEGER NOT NULL CHECK \\(${col} BETWEEN 1 AND ${max}\\)`), col);
  }
  assert.match(V10_DDL, new RegExp(`concurrent_turns\\s+INTEGER NOT NULL CHECK \\(concurrent_turns = ${c.concurrentTurns}\\)`));
  assert.match(V10_DDL, new RegExp(`revoke_reason IN \\(${seed.V10_REVOKE_REASONS.map((r) => `'${r}'`).join(',')}\\)`));
  assert.match(V10_DDL, new RegExp(`decision IN \\(${seed.V10_REVIEW_DECISIONS.map((r) => `'${r}'`).join(',')}\\)`));
});

test('S10-1i: the v10 module names no engine or vendor (the vendor-neutral rule, checked here until the scan lists it)', () => {
  const VENDOR = /claude|anthropic|hermes|sonnet|opus|haiku|openai|gpt-/i;
  for (const f of ['schemaV10.ts', 'v10Seed.ts']) {
    const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'nexus', 'db', f), 'utf8');
    const hits = text.split(/\r?\n/).map((l, i) => [i + 1, l]).filter(([, l]) => VENDOR.test(l));
    assert.deepEqual(hits, [], f);
  }
});

// ---------- a v10 world on raw rows ----------

const T0 = h.NOW;
const SID = '01JABCDEFGHJKMNPQRSTVWXYZ0';   // a 26-character ULID-shaped session id
const SID2 = '01JABCDEFGHJKMNPQRSTVWXYZ1';
const SID3 = '01JABCDEFGHJKMNPQRSTVWXYZ2';
const AGENT = `agent:${SID}`;
const HEX64 = (c) => c.repeat(64);
const SHA1 = (c) => c.repeat(40);
const JTI = 'AbCdEfGhIjKlMnOpQr_-01';     // 22 base64url characters
function insert(db, table, row) {
  const cols = Object.keys(row);
  return db.prepare(`INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]));
}
const upd = (db, table, sql, where, ...args) => db.prepare(`UPDATE ${table} SET ${sql} WHERE ${where}`).run(...args);
function insSession(db, w, id, project = 'p-ledger') {
  insert(db, 'agent_sessions', { id, project_id: project, workspace_id: project === 'p-ledger' ? 'sde' : 'dl',
    participation_id: project === 'p-ledger' ? w.p1 : w.other, principal_id: 'user:local', idempotency_key: `k-${id}`,
    created_at: T0, updated_at: T0, status_changed_at: T0 });
  insert(db, 'principals', { id: `agent:${id}`, kind: 'agent', display_name: 'the agent', created_at: T0 });
}
function insJob(db, w, id, over = {}) {
  insert(db, 'jobs', { id, kind: 'tool.run', project_id: 'p-ledger', workspace_id: 'sde', participation_id: w.p1, idempotency_key: `k-${id}`,
    requested_by: 'user:local', on_behalf_of: 'user:local', created_at: T0, updated_at: T0, state_changed_at: T0, ...over });
  return id;
}
function insVersion(db, id, artifactId, no, participationId, over = {}) {
  insert(db, 'artifact_versions', { id, artifact_id: artifactId, version_no: no, project_id: 'p-ledger', participation_id: participationId,
    status: 'draft', storage_kind: 'git', storage_ref_json: '{}', content_hash: `git:${id}`, actor_id: 'user:local',
    on_behalf_of: 'user:local', created_at: T0, status_changed_at: T0, ...over });
  return id;
}
const toStatus = (db, id, ...states) => { for (const s of states) upd(db, 'artifact_versions', 'status = ?', 'id = ?', s, id); };
function world() {
  const db = v10db();
  const p1 = db.prepare("SELECT id FROM project_workspaces WHERE project_id = 'p-ledger' AND workspace_id = 'sde'").get().id;
  const other = db.prepare("SELECT id FROM project_workspaces WHERE project_id = 'p-invoice' AND workspace_id = 'dl'").get().id;
  const w = { p1, other };
  insert(db, 'principals', { id: 'user:two', kind: 'user', display_name: 'Second user', created_at: T0 });
  insSession(db, w, SID); insSession(db, w, SID2); insSession(db, w, SID3);
  insSession(db, w, 'SESSINVOICE000000000000000', 'p-invoice');
  insJob(db, w, 'j-turn', { kind: 'agent.run', session_id: SID });
  insJob(db, w, 'j-turn2', { kind: 'agent.run', session_id: SID2 });
  insJob(db, w, 'j-tool');
  insJob(db, w, 'j-accept', { recipe_id: 'changeset.accept' });
  insJob(db, w, 'j-ff', { recipe_id: 'repo.ff' });
  insJob(db, w, 'j-invoice', { project_id: 'p-invoice', workspace_id: 'dl', participation_id: other });
  const art = (id, kind, owner, ws, project = 'p-ledger') => insert(db, 'artifacts', { id, project_id: project, kind, name: id,
    owner_participation_id: owner, owner_workspace_id: ws, created_by: 'user:local', created_at: T0, updated_at: T0 });
  art('a-cs', 'change_set', p1, 'sde');
  insVersion(db, 'v-cs-draft', 'a-cs', 1, p1);
  insVersion(db, 'v-cs-cand', 'a-cs', 2, p1); toStatus(db, 'v-cs-cand', 'candidate');
  insVersion(db, 'v-cs-active', 'a-cs', 3, p1); toStatus(db, 'v-cs-active', 'candidate', 'active');
  insVersion(db, 'v-cs-active2', 'a-cs', 4, p1); toStatus(db, 'v-cs-active2', 'candidate', 'active');
  art('a-app', 'application', p1, 'sde');
  insVersion(db, 'v-app-cand', 'a-app', 1, p1); toStatus(db, 'v-app-cand', 'candidate');
  insVersion(db, 'v-app-active', 'a-app', 2, p1); toStatus(db, 'v-app-active', 'candidate', 'active');
  art('a-cs-inv', 'change_set', other, 'dl', 'p-invoice');
  insVersion(db, 'v-cs-inv', 'a-cs-inv', 1, other, { project_id: 'p-invoice' }); toStatus(db, 'v-cs-inv', 'candidate', 'active');
  return { db, ...w };
}
const insToken = (db, over = {}) => insert(db, 'capability_tokens', { jti: JTI, job_id: 'j-turn', session_id: SID, principal_id: AGENT,
  on_behalf_of: 'user:local', caps_json: '{"turnTokens":400000}', inputs_json: '[]', tools_json: '["context_get"]', caps_sha256: HEX64('a'),
  issued_at: T0, expires_at: T0 + 1_800_000, ...over });
let n = 0;
const insReview = (db, over = {}) => insert(db, 'reviews', { id: `r-${++n}`, version_id: 'v-cs-cand', principal_id: 'user:local',
  decision: 'approve', intent_id: `intent-${n}`, created_at: T0, ...over });
const insAccept = (db, over = {}) => insert(db, 'change_set_accepts', { version_id: 'v-cs-active', project_id: 'p-ledger',
  integration_ref: 'refs/nexus/accepted/main', ref_before: SHA1('1'), ref_after: SHA1('2'), merge_commit: SHA1('2'), accept_job_id: 'j-accept',
  accepted_by: 'user:local', accepted_at: T0, ...over });
const insMerge = (db, over = {}) => insert(db, 'repo_merges', { id: `m-${++n}`, project_id: 'p-ledger', branch: 'main', before: SHA1('1'),
  after: SHA1('2'), sha_confirmed: SHA1('2'), merged_by: 'user:local', merged_at: T0, confirmed_via: 'dialog', ff_job_id: 'j-ff', ...over });
const insConsent = (db, over = {}) => insert(db, 'runtime_consents', { id: `c-${++n}`, runtime_kind: 'cli-agent',
  hosts_json: '["api.example.invalid:443"]', hosts_sha256: HEX64('b'), turn_usd_cents: 200, day_usd_cents: 1000, turns_per_hour: 6,
  concurrent_turns: 1, turn_tokens: 400000, tool_calls: 200, granted_by: 'user:local', granted_at: T0, ...over });
const insWorktree = (db, over = {}) => insert(db, 'session_worktrees', { session_id: SID, project_id: 'p-ledger', rel_path: `wt/${SID.toLowerCase()}`,
  ref: `refs/nexus/job/${SID.toLowerCase()}`, integration_ref: 'refs/nexus/accepted/main', base_commit: SHA1('3'), locked: 1, created_at: T0, ...over });
const CHECK = /CHECK constraint failed/;
const NOT_NULL = /NOT NULL constraint failed/;
/** Each case is [label, row override] or [label, row override, expected error] (CHECK when not given). */
const refuses = (ins, cases) => { for (const [label, over, re] of cases) assert.throws(() => ins(over), re ?? CHECK, label); };

// ---------- S10-2: every refusal ----------

test('S10-2a capability_tokens: the principal is agent:<session> of kind agent, for an agent turn job of that session; claims are bounded', () => {
  const { db, ...w } = world();
  const who = /the token principal is the agent of its session/;
  assert.throws(() => insToken(db, { principal_id: `agent:${SID2}` }), who, 'another agent');
  assert.throws(() => insToken(db, { principal_id: 'user:local' }), who, 'a user');
  insert(db, 'principals', { id: `agent:${'X'.repeat(26)}`, kind: 'user', display_name: 'not an agent', created_at: T0 });
  insert(db, 'agent_sessions', { id: 'X'.repeat(26), project_id: 'p-ledger', workspace_id: 'sde', participation_id: w.p1, principal_id: 'user:local',
    idempotency_key: 'k-x', created_at: T0, updated_at: T0, status_changed_at: T0 });
  insJob(db, w, 'j-x', { kind: 'agent.run', session_id: 'X'.repeat(26) });
  assert.throws(() => insToken(db, { session_id: 'X'.repeat(26), principal_id: `agent:${'X'.repeat(26)}`, job_id: 'j-x' }), who, 'a principal of kind user');
  const job = /a token is minted for an agent turn job of its session/;
  assert.throws(() => insToken(db, { job_id: 'j-turn2' }), job, 'a job of another session');
  assert.throws(() => insToken(db, { job_id: 'j-tool' }), job, 'a tool job');
  assert.throws(() => insToken(db, { on_behalf_of: AGENT }), /a token acts on behalf of a user/);
  assert.throws(() => insToken(db, { on_behalf_of: 'system' }), /a token acts on behalf of a user/);
  assert.throws(() => insToken(db, { revoked_at: T0, revoke_reason: 'restart' }), /a token is minted live/);
  assert.throws(() => insToken(db, { job_id: 'no-such-job' }), /a token is minted for an agent turn job of its session|FOREIGN KEY/);
  // CHECKs
  for (const [label, over] of [
    ['jti too short', { jti: 'abc' }], ['jti with a dot (a raw token)', { jti: 'AbCdEfGhIjKlMnOpQr.-01' }], ['jti with +', { jti: 'AbCdEfGhIjKlMnOpQr+/01' }],
    ['caps not an object', { caps_json: '[]' }], ['caps not json', { caps_json: 'x' }], ['caps over 8 KiB', { caps_json: `{"a":"${'x'.repeat(8190)}"}` }],
    ['inputs not an array', { inputs_json: '{}' }], ['inputs over 8 KiB', { inputs_json: `["${'x'.repeat(8190)}"]` }],
    ['tools not an array', { tools_json: '{}' }], ['tools over 2 KiB', { tools_json: `["${'x'.repeat(2046)}"]` }],
    ['caps sha not hex', { caps_sha256: 'Z'.repeat(64) }], ['caps sha short', { caps_sha256: 'a'.repeat(63) }],
    ['expiry not after issue', { expires_at: T0 }], ['a reason without a time', { revoke_reason: 'restart' }]
  ]) assert.throws(() => insToken(db, over), CHECK, label);
  insToken(db, { caps_json: `{"a":"${'x'.repeat(8184)}"}` });   // exactly 8192 bytes is allowed
  assert.equal(db.prepare('SELECT length(caps_json) n FROM capability_tokens').get().n, 8192);
});

// Wave-1 review, finding 2: the shared claims-to-row mapping (tokens.ts claimsRowParts) is a row v10 accepts as is.
test('S10-2a2 capability_tokens: the row claimsRowParts builds from real claims inserts, and reads back to the same claims', () => {
  const { db } = world();
  const { claimsRowParts } = loadTs('src/shared/nexus/tokens.ts');
  const { DOMAINS } = loadTs('src/shared/nexus/domains/index.ts');
  const caps = DOMAINS.find((d) => d.id === 'sde').capabilities.map((c) => JSON.parse(JSON.stringify(c)));
  const claims = { jti: 'ZyXwVuTsRqPoNmLkJi_-99', sub: AGENT, onBehalfOf: 'user:local', projectId: 'p-ledger', workspaceId: 'sde',
    participationId: 'pw', jobId: 'j-turn', sessionId: SID, caps, inputs: ['v-cs-cand'], mcpTools: ['context_get', 'sandbox_exec'],
    maxChildJobs: 20, iat: T0, exp: T0 + 1_800_000 };
  insert(db, 'capability_tokens', { ...claimsRowParts(claims) });
  const r = db.prepare('SELECT * FROM capability_tokens WHERE jti = ?').get(claims.jti);
  const grant = JSON.parse(r.caps_json);
  assert.deepEqual([grant.caps, grant.maxChildJobs, JSON.parse(r.inputs_json), JSON.parse(r.tools_json), r.issued_at, r.expires_at],
    [caps, 20, ['v-cs-cand'], ['context_get', 'sandbox_exec'], T0, T0 + 1_800_000]);
  assert.equal(r.caps_sha256, crypto.createHash('sha256').update(r.caps_json).digest('hex'));
  // The array alone (the claims' `caps` field) is never the column: v10 refuses it.
  assert.throws(() => insert(db, 'capability_tokens', { ...claimsRowParts({ ...claims, jti: 'ZyXwVuTsRqPoNmLkJi_-98' }), caps_json: JSON.stringify(caps) }), CHECK);
});

test('S10-2b capability_tokens: identity and claims are immutable; revocation is set once with a known reason', () => {
  const { db } = world();
  insToken(db);
  const frozen = /token identity and claims are immutable/;
  for (const [col, val] of [['jti', 'ZZCdEfGhIjKlMnOpQr_-01'], ['job_id', 'j-turn2'], ['session_id', SID2], ['principal_id', `agent:${SID2}`],
    ['on_behalf_of', 'user:two'], ['caps_json', '{}'], ['inputs_json', '["v"]'], ['tools_json', '[]'], ['caps_sha256', HEX64('c')],
    ['issued_at', T0 + 1], ['expires_at', T0 + 5]]) {
    assert.throws(() => upd(db, 'capability_tokens', `"${col}" = ?`, 'jti = ?', val, JTI), frozen, col);
  }
  assert.throws(() => upd(db, 'capability_tokens', "revoked_at = ?, revoke_reason = 'expired'", 'jti = ?', T0 + 1, JTI), CHECK, 'unknown reason');
  assert.throws(() => upd(db, 'capability_tokens', 'revoked_at = ?', 'jti = ?', T0 + 1, JTI), CHECK, 'a time without a reason');
  assert.throws(() => upd(db, 'capability_tokens', "revoked_at = ?, revoke_reason = 'restart'", 'jti = ?', T0 - 1, JTI), CHECK, 'revoked before issue');
  upd(db, 'capability_tokens', "revoked_at = ?, revoke_reason = 'runner_restart'", 'jti = ?', T0 + 1, JTI);
  const once = /a token revocation is recorded once/;
  assert.throws(() => upd(db, 'capability_tokens', "revoke_reason = 'budget'", 'jti = ?', JTI), once);
  assert.throws(() => upd(db, 'capability_tokens', 'revoked_at = ?', 'jti = ?', T0 + 2, JTI), once);
  assert.throws(() => upd(db, 'capability_tokens', 'revoked_at = NULL, revoke_reason = NULL', 'jti = ?', JTI), once);
  for (const r of seed.V10_REVOKE_REASONS) {
    const jti = `${r.padEnd(14, 'x').slice(0, 14)}AAAAAAAA`.replace(/[^A-Za-z0-9_-]/g, 'x');
    insToken(db, { jti }); upd(db, 'capability_tokens', 'revoked_at = ?, revoke_reason = ?', 'jti = ?', T0 + 1, r, jti);
  }
  assert.throws(() => db.prepare('DELETE FROM capability_tokens WHERE jti = ?').run(JTI), /capability tokens are never deleted/);
});

test('S10-2c reviews: by a user, on a change-set candidate, a comment for request_changes and reject, one per intent, append-only', () => {
  const { db } = world();
  assert.throws(() => insReview(db, { principal_id: AGENT }), /a review is decided by a user/);
  assert.throws(() => insReview(db, { principal_id: 'system' }), /a review is decided by a user/);
  const subject = /a review decides a change-set candidate/;
  assert.throws(() => insReview(db, { version_id: 'v-cs-draft' }), subject, 'a draft');
  assert.throws(() => insReview(db, { version_id: 'v-cs-active' }), subject, 'already active');
  assert.throws(() => insReview(db, { version_id: 'v-app-cand' }), subject, 'not a change set');
  assert.throws(() => insReview(db, { decision: 'merge' }), CHECK);
  assert.throws(() => insReview(db, { decision: 'request_changes' }), CHECK, 'request_changes needs a comment');
  assert.throws(() => insReview(db, { decision: 'reject' }), CHECK, 'reject needs a comment');
  assert.throws(() => insReview(db, { decision: 'reject', comment: 'No.' }), CHECK, 'a comment needs its sha256');
  assert.throws(() => insReview(db, { comment_sha256: HEX64('d') }), CHECK, 'a sha256 without a comment');
  assert.throws(() => insReview(db, { decision: 'reject', comment: '', comment_sha256: HEX64('d') }), CHECK, 'an empty comment');
  assert.throws(() => insReview(db, { decision: 'reject', comment: 'x'.repeat(4001), comment_sha256: HEX64('d') }), CHECK, 'over 4000');
  insReview(db, { decision: 'reject', comment: 'x'.repeat(4000), comment_sha256: HEX64('d') });
  insReview(db, { decision: 'request_changes', comment: 'Add a test.', comment_sha256: HEX64('e'), intent_id: 'intent-same' });
  assert.throws(() => insReview(db, { intent_id: 'intent-same' }), /UNIQUE constraint failed: reviews\.intent_id/);
  const id = insReview(db, { id: 'r-ok' }) && 'r-ok';
  assert.throws(() => upd(db, 'reviews', "decision = 'reject'", 'id = ?', id), /reviews are append-only/);
  assert.throws(() => db.prepare('DELETE FROM reviews WHERE id = ?').run(id), /reviews are append-only/);
  assert.throws(() => insReview(db, { version_id: 'no-such' }), /a review decides a change-set candidate|FOREIGN KEY/);
});

test('S10-2d change_set_accepts: an active change set of this project, accepted by a user through a job of this project, under refs/nexus/accepted/*', () => {
  const { db } = world();
  const ver = /an accepted change set version is active/;
  assert.throws(() => insAccept(db, { version_id: 'v-cs-cand' }), ver, 'a candidate (promote first, then insert)');
  assert.throws(() => insAccept(db, { version_id: 'v-cs-draft' }), ver, 'a draft');
  assert.throws(() => insAccept(db, { version_id: 'v-app-active' }), /an accept records a change set of its project/, 'not a change set');
  assert.throws(() => insAccept(db, { version_id: 'v-cs-inv' }), /an accept records a change set of its project/, 'another project');
  assert.throws(() => insAccept(db, { accept_job_id: 'j-invoice' }), /the accept job belongs to the project/);
  assert.throws(() => insAccept(db, { accepted_by: 'system' }), /a change set is accepted by a user/);
  assert.throws(() => insAccept(db, { accepted_by: AGENT }), /a change set is accepted by a user/);
  assert.throws(() => insAccept(db, { accept_job_id: 'no-such-job' }), /FOREIGN KEY|the accept job belongs to the project/);
  refuses((over) => insAccept(db, over), [
    ['refs/heads/* integration ref', { integration_ref: 'refs/heads/main' }],
    ['a bare branch', { integration_ref: 'main' }],
    ['the bare prefix', { integration_ref: 'refs/nexus/accepted/' }],
    ['a job ref', { integration_ref: 'refs/nexus/job/abc' }],
    ['dot-dot', { integration_ref: 'refs/nexus/accepted/../heads/main' }],
    ['a space', { integration_ref: 'refs/nexus/accepted/my branch' }],
    ['a colon', { integration_ref: 'refs/nexus/accepted/a:b' }],
    ['a backslash', { integration_ref: 'refs/nexus/accepted/a\\b' }],
    ['a trailing slash', { integration_ref: 'refs/nexus/accepted/main/' }],
    ['.lock', { integration_ref: 'refs/nexus/accepted/main.lock' }],
    ['@{', { integration_ref: 'refs/nexus/accepted/a@{1}' }],
    ['a glob star', { integration_ref: 'refs/nexus/accepted/*' }],
    ['a control char', { integration_ref: 'refs/nexus/accepted/a\tb' }],
    ['ref_before short', { ref_before: SHA1('1').slice(1) }], ['ref_after upper-case', { ref_after: 'A'.repeat(40) }],
    ['merge_commit sha256-length', { merge_commit: HEX64('2') }], ['merge_commit missing', { merge_commit: null }, NOT_NULL]
  ]);
  insAccept(db, { integration_ref: 'refs/nexus/accepted/feature/login-v2' });
  assert.throws(() => insAccept(db), /UNIQUE constraint failed: change_set_accepts\.version_id/);
  assert.throws(() => upd(db, 'change_set_accepts', 'ref_after = ?', "version_id = 'v-cs-active'", SHA1('9')), /change set accepts are immutable/);
  assert.throws(() => db.prepare("DELETE FROM change_set_accepts WHERE version_id = 'v-cs-active'").run(), /change set accepts are immutable/);
  insAccept(db, { version_id: 'v-cs-active2' });
});

test('S10-2e repo_merges: dialog-confirmed by a user, to the confirmed 40-hex sha, through a job of this project; append-only', () => {
  const { db } = world();
  assert.throws(() => insMerge(db, { merged_by: 'system' }), /a merge is confirmed by a user/);
  assert.throws(() => insMerge(db, { merged_by: AGENT }), /a merge is confirmed by a user/);
  assert.throws(() => insMerge(db, { ff_job_id: 'j-invoice' }), /the fast-forward job belongs to the project/);
  refuses((over) => insMerge(db, over), [
    ['not a dialog', { confirmed_via: 'auto' }], ['no confirmation', { confirmed_via: null }, NOT_NULL],
    ['sha_confirmed short', { sha_confirmed: SHA1('2').slice(1) }], ['sha_confirmed missing', { sha_confirmed: null }, NOT_NULL],
    ['after is not the confirmed sha', { after: SHA1('4') }], ['before not hex', { before: 'g'.repeat(40) }],
    ['no job', { ff_job_id: null }, NOT_NULL], ['empty branch', { branch: '' }], ['a hidden ref as the branch', { branch: 'refs/nexus/accepted/main' }],
    ['dot-dot branch', { branch: 'a..b' }], ['an option-like branch', { branch: '-f' }], ['a space in the branch', { branch: 'a b' }]
  ]);
  insMerge(db, { id: 'm-ok', branch: 'feature/login' });
  assert.throws(() => upd(db, 'repo_merges', 'after = before', "id = 'm-ok'"), /repo merges are append-only/);
  assert.throws(() => db.prepare("DELETE FROM repo_merges WHERE id = 'm-ok'").run(), /repo merges are append-only/);
});

test('S10-2f runtime_consents: every D-B4 ceiling is a CHECK (a grant can only lower it), one live consent, revocation once', () => {
  const { db } = world();
  const c = seed.V10_CONSENT_CEILINGS;
  for (const [col, over] of [['turn_usd_cents', c.turnUsdCents + 1], ['day_usd_cents', c.dayUsdCents + 1], ['turns_per_hour', c.turnsPerHour + 1],
    ['concurrent_turns', 2], ['turn_tokens', c.turnTokens + 1], ['tool_calls', c.toolCalls + 1]]) {
    assert.throws(() => insConsent(db, { [col]: over }), CHECK, `${col} above its ceiling`);
    assert.throws(() => insConsent(db, { [col]: 0 }), CHECK, `${col} at zero`);
  }
  assert.throws(() => insConsent(db, { turn_usd_cents: 150, day_usd_cents: 100 }), CHECK, 'a turn cap above the day cap');
  for (const [label, over] of [
    ['hosts not an array', { hosts_json: '{}' }], ['no host', { hosts_json: '[]' }], ['hosts over 1 KiB', { hosts_json: `["${'h'.repeat(1022)}"]` }],
    ['hosts sha not hex', { hosts_sha256: 'x'.repeat(64) }], ['empty runtime kind', { runtime_kind: '' }]
  ]) assert.throws(() => insConsent(db, over), CHECK, label);
  assert.throws(() => insConsent(db, { revoked_at: T0 + 1 }), /a consent is granted live/, 'revoked at insert, even without who');
  assert.throws(() => insConsent(db, { granted_by: 'system' }), /a consent is granted by a user/);
  assert.throws(() => insConsent(db, { granted_by: AGENT }), /a consent is granted by a user/);
  assert.throws(() => insConsent(db, { revoked_at: T0 + 1, revoked_by: 'user:local' }), /a consent is granted live/);
  // A grant below every ceiling is fine; only one consent is live at a time, whatever its runtime.
  insConsent(db, { id: 'c-live', turn_usd_cents: 50, day_usd_cents: 300, turns_per_hour: 2, turn_tokens: 100000, tool_calls: 50 });
  assert.throws(() => insConsent(db), /UNIQUE constraint failed: index 'ux_consent_live'|UNIQUE constraint failed/);
  assert.throws(() => insConsent(db, { runtime_kind: 'other-runtime' }), /UNIQUE constraint failed/);
  const frozen = /a consent grant is immutable; its revocation is recorded once/;
  for (const [col, val] of [['turn_usd_cents', 10], ['day_usd_cents', 10], ['hosts_json', '["x:443"]'], ['hosts_sha256', HEX64('c')],
    ['runtime_kind', 'x'], ['granted_by', 'user:two'], ['granted_at', T0 + 1], ['id', 'c-new']]) {
    assert.throws(() => upd(db, 'runtime_consents', `${col} = ?`, "id = 'c-live'", val), frozen, col);
  }
  assert.throws(() => upd(db, 'runtime_consents', "revoked_at = ?, revoked_by = 'agent:" + SID + "'", "id = 'c-live'", T0 + 1),
    /a consent is revoked by a user or the system/);
  assert.throws(() => upd(db, 'runtime_consents', "revoked_at = ?, revoked_by = 'user:local'", "id = 'c-live'", T0 - 1), CHECK, 'revoked before granted');
  assert.throws(() => upd(db, 'runtime_consents', 'revoked_at = ?', "id = 'c-live'", T0 + 1), CHECK, 'revoked without who');
  assert.throws(() => upd(db, 'runtime_consents', "revoked_by = 'user:local'", "id = 'c-live'"), CHECK, 'who without when');
  upd(db, 'runtime_consents', "revoked_at = ?, revoked_by = 'user:local'", "id = 'c-live'", T0 + 1);
  assert.throws(() => upd(db, 'runtime_consents', 'revoked_at = ?', "id = 'c-live'", T0 + 2), frozen);
  assert.throws(() => upd(db, 'runtime_consents', 'revoked_at = NULL, revoked_by = NULL', "id = 'c-live'"), frozen);
  insConsent(db, { id: 'c-next' });                          // after revocation a new grant may be live
  assert.throws(() => db.prepare("DELETE FROM runtime_consents WHERE id = 'c-live'").run(), /consents are never deleted/);
});

test('S10-2g session_worktrees: wt/<session> and refs/nexus/job/<session>, under the B2a path CHECK; one per session; reuse only after interrupted', () => {
  const { db } = world();
  const lower = SID.toLowerCase();
  assert.throws(() => insWorktree(db, { project_id: 'p-invoice' }), /a worktree belongs to the project of its session/);
  assert.throws(() => insWorktree(db, { rel_path: `wt/${SID2.toLowerCase()}` }), /a new worktree is named after its session/);
  assert.throws(() => insWorktree(db, { rel_path: `wt/${SID}` }), /a new worktree is named after its session/, 'not lowercased');
  assert.throws(() => insWorktree(db, { ref: `refs/nexus/job/${SID2.toLowerCase()}` }), /a new worktree is named after its session/);
  assert.throws(() => insWorktree(db, { removed_at: T0 }), /a worktree is recorded live/);
  refuses((over) => insWorktree(db, over), [
    ['a refs/heads integration ref', { integration_ref: 'refs/heads/main' }],
    ['a job ref as the integration ref', { integration_ref: `refs/nexus/job/${lower}` }],
    ['base not 40 hex', { base_commit: 'abc' }], ['locked 2', { locked: 2 }], ['no base', { base_commit: null }, NOT_NULL]
  ]);
  // The path and ref CHECKs hold on their own too: on a temp copy without the insert trigger (which checks the name first).
  const raw = v10db(); raw.exec('DROP TRIGGER tr_worktrees_insert');
  insSession(raw, { p1: raw.prepare("SELECT id FROM project_workspaces WHERE project_id = 'p-ledger' AND workspace_id = 'sde'").get().id }, SID);
  refuses((over) => insWorktree(raw, over), [
    ['outside wt/', { rel_path: `jobs/${lower}` }], ['absolute', { rel_path: `/wt/${lower}` }], ['drive', { rel_path: `wt/C:${lower}` }],
    ['dot-dot', { rel_path: 'wt/../x' }], ['backslash', { rel_path: `wt/a\\${lower}` }], ['bare wt/', { rel_path: 'wt/' }],
    ['too long', { rel_path: `wt/${'a'.repeat(200)}` }],
    ['a refs/heads ref', { ref: 'refs/heads/main' }], ['an accepted ref as the job ref', { ref: 'refs/nexus/accepted/main' }],
    ['dot-dot ref', { ref: 'refs/nexus/job/../../heads/x' }], ['bare job prefix', { ref: 'refs/nexus/job/' }]
  ]);
  insWorktree(raw);
  insWorktree(db);
  assert.throws(() => insWorktree(db), /UNIQUE constraint failed: session_worktrees\.session_id/, 'one worktree per session');
  // Reuse: SID2 may take over SID's worktree only once SID is interrupted.
  const reuse = (sid, from, over = {}) => insWorktree(db, { session_id: sid, rel_path: `wt/${lower}`, ref: `refs/nexus/job/${sid.toLowerCase()}`,
    reused_from_session_id: from, ...over });
  const re = /a worktree is reused only from a live worktree of an interrupted session in this project, at the same path/;
  assert.throws(() => reuse(SID2, SID), re, 'SID is still open');
  for (const s of ['running', 'interrupted']) upd(db, 'agent_sessions', 'status = ?', 'id = ?', s, SID);
  assert.throws(() => reuse(SID2, SID, { rel_path: `wt/${SID2.toLowerCase()}` }), re, 'another path');
  assert.throws(() => reuse(SID2, 'no-such-session'), /FOREIGN KEY|a worktree is reused only/);
  reuse(SID2, SID);
  for (const s of ['running', 'interrupted']) upd(db, 'agent_sessions', 'status = ?', 'id = ?', s, SID2);
  assert.throws(() => reuse(SID3, SID), /UNIQUE constraint failed: session_worktrees\.reused_from_session_id/, 'a worktree is taken over once');
  reuse(SID3, SID2);                                            // a chain of takeovers keeps the same path
  assert.deepEqual(db.prepare('SELECT rel_path FROM session_worktrees ORDER BY created_at, session_id').all().map((r) => r.rel_path),
    [`wt/${lower}`, `wt/${lower}`, `wt/${lower}`]);
  // Updates: identity is immutable; locked may change while live; removal is recorded once and freezes the row.
  const frozen = /worktree identity is immutable and a removed worktree is frozen/;
  for (const [col, val] of [['project_id', 'p-invoice'], ['rel_path', 'wt/x'], ['ref', 'refs/nexus/job/x'], ['integration_ref', 'refs/nexus/accepted/x'],
    ['base_commit', SHA1('9')], ['created_at', T0 + 1], ['reused_from_session_id', SID3], ['session_id', 'S'.repeat(26)]]) {
    assert.throws(() => upd(db, 'session_worktrees', `${col} = ?`, 'session_id = ?', val, SID3), frozen, col);
  }
  upd(db, 'session_worktrees', 'locked = 0', 'session_id = ?', SID3);
  upd(db, 'session_worktrees', 'locked = 1', 'session_id = ?', SID3);
  assert.throws(() => upd(db, 'session_worktrees', 'removed_at = ?', 'session_id = ?', T0 - 1, SID3), CHECK, 'removed before created');
  upd(db, 'session_worktrees', 'locked = 0, removed_at = ?', 'session_id = ?', T0 + 5, SID3);
  assert.throws(() => upd(db, 'session_worktrees', 'locked = 1', 'session_id = ?', SID3), frozen);
  assert.throws(() => upd(db, 'session_worktrees', 'removed_at = NULL', 'session_id = ?', SID3), frozen);
  assert.throws(() => db.prepare('DELETE FROM session_worktrees WHERE session_id = ?').run(SID), /worktrees are never deleted/);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

// Wave-1 review, finding 3: the shared helpers (changeSet.ts jobRefFor and worktreeRelPathFor) name exactly what
// tr_worktrees_insert accepts for an uppercase ULID session id; the uppercase pair is refused.
test('S10-2g2 session_worktrees: jobRefFor and worktreeRelPathFor give the lowercased pair the trigger accepts', () => {
  const { db } = world();
  const cs = loadTs('src/shared/nexus/changeSet.ts');
  assert.match(SID, /[A-Z]/, 'the fixture id is uppercase, like a real ULID');
  assert.throws(() => insWorktree(db, { rel_path: `wt/${SID}`, ref: `refs/nexus/job/${SID}` }), /a new worktree is named after its session/);
  insWorktree(db, { rel_path: cs.worktreeRelPathFor(SID), ref: cs.jobRefFor(SID) });
  assert.deepEqual(db.prepare('SELECT rel_path, ref FROM session_worktrees WHERE session_id = ?').get(SID),
    { rel_path: cs.worktreeRelPathFor(SID), ref: cs.jobRefFor(SID) });
});

test('S10-2h: no v10 write touches a v1-v9 row, and every refusal leaves the tables empty', () => {
  const { db } = world();
  const snapshot = () => ['jobs', 'agent_sessions', 'artifact_versions', 'principals', 'activity'].map((t) => db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all());
  const before = snapshot();
  for (const f of [() => insToken(db, { job_id: 'j-tool' }), () => insReview(db, { version_id: 'v-cs-draft' }), () => insAccept(db, { version_id: 'v-cs-cand' }),
    () => insMerge(db, { merged_by: 'system' }), () => insConsent(db, { tool_calls: 201 }), () => insWorktree(db, { project_id: 'p-invoice' })]) assert.throws(f);
  for (const t of V10_TABLES) assert.equal(h.count(db, t), 0, t);
  insToken(db); insReview(db); insAccept(db); insMerge(db); insConsent(db); insWorktree(db);
  assert.deepEqual(snapshot(), before);
});

// ---------- S10-3: the append-only pin ----------

test('S10-3: the append-only source rule derives its protected set from V10_DDL too, and every v10 table is in it', () => {
  const file = path.join(__dirname, 'nexus-core-append-only-writes.test.cjs');
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /ddlText\('schemaV10\.ts', 'V10_DDL'\)/, 'the append-only test reads V10_DDL');
  // The same derivation the append-only test uses, over V10_DDL.
  const guarded = new Set();
  const re = /CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?"?\w+"?\s+BEFORE\s+(?:DELETE|UPDATE)(?:\s+OF\s+[\w\s,"]+?)?\s+ON\s+"?(\w+)"?/gi;
  let m; while ((m = re.exec(V10_DDL))) guarded.add(m[1].toLowerCase());
  assert.deepEqual([...guarded].sort(), [...V10_TABLES].sort());
  // At runtime: the append-only tables refuse any update; the others refuse a delete.
  const { db } = world();
  insToken(db); insReview(db, { id: 'r-x' }); insAccept(db); insMerge(db, { id: 'm-x' }); insConsent(db, { id: 'c-x' }); insWorktree(db);
  for (const [t, where] of [['reviews', "id = 'r-x'"], ['change_set_accepts', "version_id = 'v-cs-active'"], ['repo_merges', "id = 'm-x'"]]) {
    assert.throws(() => db.prepare(`UPDATE ${t} SET rowid = rowid WHERE ${where}`).run(), /append-only|immutable/, t);
  }
  for (const t of V10_TABLES) assert.throws(() => db.prepare(`DELETE FROM ${t}`).run(), /never deleted|append-only|immutable/, t);
  for (const t of V10_TABLES) assert.equal(h.count(db, t), 1, t);
});

// ---------- S10-4: the frozen DDL texts ----------

test('S10-4: the V7_DDL, V8_DDL and V9_DDL sha256 values are unchanged', () => {
  // Hashed with line endings normalised to LF, so a CRLF checkout does not change the pin.
  const sha = (s) => crypto.createHash('sha256').update(s.replace(/\r\n/g, '\n')).digest('hex');
  assert.equal(sha(loadTs('src/main/nexus/db/schemaV7.ts').V7_DDL), '208a9b06dcc8d8d71fa66d5fb8db07450003557b05cb6c918929241868c9f04a');
  assert.equal(sha(loadTs('src/main/nexus/db/schemaV8.ts').V8_DDL), 'cdad111319895ae99c63998530cfe6e2d7c0494848249f3c4199e4b61cfbbbf5');
  assert.equal(sha(loadTs('src/main/nexus/db/schemaV9.ts').V9_DDL), '6d537a19bfdf205d48c861394fb695bbb5b0eb29888fd80037ee116c92581c3f');
});
