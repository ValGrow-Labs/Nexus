'use strict';
// B2b Task 9: user review decisions, accept by merge-tree and compare-and-swap with a durable marker and rollback, the
// integration-ref consistency check (O25) and the dialog-confirmed fast-forward to the confirmed sha. RA1-RA14.
//
// The database side is the real platform (agentFixtures: a real session, turn, token and the real exec core, ingest and
// recovery). The git side is REAL git in temporary repositories under the OS temp folder (never this project's own .git):
// the test plays the runner by calling the runner's own engines (src/runner/gitWrite.ts, gitRead.ts) for each system job
// the services queue and reporting what they return through the FakeRunner, exactly as the core would receive it.
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { agentWorld, openRunningTurn } = require('./helpers/agentFixtures.cjs');
const { newId } = loadTs('src/main/nexus/db/ids.ts');
const { immediateTx } = loadTs('src/main/nexus/db/tx.ts');
const { PlatformError } = loadTs('src/main/nexus/errors.ts');
const { insertAttemptTx, transitionAttemptTx, attemptRow } = loadTs('src/main/nexus/exec/attempts.ts');
const { ChangeSetService } = loadTs('src/main/nexus/repo/changeSetService.ts');
const { ReviewService } = loadTs('src/main/nexus/review/reviewService.ts');
const GW = loadTs('src/runner/gitWrite.ts');
const { HardenedGit, ensureWorktree, collect, accept: gitAccept, rollback: gitRollback, fastForward, GitFailure } = GW;
const { gitRead } = loadTs('src/runner/gitRead.ts');
const { AGENT_ACTION_CAPABILITIES } = loadTs('src/main/nexus/auth/policy.ts');
const { MCP_TOOLS } = loadTs('src/shared/nexus/mcpTools.ts');
const { preparedOf } = loadTs('src/main/nexus/repo/acceptRollback.ts');

const PROJECT = 'p-ledger';
const WORKSPACE = 'sde';
const MADE = [];
after(() => { for (const d of MADE) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ } } });
function tmp(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); MADE.push(d); return d; }

const git = (cwd, args, o = {}) => {
  const r = cp.spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', 'core.longpaths=true', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  if (o.check !== false) assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r;
};
const out = (cwd, args) => git(cwd, args).stdout.trim();
const refOf = (repo, ref) => { const r = git(repo, ['rev-parse', '--verify', '-q', ref], { check: false }); return r.status === 0 ? r.stdout.trim() : null; };

/** The user's side of the repository: HEAD, branch, index bytes, stash, status and a hash of every file outside .git. */
function userState(repo) {
  const idx = path.join(repo, '.git', 'index');
  const files = {};
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, `${rel}${e.name}/`);
      else files[`${rel}${e.name}`] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(repo, '');
  return {
    head: out(repo, ['rev-parse', 'HEAD']), branch: out(repo, ['symbolic-ref', 'HEAD']),
    index: fs.existsSync(idx) ? crypto.createHash('sha256').update(fs.readFileSync(idx)).digest('hex') : null,
    stash: git(repo, ['stash', 'list']).stdout, status: git(repo, ['status', '--porcelain']).stdout, files
  };
}

// ---------- the world: a real repository, a real worktree, change sets that reach `candidate` ----------

const gitFacts = (o) => ({ parser: 'git-facts', sourceSha256: '0'.repeat(64), normalized: { ok: true, ...o } });
const gitRefused = (code) => ({ parser: 'git-facts', sourceSha256: '0'.repeat(64), normalized: { ok: false, code } });
let seq = 0;
const nextKey = () => `ak${Date.now()}_${++seq}`;
const ulid = () => newId(Date.now() + (++seq));
const jobRow = (w, id) => w.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
const findJobs = (w, recipe) => w.db.prepare('SELECT * FROM jobs WHERE recipe_id = ? ORDER BY rowid').all(recipe);
const version = (w, id) => w.db.prepare('SELECT * FROM artifact_versions WHERE id = ?').get(id);
const latest = (w, versionId, validatorId) => w.db.prepare('SELECT * FROM validations WHERE version_id = ? AND validator_id = ? ORDER BY rowid DESC LIMIT 1').get(versionId, validatorId);

