'use strict';
// Shared world of the accept tests (B2b Task 9): user review decisions, accept by merge-tree and compare-and-swap with a durable marker and rollback, the
// integration-ref consistency check (O25) and the dialog-confirmed fast-forward to the confirmed sha. RA1-RA14.
//
// The database side is the real platform (agentFixtures: a real session, turn, token and the real exec core, ingest and
// recovery). The git side is REAL git in temporary repositories under the OS temp folder (never this project's own .git):
// the test plays the runner by calling the runner's own engines (src/runner/gitWrite.ts, gitRead.ts) for each system job
// the services queue and reporting what they return through the FakeRunner, exactly as the core would receive it.
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const loadTs = require('../load-ts.cjs');
const { agentWorld, openRunningTurn } = require('./agentFixtures.cjs');
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
async function makeChange(world, { file = 'feature.txt', content = 'feature\n', title = 'Add a feature', mutate = null } = {}) {
  const { w, turn, g } = world;
  fs.writeFileSync(path.join(world.wt, file), content);
  const f = await collect(g, { repoPath: world.repo, worktreePath: world.wt, gitDir: path.join(world.repo, '.git', 'worktrees', world.name),
    ref: `refs/nexus/job/${world.name}`, integrationRef: 'refs/nexus/accepted/main', scope: [], message: `${title}\n\nNexus-Job: J1\n`,
    maxFileBytes: 50 * 2 ** 20, maxTotalBytes: 8 * 2 ** 30 }, { dataRoot: world.home });
  if (mutate) mutate(f);
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
  const had = findJobs(world.w, 'repo.ff').length;
  const p = merge(world, confirm, expected); p.catch(() => {});
  for (let i = 0; i < 400 && findJobs(world.w, 'repo.ff').length === had; i++) await new Promise((r) => setTimeout(r, 10));
  const job = findJobs(world.w, 'repo.ff').length > had ? findJobs(world.w, 'repo.ff').at(-1) : null;
  const r = job ? await runEngine(world.w, world, job.id) : null;
  return { p, job, r };
}

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


module.exports = { PROJECT, WORKSPACE, tmp, git, out, refOf, userState, gitFacts, gitRefused, nextKey, ulid, jobRow, findJobs, version, latest, leaseAndRun, finish, addRepository, runEngine, jobOf, candidateWorld, makeChange, approve, integrationHead, acceptWith, acceptedWorld, merge, mergeWith, acceptSvc, rejectNow, heldAccept, conflictingPair, loadTs, agentWorld, openRunningTurn, newId, immediateTx, insertAttemptTx, transitionAttemptTx, attemptRow, ChangeSetService, GW, HardenedGit, ensureWorktree, collect, gitAccept, gitRollback, fastForward, GitFailure, gitRead, preparedOf };
