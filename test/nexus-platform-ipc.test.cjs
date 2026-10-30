'use strict';
// B1 Tasks 6 and 7: the nexus:* IPC module. A fake registrar stands in for ipcMain; every handler is
// called directly with fixtures. Real SQLite only; nothing launches Electron or touches userData.
// The end-to-end write flows and the orphan checks are in nexus-platform-b1-flows.test.cjs.
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { PersistStore } = loadTs('src/main/db.ts');
const { createNexusPlatform } = loadTs('src/main/nexus/platform.ts');
const { PlatformError } = loadTs('src/main/nexus/errors.ts');
const { verifyActivityChain } = loadTs('src/main/nexus/activity/writer.ts');
const { registerNexusIpc, NEXUS_CHANNELS } = loadTs('src/main/nexusIpc/registerNexusIpc.ts');
const { scrubMessage, fail, REASON_MESSAGES, BUSY_MESSAGE } = loadTs('src/main/nexusIpc/envelope.ts');
const { MAX_LIST_LIMIT } = loadTs('src/main/nexus/artifact/artifactService.ts');
const { V, RequestError } = loadTs('src/main/nexusIpc/validate.ts');
const { participationView, ACTIVITY_DETAIL_KEYS } = loadTs('src/main/nexusIpc/dto.ts');

const READ_CHANNELS = ['nexus:participations:list', 'nexus:artifacts:list', 'nexus:artifacts:byProject', 'nexus:artifact:get',
  'nexus:version:get', 'nexus:lineage:get', 'nexus:handoffs:list', 'nexus:handoff:get', 'nexus:activity:byProject'];
const HANDOFF_CHANNELS = ['nexus:handoffs:list', 'nexus:handoff:get', 'nexus:handoff:send', 'nexus:handoff:accept',
  'nexus:handoff:decline', 'nexus:handoff:withdraw'];
const UNKNOWN_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const SHA = 'a'.repeat(40);

const stores = [];
test.after(() => { for (const s of stores) { try { s.close(); } catch { /* closed */ } } });

function setupPlatform(o = {}) {
  const { file } = h.v6Fixture(); const s = new PersistStore(file); stores.push(s);
  s.open({ log: () => {}, backupDir: path.join(path.dirname(file), 'b'), now: () => h.NOW });
  const db = s.platformDatabase();
  const nx = createNexusPlatform(db, { now: () => h.NOW, ...(o.handoffs === undefined ? {} : { handoffs: o.handoffs }) });
  return { s, db, nx, me: nx.principals.localUser() };
}
/** Ports that record every call; no read channel may use them. */
function spyPorts(calls = []) {
  const no = (name) => async () => { calls.push(name); return null; };
  return { calls, projectRoot: no('projectRoot'), readFile: no('readFile'), resolveCommit: no('resolveCommit') };
}
function harness(o = {}) {
  const handlers = new Map(); const logs = [];
  const registrar = { handle: (ch, fn) => { assert.ok(!handlers.has(ch), `duplicate ${ch}`); handlers.set(ch, fn); } };
  const env = o.noPlatform ? { s: null, nx: null } : setupPlatform(o);
  const sources = o.sources ?? spyPorts();
  registerNexusIpc(registrar, { platform: () => env.nx, unavailableReason: () => 'held',
    handoffsUnavailableReason: () => 'auto_held', sources, log: (l) => logs.push(l) });
  return { ...env, handlers, logs, sources, call: (ch, ...a) => handlers.get(ch)({ sender: {} }, ...a) };
}
const textSave = (target, text, workspaceId = 'sde', projectId = 'p-ledger') => ({
  projectId, workspaceId, kind: 'text_file', target, storage: { kind: 'inline', json: { path: 'docs/notes.md', text } },
  metadata: { source: 'project_file', path: 'docs/notes.md', bytes: text.length }, action: 'user.save_file'
});
const commitSave = (target, commit = SHA) => ({
  projectId: 'p-ledger', workspaceId: 'sde', kind: 'git_commit', target,
  storage: { kind: 'git', commit, ref: 'refs/heads/main', paths: ['src/a.ts'] },
  metadata: { source: 'git_commit', subject: 'Fix the parser' }, action: 'user.save_commit'
});
const okData = (r) => { assert.equal(r.ok, true, JSON.stringify(r)); return r.data; };

