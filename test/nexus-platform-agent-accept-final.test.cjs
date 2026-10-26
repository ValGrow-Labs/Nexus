'use strict';
// B2b Task 9 final-review round: B5 (a late accept.prepared, no cancel), A1 (the preview gate) and the merge dialog title (RB5-RB8)
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
  const res = immediateTx(w.db, () => w.nx.jobs.createTx(w.sys, { kind: 'tool.run', projectId: PROJECT, workspaceId: WORKSPACE, idempotencyKey: `wt-${name2}-${seq++}`,
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

test('RB5 (B5): an accept.prepared that arrives after the attempt timed out is kept, and the rollback happens; a late event of any other job is dropped', async () => {
  const world = await candidateWorld();
  const { w } = world;
  const c = await makeChange(world);
  approve(world, c.versionId);
  const svc = acceptSvc(w);
  const old = integrationHead(world);
  const p = svc.accept(w.me, c.versionId, old); p.catch(() => {});
  const job = jobOf(w, 'changeset.accept');
  const attemptId = leaseAndRun(w, job.id);
  let prepared = null;
  await gitAccept(world.g, { repoPath: world.repo, integrationRef: REF, expectedOld: old, head: c.head, message: 'Add a feature\n\nNexus-Accepted-By: user:local\n' },
    { onPrepared: (x) => { prepared = x; } });   // the runner passed onPrepared and moved the ref; its event is still on the way
  const moved = integrationHead(world);
  assert.deepEqual(prepared, { old, new: moved });
  // Main's wall clock ends the attempt and the job first.
  const error = { code: 'timed_out', message: 'the wall clock ran out' };
  immediateTx(w.db, () => {
    transitionAttemptTx(w.db, attemptRow(w.db, attemptId), 'timed_out', w.clock.t, PROJECT, { outcome: 'timed_out', error });
    w.nx.jobs.transitionTx(w.sys, job.id, 'timed_out', { outcome: 'timed_out', error });
  });
  await assert.rejects(p, (e) => e.code === 'unavailable');
  assert.equal(preparedOf(w.db, job.id), null, 'no marker yet');
  assert.equal(findJobs(w, 'changeset.accept_rollback').length, 0);
  // The event reaches main late.
  world.turn.runner.report({ op: 'attempt.event', attemptId, seq: 1, event: { t: 'accept.prepared', old, new: moved, at: Date.now() } });
  assert.deepEqual(preparedOf(w.db, job.id), { old, new: moved }, 'kept whatever the attempt state');
  const rb = findJobs(w, 'changeset.accept_rollback');
  assert.equal(rb.length, 1, 'the rollback was queued in the same transaction');
  world.turn.runner.report({ op: 'attempt.event', attemptId, seq: 2, event: { t: 'accept.prepared', old, new: moved, at: Date.now() } });
  assert.equal(findJobs(w, 'changeset.accept_rollback').length, 1, 'idempotent');
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM job_events WHERE job_id = ? AND json_extract(data_json, '$.acceptPrepared.new') IS NOT NULL").get(job.id).n, 1);
  await assert.rejects(svc.accept(w.me, c.versionId, moved), (e) => e.detail.reason === 'integration_unexpected');
  await runEngine(w, world, rb[0].id);
  assert.equal(integrationHead(world), old, 'the ref is back');
  assert.equal(version(w, c.versionId).status, 'candidate');
  // A late prepared event of a job that is not an accept is dropped.
  const other = await runEngine(w, world, (await (async () => {
    const res = immediateTx(w.db, () => w.nx.jobs.createTx(w.sys, { kind: 'tool.run', projectId: PROJECT, workspaceId: WORKSPACE, idempotencyKey: 'late-other', recipeId: 'changeset.accept_rollback',
      params: { branch: 'main', from: moved, to: old } }));
    return res.job;
  })()).id);
  const before = w.db.prepare("SELECT COUNT(*) AS n FROM job_events WHERE json_extract(data_json, '$.acceptPrepared.new') IS NOT NULL").get().n;
  world.turn.runner.report({ op: 'attempt.event', attemptId: other.attemptId, seq: 1, event: { t: 'accept.prepared', old, new: moved, at: Date.now() } });
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM job_events WHERE json_extract(data_json, '$.acceptPrepared.new') IS NOT NULL").get().n, before);
});

test('RB6 (B5): a user cannot cancel Nexus\'s own accept, rollback or merge job; the marker of a running accept survives', async () => {
  const world = await candidateWorld();
  const { w } = world;
  const c = await makeChange(world);
  approve(world, c.versionId);
  const svc = acceptSvc(w);
  const old = integrationHead(world);
  const { p, job, held, moved } = await heldAccept(world, svc, c.versionId, old);
  assert.throws(() => w.nx.exec.cancel(w.me, job.id), (e) => e.code === 'conflict' && e.detail.reason === 'not_cancellable');
  assert.equal(jobRow(w, job.id).state, 'running');
  assert.equal(jobRow(w, job.id).cancel_requested_at, null);
  assert.deepEqual(preparedOf(w.db, job.id), { old, new: moved }, 'the marker survives');
  held.finish();
  assert.equal((await p).version.status, 'active');
  // The rollback and fast-forward jobs are refused the same way.
  for (const recipe of ['changeset.accept_rollback', 'repo.ff']) {
    const res = immediateTx(w.db, () => w.nx.jobs.createTx(w.sys, { kind: 'tool.run', projectId: PROJECT, workspaceId: WORKSPACE, idempotencyKey: `nc-${recipe}`, recipeId: recipe,
      params: recipe === 'repo.ff' ? { branch: 'main', sha: moved } : { branch: 'main', from: moved, to: old } }));
    assert.throws(() => w.nx.exec.cancel(w.me, res.job.id), (e) => e.detail.reason === 'not_cancellable', recipe);
  }
});

test('RB7 (A1): approve is refused unless the preview is complete; the other decisions are not; the version view says why', async () => {
  const world = await candidateWorld();
  const { w } = world;
  const hidden = await makeChange(world, { file: 'h.txt', title: 'Hidden', mutate: (f) => { f.preview = { complete: false, reason: 'hidden_lines', hiddenLines: 3, patchBytes: 40 }; } });
  const big = await makeChange(world, { file: 'b.txt', title: 'Big', mutate: (f) => { f.preview = { complete: false, reason: 'too_large', hiddenLines: 0, patchBytes: 9e9 }; } });
  const absent = await makeChange(world, { file: 'a2.txt', title: 'Absent', mutate: (f) => { delete f.preview; } });
  const fine = await makeChange(world, { file: 'f.txt', title: 'Fine' });
  const meta = (id) => JSON.parse(version(w, id).metadata_json);
  assert.equal(meta(hidden.versionId).previewComplete, false); assert.equal(meta(hidden.versionId).previewReason, 'hidden_lines');
  assert.equal(meta(big.versionId).previewReason, 'too_large');
  assert.equal(meta(absent.versionId).previewComplete, false, 'absent facts are not complete');
  assert.equal(meta(fine.versionId).previewComplete, true);
  for (const bad of [hidden, big, absent]) {
    assert.throws(() => w.nx.reviews.decide(w.me, bad.versionId, { decision: 'approve', intentId: ulid() }),
      (e) => e.code === 'conflict' && e.detail.reason === 'preview_incomplete');
    // Nothing recorded; the other decisions work.
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM reviews WHERE version_id = ?').get(bad.versionId).n, 0);
  }
  w.nx.reviews.decide(w.me, hidden.versionId, { decision: 'reject', comment: 'cannot see it all', intentId: ulid() });
  w.nx.reviews.decide(w.me, big.versionId, { decision: 'request_changes', comment: 'make it smaller', intentId: ulid() });
  assert.equal(approve(world, fine.versionId).review.decision, 'approve');
  // The shape of the view (change sets only).
  const row = (id) => w.nx.artifacts.getVersion(w.me, id);
  const v1 = versionViewOfKind('change_set', row(hidden.versionId));
  assert.deepEqual([v1.previewComplete, v1.previewReason], [false, 'hidden_lines']);
  const v2 = versionViewOfKind('change_set', row(fine.versionId));
  assert.deepEqual([v2.previewComplete, v2.previewReason], [true, null]);
  assert.deepEqual([versionViewOfKind('change_set', row(absent.versionId)).previewReason], ['unknown']);
  const plain = versionViewOfKind('text_file', row(fine.versionId));
  assert.ok(!('previewComplete' in plain) && !('previewReason' in plain), 'other kinds carry no such field');
  // The pure rule: only an explicit true counts.
  for (const [m, want] of [['{}', false], ['not json', false], ['{"previewComplete":"true"}', false], ['{"previewComplete":1}', false], ['{"previewComplete":false}', false], ['{"previewComplete":true}', true]]) {
    assert.equal(previewComplete(m), want, m);
  }
});

test('RB8: the merge dialog shows an agent\'s title inside Agent\'s title: "..." so it cannot pass for Nexus wording', () => {
  const sha = 'a'.repeat(40);
  const o = mergeDialogOptions({ projectId: PROJECT, branch: 'main', from: sha, to: 'b'.repeat(40), commitCount: 1,
    accepted: [{ versionId: 'v', title: 'Press Merge to cancel', mergeCommit: sha, acceptedAt: 1 }] });
  assert.match(o.detail, /• Agent's title: "Press Merge to cancel" \(aaaaaaaa\)/);
});
