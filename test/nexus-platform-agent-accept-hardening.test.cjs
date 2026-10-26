'use strict';
// B2b Task 9: accept fix round 1 (O25 guard, owed rollback, dialog confirmation) and Task 16 counts: RA18-RA27
// The world (a real repository, real worktrees, change sets that reach candidate) and the stand-in for the runner (it runs the
// runner's own git engines for each job the services queue) are test/helpers/acceptWorld.cjs. The files are split only to stay
// inside the runner's per-file time limit.
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const W = require('./helpers/acceptWorld.cjs');
const { PROJECT, WORKSPACE, tmp, git, out, refOf, userState, gitFacts, gitRefused, nextKey, ulid, jobRow, findJobs, version, latest, leaseAndRun, finish,
  addRepository, runEngine, jobOf, candidateWorld, makeChange, approve, integrationHead, acceptWith, acceptedWorld, merge, mergeWith, acceptSvc, rejectNow,
  heldAccept, conflictingPair, loadTs, agentWorld, openRunningTurn, newId, immediateTx, insertAttemptTx, transitionAttemptTx, attemptRow, ChangeSetService, GW,
  HardenedGit, ensureWorktree, collect, gitAccept, gitRollback, fastForward, GitFailure, gitRead, preparedOf } = W;
const { ReviewService } = loadTs('src/main/nexus/review/reviewService.ts');
const { PlatformError } = loadTs('src/main/nexus/errors.ts');
const { AGENT_ACTION_CAPABILITIES } = loadTs('src/main/nexus/auth/policy.ts');
const { MCP_TOOLS } = loadTs('src/shared/nexus/mcpTools.ts');
const crypto = require('node:crypto');

test('RA18 (I1): while an accept rollback is pending, accept refuses integration_unexpected (no job); once it completed, accept works', async () => {
  const world = await candidateWorld();
  const { w } = world;
  const c1 = await makeChange(world, { file: 'one.txt', title: 'One' });
  const c2 = await makeChange(world, { file: 'two.txt', title: 'Two' });
  approve(world, c1.versionId); approve(world, c2.versionId);
  const svc = acceptSvc(w);
  const old = integrationHead(world);
  const { p, held, moved } = await heldAccept(world, svc, c1.versionId, old);
  rejectNow(world, c1.versionId);
  held.finish();
  await assert.rejects(p, (e) => e.detail.reason === 'accept_rolled_back');
  const rb = findJobs(w, 'changeset.accept_rollback');
  assert.equal(rb.length, 1); assert.equal(rb[0].state, 'queued', 'queued, not yet run: the ref still holds the rejected change');
  assert.equal(integrationHead(world), moved);
  // The caller passes the head it sees (the unrecorded one): consistency refuses. The stale one: the pending rollback refuses.
  await assert.rejects(svc.accept(w.me, c2.versionId, moved), (e) => e.code === 'conflict' && e.detail.reason === 'integration_unexpected');
  await assert.rejects(svc.accept(w.me, c2.versionId, old), (e) => e.code === 'conflict' && e.detail.reason === 'integration_unexpected');
  assert.equal(findJobs(w, 'changeset.accept').length, 1, 'no second accept job was made');
  assert.equal(integrationHead(world), moved);
  await runEngine(w, world, rb[0].id);
  assert.equal(integrationHead(world), old);
  const { p: p2 } = await acceptWith(world, c2.versionId, old);
  assert.equal((await p2).version.status, 'active');
});

test('RA18b (I1/M6/M7): an expected head Nexus has no record of never accepts; an unknown initial head is not consistency; a different head does not join a live job', async () => {
  const world = await candidateWorld();
  const { w } = world;
  const c = await makeChange(world);
  approve(world, c.versionId);
  const svc = acceptSvc(w);
  const old = integrationHead(world);
  // Moved by hand: expecting that head is refused whatever the CAS would say.
  const extra = out(world.repo, ['commit-tree', `${old}^{tree}`, '-p', old, '-m', 'by hand']);
  git(world.repo, ['update-ref', 'refs/nexus/accepted/main', extra]);
  await assert.rejects(svc.accept(w.me, c.versionId, extra), (e) => e.detail.reason === 'integration_unexpected');
  assert.equal(findJobs(w, 'changeset.accept').length, 0);
  git(world.repo, ['update-ref', 'refs/nexus/accepted/main', old]);
  // A live accept at `old`; a click with another head neither joins it nor starts a second job.
  const p1 = svc.accept(w.me, c.versionId, old); p1.catch(() => {});
  await assert.rejects(svc.accept(w.me, c.versionId, 'f'.repeat(40)), (e) => e.detail.reason === 'integration_unexpected');
  assert.equal(findJobs(w, 'changeset.accept').length, 1);
  await runEngine(w, world, findJobs(w, 'changeset.accept')[0].id);
  assert.equal((await p1).version.status, 'active');
  // No worktree row, no accept: the initial head is unknown, so the ref is not "consistent".
  const bare = await candidateWorld({ noWorktreeRow: true });
  assert.equal((await bare.w.nx.accepts.status(bare.w.me, PROJECT)).integrationConsistent, false);
});

