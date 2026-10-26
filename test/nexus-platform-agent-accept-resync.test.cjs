'use strict';
// B2b Task 9 final-review round: B6, the integration ref resync (RB1-RB4)
// The world and the real-git runner stand-in are test/helpers/acceptWorld.cjs (the same as nexus-platform-agent-accept.test.cjs).
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const W = require('./helpers/acceptWorld.cjs');
const { PROJECT, WORKSPACE, git, out, jobRow, findJobs, version, leaseAndRun, finish, gitFacts, gitRefused, ulid, runEngine, jobOf, candidateWorld, makeChange,
  approve, integrationHead, acceptWith, acceptedWorld, merge, mergeWith, acceptSvc, heldAccept, loadTs, openRunningTurn, immediateTx, transitionAttemptTx, attemptRow,
  ChangeSetService, ensureWorktree, GitFailure, gitAccept, preparedOf } = W;
// ---------- final-review round: B6 resync, B5 late marker and no cancel, A1 preview, dialog title ----------

const { integrationBaseline, baselineRecords } = loadTs('src/main/nexus/repo/integrationBaseline.ts');
const { mergeDialogOptions } = loadTs('src/main/nexusExec/mergeDialog.ts');
const { GIT_FAILURE_TEXT } = loadTs('src/main/nexus/exec/recovery.ts');
const { previewComplete } = loadTs('src/main/nexus/review/reviewService.ts');
const { versionViewOfKind } = loadTs('src/main/nexusIpc/dto.ts');
const REF = 'refs/nexus/accepted/main';
const baselineOf = (world) => integrationBaseline(world.w.db, PROJECT, REF);

/** A second agent session on the same project: its worktree job is queued with the recorded head, then the runner's real engine runs it. */
async function secondSession(world, o = {}) {
  const { w, g } = world;
  const turn2 = openRunningTurn(w.db, w.nx, { repoPath: world.repo });
  const name2 = turn2.session.id.toLowerCase();
  const wt2 = path.join(world.home, 'wt', name2);
  const baseline = o.baseline !== undefined ? o.baseline : baselineOf(world).head;
  const res = immediateTx(w.db, () => w.nx.jobs.createTx(w.sys, { kind: 'tool.run', projectId: PROJECT, workspaceId: WORKSPACE, idempotencyKey: `wt-${name2}-${ulid()}`,
    recipeId: 'repo.worktree', params: { sessionId: turn2.session.id, branch: 'main', integrationBaseline: baseline } }));
  const sub = { ...world, turn: turn2, name: name2, wt: wt2 };
  sub.service = new ChangeSetService(w.db, { jobs: w.nx.jobs, system: w.sys, now: () => w.clock.t, waitMs: 60_000 });
  const run = async () => {
    const attempt = leaseAndRun(w, res.job.id);
    try {
      const f = await ensureWorktree(g, { repoPath: world.repo, worktreePath: wt2, ref: `refs/nexus/job/${name2}`, integrationRef: REF, branch: 'main',
        expectedIntegrationHead: JSON.parse(jobRow(w, res.job.id).params_json).integrationBaseline }, { dataRoot: world.home });
      if (o.crash) return { facts: f, crashed: true };
      finish(turn2, attempt, { parsed: [gitFacts(f)] });
      return { facts: f };
    } catch (e) {
      if (!(e instanceof GitFailure)) throw e;
      finish(turn2, attempt, { code: 1, parsed: [gitRefused(e.code)] });
      return { refused: e.code };
    }
  };
  return { sub, turn2, job: res.job, run, name: name2, wt: wt2 };
}
const resyncRows = (w) => w.db.prepare("SELECT details_json, actor_kind FROM activity WHERE action = 'repo.integration_resync' ORDER BY seq").all();
function userCommits(world, file = 'mine.txt', text = 'mine\n') {
  fs.writeFileSync(path.join(world.repo, file), text); git(world.repo, ['add', file]); git(world.repo, ['commit', '-q', '-m', `user ${file}`]);
  return out(world.repo, ['rev-parse', 'HEAD']);
}

