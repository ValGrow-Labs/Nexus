'use strict';
// B2b Task 9: review turns, crash and reject rollback, O25, the confirmed sha, the accept-time conflict: RA10-RA17
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

// ---------- RA10 ----------

test('RA10: request_changes calls the TurnStarter with the reviewing user and the review id; a missing comment answers invalid', async () => {
  const world = await candidateWorld();
  const { w } = world;
  const c = await makeChange(world);
  assert.throws(() => w.nx.reviews.decide(w.me, c.versionId, { decision: 'request_changes', intentId: ulid() }), (e) => e.code === 'invalid');
  assert.throws(() => w.nx.reviews.decide(w.me, c.versionId, { decision: 'reject', comment: '   ', intentId: ulid() }), (e) => e.code === 'invalid');
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM reviews').get().n, 0);
  const intent = ulid();
  const r = w.nx.reviews.decide(w.me, c.versionId, { decision: 'request_changes', comment: 'please rename the file', intentId: intent });
  assert.equal(world.turns.length, 1);
  assert.equal(world.turns[0].user.id, 'user:local'); assert.equal(world.turns[0].user.kind, 'user');
  assert.equal(world.turns[0].reviewId, r.review.id);
  assert.equal(world.turns[0].sessionId, world.turn.session.id);
  assert.deepEqual(r.job, { id: 'J1' });
  // The same intent again answers the same review and starts no second turn.
  const again = w.nx.reviews.decide(w.me, c.versionId, { decision: 'request_changes', comment: 'please rename the file', intentId: intent });
  assert.equal(again.review.id, r.review.id); assert.equal(world.turns.length, 1);
  assert.throws(() => w.nx.reviews.decide(w.me, c.versionId, { decision: 'approve', intentId: intent }), (e) => e.detail.reason === 'intent_mismatch');
  // A secret-shaped comment is refused (it reaches the agent's next turn).
  assert.throws(() => w.nx.reviews.decide(w.me, c.versionId, { decision: 'reject', comment: 'use AKIAABCDEFGHIJKLMNOP here', intentId: ulid() }), (e) => e.detail.reason === 'secret_in_comment');
  // The activity row never holds the comment.
  const act = w.db.prepare("SELECT details_json FROM activity WHERE action = 'review.decide'").get().details_json;
  assert.ok(!act.includes('rename'));
  // approve and reject start no turn.
  w.nx.reviews.decide(w.me, c.versionId, { decision: 'reject', comment: 'no thanks', intentId: ulid() });
  assert.equal(world.turns.length, 1);
});

test('RA10b: a TurnStarter that refuses (agents unavailable) makes request_changes answer agents_unavailable and record nothing', async () => {
  const world = await candidateWorld({ stubTurns: true });
  const c = await makeChange(world);
  assert.throws(() => world.w.nx.reviews.decide(world.w.me, c.versionId, { decision: 'request_changes', comment: 'change it', intentId: ulid() }),
    (e) => e.code === 'unavailable' && e.detail.reason === 'agents_unavailable');
  assert.equal(world.w.db.prepare('SELECT COUNT(*) AS n FROM reviews').get().n, 0, 'the review row rolled back with the refused turn');
  // approve and reject need no turn.
  world.w.nx.reviews.decide(world.w.me, c.versionId, { decision: 'approve', intentId: ulid() });
  assert.equal(world.w.db.prepare('SELECT COUNT(*) AS n FROM reviews').get().n, 1);
});

// ---------- RA11-RA14 ----------

