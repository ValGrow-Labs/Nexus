'use strict';
// B2a Task 13: the twenty execution channels #22-#41 through the one wrapper. Hostile arguments to every channel,
// availability at v8 (execution_unavailable with each sub-reason) while #22/#23 still answer, the startup registry
// check (an invalid registry is a state, never a throw) and B2A_IMPL against main's registered maps, busy, truncation,
// health (I-H1-H4: the gate's exact numbers; never waits on the runner), a hung runner (I-R1: every channel answers in
// 200 ms), and the nexus:hint push. Real SQLite (test:db); a fake runner; nothing launches Electron or touches userData.
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { execWorld, PROFILES, GIB } = require('./helpers/execWorld.cjs');
const { track } = require('./helpers/cleanup.cjs');
const { ipcOver, asLocalUser, noLeak, intent } = require('./helpers/ipcExec.cjs');
const { PersistStore } = loadTs('src/main/db.ts');
const { createNexusPlatform } = loadTs('src/main/nexus/platform.ts');
const { registerNexusIpc, NEXUS_CHANNELS, NEXUS_EXEC_CHANNELS, NEXUS_ALL_CHANNELS, sendNexusHint, NEXUS_HINT_CHANNEL } =
  loadTs('src/main/nexusIpc/registerNexusIpc.ts');
const { BUSY_MESSAGE, EXECUTION_SUB_REASONS } = loadTs('src/main/nexusIpc/envelope.ts');
const { startExecution, hintCoalescer, HINT_MIN_INTERVAL_MS, execIpcPort } = loadTs('src/main/nexusExec/execWiring.ts');
const { B2A_IMPL, B2B_IMPL, B2B_PENDING, checkRegistry } = loadTs('src/shared/nexus/registryCheck.ts');
const { DOMAINS } = loadTs('src/shared/nexus/domains/index.ts');
const { mainImplementation, implementationProblems, registryProblems } = loadTs('src/main/nexus/registryImpl.ts');
const { REQUIRED_FREE_BYTES, RECOMMENDED_FREE_BYTES } = loadTs('src/shared/nexus/resourceGate.ts');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const UNKNOWN = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const GATED = NEXUS_EXEC_CHANNELS.filter((c) => c !== 'nexus:domains:list' && c !== 'nexus:platform:health');
const REQ = { title: 'Ledger export', body: 'Export the ledger as CSV.', criteria: [{ id: 'AC1', text: 'A CSV file downloads' }] };

/** A v8 platform (no execution tables): the B1 harness shape. */
function v8Platform() {
  const { file } = h.v6Fixture(); const s = track(new PersistStore(file));
  s.open({ log: () => {}, backupDir: path.join(path.dirname(file), 'b'), now: () => h.NOW });
  const nx = createNexusPlatform(s.platformDatabase(), { now: () => h.NOW });
  return { s, db: s.platformDatabase(), nx };
}

/** Valid-shaped arguments for every channel (the answers may be refusals; the shapes pass validation). */
function validArgs(w, ids = {}) {
  return {
    'nexus:participations:list': [], 'nexus:participation:attach': ['p-ledger', 'qa'], 'nexus:participation:withdraw': [UNKNOWN],
    'nexus:artifacts:list': [{}], 'nexus:artifacts:byProject': ['p-ledger'], 'nexus:artifact:get': [UNKNOWN], 'nexus:version:get': [w.repoV],
    'nexus:lineage:get': [w.repoV, { direction: 'up' }],
    'nexus:artifact:saveCommit': [{ projectId: 'p-ledger', workspaceId: 'sde', commit: 'a'.repeat(40), target: { name: 'C' } }],
    'nexus:artifact:saveTextFile': [{ projectId: 'p-ledger', workspaceId: 'sde', relPath: 'README.md', target: { name: 'T' } }],
    'nexus:version:markReady': [UNKNOWN], 'nexus:version:promote': [UNKNOWN, null], 'nexus:version:discard': [UNKNOWN],
    'nexus:version:linkSources': [UNKNOWN, [w.repoV]], 'nexus:handoffs:list': [{}], 'nexus:handoff:get': [UNKNOWN],
    'nexus:handoff:send': [{ projectId: 'p-ledger', fromParticipationId: UNKNOWN, toParticipationId: UNKNOWN, versionIds: [w.repoV], title: 't' }],
    'nexus:handoff:accept': [UNKNOWN], 'nexus:handoff:decline': [UNKNOWN], 'nexus:handoff:withdraw': [UNKNOWN], 'nexus:activity:byProject': ['p-ledger'],
    'nexus:domains:list': [], 'nexus:platform:health': [],
    'nexus:actions:available': [{ projectId: 'p-ledger', workspaceId: 'sde' }],
    'nexus:job:start': [{ projectId: 'p-ledger', workspaceId: 'sde', actionId: 'sde.tests.discover', inputs: [{ versionId: w.repoV, slot: 'repository' }],
      params: {}, intentId: intent() }],
    'nexus:jobs:list': [{ projectId: 'p-ledger' }], 'nexus:job:get': [ids.job ?? UNKNOWN],
    'nexus:job:logs': [ids.job ?? UNKNOWN, { attempt: 1, fromOffset: 0, maxBytes: 4096 }], 'nexus:job:cancel': [ids.job ?? UNKNOWN],
    'nexus:job:retry': [ids.job ?? UNKNOWN, intent()], 'nexus:events:since': [{ sinceSeq: 0 }],
    'nexus:version:validations': [w.repoV], 'nexus:version:revalidate': [w.repoV, intent()],
    'nexus:version:preview': [w.repoV, { part: 'content', maxBytes: 4096 }],
    'nexus:artifact:saveInline': [{ projectId: 'p-ledger', workspaceId: 'sde', kind: 'requirement', target: { name: 'R' }, content: REQ }],
    'nexus:deployments:list': [{}], 'nexus:deployment:stop': [UNKNOWN], 'nexus:approvals:list': [{}],
    'nexus:approval:respond': [UNKNOWN, 'once'], 'nexus:setup:prepareImage': ['sde-node', intent()], 'nexus:blobs:gc': [{ apply: false }]
  };
}

// ---------- registration ----------

test('I-E1 the twenty execution channels are frozen, distinct, and registered through the one wrapper only with main\'s execution deps (41); B1\'s 21 without', () => {
  assert.equal(NEXUS_EXEC_CHANNELS.length, 20); assert.equal(new Set(NEXUS_EXEC_CHANNELS).size, 20); assert.ok(Object.isFrozen(NEXUS_EXEC_CHANNELS));
  assert.deepEqual([...NEXUS_ALL_CHANNELS], [...NEXUS_CHANNELS, ...NEXUS_EXEC_CHANNELS]); assert.ok(Object.isFrozen(NEXUS_ALL_CHANNELS));
  for (const c of NEXUS_EXEC_CHANNELS) assert.ok(!NEXUS_CHANNELS.includes(c), c);
  const reg = (deps) => { const got = []; registerNexusIpc({ handle: (c) => got.push(c) }, { platform: () => null, unavailableReason: () => 'held',
    sources: {}, log: () => {}, ...deps }); return got; };
  assert.deepEqual(reg({}).sort(), [...NEXUS_CHANNELS].sort());
  assert.deepEqual(reg({ executionUnavailableReason: () => null }).sort(), [...NEXUS_ALL_CHANNELS].sort());
  assert.deepEqual(reg({ exec: () => null }).sort(), [...NEXUS_ALL_CHANNELS].sort());
  assert.equal(NEXUS_HINT_CHANNEL, 'nexus:hint');
});

test('I-E2 with no platform every one of the 41 channels answers platform_unavailable with the store\'s reason', async () => {
  const w = { nx: null, dataHome: null, repoV: UNKNOWN };
  const x = ipcOver(w, { platform: () => null });
  assert.equal(x.handlers.size, 41);
  const args = validArgs(w);
  for (const ch of NEXUS_ALL_CHANNELS) {
    const r = await x.call(ch, ...args[ch]);
    assert.deepEqual([r.ok, r.code, r.reason], [false, 'platform_unavailable', 'held'], ch);
  }
});

// ---------- availability ----------

