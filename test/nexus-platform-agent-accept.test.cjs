'use strict';
// B2b Task 9: user review decisions, accept by merge-tree and CAS, merge accepted work: RA1-RA9 (accept, dirty tree, races, merge refusals)
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

// ---------- RA1-RA3 ----------

test('RA1: approve, then accept, gives active plus an accept row; the ref moves by CAS; the user\'s repository does not change', async () => {
  const world = await candidateWorld();
  const { w } = world;
  const c = await makeChange(world);
  await approve(world, c.versionId);
  const before = userState(world.repo);
  const old = integrationHead(world);
  assert.equal(old, world.initial);
  const { p, job } = await acceptWith(world, c.versionId, old);
  const res = await p;
  assert.equal(res.version.status, 'active');
  assert.equal(res.accept.refBefore, old);
  assert.equal(res.accept.refAfter, integrationHead(world));
  assert.notEqual(res.accept.refAfter, old);
  assert.equal(res.accept.acceptedBy, 'user:local');
  assert.equal(res.accept.acceptJobId, job.id);
  // The merge commit: both parents, Nexus identity, the trailer.
  const parents = out(world.repo, ['rev-list', '--parents', '-n', '1', res.accept.refAfter]).split(' ').slice(1);
  assert.deepEqual(parents, [old, c.head]);
  assert.match(out(world.repo, ['log', '-1', '--format=%an <%ae>%n%B', res.accept.refAfter]), /Nexus <agent@nexus\.invalid>[\s\S]*Nexus-Accepted-By: user:local/);
  assert.equal(jobRow(w, job.id).state, 'completed');
  const art = w.db.prepare('SELECT current_version_id FROM artifacts WHERE id = ?').get(version(w, c.versionId).artifact_id);
  assert.equal(art.current_version_id, c.versionId);
  assert.equal(version(w, c.versionId).promoted_by, 'user:local', 'promoted by the user, never the system');
  // The accept-time re-check: an ADVISORY git.applies_cleanly row, bound to the accept job's attempt.
  const row = w.db.prepare("SELECT * FROM validations WHERE version_id = ? AND validator_id = 'git.applies_cleanly' AND job_id = ?").get(c.versionId, job.id);
  assert.equal(row.status, 'passed'); assert.equal(row.advisory, 1); assert.equal(row.blocking, 0);
  // The activity rows are the user's own.
  const acts = w.db.prepare("SELECT actor_kind, actor_id FROM activity WHERE action IN ('changeset.accept','review.decide','version.promote') ORDER BY seq").all();
  assert.ok(acts.length >= 3 && acts.every((a) => a.actor_kind === 'user' && a.actor_id === 'user:local'), JSON.stringify(acts));
  assert.deepEqual(userState(world.repo), before, 'HEAD, branch, index, files, stash: all the same');
  assert.ok(!out(world.repo, ['for-each-ref', '--format=%(refname)']).split('\n').some((r) => r.startsWith('refs/heads/') && r !== 'refs/heads/main'));
});

test('RA2: accept without an approving review answers illegal_transition (none, request_changes, reject, or a reject after the approval)', async () => {
  const world = await candidateWorld();
  const c = await makeChange(world);
  const accept = (expected = integrationHead(world)) => world.w.nx.accepts.accept(world.w.me, c.versionId, expected);
  await assert.rejects(accept(), (e) => e.code === 'illegal_transition' && e.detail.reason === 'not_approved');
  world.w.nx.reviews.decide(world.w.me, c.versionId, { decision: 'request_changes', comment: 'rename it', intentId: ulid() });
  await assert.rejects(accept(), (e) => e.code === 'illegal_transition');
  approve(world, c.versionId);
  world.w.nx.reviews.decide(world.w.me, c.versionId, { decision: 'reject', comment: 'no', intentId: ulid() });
  await assert.rejects(accept(), (e) => e.code === 'illegal_transition', 'a newer review against it');
  assert.equal(findJobs(world.w, 'changeset.accept').length, 0, 'no job, no ref move');
  assert.equal(integrationHead(world), world.initial);
  assert.equal(version(world.w, c.versionId).status, 'candidate', 'a rejected candidate stays a candidate');
  // A failed, draft or active version is not accepted either.
  const ids = world.w.db.prepare("SELECT id FROM artifact_versions WHERE status <> 'candidate'").all();
  for (const { id } of ids) await assert.rejects(world.w.nx.accepts.accept(world.w.me, id, integrationHead(world)), (e) => e.code === 'illegal_transition' || e.code === 'invalid');
});