test('RA11: a crash after update-ref and before ingest: the restart rolls the ref back to old, and Merge is never offered for that sha', async () => {
  const world = await candidateWorld();
  const { w } = world;
  const c = await makeChange(world);
  approve(world, c.versionId);
  const old = integrationHead(world);
  const p = w.nx.accepts.accept(w.me, c.versionId, old); p.catch(() => {});
  const job = jobOf(w, 'changeset.accept');
  const held = await runEngine(w, world, job.id, { hold: true });   // the ref moved; the exit was never ingested
  const moved = integrationHead(world);
  assert.notEqual(moved, old);
  assert.deepEqual(preparedOf(w.db, job.id), { old, new: moved }, 'accept.prepared was recorded before the move');
  void held;
  // Merge is not offered while the ref and the records disagree (O25).
  const st = await w.nx.accepts.status(w.me, PROJECT);
  assert.equal(st.integrationConsistent, false);
  await assert.rejects(merge(world, () => true, moved), (e) => e.detail.reason === 'integration_unexpected');
  // The app restarts: phase A (no runner) interrupts the accept and queues the rollback. It is never retried.
  w.nx.exec.recoverPhaseA(w.sys, w.nx.bootId, w.clock.t);
  assert.equal(jobRow(w, job.id).state, 'interrupted');
  const rollbacks = findJobs(w, 'changeset.accept_rollback');
  assert.equal(rollbacks.length, 1);
  assert.deepEqual({ from: JSON.parse(rollbacks[0].params_json).from, to: JSON.parse(rollbacks[0].params_json).to }, { from: moved, to: old });
  assert.equal(findJobs(w, 'changeset.accept').length, 1, 'never retried');
  w.nx.exec.recoverPhaseA(w.sys, w.nx.bootId, w.clock.t);
  assert.equal(findJobs(w, 'changeset.accept_rollback').length, 1, 'a second restart queues no second rollback');
  // The rollback runs and completes (it has a durable record, so the evidence backstop lets it end).
  await runEngine(w, world, rollbacks[0].id);
  assert.equal(integrationHead(world), old);
  assert.equal(jobRow(w, rollbacks[0].id).state, 'completed');
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM change_set_accepts').get().n, 0);
  assert.equal(version(w, c.versionId).status, 'candidate');
  assert.equal((await w.nx.accepts.status(w.me, PROJECT)).integrationConsistent, true);
  await assert.rejects(merge(world, () => true, moved), (e) => e.detail.reason === 'integration_unexpected', 'never offered for that sha');
  assert.ok(w.db.prepare("SELECT 1 FROM activity WHERE action = 'exec.recover' AND details_json LIKE '%accept_rollback%'").get());
});

test('RA12: a reject recorded between the job\'s start and ingest: the ingest refuses, the ref is rolled back, the version is still a candidate', async () => {
  const world = await candidateWorld();
  const { w } = world;
  const c = await makeChange(world);
  approve(world, c.versionId);
  const old = integrationHead(world);
  const p = w.nx.accepts.accept(w.me, c.versionId, old); p.catch(() => {});
  const job = jobOf(w, 'changeset.accept');
  const held = await runEngine(w, world, job.id, { hold: true });
  const moved = integrationHead(world);
  assert.notEqual(moved, old);
  w.nx.reviews.decide(w.me, c.versionId, { decision: 'reject', comment: 'changed my mind', intentId: ulid() });
  held.finish();
  await assert.rejects(p, (e) => e.code === 'conflict' && e.detail.reason === 'accept_rolled_back');
  assert.equal(jobRow(w, job.id).state, 'failed');
  assert.equal(JSON.parse(jobRow(w, job.id).error_json).code, 'accept_rolled_back');
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM change_set_accepts').get().n, 0);
  assert.equal(version(w, c.versionId).status, 'candidate');
  assert.equal(version(w, c.versionId).promoted_at, null);
  const rb = findJobs(w, 'changeset.accept_rollback');
  assert.equal(rb.length, 1, 'enqueued by the same transaction that failed the job');
  assert.deepEqual({ from: JSON.parse(rb[0].params_json).from, to: JSON.parse(rb[0].params_json).to }, { from: moved, to: old });
  await runEngine(w, world, rb[0].id);
  assert.equal(integrationHead(world), old, 'the ref is back');
  assert.equal(jobRow(w, rb[0].id).state, 'completed');
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM validations WHERE job_id = ? AND validator_id = 'git.applies_cleanly'").get(job.id).n, 0, 'the refused ingest left no row');
  assert.ok(w.db.prepare("SELECT 1 FROM activity WHERE action = 'changeset.accept' AND status = 'failed'").get());
  assert.equal(findJobs(w, 'changeset.accept').length, 1, 'never retried');
});