test('I-E3 at v8 every gated channel answers execution_unavailable with each sub-reason; #22 and #23 still answer; B1 channels are untouched', async () => {
  const p = v8Platform();
  let reason = null;
  const w = { nx: p.nx, dataHome: null, repoV: UNKNOWN };
  const x = ipcOver(w, { executionUnavailableReason: () => reason });
  const args = validArgs(w);
  for (const sub of ['held', 'auto_held', 'backup_failed', 'failed', 'shape']) {
    reason = sub;
    for (const ch of GATED) {
      const r = await x.call(ch, ...args[ch]);
      assert.deepEqual([r.ok, r.code, r.reason, r.subReason], [false, 'platform_unavailable', 'execution_unavailable', sub], `${ch} ${sub}`);
      assert.equal(r.message, 'Running work is not available on this database.');
    }
    const domains = await x.ok('nexus:domains:list');
    assert.equal(domains.length, DOMAINS.length);
    const health = await x.ok('nexus:platform:health');
    assert.deepEqual([health.db.execution, health.db.subReason, health.db.handoffs], [false, sub, true]);
    assert.equal(health.db.version, 8);
  }
  // main says nothing: the platform's own reason (execution was never turned on at v8).
  reason = null;
  const r = await x.call('nexus:jobs:list', {});
  assert.deepEqual([r.reason, r.subReason], ['execution_unavailable', 'not_enabled']);
  // B1's channels answer as before.
  assert.equal((await x.call('nexus:participations:list')).ok, true);
  assert.equal((await x.call('nexus:activity:byProject', 'p-ledger')).ok, true);
  // An unknown sub-reason is never echoed.
  reason = 'C:\\Users\\x';
  assert.equal((await x.call('nexus:jobs:list', {})).subReason, 'not_enabled');
  assert.deepEqual([...EXECUTION_SUB_REASONS].sort(), ['auto_held', 'backup_failed', 'failed', 'held', 'not_enabled', 'not_started', 'registry_invalid', 'shape', 'v8_unavailable']);
});

test('I-E4 an invalid registry at startup is a state: execution stays off (registry_invalid), the channels say so, health shows it, nothing throws', async () => {
  const w = execWorld();
  const logs = [];
  const nx = createNexusPlatform(w.db, { now: () => w.now(), log: (l) => logs.push(l), execution: true, dataHome: w.dataHome, profiles: PROFILES,
    acceptFsRoot: (r) => r, approvals: null, registryProblems: () => ['sde/tests: REAL step has no end-to-end test'] });
  assert.equal(nx.executionAvailable, false);
  assert.equal(nx.exec.unavailableReason, 'registry_invalid');
  assert.deepEqual(nx.registry, { valid: false, problems: 1 });
  assert.ok(logs.some((l) => /domain registry check failed: 1 problem/.test(l)), logs.join('\n'));
  assert.doesNotThrow(() => nx.startup());
  const x = ipcOver({ nx, dataHome: w.dataHome, repoV: w.repoV });
  const args = validArgs(w);
  for (const ch of GATED) {
    const r = await x.call(ch, ...args[ch]);
    assert.deepEqual([r.code, r.reason, r.subReason], ['platform_unavailable', 'execution_unavailable', 'registry_invalid'], ch);
  }
  const health = await x.ok('nexus:platform:health');
  assert.deepEqual(health.registry, { valid: false, problems: 1 });
  assert.deepEqual([health.db.execution, health.db.subReason], [false, 'registry_invalid']);
  // A registry check that throws is a problem too (never a crash).
  const nx2 = createNexusPlatform(w.db, { now: () => w.now(), execution: true, dataHome: w.dataHome, profiles: PROFILES, approvals: null,
    registryProblems: () => { throw new Error('boom'); } });
  assert.equal(nx2.exec.unavailableReason, 'registry_invalid');
  // The real registry is sound and main agrees with it: execution is on.
  assert.deepEqual(registryProblems(), []);
  assert.equal(w.nx.executionAvailable, true); assert.deepEqual(w.nx.registry, { valid: true, problems: 0 });
  w.close();
});

test('I-E5 B2A_IMPL equals main\'s registered recipe, validator and ingest maps exactly (and a drift on either side is a startup problem)', () => {
  const m = mainImplementation();
  const sorted = (xs) => [...xs].sort();
  // B2b Task 1 (the registry flip): main checks the registry against B2B_IMPL; the B2b ids its later tasks land
  // (B2B_PENDING) are left out of the comparison. Task 7 landed the six git engine recipes and emptied
  // B2B_PENDING.recipes (it can only shrink); Task 8 lands all six change-set validators (the register validators,
  // cs.tests_pass and git.applies_cleanly's own candidate check), emptying B2B_PENDING.validators too, so both now
  // equal B2B_IMPL in full.
  assert.deepEqual(sorted(B2B_IMPL.recipes.filter((r) => !B2B_PENDING.recipes.includes(r))), sorted(B2B_IMPL.recipes), 'no recipe is still pending');
  assert.deepEqual(sorted(B2B_IMPL.validators.filter((v) => !B2B_PENDING.validators.includes(v))), sorted(B2B_IMPL.validators), 'no validator is still pending');
  assert.deepEqual(sorted(m.recipes), sorted(B2B_IMPL.recipes), 'recipes main can plan');
  assert.deepEqual(sorted(m.validators), sorted(B2B_IMPL.validators), 'validators main runs');
  assert.deepEqual(sorted([...m.ingest, ...m.notIngested]), sorted(B2B_IMPL.recipes), 'every recipe is ingested or named as never ingested');
  assert.deepEqual(m.ingest.filter((x) => m.notIngested.includes(x)), [], 'never both');
  // Fix round 1 (the ruled defect): a dependency install has its own evidence rule; only the dev deployment is never
  // ingested at B2a. Task 8 lands changeset.collect's and changeset.merge_check's ingest; Task 9 lands changeset.accept's
  // and repo.ff's, so only the dev deployment is left never ingested (the ratchet only shrinks).
  assert.deepEqual(sorted(m.notIngested), sorted(['sde.preview.start']));
  assert.ok(m.ingest.includes('sde.deps.node') && m.ingest.includes('sde.deps.python'));
  assert.ok(m.validators.includes('sde.deps.lock_matches'));
  assert.deepEqual(implementationProblems(), []);
  assert.deepEqual(checkRegistry(DOMAINS, B2B_IMPL), []);
  // The pending list hides exactly the B2b ids, and only while main has none of them (it can only shrink).
  const unpended = implementationProblems(B2B_IMPL, { recipes: [], validators: [] });
  assert.deepEqual(sorted(unpended), sorted([...B2B_PENDING.recipes.map((r) => `recipe: ${r} is declared implemented but main has none`),
    ...B2B_PENDING.validators.map((v) => `validator: ${v} is declared implemented but main has none`),
    ...B2B_PENDING.recipes.map((r) => `ingest: ${r} is declared implemented but main has none`)]));
  assert.ok(implementationProblems(B2B_IMPL, { recipes: [...B2B_PENDING.recipes, 'sde.diagnose'], validators: B2B_PENDING.validators })
    .some((p) => /recipe: sde\.diagnose is implemented but still listed as pending/.test(p)));
  assert.ok(implementationProblems(B2B_IMPL, { recipes: B2B_PENDING.recipes, validators: [...B2B_PENDING.validators, 'req.schema'] })
    .some((p) => /validator: req\.schema is implemented but still listed as pending/.test(p)));
  // Drift either way is found.
  assert.ok(implementationProblems({ ...B2A_IMPL, recipes: B2A_IMPL.recipes.filter((r) => r !== 'sde.diagnose') })
    .some((p) => /main has sde\.diagnose but the registry does not declare it/.test(p)));
  assert.ok(implementationProblems({ ...B2A_IMPL, validators: [...B2A_IMPL.validators, 'sde.lint'] })
    .some((p) => /validator: sde\.lint is declared implemented but main has none/.test(p)));
  assert.ok(implementationProblems({ ...B2A_IMPL, recipes: [...B2A_IMPL.recipes, 'sde.deploy.prod'] }).some((p) => /recipe: sde\.deploy\.prod/.test(p)));
});