test('RB1 (B6): after a merge the user commits; the next session resyncs the integration ref, sees the commit, and a second full cycle accepts and fast-forwards', async () => {
  const world = await acceptedWorld();
  const { w } = world;
  const S = integrationHead(world);
  await (await mergeWith(world, S)).p;
  const U = userCommits(world);
  assert.equal(baselineOf(world).head, S, 'the recorded head is the last accept');
  const st0 = await w.nx.accepts.status(w.me, PROJECT);
  assert.deepEqual([st0.integrationConsistent, st0.integrationDiverged, st0.commitCount], [true, false, 0]);
  const s2 = await secondSession(world);
  const r = await s2.run();
  assert.equal(r.facts.integrationResynced, true); assert.equal(r.facts.integrationBefore, S); assert.equal(r.facts.integrationHead, U);
  assert.equal(jobRow(w, s2.job.id).state, 'completed');
  assert.equal(integrationHead(world), U, 'the ref moved forward to the user\'s own commit');
  const rows = resyncRows(w);
  assert.equal(rows.length, 1); assert.equal(rows[0].actor_kind, 'system');
  assert.deepEqual(JSON.parse(rows[0].details_json), { branch: 'main', before: S, after: U }, 'commit ids only');
  assert.equal(baselineOf(world).head, U);
  assert.equal((await w.nx.accepts.status(w.me, PROJECT)).integrationConsistent, true, 'O25 holds after the resync');
  assert.equal(fs.readFileSync(path.join(s2.wt, 'mine.txt'), 'utf8'), 'mine\n', 'the agent sees the user\'s commit');
  // The second cycle: change, review, accept, merge: a fast-forward.
  const c = await makeChange(s2.sub, { file: 'second.txt', content: 'second\n', title: 'Second change' });
  approve(world, c.versionId);
  const acc = await acceptWith(world, c.versionId, integrationHead(world));
  const res = await acc.p;
  assert.equal(res.accept.refBefore, U); assert.equal(res.version.status, 'active');
  const N = integrationHead(world);
  const m = await (await mergeWith(world, N)).p;
  assert.equal(m.merge.before, U); assert.equal(m.merge.after, N);
  assert.equal(out(world.repo, ['rev-parse', 'HEAD']), N);
  assert.equal(fs.readFileSync(path.join(world.repo, 'second.txt'), 'utf8'), 'second\n');
  assert.equal(fs.readFileSync(path.join(world.repo, 'mine.txt'), 'utf8'), 'mine\n');
});

test('RB2 (B6): an accept still waiting to be merged is never resynced over; a diverged branch refuses with its sentence', async () => {
  const world = await acceptedWorld();
  const { w } = world;
  const S = integrationHead(world);
  const s2 = await secondSession(world);
  const r = await s2.run();
  assert.equal(r.facts.integrationResynced, undefined, 'no resync');
  assert.equal(integrationHead(world), S, 'the ref is untouched');
  assert.equal(resyncRows(w).length, 0);
  assert.equal(out(world.repo, ['rev-parse', `refs/nexus/job/${s2.name}`]), S, 'the new session starts from the accepted work');
  assert.equal(jobRow(w, s2.job.id).state, 'completed');
  // The user now commits on their own branch while the accept still waits: both sides moved.
  userCommits(world, 'late.txt', 'late\n');
  const st = await w.nx.accepts.status(w.me, PROJECT);
  assert.equal(st.integrationDiverged, true); assert.equal(st.integrationConsistent, true);
  const s3 = await secondSession(world);
  const r3 = await s3.run();
  assert.equal(r3.refused, 'integration_diverged');
  const j = jobRow(w, s3.job.id);
  assert.equal(j.state, 'failed');
  assert.equal(JSON.parse(j.error_json).code, 'integration_diverged');
  assert.equal(JSON.parse(j.error_json).message, GIT_FAILURE_TEXT.integration_diverged);
  assert.match(GIT_FAILURE_TEXT.integration_diverged, /both moved on/);
  assert.equal(integrationHead(world), S, 'nothing was touched');
  assert.equal(resyncRows(w).length, 0);
  await assert.rejects(merge(world, () => true), (e) => e.detail.reason === 'not_fast_forward');
});

