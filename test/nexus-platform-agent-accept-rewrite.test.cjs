'use strict';
// B2b Task 9, final re-review round: the user's amend, rebase or reset (a REWRITE of the branch) when nothing was accepted after the
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

test('RC1 (B6 rewrite): the user amends after the very first worktree, with nothing accepted: the next session resyncs as a REWRITE, records it, and a full accept and merge cycle works', async () => {
  const world = await candidateWorld();
  const { w } = world;
  const first = world.initial;
  const A = amend(world);
  assert.notEqual(A, first);
  assert.equal(integrationHead(world), first, 'the ref still holds the old commit');
  const s2 = await s2Run(world);
  const f = s2.r.facts;
  assert.deepEqual([f.integrationResynced, f.integrationRewrite, f.integrationBefore, f.integrationHead], [true, true, first, A]);
  assert.equal(jobRow(w, s2.s.job.id).state, 'completed');
  assert.equal(integrationHead(world), A);
  const rows = resyncRows(w);
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0].details_json), { branch: 'main', before: first, after: A, rewrite: true });
  assert.equal(baselineOf(world).head, A); assert.equal(baselineOf(world).endKind, 'resync');
  const st = await status(world);
  assert.deepEqual([st.integrationConsistent, st.integrationDiverged], [true, false]);
  // The full cycle on the rewritten branch.
  const c = await makeChange(s2.s.sub, { file: 'after-amend.txt', content: 'x\n', title: 'After the amend' });
  approve(world, c.versionId);
  const res = await (await acceptWith(world, c.versionId, A)).p;
  assert.equal(res.accept.refBefore, A);
  const N = integrationHead(world);
  const m = await (await mergeWith(world, N)).p;
  assert.equal(m.merge.before, A); assert.equal(out(world.repo, ['rev-parse', 'HEAD']), N);
  // O25 is false after a ref moved by hand.
  git(world.repo, ['update-ref', REF, first]);
  assert.equal((await status(world)).integrationConsistent, false);
});
async function s2Run(world, o = {}) { const s = await secondSession(world, o); return { s, r: await s.run() }; }

test('RC3 (B6): an amend while an accept still waits to be merged is still integration_diverged (accepted work would be lost); nothing is touched', async () => {
  const world = await acceptedWorld();
  const { w } = world;
  const S = integrationHead(world);
  assert.equal(rewriteAllowed(w.db, PROJECT, REF), false, 'the chain ends in an accept');
  amend(world);
  const s2 = await s2Run(world);
  assert.equal(s2.r.refused, 'integration_diverged');
  assert.equal(JSON.parse(jobRow(w, s2.s.job.id).params_json).allowRewrite, false);
  assert.equal(JSON.parse(jobRow(w, s2.s.job.id).error_json).message, GIT_FAILURE_TEXT.integration_diverged);
  assert.equal(integrationHead(world), S); assert.equal(resyncRows(w).length, 0);
  const st = await status(world);
  assert.deepEqual([st.integrationDiverged, st.integrationConsistent], [true, true]);
});

test('RC5 (B6): a rewrite record that follows an accept makes the chain unknown (never consistent); one that follows the initial head or a resync does not', async () => {
  const world = await acceptedWorld();
  const { w } = world;
  const S = integrationHead(world);
  const wtJob = immediateTx(w.db, () => w.nx.jobs.createTx(w.sys, { kind: 'tool.run', projectId: PROJECT, workspaceId: WORKSPACE, idempotencyKey: `forged-${ulid()}`, recipeId: 'repo.worktree',
    params: { sessionId: world.turn.session.id, branch: 'main' } })).job.id;
  const rec = (before, after, rewrite) => appendActivityRow(w.db, { actorKind: 'system', actorId: w.sys.id, jobId: wtJob, projectId: PROJECT, entityType: 'integration_ref', entityId: REF,
    action: 'repo.integration_resync', status: 'succeeded', details: { branch: 'main', before, after, ...(rewrite ? { rewrite: true } : {}) } }, w.clock.t);
  const other = out(world.repo, ['commit-tree', `${world.initial}^{tree}`, '-m', 'rewritten']);
  rec(S, other, true);                                    // forged: a rewrite after an accept
  const b = integrationBaseline(w.db, PROJECT, REF);
  assert.deepEqual([b.known, b.head], [false, null]);
  git(world.repo, ['update-ref', REF, other]);
  assert.equal((await status(world)).integrationConsistent, false);
  assert.equal(rewriteAllowed(w.db, PROJECT, REF), false);
});

test('RC6 (minor 2): the resync record is found by its entity (the ref), so a branch named like a secret still counts; the accept rows never read the branch from details', async () => {
  const w = agentWorld({ platform: { ingest: undefined } });
  const turn = openRunningTurn(w.db, w.nx);
  const branch = 'sk-learning-feature';
  const ref = `refs/nexus/accepted/${branch}`;
  const A = 'a'.repeat(40); const B = 'b'.repeat(40);
  w.db.prepare(`INSERT INTO session_worktrees (session_id, project_id, rel_path, ref, integration_ref, base_commit, locked, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)`).run(turn.session.id, PROJECT, `wt/${turn.session.id.toLowerCase()}`, `refs/nexus/job/${turn.session.id.toLowerCase()}`, ref, A, w.clock.t);
  assert.equal(integrationBaseline(w.db, PROJECT, ref).head, A);
  const wtJob = immediateTx(w.db, () => w.nx.jobs.createTx(w.sys, { kind: 'tool.run', projectId: PROJECT, workspaceId: WORKSPACE, idempotencyKey: `forged-${ulid()}`, recipeId: 'repo.worktree',
    params: { sessionId: turn.session.id } })).job.id;
  appendActivityRow(w.db, { actorKind: 'system', actorId: w.sys.id, jobId: wtJob, projectId: PROJECT, entityType: 'integration_ref', entityId: ref, action: 'repo.integration_resync',
    status: 'succeeded', details: { branch, before: A, after: B } }, w.clock.t);
  const stored = JSON.parse(w.db.prepare("SELECT details_json FROM activity WHERE action = 'repo.integration_resync'").get().details_json);
  assert.notEqual(stored.branch, branch, 'the branch name is stored redacted in the details, as it looks like a secret');
  const b = integrationBaseline(w.db, PROJECT, ref);
  assert.deepEqual([b.known, b.head, b.endKind], [true, B, 'resync']);
  // Another branch's rows are not read.
  assert.equal(integrationBaseline(w.db, PROJECT, 'refs/nexus/accepted/other').known, false);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'nexus', 'repo', 'integrationBaseline.ts'), 'utf8');
  assert.match(src, /entity_id = \?/);
  assert.doesNotMatch(src, /d\.branch/);
});