test('I-E5b the dispatched validators are derived from the dispatch tables the code dispatches through, never a hand-kept list', () => {
  const { DISPATCHED_VALIDATORS } = loadTs('src/main/nexus/registryImpl.ts');
  const { INGEST_RECORDED_VALIDATORS } = loadTs('src/main/nexus/exec/ingest.ts');
  const { RUNNER_VALIDATORS } = loadTs('src/main/nexus/validation/checkRunner.ts');
  const { DEPLOYMENT_VALIDATORS } = loadTs('src/main/nexus/deployments/deploymentService.ts');
  const { VALIDATORS } = loadTs('src/shared/nexus/validators.ts');
  assert.deepEqual([...DISPATCHED_VALIDATORS].sort(), [...Object.keys(INGEST_RECORDED_VALIDATORS), ...RUNNER_VALIDATORS, ...DEPLOYMENT_VALIDATORS].sort());
  assert.deepEqual([...DISPATCHED_VALIDATORS].sort(), ['app.preview_health', 'blob.integrity', 'cs.tests_pass', 'git.applies_cleanly', 'sde.tests_pass']);
  // Each table names exactly the validators of its executor in the registry.
  const by = (ex) => VALIDATORS.filter((v) => v.executes === ex).map((v) => v.id).sort();
  assert.deepEqual([...RUNNER_VALIDATORS].sort(), by('runner'));
  assert.deepEqual([...DEPLOYMENT_VALIDATORS].sort(), by('deployment'));
  // B2b Task 8 lands both change-set child-job validators (cs.tests_pass, git.applies_cleanly): none is pending.
  assert.deepEqual(Object.keys(INGEST_RECORDED_VALIDATORS).sort(), by('child-job').filter((id) => !B2B_PENDING.validators.includes(id)));
  assert.deepEqual(by('child-job').filter((id) => B2B_PENDING.validators.includes(id)), []);
  // registryImpl holds no validator id of its own; the dispatch code reads the tables it exports.
  const impl = read('src/main/nexus/registryImpl.ts');
  for (const v of VALIDATORS) assert.ok(!impl.includes(`'${v.id}'`), `registryImpl names ${v.id}`);
  assert.match(impl, /\.\.\.Object\.keys\(INGEST_RECORDED_VALIDATORS\), \.\.\.RUNNER_VALIDATORS, \.\.\.DEPLOYMENT_VALIDATORS/);
  assert.match(read('src/main/nexus/validation/checkRunner.ts'), /if \(def\.executes === 'runner' && RUNNER_VALIDATORS\.includes\(def\.id\)\) \{ this\.verifyStep/);
  assert.match(read('src/main/nexus/deployments/deploymentService.ts'), /recordOutcomeTx\(d\.subject_version_id, DEPLOYMENT_VALIDATORS\[0\], outcome/);
  assert.match(read('src/main/nexus/exec/ingest.ts'), /recordOutcomeTx\(suite\.id, TEST_RUN_RECORDS, recorded/);
  // A drift in a dispatch table is a startup problem (a validator the registry declares that main no longer dispatches).
  assert.ok(implementationProblems({ ...B2A_IMPL, validators: B2A_IMPL.validators.filter((v) => v !== 'blob.integrity') })
    .some((p) => /main has blob\.integrity but the registry does not declare it/.test(p)));
});

// ---------- hostile arguments ----------

test('I-E6 hostile arguments to every execution channel never throw, never leak, never write; each named case answers bad_request or bad_params', async () => {
  const w = execWorld();
  const x = ipcOver(w);
  const counts = () => ['jobs', 'job_attempts', 'approvals', 'deployments', 'artifacts', 'artifact_versions', 'validations', 'image_builds', 'activity']
    .map((t) => w.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n);
  const before = counts();
  const getter = {}; Object.defineProperty(getter, 'projectId', { enumerable: true, get() { throw new Error('ran a getter'); } });
  const sym = { [Symbol('x')]: 1 };
  const hostile = [null, 42, '', 'x'.repeat(5000), '../../etc/passwd', 'C:\\Windows\\system32', '\\\\server\\share', JSON.parse('{"__proto__":{"a":1}}'),
    { extra: 1 }, ['a'], getter, sym, NaN, Infinity, { limit: -1 }, 'not-a-ulid', `${UNKNOWN}x`, new Date(0), () => 1, Array(70).fill(UNKNOWN)];
  for (const ch of NEXUS_EXEC_CHANNELS) for (const a of hostile) {
    const r = await x.call(ch, a, a);
    assert.equal(typeof r, 'object', ch);
    assert.equal(r.ok, false, `${ch} accepted ${String(a).slice(0, 40)}: ${JSON.stringify(r).slice(0, 200)}`);
    assert.deepEqual([r.code, r.reason], ['invalid', 'bad_request'], `${ch}: ${JSON.stringify(r)}`);
    noLeak(r, ch);
  }
  // Fix round 1: the hostile value reaches the validator itself (`(a)` for a one-argument channel, `(valid, a)` for a
  // two-argument one), never just the arity check; plus exotic values: Proxies whose traps throw, element getters.
  // (A Proxy's trap runs whenever the value is read at all; what matters is the answer. An element GETTER never runs.)
  let getterRan = 0;
  const trap = () => { throw new Error('a trap ran into C:\\Users\\x'); };
  const proxyObj = new Proxy({}, { getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, get: trap, has: trap });
  const proxyArr = new Proxy([UNKNOWN], { getOwnPropertyDescriptor: trap, get: trap, ownKeys: trap });
  const getterArr = [UNKNOWN]; Object.defineProperty(getterArr, 0, { enumerable: true, get() { getterRan++; return UNKNOWN; } });
  const holeArr = []; holeArr.length = 2;
  const exotic = [proxyObj, proxyArr, getterArr, holeArr];
  const twoArg = { 'nexus:job:logs': UNKNOWN, 'nexus:job:retry': UNKNOWN, 'nexus:version:revalidate': UNKNOWN, 'nexus:version:preview': w.repoV,
    'nexus:approval:respond': UNKNOWN, 'nexus:setup:prepareImage': 'sde-node' };
  for (const ch of NEXUS_EXEC_CHANNELS) for (const a of [...hostile, ...exotic]) {
    const r = Object.prototype.hasOwnProperty.call(twoArg, ch) ? await x.call(ch, twoArg[ch], a) : await x.call(ch, a);
    assert.equal(r.ok, false, `${ch} accepted a hostile value: ${JSON.stringify(r).slice(0, 200)}`);
    assert.deepEqual([r.code, r.reason], ['invalid', 'bad_request'], `${ch}: ${JSON.stringify(r)}`);
    if (!['nexus:domains:list', 'nexus:platform:health'].includes(ch)) assert.notEqual(r.field, 'arguments', `${ch}: the validator saw the value`);
    noLeak(r, ch);
  }
  // Exotic values nested where a validator reads them: still bad_request with the field named, never internal.
  const startOf = (patch) => ({ projectId: 'p-ledger', workspaceId: 'sde', actionId: 'sde.tests.discover', inputs: [{ versionId: w.repoV, slot: 'repository' }],
    params: {}, intentId: intent(), ...patch });
  for (const [ch, args, field] of [
    ['nexus:job:start', [proxyObj], 'request'], ['nexus:job:start', [startOf({ params: proxyObj })], 'params'],
    ['nexus:job:start', [startOf({ inputs: proxyArr })], 'inputs'], ['nexus:job:start', [startOf({ inputs: getterArr })], 'inputs'],
    ['nexus:job:start', [startOf({ inputs: holeArr })], 'inputs'], ['nexus:job:start', [startOf({ inputs: [proxyObj] })], 'request'],
    ['nexus:jobs:list', [{ states: getterArr }], 'states'], ['nexus:jobs:list', [{ states: proxyArr }], 'states'], ['nexus:jobs:list', [proxyObj], 'request'],
    ['nexus:artifact:saveInline', [{ projectId: 'p-ledger', workspaceId: 'sde', kind: 'requirement', target: { name: 'R' }, content: proxyObj }], 'content'],
    ['nexus:version:linkSources', [w.repoV, getterArr], 'sourceVersionIds'], ['nexus:version:linkSources', [w.repoV, proxyArr], 'sourceVersionIds']
  ]) {
    const r = await x.call(ch, ...args);
    assert.deepEqual([r.ok, r.code, r.reason, r.field], [false, 'invalid', 'bad_request', field], `${ch} ${field}: ${JSON.stringify(r)}`);
    noLeak(r, ch);
  }
  assert.equal(getterRan, 0, 'an array element getter is refused, never run');
  assert.deepEqual(counts(), before, 'no hostile call wrote a row');
  assert.deepEqual(x.sources.calls, [], 'no B2a channel touches the B1 file or git ports');
  const start = (patch) => ({ projectId: 'p-ledger', workspaceId: 'sde', actionId: 'sde.tests.discover', inputs: [{ versionId: w.repoV, slot: 'repository' }],
    params: {}, intentId: intent(), ...patch });
  const bad = async (ch, args, field, reason = 'bad_request') => x.refused(ch, args, 'invalid', { reason, field });
  // 'always' is not an answer; there is no third decision.
  await bad('nexus:approval:respond', [UNKNOWN, 'always'], 'decision');
  await bad('nexus:approval:respond', [UNKNOWN, 'ONCE'], 'decision');
  // `role` instead of `slot`: an unknown key, named back.
  await bad('nexus:job:start', [start({ inputs: [{ versionId: w.repoV, role: 'repository' }] })], 'role');
  await bad('nexus:job:start', [start({ inputs: [{ versionId: w.repoV }] })], 'slot');
  await bad('nexus:job:start', [start({ inputs: Array(65).fill(0).map(() => ({ versionId: w.repoV, slot: 'repository' })) })], 'inputs');
  await bad('nexus:job:start', [start({ inputs: [{ versionId: w.repoV, slot: 'repository' }, { versionId: w.repoV, slot: 'repository' }] })], 'inputs');
  await bad('nexus:job:start', [start({ intentId: 'intent-1' })], 'intentId');
  await bad('nexus:job:start', [start({ intentId: UNKNOWN.toLowerCase() })], 'intentId');
  await bad('nexus:job:start', [start({ actionId: 'Sde.Tests' })], 'actionId');
  await bad('nexus:job:start', [{ ...start(), extra: 1 }], 'extra');
  await bad('nexus:job:start', [{ ...start(), principal: 'system' }], 'principal');
  await bad('nexus:job:start', [start({ params: getter })], 'params');
  await bad('nexus:job:start', [start({ params: { a: { b: 1 } } })], 'params');
  await bad('nexus:job:start', [start({ params: Object.fromEntries(Array(40).fill(0).map((_, i) => [`k${i}`, 1])) })], 'params');
  // An execution setting is never a parameter (bad_request); an unknown or ill-shaped parameter is bad_params.
  for (const k of ['network', 'ports', 'image', 'argv', 'env', 'command', 'mounts', 'privileged', 'user', 'token']) {
    await bad('nexus:job:start', [start({ params: { [k]: 'x' } })], 'params');
  }
  await bad('nexus:job:start', [start({ params: { verbose: true } })], 'params', 'bad_params');
  await bad('nexus:job:start', [start({ actionId: 'sde.diagnose', inputs: [], params: { target: 'job' } })], 'params', 'bad_params');
  // Oversize strings and arrays.
  await bad('nexus:jobs:list', [{ states: Array(12).fill('queued') }], 'states');
  await bad('nexus:jobs:list', [{ states: ['queued', 'queued'] }], 'states');
  await bad('nexus:jobs:list', [{ jobKind: 'shell' }], 'jobKind');
  await bad('nexus:jobs:list', [{ kind: 'tool.run' }], 'kind');
  await bad('nexus:job:logs', [UNKNOWN, { attempt: 1, fromOffset: 0, maxBytes: 262145 }], 'maxBytes');
  await bad('nexus:job:logs', [UNKNOWN, { attempt: 0, fromOffset: 0, maxBytes: 1 }], 'attempt');
  await bad('nexus:version:preview', [w.repoV, { part: 'content', maxBytes: 262145 }], 'maxBytes');
  await bad('nexus:version:preview', [w.repoV, { part: 'raw', maxBytes: 1 }], 'part');
  await bad('nexus:artifact:saveInline', [{ projectId: 'p-ledger', workspaceId: 'sde', kind: 'build', target: { name: 'R' }, content: REQ }], 'kind');
  await bad('nexus:artifact:saveInline', [{ projectId: 'p-ledger', workspaceId: 'sde', kind: 'requirement', target: { name: 'R' }, content: { body: 'x'.repeat(40000) } }], 'content');
  const deep = {}; let cur = deep; for (let i = 0; i < 12; i++) { cur.a = {}; cur = cur.a; }
  await bad('nexus:artifact:saveInline', [{ projectId: 'p-ledger', workspaceId: 'sde', kind: 'requirement', target: { name: 'R' }, content: deep }], 'content');
  await bad('nexus:setup:prepareImage', ['sde-ruby', intent()], 'profileId');
  await bad('nexus:blobs:gc', [{ apply: true }], 'expectedCandidatesHash');
  await bad('nexus:blobs:gc', [{ apply: true, expectedCandidatesHash: 'A'.repeat(64) }], 'expectedCandidatesHash');
  await bad('nexus:blobs:gc', [{ apply: 'yes' }], 'apply');
  await bad('nexus:blobs:gc', [{ apply: false, expectedCandidatesHash: 'a'.repeat(64) }], 'expectedCandidatesHash');
  await bad('nexus:events:since', [{ sinceSeq: -1 }], 'sinceSeq');
  await bad('nexus:actions:available', [{ projectId: 'p-ledger', workspaceId: 'sde', versionId: 'v-1' }], 'versionId');
  assert.deepEqual(counts(), before, 'no named refusal wrote a row');
  w.close();
});

// ---------- B2a Task 13 fix round 1 ----------

const denials = (w) => w.db.prepare("SELECT COUNT(*) n FROM activity WHERE status = 'denied'").get().n;
/** The system, an agent and a disabled user: none of them is a stored, enabled user. */
function notUsers(w) {
  w.db.prepare('INSERT INTO principals VALUES (?,?,?,NULL,?)').run('agent:x', 'agent', 'agent x', h.NOW);
  const off = w.addUser('u-off', 'project', 'p-ledger', 'owner');
  w.db.prepare('UPDATE principals SET disabled_at = ? WHERE id = ?').run(h.NOW, off.id);
  return [w.sys, { id: 'agent:x', kind: 'agent', displayName: 'agent x' }, off];
}

test('I-E9 #22 answers only a stored, enabled user: the system, an agent and a disabled user are denied (user_only), one audit row each', async () => {
  const w = execWorld(); const x = ipcOver(w);
  assert.equal((await x.ok('nexus:domains:list')).length, DOMAINS.length);
  for (const p of notUsers(w)) {
    const restore = asLocalUser(w.nx, p);
    const d0 = denials(w);
    await x.refused('nexus:domains:list', [], 'denied', { reason: 'user_only' });
    assert.equal(denials(w) - d0, 1, p.id);
    restore();
  }
  w.close();
});

test('I-E11 #35 saveInline: the system, an agent and a disabled user are denied (user_only, audited), never a bare invalid; nothing is saved', async () => {
  const w = execWorld(); const x = ipcOver(w);
  const args = { projectId: 'p-ledger', workspaceId: 'sde', kind: 'requirement', target: { name: 'R' }, content: REQ };
  const reqs = () => w.db.prepare("SELECT COUNT(*) n FROM artifacts WHERE kind = 'requirement'").get().n;
  for (const p of notUsers(w)) {
    const restore = asLocalUser(w.nx, p);
    const d0 = denials(w);
    await x.refused('nexus:artifact:saveInline', [args], 'denied', { reason: 'user_only' });
    assert.equal(denials(w) - d0, 1, p.id);
    restore();
    assert.throws(() => w.nx.artifacts.saveInline(p, args), (e) => e.code === 'denied' && e.detail.reason === 'user_only', p.id);
  }
  assert.equal(reqs(), 0);
  assert.equal((await x.ok('nexus:artifact:saveInline', args)).created, true);
  w.close();
});

test('I-E10 #33 passes its intent through: the same intent re-sent returns the same checks and queues nothing, even after they ended', async () => {
  const w = execWorld({ realIngest: true }); const x = ipcOver(w);
  const b = await w.runBuild({ files: ['app.js'] });
  const runner = w.attach();
  runner.report({ op: 'fault', message: 'the docker daemon went away' });
  await w.settle();
  assert.equal(w.version(b.buildVersionId).status, 'draft');
  const validateJobs = () => w.db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind = 'validate'").get().n;
  const i = intent();
  const first = await x.ok('nexus:version:revalidate', b.buildVersionId, i);
  assert.ok(first.jobs.length > 0);
  const n1 = validateJobs();
  const again = await x.ok('nexus:version:revalidate', b.buildVersionId, i);
  assert.deepEqual(again.jobs.map((j) => j.id), first.jobs.map((j) => j.id)); assert.equal(validateJobs(), n1);
  // The checks end and the version leaves draft: the same intent still answers the same jobs, nothing new is queued.
  w.answerVerifies(runner, true); await w.settle();
  assert.equal(w.version(b.buildVersionId).status, 'candidate');
  const late = await x.ok('nexus:version:revalidate', b.buildVersionId, i);
  assert.deepEqual(late.jobs.map((j) => j.id), first.jobs.map((j) => j.id)); assert.equal(validateJobs(), n1);
  // A new intent is a new request (refused: the version is no longer a draft). The answer was recorded once, with its intent.
  await x.refused('nexus:version:revalidate', [b.buildVersionId, intent()], 'illegal_transition');
  const act = w.db.prepare("SELECT details_json FROM activity WHERE action = 'version.revalidate' AND status = 'succeeded'").all();
  assert.equal(act.length, 1);
  assert.deepEqual(JSON.parse(act[0].details_json), { intent: i, jobs: first.jobs.map((j) => j.id) });
  w.close();
});

test('I-E10b #33 an intent is one request for one version: re-sent for another version it is refused (intent_mismatch), never answered with the first version\'s jobs', async () => {
  const w = execWorld({ realIngest: true }); const x = ipcOver(w);
  const b = await w.runBuild({ files: ['app.js'] });
  const runner = w.attach();
  runner.report({ op: 'fault', message: 'the docker daemon went away' });
  await w.settle();
  assert.equal(w.version(b.buildVersionId).status, 'draft');
  const validateJobs = () => w.db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind = 'validate'").get().n;
  const answers = () => w.db.prepare("SELECT COUNT(*) n FROM activity WHERE action = 'version.revalidate'").get().n;
  const i = intent();
  const first = await x.ok('nexus:version:revalidate', b.buildVersionId, i);
  assert.ok(first.jobs.length > 0);
  const [n1, a1] = [validateJobs(), answers()];
  // The same intent for another version (the repository version; the lookup comes before the draft check).
  const r = await x.refused('nexus:version:revalidate', [w.repoV, i], 'invalid', { reason: 'intent_mismatch' });
  assert.doesNotMatch(JSON.stringify(r), new RegExp(first.jobs[0].id), 'the other version\'s jobs are never answered');
  assert.deepEqual([validateJobs(), answers()], [n1, a1], 'nothing queued, nothing recorded');
  // The service directly: the same refusal.
  assert.throws(() => w.nx.validation.revalidate(w.me, w.repoV, i), (e) => e.code === 'invalid' && e.detail?.reason === 'intent_mismatch');
  // The intent for its own version still answers its jobs.
  const again = await x.ok('nexus:version:revalidate', b.buildVersionId, i);
  assert.deepEqual(again.jobs.map((j) => j.id), first.jobs.map((j) => j.id));
  w.close();
});

test('I-H5 #23 health never echoes a raw sub-reason: an unknown one reads not_enabled, a known one is kept', async () => {
  const p = v8Platform();
  let reason = 'C:\\Users\\x\\<b>held</b>';
  const x = ipcOver({ nx: p.nx, dataHome: null, repoV: UNKNOWN }, { executionUnavailableReason: () => reason });
  const v = await x.ok('nexus:platform:health');
  assert.equal(v.db.subReason, 'not_enabled'); noLeak(v);
  reason = 'auto_held';
  assert.equal((await x.ok('nexus:platform:health')).db.subReason, 'auto_held');
  // The view filters whatever its caller passes.
  const { healthView } = loadTs('src/main/nexusIpc/dto.ts');
  const view = healthView(p.nx.exec.health(), { handoffs: true, execution: false, registry: { valid: true, problems: 0 }, subReason: '/Users/x/raw' });
  assert.equal(view.db.subReason, 'not_enabled');
});

test('I-D1 evidence values are digests only when they are digests: a non-hex sha256 or commit is never sliced into a view; case items are not listed by #32', () => {
  const { validationView } = loadTs('src/main/nexusIpc/dto.ts');
  const v = validationView({ validatorId: 'x.y', blocking: true, latestRun: null, history: 1, latestBlocking: { status: 'passed', summary: 's', finishedAt: 1,
    evidence: [{ type: 'hash', label: 'a', sha256: 'C:\\Users\\leak\\secret-file' }, { type: 'git', commit: '/home/bob/private/repo' },
      { type: 'hash', label: 'ok', sha256: 'a'.repeat(64) }, { type: 'git', commit: 'b'.repeat(40) },
      { type: 'case', name: 'n', classname: 'c', file: null, outcome: 'failed' }] } });
  assert.deepEqual(v.evidence.map((e) => e.value), [null, null, `sha256:${'a'.repeat(12)}`, 'b'.repeat(12)]);
  noLeak(v);
});

test('I-A1 #24: the actions of a withdrawn participation say withdrawn, never permission', async () => {
  const w = execWorld(); const x = ipcOver(w);
  const pw = await x.ok('nexus:participation:attach', 'p-ledger', 'ml');
  const before = await x.ok('nexus:actions:available', { projectId: 'p-ledger', workspaceId: 'ml' });
  assert.equal(before.find((a) => a.actionId === 'ml.problem.write').reason, null);
  await x.ok('nexus:participation:withdraw', pw.id);
  const after = await x.ok('nexus:actions:available', { projectId: 'p-ledger', workspaceId: 'ml' });
  assert.equal(after.find((a) => a.actionId === 'ml.problem.write').reason, 'withdrawn');
  assert.ok(after.every((a) => a.reason !== 'permission' && a.available === false));
  // A missing permission on an active participation still reads permission.
  const viewer = w.addUser('u-viewer', 'project', 'p-ledger', 'viewer');
  const restore = asLocalUser(w.nx, viewer);
  assert.equal((await x.ok('nexus:actions:available', { projectId: 'p-ledger', workspaceId: 'sde' })).find((a) => a.actionId === 'sde.tests.discover').reason, 'permission');
  restore();
  w.close();
});

test('I-V1 #34 rows page by a row cursor: a byte cap that ends a page early never skips a row (450 rows at 2000 bytes: every row exactly once)', async () => {
  const rows = Array.from({ length: 450 }, (_, i) => ({ name: `dist/assets/chunk-${String(i).padStart(3, '0')}.js`, detail: `sha256:${'a'.repeat(12)}`, bytes: i, outcome: null }));
  const fakePlatform = { queries: { previewSource: () => ({ type: 'rows', rows }) } };
  const port = execIpcPort(fakePlatform, { confineToDataHome: async () => null, objectPath: async () => null, deleteObjects: async () => ({ failed: [] }) });
  const read = async (maxBytes) => {
    const seen = []; let from = 0; let pages = 0;
    for (;;) {
      const p = await port.preview(null, 'v', { part: 'manifest', fromRow: from, maxBytes });
      assert.equal(p.fromRow, from); assert.equal(p.totalRows, 450); assert.equal(p.text, null);
      seen.push(...p.rows.map((r) => r.name)); pages++;
      if (p.nextRow === null) break;
      assert.equal(p.nextRow, from + p.rows.length, 'the cursor is the first row not returned'); from = p.nextRow;
    }
    return { seen, pages };
  };
  for (const maxBytes of [2000, 1, 150, 262144]) {
    const { seen, pages } = await read(maxBytes);
    assert.deepEqual(seen, rows.map((r) => r.name), `maxBytes ${maxBytes}: every row once, in order`);
    if (maxBytes === 2000) assert.ok(pages > 3, 'the byte cap ended pages early');
  }
  // The same through #34 over a real 450-file build.
  const w = execWorld({ realIngest: true }); const x = ipcOver(w);
  const b = await w.runBuild({ files: Array.from({ length: 450 }, (_, i) => `f${String(i).padStart(3, '0')}.js`) });
  const seen = []; let from = 0;
  for (;;) {
    const p = await x.ok('nexus:version:preview', b.buildVersionId, { part: 'manifest', fromRow: from, maxBytes: 2000 });
    seen.push(...p.rows.map((r) => r.name));
    if (p.nextRow === null) break;
    from = p.nextRow;
  }
  assert.equal(seen.length, 450); assert.equal(new Set(seen).size, 450);
  // page is for the text part, fromRow for the row parts: the wrong one is a bad request.
  await x.refused('nexus:version:preview', [b.buildVersionId, { part: 'manifest', page: 1, maxBytes: 10 }], 'invalid', { reason: 'bad_request', field: 'page' });
  await x.refused('nexus:version:preview', [w.repoV, { part: 'content', fromRow: 1, maxBytes: 10 }], 'invalid', { reason: 'bad_request', field: 'fromRow' });
  w.close();
});

test('I-V2 #34 text: redacted WHOLE before it is paged (a secret across a cut never survives in either page) and every cut on a code point', async () => {
  const { redactSecretText } = loadTs('src/main/nexus/activity/redact.ts');
  const TOKEN = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
  const text = `añb€c😀d key ${TOKEN} end ${'ü'.repeat(40)} 日本語 -----BEGIN RSA PRIVATE KEY-----\n${'QUJD'.repeat(60)}\n-----END RSA PRIVATE KEY----- tail`;
  const w = execWorld();
  const stored = w.stored('notes.txt', text);
  for (const src of [{ type: 'text', text }, { type: 'object', sha256: stored.sha256, bytes: stored.bytes, mediaType: 'text/plain' }]) {
    const port = execIpcPort({ queries: { previewSource: () => src } }, w.dataHome);
    for (const maxBytes of [1, 2, 3, 5, 7, 13, 64, 4096]) {
      let all = ''; let page = 0;
      for (;;) {
        const p = await port.preview(null, 'v', { part: 'content', page, maxBytes });
        assert.ok(!p.text.includes('\uFFFD'), `${src.type} ${maxBytes}: page ${page} splits a character`);
        // Fixed page boundaries, each snapped back to a code point: a page holds at most maxBytes + 3 bytes (its start may
        // move back into the character the previous boundary would have split).
        assert.ok(Buffer.byteLength(p.text) <= maxBytes + 3, `${src.type} ${maxBytes}: page ${page} too long`);
        for (const piece of ['abcdefgh', 'QUJDQUJD', 'sk-ant-api03-abc']) assert.ok(!p.text.includes(piece), `${src.type} ${maxBytes}: ${piece}`);
        all += p.text;
        if (p.nextPage === null) break;
        assert.equal(p.nextPage, page + 1); page = p.nextPage;
      }
      assert.equal(all, redactSecretText(text), `${src.type} ${maxBytes}: the pages are the redacted text, whole`);
    }
  }
  // An object over the preview bound is too_large (the whole is redacted per page, so it stays bounded).
  const { PREVIEW_MAX_OBJECT_BYTES } = loadTs('src/main/nexus/exec/execQueries.ts');
  assert.equal(PREVIEW_MAX_OBJECT_BYTES, 4 * 2 ** 20);
  w.close();
});

test('I-V3 #34 text is redacted once per content (fix round 2): later pages and later requests for the same bytes never redact again; a small LRU bounded by entries and bytes', async () => {
  const { redactSecretText } = loadTs('src/main/nexus/activity/redact.ts');
  const { PREVIEW_CACHE_ENTRIES, PREVIEW_CACHE_BYTES } = loadTs('src/main/nexusExec/execWiring.ts');
  assert.deepEqual([PREVIEW_CACHE_ENTRIES, PREVIEW_CACHE_BYTES], [4, 16 * 2 ** 20]);
  const TOKEN = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
  const w = execWorld();
  let src = null;
  let redactions = 0;
  const port = execIpcPort({ queries: { previewSource: () => src } }, w.dataHome, { redact: (s) => { redactions++; return redactSecretText(s); } });
  const pages = async (maxBytes) => {
    let all = ''; let page = 0;
    for (;;) {
      const p = await port.preview(null, 'v', { part: 'content', page, maxBytes });
      all += p.text;
      if (p.nextPage === null) return all;
      page = p.nextPage;
    }
  };
  const text = (i) => `content ${i} key ${TOKEN} ${'ü'.repeat(300)} end`;
  // One content, paged at three sizes, as inline text and as the stored object with the same bytes: redacted once.
  src = { type: 'text', text: text(0) };
  for (const maxBytes of [7, 64, 4096]) assert.equal(await pages(maxBytes), redactSecretText(text(0)));
  assert.equal(redactions, 1, 'the first page redacted it, no later page did');
  const stored = w.stored('notes.txt', text(0));
  src = { type: 'object', sha256: stored.sha256, bytes: stored.bytes, mediaType: 'text/plain' };
  assert.equal(await pages(64), redactSecretText(text(0)));
  assert.equal(redactions, 1, 'the same bytes are the same content');
  // Contents 1-3 fill the cache (4 entries); content 0 is used again (most recent); content 4 evicts content 1, the least recent.
  for (const i of [1, 2, 3]) { src = { type: 'text', text: text(i) }; await pages(4096); }
  assert.equal(redactions, 4);
  src = { type: 'text', text: text(0) }; await pages(4096);
  assert.equal(redactions, 4, 'content 0 still cached');
  src = { type: 'text', text: text(4) }; await pages(4096);
  assert.equal(redactions, 5);
  for (const i of [0, 2, 3, 4]) { src = { type: 'text', text: text(i) }; await pages(4096); }
  assert.equal(redactions, 5, 'contents 0, 2, 3 and 4 are cached');
  src = { type: 'text', text: text(1) }; await pages(4096);
  assert.equal(redactions, 6, 'content 1 was evicted and is redacted again');
  // The byte bound: redacted text can be longer than its content (`sig=a` -> `sig=[redacted]`). Three such contents of
  // over 6 MiB each exceed 16 MiB, so the oldest is evicted although only three entries are held.
  const big = (c) => `sig=${c} `.repeat(500_000);
  assert.ok(Buffer.byteLength(redactSecretText(big('a'))) > 6 * 2 ** 20);
  const view = async (c, page = 0) => { src = { type: 'text', text: big(c) }; return port.preview(null, 'v', { part: 'content', page, maxBytes: 10 }); };
  for (const c of ['a', 'b', 'c']) await view(c);
  assert.equal(redactions, 9);
  await view('c', 5); await view('b', 7);
  assert.equal(redactions, 9, 'the two most recent are cached');
  assert.doesNotMatch((await view('a', 1)).text + (await view('a', 2)).text, /sig=a/);
  assert.equal(redactions, 10, 'the oldest was evicted by the byte bound');
  // A real adversarial 4 MiB text: the second page does not redact again (measured here: about 80 ms, then about 10 ms).
  const real = execIpcPort({ queries: { previewSource: () => ({ type: 'text', text: `${'x-'.repeat(127)} `.repeat(16448) }) } }, w.dataHome);
  const t0 = process.hrtime.bigint();
  const p0 = await real.preview(null, 'v', { part: 'content', page: 0, maxBytes: 262144 });
  const t1 = process.hrtime.bigint();
  const p1 = await real.preview(null, 'v', { part: 'content', page: 1, maxBytes: 262144 });
  const t2 = process.hrtime.bigint();
  assert.equal(p0.nextPage, 1); assert.equal(p1.page, 1);
  const [first, second] = [Number(t1 - t0) / 1e6, Number(t2 - t1) / 1e6];
  assert.ok(second < 200, `the second page took ${second.toFixed(1)} ms (the first ${first.toFixed(1)} ms)`);
  w.close();
});

test('I-L1 #28 log pages hold WHOLE frames: any fromOffset snaps to its frame start, a frame longer than maxBytes comes whole, no character is split, a stored token is never reassembled', async () => {
  const { readLogPage } = loadTs('src/main/nexusExec/execWiring.ts');
  const TOKEN = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
  const w = execWorld();
  const frames = [{ ts: 1, stream: 'stdout', text: 'start' }, { ts: 2, stream: 'stdout', text: `wide ${'ü€😀'.repeat(30)}` },
    // A frame as an older writer might have stored it: the token in clear text. Read-side redaction sees it whole.
    { ts: 3, stream: 'stderr', text: `auth ${TOKEN} done` }, { ts: 4, stream: 'stdout', text: '日本語 end' }];
  const raw = frames.map((f) => `${JSON.stringify(f)}\n`).join('');
  const rel = 'logs/jobs/JOBUTF8/1.log';
  fs.mkdirSync(path.dirname(path.join(w.dataHome.root, rel)), { recursive: true });
  fs.writeFileSync(path.join(w.dataHome.root, rel), raw);
  const size = Buffer.byteLength(raw);
  const starts = []; let at = 0; for (const f of frames) { starts.push(at); at += Buffer.byteLength(`${JSON.stringify(f)}\n`); }
  const check = (p, why) => {
    assert.ok(!p.text.includes('\uFFFD'), `${why}: a split character`);
    for (const piece of ['sk-ant', 'abcdefghij', 'qrstuvwxyz']) assert.ok(!p.text.includes(piece), `${why}: ${piece}`);
    for (const line of p.text.split('\n').filter((l) => l.length > 0)) assert.doesNotThrow(() => JSON.parse(line), `${why}: a whole frame`);
    assert.ok(p.text === '' || p.text.endsWith('\n'), `${why}: ends on a frame`);
    assert.ok(starts.includes(p.nextOffset) || p.nextOffset === size, `${why}: nextOffset ${p.nextOffset} is a frame start`);
  };
  for (const maxBytes of [1, 7, 60, 262144]) {
    // Every offset at one page size; every seventh at the others (the same frames, a quicker file).
    for (let from = 0; from < size; from += maxBytes === 7 ? 1 : 7) {
      const p = await readLogPage(w.dataHome, rel, { fromOffset: from, maxBytes });
      check(p, `max ${maxBytes} from ${from}`);
      const frameStart = starts.filter((s) => s <= from).pop();
      const first = JSON.parse(p.text.split('\n')[0]);
      assert.equal(first.ts, frames[starts.indexOf(frameStart)].ts, `from ${from}: the page starts at the frame holding it`);
    }
    // Sequential reads: every frame exactly once.
    const got = []; let off = 0;
    for (;;) {
      const p = await readLogPage(w.dataHome, rel, { fromOffset: off, maxBytes });
      got.push(...p.text.split('\n').filter((l) => l).map((l) => JSON.parse(l).ts));
      if (p.eof) break;
      off = p.nextOffset;
    }
    assert.deepEqual(got, [1, 2, 3, 4], `max ${maxBytes}`);
  }
  // A line longer than a page is not a frame the runner writes: refused as malformed, never cut.
  const big = 'logs/jobs/JOBBIG/1.log';
  fs.mkdirSync(path.dirname(path.join(w.dataHome.root, big)), { recursive: true });
  fs.writeFileSync(path.join(w.dataHome.root, big), `${'x'.repeat(300 * 1024)}\n{"ts":1,"stream":"stdout","text":"after"}\n`);
  assert.equal(await readLogPage(w.dataHome, big, { fromOffset: 0, maxBytes: 100 }), 'malformed');
  assert.equal(await readLogPage(w.dataHome, big, { fromOffset: 290 * 1024, maxBytes: 100 }), 'malformed');
  w.close();
});

test('I-G1 #41 apply reports the bytes it actually freed (deleted files of the removed rows; a failed delete frees none)', async () => {
  const w = execWorld(); const x = ipcOver(w);
  const bi = w.nx.blobs;
  const a = w.stored('a', 'a'.repeat(10)); const b = w.stored('b', 'b'.repeat(25));
  const c = w.file('c', 'c'.repeat(7));
  // c's object path is a folder: its file delete fails.
  fs.mkdirSync(path.join(w.dataHome.root, w.dataHome.objectRel(c.sha256)), { recursive: true });
  await bi.withIngestLock((t) => bi.recordBlobsTx(t, [a, b, c].map((f) => ({ sha256: f.sha256, bytes: f.bytes, mediaType: 'text/plain' }))));
  w.advance(25 * 60 * 60_000);
  const dry = await x.ok('nexus:blobs:gc', { apply: false });
  assert.deepEqual([dry.candidates, dry.bytes, dry.removed], [3, 42, 0]);
  const applied = await x.ok('nexus:blobs:gc', { apply: true, expectedCandidatesHash: dry.candidatesHash });
  assert.deepEqual([applied.candidates, applied.removed, applied.fileDeleteFailed, applied.bytes], [3, 2, 1, 35]);
  assert.ok(!fs.existsSync(path.join(w.dataHome.root, w.dataHome.objectRel(a.sha256))));
  w.close();
});

// ---------- busy and truncation ----------

test('I-E7 a write lock held by another connection answers busy on job:start and writes nothing; the same intent succeeds once the lock is gone', async () => {
  const w = execWorld();
  const x = ipcOver(w);
  w.db.pragma('busy_timeout = 50');
  const req = { projectId: 'p-ledger', workspaceId: 'sde', actionId: 'sde.tests.discover', inputs: [{ versionId: w.repoV, slot: 'repository' }], params: {}, intentId: intent() };
  const jobs = () => w.db.prepare('SELECT COUNT(*) n FROM jobs').get().n;
  const before = jobs();
  const other = h.openRaw(w.db.name); other.pragma('busy_timeout = 0');
  other.prepare('BEGIN IMMEDIATE').run();
  try {
    const r = await x.call('nexus:job:start', req);
    assert.deepEqual(r, { ok: false, code: 'platform_unavailable', message: BUSY_MESSAGE, reason: 'busy' });
  } finally { other.prepare('ROLLBACK').run(); other.close(); }
  assert.equal(jobs(), before);
  const ok = await x.ok('nexus:job:start', req);
  assert.equal(ok.created, true);
  const again = await x.ok('nexus:job:start', req);
  assert.deepEqual([again.created, again.job.id], [false, ok.job.id], 'the same intent never makes a second job');
  w.close();
});

test('I-E8 truncation flags: jobs:list says truncated only when more rows exist than were returned', async () => {
  const w = execWorld();
  const x = ipcOver(w);
  for (let i = 0; i < 3; i++) await x.ok('nexus:job:start', { projectId: 'p-ledger', workspaceId: 'sde', actionId: 'sde.tests.discover',
    inputs: [{ versionId: w.repoV, slot: 'repository' }], params: {}, intentId: intent() });
  const two = await x.call('nexus:jobs:list', { projectId: 'p-ledger', limit: 2 });
  assert.deepEqual([two.data.length, two.truncated], [2, true]);
  const three = await x.call('nexus:jobs:list', { projectId: 'p-ledger', limit: 3 });
  assert.deepEqual([three.data.length, three.truncated], [3, false]);
  const big = await x.call('nexus:jobs:list', { limit: 5000 });
  assert.deepEqual([big.data.length, big.truncated], [3, false], 'a limit above the cap is clamped to 500');
  for (const j of three.data) { assert.equal(j.headline, 'queued'); assert.equal(j.requestedByKind, 'user'); noLeak(j); }
  w.close();
});

// ---------- health ----------

test('I-H1 health: the disk gate with its exact numbers (30 GiB required, 40 GiB recommended) and the free bytes main observed', async () => {
  const w = execWorld({ freeBytes: 100 * GIB });
  w.attach();
  const x = ipcOver(w);
  const v = await x.ok('nexus:platform:health');
  assert.deepEqual(v.disk, { dataHomeFreeBytes: 100 * GIB, requiredBytes: 32212254720, recommendedBytes: 42949672960, leaseFloorBytes: v.disk.leaseFloorBytes, gate: 'ok' });
  assert.equal(REQUIRED_FREE_BYTES, 30 * 2 ** 30); assert.equal(RECOMMENDED_FREE_BYTES, 40 * 2 ** 30);
  assert.ok(v.disk.leaseFloorBytes > 0);
  assert.deepEqual(v.problems, []);
  assert.deepEqual([v.db.version, v.db.platform, v.db.handoffs, v.db.execution], [9, true, true, true]);
  assert.deepEqual(v.registry, { valid: true, problems: 0 });
  assert.equal(v.docker.state, 'running'); assert.equal(v.docker.cpus, 4); assert.equal(v.docker.memoryBytes, 8 * GIB);
  assert.deepEqual(v.gpu, { detected: false, supported: false });
  for (const i of v.images) assert.match(i.imageIdShort, /^sha256:[0-9a-f]{12}$/);
  noLeak(v, 'health');
  w.close();
});

test('I-H2 health: 35 GiB free is below_recommended (advisory), 20 GiB below_required (disk_low), each with the numbers', async () => {
  const w = execWorld({ freeBytes: 35 * GIB });
  w.attach();
  const x = ipcOver(w);
  let v = await x.ok('nexus:platform:health');
  assert.deepEqual([v.disk.gate, v.disk.dataHomeFreeBytes], ['below_recommended', 35 * GIB]);
  assert.ok(v.problems.includes('disk_below_recommended'), v.problems.join());
  w.setProbe({ freeBytes: 20 * GIB });
  v = await x.ok('nexus:platform:health');
  assert.deepEqual([v.disk.gate, v.disk.dataHomeFreeBytes], ['below_required', 20 * GIB]);
  assert.ok(v.problems.includes('disk_low'), v.problems.join());
  w.close();
});

test('I-H3 health: Docker stopped, an image missing, a GPU detected (never supported); every line actionable by id', async () => {
  const w = execWorld({ images: [{ profile: 'sde-node', present: false, digestMatches: false }, { profile: 'sde-python', present: true, digestMatches: false, imageId: 'sha256:' + '2'.repeat(64) }] });
  w.attach();
  w.setProbe({ docker: 'stopped' });
  const x = ipcOver(w);
  const v = await x.ok('nexus:platform:health');
  assert.equal(v.docker.state, 'stopped');
  assert.deepEqual(v.problems, ['docker_stopped']);
  // A setup:* answer on the action itself.
  const acts = await x.ok('nexus:actions:available', { projectId: 'p-ledger', workspaceId: 'sde' });
  assert.equal(acts.find((a) => a.actionId === 'sde.tests.discover').reason, 'setup:docker_stopped');
  // Docker running again: the images are judged.
  w.setProbe({ docker: 'running' });
  const v2 = await x.ok('nexus:platform:health');
  assert.ok(v2.problems.includes('image_missing:sde-node'), v2.problems.join());
  assert.ok(v2.problems.includes('image_mismatch:sde-python'), v2.problems.join());
  assert.equal(v2.images.find((i) => i.profile === 'sde-python').imageIdShort, 'sha256:222222222222');
  assert.equal((await x.ok('nexus:actions:available', { projectId: 'p-ledger', workspaceId: 'sde' })).find((a) => a.actionId === 'sde.tests.discover').reason,
    'setup:image_missing');
  w.close();
});

test('I-H4 health never waits on the runner: with a runner that never answers, #23 answers from the cache within 50 ms', async () => {
  const w = execWorld();
  const silent = { state: () => 'ready', send: () => true, onMessage: () => () => {}, report: () => {} };
  w.exec.attachRunner(silent, w.bootId);
  const x = ipcOver(w);
  await x.ok('nexus:platform:health');                       // warm the module paths
  const t0 = process.hrtime.bigint();
  const v = await x.ok('nexus:platform:health');
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 50, `${ms} ms`);
  assert.deepEqual([v.docker.state, v.checkedAt, v.disk.gate], ['unknown', null, 'unknown'], 'no probe has arrived: nothing is invented');
  assert.equal(v.runner.state, 'ready');
  // A runner whose state throws reads as unavailable; still no wait, no throw.
  w.exec.attachRunner({ state: () => { throw new Error('gone'); }, send: () => false, onMessage: () => () => {}, report: () => {} }, w.bootId);
  assert.equal((await x.ok('nexus:platform:health')).runner.state, 'unavailable');
  w.close();
});

// ---------- a hung runner ----------

test('I-R1 a hung runner: every one of the 41 channels answers within 200 ms', async () => {
  const w = execWorld();
  const hung = { state: () => 'ready', send: () => true, onMessage: () => () => {}, report: () => {} };
  w.exec.attachRunner(hung, w.bootId);
  const x = ipcOver(w);
  const started = await x.ok('nexus:job:start', { projectId: 'p-ledger', workspaceId: 'sde', actionId: 'sde.tests.discover',
    inputs: [{ versionId: w.repoV, slot: 'repository' }], params: {}, intentId: intent() });
  w.exec.tick(w.now());                                       // leased and sent; the runner never answers
  const args = validArgs(w, { job: started.job.id });
  for (const ch of NEXUS_ALL_CHANNELS) {
    const t0 = process.hrtime.bigint();
    const r = await x.call(ch, ...args[ch]);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(typeof r.ok, 'boolean', ch);
    assert.ok(ms < 200, `${ch} took ${ms} ms`);
    noLeak(r, ch);
  }
  w.close();
});

// ---------- the nexus:hint push ----------

test('I-P1 nexus:hint carries { lastSeq } only, through sendNexusHint (the one send of the family), never to a destroyed target, never throwing', () => {
  const sent = [];
  const target = { send: (ch, payload) => sent.push([ch, payload]), isDestroyed: () => false };
  assert.equal(sendNexusHint(target, 7), true);
  assert.deepEqual(sent, [['nexus:hint', { lastSeq: 7 }]]);
  for (const bad of [-1, 1.5, NaN, '7', null, Number.MAX_SAFE_INTEGER + 2]) assert.equal(sendNexusHint(target, bad), false, String(bad));
  assert.equal(sendNexusHint({ send: () => { sent.push('x'); }, isDestroyed: () => true }, 8), false);
  assert.equal(sendNexusHint({ send: () => { throw new Error('gone'); } }, 9), false);
  assert.equal(sent.length, 1);
  // The family sends exactly one push: one `.send(` in src/main/nexusIpc, inside sendNexusHint; its literal appears once.
  const files = fs.readdirSync(path.join(ROOT, 'src/main/nexusIpc')).map((f) => read(`src/main/nexusIpc/${f}`));
  // (B1's `handoffs!.send(` is the handoff service's send, not a transport.)
  assert.deepEqual(files.join('\n').match(/[A-Za-z!]+\.send\(/g).sort(), ['handoffs!.send(', 'target.send(']);
  const mod = read('src/main/nexusIpc/registerNexusIpc.ts');
  assert.equal((mod.match(/'nexus:hint'/g) || []).length, 1);
  assert.match(mod, /target\.send\(NEXUS_HINT_CHANNEL, \{ lastSeq \}\)/);
  // main's wiring sends hints only through it, to the targets main names.
  const wiring = read('src/main/nexusExec/execWiring.ts');
  assert.match(wiring, /for \(const t of targets\) if \(t\) sendNexusHint\(t, h\.lastSeq\);/);
  assert.doesNotMatch(wiring, /webContents|\.send\('/);
});

test('I-P2 the hint coalescer: at most 4 hints in any second, each the newest seq, none when it did not change', () => {
  const q = []; let now = 0;
  const timers = { setTimeout: (fn, ms) => { const t = { at: now + ms, fn }; q.push(t); return t; }, clearTimeout: (t) => { const i = q.indexOf(t); if (i >= 0) q.splice(i, 1); } };
  const advance = (ms) => { const end = now + ms; for (;;) { const due = q.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0]; if (!due) break; q.splice(q.indexOf(due), 1); now = due.at; due.fn(); } now = end; };
  let seq = 0; const sent = [];
  const c = hintCoalescer({ lastSeq: () => seq, emit: (x) => sent.push({ at: now, ...x }), now: () => now, timers });
  for (let i = 0; i < 3000; i++) { seq++; c.poke(); advance(1); }
  advance(1000);
  assert.equal(HINT_MIN_INTERVAL_MS, 250);
  for (const s of sent) assert.ok(sent.filter((x) => x.at >= s.at && x.at < s.at + 1000).length <= 4, `more than 4 hints in the second from ${s.at}`);
  for (const s of sent) assert.deepEqual(Object.keys(s).sort(), ['at', 'lastSeq']);
  assert.equal(sent.at(-1).lastSeq, 3000, 'the newest seq');
  const n = sent.length; c.poke(); advance(1000);
  assert.equal(sent.length, n, 'unchanged: no hint');
});

test('I-P3 startExecution sends each coalesced hint to every live target main names, { lastSeq } only', async () => {
  const w = execWorld();
  const nx = createNexusPlatform(w.db, { now: () => w.now(), execution: true, dataHome: w.dataHome, profiles: PROFILES, acceptFsRoot: (r) => r, approvals: null });
  nx.startup();
  // A scripted runner process that answers hello with ready and nothing else.
  const fork = () => {
    const c = { msgFn: null, exitFn: null, post(m) { if (m.op === 'hello') setImmediate(() => c.msgFn?.({ op: 'ready', bootId: m.bootId })); },
      onMessage(f) { c.msgFn = f; }, onExit(f) { c.exitFn = f; }, kill() { c.exitFn?.(null); } };
    return c;
  };
  const q = []; let now = w.now();
  const timers = { setTimeout: (fn, ms) => { const t = { at: now + ms, fn, every: 0 }; q.push(t); return t; }, clearTimeout: (t) => { const i = q.indexOf(t); if (i >= 0) q.splice(i, 1); },
    setInterval: (fn, ms) => { const t = { at: now + ms, fn, every: ms }; q.push(t); return t; }, clearInterval: (t) => { const i = q.indexOf(t); if (i >= 0) q.splice(i, 1); } };
  const advance = (ms) => { const end = now + ms; for (;;) { const due = q.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0]; if (!due) break; now = due.at; if (due.every) due.at += due.every; else q.splice(q.indexOf(due), 1); due.fn(); } now = end; };
  const got = [];
  const live = { send: (ch, p) => got.push([ch, p]), isDestroyed: () => false };
  const dead = { send: () => got.push(['dead']), isDestroyed: () => true };
  const handle = await startExecution({ platform: nx, userData: path.dirname(w.dataHome.root), log: () => {}, fork, timers, now: () => now,
    hintTargets: () => [live, dead, null] });
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  nx.exec.start(nx.principals.localUser(), w.req('sde.tests.discover'));   // a job event: the newest seq moves
  advance(3 * 60_000);
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.ok(got.length >= 1, 'a hint went out');
  for (const g of got) {
    assert.equal(g[0], 'nexus:hint');
    assert.deepEqual(Object.keys(g[1]), ['lastSeq']);
    assert.ok(Number.isSafeInteger(g[1].lastSeq));
  }
  assert.equal(got.at(-1)[1].lastSeq, nx.exec.lastEventSeq());
  const st = handle.stop(); advance(10_000); await st;
  w.close();
});

test('I-P4 no system-only door is mapped to IPC: resumeApproved(Tx), ingest, recovery, finalize, transitions and the runner port never appear in the IPC layer', () => {
  const family = fs.readdirSync(path.join(ROOT, 'src/main/nexusIpc')).map((f) => read(`src/main/nexusIpc/${f}`)).join('\n');
  for (const name of ['resumeApproved', 'resumeApprovedTx', 'endAwaitingTx', 'ingestAttempt', 'ingestTx', 'recoverPhaseA', 'recoverPhaseB',
    'recoverBlobStore', 'reconcileList', 'onRunnerMessage', 'attachRunner', 'sendToRunner', 'createCheckTx', 'createTx', 'transitionTx',
    'finalizeIfReady', 'enqueueCandidate', 'recordResultTx', 'recordOutcomeTx', 'expireDue', 'insertSystemVersionTx', 'setStatusTx', 'stopAllForQuit',
    'gcCandidates', 'tick(']) {
    assert.ok(!family.includes(name), `${name} is reachable from the IPC layer`);
  }
  // The approval answer is #39 (respond) only, with once or deny.
  const mod = read('src/main/nexusIpc/registerNexusIpc.ts');
  assert.equal((mod.match(/\.respond\(/g) || []).length, 1);
  assert.match(mod, /approvalsOf\(nx\)\.respond\(me, q\.approvalId, q\.decision\)/);
  assert.match(read('src/main/nexusIpc/validate.ts'), /decision\(x: unknown\): 'once' \| 'deny' \{ return V\.enumOf\(x, 'decision', \['once', 'deny'\] as const\); \}/);
});

test('I-P5 the execution IPC port reads logs and previews only after the platform authorizes, and answers not_started without main\'s wiring', async () => {
  const w = execWorld();
  const x = ipcOver(w, { exec: () => null });
  for (const [ch, args] of [['nexus:job:logs', [UNKNOWN, { attempt: 1, fromOffset: 0, maxBytes: 10 }]], ['nexus:version:preview', [w.repoV, { part: 'content', maxBytes: 10 }]],
    ['nexus:blobs:gc', [{ apply: false }]]]) {
    const r = await x.call(ch, ...args);
    assert.deepEqual([r.code, r.reason, r.subReason], ['platform_unavailable', 'execution_unavailable', 'not_started'], ch);
  }
  const port = execIpcPort(w.nx, w.dataHome);
  assert.deepEqual(Object.keys(port).sort(), ['blobsGc', 'logs', 'preview']);
  w.close();
});