test('RB3 (B6): O25 stays true after a resync and is false after a ref moved by hand; a ref moved before its record is detected and then recorded by the retry', async () => {
  const world = await acceptedWorld();
  const { w } = world;
  const S = integrationHead(world);
  await (await mergeWith(world, S)).p;
  const U = userCommits(world);
  // Crash between the ref CAS and the record: the runner moved the ref, its facts never reached main.
  const s2 = await secondSession(world, { crash: true });
  const crashed = await s2.run();
  assert.equal(crashed.facts.integrationResynced, true);
  assert.equal(integrationHead(world), U);
  assert.equal(resyncRows(w).length, 0, 'no record');
  assert.equal(baselineOf(world).head, S, 'the record is the baseline, so the unrecorded move is not');
  const st = await w.nx.accepts.status(w.me, PROJECT);
  assert.equal(st.integrationConsistent, false, 'detected');
  const c0 = await makeChange(world, { file: 'x1.txt', title: 'X1' });
  approve(world, c0.versionId);
  await assert.rejects(w.nx.accepts.accept(w.me, c0.versionId, U), (e) => e.detail.reason === 'integration_unexpected');
  assert.equal(findJobs(w, 'changeset.accept').length, 1, 'only the first cycle accept job');
  // The retried worktree job (a new job with the recorded head) finds the ref moved forward from it and records it.
  const retry = await secondSession(world);
  const r = await retry.run();
  assert.equal(r.facts.integrationResynced, true); assert.equal(r.facts.integrationBefore, S);
  assert.equal(resyncRows(w).length, 1);
  assert.equal(baselineOf(world).head, U);
  assert.equal((await w.nx.accepts.status(w.me, PROJECT)).integrationConsistent, true);
  // A ref moved by hand afterwards is inconsistent again.
  git(world.repo, ['update-ref', REF, S]);
  assert.equal((await w.nx.accepts.status(w.me, PROJECT)).integrationConsistent, false);
  await assert.rejects(w.nx.accepts.accept(w.me, c0.versionId, S), (e) => e.detail.reason === 'integration_unexpected');
  git(world.repo, ['update-ref', REF, U]);
  assert.equal((await w.nx.accepts.status(w.me, PROJECT)).integrationConsistent, true);
});

test('RB4 (B6): a resync whose facts do not start from the recorded head is refused and never recorded; a runner without the field is fine; a hand-moved ref is never adopted', async () => {
  const world = await acceptedWorld();
  const { w } = world;
  const S = integrationHead(world);
  await (await mergeWith(world, S)).p;
  const U = userCommits(world);
  // Facts naming another `before`.
  const s2 = await secondSession(world);
  const attempt = leaseAndRun(w, s2.job.id);
  const f = await ensureWorktree(world.g, { repoPath: world.repo, worktreePath: s2.wt, ref: `refs/nexus/job/${s2.name}`, integrationRef: REF, branch: 'main' }, { dataRoot: world.home });
  assert.equal(f.integrationResynced, undefined, 'no expected head, no resync (an old plan)');
  finish(s2.turn2, attempt, { parsed: [gitFacts({ ...f, integrationResynced: true, integrationBefore: world.initial, integrationHead: U, branchHead: U })] });
  assert.equal(jobRow(w, s2.job.id).state, 'failed');
  assert.equal(JSON.parse(jobRow(w, s2.job.id).error_json).code, 'resync_mismatch');
  assert.equal(resyncRows(w).length, 0);
  // A session with facts that lack the field completes as before (a runner from before B6).
  const s3 = await secondSession(world, { baseline: null });
  const a3 = leaseAndRun(w, s3.job.id);
  const f3 = await ensureWorktree(world.g, { repoPath: world.repo, worktreePath: s3.wt, ref: `refs/nexus/job/${s3.name}`, integrationRef: REF, branch: 'main' }, { dataRoot: world.home });
  const { integrationResynced, integrationBefore, branchHead, ...old } = f3;
  void integrationResynced; void integrationBefore; void branchHead;
  finish(s3.turn2, a3, { parsed: [gitFacts(old)] });
  assert.equal(jobRow(w, s3.job.id).state, 'completed');
  // A ref moved by hand to a commit that is NOT on the branch is never adopted (accept's unrecorded commit, an agent's commit).
  const stray = out(world.repo, ['commit-tree', `${S}^{tree}`, '-p', S, '-m', 'stray']);
  git(world.repo, ['update-ref', REF, stray]);
  const s4 = await secondSession(world);
  const r4 = await s4.run();
  assert.equal(r4.refused, 'integration_diverged', 'the stray commit is on neither side of the branch');
  assert.equal(integrationHead(world), stray, 'untouched');
  assert.equal(resyncRows(w).length, 0);
});