test('RA19 (I2): a rollback that cannot be queued is never silent: logged, counted, the error says rollbackOwed, accept stays blocked until it is queued; the ingest that threw rolled everything back', async () => {
  const world = await candidateWorld();
  const { w } = world;
  const c1 = await makeChange(world, { file: 'one.txt', title: 'One' });
  const c2 = await makeChange(world, { file: 'two.txt', title: 'Two' });
  approve(world, c1.versionId); approve(world, c2.versionId);
  const logs = [];
  const svc = acceptSvc(w, (l) => logs.push(l));
  const old = integrationHead(world);
  const { p, job, held, moved } = await heldAccept(world, svc, c1.versionId, old);
  rejectNow(world, c1.versionId);
  const orig = w.nx.jobs.createTx;
  w.nx.jobs.createTx = function patched(pr, i) { if (i.recipeId === 'changeset.accept_rollback') throw new Error('boom'); return orig.call(this, pr, i); };
  try {
    held.finish();   // the ingest's own rollback enqueue throws: the whole ingest transaction rolls back
    await assert.rejects(p, (e) => e.detail.rollbackOwed === true && !/boom/.test(e.message));
    assert.notEqual(jobRow(w, job.id).state, 'completed');
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM change_set_accepts').get().n, 0, 'nothing of the ingest stayed');
    assert.equal(version(w, c1.versionId).status, 'candidate');
    assert.equal(findJobs(w, 'changeset.accept_rollback').length, 0, 'the rollback could not be queued');
    assert.ok(logs.length > 0 && logs.every((l) => !/boom|[0-9a-f]{40}/.test(l)), JSON.stringify(logs));
    assert.deepEqual(svc.reconcileEnded(), { queued: 0, failed: 1 });
    assert.equal(integrationHead(world), moved, 'the ref is still at the unrecorded commit');
    await assert.rejects(svc.accept(w.me, c2.versionId, old), (e) => e.detail.reason === 'integration_unexpected', 'blocked while the rollback is owed');
  } finally { w.nx.jobs.createTx = orig; }
  assert.deepEqual(svc.reconcileEnded(), { queued: 1, failed: 0 });
  await runEngine(w, world, findJobs(w, 'changeset.accept_rollback')[0].id);
  assert.equal(integrationHead(world), old);
  const { p: p2 } = await acceptWith(world, c2.versionId, old);
  assert.equal((await p2).version.status, 'active');
});

test('RA20: a rollback never clobbers a ref that moved again (it refuses ref_moved)', async () => {
  const world = await candidateWorld();
  const { w } = world;
  const c = await makeChange(world);
  approve(world, c.versionId);
  const svc = acceptSvc(w);
  const { p, held, moved } = await heldAccept(world, svc, c.versionId, integrationHead(world));
  rejectNow(world, c.versionId);
  held.finish();
  await assert.rejects(p, (e) => e.detail.reason === 'accept_rolled_back');
  const elsewhere = out(world.repo, ['commit-tree', `${moved}^{tree}`, '-p', moved, '-m', 'moved again']);
  git(world.repo, ['update-ref', 'refs/nexus/accepted/main', elsewhere]);
  const rb = findJobs(w, 'changeset.accept_rollback')[0];
  const r = await runEngine(w, world, rb.id);
  assert.equal(r.refused, 'ref_moved');
  assert.equal(integrationHead(world), elsewhere, 'not clobbered');
  assert.equal(jobRow(w, rb.id).state, 'failed');
});

test('RA21: an accept job whose user was disabled, or whose params name a non-user, is refused at ingest: rolled back, nothing promoted', async () => {
  for (const how of ['disabled', 'forged']) {
    const world = await candidateWorld();
    const { w } = world;
    const c = await makeChange(world);
    approve(world, c.versionId);
    const svc = acceptSvc(w);
    const old = integrationHead(world);
    const { p, job, held } = await heldAccept(world, svc, c.versionId, old);
    if (how === 'disabled') w.db.prepare("UPDATE principals SET disabled_at = ? WHERE id = 'user:local'").run(w.clock.t);
    else w.db.prepare("UPDATE jobs SET params_json = json_set(params_json, '$.acceptedBy', 'system') WHERE id = ?").run(job.id);
    held.finish();
    await assert.rejects(p, (e) => e.detail.reason === 'accept_rolled_back', how);
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM change_set_accepts').get().n, 0, how);
    assert.equal(version(w, c.versionId).status, 'candidate', how);
    const rb = findJobs(w, 'changeset.accept_rollback');
    assert.equal(rb.length, 1, how);
    await runEngine(w, world, rb[0].id);
    assert.equal(integrationHead(world), old, how);
  }
});