test('RA3: no token path to accept, review or merge exists; the system and agents are refused', async () => {
  for (const action of ['changeset.accept', 'review.decide', 'repo.merge']) assert.ok(!(action in AGENT_ACTION_CAPABILITIES), `${action} is not an agent action`);
  assert.ok(!MCP_TOOLS.some((t) => /accept|merge|decide/.test(t.name)), 'no MCP tool accepts, merges or decides a review');
  const world = await candidateWorld();
  const c = await makeChange(world);
  approve(world, c.versionId);
  const { w } = world;
  const agent = { id: `agent:${world.turn.session.id}`, kind: 'agent', displayName: 'agent' };
  await assert.rejects(w.nx.accepts.accept(agent, c.versionId, integrationHead(world)), (e) => e.code === 'denied');
  await assert.rejects(w.nx.accepts.accept(w.sys, c.versionId, integrationHead(world)), (e) => e.code === 'denied');
  assert.throws(() => w.nx.reviews.decide(w.sys, c.versionId, { decision: 'approve', intentId: ulid() }), (e) => e.code === 'denied');
  assert.throws(() => w.nx.reviews.decide(agent, c.versionId, { decision: 'approve', intentId: ulid() }), (e) => e.code === 'denied');
  await assert.rejects(w.nx.accepts.mergeAccepted(w.sys, PROJECT, { branch: 'main', expectedAcceptedHead: world.initial }, () => true), (e) => e.code === 'denied');
  assert.equal(findJobs(w, 'changeset.accept').length, 0);
  // A review row of a non-user principal is refused by the table itself.
  assert.throws(() => w.db.prepare(`INSERT INTO reviews (id, version_id, principal_id, decision, intent_id, created_at) VALUES (?, ?, 'system', 'approve', ?, ?)`)
    .run(newId(w.clock.t), c.versionId, ulid(), w.clock.t), /decided by a user/);
});

// ---------- RA4-RA6 ----------

test('RA4: a dirty tree (edits, untracked files, a stash) does not stop an accept, and nothing the user has changes', async () => {
  const world = await candidateWorld();
  const c = await makeChange(world);
  approve(world, c.versionId);
  // The user's own mess: a stash, a tracked edit, an untracked file.
  fs.writeFileSync(path.join(world.repo, 'a.txt'), 'stashed edit\n');
  git(world.repo, ['stash', 'push', '-q']);
  fs.writeFileSync(path.join(world.repo, 'a.txt'), 'uncommitted edit\n');
  fs.writeFileSync(path.join(world.repo, 'scratch.txt'), 'untracked\n');
  const before = userState(world.repo);
  assert.ok(before.stash.length > 0 && before.status.includes('a.txt') && before.status.includes('scratch.txt'));
  const { p } = await acceptWith(world, c.versionId, integrationHead(world));
  const res = await p;
  assert.equal(res.version.status, 'active');
  assert.deepEqual(userState(world.repo), before, 'HEAD, branch, index hash, stash and every working file hash are identical');
});

test('RA5: a ref that moved answers conflict ref_moved with the current head, and nothing is written', async () => {
  const world = await candidateWorld();
  const { w } = world;
  const c = await makeChange(world);
  approve(world, c.versionId);
  const stale = integrationHead(world);
  // Someone moves the integration ref by hand after the user's click was prepared.
  fs.writeFileSync(path.join(world.repo, 'x.txt'), 'x\n'); git(world.repo, ['add', 'x.txt']); git(world.repo, ['commit', '-q', '-m', 'x']);
  const elsewhere = out(world.repo, ['rev-parse', 'HEAD']);
  git(world.repo, ['update-ref', 'refs/nexus/accepted/main', elsewhere]);
  const { p, r } = await acceptWith(world, c.versionId, stale);
  assert.equal(r.refused, 'ref_moved');
  await assert.rejects(p, (e) => e.code === 'conflict' && e.detail.reason === 'ref_moved' && e.detail.current === elsewhere);
  assert.equal(integrationHead(world), elsewhere, 'the ref is as it was');
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM change_set_accepts').get().n, 0);
  assert.equal(version(w, c.versionId).status, 'candidate');
  assert.equal(findJobs(w, 'changeset.accept_rollback').length, 0, 'a refused CAS moved nothing, so nothing is rolled back');
});

test('RA6: of two concurrent accepts of the same head, exactly one wins', async () => {
  const world = await candidateWorld();
  const { w } = world;
  const c1 = await makeChange(world, { file: 'one.txt', title: 'One' });
  const c2 = await makeChange(world, { file: 'two.txt', title: 'Two' });
  approve(world, c1.versionId); approve(world, c2.versionId);
  const old = integrationHead(world);
  const p1 = w.nx.accepts.accept(w.me, c1.versionId, old); p1.catch(() => {});
  const p2 = w.nx.accepts.accept(w.me, c2.versionId, old); p2.catch(() => {});
  const [j1, j2] = findJobs(w, 'changeset.accept');
  await Promise.all([runEngine(w, world, j1.id), runEngine(w, world, j2.id)]);
  const settled = await Promise.allSettled([p1, p2]);
  assert.equal(settled.filter((s) => s.status === 'fulfilled').length, 1, 'exactly one accept won');
  const lost = settled.find((s) => s.status === 'rejected');
  assert.ok(lost.reason.code === 'conflict' && lost.reason.detail.reason === 'ref_moved');
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM change_set_accepts').get().n, 1);
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM artifact_versions WHERE status = 'active' AND artifact_id IN (SELECT id FROM artifacts WHERE kind = 'change_set')").get().n, 1);
  assert.equal(integrationHead(world), w.db.prepare('SELECT ref_after FROM change_set_accepts').get().ref_after);
  // The same version clicked twice joins the one live job.
  const c3 = await makeChange(world, { file: 'three.txt', title: 'Three' });
  approve(world, c3.versionId);
  const head3 = integrationHead(world);
  const a = w.nx.accepts.accept(w.me, c3.versionId, head3); a.catch(() => {});
  const b = w.nx.accepts.accept(w.me, c3.versionId, head3); b.catch(() => {});
  assert.equal(findJobs(w, 'changeset.accept').length, 3, 'one job for the two clicks');
  await runEngine(w, world, findJobs(w, 'changeset.accept').at(-1).id);
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.accept.versionId, rb.accept.versionId);
});

