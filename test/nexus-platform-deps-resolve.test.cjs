'use strict';
// Live preview phase 2: an app with add-ons (packages) and NO lockfile is installed with the person's OK, through the same registry-only proxy, in ONE approved
// job (`sde.deps.resolve`: the exact versions are worked out, then installed with scripts off). Fake runner and fake sandbox world (no Docker); the real-Docker
// run is in the phase notes. Real SQLite (test:db). Every step is driven through the handlers a renderer calls.
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { execWorld, GIB } = require('./helpers/execWorld.cjs');
const { ipcOver, intent } = require('./helpers/ipcExec.cjs');

const MAN = '5c'.repeat(32);
const LOCK = '3f'.repeat(32);
const OTHER = 'ab'.repeat(32);
const manifest = (sha = MAN, dependencies = 2) => ({ manifest: { path: 'package.json', sha256: sha, dependencies } });
const world = (repoMeta) => execWorld({ approvals: 'real', realIngest: true, repoMeta, dockerMemoryBytes: 64 * GIB });
const startArgs = (actionId, inputs) => ({ projectId: 'p-ledger', workspaceId: 'sde', actionId, inputs, params: {}, intentId: intent() });
const prepare = (w, x, versionId) => x.call('nexus:job:start', startArgs('sde.deps.prepare', [{ versionId: versionId ?? w.repoV, slot: 'repository' }]));
const lockRows = (w) => w.db.prepare("SELECT * FROM validations WHERE validator_id = 'sde.deps.lock_matches' ORDER BY rowid").all();
const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

async function approvedResolve(w, r, x, metaSha = MAN) {
  const s = await x.ok('nexus:job:start', startArgs('sde.deps.prepare', [{ versionId: w.repoV, slot: 'repository' }]));
  w.exec.tick(w.now());
  const ap = (await x.ok('nexus:approvals:list', { projectId: 'p-ledger', status: 'pending' })).find((y) => y.jobId === s.job.id);
  assert.ok(ap, 'the question is waiting');
  assert.equal(ap.request.manifestSha256, metaSha);
  await x.ok('nexus:approval:respond', ap.id, 'once');
  w.provision(r, s.job.id);
  return { jobId: s.job.id, approvalId: ap.id, ap };
}

