'use strict';
// B2b Task 9, final re-review round 2: an accept refuses (base_moved) when the ground the reviewed change was made on is no longer under
// the integration head (the user amended or reset since), and a merged accept does not stop the next rewrite. Real git; the world
// and the runner stand-in are test/helpers/acceptWorld.cjs.
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const W = require('./helpers/acceptWorld.cjs');
const { PROJECT, git, out, jobRow, findJobs, version, runEngine, jobOf, candidateWorld, makeChange, approve, integrationHead, acceptWith, acceptedWorld, mergeWith,
  acceptSvc, loadTs, REF, baselineOf, secondSession, resyncRows, userCommits } = W;
const { GIT_FAILURE_TEXT } = loadTs('src/main/nexus/exec/recovery.ts');
const { rewriteAllowed } = loadTs('src/main/nexus/repo/integrationBaseline.ts');

const status = (world) => world.w.nx.accepts.status(world.w.me, PROJECT);
const exists = (world, f) => fs.existsSync(path.join(world.repo, f));
async function newSession(world, o = {}) { const s = await secondSession(world, o); return { s, r: await s.run() }; }

test('RD1 (base_moved): the user amends away a commit the reviewed change sat on: accept refuses base_moved, nothing is merged; a change made on the new code still accepts and merges', async () => {
  const world = await candidateWorld();
  const { w } = world;
  const H = userCommits(world, 'x.txt', 'x\n');                       // the user's commit H adds x.txt
  const s2 = await newSession(world);                                 // forward resync to H: the agent works on H
  assert.equal(s2.r.facts.integrationHead, H);
  const c = await makeChange(s2.s.sub, { file: 'agent.txt', content: 'agent\n', title: 'Agent change' });
  assert.equal(JSON.parse(version(w, c.versionId).metadata_json).base, H, 'the preview is H..head: agent.txt only');
  approve(world, c.versionId);
  // The user amends H and drops x.txt; the next session records the rewrite.
  git(world.repo, ['rm', '-q', 'x.txt']); git(world.repo, ['commit', '-q', '--amend', '--allow-empty', '-m', 'amended without x']);
  const H2 = out(world.repo, ['rev-parse', 'HEAD']);
  const s3 = await newSession(world);
  assert.deepEqual([s3.r.facts.integrationRewrite, s3.r.facts.integrationHead], [true, H2]);
  const before = out(world.repo, ['rev-parse', REF]);
  const { p, r, job } = await acceptWith(world, c.versionId, H2);
  assert.equal(r.refused, 'base_moved');
  await assert.rejects(p, (e) => e.code === 'conflict' && e.detail.reason === 'base_moved' && e.message === GIT_FAILURE_TEXT.base_moved);
  assert.match(GIT_FAILURE_TEXT.base_moved, /ground this change was made on has moved; ask the agent to redo it on your current code/);
  assert.equal(JSON.parse(jobRow(w, job.id).error_json).code, 'base_moved');
  assert.equal(integrationHead(world), before, 'the ref did not move: nothing was merged (x.txt did not come back)');
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM change_set_accepts').get().n, 0);
  assert.equal(version(w, c.versionId).status, 'candidate');
  assert.equal(findJobs(w, 'changeset.accept_rollback').length, 0, 'a refusal before the move needs no rollback');
  // A change made on the new code is a normal forward accept and merge.
  const c2 = await makeChange(s3.s.sub, { file: 'agent2.txt', content: 'agent2\n', title: 'On the new code' });
  assert.equal(JSON.parse(version(w, c2.versionId).metadata_json).base, H2);
  approve(world, c2.versionId);
  await (await acceptWith(world, c2.versionId, H2)).p;
  await (await mergeWith(world, integrationHead(world))).p;
  assert.equal(exists(world, 'agent2.txt'), true); assert.equal(exists(world, 'x.txt'), false, 'the amended-away commit stayed away');
});

