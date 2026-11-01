'use strict';
// Live preview phase 2 on REAL Docker with the pinned images and the REAL package registry: an app that lists an add-on (ms) and has no lockfile is installed
// with the person's OK (ONE approved job, lock-only then install, through the registry-only proxy), then built and run with it. It needs the internet through
// that proxy, so it also checks the registry is reachable first (a failed check fails: nothing passes silently). Runs only behind the test:exec gate.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { realDockerOrSkip } = require('./helpers/execGate.cjs');

if (realDockerOrSkip()) {
  const { realWorld, docker } = require('./helpers/execReal.cjs');
  const { jobEnds, produced, versionSettles, assemble, deploy, stop } = require('./helpers/recipeFlows.cjs');
  const LONG = { timeout: 25 * 60_000 };
  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'infra', 'images', 'lock.json'), 'utf8'));
  const nodeImage = `nexus-local/sde-node:${lock.profiles['sde-node'].contextSha256.slice(0, 12)}`;
  let w = null;
  const world = async () => { if (!w) w = await realWorld(); return w; };
  test.after(async () => { if (w) await w.close(); });

  const pending = (x, jobId) => x.db.prepare("SELECT * FROM approvals WHERE job_id = ? AND status = 'pending'").get(jobId);
  const volumeList = (name) => docker(['run', '--rm', '--entrypoint', 'ls', '-v', `${name}:/m:ro`, nodeImage, '/m']).stdout.split(/\r?\n/).filter(Boolean);
  const events = (x, jobId) => x.db.prepare('SELECT summary FROM job_events WHERE job_id = ? ORDER BY seq').all(jobId).map((e) => e.summary);

  test('DX0 the package registry answers over HTTPS from this computer (the install itself goes through the Nexus proxy only)', LONG, async () => {
    const res = await fetch('https://registry.npmjs.org/ms', { method: 'HEAD' });
    assert.equal(res.status, 200);
  });

  test('DX1 an app with add-ons and no lockfile: asked once, installed through the proxy (the one registry only), built with it, run with it; asked never again for the same list', LONG, async () => {
    const x = await world();
    await x.useFixture('node-deps-app');
    const snap = await x.snapshot();
    const meta = JSON.parse(x.version(snap.versionId).metadata_json);
    assert.equal(meta.lockfile, undefined, 'the project has no lockfile');
    assert.deepEqual([meta.manifest.path, meta.manifest.dependencies], ['package.json', 1]);
    assert.match(meta.manifest.sha256, /^[0-9a-f]{64}$/);

    // The question: nothing runs and nothing is downloaded before the answer.
    const j = x.start('sde.deps.prepare', { inputs: [{ versionId: snap.versionId, slot: 'repository' }] });
    assert.equal(j.recipeId ?? x.job(j.id).recipe_id, 'sde.deps.resolve');
    await x.until(() => !!pending(x, j.id), 'the question is waiting', 3 * 60_000);
    assert.equal(x.attemptsOf(j.id).filter((a) => a.container_id).length, 0, 'no container before the answer');
    const ap = pending(x, j.id);
    assert.equal(JSON.parse(ap.request_json).manifestSha256, meta.manifest.sha256);
    assert.deepEqual(JSON.parse(ap.request_json).registries, ['registry.npmjs.org']);
    x.nx.approvals.respond(x.me, ap.id, 'once');
    const ended = await jobEnds(x, j.id, 15 * 60_000);
    assert.equal(ended.state, 'completed', `the install completed (${ended.outcome} ${ended.error_json}) ${events(x, j.id).join(' | ')}`);

    // The add-ons are in the cache volume named by the package list; only the one registry was reached; the evidence passed.
    const volName = `nexus-deps-sde-node-${meta.manifest.sha256.slice(0, 12)}`;
    assert.ok(volumeList(volName).includes('ms'), 'ms is installed in the add-ons volume');
    const ev = events(x, j.id).filter((s) => /egress/.test(s));
    assert.ok(ev.some((s) => /egress allowed registry\.npmjs\.org:443/.test(s)), `the registry was reached: ${ev.join(' | ')}`);
    for (const s of ev) if (/allowed/.test(s)) assert.match(s, /registry\.npmjs\.org:443/, 'nothing else was allowed');
    const row = x.db.prepare("SELECT * FROM validations WHERE validator_id = 'sde.deps.lock_matches' AND job_id = ?").get(j.id);
    assert.equal(row.status, 'passed');

    // Asked once: the same list is not asked again (a second press builds straight away).
    assert.throws(() => x.start('sde.deps.prepare', { inputs: [{ versionId: snap.versionId, slot: 'repository' }] }), (e) => e.detail?.reason === 'deps_ready');

    // The build needs the add-on (it requires ms): it ran with the volume mounted read-only and no network.
    const b = x.start('sde.build.run', { inputs: [{ versionId: snap.versionId, slot: 'repository' }] });
    const bj = await jobEnds(x, b.id);
    assert.equal(bj.state, 'completed', `the build completed (${bj.outcome} ${bj.error_json})`);
    const bv = await versionSettles(x, produced(x, b.id, 'dist').id);
    assert.ok(['candidate', 'active'].includes(bv.status));
    assert.equal(JSON.parse(bv.metadata_json).manifest.sha256, meta.manifest.sha256, 'the build carries the add-ons key');
    const bAttempt = x.attemptsOf(b.id).pop();
    const rec = JSON.parse(bAttempt.sandbox_json);
    assert.equal(rec.network?.mode ?? rec.network, 'none', 'the build has no network');
    assert.ok(rec.mounts.some((m) => m.kind === 'deps' && m.readOnly === true), `the add-ons are mounted read-only ${JSON.stringify(rec.mounts)}`);

    // The preview runs with them (the app requires ms at run time) and answers on the loopback port only.
    const a = await assemble(x, bv.id);
    const d = await deploy(x, a.version.id);
    assert.equal(d.deployment.status, 'healthy', `healthy (${d.deployment.stop_reason ?? ''})`);
    assert.equal(d.deployment.bind_address, '127.0.0.1');
    assert.equal(await x.httpGet(d.deployment.host_port, '/health'), 200);
    const body = await new Promise((resolve, reject) => require('node:http').get({ host: '127.0.0.1', port: d.deployment.host_port, path: '/uptime' }, (r) => {
      let t = ''; r.on('data', (c) => { t += c; }); r.on('end', () => resolve(t));
    }).on('error', reject));
    assert.match(body, /^running for \d+m?s \(ms 60000\)$/, 'the add-on works inside the running app');
    const page = await new Promise((resolve, reject) => require('node:http').get({ host: '127.0.0.1', port: d.deployment.host_port, path: '/' }, (r) => {
      let t = ''; r.on('data', (c) => { t += c; }); r.on('end', () => resolve(t));
    }).on('error', reject));
    assert.match(page, /built with ms: two hours is 2h/);
    await stop(x, d.deployment.id, d.jobId);
  });

  test('DX2 not allowed -> nothing is downloaded and the job says so; an add-on that does not exist -> the install fails in plain terms and is never counted as ready', LONG, async () => {
    const x = await world();
    const pkg = JSON.parse(x.fixtureFile('node-deps-app', 'package.json'));
    await x.useFixture('node-deps-app', { 'package.json': JSON.stringify({ ...pkg, dependencies: { ms: '2.1.2' } }, null, 2) });
    const snap = await x.snapshot();
    const meta = JSON.parse(x.version(snap.versionId).metadata_json);
    const j = x.start('sde.deps.prepare', { inputs: [{ versionId: snap.versionId, slot: 'repository' }] });
    await x.until(() => !!pending(x, j.id), 'the question is waiting', 3 * 60_000);
    x.nx.approvals.respond(x.me, pending(x, j.id).id, 'deny');
    const ended = await jobEnds(x, j.id, 3 * 60_000);
    assert.equal(ended.state, 'failed');
    assert.equal(JSON.parse(ended.error_json).code, 'approval_denied');
    assert.equal(x.attemptsOf(j.id).filter((a) => a.container_id).length, 0, 'nothing ran');
    assert.ok(!events(x, j.id).some((s) => /egress allowed/.test(s)), 'nothing was downloaded');

    const pkg2 = { ...pkg, dependencies: { 'nexus-no-such-package-zz9': '1.0.0' } };
    await x.useFixture('node-deps-app', { 'package.json': JSON.stringify(pkg2, null, 2) });
    const snap2 = await x.snapshot();
    const j2 = x.start('sde.deps.prepare', { inputs: [{ versionId: snap2.versionId, slot: 'repository' }] });
    await x.until(() => !!pending(x, j2.id), 'the second question is waiting', 3 * 60_000);
    x.nx.approvals.respond(x.me, pending(x, j2.id).id, 'once');
    const e2 = await jobEnds(x, j2.id, 10 * 60_000);
    assert.equal(e2.state, 'failed', `a missing package fails the install (${e2.outcome})`);
    assert.notEqual(JSON.parse(e2.error_json).code, 'approval_denied');
    // A failed install is not "ready": the same list asks again.
    const again = x.start('sde.deps.prepare', { inputs: [{ versionId: snap2.versionId, slot: 'repository' }] });
    assert.equal(x.job(again.id).recipe_id, 'sde.deps.resolve');
    x.nx.jobs?.cancel?.(x.me, again.id);
    void meta;
  });
}