function leaseAndRun(w, jobId) {
  return immediateTx(w.db, () => {
    const leased = w.nx.jobs.transitionTx(w.sys, jobId, 'leased', undefined, { expectState: 'queued' });
    const attemptId = newId(w.clock.t);
    insertAttemptTx(w.db, { id: attemptId, jobId, projectId: PROJECT, n: leased.attempts, bootId: w.nx.bootId, now: w.clock.t, logPath: null,
      sandbox: { kind: 'tool' }, environment: {} });
    transitionAttemptTx(w.db, attemptRow(w.db, attemptId), 'running', w.clock.t, PROJECT);
    w.nx.jobs.transitionTx(w.sys, jobId, 'running', undefined, { expectState: 'leased' });
    return attemptId;
  });
}
function finish(turn, attemptId, { code = 0, parsed = [], outputs = [] } = {}) {
  turn.runner.report({ op: 'attempt.exited', attemptId, exit: { code, oomKilled: false, finishedAt: Date.now() }, outputs, parsed, logBytes: 0 });
}

function addRepository(w, { branch, commit }) {
  const pw = w.nx.workspaces.primaryOf(w.me, PROJECT);
  const art = newId(w.clock.t);
  w.db.prepare(`INSERT INTO artifacts (id, project_id, kind, name, description, owner_scope, owner_participation_id, owner_workspace_id,
      created_by, status, current_version_id, metadata_json, created_at, updated_at)
    VALUES (?, ?, 'repository', 'ledger-api', NULL, 'participation', ?, ?, 'user:local', 'active', NULL, '{}', ?, ?)`)
    .run(art, PROJECT, pw.id, pw.workspaceId, w.clock.t, w.clock.t);
  const v = w.nx.artifacts.registerVersion(w.me, { artifactId: art, storage: { kind: 'git', commit },
    metadata: { profile: 'sde-node', branch, lockfile: { sha256: 'a'.repeat(64) } } }).version.id;
  w.nx.artifacts.finalize(w.sys, v, 'candidate');
  w.db.transaction(() => {
    w.db.prepare("UPDATE artifact_versions SET status = 'active' WHERE id = ?").run(v);
    w.db.prepare('UPDATE artifacts SET current_version_id = ? WHERE id = ?').run(v, art);
  })();
  return v;
}

/** Plays the runner's side of one git job: runs the real engine, reports what it returns (or its refusal). */
async function runEngine(w, world, jobId, o = {}) {
  const job = jobRow(w, jobId);
  const params = JSON.parse(job.params_json);
  const attemptId = leaseAndRun(w, jobId);
  const integrationRef = `refs/nexus/accepted/${params.branch}`;
  let n = 0;
  const done = (code, parsed) => finish(world.turn, attemptId, { code, parsed });
  try {
    let facts;
    if (job.recipe_id === 'changeset.accept') {
      facts = await gitAccept(world.g, { repoPath: world.repo, integrationRef, expectedOld: params.expectedOld, head: params.head,
        message: `${params.title}\n\nNexus-Accepted-By: user:local\n` }, { onPrepared: (p) => {
        world.turn.runner.report({ op: 'attempt.event', attemptId, seq: ++n, event: { t: 'accept.prepared', old: p.old, new: p.new, at: Date.now() } });
      } });
    } else if (job.recipe_id === 'changeset.accept_rollback') {
      facts = await gitRollback(world.g, { repoPath: world.repo, integrationRef, from: params.from, to: params.to });
    } else if (job.recipe_id === 'repo.ff') {
      facts = await fastForward(world.g, { repoPath: world.repo, branch: params.branch, sha: params.sha });
    } else throw new Error(`no engine for ${job.recipe_id}`);
    if (o.hold) return { attemptId, finish: () => done(0, [gitFacts(facts)]), facts };
    done(0, [gitFacts(facts)]);
    return { attemptId, facts };
  } catch (e) {
    if (!(e instanceof GitFailure)) throw e;
    done(1, [gitRefused(e.code)]);
    return { attemptId, refused: e.code };
  }
}

/** Waits until a job of the recipe exists (a service call runs its first transaction synchronously, so it is there at once). */
function jobOf(w, recipe, nth = -1) {
  const all = findJobs(w, recipe);
  return all.at(nth);
}