test('every channel of NEXUS_CHANNELS is registered (21, frozen), the read channels among them', () => {
  const { handlers } = harness({ noPlatform: true });
  assert.deepEqual([...handlers.keys()].sort(), [...NEXUS_CHANNELS].sort());
  assert.equal(NEXUS_CHANNELS.length, 21); assert.equal(new Set(NEXUS_CHANNELS).size, 21); assert.ok(Object.isFrozen(NEXUS_CHANNELS));
  for (const ch of READ_CHANNELS) assert.ok(NEXUS_CHANNELS.includes(ch), ch);
});

test('I1 with no platform every channel answers platform_unavailable with its reason', async () => {
  const { handlers, call } = harness({ noPlatform: true });
  for (const ch of handlers.keys()) {
    assert.ok(NEXUS_CHANNELS.includes(ch), ch);
    const r = await call(ch, 'x', { a: 1 });
    assert.deepEqual([r.ok, r.code, r.reason], [false, 'platform_unavailable', 'held'], ch);
    assert.equal(typeof r.message, 'string');
  }
});

test('I2 with handoffs off, the handoff channels answer handoffs_unavailable and the others work', async () => {
  const { handlers, call, nx } = harness({ handoffs: false });
  assert.equal(nx.handoffs, null);
  for (const ch of handlers.keys()) {
    if (!HANDOFF_CHANNELS.includes(ch)) continue;
    const r = await call(ch, UNKNOWN_ID);
    assert.deepEqual([r.ok, r.code, r.reason, r.subReason], [false, 'platform_unavailable', 'handoffs_unavailable', 'auto_held'], ch);
  }
  okData(await call('nexus:participations:list'));
  okData(await call('nexus:artifacts:list', {}));
  okData(await call('nexus:artifacts:byProject', 'p-ledger'));
  okData(await call('nexus:activity:byProject', 'p-ledger'));
});

