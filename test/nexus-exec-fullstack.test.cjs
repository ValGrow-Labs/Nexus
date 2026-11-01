'use strict';
// Live preview phase 3 on REAL Docker with the pinned images and the REAL package registry: a full-stack app in ONE container (an API, the page and a SQLite file
// database through node-sqlite3-wasm), installed with the person's OK, built, and run in the safe space. The database file lives in the run's own copy of the
// project, answers across requests, and is gone with the run. The published port is on 127.0.0.1 only. Runs only behind the test:exec gate.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { realDockerOrSkip } = require('./helpers/execGate.cjs');

if (realDockerOrSkip()) {
  const { realWorld, docker } = require('./helpers/execReal.cjs');
  const { jobEnds, produced, versionSettles, assemble, deploy, stop } = require('./helpers/recipeFlows.cjs');
  const LONG = { timeout: 25 * 60_000 };
  let w = null;
  const world = async () => { if (!w) w = await realWorld(); return w; };
  test.after(async () => { if (w) await w.close(); });

  const pending = (x, jobId) => x.db.prepare("SELECT * FROM approvals WHERE job_id = ? AND status = 'pending'").get(jobId);
  const call = (port, method, path, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: body ? { 'content-type': 'application/json' } : {} }, (r) => {
      let t = ''; r.on('data', (c) => { t += c; }); r.on('end', () => resolve({ status: r.statusCode, text: t }));
    });
    req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
  });

  test('FS1 a full-stack app (API + page + SQLite file) in one container: installed once with the OK, built, healthy through its database, data kept across requests, loopback only, gone with the run', LONG, async () => {
    const x = await world();
    await x.useFixture('node-fullstack-app');
    const snap = await x.snapshot();
    const meta = JSON.parse(x.version(snap.versionId).metadata_json);
    assert.equal(meta.lockfile, undefined);
    assert.equal(meta.manifest.dependencies, 1);

    const j = x.start('sde.deps.prepare', { inputs: [{ versionId: snap.versionId, slot: 'repository' }] });
    await x.until(() => !!pending(x, j.id), 'the question is waiting', 3 * 60_000);
    x.nx.approvals.respond(x.me, pending(x, j.id).id, 'once');
    const ended = await jobEnds(x, j.id, 15 * 60_000);
    assert.equal(ended.state, 'completed', `the install completed (${ended.outcome} ${ended.error_json})`);

    const b = x.start('sde.build.run', { inputs: [{ versionId: snap.versionId, slot: 'repository' }] });
    assert.equal((await jobEnds(x, b.id)).state, 'completed');
    const bv = await versionSettles(x, produced(x, b.id, 'dist').id);
    const a = await assemble(x, bv.id);
    const d = await deploy(x, a.version.id);
    // The health page asks the database: healthy means the SQLite file opened and answered inside the container.
    assert.equal(d.deployment.status, 'healthy', `healthy (${d.deployment.stop_reason ?? ''})`);
    assert.equal(d.deployment.bind_address, '127.0.0.1');
    const port = d.deployment.host_port;
    assert.equal((await call(port, 'GET', '/health')).status, 200);
    assert.deepEqual(JSON.parse((await call(port, 'GET', '/api/notes')).text), [], 'a fresh run starts with an empty database');
    assert.equal((await call(port, 'POST', '/api/notes', { text: 'first note' })).status, 201);
    assert.equal((await call(port, 'POST', '/api/notes', { text: 'second note' })).status, 201);
    assert.equal((await call(port, 'POST', '/api/notes', {})).status, 400, 'a bad request is refused by the app');
    const rows = JSON.parse((await call(port, 'GET', '/api/notes')).text);
    assert.deepEqual(rows.map((r) => r.text), ['first note', 'second note'], 'the data is kept across requests');
    assert.match((await call(port, 'GET', '/')).text, /<h1>Notes<\/h1>/, 'the page of the same process');

    // One container for the app (and the loopback forwarder beside it); the app's own network is internal: no route out. The database file is inside the run.
    const rec = JSON.parse(x.attemptsOf(d.jobId).pop().sandbox_json);
    assert.equal(rec.app.network.mode, 'service-internal');
    assert.ok(rec.app.mounts.some((m) => m.kind === 'workspace' && m.readOnly === false), 'the run has its own writable copy of the project');
    assert.ok(rec.app.mounts.some((m) => m.kind === 'deps' && m.readOnly === true), 'the add-ons are read-only');
    const names = docker(['ps', '--filter', `label=nexus.job=${d.jobId}`, '--format', '{{.Names}}']).stdout.split(/\r?\n/).filter(Boolean);
    assert.equal(names.filter((n) => /-app$/.test(n)).length, 1, `one app container: ${names.join(',')}`);
    await stop(x, d.deployment.id, d.jobId);
    assert.equal(x.liveLabelled(d.jobId), 0, 'the run, its copy of the project and its database are removed');
  });
}