async function candidateWorld(o = {}) {
  const turns = []; const w0 = {};
  const fakeTurns = { continueWith(user, sessionId, reviewId) { turns.push({ user, sessionId, reviewId }); return { job: { id: `J${turns.length}` } }; } };
  // Task 10 wired the real AgentService as the default; RA10b keeps its intent with a TurnStarter that refuses, as agents being off does.
  const refusingTurns = { continueWith() { throw new PlatformError('unavailable', 'agents are not available yet', { reason: 'agents_unavailable' }); } };
  const w = agentWorld({ platform: { ingest: undefined, acceptFsRoot: (r) => (typeof r === 'string' && r ? r : null), turns: o.stubTurns ? refusingTurns : fakeTurns } });
  const dir = tmp('nx-ra-');
  const repo = path.join(dir, 'repo'); const home = path.join(dir, 'nexus');
  fs.mkdirSync(repo); fs.mkdirSync(path.join(home, 'wt'), { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); fs.writeFileSync(path.join(repo, 'keep.txt'), 'keep\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-q', '-m', 'init']);
  const turn = openRunningTurn(w.db, w.nx, { repoPath: repo });
  const g = new HardenedGit({ cwd: home });
  const world = { w, dir, repo, home, g, turn, turns, fakeTurns, versions: [] };
  // The runner answers `git.read` with the real read, as the real runner does.
  const orig = turn.runner.send.bind(turn.runner);
  turn.runner.send = (msg) => {
    orig(msg);
    if (msg.op === 'git.read') {
      setImmediate(async () => {
        const result = await gitRead(g, msg.task);
        turn.runner.report({ op: 'git.read.result', reqId: msg.reqId, result });
      });
    }
  };
  world.initial = out(repo, ['rev-parse', 'HEAD']);
  addRepository(w, { branch: 'main', commit: world.initial });
  // The session worktree (real) and its row (what the worktree job's ingest writes).
  const sid = turn.session.id; const name = sid.toLowerCase();
  world.name = name; world.wt = path.join(home, 'wt', name);
  const f = await ensureWorktree(g, { repoPath: repo, worktreePath: world.wt, ref: `refs/nexus/job/${name}`, integrationRef: 'refs/nexus/accepted/main', branch: 'main' }, { dataRoot: home });
  if (!o.noWorktreeRow) {
    w.db.prepare(`INSERT INTO session_worktrees (session_id, project_id, rel_path, ref, integration_ref, base_commit, locked, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)`).run(sid, PROJECT, `wt/${name}`, f.ref, 'refs/nexus/accepted/main', f.base, w.clock.t);
  }
  world.service = new ChangeSetService(w.db, { jobs: w.nx.jobs, system: w.sys, now: () => w.clock.t, waitMs: 60_000 });
  void w0;
  return world;
}

/** The agent edits a file in its worktree; Nexus collects it (real) and the change set reaches `candidate`. */
async function makeChange(world, { file = 'feature.txt', content = 'feature\n', title = 'Add a feature' } = {}) {
  const { w, turn, g } = world;
  fs.writeFileSync(path.join(world.wt, file), content);
  const f = await collect(g, { repoPath: world.repo, worktreePath: world.wt, gitDir: path.join(world.repo, '.git', 'worktrees', world.name),
    ref: `refs/nexus/job/${world.name}`, integrationRef: 'refs/nexus/accepted/main', scope: [], message: `${title}\n\nNexus-Job: J1\n`,
    maxFileBytes: 50 * 2 ** 20, maxTotalBytes: 8 * 2 ** 30 }, { dataRoot: world.home });
  const p = world.service.register(turn.claims, { clientKey: nextKey(), title, summary: 'does a thing' });
  const collectJob = findJobs(w, 'changeset.collect').at(-1);
  finish(turn, leaseAndRun(w, collectJob.id), { parsed: [gitFacts(f)] });
  const answer = await p;
  // cs.tests_pass: discover then one passing test.
  const discover = w.db.prepare("SELECT id FROM jobs WHERE recipe_id = 'sde.test.discover' AND json_extract(params_json, '$.versionId') = ? ORDER BY rowid DESC").get(answer.versionId);
  const idsSha = crypto.createHash('sha256').update(`ids${answer.versionId}`).digest('hex');
  finish(turn, leaseAndRun(w, discover.id), { outputs: [{ relPath: 'ids.txt', sha256: idsSha, bytes: 10, mediaType: 'text/plain' }],
    parsed: [{ parser: 'discovery', sourceSha256: idsSha, normalized: { framework: 'node-test', ids: ['a.test.js'], files: ['a.test.js'] } }] });
  const run = w.db.prepare("SELECT id FROM jobs WHERE parent_job_id = ? AND recipe_id = 'sde.test.node'").get(discover.id);
  const junitSha = crypto.createHash('sha256').update(`junit${answer.versionId}`).digest('hex');
  finish(turn, leaseAndRun(w, run.id), { outputs: [{ relPath: 'junit.xml', sha256: junitSha, bytes: 50, mediaType: 'application/xml' }],
    parsed: [{ parser: 'junit', sourceSha256: junitSha, normalized: { sha256: junitSha, total: 1, passed: 1, failed: 0, errored: 0, skipped: 0, declaredTotal: 1,
      countsMismatch: false, cases: [{ id: 'a.test.js', file: 'a.test.js', classname: 'a', name: 't1', outcome: 'passed', ms: 1 }] } }] });
  const check = w.db.prepare("SELECT id FROM jobs WHERE recipe_id = 'changeset.merge_check' AND json_extract(params_json, '$.versionId') = ? ORDER BY rowid DESC").get(answer.versionId);
  finish(turn, leaseAndRun(w, check.id), { parsed: [gitFacts({ clean: true, tree: 'c'.repeat(40), integrationHead: world.initial })] });
  assert.equal(version(w, answer.versionId).status, 'candidate', 'the change set reached candidate');
  const rec = { versionId: answer.versionId, head: f.head, file };
  world.versions.push(rec);
  return rec;
}

