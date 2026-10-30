'use strict';
// B1 Task 7: end-to-end flows through the nexus:* IPC handlers. A fake registrar stands in for ipcMain; the
// source ports are the real main adapters (sources.ts) over a temp git repo made here with async git (no sync
// child process). Every flow ends with the store health checks: the orphan queries O1-O9 all 0,
// foreign_key_check empty, integrity_check ok and the activity hash chain verified.
// Real SQLite only; nothing launches Electron or touches userData.
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const execFileAsync = promisify(require('node:child_process').execFile);
const loadTs = require('./load-ts.cjs');
const { orphans, orphanRows, storeHealth, ZERO } = require('./helpers/orphans.cjs');
const { PersistStore } = loadTs('src/main/db.ts');
const { createNexusPlatform } = loadTs('src/main/nexus/platform.ts');
const { registerNexusIpc, NEXUS_CHANNELS } = loadTs('src/main/nexusIpc/registerNexusIpc.ts');
const { createSourcePorts } = loadTs('src/main/nexusIpc/sources.ts');
const { resolveAllowedRoot } = loadTs('src/main/fsRoots.ts');

const UNKNOWN_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const SK = `sk-ant-api03-${'A1b2C3d4'.repeat(8)}`;
const P = 'p-ledger';

const git = async (cwd, ...args) => (await execFileAsync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true })).stdout.trim();

const stores = [];
test.after(() => { for (const s of stores) { try { s.close(); } catch { /* closed */ } } });

/** A v8 store whose p-ledger folder is a fresh temp git repo with one commit; real ports; the IPC handlers. */
async function setup() {
  const { file } = h.v6Fixture(); const s = new PersistStore(file); stores.push(s);
  s.open({ log: () => {}, backupDir: path.join(path.dirname(file), 'b'), now: () => h.NOW });
  const db = s.platformDatabase();
  const nx = createNexusPlatform(db, { now: () => h.NOW });
  const root = h.tmpDir('nx-flow-repo-');
  await git(root, 'init', '-q');
  fs.writeFileSync(path.join(root, 'README.md'), '# ledger\n\nRelease notes.\n');
  await git(root, 'add', 'README.md');
  await git(root, 'commit', '-q', '-m', 'Release one');
  const head = await git(root, 'rev-parse', 'HEAD');
  db.prepare('UPDATE projects SET root_path = ? WHERE id = ?').run(root, P);
  const roots = [root];
  const getProject = (id) => { const r = db.prepare('SELECT root_path FROM projects WHERE id = ?').get(id); return r ? { rootPath: r.root_path } : null; };
  const acceptFsRoot = (r) => resolveAllowedRoot(r, roots, fs.realpathSync.native);
  const sources = createSourcePorts({ acceptFsRoot, getProject });
  const env = { s, db, nx, root, roots, head, current: nx, logs: [] };
  const handlers = new Map();
  registerNexusIpc({ handle: (ch, fn) => handlers.set(ch, fn) }, {
    platform: () => env.current, unavailableReason: () => 'held', handoffsUnavailableReason: () => null,
    sources, log: (l) => env.logs.push(l)
  });
  assert.equal(handlers.size, 21);
  env.call = (ch, ...a) => handlers.get(ch)({ sender: {} }, ...a);
  env.ok = async (ch, ...a) => { const r = await env.call(ch, ...a); assert.equal(r.ok, true, `${ch}: ${JSON.stringify(r)}`); return r.data; };
  env.refused = async (ch, args, code, extra = {}) => {
    const r = await env.call(ch, ...args);
    assert.equal(r.ok, false, `${ch} should refuse: ${JSON.stringify(r)}`);
    assert.equal(r.code, code, `${ch}: ${JSON.stringify(r)}`);
    for (const [k, v] of Object.entries(extra)) assert.deepEqual(r[k], v, `${ch}.${k}: ${JSON.stringify(r)}`);
    assert.doesNotMatch(JSON.stringify(r), /\n\s+at |\.ts:\d+|[A-Za-z]:\\|user:local|nx-flow-repo/, ch);
    return r;
  };
  env.participation = async (workspaceId) => (await env.ok('nexus:participations:list')).find((x) => x.projectId === P && x.workspaceId === workspaceId);
  env.commitFile = async (name, text, msg) => {
    fs.writeFileSync(path.join(root, name), text);
    await git(root, 'add', name); await git(root, 'commit', '-q', '-m', msg);
    return git(root, 'rev-parse', 'HEAD');
  };
  env.saveCommit = (commit, target, workspaceId = 'sde') => env.ok('nexus:artifact:saveCommit', { projectId: P, workspaceId, commit, target });
  env.saveText = (relPath, target, workspaceId = 'sde') => env.ok('nexus:artifact:saveTextFile', { projectId: P, workspaceId, relPath, target });
  env.ready = async (commit, name) => { const r = await env.saveCommit(commit, { name }); return env.ok('nexus:version:markReady', r.version.id); };
  env.send = (fromId, toId, versionIds, title = 'For checking', note) =>
    env.ok('nexus:handoff:send', { projectId: P, fromParticipationId: fromId, toParticipationId: toId, versionIds, title, ...(note === undefined ? {} : { note }) });
  return env;
}