test('DP1 an app with add-ons and no lockfile: one question, one approved job (lock-only then install, registry only), completed on the package list hash', async () => {
  const w = world(manifest()); const r = w.attach(); const x = ipcOver(w);
  const s = await x.ok('nexus:job:start', startArgs('sde.deps.prepare', [{ versionId: w.repoV, slot: 'repository' }]));
  assert.equal(s.job.recipeId, 'sde.deps.resolve');
  w.exec.tick(w.now());
  assert.equal((await x.ok('nexus:job:get', s.job.id)).headline, 'waiting_for_approval');
  const ap = (await x.ok('nexus:approvals:list', { projectId: 'p-ledger', status: 'pending' }))[0];
  assert.deepEqual([ap.jobId, ap.reason, ap.request.manifestSha256, ap.request.lockfileSha256, ap.request.registries],
    [s.job.id, 'egress.deps', MAN, undefined, ['registry.npmjs.org']]);
  assert.match(ap.summary, /no lockfile/);
  assert.match(ap.summary, /Only registry\.npmjs\.org \(HTTPS, port 443\) can be reached/);
  // The list view shortens the sentence; the stored one is whole and says what is enforced.
  assert.ok(w.db.prepare('SELECT summary FROM approvals WHERE id = ?').get(ap.id).summary
    .endsWith('exact versions are worked out from its package list (5c5c5c5c5c5c) and then installed. Install scripts are disabled.'));
  assert.equal(r.sentOf('attempt.start').length, 0, 'nothing runs before the answer');
  await x.ok('nexus:approval:respond', ap.id, 'once');
  const plan = r.lastStart().plan;
  assert.deepEqual(plan.container.network, { mode: 'egress-approved', approvalId: ap.id, purpose: 'deps' });
  const argv = plan.container.argv;
  const sep = '--nexus-then';
  const steps = []; let cur = [];
  for (const a of argv) { if (a === sep) { steps.push(cur); cur = []; } else cur.push(a); }
  steps.push(cur);
  assert.deepEqual(steps, [
    ['npm', 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
    ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    ['nexus-lock-hash', '--file', 'package.json', '--out', '/out/lock.sha256']]);
  // The proxy allows the one registry, HTTPS only, and the add-ons volume (named by the package list) is written by this job only.
  assert.equal(plan.egressProxy.container.env.NEXUS_EGRESS_ALLOW, 'registry.npmjs.org:443');
  assert.deepEqual(plan.staging.depsVolume, { name: `nexus-deps-sde-node-${MAN.slice(0, 12)}`, readOnly: false });
  assert.ok(plan.container.mounts.some((m) => m.kind === 'deps' && m.containerPath === '/workspace/node_modules' && m.readOnly === false));
  w.provision(r, s.job.id);
  const out = w.stored('lock.sha256', `${MAN}\n`);
  w.exitWith(r, s.job.id, { code: 0, outputs: [out] });
  await w.settle();
  const d = await x.ok('nexus:job:get', s.job.id);
  assert.deepEqual([d.state, d.outcome, d.headline, d.error], ['completed', 'completed', 'checks_passed', null]);
  const rows = lockRows(w);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].version_id, rows[0].job_id, rows[0].status, rows[0].blocking, rows[0].advisory], [w.repoV, s.job.id, 'passed', 0, 1]);
  const env = JSON.parse(w.attempts(s.job.id)[0].environment_json);
  assert.deepEqual([env.depsVolume, env.manifestSha256], [`nexus-deps-sde-node-${MAN.slice(0, 12)}`, MAN]);
  w.close();
});

test('DP2 the install is refused when its evidence is not the approved package list: another hash, a non-zero exit, an extra output', async () => {
  const cases = [
    { name: 'another package list', outputs: (w) => [w.stored('lock.sha256', OTHER)], want: ['invalid_output', 'repository_mismatch'] },
    { name: 'non-zero exit', outputs: (w) => [w.stored('lock.sha256', MAN)], code: 1, want: ['nonzero_exit', 'nonzero_exit'] },
    { name: 'an extra output', outputs: (w) => [w.stored('lock.sha256', MAN), w.stored('x.txt', 'x')], want: ['invalid_output', 'extra_output'] }
  ];
  for (const c of cases) {
    const w = world(manifest()); const r = w.attach(); const x = ipcOver(w);
    const { jobId } = await approvedResolve(w, r, x);
    w.exitWith(r, jobId, { code: c.code ?? 0, outputs: c.outputs(w) });
    await w.settle();
    const d = await x.ok('nexus:job:get', jobId);
    assert.deepEqual([d.state, d.outcome, d.error.code], ['failed', ...c.want], c.name);
    assert.deepEqual(lockRows(w), [], `${c.name}: no evidence row`);
    w.close();
  }
});

test('DP3 what the step picks: a lockfile -> the lockfile install; add-ons and no lockfile -> the lock-only install; no add-ons -> nothing to do (no_dependencies)', async () => {
  const w1 = world({ lockfile: { path: 'package-lock.json', sha256: LOCK }, ...manifest() }); w1.attach(); const x1 = ipcOver(w1);
  const a = await x1.ok('nexus:job:start', startArgs('sde.deps.prepare', [{ versionId: w1.repoV, slot: 'repository' }]));
  assert.equal(a.job.recipeId, 'sde.deps.node', 'a lockfile wins');
  w1.close();
  const w2 = world(manifest(MAN, 0)); w2.attach(); const x2 = ipcOver(w2);
  const b = await prepare(w2, x2);
  assert.equal(b.ok, false);
  assert.equal(b.reason, 'no_dependencies');
  assert.equal(w2.db.prepare("SELECT COUNT(*) n FROM jobs WHERE recipe_id LIKE 'sde.deps.%'").get().n, 0, 'no job was made');
  w2.close();
  const w3 = world({}); w3.attach(); const x3 = ipcOver(w3);
  const c = await prepare(w3, x3);
  assert.equal(c.ok, false);
  assert.equal(c.reason, 'no_dependencies');
  w3.close();
});

