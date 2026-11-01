'use strict';
// The machine learning kit (ml-python) in main, over a real v9 database and the platform's own execution core (a FakeRunner, no Docker):
// - a computer with no Machine learning project neither shows nor needs the ML kit (it is large and nobody else needs it);
// - once a project's primary kind of work is Machine learning, the ML kit is part of getting this computer ready (an honest
//   `image_missing:ml-python` until it is prepared, through the existing image approval);
// - that project's Python runs are planned in the ML kit (no dependency volume, no PYTHONPATH) and wait `waiting:image` while it is
//   missing; a Python project of another kind keeps sde-python; nothing is installed for an ML project.
const h = require('./helpers/sqlite.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');

if (h.realSqliteOrSkip()) {
  const { execWorld } = require('./helpers/execWorld.cjs');
  const { FakeRunner } = require('./helpers/fakeRunner.cjs');
  const { healthView } = require('./load-ts.cjs')('src/main/nexusIpc/dto.ts');
  const ML_IMAGE = 'sha256:' + '4'.repeat(64);
  const images = (ml) => [{ profile: 'sde-node', present: true, digestMatches: true, imageId: 'sha256:' + '1'.repeat(64) },
    { profile: 'sde-python', present: true, digestMatches: true, imageId: 'sha256:' + '2'.repeat(64) },
    ml ? { profile: 'ml-python', present: true, digestMatches: true, imageId: ML_IMAGE } : { profile: 'ml-python', present: false, digestMatches: false }];
  /** Makes p-ledger's primary kind of work Machine learning (its primary participation becomes the `ml` workspace). */
  function makeMl(w) {
    w.db.transaction(() => {
      w.db.prepare("UPDATE project_workspaces SET is_primary = 0 WHERE project_id = 'p-ledger' AND is_primary = 1").run();
      const row = w.db.prepare("SELECT id FROM project_workspaces WHERE project_id = 'p-ledger' AND workspace_id = 'ml'").get();
      if (row) w.db.prepare("UPDATE project_workspaces SET status = 'active', is_primary = 1 WHERE id = ?").run(row.id);
      else {
        w.db.prepare(`INSERT INTO project_workspaces (id, project_id, workspace_id, objective, status, is_primary, source, created_by, created_at, updated_at)
          VALUES ('pw-ml-ledger', 'p-ledger', 'ml', NULL, 'active', 1, 'user', 'user:local', ?, ?)`).run(w.now(), w.now());
      }
    })();
    assert.equal(w.db.prepare("SELECT workspace_id FROM project_workspaces WHERE project_id = 'p-ledger' AND is_primary = 1").get().workspace_id, 'ml');
  }
  const platform = { handoffs: true, execution: true, registry: { valid: true, problems: 0 }, subReason: null };

  test('ML1 no Machine learning project: the ML kit is neither shown nor needed (health, the gate, an action\'s setup), even while missing', () => {
    const w = execWorld({ ml: true, profile: 'sde-python', images: images(false) });
    const r = new FakeRunner(); w.exec.attachRunner(r, w.bootId);
    const hs = w.exec.health();
    assert.deepEqual(hs.images.map((i) => i.profile), ['sde-node', 'sde-python']);
    assert.deepEqual(hs.gate.problems.filter((p) => String(p.id).startsWith('image_')), []);
    assert.deepEqual(healthView(hs, platform).problems.filter((p) => p.startsWith('image_')), []);
    assert.deepEqual(w.exec.setupAvailability({ actionId: 'sde.tests.discover' }), { available: true, reason: null }, 'discover lists the ML kit, which is not needed here');
    // A Python project of another kind keeps the Python kit.
    const { job } = w.exec.start(w.me, w.req('sde.tests.discover'));
    assert.equal(JSON.parse(w.job(job.id).capabilities_json)[0].profile, 'sde-python');
    w.close();
  });

  test('ML2 a Machine learning project: the ML kit is part of getting this computer ready (image_missing:ml-python) and its actions say so', () => {
    const w = execWorld({ ml: true, profile: 'sde-python', images: images(false) });
    const r = new FakeRunner(); w.exec.attachRunner(r, w.bootId);
    makeMl(w);
    const hs = w.exec.health();
    assert.deepEqual(hs.images.map((i) => [i.profile, i.present]), [['sde-node', true], ['sde-python', true], ['ml-python', false]]);
    assert.ok(hs.gate.problems.some((p) => p.id === 'image_missing' && p.profile === 'ml-python'));
    assert.ok(healthView(hs, platform).problems.includes('image_missing:ml-python'), 'the renderer offers "Prepare this kit" for it');
    assert.deepEqual(w.exec.setupAvailability({ actionId: 'sde.tests.discover' }), { available: false, reason: 'setup:image_missing' });
    w.setProbe({ images: images(true) });
    assert.deepEqual(w.exec.health().gate.problems.filter((p) => String(p.id).startsWith('image_')), []);
    assert.deepEqual(w.exec.setupAvailability({ actionId: 'sde.tests.discover' }), { available: true, reason: null });
    w.close();
  });

  test('ML3 a Machine learning project\'s Python runs are planned in the ML kit: waiting:image while it is missing, then its image, pytest, no dependency volume, no PYTHONPATH', () => {
    const w = execWorld({ ml: true, profile: 'sde-python', images: images(false),
      repoMeta: { lockfile: { path: 'requirements.txt', sha256: 'a'.repeat(64) } } });
    const r = new FakeRunner(); w.exec.attachRunner(r, w.bootId);
    makeMl(w);
    const { job } = w.exec.start(w.me, w.req('sde.tests.discover'));
    assert.equal(JSON.parse(w.job(job.id).capabilities_json)[0].profile, 'ml-python', 'the run profile');
    w.exec.tick(w.now());
    assert.deepEqual([w.jobState(job.id), w.job(job.id).phase], ['queued', 'waiting:image'], 'it waits for the kit; nothing crashes');
    w.setProbe({ images: images(true) });
    w.exec.tick(w.now());
    assert.equal(w.jobState(job.id), 'leased');
    const plan = r.lastStart().plan;
    assert.equal(plan.container.profile, 'ml-python');
    assert.equal(plan.container.image.id, ML_IMAGE);
    assert.ok(plan.container.argv.includes('pytest'), plan.container.argv.join(' '));
    assert.equal(plan.container.env.PYTHONPATH, undefined, 'the packages are in the image');
    assert.equal(plan.container.mounts.some((m) => m.kind === 'deps'), false, 'no dependency volume, whatever the lockfile says');
    assert.deepEqual(plan.container.network, { mode: 'none' });
    assert.deepEqual(plan.container.imageEnv, ['PATH', 'HOME', 'LANG', 'MPLBACKEND', 'MPLCONFIGDIR']);
    // Nothing is installed for a Machine learning project: the add-ons step says so and the person's flow moves on (it skips this reason).
    assert.throws(() => w.exec.start(w.me, w.req('sde.deps.prepare', { inputs: [{ versionId: w.repoV, slot: 'repository' }] })),
      (e) => e.code === 'invalid' && e.detail.reason === 'no_dependencies' && /packages of its kit/.test(e.message));
    w.close();
  });

  test('ML4 a JavaScript repository in a Machine learning project keeps the node kit for its runs', () => {
    const w = execWorld({ ml: true, profile: 'sde-node', images: images(false) });
    const r = new FakeRunner(); w.exec.attachRunner(r, w.bootId);
    makeMl(w);
    const { job } = w.exec.start(w.me, w.req('sde.tests.discover'));
    assert.equal(JSON.parse(w.job(job.id).capabilities_json)[0].profile, 'sde-node');
    w.close();
  });
}
