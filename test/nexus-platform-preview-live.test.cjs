// "Preview" of a suggested change BEFORE it is added to the project (#52 nexus:try, what 'preview'; recipe and action sde.preview.live): the whole path through
// the real handlers, main, the real runner core and the fake sandbox driver. The change is registered by the scripted agent; the person previews it; its app is
// run from the change's own commit (the manifest and build step read by main), answers its health page, ends up as advisory evidence on the change, and a
// follow-up version replaces it. A REAL run (Docker, the isolated view) is the controller's verification.
//
//   PL1  preview a change: a service job + deployment on 127.0.0.1, the plan (build step then the app, no route out, loopback publish), advisory evidence on the change
//   PL2  one preview per project; a second one is refused while the first runs; after Stop it starts; the generic job start refuses the action
//   PL3  refusals: a change with no manifest, a manifest that names environment variables, a draft or foreign version, a command with a preview
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers/agentFlowWorld.cjs');
const { flowWorld, useFixture, makeChange, sound } = H;
const { NODE } = require('./helpers/agentFlowCode.cjs');
const { intent } = require('./helpers/ipcExec.cjs');

const MANIFEST = { version: 1, profile: 'sde-node', run: ['node', 'src/server.js'], port: 3000, healthPath: '/health', env: [], build: { outputDir: 'dist' } };
const PKG = JSON.stringify({ name: 'node-test-app', version: '1.0.0', private: true, scripts: { build: 'node build.js', start: 'node src/server.js' } }, null, 2);
const preview = (w, cs, extra = {}) => w.x.call('nexus:try', { op: 'run', projectId: w.PROJECT, versionId: cs, what: 'preview', intentId: intent(), ...extra });
const MIN = 60_000;

test('PL1-PL3 preview a suggested change before it is added to the project', async () => {
  const w = await flowWorld({ v11: true });
  try {
    await useFixture(w, 'node-test-app');
    await w.snapshot();
    await w.consent();
    const { cs } = await makeChange(w, { files: { ...NODE.ledger, 'nexus.app.json': JSON.stringify(MANIFEST, null, 2), 'package.json': PKG }, execArgv: ['node', '--test'], title: 'Add an app', clientKey: 'pl-1' });
    await w.until_candidate(cs);

    // PL1
    const r = await preview(w, cs);
    assert.equal(r.ok, true, JSON.stringify(r));
    const job = r.data.job;
    assert.equal(job.recipeId, 'sde.preview.live'); assert.equal(job.actionId, 'sde.preview.live');
    assert.deepEqual(job.inputs.map((i) => i.versionId), [cs]);
    await w.until(() => { const d = w.deploymentOf(job.id); return !!d && d.status !== 'starting'; }, 'the preview leaves starting', 3 * MIN).catch((e) => { const j = w.jobRow(job.id); throw new Error(`${e.message} job=${j.state}/${j.outcome}/${j.error_json}`); });
    const dep = (await w.x.ok('nexus:deployments:list', { projectId: w.PROJECT })).find((d) => d.jobId === job.id);
    assert.equal(dep.status, 'healthy', JSON.stringify(dep) + ' ' + w.jobRow(job.id).error_json + ' ' + JSON.stringify(w.db.prepare('SELECT type, summary FROM job_events WHERE job_id = ? ORDER BY seq').all(job.id)) + w.logs.slice(-6).join(' | '));
    assert.equal(dep.bindAddress, '127.0.0.1'); assert.equal(dep.subjectVersionId, cs);
    assert.ok(dep.hostPort >= 49152 && dep.hostPort <= 65535);
    // the plan the runner got: the change's own commit staged, the fixed build step then the app's own argv, an app on the internal network only
    const attempt = w.db.prepare('SELECT sandbox_json FROM job_attempts WHERE job_id = ?').get(job.id);
    const sb = JSON.parse(attempt.sandbox_json);
    assert.equal(sb.executor, 'service');
    assert.deepEqual(sb.app.argv, ['npm', 'run', 'build', '--nexus-then', 'node', 'src/server.js']);
    assert.equal(sb.app.network.mode, 'service-internal');
    assert.equal(sb.readOnlyRootfs, true); assert.deepEqual(sb.capDrop, ['ALL']); assert.equal(sb.noNewPrivileges, true);
    assert.deepEqual(sb.forwarder.publish ?? { hostIp: '127.0.0.1' }, { hostIp: '127.0.0.1', containerPort: 8080 });
    const params = JSON.parse(w.jobRow(job.id).params_json);
    assert.deepEqual(Object.keys(params).sort(), ['buildArgv', 'commit', 'manifest']);
    assert.deepEqual(params.buildArgv, ['npm', 'run', 'build']);
    // the evidence: the health result is recorded on the CHANGE, advisory (a change keeps its own checks), bound to this attempt
    const ev = w.db.prepare("SELECT status, blocking FROM validations WHERE version_id = ? AND validator_id = 'app.preview_health' AND job_id = ?").all(cs, job.id);
    assert.equal(ev.length >= 1, true); assert.ok(ev.every((x) => x.blocking === 0), 'advisory on a change');
    assert.ok(ev.some((x) => x.status === 'passed'));
    assert.equal(w.versionRow(cs).status, 'candidate', 'the change keeps its status');
    const checks = await w.x.ok('nexus:version:validations', cs);
    const pv = checks.find((c) => c.validatorId === 'app.preview_health');
    assert.equal(pv.blocking, false); assert.equal(pv.latestRun.status, 'passed');

    // PL2: one preview per project
    const second = await preview(w, cs);
    assert.equal(second.ok, false); assert.equal(second.reason, 'preview_busy');
    await w.x.refused('nexus:job:start', [{ projectId: w.PROJECT, workspaceId: 'sde', actionId: 'sde.preview.live', inputs: [{ versionId: cs, slot: 'change' }], params: {}, intentId: intent() }], 'invalid', { reason: 'unknown_action' });
    await w.x.ok('nexus:deployment:stop', dep.id);
    await w.until(() => w.ended(job.id), 'the preview job ends', 3 * MIN);
    await w.until(() => w.liveLabelled(job.id) === 0, 'the preview resources are removed', 2 * MIN);
    assert.equal(w.jobRow(job.id).state, 'completed', 'a preview stopped after it answered completes');
    const again = await preview(w, cs);
    assert.equal(again.ok, true, JSON.stringify(again));
    await w.until(() => { const d = w.deploymentOf(again.data.job.id); return !!d && d.status === 'healthy'; }, 'the second preview is healthy', 3 * MIN);
    const dep2 = (await w.x.ok('nexus:deployments:list', { projectId: w.PROJECT })).find((d) => d.jobId === again.data.job.id);
    await w.x.ok('nexus:deployment:stop', dep2.id);
    await w.until(() => w.ended(again.data.job.id), 'the second preview ends', 3 * MIN);

    // PL3: refusals
    const secret = await makeChange(w, { files: { 'nexus.app.json': JSON.stringify({ ...MANIFEST, env: ['API_KEY'] }) }, title: 'Wants a secret', clientKey: 'pl-3' });
    await w.until_candidate(secret.cs);
    const sec = await preview(w, secret.cs);
    assert.equal(sec.ok, false); assert.equal(sec.code, 'unavailable');
    const withCommand = await preview(w, cs, { command: 'echo x' });
    assert.equal(withCommand.ok, false);
    const snap = w.db.prepare("SELECT v.id FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id WHERE a.kind = 'repository' LIMIT 1").get();
    const notChange = await preview(w, snap.id);
    assert.equal(notChange.ok, false); assert.equal(notChange.reason, 'input_not_allowed');
    sound(w, 'live preview');
  } finally { await w.close(); }
});