test('DP4 asked once: after a completed install of this package list, the same list (even on a newer version) is not asked again; a changed list is', async () => {
  const w = world(manifest()); const r = w.attach(); const x = ipcOver(w);
  const { jobId } = await approvedResolve(w, r, x);
  w.exitWith(r, jobId, { code: 0, outputs: [w.stored('lock.sha256', MAN)] });
  await w.settle();
  assert.equal((await x.ok('nexus:job:get', jobId)).state, 'completed');
  const again = await prepare(w, x);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'deps_ready');
  // A newer repository version with the same package list (other code, same add-ons) is ready too.
  const art = w.db.prepare('SELECT artifact_id a FROM artifact_versions WHERE id = ?').get(w.repoV).a;
  const newer = w.nx.artifacts.registerVersion(w.me, { artifactId: art, storage: { kind: 'git', commit: 'b'.repeat(40) }, metadata: { profile: 'sde-node', ...manifest() } }).version.id;
  w.nx.artifacts.finalize(w.sys, newer, 'candidate');
  const again2 = await prepare(w, x, newer);
  assert.equal(again2.reason, 'deps_ready');
  // A changed package list is asked about again.
  const changed = w.nx.artifacts.registerVersion(w.me, { artifactId: art, storage: { kind: 'git', commit: 'c'.repeat(40) }, metadata: { profile: 'sde-node', ...manifest(OTHER, 2) } }).version.id;
  w.nx.artifacts.finalize(w.sys, changed, 'candidate');
  const fresh = await x.ok('nexus:job:start', startArgs('sde.deps.prepare', [{ versionId: changed, slot: 'repository' }]));
  assert.equal(fresh.job.recipeId, 'sde.deps.resolve');
  // A failed install does not count as ready: a world with a refused install asks again.
  const w2 = world(manifest()); const r2 = w2.attach(); const x2 = ipcOver(w2);
  const j2 = await approvedResolve(w2, r2, x2);
  w2.exitWith(r2, j2.jobId, { code: 0, outputs: [w2.stored('lock.sha256', OTHER)] });
  await w2.settle();
  assert.equal((await x2.ok('nexus:job:get', j2.jobId)).state, 'failed');
  const retry = await x2.ok('nexus:job:start', startArgs('sde.deps.prepare', [{ versionId: w2.repoV, slot: 'repository' }]));
  assert.equal(retry.job.recipeId, 'sde.deps.resolve', 'asked again after a failed install');
  w.close(); w2.close();
});

test('DP5 the add-ons the install wrote are mounted READ-ONLY into the build of the same package list, and into nothing that has no add-ons; the other test and try plans stay closed', async () => {
  const w = world(manifest()); const r = w.attach(); const x = ipcOver(w);
  const b = await x.ok('nexus:job:start', startArgs('sde.build.run', [{ versionId: w.repoV, slot: 'repository' }]));
  w.exec.tick(w.now());
  const plan = r.lastStart().plan;
  assert.deepEqual(plan.staging.depsVolume, { name: `nexus-deps-sde-node-${MAN.slice(0, 12)}`, readOnly: true });
  assert.equal(plan.container.network.mode, 'none', 'a build has no network');
  assert.ok(plan.container.mounts.some((m) => m.kind === 'deps' && m.readOnly === true));
  void b;
  w.close();
  const w2 = world(manifest(MAN, 0)); const r2 = w2.attach(); const x2 = ipcOver(w2);
  await x2.ok('nexus:job:start', startArgs('sde.build.run', [{ versionId: w2.repoV, slot: 'repository' }]));
  w2.exec.tick(w2.now());
  assert.equal(r2.lastStart().plan.staging.depsVolume, undefined, 'no add-ons, no volume');
  w2.close();
});