const approve = (world, versionId) => world.w.nx.reviews.decide(world.w.me, versionId, { decision: 'approve', intentId: ulid() });
const integrationHead = (world) => refOf(world.repo, 'refs/nexus/accepted/main');

/** accept() with the engine played right after its job is queued. */
async function acceptWith(world, versionId, expected, o = {}) {
  const p = world.w.nx.accepts.accept(world.w.me, versionId, expected);
  p.catch(() => {});
  const job = jobOf(world.w, 'changeset.accept');
  const r = await runEngine(world.w, world, job.id, o);
  return { p, job, r };
}

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

async function acceptedWorld() {
  const world = await candidateWorld();
  const c = await makeChange(world);
  approve(world, c.versionId);
  const { p } = await acceptWith(world, c.versionId, integrationHead(world));
  const res = await p;
  world.accepted = res.accept; world.version = c;
  return world;
}
const merge = (world, confirm, expected) => world.w.nx.accepts.mergeAccepted(world.w.me, PROJECT, { branch: 'main', expectedAcceptedHead: expected ?? integrationHead(world) }, confirm);
/** mergeAccepted with the ff engine played once its job exists. */
async function mergeWith(world, expected, confirm = () => true) {
  const p = merge(world, confirm, expected); p.catch(() => {});
  for (let i = 0; i < 400 && findJobs(world.w, 'repo.ff').length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  const job = findJobs(world.w, 'repo.ff').at(-1);
  const r = job ? await runEngine(world.w, world, job.id) : null;
  return { p, job, r };
}

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
  assert.equal(st.userTreeClean, true); assert.equal(st.branch, 'main'); assert.ok(st.acceptedNotMerged >= 2); assert.equal(st.fastForward, true);
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


/**
 * A recorded accept of `a.txt = one`, then a second change that edits the same file from the ORIGINAL base (the session ref and
 * worktree are reset to it), so merging it onto the accepted branch conflicts. Returns the second change and the recorded head.
 */
async function conflictingPair(world) {
  const first = await makeChange(world, { file: 'a.txt', content: 'one\n', title: 'One' });
  approve(world, first.versionId);
  const { p } = await acceptWith(world, first.versionId, integrationHead(world));
  await p;
  const ref = `refs/nexus/job/${world.name}`;
  git(world.repo, ['update-ref', ref, world.initial]);
  git(world.wt, ['reset', '-q', '--hard', world.initial]);
  const second = await makeChange(world, { file: 'a.txt', content: 'two\n', title: 'Two' });
  approve(world, second.versionId);
  return { second, recorded: integrationHead(world) };
}

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

// ---------- fix round 1 ----------

function acceptSvc(w, log) {
  return new (loadTs('src/main/nexus/repo/acceptService.ts').AcceptService)(w.db, { auth: w.nx.auth, principals: w.nx.principals, artifacts: w.nx.artifacts,
    jobs: w.nx.jobs, validation: w.nx.validation, gitRead: w.nx.gitRead, system: w.sys, now: () => w.clock.t, acceptFsRoot: (r) => r, log });
}
const rejectNow = (world, versionId) => world.w.nx.reviews.decide(world.w.me, versionId, { decision: 'reject', comment: 'changed my mind', intentId: ulid() });

/** Starts an accept, runs the real engine and holds its exit: the ref has moved, the ingest has not run. */
async function heldAccept(world, svc, versionId, expected) {
  const p = svc.accept(world.w.me, versionId, expected); p.catch(() => {});
  const job = jobOf(world.w, 'changeset.accept');
  const held = await runEngine(world.w, world, job.id, { hold: true });
  return { p, job, held, moved: integrationHead(world) };
}

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