test('I3 hostile arguments never throw, never leak a stack or a path, and never reach a write', async () => {
  const { handlers, call, db, sources } = harness();
  const counts = () => ['artifacts', 'artifact_versions', 'artifact_edges', 'handoffs', 'project_workspaces']
    .map((t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n);
  const before = counts();
  const hostile = [undefined, null, 42, '', 'x'.repeat(5000), '../../etc/passwd', 'C:\\Windows\\system32', JSON.parse('{"__proto__":{"a":1}}'),
    { projectId: 'p-ledger', extra: 1 }, ['a'], { principal: 'system', kind: 'system' }, { 'C:\\x': 1 }, NaN, Infinity, { limit: -1 }];
  for (const ch of handlers.keys()) for (const a of hostile) {
    const r = await call(ch, a, a);
    assert.equal(typeof r, 'object', ch);
    if (!r.ok) {
      assert.ok(['invalid', 'not_found', 'denied'].includes(r.code), `${ch} gave ${r.code}`);
      assert.doesNotMatch(JSON.stringify(r), /\n\s+at |\.ts:\d+|[A-Za-z]:\\|\/tmp\//);
    }
  }
  assert.deepEqual(counts(), before, 'no hostile call wrote a platform row');
  assert.deepEqual(sources.calls, [], 'no hostile request reaches the file system or git ports');
  // An unknown key is refused by name; a hostile key is never echoed.
  const r = await call('nexus:artifacts:list', { projectId: 'p-ledger', extra: 1 });
  assert.deepEqual([r.code, r.reason, r.field], ['invalid', 'bad_request', 'extra']);
  const r2 = await call('nexus:artifacts:list', { '../C:\\evil': 1 });
  assert.deepEqual([r2.code, r2.field], ['invalid', 'request']);
});

test('I4 the principal is always user:local, resolved once per request; identity-shaped arguments are refused', async () => {
  const { call, nx, db, me } = harness();
  nx.artifacts.saveUserVersion(me, textSave({ name: 'Notes' }, 'hello'));
  const real = nx.principals.localUser.bind(nx.principals); let n = 0;
  nx.principals.localUser = () => { n++; return real(); };
  const seq0 = db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM activity').get().s;
  const requests = [['nexus:participations:list'], ['nexus:artifacts:list', {}], ['nexus:artifacts:byProject', 'p-ledger'],
    ['nexus:activity:byProject', 'p-ledger'], ['nexus:handoffs:list'], ['nexus:artifact:get', UNKNOWN_ID]];
  for (const [ch, ...a] of requests) await call(ch, ...a);
  assert.equal(n, requests.length, 'one localUser call per request');
  for (const bad of [{ principal: 'system' }, { actor: 'system' }, { role: 'owner' }, { principalId: 'system' }, { actorId: 'agent:x' }]) {
    const r = await call('nexus:artifacts:list', bad);
    assert.deepEqual([r.ok, r.code, r.reason], [false, 'invalid', 'bad_request'], JSON.stringify(bad));
    const r2 = await call('nexus:handoffs:list', bad);
    assert.deepEqual([r2.ok, r2.code], [false, 'invalid']);
  }
  assert.equal(n, requests.length, 'a refused request resolves no principal');
  const others = db.prepare("SELECT COUNT(*) AS n FROM activity WHERE seq > ? AND actor_id <> 'user:local'").get(seq0).n;
  assert.equal(others, 0, 'no row written on behalf of the arguments');
});

test('I5 an unexpected throw becomes internal, with one scrubbed log line', async () => {
  const { call, logs, nx } = harness();
  nx.artifacts.listForReader = () => { throw Object.assign(new Error('disk I/O at C:\\Users\\x\\harness.db'), { code: 'SQLITE_IOERR' }); };
  const r = await call('nexus:artifacts:list', {});
  assert.deepEqual([r.ok, r.code], [false, 'internal']); assert.doesNotMatch(r.message, /Users|harness/);
  assert.deepEqual(logs, ['[nexus-ipc] nexus:artifacts:list failed error=Error code=SQLITE_IOERR']);
  // A throwing platform getter, a non-Error throw and a hostile code are internal too.
  const handlers = new Map(); const logs2 = [];
  registerNexusIpc({ handle: (c, f) => handlers.set(c, f) }, { platform: () => { throw new TypeError('x'); }, unavailableReason: () => null,
    sources: spyPorts(), log: (l) => logs2.push(l) });
  const r2 = await handlers.get('nexus:participations:list')({});
  assert.deepEqual([r2.ok, r2.code], [false, 'internal']);
  assert.deepEqual(logs2, ['[nexus-ipc] nexus:participations:list failed error=TypeError code=none']);
  const l3 = []; fail({ code: 'C:\\x\\y' }, 'nexus:x', (l) => l3.push(l));
  assert.deepEqual(l3, ['[nexus-ipc] nexus:x failed error=object code=none']);
});

test('I6 a PlatformError message with an absolute path is scrubbed to its basename, redacted, one line, capped', async () => {
  const { call, nx } = harness();
  nx.artifacts.get = () => { throw new PlatformError('not_found', 'artifact not found at C:\\Users\\x\\proj\\secret.txt and /home/u/data/y.db\n    at foo (/tmp/a.ts:3:4)'); };
  const r = await call('nexus:artifact:get', UNKNOWN_ID);
  assert.equal(r.code, 'not_found');
  assert.match(r.message, /secret\.txt/); assert.match(r.message, /y\.db/);
  assert.doesNotMatch(r.message, /Users|home|\/tmp|\n/);
  assert.equal(scrubMessage('x'.repeat(1000)).length, 300);
  assert.equal(scrubMessage('see \\\\server\\share\\dir\\file.txt now'), 'see file.txt now');
  assert.doesNotMatch(scrubMessage('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCDEF'), /abcdefghijklmnop/);
  assert.equal(scrubMessage('status must be one of a, b'), 'status must be one of a, b');
  assert.equal(scrubMessage('see https://example.com/a/b'), 'see https://example.com/a/b');
});

test('I7 detail keeps only allow-listed scalar keys; a known reason gets a plain sentence', async () => {
  const { call, nx } = harness();
  nx.artifacts.get = () => { throw new PlatformError('conflict', 'moved', { currentVersionId: UNKNOWN_ID, liveJobs: 2, audited: true,
    projectId: 'p-ledger', stack: 'at x', openHandoffs: { a: 1 }, existingId: 'C:\\Users\\x\\y', limit: null }); };
  const r = await call('nexus:artifact:get', UNKNOWN_ID);
  assert.deepEqual(r.detail, { currentVersionId: UNKNOWN_ID, liveJobs: 2, existingId: 'y', limit: null });
  assert.equal(r.reason, undefined); assert.equal(r.message, 'moved');
  nx.artifacts.get = () => { throw new PlatformError('invalid', 'refused C:\\a\\b', { reason: 'path_refused' }); };
  const r2 = await call('nexus:artifact:get', UNKNOWN_ID);
  assert.deepEqual([r2.code, r2.reason], ['invalid', 'path_refused']);
  assert.equal(r2.message, REASON_MESSAGES.path_refused);
  assert.match(r2.message, /linked file that is also stored under other names/); assert.match(r2.message, /outside the project/); assert.match(r2.message, /package tools/);
  nx.artifacts.get = () => { throw new PlatformError('invalid', 'x', { reason: 'Bad Reason!' }); };
  assert.equal((await call('nexus:artifact:get', UNKNOWN_ID)).reason, undefined);
});

test('I8 list views carry no storage, content, rootPath or principal id', async () => {
  const { call, nx, me } = harness();
  nx.artifacts.saveUserVersion(me, textSave({ name: 'Notes' }, 'the secret recipe body'));
  nx.artifacts.saveUserVersion(me, commitSave({ name: 'Fix' }));
  for (const r of [await call('nexus:artifacts:list', {}), await call('nexus:artifacts:byProject', 'p-ledger')]) {
    const data = okData(r);
    assert.equal(data.length, 2); assert.equal(r.truncated, false);
    const text = JSON.stringify(data);
    assert.doesNotMatch(text, /storage|rootPath|root_path|C:\/work|recipe|json|createdBy|user:local|metadata|Fix the parser/);
  }
  const plist = JSON.stringify(okData(await call('nexus:participations:list')));
  assert.doesNotMatch(plist, /rootPath|createdBy|user:local/);
});

test('I9 version:get returns the text of a text file and only the commit of a git version', async () => {
  const { call, nx, me } = harness();
  const t = nx.artifacts.saveUserVersion(me, textSave({ name: 'Notes' }, 'line one\nline two\n'));
  const g = nx.artifacts.saveUserVersion(me, commitSave({ name: 'Fix' }));
  const tv = okData(await call('nexus:version:get', t.version.id));
  assert.deepEqual(tv.content, { type: 'text', path: 'docs/notes.md', text: 'line one\nline two\n' });
  assert.deepEqual([tv.id, tv.versionNo, tv.status, tv.storageKind, tv.producedByEngine], [t.version.id, 1, 'draft', 'inline', false]);
  const gv = okData(await call('nexus:version:get', g.version.id));
  assert.deepEqual(gv.content, { type: 'git', commit: SHA });
  assert.doesNotMatch(JSON.stringify(gv), /refs\/heads|src\/a\.ts|Fix the parser/);
  const ad = okData(await call('nexus:artifact:get', t.artifact.id));
  assert.deepEqual([ad.artifact.id, ad.versions.map((v) => v.id)], [t.artifact.id, [t.version.id]]);
  assert.doesNotMatch(JSON.stringify(ad), /line one|storage"|json/);
  const nf = await call('nexus:version:get', UNKNOWN_ID);
  assert.deepEqual([nf.ok, nf.code], [false, 'not_found']);
});

test('I10 activity:byProject reduces details to the allow-list and sends the actor kind only', async () => {
  const { call, nx, me } = harness();
  nx.artifacts.saveUserVersion(me, textSave({ name: 'Notes' }, 'hello'));
  const rows = okData(await call('nexus:activity:byProject', 'p-ledger'));
  assert.ok(rows.length >= 2);
  for (const r of rows) {
    for (const k of Object.keys(r.details)) assert.ok(ACTIVITY_DETAIL_KEYS.includes(k), k);
    assert.equal(r.actorKind, 'user'); assert.equal('actorId' in r, false); assert.equal('hash' in r, false);
  }
  const real = nx.activity.list.bind(nx.activity);
  nx.activity.list = (p, q) => real(p, q).map((e, i) => i === 0
    ? { ...e, details: { from: 'draft', backupFile: 'C:\\Users\\x\\backups\\h.db', backupSha256: 'ab', filter: ['projectId'],
      error: { code: 'x' }, notGranted: [UNKNOWN_ID], to: 'C:\\Users\\x\\y.txt', toVersionId: UNKNOWN_ID } } : e);
  const first = okData(await call('nexus:activity:byProject', 'p-ledger'))[0];
  assert.deepEqual(first.details, { from: 'draft', to: 'y.txt', toVersionId: UNKNOWN_ID });
  const nf = await call('nexus:activity:byProject', 'p-nope');
  assert.deepEqual([nf.ok, nf.code], [false, 'not_found']);
});

test('I11 list limits are validated and clamped; truncated reports more rows', async () => {
  const { call, nx, me } = harness();
  for (const k of ['a', 'b', 'c']) nx.artifacts.saveUserVersion(me, textSave({ name: k }, `text ${k}`));
  for (const bad of ['x', 1.5, 0, -3, 1e9, NaN, null, '10']) {
    const r = await call('nexus:artifacts:list', { limit: bad });
    assert.deepEqual([r.code, r.field], ['invalid', 'limit'], String(bad));
    const r2 = await call('nexus:activity:byProject', 'p-ledger', { limit: bad });
    assert.deepEqual([r2.code, r2.field], ['invalid', 'limit'], String(bad));
  }
  const two = await call('nexus:artifacts:list', { limit: 2 });
  assert.deepEqual([okData(two).length, two.truncated], [2, true]);
  const three = await call('nexus:artifacts:list', { limit: 3 });
  assert.deepEqual([okData(three).length, three.truncated], [3, false]);
  const seen = {};
  const spy = (svc, name) => { const real = svc[name].bind(svc); svc[name] = (p, f) => { seen[name] = f.limit; return real(p, f); }; };
  spy(nx.artifacts, 'listForReader'); spy(nx.handoffs, 'list'); spy(nx.activity, 'list');
  okData(await call('nexus:artifacts:list', { limit: 900 }));
  assert.equal(seen.listForReader, 501, 'artifacts: clamped to 500, plus one to detect more');
  okData(await call('nexus:handoffs:list', { limit: 900 })); // handoffs.list and activity.list share the name 'list'
  assert.equal(seen.list, 501, 'handoffs: clamped to 500, plus one');
  okData(await call('nexus:activity:byProject', 'p-ledger', { limit: 80 }));
  assert.equal(seen.list, 51, 'activity: clamped to 50, plus one');
  const page = await call('nexus:activity:byProject', 'p-ledger', { limit: 1 });
  assert.deepEqual([okData(page).length, page.truncated], [1, true]);
  for (const depth of [0, 7, 2.5, '3']) {
    const r = await call('nexus:lineage:get', UNKNOWN_ID, { direction: 'up', depth });
    assert.deepEqual([r.code, r.field], ['invalid', 'depth'], String(depth));
  }
  const dir = await call('nexus:lineage:get', UNKNOWN_ID, { direction: 'sideways' });
  assert.deepEqual([dir.code, dir.field], ['invalid', 'direction']);
});

test('I12 participations:list equals workspaces.listForReader', async () => {
  const { call, nx, me } = harness();
  nx.workspaces.attach(me, 'p-ledger', 'qa');
  const data = okData(await call('nexus:participations:list'));
  assert.deepEqual(data, nx.workspaces.listForReader(me).map(participationView));
  assert.ok(data.some((p) => p.projectId === 'p-ledger' && p.workspaceId === 'qa' && !p.isPrimary));
  const r = await call('nexus:participations:list', 'extra');
  assert.deepEqual([r.code, r.field], ['invalid', 'arguments']);
});

test('lineage and handoff reads return views', async () => {
  const { call, nx, me, db } = harness();
  const qa = nx.workspaces.attach(me, 'p-ledger', 'qa'); const sde = nx.workspaces.primaryOf(me, 'p-ledger');
  const a = nx.artifacts.saveUserVersion(me, textSave({ name: 'A' }, 'alpha'));
  const b = nx.artifacts.saveUserVersion(me, textSave({ name: 'B' }, 'beta'));
  const va = nx.artifacts.markReady(me, a.version.id); nx.artifacts.markReady(me, b.version.id);
  nx.lineage.linkSources(me, b.version.id, [a.version.id]);
  const up = okData(await call('nexus:lineage:get', b.version.id, { direction: 'up', depth: 1 }));
  assert.deepEqual(up.nodes.map((n) => [n.versionId, n.relation, n.depth]), [[a.version.id, 'derived_from', 1]]);
  assert.equal(up.truncated, false);
  const down = okData(await call('nexus:lineage:get', a.version.id, { direction: 'down' }));
  assert.deepEqual(down.nodes.map((n) => n.versionId), [b.version.id]);
  const { handoff } = nx.handoffs.send(me, { projectId: 'p-ledger', fromParticipationId: sde.id, toParticipationId: qa.id, versionIds: [va.id], title: 'Check' });
  const list = await call('nexus:handoffs:list', { box: 'inbox', workspaceId: 'qa' });
  assert.deepEqual(okData(list).map((x) => [x.id, x.status, x.subjectCount]), [[handoff.id, 'sent', 1]]);
  assert.equal(list.truncated, false);
  const d = okData(await call('nexus:handoff:get', handoff.id));
  assert.deepEqual(d.subjects.map((s) => [s.versionId, s.artifactName, s.versionNo]), [[va.id, 'A', 1]]);
  assert.doesNotMatch(JSON.stringify(d), /createdBy|respondedBy|user:local/);
  const nf = await call('nexus:handoff:get', UNKNOWN_ID);
  assert.deepEqual([nf.ok, nf.code], [false, 'not_found']);
  assert.equal(verifyActivityChain(db).ok, true);
});

test('validate: shapes, caps and the relPath rules', () => {
  const bad = (fn) => assert.throws(fn, (e) => e instanceof RequestError);
  assert.equal(V.platformId(UNKNOWN_ID, 'id'), UNKNOWN_ID);
  for (const x of [UNKNOWN_ID.toLowerCase(), `${UNKNOWN_ID}A`, 'I'.repeat(26), 42, null]) bad(() => V.platformId(x, 'id'));
  assert.equal(V.projectId('p-ledger'), 'p-ledger'); bad(() => V.projectId('a'.repeat(65))); bad(() => V.projectId('a/b'));
  assert.equal(V.workspaceId('sde'), 'sde'); bad(() => V.workspaceId('SDE')); bad(() => V.workspaceId('s'));
  assert.equal(V.commit(SHA), SHA); bad(() => V.commit(SHA.toUpperCase())); bad(() => V.commit('abc'));
  assert.equal(V.relPath('docs\\a.md'), 'docs/a.md');
  for (const x of ['', '/etc/passwd', 'C:\\x', 'c:x', '\\\\srv\\share', 'a/../b', '..', 'a\0b', 'x'.repeat(1025)]) bad(() => V.relPath(x));
  assert.equal(V.title('  Hi  ', 'title'), 'Hi'); bad(() => V.title('   ', 'title')); bad(() => V.title('a\nb', 'title')); bad(() => V.title('x'.repeat(201), 'title'));
  assert.equal(V.note(undefined), undefined); assert.equal(V.note(''), ''); bad(() => V.note('x'.repeat(2001))); bad(() => V.note('a\0'));
  assert.deepEqual(V.idList([UNKNOWN_ID], 'ids', 20), [UNKNOWN_ID]);
  bad(() => V.idList([], 'ids', 20)); bad(() => V.idList([UNKNOWN_ID, UNKNOWN_ID], 'ids', 20)); bad(() => V.idList(Array(21).fill(UNKNOWN_ID), 'ids', 20));
  assert.deepEqual({ ...V.object({ a: 1 }, ['a', 'b'], ['b']) }, { a: 1, b: undefined });
  bad(() => V.object({ b: 1 }, ['a', 'b'], ['b'])); bad(() => V.object(Object.create({ a: 1 }), ['a']));
  bad(() => V.object(new Date(), [])); bad(() => V.object({ [Symbol('s')]: 1 }, []));
  bad(() => V.object(JSON.parse('{"constructor":1}'), ['constructor']));
  assert.equal(V.int(5, 'n', 1, 10), 5); bad(() => V.int(11, 'n', 1, 10)); bad(() => V.int(Number.MAX_SAFE_INTEGER + 2, 'n', 1, Infinity));
  assert.equal(V.enumOf('up', 'd', ['up', 'down']), 'up'); bad(() => V.enumOf('UP', 'd', ['up', 'down']));
});

// ---------- Task 7: Task 6 review fixes ----------

test('platform_unavailable from a service gets a fixed message and a reason; no principal id leaks', async () => {
  const { call, nx } = harness();
  // A seeded principal missing (the real resolver path, with an id that is not seeded).
  nx.principals.localUser = () => nx.principals.seeded('user:missing-one');
  const r = await call('nexus:participations:list');
  assert.deepEqual([r.ok, r.code, r.reason], [false, 'platform_unavailable', 'startup_failed']);
  assert.doesNotMatch(JSON.stringify(r), /user:|seeded|missing/);
  assert.equal(r.message, "Some of Nexus's saved information is not available right now.");
  // Busy and locked codes (with sub-codes) are 'busy'; any other code is 'startup_failed'.
  const busy = (code) => fail(new PlatformError('platform_unavailable', 'the database is busy; try again user:local', { sqliteCode: code }), 'x', () => {});
  for (const c of ['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED', 'SQLITE_LOCKED_SHAREDCACHE']) {
    assert.deepEqual(busy(c), { ok: false, code: 'platform_unavailable', message: BUSY_MESSAGE, reason: 'busy' }, c);
  }
  for (const c of ['SQLITE_IOERR', 'SQLITE_BUSYX', undefined, 5]) assert.equal(busy(c).reason, 'startup_failed', String(c));
  // Handoffs off from the service itself keeps its reason and sub-reason.
  const ho = fail(new PlatformError('platform_unavailable', 'x', { reason: 'handoffs_unavailable', subReason: 'shape' }), 'x', () => {});
  assert.deepEqual([ho.code, ho.reason, ho.subReason], ['platform_unavailable', 'handoffs_unavailable', 'shape']);
});

test('a real write lock held by another connection answers busy on a write channel and writes nothing', async () => {
  const { call, db, s, nx, me } = harness();
  const file = db.name;
  db.pragma('busy_timeout = 50');                     // keep the wait short; the store default is 5 s
  const before = db.prepare('SELECT COUNT(*) n FROM project_workspaces').get().n;
  const seq = db.prepare('SELECT MAX(seq) s FROM activity').get().s;
  const other = h.openRaw(file); other.pragma('busy_timeout = 0');
  other.prepare('BEGIN IMMEDIATE').run();
  try {
    const r = await call('nexus:participation:attach', 'p-ledger', 'qa');
    assert.deepEqual(r, { ok: false, code: 'platform_unavailable', message: BUSY_MESSAGE, reason: 'busy' });
  } finally { other.prepare('ROLLBACK').run(); other.close(); }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM project_workspaces').get().n, before);
  assert.equal(db.prepare('SELECT MAX(seq) s FROM activity').get().s, seq);
  // Once the lock is gone the same request succeeds.
  const ok2 = okData(await call('nexus:participation:attach', 'p-ledger', 'qa'));
  assert.equal(ok2.workspaceId, 'qa');
  assert.equal(verifyActivityChain(db).ok, true);
  void s; void nx; void me;
});

test('artifacts:byProject reports truncated only when more than MAX_LIST_LIMIT rows exist', async () => {
  const { call, nx, me, db } = harness();
  const spy = []; const real = nx.artifacts.summariesByProject.bind(nx.artifacts);
  nx.artifacts.summariesByProject = (p, id, o) => { spy.push(o); return real(p, id, o); };
  const save = (k) => nx.artifacts.saveUserVersion(me, textSave({ name: `a${k}` }, `text ${k}`));
  db.transaction(() => { for (let k = 0; k < MAX_LIST_LIMIT - 1; k++) save(k); })();
  const under = await call('nexus:artifacts:byProject', 'p-ledger');
  assert.deepEqual([okData(under).length, under.truncated], [MAX_LIST_LIMIT - 1, false]);
  save('x');
  const exact = await call('nexus:artifacts:byProject', 'p-ledger');
  assert.deepEqual([okData(exact).length, exact.truncated], [MAX_LIST_LIMIT, false], 'exactly 1000 rows is not truncated');
  save('y');
  const over = await call('nexus:artifacts:byProject', 'p-ledger');
  assert.deepEqual([okData(over).length, over.truncated], [MAX_LIST_LIMIT, true]);
  assert.deepEqual(spy[0], { limit: MAX_LIST_LIMIT + 1 });
  // The service keeps its default and refuses a limit past MAX_LIST_LIMIT + 1.
  assert.equal(real(me, 'p-ledger').length, MAX_LIST_LIMIT);
  for (const bad of [0, MAX_LIST_LIMIT + 2, 1.5]) assert.throws(() => real(me, 'p-ledger', { limit: bad }), (e) => e.code === 'invalid');
});

test('V.object refuses getters and setters without running them', async () => {
  let ran = 0;
  const withGetter = { get projectId() { ran++; return 'p-ledger'; } };
  assert.throws(() => V.object(withGetter, ['projectId']), (e) => e instanceof RequestError && e.field === 'projectId');
  const withSetter = {}; Object.defineProperty(withSetter, 'projectId', { set() { ran++; }, enumerable: true });
  assert.throws(() => V.object(withSetter, ['projectId']), (e) => e instanceof RequestError);
  assert.equal(ran, 0, 'no accessor ran');
  const { call } = harness();
  const r = await call('nexus:artifacts:list', { get limit() { ran++; return 5; } });
  assert.deepEqual([r.ok, r.code, r.reason, r.field], [false, 'invalid', 'bad_request', 'limit']);
  const r2 = await call('nexus:artifact:saveTextFile', { projectId: 'p-ledger', workspaceId: 'sde', relPath: 'a.md', get target() { ran++; return { name: 'x' }; } });
  assert.deepEqual([r2.code, r2.field], ['invalid', 'target']);
  assert.equal(ran, 0);
  // A plain data property still reads normally.
  assert.deepEqual({ ...V.object({ projectId: 'p-ledger' }, ['projectId']) }, { projectId: 'p-ledger' });
});