// ---------- RA7-RA9 (real git) ----------

test('RA7: merge refuses tree_dirty, branch_mismatch and not_fast_forward, and the files are unchanged', async () => {
  const world = await acceptedWorld();
  let asked = 0;
  const confirm = () => { asked++; return true; };
  // tree_dirty
  fs.writeFileSync(path.join(world.repo, 'a.txt'), 'dirty\n');
  let before = userState(world.repo);
  await assert.rejects(merge(world, confirm), (e) => e.code === 'conflict' && e.detail.reason === 'tree_dirty');
  assert.deepEqual(userState(world.repo), before);
  git(world.repo, ['checkout', '-q', '--', 'a.txt']);
  // branch_mismatch
  git(world.repo, ['checkout', '-q', '-b', 'other']);
  before = userState(world.repo);
  await assert.rejects(merge(world, confirm), (e) => e.code === 'conflict' && e.detail.reason === 'branch_mismatch');
  assert.deepEqual(userState(world.repo), before);
  git(world.repo, ['checkout', '-q', 'main']);
  // not_fast_forward: the user's branch moved on.
  fs.writeFileSync(path.join(world.repo, 'mine.txt'), 'mine\n'); git(world.repo, ['add', 'mine.txt']); git(world.repo, ['commit', '-q', '-m', 'mine']);
  before = userState(world.repo);
  await assert.rejects(merge(world, confirm), (e) => e.code === 'conflict' && e.detail.reason === 'not_fast_forward');
  assert.deepEqual(userState(world.repo), before);
  assert.equal(asked, 0, 'a refusal never reaches the dialog');
  assert.equal(findJobs(world.w, 'repo.ff').length, 0);
  assert.equal(world.w.db.prepare('SELECT COUNT(*) AS n FROM repo_merges').get().n, 0);
});

test('RA8: a dialog cancel answers cancelled, with no row and no job', async () => {
  const world = await acceptedWorld();
  let info = null;
  await assert.rejects(merge(world, (i) => { info = i; return false; }), (e) => e.code === 'conflict' && e.detail.reason === 'cancelled');
  assert.ok(info && info.to === integrationHead(world) && info.branch === 'main' && info.accepted.length === 1 && info.accepted[0].title === 'Add a feature');
  assert.ok(info.commitCount >= 2, 'the dialog lists the commits to be merged');
  await assert.rejects(merge(world, () => { throw new Error('dialog broke'); }), (e) => e.detail.reason === 'cancelled', 'a dialog that fails is a cancel');
  assert.equal(world.w.db.prepare('SELECT COUNT(*) AS n FROM repo_merges').get().n, 0);
  assert.equal(findJobs(world.w, 'repo.ff').length, 0);
  assert.equal(out(world.repo, ['rev-parse', 'HEAD']), world.initial);
});

test('RA9: merge succeeds and writes a row with sha_confirmed; the branch lands on the accepted commit', async () => {
  const world = await acceptedWorld();
  const sha = integrationHead(world);
  const { p, job } = await mergeWith(world, sha);
  const { merge: m } = await p;
  assert.equal(m.shaConfirmed, sha); assert.equal(m.after, sha); assert.equal(m.before, world.initial);
  assert.equal(m.mergedBy, 'user:local'); assert.equal(m.ffJobId, job.id);
  assert.equal(out(world.repo, ['rev-parse', 'HEAD']), sha);
  assert.equal(out(world.repo, ['symbolic-ref', '--short', 'HEAD']), 'main');
  assert.equal(fs.readFileSync(path.join(world.repo, world.version.file), 'utf8'), 'feature\n');
  const row = world.w.db.prepare('SELECT * FROM repo_merges').get();
  assert.equal(row.confirmed_via, 'dialog'); assert.equal(row.sha_confirmed, sha);
  assert.equal(jobRow(world.w, job.id).state, 'completed', 'the merge job completes (it has a durable record)');
  assert.ok(world.w.db.prepare("SELECT 1 FROM activity WHERE action = 'repo.merge' AND actor_kind = 'user'").get());
  // Nothing left to merge now.
  await assert.rejects(merge(world, () => true), (e) => e.detail.reason === 'nothing_to_merge');
  // The repo_merges table is append-only and the row's own CHECK ties after to sha_confirmed.
  assert.throws(() => world.w.db.prepare('DELETE FROM repo_merges').run(), /append-only/);
});
