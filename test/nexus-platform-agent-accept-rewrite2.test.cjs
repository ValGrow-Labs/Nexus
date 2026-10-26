'use strict';
// (second half) B2b Task 9, final re-review round: the user's amend, rebase or reset (a REWRITE of the branch) when nothing was accepted after the
// recorded head, the integration ref's record found by its entity (a branch named like a secret), and the worktree job that no
// cancel stops. Real git; the world and the runner stand-in are test/helpers/acceptWorld.cjs.
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const W = require('./helpers/acceptWorld.cjs');
const { PROJECT, WORKSPACE, git, out, jobRow, findJobs, leaseAndRun, finish, gitFacts, ulid, runEngine, jobOf, candidateWorld, makeChange, approve,
  integrationHead, acceptWith, acceptedWorld, mergeWith, acceptSvc, loadTs, agentWorld, openRunningTurn, immediateTx, newId,
  REF, baselineOf, secondSession, resyncRows, userCommits, ensureWorktree } = W;
const { GIT_FAILURE_TEXT } = loadTs('src/main/nexus/exec/recovery.ts');
const { integrationBaseline, rewriteAllowed } = loadTs('src/main/nexus/repo/integrationBaseline.ts');
const { appendActivityRow } = loadTs('src/main/nexus/activity/writer.ts');

const amend = (world, msg = 'amended') => { git(world.repo, ['commit', '-q', '--amend', '--allow-empty', '-m', msg]); return out(world.repo, ['rev-parse', 'HEAD']); };
const status = (world) => world.w.nx.accepts.status(world.w.me, PROJECT);

async function s2Run(world, o = {}) { const s = await secondSession(world, o); return { s, r: await s.run() }; }

test('RC2 (B6 rewrite): an amend after a forward resync, and a reset and a rebase, are each recorded as a rewrite; the chain stays one chain', async () => {
  const world = await acceptedWorld();
  const { w } = world;
  const S = integrationHead(world);
  await (await mergeWith(world, S)).p;                    // the accept is merged: the ref is on the branch
  const U = userCommits(world);
  const r1 = await s2Run(world);                          // forward resync S -> U
  assert.deepEqual([r1.r.facts.integrationResynced, r1.r.facts.integrationRewrite], [true, undefined]);
  assert.equal(baselineOf(world).head, U);
  // The user amends U. After an accept the chain ended in a resync (the accept is behind it): a rewrite is allowed again.
  const U2 = amend(world, 'amended again');
  assert.equal(rewriteAllowed(w.db, PROJECT, REF), true);
  const r2 = await s2Run(world);
  assert.deepEqual([r2.r.facts.integrationRewrite, r2.r.facts.integrationBefore, r2.r.facts.integrationHead], [true, U, U2]);
  assert.equal(baselineOf(world).head, U2);
  // A reset back to an earlier commit (the ref is now AHEAD of the branch, and nothing is accepted after the recorded head).
  const back = out(world.repo, ['rev-parse', 'HEAD~1']);
  git(world.repo, ['reset', '-q', '--hard', 'HEAD~1']);
  const r3 = await s2Run(world);
  assert.deepEqual([r3.r.facts.integrationRewrite, r3.r.facts.integrationBefore, r3.r.facts.integrationHead], [true, U2, back]);
  assert.equal(baselineOf(world).head, back, 'a reset back to a commit seen before is a new record, not a cycle');
  // A rebase that drops a commit.
  const X1 = userCommits(world, 'x1.txt'); const X2 = userCommits(world, 'x2.txt');
  const r4 = await s2Run(world);
  assert.equal(r4.r.facts.integrationResynced, true); assert.equal(baselineOf(world).head, X2);
  git(world.repo, ['rebase', '-q', '--onto', back, X1, 'main']);
  const X2b = out(world.repo, ['rev-parse', 'HEAD']);
  assert.notEqual(X2b, X2);
  const r5 = await s2Run(world);
  assert.deepEqual([r5.r.facts.integrationRewrite, r5.r.facts.integrationHead], [true, X2b]);
  assert.equal(integrationHead(world), X2b);
  assert.equal((await status(world)).integrationConsistent, true);
  assert.equal(resyncRows(w).length, 5);
});