test('RA13: the integration ref moved by hand: status reads integrationConsistent false and merge refuses integration_unexpected', async () => {
  const world = await acceptedWorld();
  const sha = integrationHead(world);
  let st = await world.w.nx.accepts.status(world.w.me, PROJECT);
  assert.equal(st.integrationConsistent, true); assert.equal(st.integrationHead, sha); assert.equal(st.lastAcceptedHead, sha);
  assert.equal(st.userTreeClean, true); assert.equal(st.branch, 'main'); assert.equal(st.acceptedNotMerged, 1, 'one accepted change'); assert.ok(st.commitCount >= 2, 'its commits'); assert.equal(st.fastForward, true);
  git(world.repo, ['update-ref', 'refs/nexus/accepted/main', world.initial]);
  st = await world.w.nx.accepts.status(world.w.me, PROJECT);
  assert.equal(st.integrationConsistent, false);
  await assert.rejects(merge(world, () => true, sha), (e) => e.code === 'conflict' && e.detail.reason === 'integration_unexpected');
  await assert.rejects(merge(world, () => true, world.initial), (e) => e.detail.reason === 'integration_unexpected');
  assert.equal(out(world.repo, ['rev-parse', 'HEAD']), world.initial, 'the user\'s branch is untouched');
  assert.equal(world.w.db.prepare('SELECT COUNT(*) AS n FROM repo_merges').get().n, 0);
  // Before anything is accepted, the initial head is the consistent one.
  const fresh = await candidateWorld();
  assert.equal((await fresh.w.nx.accepts.status(fresh.w.me, PROJECT)).integrationConsistent, true);
  git(fresh.repo, ['update-ref', 'refs/nexus/accepted/main', fresh.initial]);
  fs.writeFileSync(path.join(fresh.repo, 'y.txt'), 'y\n'); git(fresh.repo, ['add', 'y.txt']); git(fresh.repo, ['commit', '-q', '-m', 'y']);
  git(fresh.repo, ['update-ref', 'refs/nexus/accepted/main', out(fresh.repo, ['rev-parse', 'HEAD'])]);
  assert.equal((await fresh.w.nx.accepts.status(fresh.w.me, PROJECT)).integrationConsistent, false, 'moved by hand with nothing accepted');
});

test('RA14: merge uses the confirmed sha: a ref moved after the dialog is not merged; the branch lands on the confirmed commit or the merge refuses', async () => {
  const world = await acceptedWorld();
  const confirmed = integrationHead(world);
  // After the dialog showed `confirmed`, the integration ref is moved by hand to a newer commit.
  const extra = out(world.repo, ['commit-tree', `${confirmed}^{tree}`, '-p', confirmed, '-m', 'moved by hand']);
  const { p, job } = await mergeWith(world, confirmed, () => { git(world.repo, ['update-ref', 'refs/nexus/accepted/main', extra]); return true; });
  const { merge: m } = await p;
  assert.equal(integrationHead(world), extra, 'the ref is where it was moved');
  assert.equal(JSON.parse(jobRow(world.w, job.id).params_json).sha, confirmed, 'the job names the confirmed commit');
  assert.equal(out(world.repo, ['rev-parse', 'HEAD']), confirmed, 'the branch is at the confirmed commit, not the moved ref');
  assert.equal(m.shaConfirmed, confirmed); assert.equal(m.after, confirmed);
  // Second variant: the user's branch moves on after the dialog: the fast-forward refuses and nothing is merged.
  const world2 = await acceptedWorld();
  const confirmed2 = integrationHead(world2);
  const { p: p2, r } = await mergeWith(world2, confirmed2, () => {
    fs.writeFileSync(path.join(world2.repo, 'late.txt'), 'late\n'); git(world2.repo, ['add', 'late.txt']); git(world2.repo, ['commit', '-q', '-m', 'late']);
    return true;
  });
  assert.equal(r.refused, 'not_fast_forward');
  await assert.rejects(p2, (e) => e.code === 'conflict' && e.detail.reason === 'not_fast_forward');
  assert.equal(world2.w.db.prepare('SELECT COUNT(*) AS n FROM repo_merges').get().n, 0);
  assert.ok(!out(world2.repo, ['log', '--format=%H', 'main']).split('\n').includes(confirmed2), 'the accepted work was not merged');
  // A merge job that was not confirmed in the dialog never leaves a row (ingest requires confirmedVia).
  const w = world2.w;
  const res = immediateTx(w.db, () => w.nx.jobs.createTx(w.sys, { kind: 'tool.run', projectId: PROJECT, workspaceId: WORKSPACE, idempotencyKey: 'ff-unconfirmed', recipeId: 'repo.ff',
    params: { branch: 'main', sha: confirmed2, mergedBy: 'user:local' } }));
  w.db.prepare("UPDATE jobs SET capabilities_json = ? WHERE id = ?").run(JSON.stringify([{ action: 'system.repo.ff', recipe: 'repo.ff', recipeVersion: '1', executor: 'engine', network: 'none', profile: null }]), res.job.id);
  const attempt = leaseAndRun(w, res.job.id);
  finish(world2.turn, attempt, { parsed: [gitFacts({ before: world2.initial, after: confirmed2, branch: 'main' })] });
  assert.equal(jobRow(w, res.job.id).state, 'failed');
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM repo_merges').get().n, 0);
  // M1: the branch moved (the facts said so) and the row was refused: the move is audited as a failed repo.merge row.
  const audit = w.db.prepare("SELECT details_json FROM activity WHERE action = 'repo.merge' AND status = 'failed'").get();
  assert.ok(audit, 'a refused merge row is audited');
  assert.deepEqual(JSON.parse(audit.details_json), { reason: 'bad_input', before: world2.initial, after: confirmed2 });
});

