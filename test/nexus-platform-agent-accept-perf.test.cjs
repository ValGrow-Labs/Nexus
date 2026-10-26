'use strict';
// B2b Task 9, final re-review round 2: the recorded baseline is looked up by job and cached by the project's newest activity row (so a
// status read costs nothing when nothing changed, and does not grow with the activity log), plus the two refusals of a rewrite that
// were not pinned (a rollback owed; a branch head that is not the new ref).
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('./helpers/acceptWorld.cjs');
const { PROJECT, git, out, jobRow, findJobs, finish, gitFacts, runEngine, candidateWorld, makeChange, approve, integrationHead, acceptedWorld, acceptSvc,
  heldAccept, rejectNow, loadTs, REF, baselineOf, secondSession, resyncRows, userCommits } = W;
const { integrationBaseline, rewriteAllowed } = loadTs('src/main/nexus/repo/integrationBaseline.ts');
const { appendActivityRow } = loadTs('src/main/nexus/activity/writer.ts');

test('RE1 (perf): the baseline is cached by the project\'s newest activity row; a new accept, resync or rewrite row invalidates it; 100k activity rows do not slow a read', async () => {
  const world = await acceptedWorld();                               // initial + one accept
  const { w } = world;
  const a = integrationBaseline(w.db, PROJECT, REF);
  assert.equal(integrationBaseline(w.db, PROJECT, REF), a, 'nothing changed: the same answer without a recompute');
  assert.deepEqual(a.records.map((r) => r.kind), ['initial', 'accept']);
  // A new activity row of the project (a tool call, say) changes the key: recomputed, equal in content.
  appendActivityRow(w.db, { actorKind: 'system', actorId: w.sys.id, projectId: PROJECT, entityType: 'x', action: 'job.transition', status: 'succeeded' }, w.clock.t);
  const b = integrationBaseline(w.db, PROJECT, REF);
  assert.notEqual(b, a); assert.equal(b.head, a.head);
  // A merge changes `endMerged` without an activity row of its own kind: it is in the key.
  const N1 = integrationHead(world);
  assert.equal(b.endMerged, false);
  await (await W.mergeWith(world, N1)).p;
  const merged = integrationBaseline(w.db, PROJECT, REF);
  assert.equal(merged.endMerged, true);
  // A resync (a rewrite) row is a new record and a new head.
  git(world.repo, ['reset', '-q', '--hard', world.initial]);
  const s2 = await secondSession(world); await s2.run();
  const rewritten = integrationBaseline(w.db, PROJECT, REF);
  assert.equal(rewritten.head, world.initial); assert.deepEqual(rewritten.records.map((r) => r.kind), ['initial', 'accept', 'resync']);
  // Another accept row after it.
  const c = await makeChange(s2.sub, { file: 'p.txt', title: 'Perf' });
  approve(world, c.versionId);
  await (await W.acceptWith(world, c.versionId, world.initial)).p;
  const after = integrationBaseline(w.db, PROJECT, REF);
  assert.deepEqual(after.records.map((r) => r.kind), ['initial', 'accept', 'resync', 'accept']);
  assert.equal(after.head, integrationHead(world));
  // 100k raw activity rows of the project (a long history of tool calls): reads stay cheap.
  const ins = w.db.prepare(`INSERT INTO activity (id, ts, actor_kind, actor_id, project_id, entity_type, action, status, details_json, prev_hash, hash)
    VALUES (?, ?, 'agent', 'agent:x', ?, 'mcp_call', 'mcp.call', 'succeeded', '{}', ?, ?)`);
  const hash = 'f'.repeat(64);
  w.db.transaction(() => { for (let i = 0; i < 100_000; i++) ins.run(`perf-${i}`, w.clock.t, PROJECT, hash, hash); })();
  let t0 = Date.now();
  for (let i = 0; i < 50; i++) {
    ins.run(`perf-more-${i}`, w.clock.t, PROJECT, hash, hash);       // a new row each time: every read is a miss, recomputed from the job lookups
    integrationBaseline(w.db, PROJECT, REF);
  }
  const uncached = Date.now() - t0;
  t0 = Date.now();
  for (let i = 0; i < 2000; i++) integrationBaseline(w.db, PROJECT, REF);
  const cached = Date.now() - t0;
  if (process.env.RE_PERF_LOG) console.log('PERF uncached50 ms', uncached, 'cached2000 ms', cached);
  assert.ok(uncached < 1000, `50 recomputations over 100k activity rows took ${uncached} ms`);
  assert.ok(cached < 4000, `2000 cached reads took ${cached} ms`);
  assert.equal(integrationBaseline(w.db, PROJECT, REF).head, after.head, 'the same answer');
  assert.equal((await w.nx.accepts.status(w.me, PROJECT)).integrationConsistent, true);
});

test('RE2 (rewrite guards): allowRewrite is false while a rollback is owed, even with no accept in flight and a chain ending in the initial head; a rewrite whose new head is not the branch head is refused', async () => {
  const world = await candidateWorld();
  const { w } = world;
  const first = world.initial;
  const c = await makeChange(world);
  approve(world, c.versionId);
  const svc = acceptSvc(w);
  const { p, held } = await heldAccept(world, svc, c.versionId, first);
  rejectNow(world, c.versionId);
  held.finish();
  await assert.rejects(p, (e) => e.detail.reason === 'accept_rolled_back');
  const rb = findJobs(w, 'changeset.accept_rollback')[0];
  assert.equal(rb.state, 'queued');
  assert.equal(baselineOf(world).endKind, 'initial', 'nothing was accepted');
  assert.equal(rewriteAllowed(w.db, PROJECT, REF), false, 'a rollback is owed');
  const queuedNow = await secondSession(world);
  assert.equal(JSON.parse(jobRow(w, queuedNow.job.id).params_json).allowRewrite, false);
  await runEngine(w, world, rb.id);
  assert.equal(rewriteAllowed(w.db, PROJECT, REF), true, 'the rollback completed');
  // A rewrite whose reported branch head is not the new head of the ref: refused, nothing recorded.
  git(world.repo, ['commit', '-q', '--amend', '--allow-empty', '-m', 'amended']);
  const A = out(world.repo, ['rev-parse', 'HEAD']);
  const s = await secondSession(world, { crash: true });
  assert.equal(JSON.parse(jobRow(w, s.job.id).params_json).allowRewrite, true);
  const r = await s.run();
  assert.deepEqual([r.facts.integrationRewrite, r.facts.integrationHead], [true, A]);
  const stray = out(world.repo, ['commit-tree', `${first}^{tree}`, '-m', 'stray']);
  finish(s.turn2, r.attempt, { parsed: [gitFacts({ ...r.facts, branchHead: stray })] });
  assert.equal(jobRow(w, s.job.id).state, 'failed');
  assert.equal(JSON.parse(jobRow(w, s.job.id).error_json).code, 'rewrite_refused');
  assert.equal(resyncRows(w).length, 0);
});