/** The store health every flow ends with. */
function healthy(db) {
  const r = storeHealth(db);
  assert.deepEqual(r.orphans, ZERO, `orphans: ${JSON.stringify(orphanRows(db))}`);
  assert.deepEqual(r.foreignKeys, []);
  assert.equal(r.integrity, 'ok');
  assert.equal(r.chain.ok, true, `activity chain: ${JSON.stringify(r.chain)}`);
  return r;
}
const count = (db, sql, ...a) => db.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get(...a).n;
const TABLES = ['project_workspaces', 'artifacts', 'artifact_versions', 'artifact_edges', 'handoffs', 'handoff_subjects', 'activity'];
const counts = (db) => Object.fromEntries(TABLES.map((t) => [t, count(db, t)]));
/** Lets a deferred denial audit row land: it is queued with queueMicrotask, so one macrotask turn drains it (no transaction stays open here). */
const settleDenials = () => new Promise((r) => setImmediate(r));
const snapshot = (db) => Object.fromEntries(TABLES.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
function addViewer(db) {
  db.prepare("INSERT INTO principals VALUES ('user:viewer','user','viewer',NULL,?)").run(h.NOW);
  db.prepare("INSERT INTO memberships VALUES ('user:viewer','project','p-ledger','viewer',?)").run(h.NOW);
  return { id: 'user:viewer', kind: 'user', displayName: 'viewer' };
}

test('the orphan queries find each kind of orphan on a damaged copy (and are 0 on a clean store)', async () => {
  const e = await setup();
  assert.deepEqual(orphans(e.db), ZERO);
  // Build one of each, with the triggers and foreign keys off on this throwaway store only.
  const { db } = e;
  const sde = await e.participation('sde'); const qa = await e.ok('nexus:participation:attach', P, 'qa');
  const rel = await e.ready(e.head, 'Release');
  db.pragma('foreign_keys = OFF');
  const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all();
  for (const t of triggers) db.exec(`DROP TRIGGER "${t.name}"`);
  const ins = (sql, ...a) => db.prepare(sql).run(...a);
  ins(`INSERT INTO artifacts (id, project_id, kind, name, owner_scope, owner_participation_id, owner_workspace_id, created_by, status,
      current_version_id, metadata_json, created_at, updated_at) VALUES ('a-empty', ?, 'text_file', 'x', 'participation', ?, 'sde', 'user:local',
      'active', NULL, '{}', 1, 1)`, P, sde.id);                                                                          // O1
  ins("UPDATE artifacts SET current_version_id = ? WHERE id = ?", rel.id, rel.artifactId);                              // O2 (candidate)
  ins(`INSERT INTO handoffs (id, project_id, from_participation_id, from_workspace_id, to_participation_id, to_workspace_id, title,
      subject_count, status, created_by, created_at, updated_at, status_changed_at) VALUES ('h-1', ?, ?, 'sde', ?, 'qa', 't', 2, 'accepted',
      'user:local', 1, 1, 1)`, P, sde.id, qa.id);                                                                         // O3 + O4
  ins(`INSERT INTO artifacts (id, project_id, kind, name, owner_scope, owner_participation_id, owner_workspace_id, created_by, status,
      current_version_id, metadata_json, created_at, updated_at) VALUES ('a-rcpt', ?, 'handoff_receipt', 'r', 'participation', ?, 'qa',
      'user:local', 'active', NULL, '{}', 1, 1)`, P, qa.id);                                                            // O5 (+O1)
  ins(`INSERT INTO artifact_edges (id, from_version_id, to_version_id, relation, source, created_by, created_at)
      VALUES ('e-1', ?, ?, 'depends_on', 'handoff_convert', 'user:local', 1)`, rel.id, UNKNOWN_ID);                          // O6 (+O8)
  ins('UPDATE artifact_versions SET participation_id = ? WHERE id = ?', qa.id, rel.id);                                   // O7
  ins("INSERT INTO project_workspaces (id, project_id, workspace_id, status, is_primary, source, created_by, created_at, updated_at) VALUES ('pw-x', 'p-gone', 'qa', 'active', 0, 'user', 'user:local', 1, 1)"); // O8
  ins(`INSERT INTO activity (id, ts, actor_kind, actor_id, entity_type, entity_id, action, status, details_json, prev_hash, hash)
      VALUES ('act-x', 1, 'user', 'user:local', 'handoff', 'h-missing', 'handoff.send', 'succeeded', '{}', 'x', 'y')`);     // O9
  const n = orphans(db);
  for (const id of Object.keys(ZERO)) assert.ok(n[id] >= 1, `${id} found nothing: ${JSON.stringify(n)}`);
});

test('F1 the full loop: attach, save a commit and a file, ready, promote, link, hand off, accept; downstream lineage', async () => {
  const e = await setup();
  // 1. attach qa
  const qa = await e.ok('nexus:participation:attach', P, 'qa');
  assert.deepEqual([qa.workspaceId, qa.status, qa.isPrimary, qa.source], ['qa', 'active', false, 'user']);
  const sde = await e.participation('sde');
  assert.equal(sde.isPrimary, true);
  // 2. the head commit as "Release" (sde), ready, promoted
  const rel = await e.saveCommit(e.head, { name: 'Release' });
  assert.deepEqual([rel.created, rel.artifact.kind, rel.artifact.ownerWorkspaceId, rel.version.versionNo, rel.version.status, rel.version.storageKind],
    [true, 'git_commit', 'sde', 1, 'draft', 'git']);
  assert.doesNotMatch(JSON.stringify(rel), /storage"|metadata|Release one|user:local|nx-flow-repo/);
  const relReady = await e.ok('nexus:version:markReady', rel.version.id);
  assert.equal(relReady.status, 'candidate');
  const relActive = await e.ok('nexus:version:promote', rel.version.id, null);
  assert.equal(relActive.status, 'active');
  assert.deepEqual((await e.ok('nexus:version:get', rel.version.id)).content, { type: 'git', commit: e.head });
  // 3. README.md as "Notes" (sde), ready
  const notes = await e.saveText('README.md', { name: 'Notes' });
  assert.deepEqual([notes.created, notes.artifact.kind, notes.version.status], [true, 'text_file', 'draft']);
  assert.equal((await e.ok('nexus:version:markReady', notes.version.id)).status, 'candidate');
  assert.deepEqual((await e.ok('nexus:version:get', notes.version.id)).content, { type: 'text', path: 'README.md', text: '# ledger\n\nRelease notes.\n' });
  // 4. Notes v1 -> Release v1
  const link = await e.ok('nexus:version:linkSources', notes.version.id, [rel.version.id]);
  assert.equal(link.created, 1);
  assert.deepEqual(link.edges.map((x) => [x.fromVersionId, x.toVersionId, x.relation, x.source]),
    [[notes.version.id, rel.version.id, 'derived_from', 'user_action']]);
  // 5. sde -> qa with Release v1, accepted
  const sent = await e.send(sde.id, qa.id, [rel.version.id], 'Release for checking', 'Please check the release');
  assert.deepEqual([sent.created, sent.handoff.status, sent.handoff.subjectCount, sent.handoff.fromWorkspaceId, sent.handoff.toWorkspaceId],
    [true, 'sent', 1, 'sde', 'qa']);
  const inbox = await e.ok('nexus:handoffs:list', { box: 'inbox', workspaceId: 'qa' });
  assert.deepEqual(inbox.map((x) => x.id), [sent.handoff.id]);
  const acc = await e.ok('nexus:handoff:accept', sent.handoff.id);
  assert.equal(acc.status, 'accepted'); assert.ok(acc.receiptVersionId);
  const receipt = await e.ok('nexus:version:get', acc.receiptVersionId);
  assert.deepEqual([receipt.status, receipt.content], ['active', { type: 'receipt', handoffId: sent.handoff.id }]);
  // 6. downstream of Release v1 = { Notes v1 (derived_from), receipt (depends_on) }
  const down = await e.ok('nexus:lineage:get', rel.version.id, { direction: 'down' });
  assert.deepEqual(down.nodes.map((x) => [x.versionId, x.relation]).sort(),
    [[notes.version.id, 'derived_from'], [acc.receiptVersionId, 'depends_on']].sort());
  assert.equal(down.truncated, false);
  // The receipt artifact lives in qa; the artifacts page shows all three.
  const all = await e.ok('nexus:artifacts:byProject', P);
  assert.deepEqual(all.map((x) => [x.artifact.kind, x.artifact.ownerWorkspaceId]).sort(),
    [['git_commit', 'sde'], ['handoff_receipt', 'qa'], ['text_file', 'sde']]);
  // A discard on a fresh draft.
  const scratch = await e.saveText('README.md', { name: 'Scratch' });
  assert.equal((await e.ok('nexus:version:discard', scratch.version.id)).status, 'deprecated');
  // The activity of the loop, as the Passport reads it.
  const acts = (await e.ok('nexus:activity:byProject', P, { limit: 50 })).map((x) => x.action).reverse();
  for (const a of ['participation.attach', 'artifact.create', 'version.register', 'version.finalize', 'version.promote', 'lineage.write',
    'handoff.send', 'handoff.accept', 'version.discard']) assert.ok(acts.includes(a), a);
  assert.deepEqual(e.logs, []);
  healthy(e.db);
});

test('F2 send then decline with a note; the same subjects again make a new handoff, then withdrawn', async () => {
  const e = await setup();
  const qa = await e.ok('nexus:participation:attach', P, 'qa'); const sde = await e.participation('sde');
  const v = await e.ready(e.head, 'Release');
  const first = await e.send(sde.id, qa.id, [v.id]);
  const declined = await e.ok('nexus:handoff:decline', first.handoff.id, 'Not this week');
  assert.deepEqual([declined.status, declined.responseNote, declined.receiptVersionId], ['declined', 'Not this week', null]);
  const second = await e.send(sde.id, qa.id, [v.id]);
  assert.equal(second.created, true); assert.notEqual(second.handoff.id, first.handoff.id);
  const withdrawn = await e.ok('nexus:handoff:withdraw', second.handoff.id);
  assert.deepEqual([withdrawn.status, withdrawn.responseNote, withdrawn.respondedAt], ['withdrawn', null, null]);
  const listed = await e.ok('nexus:handoffs:list', { box: 'all', projectId: P });
  assert.deepEqual(listed.map((x) => [x.id, x.status]).sort(), [[first.handoff.id, 'declined'], [second.handoff.id, 'withdrawn']].sort());
  assert.equal(count(e.db, "artifacts WHERE kind = 'handoff_receipt'"), 0, 'no receipt without an accept');
  healthy(e.db);
});

test('F3 every write sent twice at once writes one set of rows', async () => {
  const e = await setup();
  const twice = (ch, ...a) => Promise.all([e.call(ch, ...a), e.call(ch, ...a)]);
  const sameOrRefused = (pair, ch, allowed) => {
    const [a, b] = pair;
    assert.equal(a.ok, true, `${ch} first: ${JSON.stringify(a)}`);
    if (b.ok) assert.deepEqual(b.data?.id ?? b.data?.version?.id ?? b.data?.handoff?.id, a.data?.id ?? a.data?.version?.id ?? a.data?.handoff?.id, ch);
    else assert.ok(allowed.includes(b.code), `${ch} second: ${JSON.stringify(b)}`);
    return a.data;
  };
  // attach
  const [qa1, qa2] = await twice('nexus:participation:attach', P, 'qa');
  assert.deepEqual(qa2.data, qa1.data);
  assert.equal(count(e.db, "project_workspaces WHERE project_id = ? AND workspace_id = 'qa'", P), 1);
  const qa = qa1.data; const sde = await e.participation('sde');
  // save a commit (both reads interleave in the real ports; the second is deduped in the transaction)
  const [c1, c2] = await twice('nexus:artifact:saveCommit', { projectId: P, workspaceId: 'sde', commit: e.head, target: { name: 'Release' } });
  assert.deepEqual([c1.data.created, c2.data.created].sort(), [false, true]);
  assert.equal(c1.data.version.id, c2.data.version.id);
  assert.equal(count(e.db, "artifacts WHERE name = 'Release'"), 1);
  const rel = c1.data;
  // save a text file
  const [t1, t2] = await twice('nexus:artifact:saveTextFile', { projectId: P, workspaceId: 'sde', relPath: 'README.md', target: { name: 'Notes' } });
  assert.deepEqual([t1.data.created, t2.data.created].sort(), [false, true]);
  assert.equal(count(e.db, "artifacts WHERE name = 'Notes'"), 1); assert.equal(count(e.db, 'artifact_versions WHERE artifact_id = ?', t1.data.artifact.id), 1);
  // append to an existing artifact
  const head2 = await e.commitFile('CHANGES.md', 'two\n', 'Release two');
  const [a1, a2] = await twice('nexus:artifact:saveCommit', { projectId: P, workspaceId: 'sde', commit: head2, target: { artifactId: rel.artifact.id } });
  assert.deepEqual([a1.data.created, a2.data.created].sort(), [false, true]);
  assert.equal(count(e.db, 'artifact_versions WHERE artifact_id = ?', rel.artifact.id), 2);
  // mark ready
  const [r1, r2] = await twice('nexus:version:markReady', rel.version.id);
  assert.deepEqual(r2.data, r1.data);
  assert.equal(count(e.db, "activity WHERE action = 'version.finalize' AND version_id = ?", rel.version.id), 1);
  await e.ok('nexus:version:markReady', t1.data.version.id);
  // promote: the second loses the compare-and-set (the pointer already moved) and changes nothing
  const p = await twice('nexus:version:promote', rel.version.id, null);
  sameOrRefused(p, 'promote', ['conflict', 'illegal_transition']);
  if (!p[1].ok) assert.equal(p[1].detail.currentVersionId, rel.version.id);
  assert.equal(count(e.db, "activity WHERE action = 'version.promote' AND version_id = ?", rel.version.id), 1);
  // discard (a draft)
  const d = await twice('nexus:version:discard', a1.data.version.id);
  assert.deepEqual(d[1].data, d[0].data);
  assert.equal(count(e.db, "activity WHERE action = 'version.discard'"), 1);
  // link sources
  const [l1, l2] = await twice('nexus:version:linkSources', t1.data.version.id, [rel.version.id]);
  assert.deepEqual([l1.data.created, l2.data.created].sort(), [0, 1]);
  assert.deepEqual(l1.data.edges.map((x) => x.id), l2.data.edges.map((x) => x.id));
  assert.equal(count(e.db, "artifact_edges WHERE source = 'user_action'"), 1);
  // send, accept
  const args = { projectId: P, fromParticipationId: sde.id, toParticipationId: qa.id, versionIds: [rel.version.id], title: 'Check' };
  const [s1, s2] = await twice('nexus:handoff:send', args);
  assert.deepEqual([s1.data.created, s2.data.created].sort(), [false, true]);
  assert.equal(s1.data.handoff.id, s2.data.handoff.id);
  assert.equal(count(e.db, 'handoffs'), 1);
  const acc = await twice('nexus:handoff:accept', s1.data.handoff.id);
  sameOrRefused(acc, 'accept', ['illegal_transition']);
  assert.equal(count(e.db, "artifacts WHERE kind = 'handoff_receipt'"), 1);
  // decline and withdraw (handoff)
  const dh = (await e.send(sde.id, qa.id, [rel.version.id], 'Second')).handoff;
  const dec = await twice('nexus:handoff:decline', dh.id, 'no');
  sameOrRefused(dec, 'decline', ['illegal_transition']);
  const wh = (await e.send(sde.id, qa.id, [rel.version.id], 'Third')).handoff;
  const wd = await twice('nexus:handoff:withdraw', wh.id);
  sameOrRefused(wd, 'withdraw', ['illegal_transition']);
  assert.equal(count(e.db, "activity WHERE action IN ('handoff.decline', 'handoff.withdraw')"), 2);
  // withdraw a participation
  const ml = await e.ok('nexus:participation:attach', P, 'ml');
  const [w1, w2] = await twice('nexus:participation:withdraw', ml.id);
  assert.deepEqual(w2.data, w1.data); assert.equal(w1.data.status, 'withdrawn');
  assert.equal(count(e.db, "activity WHERE action = 'participation.withdraw'"), 1);
  healthy(e.db);
});

test('F4 the withdraw guard: blocked while a handoff is sent, allowed after a decline; then qa is frozen', async () => {
  const e = await setup();
  const qa = await e.ok('nexus:participation:attach', P, 'qa'); const sde = await e.participation('sde');
  const v = await e.ready(e.head, 'Release');
  const a = await e.send(sde.id, qa.id, [v.id], 'First');
  const acc = await e.ok('nexus:handoff:accept', a.handoff.id);
  const b = await e.send(sde.id, qa.id, [v.id], 'Second');
  const before = counts(e.db);
  const blocked = await e.refused('nexus:participation:withdraw', [qa.id], 'conflict');
  assert.deepEqual(blocked.detail, { participationId: qa.id, openHandoffs: 1 });
  assert.deepEqual(counts(e.db), before, 'a refused withdraw writes nothing');
  await e.ok('nexus:handoff:decline', b.handoff.id);
  const out = await e.ok('nexus:participation:withdraw', qa.id);
  assert.equal(out.status, 'withdrawn');
  const list = await e.ok('nexus:participations:list');
  assert.equal(list.find((x) => x.id === qa.id).status, 'withdrawn');
  // Saving into qa is not_participating; the qa receipt is frozen.
  await e.refused('nexus:artifact:saveTextFile', [{ projectId: P, workspaceId: 'qa', relPath: 'README.md', target: { name: 'QA notes' } }], 'not_participating');
  await e.refused('nexus:version:promote', [acc.receiptVersionId, acc.receiptVersionId], 'participation_inactive');
  await e.refused('nexus:handoff:send', [{ projectId: P, fromParticipationId: sde.id, toParticipationId: qa.id, versionIds: [v.id], title: 'x' }], 'participation_inactive');
  // Re-attaching re-activates the same row.
  const back = await e.ok('nexus:participation:attach', P, 'qa');
  assert.deepEqual([back.id, back.status], [qa.id, 'active']);
  healthy(e.db);
});

test('F5 a legacy domain change moves the primary to ml; sde stays active and its artifacts stay writable', async () => {
  const e = await setup();
  const notes = await e.saveText('README.md', { name: 'Notes' });
  const project = e.s.getProject(P);
  e.s.saveProject({ ...project, domainId: 'ai-ml' });
  const mine = (await e.ok('nexus:participations:list')).filter((x) => x.projectId === P);
  const by = Object.fromEntries(mine.map((x) => [x.workspaceId, x]));
  assert.deepEqual([by.ml.isPrimary, by.ml.status], [true, 'active']);
  assert.deepEqual([by.sde.isPrimary, by.sde.status], [false, 'active']);
  // sde artifacts stay writable: append, mark ready, promote.
  fs.writeFileSync(path.join(e.root, 'README.md'), '# ledger\n\nRelease notes, second edition.\n');
  const v2 = await e.saveText('README.md', { artifactId: notes.artifact.id });
  assert.deepEqual([v2.created, v2.version.versionNo], [true, 2]);
  await e.ok('nexus:version:markReady', v2.version.id);
  assert.equal((await e.ok('nexus:version:promote', v2.version.id, null)).status, 'active');
  // ... and ml takes saves too.
  const mlSave = await e.saveCommit(e.head, { name: 'Model input' }, 'ml');
  assert.equal(mlSave.artifact.ownerWorkspaceId, 'ml');
  healthy(e.db);
});

test('F6 the platform getter turns null mid-flow: every channel answers platform_unavailable and nothing is written', async () => {
  const e = await setup();
  const qa = await e.ok('nexus:participation:attach', P, 'qa'); const sde = await e.participation('sde');
  const v = await e.ready(e.head, 'Release');
  // An in-flight save that started before the switch completes whole, on the platform it started with.
  const inflight = e.call('nexus:artifact:saveTextFile', { projectId: P, workspaceId: 'sde', relPath: 'README.md', target: { name: 'Notes' } });
  e.current = null;
  const r = await inflight;
  assert.equal(r.ok, true, JSON.stringify(r));
  const before = snapshot(e.db);
  const args = {
    'nexus:participation:attach': [P, 'ml'], 'nexus:participation:withdraw': [qa.id], 'nexus:artifacts:list': [{}],
    'nexus:artifacts:byProject': [P], 'nexus:artifact:get': [r.data.artifact.id], 'nexus:version:get': [v.id],
    'nexus:lineage:get': [v.id, { direction: 'up' }], 'nexus:participations:list': [],
    'nexus:artifact:saveCommit': [{ projectId: P, workspaceId: 'sde', commit: e.head, target: { name: 'Other' } }],
    'nexus:artifact:saveTextFile': [{ projectId: P, workspaceId: 'sde', relPath: 'README.md', target: { name: 'Other' } }],
    'nexus:version:markReady': [r.data.version.id], 'nexus:version:promote': [v.id, null], 'nexus:version:discard': [r.data.version.id],
    'nexus:version:linkSources': [r.data.version.id, [v.id]], 'nexus:handoffs:list': [{}], 'nexus:handoff:get': [UNKNOWN_ID],
    'nexus:handoff:send': [{ projectId: P, fromParticipationId: sde.id, toParticipationId: qa.id, versionIds: [v.id], title: 't' }],
    'nexus:handoff:accept': [UNKNOWN_ID], 'nexus:handoff:decline': [UNKNOWN_ID], 'nexus:handoff:withdraw': [UNKNOWN_ID],
    'nexus:activity:byProject': [P]
  };
  assert.deepEqual(Object.keys(args).sort(), [...NEXUS_CHANNELS].sort());
  for (const ch of NEXUS_CHANNELS) {
    const out = await e.call(ch, ...args[ch]);
    assert.deepEqual([out.ok, out.code, out.reason], [false, 'platform_unavailable', 'held'], ch);
  }
  assert.deepEqual(snapshot(e.db), before, 'no partial rows');
  // A new platform instance (a restart) gets its own user saves and works.
  e.current = createNexusPlatform(e.db, { now: () => h.NOW });
  const again = await e.saveText('README.md', { name: 'Notes' });
  assert.deepEqual([again.created, again.version.id], [false, r.data.version.id]);
  healthy(e.db);
});

test('F7 a stale promote is a conflict with currentVersionId and changes nothing; promote and roll back', async () => {
  const e = await setup();
  const v1 = await e.ready(e.head, 'Release');
  await e.ok('nexus:version:promote', v1.id, null);
  const head2 = await e.commitFile('CHANGES.md', 'two\n', 'Release two');
  const s2 = await e.saveCommit(head2, { artifactId: v1.artifactId });
  assert.deepEqual([s2.created, s2.version.versionNo], [true, 2]);
  const v2 = await e.ok('nexus:version:markReady', s2.version.id);
  const before = snapshot(e.db);
  const stale = await e.refused('nexus:version:promote', [v2.id, null], 'conflict');
  assert.deepEqual(stale.detail, { currentVersionId: v1.id });
  const stale2 = await e.refused('nexus:version:promote', [v2.id, v2.id], 'conflict');
  assert.deepEqual(stale2.detail, { currentVersionId: v1.id });
  assert.deepEqual(snapshot(e.db), before, 'nothing changes');
  // promote v2 with the right expectation, then roll back to v1
  assert.equal((await e.ok('nexus:version:promote', v2.id, v1.id)).status, 'active');
  assert.equal((await e.ok('nexus:version:get', v1.id)).status, 'deprecated');
  const back = await e.ok('nexus:version:promote', v1.id, v2.id);
  assert.equal(back.status, 'active');
  const art = await e.ok('nexus:artifact:get', v1.artifactId);
  assert.equal(art.artifact.currentVersionId, v1.id);
  assert.deepEqual(art.versions.map((x) => [x.versionNo, x.status]), [[1, 'active'], [2, 'deprecated']]);
  const rows = (await e.ok('nexus:activity:byProject', P)).filter((x) => x.action === 'version.promote');
  assert.equal(rows[0].details.rollback, true);
  healthy(e.db);
});

test('F8 deleteProject on the flow project is refused at v8 and writes nothing (D2)', async () => {
  const e = await setup();
  const qa = await e.ok('nexus:participation:attach', P, 'qa'); const sde = await e.participation('sde');
  const v = await e.ready(e.head, 'Release');
  const sent = await e.send(sde.id, qa.id, [v.id]);
  await e.ok('nexus:handoff:accept', sent.handoff.id);
  const before = h.allRows(e.db);
  assert.equal(e.s.deleteProject(P), false);
  assert.equal(e.s.deleteProject(P, { withGraph: true }), false);
  assert.deepEqual(h.allRows(e.db), before);
  assert.ok(e.s.getProject(P));
  healthy(e.db);
});

test('every write channel error path answers its code through the envelope and writes no partial rows', async () => {
  const e = await setup();
  const { db, nx } = e;
  const qa = await e.ok('nexus:participation:attach', P, 'qa'); const sde = await e.participation('sde');
  const relDraft = await e.saveCommit(e.head, { name: 'Release' });
  const rel = await e.ok('nexus:version:markReady', relDraft.version.id);
  await e.ok('nexus:version:promote', rel.id, null);                                            // rel: active
  const notes = await e.saveText('README.md', { name: 'Notes' });                                // notes: draft
  const before = () => counts(db);
  const deniedRows = () => count(db, "activity WHERE status = 'denied'");
  const otherActivity = () => count(db, "activity WHERE status <> 'denied'");
  // A refused call writes no platform row. Its only allowed trace is a denial audit row (status 'denied'); a
  // denial raised inside a transaction is queued (queueMicrotask), so let it land first.
  const unchanged = async (fn) => {
    const b = before(); const bOther = otherActivity(); const bDenied = deniedRows();
    await fn();
    await settleDenials();
    const a = before();
    assert.deepEqual({ ...a, activity: undefined }, { ...b, activity: undefined }, 'no platform rows written');
    assert.equal(otherActivity(), bOther, 'no activity row other than a denial');
    assert.equal(a.activity - b.activity, deniedRows() - bDenied, 'every new activity row is a denial');
  };
  const bad = (ch, args, field) => unchanged(() => e.refused(ch, args, 'invalid', { reason: 'bad_request', ...(field ? { field } : {}) }));
  const why = (ch, args, code, reason) => unchanged(() => e.refused(ch, args, code, reason ? { reason } : {}));
  const textArgs = (relPath, target = { name: 'x' }, workspaceId = 'sde', projectId = P) => [{ projectId, workspaceId, relPath, target }];
  const commitArgs = (commit, target = { name: 'x' }, workspaceId = 'sde', projectId = P) => [{ projectId, workspaceId, commit, target }];

  // --- request validation (every write channel) ---
  await bad('nexus:participation:attach', [P, 'SDE'], 'workspaceId');
  await bad('nexus:participation:attach', [P, 'qa', 'x'], 'arguments');
  await bad('nexus:participation:withdraw', ['qa'], 'participationId');
  await bad('nexus:artifact:saveCommit', commitArgs('HEAD'), 'commit');
  await bad('nexus:artifact:saveCommit', [{ ...commitArgs(e.head)[0], principal: 'system' }], 'principal');
  await bad('nexus:artifact:saveCommit', commitArgs(e.head, { name: 'x', artifactId: UNKNOWN_ID }), 'target');
  await bad('nexus:artifact:saveCommit', commitArgs(e.head, {}), 'target');
  await bad('nexus:artifact:saveTextFile', textArgs('../outside.txt'), 'relPath');
  await bad('nexus:artifact:saveTextFile', textArgs('C:\\Windows\\win.ini'), 'relPath');
  await bad('nexus:artifact:saveTextFile', [{ ...textArgs('a.md')[0], rootPath: 'C:\\' }], 'rootPath');
  await bad('nexus:version:markReady', [42], 'versionId');
  await bad('nexus:version:promote', [rel.id], 'expectedCurrentVersionId');
  await bad('nexus:version:discard', [null], 'versionId');
  await bad('nexus:version:linkSources', [notes.version.id, []], 'sourceVersionIds');
  await bad('nexus:version:linkSources', [notes.version.id, Array(21).fill(0).map((_, i) => `01ARZ3NDEKTSV4RRFFQ69G5F${String(i).padStart(2, '0')}`)], 'sourceVersionIds');
  await bad('nexus:handoff:send', [{ projectId: P, fromParticipationId: sde.id, toParticipationId: qa.id, versionIds: [rel.id], title: ' ' }], 'title');
  await bad('nexus:handoff:send', [{ projectId: P, fromParticipationId: sde.id, toParticipationId: qa.id, versionIds: [rel.id], title: 't', role: 'owner' }], 'role');
  await bad('nexus:handoff:accept', ['h-1'], 'handoffId');
  await bad('nexus:handoff:decline', [UNKNOWN_ID, 'x'.repeat(2001)], 'note');
  await bad('nexus:handoff:withdraw', [undefined], 'handoffId');

  // --- not_found (every write channel) ---
  await why('nexus:participation:attach', ['p-nope', 'qa'], 'not_found');
  await why('nexus:participation:withdraw', [UNKNOWN_ID], 'not_found');
  await why('nexus:artifact:saveCommit', commitArgs(e.head, { artifactId: UNKNOWN_ID }), 'not_found');
  await why('nexus:artifact:saveTextFile', textArgs('README.md', { artifactId: UNKNOWN_ID }), 'not_found');
  for (const ch of ['nexus:version:markReady', 'nexus:version:discard', 'nexus:handoff:accept', 'nexus:handoff:decline', 'nexus:handoff:withdraw']) {
    await why(ch, [UNKNOWN_ID], 'not_found');
  }
  await why('nexus:version:promote', [UNKNOWN_ID, null], 'not_found');
  await why('nexus:version:linkSources', [UNKNOWN_ID, [rel.id]], 'not_found');
  await why('nexus:handoff:send', [{ projectId: P, fromParticipationId: UNKNOWN_ID, toParticipationId: qa.id, versionIds: [rel.id], title: 't' }], 'not_found');

  // --- attach ---
  await why('nexus:participation:attach', [P, 'zz-unknown'], 'invalid');
  const dl = await e.ok('nexus:participation:attach', P, 'dl');
  db.prepare("UPDATE project_workspaces SET status = 'complete', completion_json = '{\"ok\":true}', completion_hash = 'h1', completion_at = 5 WHERE id = ?").run(dl.id);
  await why('nexus:participation:attach', [P, 'dl'], 'conflict');
  // --- withdraw: the primary ---
  await why('nexus:participation:withdraw', [sde.id], 'invalid');

  // --- saveCommit reasons ---
  await why('nexus:artifact:saveCommit', commitArgs('0'.repeat(40)), 'invalid', 'not_a_commit');
  await why('nexus:artifact:saveCommit', commitArgs(e.head, { artifactId: notes.artifact.id }), 'invalid', 'kind_mismatch');
  await why('nexus:artifact:saveCommit', commitArgs(e.head, { name: `key ${SK}` }), 'invalid', 'secret_in_metadata');
  await why('nexus:artifact:saveCommit', commitArgs(e.head, { name: 'x' }, 'ml'), 'not_participating');
  const plain = h.tmpDir('nx-flow-plain-'); e.roots.push(plain);
  fs.writeFileSync(path.join(plain, 'a.txt'), 'a\n');
  db.prepare('UPDATE projects SET root_path = ? WHERE id = ?').run(plain, 'p-sales');
  const salesWs = (await e.ok('nexus:participations:list')).find((x) => x.projectId === 'p-sales' && x.isPrimary).workspaceId;
  await why('nexus:artifact:saveCommit', commitArgs(e.head, { name: 'x' }, salesWs, 'p-sales'), 'invalid', 'not_a_repository');
  await why('nexus:artifact:saveCommit', commitArgs(e.head, { name: 'x' }, 'sec', 'p-audit'), 'invalid', 'project_folder_unavailable');
  await why('nexus:artifact:saveTextFile', textArgs('a.txt', { name: 'x' }, 'sec', 'p-audit'), 'invalid', 'project_folder_unavailable');

  // --- saveTextFile reasons ---
  await why('nexus:artifact:saveTextFile', textArgs('missing.md'), 'invalid', 'file_not_found');
  await why('nexus:artifact:saveTextFile', textArgs('.env'), 'invalid', 'sensitive_name');
  fs.writeFileSync(path.join(e.root, 'big.txt'), 'x'.repeat(65537));
  await why('nexus:artifact:saveTextFile', textArgs('big.txt'), 'invalid', 'too_large');
  fs.writeFileSync(path.join(e.root, 'bin.dat'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  await why('nexus:artifact:saveTextFile', textArgs('bin.dat'), 'invalid', 'not_text');
  fs.writeFileSync(path.join(e.root, 'key.txt'), `token: ${SK}\n`);
  await why('nexus:artifact:saveTextFile', textArgs('key.txt'), 'invalid', 'secret_in_content');
  fs.writeFileSync(path.join(e.root, 'linked.txt'), 'shared\n');
  fs.linkSync(path.join(e.root, 'linked.txt'), path.join(plain, 'other-name.txt'));
  const hard = await e.refused('nexus:artifact:saveTextFile', textArgs('linked.txt'), 'invalid', { reason: 'path_refused' });
  assert.match(hard.message, /linked file that is also stored under other names/);
  await why('nexus:artifact:saveTextFile', textArgs('README.md', { artifactId: relDraft.artifact.id }), 'invalid', 'kind_mismatch');

  // --- markReady / promote / discard ---
  await why('nexus:version:markReady', [rel.id], 'illegal_transition');
  const job = nx.jobs.create(nx.principals.localUser(), { kind: 'tool.run', projectId: P, workspaceId: 'sde', idempotencyKey: 'flows-job' }).job;
  const engineArt = nx.artifacts.create(nx.principals.localUser(), { projectId: P, workspaceId: 'sde', kind: 'report', name: 'engine draft' });
  const engineDraft = nx.artifacts.registerVersion(nx.principals.localUser(), { artifactId: engineArt.id, storage: { kind: 'inline', json: { n: 1 } }, producedByJobId: job.id }).version;
  await why('nexus:version:markReady', [engineDraft.id], 'invalid', 'produced_by_job');
  await why('nexus:version:promote', [notes.version.id, null], 'illegal_transition');
  await why('nexus:version:discard', [rel.id], 'illegal_transition');

  // --- linkSources ---
  await e.ok('nexus:version:markReady', notes.version.id);
  await e.ok('nexus:version:linkSources', notes.version.id, [rel.id]);
  await why('nexus:version:linkSources', [rel.id, [notes.version.id]], 'cycle');
  await why('nexus:version:linkSources', [rel.id, [rel.id]], 'cycle');
  const draft2 = await e.saveText('README.md', { name: 'Draft two' });
  await why('nexus:version:linkSources', [rel.id, [draft2.version.id]], 'invalid');
  const inv = nx.artifacts.saveUserVersion(nx.principals.localUser(), { projectId: 'p-invoice', workspaceId: 'dl', kind: 'text_file', target: { name: 'Other' },
    storage: { kind: 'inline', json: { path: 'a.md', text: 'other project' } }, metadata: { source: 'project_file', path: 'a.md', bytes: 13 }, action: 'user.save_file' });
  nx.artifacts.markReady(nx.principals.localUser(), inv.version.id);
  await why('nexus:version:linkSources', [rel.id, [inv.version.id]], 'invalid');

  // --- handoffs ---
  await why('nexus:handoff:send', [{ projectId: P, fromParticipationId: sde.id, toParticipationId: qa.id, versionIds: [draft2.version.id], title: 't' }], 'invalid');
  await why('nexus:handoff:send', [{ projectId: P, fromParticipationId: sde.id, toParticipationId: sde.id, versionIds: [rel.id], title: 't' }], 'invalid');
  await why('nexus:handoff:send', [{ projectId: P, fromParticipationId: sde.id, toParticipationId: qa.id, versionIds: [rel.id], title: `t ${SK}` }], 'invalid', 'secret_in_metadata');
  const h1 = (await e.send(sde.id, qa.id, [rel.id], 'One')).handoff;
  await why('nexus:handoff:decline', [h1.id, `see ${SK}`], 'invalid', 'secret_in_metadata');
  await e.ok('nexus:handoff:withdraw', h1.id);
  for (const ch of ['nexus:handoff:accept', 'nexus:handoff:decline', 'nexus:handoff:withdraw']) await why(ch, [h1.id], 'illegal_transition');
  // accept into a participation that was frozen behind the guard's back (a fixture edit) is participation_inactive
  const h2 = (await e.send(sde.id, qa.id, [rel.id], 'Two')).handoff;
  db.prepare("UPDATE project_workspaces SET status = 'withdrawn' WHERE id = ?").run(qa.id);
  await why('nexus:handoff:accept', [h2.id], 'participation_inactive');
  db.prepare("UPDATE project_workspaces SET status = 'active' WHERE id = ?").run(qa.id);
  // archived artifacts: an append is a conflict, and so is a link into one
  nx.artifacts.archive(nx.principals.localUser(), notes.artifact.id);
  await why('nexus:artifact:saveTextFile', textArgs('README.md', { artifactId: notes.artifact.id }), 'conflict');
  await why('nexus:version:linkSources', [notes.version.id, [rel.id]], 'conflict');
  // a draft whose owner was withdrawn is frozen: markReady, discard and append are participation_inactive
  await e.ok('nexus:handoff:decline', h2.id);
  const qaDraft = await e.saveCommit(e.head, { name: 'QA draft' }, 'qa');
  await e.ok('nexus:participation:withdraw', qa.id);
  await why('nexus:version:markReady', [qaDraft.version.id], 'participation_inactive');
  await why('nexus:version:discard', [qaDraft.version.id], 'participation_inactive');
  await why('nexus:artifact:saveCommit', commitArgs(e.head, { artifactId: qaDraft.artifact.id }, 'qa'), 'participation_inactive');

  // --- denied: a viewer (stands in for the resolved principal; the arguments never name one) ---
  const viewer = addViewer(db);
  const realLocal = nx.principals.localUser.bind(nx.principals);
  nx.principals.localUser = () => viewer;
  const h3 = { id: h2.id };
  const deniedCalls = [
    ['nexus:participation:attach', [P, 'ml']], ['nexus:participation:withdraw', [qa.id]],
    ['nexus:artifact:saveCommit', commitArgs(e.head, { name: 'v' })], ['nexus:artifact:saveTextFile', textArgs('README.md', { name: 'v' })],
    ['nexus:version:markReady', [draft2.version.id]], ['nexus:version:promote', [rel.id, rel.id]], ['nexus:version:discard', [draft2.version.id]],
    ['nexus:version:linkSources', [draft2.version.id, [rel.id]]],
    ['nexus:handoff:send', [{ projectId: P, fromParticipationId: sde.id, toParticipationId: qa.id, versionIds: [rel.id], title: 't' }]],
    ['nexus:handoff:accept', [h3.id]], ['nexus:handoff:decline', [h3.id]], ['nexus:handoff:withdraw', [h3.id]]
  ];
  const viewerDenials = () => count(db, "activity WHERE status = 'denied' AND actor_id = 'user:viewer'");
  const deniedBefore = viewerDenials();
  for (const [ch, args] of deniedCalls) await why(ch, args, 'denied');
  nx.principals.localUser = realLocal;
  await settleDenials();
  // Exactly one denial row per refused call: every one of these channels audits its denial.
  assert.equal(viewerDenials() - deniedBefore, deniedCalls.length);

  assert.deepEqual(e.logs, [], 'no internal error on any path');
  healthy(db);
});