test('RD2 (merged accept, then a reset): accept, merge, reset --hard drops the merged work: the next session rewrites, an older candidate is refused base_moved, a new change accepts and merges, the chain stays known', async () => {
  const world = await acceptedWorld();                                // accepted change 1 (feature.txt), unmerged
  const { w } = world;
  const N1 = integrationHead(world);
  const c2 = await makeChange(world, { file: 'two.txt', content: 'two\n', title: 'Small change' });   // made on top of change 1
  approve(world, c2.versionId);
  assert.equal(rewriteAllowed(w.db, PROJECT, REF), false, 'an accept that still waits is not rewritable');
  await (await mergeWith(world, N1)).p;                               // the accept is merged into the user's branch
  assert.equal(rewriteAllowed(w.db, PROJECT, REF), true, 'a merged accept is');
  assert.equal((await status(world)).acceptedNotMerged, 0);
  git(world.repo, ['reset', '-q', '--hard', world.initial]);          // the user deliberately drops the merged work
  assert.equal(exists(world, 'feature.txt'), false);
  const s2 = await newSession(world);
  assert.deepEqual([s2.r.facts.integrationRewrite, s2.r.facts.integrationBefore, s2.r.facts.integrationHead], [true, N1, world.initial]);
  assert.equal(jobRow(w, s2.s.job.id).state, 'completed');
  assert.equal(JSON.parse(resyncRows(w)[0].details_json).rewrite, true);
  assert.equal(baselineOf(world).known, true); assert.equal(baselineOf(world).head, world.initial);
  assert.equal((await status(world)).integrationConsistent, true);
  // The older small candidate sat on the accepted work that was reset away: it must not bring that work back.
  const { p, r } = await acceptWith(world, c2.versionId, world.initial);
  assert.equal(r.refused, 'base_moved');
  await assert.rejects(p, (e) => e.detail.reason === 'base_moved');
  assert.equal(exists(world, 'feature.txt'), false); assert.equal(integrationHead(world), world.initial);
  // A new change on the reset code: accept (after the rewrite) and merge: one chain, O25 true; a hand-moved ref is not.
  const c3 = await makeChange(s2.s.sub, { file: 'three.txt', content: 'three\n', title: 'After the reset' });
  approve(world, c3.versionId);
  await (await acceptWith(world, c3.versionId, world.initial)).p;
  const N3 = integrationHead(world);
  await (await mergeWith(world, N3)).p;
  assert.equal(out(world.repo, ['rev-parse', 'HEAD']), N3);
  assert.equal(exists(world, 'three.txt'), true); assert.equal(exists(world, 'feature.txt'), false, 'the reset-away work stayed away');
  const b = baselineOf(world);
  assert.deepEqual([b.known, b.head, b.endKind, b.endMerged], [true, N3, 'accept', true]);
  assert.deepEqual(b.records.map((x) => x.kind), ['initial', 'accept', 'resync', 'accept']);
  assert.equal((await status(world)).integrationConsistent, true);
  git(world.repo, ['update-ref', REF, N1]);
  assert.equal((await status(world)).integrationConsistent, false);
});

test('RD3 (merged accept, then a squash or rebase): rewritten after the merge, the next session rewrites and a full cycle works; an UNMERGED accept stays integration_diverged', async () => {
  const world = await acceptedWorld();
  const { w } = world;
  const N1 = integrationHead(world);
  await (await mergeWith(world, N1)).p;
  // Squash: the user collapses the merged commits into one new commit on the original base (not a descendant of the ref).
  git(world.repo, ['reset', '-q', '--soft', world.initial]); git(world.repo, ['commit', '-q', '-m', 'squashed']);
  const Q = out(world.repo, ['rev-parse', 'HEAD']);
  assert.notEqual(Q, N1);
  const s2 = await newSession(world);
  assert.deepEqual([s2.r.facts.integrationRewrite, s2.r.facts.integrationHead], [true, Q]);
  const c = await makeChange(s2.s.sub, { file: 'after-squash.txt', content: 's\n', title: 'After the squash' });
  approve(world, c.versionId);
  await (await acceptWith(world, c.versionId, Q)).p;
  const N2 = integrationHead(world);
  await (await mergeWith(world, N2)).p;
  assert.equal(out(world.repo, ['rev-parse', 'HEAD']), N2);
  // Now an UNMERGED accept: a rewrite is refused with its sentence and nothing is touched.
  const c2 = await makeChange(s2.s.sub, { file: 'unmerged.txt', content: 'u\n', title: 'Waits' });
  approve(world, c2.versionId);
  await (await acceptWith(world, c2.versionId, N2)).p;
  const N3 = integrationHead(world);
  git(world.repo, ['commit', '-q', '--amend', '--allow-empty', '-m', 'amended while an accept waits']);
  const s3 = await newSession(world);
  assert.equal(s3.r.refused, 'integration_diverged');
  assert.equal(integrationHead(world), N3); assert.equal(rewriteAllowed(w.db, PROJECT, REF), false);
});