// ---------- the accept-time advisory re-check ----------


test('RA15: a merge conflict at accept does not touch the version: accept answers merge_conflict and writes an ADVISORY failed git.applies_cleanly row', async () => {
  const world = await candidateWorld();
  const { w } = world;
  const { second, recorded } = await conflictingPair(world);
  const { p, r, job } = await acceptWith(world, second.versionId, recorded);
  assert.equal(r.refused, 'merge_conflict');
  await assert.rejects(p, (e) => e.code === 'conflict' && e.detail.reason === 'merge_conflict');
  assert.equal(version(w, second.versionId).status, 'candidate', 'the version is not touched');
  const row = w.db.prepare("SELECT * FROM validations WHERE version_id = ? AND validator_id = 'git.applies_cleanly' AND job_id = ?").get(second.versionId, job.id);
  assert.equal(row.status, 'failed'); assert.equal(row.advisory, 1); assert.equal(row.blocking, 0);
  assert.equal(integrationHead(world), recorded, 'no ref move');
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM change_set_accepts').get().n, 1, 'only the first accept');
});

test('RA16: the six validators and the accept rows are written by main only through the services (source pins)', () => {
  const root = path.join(__dirname, '..');
  const accept = fs.readFileSync(path.join(root, 'src', 'main', 'nexus', 'exec', 'acceptIngest.ts'), 'utf8');
  assert.match(accept, /promoteTx\(user,/, 'the promotion is the user\'s');
  assert.doesNotMatch(accept, /promoteTx\(system/);
  const svc = fs.readFileSync(path.join(root, 'src', 'main', 'nexus', 'repo', 'acceptService.ts'), 'utf8');
  assert.match(svc, /requireStoredUser\(this\.deps\.principals, this\.deps\.auth, user, 'changeset\.accept'/);
  assert.match(svc, /requireStoredUser\(this\.deps\.principals, this\.deps\.auth, user, 'repo\.merge'/);
  const rev = fs.readFileSync(path.join(root, 'src', 'main', 'nexus', 'review', 'reviewService.ts'), 'utf8');
  assert.match(rev, /requireStoredUser\(this\.deps\.principals, this\.deps\.auth, user, 'review\.decide'/);
});

test('RA17: the evidence backstop lets a record-only git job complete (worktree row, rollback, merge row) and nothing else', async () => {
  const world = await candidateWorld();
  const { w } = world;
  // A second session's worktree job completes through its own durable record (the session_worktrees row).
  const turn2 = openRunningTurn(w.db, w.nx, { repoPath: world.repo });
  const name = turn2.session.id.toLowerCase();
  const res = immediateTx(w.db, () => w.nx.jobs.createTx(w.sys, { kind: 'tool.run', projectId: PROJECT, workspaceId: WORKSPACE, idempotencyKey: 'wt-2', recipeId: 'repo.worktree',
    params: { sessionId: turn2.session.id, branch: 'main' } }));
  const attempt = leaseAndRun(w, res.job.id);
  finish(turn2, attempt, { parsed: [gitFacts({ integrationHead: world.initial, integrationCreated: false, ref: `refs/nexus/job/${name}`, base: world.initial,
    worktree: `wt/${name}`, locked: true, reused: false })] });
  assert.equal(jobRow(w, res.job.id).state, 'completed');
  assert.ok(w.db.prepare('SELECT 1 FROM session_worktrees WHERE session_id = ?').get(turn2.session.id));
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'nexus', 'exec', 'executionService.ts'), 'utf8');
  assert.match(src, /RECORD_ONLY_RECIPES: readonly string\[\] = Object\.freeze\(\['repo\.worktree', 'changeset\.accept_rollback', 'repo\.ff'\]\)/);
  assert.match(src, /d\.durableRecord === true && RECORD_ONLY_RECIPES\.includes\(recipe\.id\)/);
});
