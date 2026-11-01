'use strict';
// A Machine learning project's results (#54 nexus:results; phase 3) through the real handler, main's ResultsService, a real v9 database and
// a REAL file system under a temp data home. Main's Save window is faked at its one port (`pickResultSavePath`: the test hands the location
// the window would answer); everything after it is the real code. No Docker (a FakeRunner takes the plans).
//   PR1  only a Machine learning project has "Results" (list answers applies:false elsewhere; read, save, remove and clear are refused)
//   PR2  through the real handler: list (flat, newest first, left-out files counted), read a report (inert text) and a chart (a PNG data
//        URL), save through main's window (byte for byte; the answer names no location), remove, clear; no host path ever crosses
//   PR3  the request is checked strictly (no extra key, a result id of 32 hex characters only, no id with list or clear, no location)
//   PR4  the rate limits (saves, removes and clears; reads) with the plain sentence
//   PR5  delivery: the project's runs in the ML kit carry exactly one READ-WRITE /results mount of its own folder (next to the read-only
//        /data); once it is not ML, none
//   PR6  the AI helper's context file (the platform's own composition): an ML project gets "How to work on a data question" once, after the
//        Datasets block and before the domain; the line about the 1 GB limit only when the folder is over it; the honest line when the
//        helper does not get the machine learning kit; nothing for another project
const h = require('./helpers/sqlite.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');