test('DP6 pure: the volume key (lockfile first, then the package list with add-ons, Node only), the policy list, the templates and the recipe', () => {
  const pb = loadTs('src/main/nexus/exec/planBuilder.ts');
  const eg = loadTs('src/shared/nexus/egressPolicy.ts');
  const { getRecipe } = loadTs('src/shared/nexus/recipes.ts');
  const m = (sha, n) => [{ versionId: 'v', slot: 'build', contentHash: 'c', storage: { kind: 'tree' }, metadata: { manifest: { sha256: sha, dependencies: n } } }];
  assert.equal(pb.depsVolumeName('sde-node', m(MAN, 3)), `nexus-deps-sde-node-${MAN.slice(0, 12)}`);
  assert.equal(pb.depsVolumeName('sde-node', m(MAN, 0)), null, 'no add-ons, no volume');
  assert.equal(pb.depsVolumeName('sde-python', m(MAN, 3)), null, 'Python needs its hash-pinned list');
  assert.equal(pb.depsVolumeName('sde-node', [{ ...m(MAN, 3)[0], metadata: { lockfile: { sha256: LOCK }, manifest: { sha256: MAN, dependencies: 3 } } }]),
    `nexus-deps-sde-node-${LOCK.slice(0, 12)}`, 'a lockfile wins');
  assert.equal(pb.depsVolumeName('sde-node', [{ ...m('zz', 3)[0] }]), null, 'a malformed hash is no key');
  assert.deepEqual(eg.egressAllowFor('sde.deps.resolve'), eg.egressAllowFor('sde.deps.node'), 'the same one registry as the lockfile install');
  const rec = getRecipe('sde.deps.resolve');
  assert.deepEqual([rec.network, rec.profiles, rec.executor, rec.argvTemplates], ['egress-approved', ['sde-node'], 'tool', ['npm.lock-only', 'npm.ci-ignore-scripts', 'entry.lock-hash-package']]);
  assert.deepEqual(pb.ARGV_TEMPLATES['npm.lock-only'], ['npm', 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund']);
  for (const id of rec.argvTemplates) assert.ok(!pb.ARGV_TEMPLATES[id].includes('--force') && !pb.ARGV_TEMPLATES[id].includes('--unsafe-perm'), id);
  // No other recipe has a network: tests, builds, try runs and the running app stay closed (the guarantee is unchanged).
  const { RECIPES } = loadTs('src/shared/nexus/recipes.ts');
  assert.deepEqual(RECIPES.filter((x) => x.network === 'egress-approved').map((x) => x.id), ['sde.deps.node', 'sde.deps.python', 'sde.deps.resolve']);
});

test('DP7 source pins: the snapshot records the package list; the build carries the add-ons key; the chain asks nothing itself (the question is main\'s approval)', () => {
  const ingest = src('src/main/nexus/exec/ingest.ts');
  assert.match(ingest, /manifest: \{ path: g\.value\.manifest\.path/);
  assert.match(ingest, /\.\.\.\(isObj\(repoMeta\) && isObj\(repoMeta\.manifest\) \? \{ manifest: repoMeta\.manifest \} : \{\}\)/);
  assert.match(ingest, /\.\.\.\(isObj\(repoMeta\) && isObj\(repoMeta\.lockfile\) \? \{ lockfile: repoMeta\.lockfile \} : \{\}\)/);
  const git = src('src/runner/git.ts');
  assert.match(git, /\['cat-file', 'blob', `\$\{commit\}:\$\{MANIFEST_PATH\}`\]/, 'the committed bytes, never the work tree');
  const prev = src('src/renderer/src/nexus/project/ProjectPreview.tsx');
  assert.doesNotMatch(prev, /approvalRespond/, 'only the approval list answers the question');
  assert.match(prev, /<ApprovalList approvals=\{depsQuestion\}/);
});