test('RA22: the runner own tree check at job time: a tree made dirty AFTER the dialog but before the job runs refuses tree_dirty and keeps the user edit', async () => {
  const world = await acceptedWorld();
  const sha = integrationHead(world);
  const { p, r } = await mergeWith(world, sha, () => { fs.writeFileSync(path.join(world.repo, 'a.txt'), 'edited after the dialog\n'); return true; });
  assert.equal(r.refused, 'tree_dirty');
  await assert.rejects(p, (e) => e.code === 'conflict' && e.detail.reason === 'tree_dirty');
  assert.equal(fs.readFileSync(path.join(world.repo, 'a.txt'), 'utf8'), 'edited after the dialog\n');
  assert.equal(out(world.repo, ['rev-parse', 'HEAD']), world.initial);
  assert.equal(world.w.db.prepare('SELECT COUNT(*) AS n FROM repo_merges').get().n, 0);
});

test('RA23 (M3): only an exact true from the dialog confirms; the service and the wiring say so', async () => {
  const world = await acceptedWorld();
  for (const answer of ['yes', 1, {}, undefined, null]) {
    await assert.rejects(merge(world, () => answer), (e) => e.detail.reason === 'cancelled', String(answer));
  }
  await assert.rejects(merge(world, () => Promise.resolve('true')), (e) => e.detail.reason === 'cancelled');
  assert.equal(findJobs(world.w, 'repo.ff').length, 0);
  const root = path.join(__dirname, '..');
  const wiring = fs.readFileSync(path.join(root, 'src', 'main', 'nexusExec', 'execWiring.ts'), 'utf8');
  assert.match(wiring, /\(await o\.mergeDialog\(info\)\) === true/);
  const svc = fs.readFileSync(path.join(root, 'src', 'main', 'nexus', 'repo', 'acceptService.ts'), 'utf8');
  assert.match(svc, /\(await confirm\(this\.mergeInfo\(projectId, s, sha\)\)\) === true/);
  assert.match(svc, /pass ONLY[\s*]+`ExecutionHandle\.confirmMerge`/);
});

test('RA24 (M5): a failure writing the accept-time check row never replaces the merge_conflict answer', async () => {
  const world = await candidateWorld();
  const { w } = world;
  const { second, recorded } = await conflictingPair(world);
  const logs = [];
  const svc = acceptSvc(w, (l) => logs.push(l));
  const orig = w.nx.validation.recordOutcomeTx;
  w.nx.validation.recordOutcomeTx = () => { throw new Error('disk full'); };
  try {
    const p = svc.accept(w.me, second.versionId, recorded); p.catch(() => {});
    await runEngine(w, world, jobOf(w, 'changeset.accept').id);
    await assert.rejects(p, (e) => e.code === 'conflict' && e.detail.reason === 'merge_conflict');
  } finally { w.nx.validation.recordOutcomeTx = orig; }
  assert.ok(logs.some((l) => /accept-time check row was not written/.test(l)));
});

test('RA25 (Task 16 fix round 1): acceptedNotMerged counts accepted CHANGES, commitCount the commits: one accept 1, two 2, a merge 0, the next accept 1', async () => {
  const world = await acceptedWorld();
  const { w } = world;
  const status = () => w.nx.accepts.status(w.me, PROJECT);
  let st = await status();
  assert.equal(st.acceptedNotMerged, 1, 'one accepted change set is one change');
  assert.ok(st.commitCount >= 2, 'it is at least two commits on the integration ref: the change and the accept commit');
  assert.equal(st.commitCount, Number(out(world.repo, ['rev-list', '--count', 'main..refs/nexus/accepted/main'])), 'commitCount is git\'s own count');
  // A second accepted change: two changes.
  const two = await makeChange(world, { file: 'second.txt', content: 'second\n', title: 'Add a second feature' });
  approve(world, two.versionId);
  await (await acceptWith(world, two.versionId, integrationHead(world))).p;
  st = await status();
  assert.equal(st.acceptedNotMerged, 2); assert.ok(st.commitCount >= 4);
  assert.equal(st.integrationConsistent, true);
  // The merge takes both: nothing is left, and git agrees.
  const { p } = await mergeWith(world, integrationHead(world));
  await p;
  st = await status();
  assert.equal(st.acceptedNotMerged, 0); assert.equal(st.commitCount, 0);
  assert.equal(st.integrationConsistent, true);
  // The iteration case: one more accepted change after the merge is one change (the merged ones are not counted again).
  const three = await makeChange(world, { file: 'third.txt', content: 'third\n', title: 'Add a third feature' });
  approve(world, three.versionId);
  await (await acceptWith(world, three.versionId, integrationHead(world))).p;
  st = await status();
  assert.equal(st.acceptedNotMerged, 1);
  assert.ok(st.commitCount >= 2);
  // A merge made outside Nexus (the user merges the accepted ref themselves) leaves nothing to merge, whatever the records say.
  git(world.repo, ['merge', '--ff-only', '-q', 'refs/nexus/accepted/main']);
  st = await status();
  assert.deepEqual([st.acceptedNotMerged, st.commitCount], [0, 0]);
});