if (h.realSqliteOrSkip()) {
  const fs = require('node:fs');
  const path = require('node:path');
  const loadTs = require('./load-ts.cjs');
  const { execWorld } = require('./helpers/execWorld.cjs');
  const { FakeRunner } = require('./helpers/fakeRunner.cjs');
  const { ipcOver } = require('./helpers/ipcExec.cjs');
  const { agentWorld } = require('./helpers/agentFixtures.cjs');
  const R = loadTs('src/shared/nexus/results.ts');
  const C = loadTs('src/main/nexus/results/resultsContext.ts');
  const { resultIdOf } = loadTs('src/main/nexus/results/resultsService.ts');
  const { RESULT_WRITES_PER_WINDOW, RESULT_READS_PER_WINDOW } = loadTs('src/main/nexusIpc/registerNexusIpc.ts');
  const { newId } = loadTs('src/main/nexus/db/ids.ts');

  const ML_IMAGE = 'sha256:' + '4'.repeat(64);
  const IMAGES = [{ profile: 'sde-node', present: true, digestMatches: true, imageId: 'sha256:' + '1'.repeat(64) },
    { profile: 'sde-python', present: true, digestMatches: true, imageId: 'sha256:' + '2'.repeat(64) },
    { profile: 'ml-python', present: true, digestMatches: true, imageId: ML_IMAGE }];
  const MSG = R.RESULT_REASON_MESSAGES;
  const ch = (n) => String.fromCharCode(n);
  function png(width, height, pad = 64) {
    const ihdr = Buffer.alloc(25);
    ihdr.writeUInt32BE(13, 0); ihdr.write('IHDR', 4, 'latin1'); ihdr.writeUInt32BE(width, 8); ihdr.writeUInt32BE(height, 12); ihdr[16] = 8; ihdr[17] = 2;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.alloc(pad, 7)]);
  }

  function makeMl(w, projectId = 'p-ledger') {
    w.db.transaction(() => {
      w.db.prepare('UPDATE project_workspaces SET is_primary = 0 WHERE project_id = ? AND is_primary = 1').run(projectId);
      const row = w.db.prepare("SELECT id FROM project_workspaces WHERE project_id = ? AND workspace_id = 'ml'").get(projectId);
      if (row) w.db.prepare("UPDATE project_workspaces SET status = 'active', is_primary = 1 WHERE id = ?").run(row.id);
      else w.db.prepare(`INSERT INTO project_workspaces (id, project_id, workspace_id, objective, status, is_primary, source, created_by, created_at, updated_at)
        VALUES (?, ?, 'ml', NULL, 'active', 1, 'user', 'user:local', ?, ?)`).run(`pw-ml-${projectId}`, projectId, w.now(), w.now());
    })();
  }
  function notMl(w, projectId = 'p-ledger') {
    w.db.prepare("UPDATE project_workspaces SET is_primary = 0 WHERE project_id = ? AND workspace_id = 'ml'").run(projectId);
    w.db.prepare("UPDATE project_workspaces SET is_primary = 1 WHERE project_id = ? AND workspace_id = 'sde'").run(projectId);
  }
  function world(o = {}) {
    const w = execWorld({ ml: true, profile: 'sde-python', images: IMAGES });
    const r = new FakeRunner(); w.exec.attachRunner(r, w.bootId);
    if (o.ml !== false) makeMl(w);
    w.runner = r;
    w.saves = []; w.asked = [];
    w.x = ipcOver(w, { pickResultSavePath: async (name) => { w.asked.push(name); return w.saves.length ? w.saves.shift() : null; } });
    w.dir = path.join(w.dataHome.root, 'results', 'p-ledger', 'files');
    let t = 1_780_000_000;
    w.put = (name, content) => { fs.mkdirSync(w.dir, { recursive: true }); const p = path.join(w.dir, name); fs.writeFileSync(p, content); t += 60; fs.utimesSync(p, t, t); return p; };
    w.out = h.tmpDir('nx-rs-out-');
    w.res = (args) => w.x.call('nexus:results', { projectId: 'p-ledger', ...args });
    w.list = () => w.x.ok('nexus:results', { op: 'list', projectId: 'p-ledger' });
    return w;
  }
  const refusedWith = (r, reason) => {
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.reason, reason, JSON.stringify(r));
    assert.equal(r.message, MSG[reason], 'the plain sentence');
  };
  const NO_LOCATION = /[A-Za-z]:\\|AppData|nx-home|nx-rs-out|results[\\/]p-ledger|"path"|"hostPath"|"target"/;

  test('PR1 only a Machine learning project has "Results": list says applies:false elsewhere; read, save, remove and clear are refused', async () => {
    const w = world({ ml: false });
    try {
      w.put('report.md', '# x\n');
      assert.deepEqual(await w.list(), { applies: false, results: [], skipped: 0, more: 0, totalBytes: 0, overLimit: false });
      const id = resultIdOf('report.md');
      for (const op of ['read', 'save', 'remove']) refusedWith(await w.res({ op, resultId: id }), 'results_not_ml');
      refusedWith(await w.res({ op: 'clear' }), 'results_not_ml');
      assert.deepEqual(w.asked, [], 'no window opens for a project that is not ML');
      assert.equal(fs.existsSync(path.join(w.dir, 'report.md')), true, 'nothing removed');
      makeMl(w);
      assert.equal((await w.list()).results.length, 1);
    } finally { w.close(); }
  });

  test('PR2 through the real handler: list, read a report and a chart, save through main\'s window, remove and clear; no location crosses', async () => {
    const w = world();
    try {
      assert.deepEqual(await w.list(), { applies: true, results: [], skipped: 0, more: 0, totalBytes: 0, overLimit: false }, 'no folder yet: nothing');
      w.put('report.md', `# Who leaves${ch(0x202e)}\n\n<script>alert(1)</script>\n\n- **Accuracy**: 0.91\n`);
      const chart = png(320, 200, 500);
      w.put('churn_by_plan.png', chart);
      w.put('fake.png', '<svg onload=alert(1)>');
      w.put('model.joblib', Buffer.from([0x80, 4, 0x95]));
      w.put('predictions.csv', 'id,p\n1,0.3\n');
      w.put('index.html', '<script>alert(1)</script>');
      fs.symlinkSync(path.join(w.dir, 'report.md'), path.join(w.dir, 'alias.md'), 'file');
      const l = await w.list();
      assert.deepEqual(l.results.map((r) => [r.name, r.kind, r.shown, r.tooBig]),
        [['predictions.csv', 'table', false, false], ['model.joblib', 'model', false, false], ['fake.png', 'file', false, false], ['churn_by_plan.png', 'chart', true, false], ['report.md', 'report', true, false]]);
      assert.equal(l.skipped, 2, 'the HTML file and the link');
      for (const r of l.results) { assert.match(r.id, /^[0-9a-f]{32}$/); assert.deepEqual(Object.keys(r).sort(), ['bytes', 'id', 'kind', 'modifiedAt', 'name', 'shown', 'tooBig']); }
      assert.doesNotMatch(JSON.stringify(l), NO_LOCATION);
      // Read: the report as inert text (cleaned), the chart as a PNG data URL of those bytes.
      const rep = await w.x.ok('nexus:results', { op: 'read', projectId: 'p-ledger', resultId: resultIdOf('report.md') });
      assert.equal(rep.content.kind, 'report');
      assert.ok(rep.content.text.includes('<script>alert(1)</script>'), 'kept as letters; the renderer shows it as text');
      assert.ok(!rep.content.text.includes(ch(0x202e)));
      assert.equal(rep.results.length, 5, 'every answer carries the fresh list');
      const c = await w.x.ok('nexus:results', { op: 'read', projectId: 'p-ledger', resultId: resultIdOf('churn_by_plan.png') });
      assert.deepEqual(Buffer.from(c.content.dataUrl.replace('data:image/png;base64,', ''), 'base64'), chart);
      refusedWith(await w.res({ op: 'read', resultId: resultIdOf('fake.png') }), 'results_not_shown');
      refusedWith(await w.res({ op: 'read', resultId: resultIdOf('model.joblib') }), 'results_not_shown');
      refusedWith(await w.res({ op: 'read', resultId: resultIdOf('index.html') }), 'results_not_found');
      refusedWith(await w.res({ op: 'read', resultId: resultIdOf('alias.md') }), 'results_not_found');
      // Save: main's window is offered the plain name; the copy is exact; the answer names no location.
      const dest = path.join(w.out, 'churn model.joblib');
      w.saves.push(dest);
      const saved = await w.x.ok('nexus:results', { op: 'save', projectId: 'p-ledger', resultId: resultIdOf('model.joblib') });
      assert.equal(saved.saved, true);
      assert.deepEqual(w.asked, ['model.joblib']);
      assert.deepEqual(fs.readFileSync(dest), Buffer.from([0x80, 4, 0x95]));
      assert.doesNotMatch(JSON.stringify(saved), NO_LOCATION);
      const cancelled = await w.x.ok('nexus:results', { op: 'save', projectId: 'p-ledger', resultId: resultIdOf('report.md') });
      assert.equal(cancelled.cancelled, true, 'a closed window saves nothing');
      w.saves.push(path.join(w.dataHome.root, 'x.md'));
      refusedWith(await w.res({ op: 'save', resultId: resultIdOf('report.md') }), 'results_save_inside');
      w.asked.length = 0;
      refusedWith(await w.res({ op: 'save', resultId: resultIdOf('index.html') }), 'results_not_found');
      assert.deepEqual(w.asked, [], 'no window for an id the listing does not hold');
      // Remove and clear.
      const removed = await w.x.ok('nexus:results', { op: 'remove', projectId: 'p-ledger', resultId: resultIdOf('fake.png') });
      assert.equal(removed.removed, true);
      assert.equal(removed.results.some((r) => r.name === 'fake.png'), false);
      refusedWith(await w.res({ op: 'remove', resultId: resultIdOf('alias.md') }), 'results_not_found');
      assert.equal(fs.existsSync(path.join(w.dir, 'report.md')), true, 'the link was not followed');
      const cleared = await w.x.ok('nexus:results', { op: 'clear', projectId: 'p-ledger' });
      assert.equal(cleared.cleared, 6, 'five files and the link');
      assert.deepEqual(cleared.results, []);
      assert.deepEqual(fs.readdirSync(w.dir), []);
      assert.deepEqual(fs.readFileSync(dest), Buffer.from([0x80, 4, 0x95]), 'the saved copy is the person\'s and stays');
    } finally { w.close(); }
  });

  test('PR3 the request is checked strictly: no extra key, a 32-hex result id only, no id with list or clear, no location', async () => {
    const w = world();
    try {
      w.put('report.md', 'x');
      const bad = async (args) => { const r = await w.x.call('nexus:results', args); assert.equal(r.ok, false, JSON.stringify(args)); assert.equal(r.code, 'invalid', JSON.stringify(r)); };
      await bad({ op: 'list', projectId: 'p-ledger', path: 'C:/x' });
      await bad({ op: 'list', projectId: 'p-ledger', resultId: resultIdOf('report.md') });
      await bad({ op: 'clear', projectId: 'p-ledger', resultId: resultIdOf('report.md') });
      await bad({ op: 'read', projectId: 'p-ledger' });
      await bad({ op: 'read', projectId: 'p-ledger', resultId: 'report.md' });
      await bad({ op: 'read', projectId: 'p-ledger', resultId: '../../secret' });
      await bad({ op: 'read', projectId: 'p-ledger', resultId: 'F'.repeat(32) });
      await bad({ op: 'read', projectId: 'p-ledger', resultId: 'f'.repeat(33) });
      await bad({ op: 'save', projectId: 'p-ledger', resultId: resultIdOf('report.md'), target: 'C:/Users/x/a.md' });
      await bad({ op: 'open', projectId: 'p-ledger' });
      await bad({ op: 'list', projectId: '../p-ledger' });
      const extra = await w.x.call('nexus:results', { op: 'list', projectId: 'p-ledger' }, 'more');
      assert.equal(extra.ok, false);
      assert.deepEqual(w.asked, []);
    } finally { w.close(); }
  });

  test('PR4 the rate limits: at most RESULT_WRITES_PER_WINDOW saves, removes and clears and RESULT_READS_PER_WINDOW reads a minute; a list is free', async () => {
    const w = world();
    try {
      w.put('report.md', '# r\n');
      for (let i = 0; i < RESULT_WRITES_PER_WINDOW; i++) assert.equal((await w.res({ op: 'save', resultId: resultIdOf('report.md') })).ok, true);
      refusedWith(await w.res({ op: 'save', resultId: resultIdOf('report.md') }), 'results_rate');
      refusedWith(await w.res({ op: 'clear' }), 'results_rate');
      for (let i = 0; i < RESULT_READS_PER_WINDOW; i++) assert.equal((await w.res({ op: 'read', resultId: resultIdOf('report.md') })).ok, true, `read ${i}`);
      refusedWith(await w.res({ op: 'read', resultId: resultIdOf('report.md') }), 'results_rate');
      for (let i = 0; i < 50; i++) await w.list();
    } finally { w.close(); }
  });

  test('PR5 delivery: an ML project\'s runs carry exactly one read-write /results mount of its own folder (and /data read-only); once it is not ML, none', async () => {
    const w = world();
    try {
      const { job } = w.exec.start(w.me, w.req('sde.tests.discover'));
      w.exec.tick(w.now());
      const plan = w.runner.lastStart().plan;
      assert.equal(plan.container.profile, 'ml-python');
      assert.deepEqual(plan.container.mounts.filter((m) => m.kind === 'results' || m.containerPath === '/results'),
        [{ kind: 'results', hostPath: path.join(w.dataHome.root, 'results', 'p-ledger', 'files'), containerPath: '/results', readOnly: false }]);
      assert.deepEqual(plan.container.mounts.filter((m) => m.containerPath === '/data').map((m) => [m.kind, m.readOnly]), [['datasets', true]]);
      const rec = JSON.parse(w.db.prepare('SELECT sandbox_json FROM job_attempts WHERE job_id = ?').get(job.id).sandbox_json);
      assert.deepEqual(rec.mounts.filter((m) => m.kind === 'results'), [{ kind: 'results', containerPath: '/results', readOnly: false }], 'the record names no host path');
      notMl(w);
      w.clock.t += 60_000;
      const { job: job2 } = w.exec.start(w.me, w.req('sde.tests.discover'));
      w.exec.tick(w.now());
      const plan2 = w.runner.lastStart().plan;
      assert.equal(plan2.jobId, job2.id);
      assert.equal(plan2.container.profile, 'sde-python');
      assert.deepEqual(plan2.container.mounts.filter((m) => m.kind === 'results' || m.containerPath === '/results'), []);
    } finally { w.close(); }
  });

  test('PR6 the AI helper\'s context: "How to work on a data question" once for an ML project, after the data and before the domain; the limit line only when over it', async () => {
    const w = agentWorld();
    try {
      makeMl({ db: w.db, now: () => w.clock.t });
      assert.ok(w.nx.results && w.nx.contextResolver, 'composed together');
      const src = h.tmpDir('nx-rs-ctx-');
      const file = path.join(src, 'customers.csv'); fs.writeFileSync(file, 'id,age\n1,30\n');
      await w.nx.datasets.add(w.me, 'p-ledger', async () => file);
      const read = async (projectId, workspaceId) => {
        const out = await w.nx.contextResolver.resolve({ id: newId(w.clock.t++), projectId, workspaceId, sessionId: null });
        return fs.readFileSync(path.join(w.nx.results.deps.dataHome.root, ...out.path.split('/')), 'utf8');
      };
      // The helper's container is the machine learning kit here (a project with no JavaScript): the steps.
      w.db.prepare("UPDATE projects SET metadata_json = ? WHERE id = 'p-ledger'").run(JSON.stringify({ detectedLanguages: [{ language: 'Python', fileCount: 3, extension: 'py' }] }));
      w.db.prepare("UPDATE artifact_versions SET metadata_json = '{}' WHERE artifact_id IN (SELECT id FROM artifacts WHERE project_id = 'p-ledger' AND kind = 'repository')").run();
      const text = await read('p-ledger', 'ml');
      const title = `## ${C.ANALYST_BLOCK_TITLE}`;
      assert.equal(text.split(title).length - 1, 1, 'once');
      const at = text.indexOf(title);
      assert.ok(text.indexOf('## Datasets') >= 0 && text.indexOf('## Datasets') < at, 'right after the data');
      assert.ok(at < text.indexOf('## Domain'), 'early, so a small model\'s cut-down context keeps it');
      const block = text.slice(at, text.indexOf('\n## ', at + 3));
      assert.ok(block.includes(C.ANALYST_STEPS[0]) && block.includes(C.ANALYST_STEPS[7]));
      assert.ok(!block.includes(C.ANALYST_OVER_LIMIT), 'no limit line under the limit');
      assert.ok(Buffer.byteLength(block, 'utf8') <= C.ANALYST_BLOCK_MAX_BYTES + 64, 'bounded');
      assert.ok(Buffer.byteLength(text, 'utf8') < 24 * 1024, 'the whole file stays inside a small model\'s cut (24 KiB)');
      // Over 1 GB of results: one line tells the helper to clear old outputs first.
      const dir = path.join(w.nx.results.deps.dataHome.root, 'results', 'p-ledger', 'files');
      fs.mkdirSync(dir, { recursive: true });
      const huge = path.join(dir, 'old_big.csv'); fs.writeFileSync(huge, 'a\n'); fs.truncateSync(huge, R.RESULTS_MAX_TOTAL_BYTES + 1);
      try {
        const over = await read('p-ledger', 'ml');
        assert.ok(over.includes(C.ANALYST_OVER_LIMIT));
        assert.equal((await w.nx.results.list(w.me, 'p-ledger')).overLimit, true, 'the listing says so too');
      } finally { fs.rmSync(huge, { force: true }); }
      // A JavaScript repository's helper does not get the kit: the honest line instead of the steps.
      w.db.prepare("UPDATE projects SET metadata_json = ? WHERE id = 'p-ledger'").run(JSON.stringify({ detectedLanguages: [{ language: 'TypeScript', fileCount: 3, extension: 'ts' }] }));
      const js = await read('p-ledger', 'ml');
      assert.ok(js.includes(C.ANALYST_NO_KIT));
      assert.ok(!js.includes(C.ANALYST_STEPS[2]));
      // Not an ML project: no block.
      assert.doesNotMatch(await read('p-sales', 'sde'), /How to work on a data question|\/results/);
      w.db.prepare("UPDATE project_workspaces SET is_primary = 0 WHERE project_id = 'p-ledger' AND workspace_id = 'ml'").run();
      w.db.prepare("UPDATE project_workspaces SET is_primary = 1 WHERE project_id = 'p-ledger' AND workspace_id = 'sde'").run();
      assert.doesNotMatch(await read('p-ledger', 'sde'), /How to work on a data question|\/results/);
    } finally { try { w.s.close(); } catch { /* closed */ } }
  });
}