test('RC4 (B6): ingest refuses a rewrite that main did not allow, or when an accept is in flight; the next session then records the moved ref', async () => {
  const world = await candidateWorld();
  const { w } = world;
  const first = world.initial;
  const c = await makeChange(world);
  approve(world, c.versionId);
  const A = amend(world);
  // (1) The runner is told it may rewrite, the job's own params (main's verdict) say it may not: nothing is recorded.
  const forged = await s2Run(world, { allowRewrite: false, runnerAllows: true });
  assert.equal(forged.r.facts.integrationRewrite, true);
  assert.equal(jobRow(w, forged.s.job.id).state, 'failed');
  assert.equal(JSON.parse(jobRow(w, forged.s.job.id).error_json).code, 'rewrite_refused');
  assert.equal(resyncRows(w).length, 0);
  assert.equal(integrationHead(world), A, 'the ref was moved by the runner, unrecorded: O25 says so');
  assert.equal((await status(world)).integrationConsistent, false);
  // (2) An accept appeared meanwhile: the new rewrite is refused by the same-transaction check, nothing is recorded.
  git(world.repo, ['update-ref', REF, first]);
  const svc = acceptSvc(w);
  const live = { s: await secondSession(world) };        // queued while nothing is in flight: main's verdict is allowRewrite true
  const p = svc.accept(w.me, c.versionId, first); p.catch(() => {});
  live.r = await live.s.run();                           // the accept job is live now, so the ingest refuses
  assert.equal(JSON.parse(jobRow(w, live.s.job.id).params_json).allowRewrite, true);
  assert.equal(JSON.parse(jobRow(w, live.s.job.id).error_json).code, 'rewrite_refused');
  assert.equal(resyncRows(w).length, 0);
  // The accept's CAS then misses (the ref moved to A): it fails ref_moved and nothing is recorded for it.
  const r = await runEngine(w, world, jobOf(w, 'changeset.accept').id);
  assert.equal(r.refused, 'ref_moved');
  await assert.rejects(p, (e) => e.detail.reason === 'ref_moved');
  // (3) With no accept in flight, the next session finds the ref on the branch head and records the rewrite.
  const next = await s2Run(world);
  assert.deepEqual([next.r.facts.integrationResynced, next.r.facts.integrationRewrite, next.r.facts.integrationBefore, next.r.facts.integrationHead], [true, true, first, A]);
  assert.equal(jobRow(w, next.s.job.id).state, 'completed');
  assert.equal(baselineOf(world).head, A);
  assert.equal((await status(world)).integrationConsistent, true);
});

test('RC7 (minor 1): a cancel of the turn, or of the worktree job itself, never stops the worktree job; it completes and records its resync', async () => {
  const world = await acceptedWorld();
  const { w } = world;
  const S = integrationHead(world);
  await (await mergeWith(world, S)).p;
  const U = userCommits(world);
  const s = await secondSession(world, { child: true });
  assert.throws(() => w.nx.exec.cancel(w.me, s.job.id), (e) => e.code === 'conflict' && e.detail.reason === 'not_cancellable');
  // The runner is in the middle of the job (the ref is moved); the turn is cancelled; the cascade skips the worktree job.
  const attempt = leaseAndRun(w, s.job.id);
  const f = await ensureWorktree(world.g, { repoPath: world.repo, worktreePath: s.wt, ref: `refs/nexus/job/${s.name}`, integrationRef: REF, branch: 'main',
    expectedIntegrationHead: S, allowRewrite: true }, { dataRoot: world.home });
  assert.equal(integrationHead(world), U);
  w.nx.exec.cancel(w.me, s.turn2.job.id);
  assert.equal(jobRow(w, s.turn2.job.id).state, 'cancelled');
  assert.equal(jobRow(w, s.job.id).state, 'running', 'the worktree job was not cancelled');
  assert.equal(jobRow(w, s.job.id).cancel_requested_at, null);
  finish(s.turn2, attempt, { parsed: [gitFacts(f)] });
  assert.equal(jobRow(w, s.job.id).state, 'completed');
  assert.equal(resyncRows(w).length, 1);
  assert.equal(baselineOf(world).head, U);
  assert.equal((await status(world)).integrationConsistent, true);
});