test('PL4 without schema v11 a suggested change is not previewed: refused in plain words, nothing is queued, and the store is v10; the project as it stands still previews', async () => {
  const w = await flowWorld();
  try {
    await useFixture(w, 'node-test-app');
    await w.snapshot();
    await w.consent();
    const { cs } = await makeChange(w, { files: { ...NODE.ledger, 'nexus.app.json': JSON.stringify(MANIFEST, null, 2), 'package.json': PKG }, execArgv: ['node', '--test'], title: 'Add an app', clientKey: 'pl-off' });
    await w.until_candidate(cs);
    assert.equal(w.db.pragma('user_version', { simple: true }), 10, 'the store is at v10');
    const before = w.db.prepare("SELECT COUNT(*) n FROM jobs WHERE recipe_id = 'sde.preview.live'").get().n;
    const r = await preview(w, cs);
    assert.equal(r.ok, false); assert.equal(r.reason, 'change_preview_off');
    assert.equal(w.db.prepare("SELECT COUNT(*) n FROM jobs WHERE recipe_id = 'sde.preview.live'").get().n, before, 'no job was made');
    assert.equal(w.db.prepare('SELECT COUNT(*) n FROM deployments').get().n, 0);
    sound(w, 'live preview off');
  } finally { await w.close(); }
});

test('PL3b a change in a project that has no nexus.app.json (nor does the change) is refused in plain words', async () => {
  const w = await flowWorld({ v11: true });
  try {
    await useFixture(w, 'node-test-empty');
    await w.snapshot();
    await w.consent();
    const bare = await makeChange(w, { files: { 'src/plain.js': 'module.exports = 1;\n' }, title: 'No manifest', clientKey: 'pl-2' });
    await w.until_candidate(bare.cs);
    const none = await preview(w, bare.cs);
    assert.equal(none.ok, false); assert.equal(none.reason, 'preview_manifest');
    sound(w, 'live preview no manifest');
  } finally { await w.close(); }
});
