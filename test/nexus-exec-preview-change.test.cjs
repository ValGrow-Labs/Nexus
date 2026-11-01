'use strict';
// Live preview of a SUGGESTED CHANGE on REAL Docker (schema v11): the app of a change that is not yet in the project is run from the change's own commit (the
// fixed build step runs in the container, then the app), on 127.0.0.1 only, and a follow-up version replaces the running preview. The project's own files and
// branch are never touched. Runs only behind the test:exec gate (a scripted agent stands in for the model; the Docker is real).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { realDockerOrSkip } = require('./helpers/execGate.cjs');

if (realDockerOrSkip()) {
  const H = require('./helpers/agentFlowWorld.cjs');
  const { flowWorld, useFixture, makeChange, sound } = H;
  const { intent } = require('./helpers/ipcExec.cjs');
  const LONG = { timeout: 25 * 60_000 };
  const MIN = 60_000;
  const get = (port, p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (r) => { let t = ''; r.on('data', (c) => { t += c; }); r.on('end', () => resolve({ status: r.statusCode, text: t })); }).on('error', reject);
  });
  const dockerPs = (jobId) => cp.spawnSync('docker', ['ps', '-a', '--filter', `label=nexus.job=${jobId}`, '--format', '{{.Names}} {{.State}}'], { encoding: 'utf8' }).stdout.split(/\r?\n/).filter(Boolean);
  const previewOf = (w, cs) => w.x.call('nexus:try', { op: 'run', projectId: w.PROJECT, versionId: cs, what: 'preview', intentId: intent() });
  const handler = (text) => fs.readFileSync(path.join(__dirname, 'fixtures', 'exec', 'node-test-app', 'src', 'handler.js.tpl'), 'utf8').replace('hello from node-test-app', text);
  const git = (dir, ...a) => cp.spawnSync('git', a, { cwd: dir, encoding: 'utf8' }).stdout.trim();

  test('PC1 a suggested change is previewed before it is added (built in the container from its own commit, loopback only); a follow-up replaces the running preview; the project is untouched', LONG, async () => {
    const w = await flowWorld({ real: true, v11: true });
    try {
      await useFixture(w, 'node-test-app');
      await w.snapshot();
      await w.consent();
      const head = git(w.repoDir, 'rev-parse', 'HEAD');
      const before = fs.readFileSync(path.join(w.repoDir, 'src', 'handler.js'), 'utf8');

      const c1 = await makeChange(w, { files: { 'src/handler.js': handler('hello from the first suggestion') }, title: 'First suggestion', clientKey: 'pc-1' });
      await w.until_candidate(c1.cs);
      const r1 = await previewOf(w, c1.cs);
      assert.equal(r1.ok, true, JSON.stringify(r1));
      const job1 = r1.data.job.id;
      await w.until(() => { const d = w.deploymentOf(job1); return !!d && d.status !== 'starting'; }, 'the first preview leaves starting', 5 * MIN);
      const d1 = w.deploymentOf(job1);
      assert.equal(d1.status, 'healthy', `healthy (${d1.stop_reason ?? ''})`);
      assert.equal(d1.bind_address, '127.0.0.1');
      assert.equal(d1.subject_version_id, c1.cs, 'the deployment is of the change');
      assert.equal((await get(d1.host_port, '/health')).status, 200);
      const page1 = await get(d1.host_port, '/');
      assert.match(page1.text, /hello from the first suggestion/, 'the page was built from the change, not from the project');

      // The project as it stands was never touched: same commit, same file, nothing added.
      assert.equal(git(w.repoDir, 'rev-parse', 'HEAD'), head);
      assert.equal(fs.readFileSync(path.join(w.repoDir, 'src', 'handler.js'), 'utf8'), before);
      assert.equal(git(w.repoDir, 'status', '--porcelain'), '', 'the project folder has no changes');
      assert.equal(w.versionRow(c1.cs).status, 'candidate', 'the change is still waiting for review');
      const ev = w.db.prepare("SELECT status, blocking FROM validations WHERE version_id = ? AND validator_id = 'app.preview_health' AND job_id = ?").all(c1.cs, job1);
      assert.ok(ev.length >= 1 && ev.every((x) => x.blocking === 0) && ev.some((x) => x.status === 'passed'), 'advisory evidence on the change');

      // One app container (and the loopback forwarder); the app is on an internal network only.
      const names1 = dockerPs(job1);
      assert.equal(names1.filter((n) => /-app /.test(n)).length, 1, names1.join(','));
      const sb = JSON.parse(w.db.prepare('SELECT sandbox_json FROM job_attempts WHERE job_id = ?').get(job1).sandbox_json);
      assert.equal(sb.app.network.mode, 'service-internal');
      assert.deepEqual(sb.app.argv.slice(0, 4), ['npm', 'run', 'build', '--nexus-then']);

      // A second preview while the first runs is refused; a follow-up version replaces the running one (the page stops the first, then starts the next).
      const busy = await previewOf(w, c1.cs);
      assert.equal(busy.ok, false); assert.equal(busy.reason, 'preview_busy');
      const c2 = await makeChange(w, { files: { 'src/handler.js': handler('hello from the follow-up') }, title: 'Follow-up', clientKey: 'pc-2', sessionId: c1.turn.sessionId });
      await w.until_candidate(c2.cs);
      await w.x.ok('nexus:deployment:stop', w.db.prepare('SELECT id FROM deployments WHERE job_id = ?').get(job1).id);
      await w.until(() => w.ended(job1), 'the first preview ends', 3 * MIN);
      await w.until(() => dockerPs(job1).length === 0, 'the first preview containers are removed', 2 * MIN);
      const r2 = await previewOf(w, c2.cs);
      assert.equal(r2.ok, true, JSON.stringify(r2));
      const job2 = r2.data.job.id;
      await w.until(() => { const d = w.deploymentOf(job2); return !!d && d.status !== 'starting'; }, 'the follow-up preview leaves starting', 5 * MIN);
      const d2 = w.deploymentOf(job2);
      assert.equal(d2.status, 'healthy', `healthy (${d2.stop_reason ?? ''})`);
      assert.match((await get(d2.host_port, '/')).text, /hello from the follow-up/, 'the running preview now shows the follow-up');
      assert.equal(git(w.repoDir, 'rev-parse', 'HEAD'), head, 'still nothing added to the project');

      await w.x.ok('nexus:deployment:stop', d2.id);
      await w.until(() => w.ended(job2), 'the follow-up preview ends', 3 * MIN);
      await w.until(() => dockerPs(job2).length === 0, 'its containers are removed', 2 * MIN);
      sound(w, 'preview change');
    } finally { await w.close(); }
  });
}
