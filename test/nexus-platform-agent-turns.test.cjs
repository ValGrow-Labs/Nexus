'use strict';
// B2b Task 10: agent turns in main. AgentService (start, continueWith, end, cancel, list, get), the scheduler's runtime,
// consent, budget and rate guards, the lease transaction that mints the token and builds the AgentPlan, the redacted
// sandbox_json / environment_json, monotonic usage caps, no-change turns, token revocation on every end path and restart
// recovery. AT1-AT6, AT10-AT13, AT15, AT16, AT18, plus the carried requirements of the earlier reviews.
//
// The database side is the REAL platform (agentWorld: a v10 database, the real execution core, tokens, budgets, sessions,
// worktrees and the agent service). The runner is a FakeRunner: the test reports what the real runner would (provisioned,
// runtime events, exited) and reads the plan main sent. No Docker, no process, no real userData.
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const loadTs = require('./load-ts.cjs');
const { agentWorld } = require('./helpers/agentFixtures.cjs');
const { FakeRunner } = require('./helpers/fakeRunner.cjs');
const { PROFILES, passingPreflight, GIB } = require('./helpers/execWorld.cjs');
const { newId } = loadTs('src/main/nexus/db/ids.ts');
const { createNexusPlatform } = loadTs('src/main/nexus/platform.ts');
const { resolveDataHome } = loadTs('src/main/nexusExec/dataHome.ts');
const { hostsSha256 } = loadTs('src/main/nexus/agents/budgetService.ts');
const { MCP_TOOLS } = loadTs('src/shared/nexus/mcpTools.ts');
const { buildPlan, buildAgentPlan } = loadTs('src/main/nexus/exec/planBuilder.ts');
const { getRecipe } = loadTs('src/shared/nexus/recipes.ts');
const { RunnerCore } = loadTs('src/runner/core.ts');
const { homeLabel } = loadTs('src/shared/nexus/homeLabel.ts');
const { FakeSandboxDriver } = require('./helpers/fakeSandboxDriver.cjs');
const { MessageChannel } = require('node:worker_threads');
const fsp = require('node:fs/promises');
const { stepStateFrom } = loadTs('src/shared/nexus/stepState.ts');
const { getDomain } = loadTs('src/shared/nexus/domains/index.ts');

const PROJECT = 'p-ledger';
const WORKSPACE = 'sde';
const HOSTS = [{ host: 'api.anthropic.com', port: 443 }];
const HEALTH_OK = { kind: 'scripted', health: { ok: true, version: '1.0.0' }, flagsSha256: 'f'.repeat(64), egressHosts: HOSTS };
const MCP_URL = 'http://127.0.0.1:43111/mcp';
const IMAGE = 'sha256:' + '1'.repeat(64);
const MESSAGE = 'Please add the pagination helper to the ledger report, zebra-quartz-77';
let seq = 0;
const ulid = () => newId(Date.now() + (++seq));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits (real time, short) until `pred()` holds: the lease's preparation (files, worktree) is asynchronous. */
async function until(pred, what, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    if (pred()) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

function addRepository(w, { branch = 'main', commit = 'c0ffee'.padEnd(40, '0') } = {}) {
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

const probeMsg = (o = {}) => ({ op: 'probe.result',
  probe: { docker: o.docker ?? 'running', version: '27.0.0', cpus: 4, memoryBytes: 8 * GIB, gpu: { detected: false, usableInContainers: false } },
  images: o.images ?? [{ profile: 'sde-node', present: true, digestMatches: true, imageId: IMAGE }, { profile: 'sde-python', present: true, digestMatches: true, imageId: 'sha256:' + '2'.repeat(64) }],
  freeBytes: 100 * GIB, runtimes: [] });

/** A booted platform with the agent services, a granted consent, a repository, an attached runner and Docker answering. */
async function turnWorld(o = {}) {
  const health = { current: o.health === undefined ? HEALTH_OK : o.health };
  const home = h.tmpDir('nx-at-home-');
  const repoDir = h.tmpDir('nx-at-repo-');
  const dataHome = resolveDataHome(home);
  await dataHome.ensure();
  const w = agentWorld({ platform: { dataHome, runtimeHealth: () => health.current, appVersion: 'test-1', ...(o.platform ?? {}) } });
  w.db.prepare('UPDATE projects SET root_path = ? WHERE id = ?').run(repoDir, PROJECT);
  w.health = health; w.dataHome = dataHome; w.home = home; w.repoDir = repoDir;
  w.repoVersion = addRepository(w);
  if (!o.noConsent) w.consent = w.nx.budget.grant(w.me, { runtimeKind: 'scripted', hosts: HOSTS, caps: o.caps });
  const runner = new FakeRunner();
  w.runner = runner;
  w.nx.exec.attachRunner(runner, w.nx.bootId);
  if (!o.noReady) runner.report({ op: 'ready', bootId: w.nx.bootId, mcpUrl: MCP_URL });
  runner.report(probeMsg(o.probe));
  const evSeq = new Map();
  Object.assign(w, {
    tick(ms = 0) { if (ms) w.clock.t += ms; w.nx.exec.tick(w.clock.t); },
    job: (id) => w.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id),
    attempts: (jobId) => w.db.prepare('SELECT * FROM job_attempts WHERE job_id = ? ORDER BY n').all(jobId),
    attemptOf: (id) => w.db.prepare('SELECT * FROM job_attempts WHERE id = ?').get(id),
    session: (id) => w.db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(id),
    /** The worktree folder and row a finished `repo.worktree` job would leave for the session. */
    seedWorktree(sessionId, files = { 'a.txt': 'a\n' }) {
      const name = sessionId.toLowerCase();
      const dir = path.join(dataHome.root, 'wt', name);
      fs.mkdirSync(dir, { recursive: true });
      for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c);
      w.db.prepare(`INSERT INTO session_worktrees (session_id, project_id, rel_path, ref, integration_ref, base_commit, locked, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?)`).run(sessionId, PROJECT, `wt/${name}`, `refs/nexus/job/${name}`, 'refs/nexus/accepted/main', 'b'.repeat(40), w.clock.t);
      return dir;
    },
    /** `AgentService.start` as the user, with the session's worktree seeded (A3 and the worktree job are Task 7's). */
    start(x = {}) {
      const r = w.nx.agents.start(w.me, { projectId: PROJECT, workspaceId: WORKSPACE, sessionId: x.sessionId ?? null, focusVersionIds: x.focus ?? [],
        message: x.message ?? MESSAGE, intentId: x.intentId ?? ulid(), ...(x.skillId ? { skillId: x.skillId } : {}) });
      if (x.seed !== false && !w.db.prepare('SELECT 1 FROM session_worktrees WHERE session_id = ?').get(r.session.id)) w.seedWorktree(r.session.id);
      return r;
    },
    /** Ticks until the turn's job is leased; returns the attempt and the plan the runner was sent. */
    async lease(jobId) {
      for (let i = 0; i < 400 && w.job(jobId).state === 'queued'; i++) { w.tick(); await sleep(5); }
      assert.equal(w.job(jobId).state, 'leased', `the turn is leased (phase ${w.job(jobId).phase}; ${w.logs.filter((l) => /exec|agents/.test(l)).slice(-6).join(' | ')})`);
      const attempt = w.attempts(jobId).at(-1);
      const start = w.runner.sentOf('attempt.start').filter((m) => m.attemptId === attempt.id).at(-1);
      assert.ok(start, 'attempt.start was sent');
      return { attempt, plan: start.plan };
    },
    provision(attemptId, plan, extra = {}) {
      w.runner.report({ op: 'attempt.provisioned', attemptId, containerId: (extra.c ?? 'c').repeat(64), imageDigest: IMAGE, preflight: passingPreflight() });
      return plan;
    },
    ev(attemptId, event) {
      const n = (evSeq.get(attemptId) ?? 1_000_000) + 1; evSeq.set(attemptId, n);
      w.runner.report({ op: 'attempt.runtime', attemptId, seq: n, event });
    },
    usage(attemptId, u = {}) {
      w.ev(attemptId, { t: 'usage', inputTokens: 10, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0, costUsdCents: 1, toolCalls: 1, estimated: false, ...u });
    },
    exit(attemptId, code = 0, extra = {}) {
      w.runner.report({ op: 'attempt.exited', attemptId, exit: { code, oomKilled: false, finishedAt: w.clock.t }, outputs: [], parsed: [], logBytes: 0, ...extra });
    },
    /** A running turn: started, leased, provisioned. */
    async running(x = {}) {
      const r = w.start(x);
      const { attempt, plan } = await w.lease(r.job.id);
      w.provision(attempt.id, plan);
      w.ev(attempt.id, { t: 'run.started', runRef: 'run-1', at: w.clock.t });
      return { ...r, attempt, plan };
    },
    /** Let `ms` pass at the scheduler's cadence (a tick every 5 s); the runner heartbeats every 30 s. */
    run(ms, step = 5_000) {
      for (let t = step; t <= ms; t += step) {
        w.clock.t += step;
        if (t % 30_000 === 0) {
          for (const a of w.db.prepare("SELECT id FROM job_attempts WHERE state IN ('starting','running')").all()) {
            w.runner.report({ op: 'attempt.heartbeat', attemptId: a.id, at: w.clock.t, logBytes: 0, outBytes: 0, container: 'running' });
          }
        }
        w.nx.exec.tick(w.clock.t);
      }
    },
    /** An app restart: a new platform over the same database (startup recovery runs), a new runner, the same data home. */
    reboot() {
      const bootId = newId(w.clock.t + 7);
      const nx = createNexusPlatform(w.db, { now: () => w.clock.t, log: (l) => w.logs.push(l), execution: true, agents: true, dataHome: w.dataHome, profiles: PROFILES,
        acceptFsRoot: (r) => (typeof r === 'string' && r ? r : null), approvals: null, ingest: null, runtimeHealth: () => w.health.current, appVersion: 'test-1',
        bootId, ...(o.platform ?? {}) });
      const report = nx.startup();
      w.nx = nx; w.bootId = bootId;
      const r2 = new FakeRunner(); w.runner = r2;
      nx.exec.attachRunner(r2, bootId);
      r2.report({ op: 'ready', bootId, mcpUrl: MCP_URL });
      r2.report(probeMsg(o.probe));
      return report;
    },
    /** A version registered by the turn (produced by a child job of it), as a change-set collect would leave one. */
    registerVersion(turnJobId, sessionId, name = 'change', o = {}) {
      const created = w.db.transaction(() => w.nx.jobs.createTx(w.sys, { kind: 'tool.run', projectId: PROJECT, workspaceId: WORKSPACE, sessionId, parentJobId: turnJobId,
        idempotencyKey: `child-${ulid()}`, recipeId: o.recipe ?? 'changeset.collect', params: {} })).immediate();
      const a = w.nx.artifacts.create(w.me, { projectId: PROJECT, workspaceId: WORKSPACE, kind: o.kind ?? 'change_set', name });
      const v = w.nx.artifacts.registerVersion(w.me, { artifactId: a.id, storage: { kind: 'git', commit: 'd'.repeat(40) }, metadata: {}, producedByJobId: created.job.id });
      // The register-stage blocking checks ingest records at once (a change set only counts as work when they did not fail).
      const results = o.validators ?? ((o.kind ?? 'change_set') === 'change_set' ? [['git.diff_nonempty', 'passed'], ['git.paths_in_scope', 'passed'], ['sec.secret_scan', 'passed']] : []);
      for (const [validatorId, status] of results) {
        w.db.prepare(`INSERT INTO validations (id, version_id, validator_id, validator_version, stage, status, blocking, advisory, summary, evidence_json, created_by, started_at, finished_at)
          VALUES (?, ?, ?, '1', 'register', ?, 1, 0, 'check', '[]', ?, ?, ?)`).run(ulid(), v.version.id, validatorId, status, w.sys.id, w.clock.t, w.clock.t);
      }
      return { versionId: v.version.id, childJobId: created.job.id };
    }
  });
  return w;
}

const tokenOf = (plan) => plan.runtime.token;
const claimsOf = (w, plan) => { const v = w.nx.tokens.verify(tokenOf(plan)); return v.ok ? v.claims : null; };
const tokenCode = (w, plan) => { const v = w.nx.tokens.verify(tokenOf(plan)); return v.ok ? 'ok' : v.code; };

// ---------- AT1: a full turn, with the plan main builds (F23) ----------

test('AT1 a full turn: start, lease with the token and the plan, provisioned, usage, a registered version, completed', async () => {
  const w = await turnWorld();
  const { session, job } = w.start();
  assert.equal(job.kind, 'agent.run'); assert.equal(job.priority, 1); assert.equal(job.requestedBy, 'user:local');
  assert.equal(job.params.message, MESSAGE);
  assert.equal(session.status, 'open');
  const { attempt, plan } = await w.lease(job.id);
  // The plan (F23): the turn's container sleeps, binds the worktree read-write at /workspace, has no network.
  assert.equal(plan.kind, 'agent');
  assert.deepEqual(plan.container.argv.slice(0, 1), ['sleep']);
  assert.ok(Number(plan.container.argv[1]) >= 1800, 'sleeps for the wall clock and a margin');
  assert.equal(plan.container.network.mode, 'none');
  assert.equal(plan.container.labels['nexus.kind'], 'agent');
  assert.equal(plan.container.mounts.length, 1);
  assert.deepEqual({ kind: plan.container.mounts[0].kind, containerPath: plan.container.mounts[0].containerPath, readOnly: plan.container.mounts[0].readOnly },
    { kind: 'worktree', containerPath: '/workspace', readOnly: false });
  assert.equal(plan.worktree.hostPath, plan.container.mounts[0].hostPath);
  assert.ok(plan.worktree.hostPath.endsWith(session.id.toLowerCase()), 'the worktree is the session folder');
  assert.equal(plan.caps.dayRemainingUsdCents, 1000); assert.equal(plan.caps.turnUsdCents, 200); assert.equal(plan.caps.turnTokens, 400000);
  assert.equal(plan.caps.toolCalls, 200);
  assert.equal(plan.runtime.kind, 'scripted'); assert.equal(plan.runtime.request.mcp.url, MCP_URL);
  assert.deepEqual(plan.runtime.request.credential, { ref: 'runtime-owned' });
  assert.equal(plan.runtime.request.message, MESSAGE);
  assert.equal(plan.runtime.request.configDir, path.join(w.dataHome.root, 'jobs', job.id, 'agent'));
  // The context file is written by main, its hash recorded.
  const ctxFile = path.join(w.dataHome.root, 'jobs', job.id, 'agent', 'context.md');
  assert.ok(fs.existsSync(ctxFile));
  assert.equal(w.job(job.id).context_hash, crypto.createHash('sha256').update(fs.readFileSync(ctxFile)).digest('hex'));
  assert.equal(plan.runtime.request.context.hash, w.job(job.id).context_hash);
  // The token is minted in the lease transaction, claims as tools (carry-forward 2), and it works.
  const claims = claimsOf(w, plan);
  assert.ok(claims, 'the plan carries a live token');
  assert.equal(claims.jobId, job.id); assert.equal(claims.sessionId, session.id); assert.equal(claims.onBehalfOf, 'user:local');
  assert.deepEqual(plan.mcpTools, claims.mcpTools, 'the runtime allow-list is exactly the token\'s tools');
  assert.ok(plan.mcpTools.length > 0 && plan.mcpTools.every((t) => MCP_TOOLS.some((d) => d.name === t)));
  assert.ok(claims.inputs.includes(w.repoVersion), 'the repository version is one of the turn\'s inputs');
  // The consent (carry-forward 1): the live row's own hash, never derived from the allow-list.
  assert.deepEqual(plan.egress.allow, HOSTS);
  assert.equal(plan.egress.consentHostsSha256, w.consent.hostsSha256);
  assert.equal(plan.egress.consentHostsSha256, hostsSha256(HOSTS));
  // The attempt row: the redacted records, the runtime kind.
  assert.equal(attempt.state, 'starting'); assert.equal(attempt.runtime_kind, 'scripted');
  assert.equal(w.job(job.id).phase, 'provisioning');
  w.provision(attempt.id, plan);
  assert.equal(w.attemptOf(attempt.id).state, 'running'); assert.equal(w.job(job.id).state, 'running');
  assert.equal(w.session(session.id).status, 'running', 'the session runs once its first turn does');
  w.ev(attempt.id, { t: 'run.started', runRef: 'run-1', at: w.clock.t });
  assert.equal(w.attemptOf(attempt.id).runtime_ref, 'run-1');
  w.ev(attempt.id, { t: 'message.delta', text: 'Reading the context.' });
  w.ev(attempt.id, { t: 'tool.started', callId: 'c1', tool: 'sandbox_exec', argsSummary: 'npm test' });
  w.usage(attempt.id, { inputTokens: 100, outputTokens: 50, costUsdCents: 3, toolCalls: 2 });
  const v = w.registerVersion(job.id, session.id);
  w.ev(attempt.id, { t: 'run.completed', at: w.clock.t, stopReason: 'end_turn' });
  assert.equal(w.job(job.id).state, 'running', 'the exit, not the event, ends the turn');
  w.exit(attempt.id, 0);
  const done = w.job(job.id);
  assert.equal(done.state, 'completed'); assert.equal(done.outcome, 'completed');
  assert.equal(w.attemptOf(attempt.id).state, 'succeeded');
  assert.equal(JSON.parse(w.attemptOf(attempt.id).usage_json).costUsdCents, 3);
  assert.equal(w.session(session.id).status, 'running', 'the conversation stays open for the next message');
  assert.equal(tokenCode(w, plan), 'revoked', 'the token died with the turn');
  assert.ok(w.runner.sentOf('attempt.release').some((m) => m.attemptId === attempt.id), 'the runner is told to release');
  assert.ok(v.versionId);
});

// ---------- AT2: one turn per session ----------

test('AT2 a second message while a turn runs answers conflict; another conversation may queue its own turn', async () => {
  const w = await turnWorld();
  const first = await w.running();
  assert.throws(() => w.nx.agents.start(w.me, { projectId: PROJECT, workspaceId: WORKSPACE, sessionId: first.session.id, focusVersionIds: [], message: 'one more thing', intentId: ulid() }),
    (e) => e.code === 'conflict' && e.detail.reason === 'turn_running');
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'agent.run'").get().n, 1, 'nothing was created');
  // Queued counts too: a turn that waits is still the session's turn.
  const w2 = await turnWorld({ noReady: true });
  const q = w2.start();
  assert.throws(() => w2.nx.agents.start(w2.me, { projectId: PROJECT, workspaceId: WORKSPACE, sessionId: q.session.id, focusVersionIds: [], message: 'again', intentId: ulid() }),
    (e) => e.code === 'conflict' && e.detail.reason === 'turn_running');
  // After the turn ends the same conversation takes the next message.
  w.ev(first.attempt.id, { t: 'run.completed', at: w.clock.t, stopReason: 'end_turn' });
  w.exit(first.attempt.id, 0);
  const next = w.nx.agents.start(w.me, { projectId: PROJECT, workspaceId: WORKSPACE, sessionId: first.session.id, focusVersionIds: [], message: 'the next message', intentId: ulid() });
  assert.equal(next.session.id, first.session.id); assert.notEqual(next.job.id, first.job.id);
});

// ---------- AT3: cancel in provisioning, running, awaiting approval ----------

test('AT3 cancel while provisioning: attempt and job cancelled, token revoked, the runner told, a late container released', async () => {
  const w = await turnWorld();
  const { session, job } = w.start();
  const { attempt, plan } = await w.lease(job.id);
  assert.equal(tokenCode(w, plan), 'ok');
  const cancelled = w.nx.agents.cancel(w.me, session.id);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(w.attemptOf(attempt.id).state, 'cancelled');
  assert.equal(tokenCode(w, plan), 'revoked');
  const sent = w.runner.sentOf('attempt.cancel').filter((m) => m.attemptId === attempt.id);
  assert.equal(sent.length, 1); assert.equal(sent[0].reason, 'user');
  // The container the runner made meanwhile is released, not run.
  w.provision(attempt.id, plan);
  assert.equal(w.attemptOf(attempt.id).state, 'cancelled');
  assert.ok(w.runner.sentOf('attempt.release').some((m) => m.attemptId === attempt.id));
  assert.equal(w.session(session.id).status, 'open', 'the conversation is not ended by a cancelled turn');
});

test('AT3 cancel while running: drafts of the turn become cancelled_partial, its children are cancelled, the token is revoked', async () => {
  const w = await turnWorld();
  const r = await w.running();
  const v = w.registerVersion(r.job.id, r.session.id);
  assert.equal(w.db.prepare('SELECT status, draft_flag FROM artifact_versions WHERE id = ?').get(v.versionId).status, 'draft');
  w.nx.agents.cancel(w.me, r.session.id);
  assert.equal(w.job(r.job.id).state, 'cancelled'); assert.equal(w.attemptOf(r.attempt.id).state, 'cancelled');
  assert.equal(w.job(v.childJobId).state, 'cancelled', 'the child job was cancelled first');
  assert.equal(w.db.prepare('SELECT draft_flag FROM artifact_versions WHERE id = ?').get(v.versionId).draft_flag, 'cancelled_partial');
  assert.equal(tokenCode(w, r.plan), 'revoked');
  assert.ok(w.runner.sentOf('attempt.cancel').some((m) => m.attemptId === r.attempt.id));
  // The runner's own exit afterwards changes nothing and is released.
  w.exit(r.attempt.id, null, { reason: 'cancelled' });
  assert.equal(w.job(r.job.id).state, 'cancelled');
});

test('AT3 cancel while awaiting approval: the repository-write approval (A3) of a waiting turn, and a child awaiting its network approval (A1)', async () => {
  const w = await turnWorld({ platform: { approvals: undefined } });
  // A3: no worktree and no approved repository write yet: the turn waits for the user's approval, nothing was written.
  const r = w.start({ seed: false });
  for (let i = 0; i < 100 && w.job(r.job.id).phase !== 'waiting:approval'; i++) { w.tick(); await sleep(5); }
  assert.equal(w.job(r.job.id).phase, 'waiting:approval'); assert.equal(w.job(r.job.id).state, 'queued');
  const pending = w.db.prepare("SELECT id, status FROM approvals WHERE reason = 'repo.write_refs'").all();
  assert.equal(pending.length, 1); assert.equal(pending[0].status, 'pending');
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM session_worktrees').get().n, 0, 'nothing exists before the user answers');
  w.nx.agents.cancel(w.me, r.session.id);
  assert.equal(w.job(r.job.id).state, 'cancelled');
  // A1: a running turn's child install waits for the user's network approval; cancelling the turn withdraws it.
  const run = await w.running();
  const reply = await w.nx.mcpGateway.call({ op: 'mcp.call', callId: 'cc1', bearer: run.plan.runtime.token, tool: 'job_request', args: { recipeId: 'sde.deps.node', inputs: [w.repoVersion] } });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  const childId = reply.value.jobId;
  for (let i = 0; i < 100 && w.job(childId).state !== 'awaiting_approval'; i++) { w.tick(); await sleep(5); }
  assert.equal(w.job(childId).state, 'awaiting_approval');
  const approval = w.db.prepare("SELECT id, status FROM approvals WHERE job_id = ?").get(childId);
  assert.equal(approval.status, 'pending');
  w.nx.agents.cancel(w.me, run.session.id);
  assert.equal(w.job(childId).state, 'cancelled');
  assert.equal(w.db.prepare('SELECT status FROM approvals WHERE id = ?').get(approval.id).status, 'withdrawn');
  assert.equal(w.job(run.job.id).state, 'cancelled'); assert.equal(tokenCode(w, run.plan), 'revoked');
});

// ---------- AT4: the wall clock ----------

test('AT4 the wall clock ends a turn timed_out, with the same cleanup', async () => {
  const w = await turnWorld();
  const r = await w.running();
  const v = w.registerVersion(r.job.id, r.session.id);
  w.run(29 * 60_000);
  assert.equal(w.job(r.job.id).state, 'running');
  w.run(2 * 60_000);
  assert.equal(w.job(r.job.id).state, 'timed_out'); assert.equal(w.attemptOf(r.attempt.id).state, 'timed_out');
  assert.equal(tokenCode(w, r.plan), 'revoked');
  const cancel = w.runner.sentOf('attempt.cancel').find((m) => m.attemptId === r.attempt.id);
  assert.ok(cancel && cancel.reason === 'timeout');
  assert.ok(w.db.prepare('SELECT 1 FROM artifact_versions WHERE id = ?').get(v.versionId));
});

// ---------- AT5: a restart mid-turn ----------

const hashDir = (dir) => {
  const out = {};
  const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, `${rel}${e.name}/`); else out[`${rel}${e.name}`] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } };
  walk(dir, '');
  return out;
};

test('AT5 a restart mid-turn: interrupted, the worktree kept and unchanged, the token dead, a new message opens a new session on the same worktree', async () => {
  const w = await turnWorld();
  const r = await w.running();
  const dir = path.join(w.dataHome.root, 'wt', r.session.id.toLowerCase());
  fs.writeFileSync(path.join(dir, 'work-in-progress.txt'), 'half done\n');
  const before = hashDir(dir);
  const report = w.reboot();
  assert.equal(w.job(r.job.id).state, 'interrupted'); assert.equal(w.job(r.job.id).outcome, 'interrupted');
  assert.equal(w.attemptOf(r.attempt.id).state, 'abandoned');
  assert.equal(w.session(r.session.id).status, 'interrupted');
  assert.equal(tokenCode(w, r.plan), 'bad_signature', 'the new boot has a new key: the old token no longer even verifies');
  assert.equal(w.db.prepare('SELECT revoke_reason FROM capability_tokens WHERE job_id = ?').get(r.job.id).revoke_reason, 'restart');
  assert.ok(report.execution.interrupted >= 1);
  assert.deepEqual(hashDir(dir), before, 'the worktree is exactly as the agent left it');
  assert.ok(w.db.prepare('SELECT 1 FROM session_worktrees WHERE session_id = ? AND removed_at IS NULL').get(r.session.id), 'its record stays live');
  // The container is not a live attempt's any more: phase B's orphan list takes it.
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM job_attempts WHERE state IN ('starting','running')").get().n, 0);
  // A new message names the interrupted conversation: it opens a NEW session that continues on the same worktree.
  const next = w.start({ sessionId: r.session.id, seed: false, message: 'carry on' });
  assert.notEqual(next.session.id, r.session.id);
  assert.equal(next.session.status, 'open');
  const { plan } = await w.lease(next.job.id);
  assert.equal(plan.worktree.hostPath, path.join(w.dataHome.root, 'wt', r.session.id.toLowerCase()), 'the same folder');
  const row = w.db.prepare('SELECT rel_path, reused_from_session_id FROM session_worktrees WHERE session_id = ?').get(next.session.id);
  assert.equal(row.rel_path, `wt/${r.session.id.toLowerCase()}`); assert.equal(row.reused_from_session_id, r.session.id);
  assert.deepEqual(hashDir(dir), before, 'leasing the new turn did not touch it');
  assert.equal(JSON.parse(w.db.prepare('SELECT details_json FROM activity WHERE action = ? AND session_id = ?').get('repo.worktree', next.session.id).details_json).reused, true);
});

// ---------- AT6 and AT16: usage caps ----------

test('AT6 usage over the turn token cap ends the turn failed: limit (mid-turn usage events), the token revoked, the runner told', async () => {
  const w = await turnWorld();
  const r = await w.running();
  w.usage(r.attempt.id, { inputTokens: 100_000, outputTokens: 50_000 });
  assert.equal(w.job(r.job.id).state, 'running');
  w.usage(r.attempt.id, { inputTokens: 300_000, outputTokens: 100_001 });
  const j = w.job(r.job.id);
  assert.equal(j.state, 'failed'); assert.equal(j.outcome, 'limit');
  assert.equal(JSON.parse(j.error_json).code, 'limit');
  assert.equal(w.attemptOf(r.attempt.id).state, 'failed'); assert.equal(w.attemptOf(r.attempt.id).outcome, 'limit');
  assert.equal(tokenCode(w, r.plan), 'revoked');
  assert.ok(w.runner.sentOf('attempt.cancel').some((m) => m.attemptId === r.attempt.id), 'the runner is told to stop it');
  // What the runner reports afterwards (the exit) changes nothing.
  w.ev(r.attempt.id, { t: 'run.completed', at: w.clock.t, stopReason: 'end_turn' });
  w.exit(r.attempt.id, 0);
  assert.equal(w.job(r.job.id).state, 'failed');
  assert.equal(w.session(r.session.id).status, 'running');
});

test('F10 usage only ever rises: a lower report is ignored; the cost and tool-call caps end a turn too', async () => {
  const w = await turnWorld();
  const r = await w.running();
  w.usage(r.attempt.id, { inputTokens: 500, outputTokens: 500, costUsdCents: 20, toolCalls: 7 });
  w.usage(r.attempt.id, { inputTokens: 100, outputTokens: 100, costUsdCents: 5, toolCalls: 3 });
  let u = JSON.parse(w.attemptOf(r.attempt.id).usage_json);
  assert.deepEqual([u.inputTokens, u.costUsdCents, u.toolCalls], [500, 20, 7], 'the stored usage is the highest seen');
  w.usage(r.attempt.id, { inputTokens: 600, outputTokens: 500, costUsdCents: null, toolCalls: 8, estimated: true });
  u = JSON.parse(w.attemptOf(r.attempt.id).usage_json);
  assert.equal(u.costUsdCents, 20, 'a reported cost never disappears');
  w.usage(r.attempt.id, { inputTokens: 700, outputTokens: 500, costUsdCents: 200, toolCalls: 9 });
  assert.equal(w.job(r.job.id).state, 'failed'); assert.equal(w.job(r.job.id).outcome, 'limit');
  const t = await w.running({ sessionId: r.session.id });
  w.usage(t.attempt.id, { toolCalls: 199 });
  assert.equal(w.job(t.job.id).state, 'running');
  w.usage(t.attempt.id, { toolCalls: 200 });
  assert.equal(w.job(t.job.id).outcome, 'limit');
});

test('AT16 the day cap is reached mid-turn: the job is cancelled with limit', async () => {
  const w = await turnWorld({ caps: { dayUsdCents: 300, turnUsdCents: 200 } });
  const one = await w.running();
  w.usage(one.attempt.id, { costUsdCents: 150 });
  w.ev(one.attempt.id, { t: 'run.completed', at: w.clock.t, stopReason: 'end_turn' });
  w.registerVersion(one.job.id, one.session.id);
  w.exit(one.attempt.id, 0);
  assert.equal(w.job(one.job.id).state, 'completed');
  const two = await w.running({ sessionId: one.session.id });
  assert.equal(two.plan.caps.dayRemainingUsdCents, 150, 'the plan carries what is left of the day');
  assert.equal(two.plan.caps.turnUsdCents, 200);
  w.usage(two.attempt.id, { costUsdCents: 100 });
  assert.equal(w.job(two.job.id).state, 'running');
  w.usage(two.attempt.id, { costUsdCents: 150 });
  const j = w.job(two.job.id);
  assert.equal(j.state, 'failed'); assert.equal(j.outcome, 'limit');
  assert.equal(tokenCode(w, two.plan), 'revoked');
  // The day is spent: the next message is refused, not queued.
  assert.throws(() => w.nx.agents.start(w.me, { projectId: PROJECT, workspaceId: WORKSPACE, sessionId: one.session.id, focusVersionIds: [], message: 'more', intentId: ulid() }),
    (e) => e.code === 'unavailable' && e.detail.reason === 'budget_exhausted');
});

// ---------- AT18 and F27: a turn that registers nothing ----------

test('AT18 a turn that registers nothing becomes partial: no_change, and the step is not done', async () => {
  const w = await turnWorld();
  const r = await w.running();
  w.ev(r.attempt.id, { t: 'message.delta', text: 'I looked at it and changed nothing.' });
  w.ev(r.attempt.id, { t: 'run.completed', at: w.clock.t, stopReason: 'end_turn' });
  w.exit(r.attempt.id, 0);
  const j = w.job(r.job.id);
  assert.equal(j.state, 'partial'); assert.equal(j.outcome, 'no_change');
  assert.equal(w.attemptOf(r.attempt.id).state, 'succeeded'); assert.equal(w.attemptOf(r.attempt.id).outcome, 'no_change');
  assert.equal(tokenCode(w, r.plan), 'revoked');
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id WHERE a.kind = 'change_set'").get().n, 0);
  // The step's state from the records, exactly as the rail reads them: the change sets and their latest blocking results.
  const step = getDomain('sde').lifecycle.find((x) => x.id === 'ai-implementation');
  const versions = w.db.prepare(`SELECT v.id, v.status FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id WHERE a.project_id = ? AND a.kind = ?`).all(PROJECT, step.doneWhen.kind)
    .map((v) => ({ status: v.status, validators: Object.fromEntries(w.db.prepare('SELECT validator_id, status FROM validations WHERE version_id = ? AND blocking = 1').all(v.id).map((r) => [r.validator_id, r.status])) }));
  assert.deepEqual(versions, []);
  assert.notEqual(stepStateFrom(step, { versions, liveJobs: 0, inputsAvailable: true }), 'done');
  assert.notEqual(w.nx.exec.get(w.me, r.job.id).headline, 'completed');
  assert.equal(w.session(r.session.id).status, 'running', 'the conversation goes on');
});

test('a requirement drafted through the token counts as a registered version (completed, not no_change)', async () => {
  const w = await turnWorld();
  const r = await w.running();
  const reply = await w.nx.mcpGateway.call({ op: 'mcp.call', callId: 'rq1', bearer: r.plan.runtime.token, tool: 'requirement_draft',
    args: { title: 'Paginate the report', criteria: [{ id: 'C1', text: 'The report is paginated' }], clientKey: 'k1' } });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  w.ev(r.attempt.id, { t: 'run.completed', at: w.clock.t, stopReason: 'end_turn' });
  w.exit(r.attempt.id, 0);
  assert.equal(w.job(r.job.id).state, 'completed');
});

// ---------- run.failed, an exit without a result, the runner's own stops ----------

test('run.failed{auth} fails the turn runtime_auth and the session; other failures keep the session open', async () => {
  const w = await turnWorld();
  const r = await w.running();
  w.ev(r.attempt.id, { t: 'run.failed', at: w.clock.t, code: 'auth', message: 'the model service refused the engine\'s login' });
  w.exit(r.attempt.id, 1);
  const j = w.job(r.job.id);
  assert.equal(j.state, 'failed'); assert.equal(j.outcome, 'runtime_auth'); assert.equal(JSON.parse(j.error_json).code, 'runtime_auth');
  assert.equal(w.session(r.session.id).status, 'failed');
  assert.equal(tokenCode(w, r.plan), 'revoked');
  // A runtime error leaves the conversation open.
  const w2 = await turnWorld();
  const r2 = await w2.running();
  w2.ev(r2.attempt.id, { t: 'run.failed', at: w2.clock.t, code: 'runtime_error', message: 'failed: worktree_guard (symlink_in_worktree)' });
  w2.exit(r2.attempt.id, 1);
  assert.equal(w2.job(r2.job.id).state, 'failed'); assert.equal(w2.job(r2.job.id).outcome, 'worktree_guard');
  assert.equal(w2.session(r2.session.id).status, 'running');
});

test('an exit without a result fails the turn; the exit alone never completes it', async () => {
  const w = await turnWorld();
  const r = await w.running();
  w.registerVersion(r.job.id, r.session.id);
  w.exit(r.attempt.id, 0);
  const j = w.job(r.job.id);
  assert.equal(j.state, 'failed'); assert.equal(j.outcome, 'runtime_error', 'a version is there, but the runtime reported no result');
  const w2 = await turnWorld();
  const r2 = await w2.running();
  w2.ev(r2.attempt.id, { t: 'run.completed', at: w2.clock.t, stopReason: 'end_turn' });
  w2.registerVersion(r2.job.id, r2.session.id);
  w2.exit(r2.attempt.id, 1);
  assert.equal(w2.job(r2.job.id).state, 'failed', 'a completed event with a failing exit code is no completion');
});

// ---------- carry-forward 3: the token is revoked on EVERY end path ----------

test('the token is revoked on every end path: completed, partial, failed, cancelled, timed out, interrupted, refused and requeued', async () => {
  const paths = {
    completed: async (w, r) => { w.registerVersion(r.job.id, r.session.id); w.ev(r.attempt.id, { t: 'run.completed', at: w.clock.t, stopReason: 'x' }); w.exit(r.attempt.id, 0); },
    partial: async (w, r) => { w.ev(r.attempt.id, { t: 'run.completed', at: w.clock.t, stopReason: 'x' }); w.exit(r.attempt.id, 0); },
    failed: async (w, r) => { w.ev(r.attempt.id, { t: 'run.failed', at: w.clock.t, code: 'runtime_error', message: 'x' }); w.exit(r.attempt.id, 1); },
    cancelled: async (w, r) => { w.nx.agents.cancel(w.me, r.session.id); },
    timed_out: async (w) => { w.run(31 * 60_000); },
    interrupted_run_cancelled: async (w, r) => { w.ev(r.attempt.id, { t: 'run.cancelled', at: w.clock.t }); w.exit(r.attempt.id, null, { reason: 'cancelled' }); },
    interrupted_restart: async (w) => { w.reboot(); },
    runner_lost: async (w) => { for (let i = 0; i < 14; i++) { w.clock.t += 5_000; w.tick(); } },
    limit: async (w, r) => { w.usage(r.attempt.id, { inputTokens: 500_000 }); }
  };
  const expected = { completed: 'completed', partial: 'partial', failed: 'failed', cancelled: 'cancelled', timed_out: 'timed_out', interrupted_run_cancelled: 'interrupted',
    interrupted_restart: 'interrupted', runner_lost: 'failed', limit: 'failed' };
  for (const [name, end] of Object.entries(paths)) {
    const w = await turnWorld();
    const r = await w.running();
    assert.equal(tokenCode(w, r.plan), 'ok', `${name}: live before`);
    await end(w, r);
    assert.equal(w.job(r.job.id).state, expected[name], name);
    assert.equal(tokenCode(w, r.plan), name === 'interrupted_restart' ? 'bad_signature' : 'revoked', `${name}: the token is dead`);
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM capability_tokens WHERE job_id = ? AND revoked_at IS NULL').get(r.job.id).n, 0, `${name}: no live row`);
  }
  // Refused by the runner for good (bad_plan): failed. Refused for a reason that passes (Docker stopped): back to the queue, token dead, a new one at the next lease.
  const w = await turnWorld();
  const a = w.start();
  const first = await w.lease(a.job.id);
  w.runner.report({ op: 'attempt.refused', attemptId: first.attempt.id, reason: 'docker_stopped', detail: 'Docker is not running' });
  assert.equal(w.job(a.job.id).state, 'queued'); assert.equal(w.job(a.job.id).phase, 'waiting:docker');
  assert.equal(tokenCode(w, first.plan), 'revoked', 'the abandoned attempt\'s token is dead');
  w.tick(61_000);
  const second = await w.lease(a.job.id);
  assert.notEqual(tokenOf(second.plan), tokenOf(first.plan));
  assert.equal(tokenCode(w, second.plan), 'ok');
  w.runner.report({ op: 'attempt.refused', attemptId: second.attempt.id, reason: 'bad_plan', detail: 'x' });
  assert.equal(w.job(a.job.id).state, 'failed');
  assert.equal(tokenCode(w, second.plan), 'revoked');
});

test('the gateway forgets a turn when its token is revoked (the onRevoked listener), and a call after the end answers revoked', async () => {
  const w = await turnWorld();
  const r = await w.running();
  const ok = await w.nx.mcpGateway.call({ op: 'mcp.call', callId: 'g1', bearer: r.plan.runtime.token, tool: 'context_get', args: {} });
  assert.equal(ok.ok, true);
  w.ev(r.attempt.id, { t: 'run.completed', at: w.clock.t, stopReason: 'end_turn' });
  w.exit(r.attempt.id, 0);
  const late = await w.nx.mcpGateway.call({ op: 'mcp.call', callId: 'g2', bearer: r.plan.runtime.token, tool: 'context_get', args: {} });
  assert.equal(late.ok, false); assert.equal(late.code, 'revoked');
});

// ---------- AT10: a restart in each state, reconstructed, never completed ----------

test('AT10 a restart in queued, provisioning, running, tool execution, validation and awaiting approval is reconstructed and never completed', async () => {
  // queued: untouched, and it runs after the restart.
  {
    const w = await turnWorld();
    const q = w.start();
    w.reboot();
    assert.equal(w.job(q.job.id).state, 'queued');
    const { attempt } = await w.lease(q.job.id);
    assert.equal(attempt.state, 'starting');
  }
  // provisioning: leased, its attempt starting.
  {
    const w = await turnWorld();
    const q = w.start(); const { attempt, plan } = await w.lease(q.job.id);
    w.reboot();
    assert.equal(w.job(q.job.id).state, 'interrupted'); assert.equal(w.attemptOf(attempt.id).state, 'abandoned');
    assert.equal(w.db.prepare('SELECT revoke_reason FROM capability_tokens WHERE job_id = ?').get(q.job.id).revoke_reason, 'restart');
    assert.notEqual(tokenCode(w, plan), 'ok');
  }
  // running.
  {
    const w = await turnWorld();
    const r = await w.running();
    w.reboot();
    assert.equal(w.job(r.job.id).state, 'interrupted'); assert.equal(w.session(r.session.id).status, 'interrupted');
  }
  // tool execution: a granted sandbox exec is pending.
  {
    const w = await turnWorld();
    const r = await w.running();
    const g = await w.nx.mcpGateway.call({ op: 'mcp.call', callId: 'ex1', bearer: r.plan.runtime.token, tool: 'sandbox_exec', args: { argv: ['npm', 'test'], cwd: '/workspace', timeoutMs: 60_000 } });
    assert.equal(g.ok, true); assert.ok(g.value.grant.execId);
    w.reboot();
    assert.equal(w.job(r.job.id).state, 'interrupted'); assert.notEqual(tokenCode(w, r.plan), 'ok');
    assert.equal(await w.nx.mcpGateway.call({ op: 'mcp.call', callId: 'ex2', bearer: r.plan.runtime.token, tool: 'context_get', args: {} }).then((x) => x.code), 'bad_signature', 'the new key makes the old token fail');
  }
  // validation: a child check job is in flight.
  {
    const w = await turnWorld();
    const r = await w.running();
    const c = await w.nx.mcpGateway.call({ op: 'mcp.call', callId: 'jr1', bearer: r.plan.runtime.token, tool: 'job_request', args: { recipeId: 'sde.test.discover', inputs: [w.repoVersion] } });
    assert.equal(c.ok, true, JSON.stringify(c));
    w.reboot();
    assert.equal(w.job(r.job.id).state, 'interrupted'); assert.notEqual(w.job(r.job.id).state, 'completed');
    assert.ok(w.job(c.value.jobId), 'the child job is still a job of its own');
  }
  // awaiting approval: a child install waits for the user's network approval; the turn is interrupted, the approval is not.
  {
    const w = await turnWorld({ platform: { approvals: undefined } });
    const r = await w.running();
    const c = await w.nx.mcpGateway.call({ op: 'mcp.call', callId: 'ap1', bearer: r.plan.runtime.token, tool: 'job_request', args: { recipeId: 'sde.deps.node', inputs: [w.repoVersion] } });
    for (let i = 0; i < 100 && w.job(c.value.jobId).state !== 'awaiting_approval'; i++) { w.tick(); await sleep(5); }
    assert.equal(w.job(c.value.jobId).state, 'awaiting_approval');
    w.reboot();
    assert.equal(w.job(r.job.id).state, 'interrupted'); assert.notEqual(w.job(r.job.id).state, 'completed');
    assert.equal(w.db.prepare('SELECT status FROM approvals WHERE job_id = ?').get(c.value.jobId).status, 'pending');
  }
});

test('a queued turn whose conversation a restart interrupted is cancelled (session_ended) and never leased', async () => {
  const w = await turnWorld();
  const first = await w.running();
  w.registerVersion(first.job.id, first.session.id);
  w.ev(first.attempt.id, { t: 'run.completed', at: w.clock.t, stopReason: 'end_turn' });
  w.exit(first.attempt.id, 0);
  assert.equal(w.session(first.session.id).status, 'running');
  const second = w.nx.agents.start(w.me, { projectId: PROJECT, workspaceId: WORKSPACE, sessionId: first.session.id, focusVersionIds: [], message: 'and then this', intentId: ulid() });
  w.reboot();
  assert.equal(w.session(first.session.id).status, 'interrupted');
  assert.equal(w.job(second.job.id).state, 'queued');
  w.tick(); await sleep(15); w.tick();
  assert.equal(w.job(second.job.id).state, 'cancelled'); assert.equal(w.job(second.job.id).outcome, 'session_ended');
  assert.equal(w.attempts(second.job.id).length, 0, 'it never reached the runner');
  assert.equal(w.runner.sentOf('attempt.start').length, 0);
});

test('a runner restarted under a live turn cuts it off at phase B: interrupted, token revoked, the container released (never adopted)', async () => {
  const w = await turnWorld();
  const r = await w.running();
  w.runner.report({ op: 'ready', bootId: w.nx.bootId, mcpUrl: MCP_URL });
  assert.equal(tokenCode(w, r.plan), 'revoked', 'the runner\'s ready revokes every live token');
  const report = w.nx.exec.recoverPhaseB(w.sys, w.nx.bootId, { docker: 'running', attempts: [{ attemptId: r.attempt.id, container: 'running', containerId: 'c'.repeat(64) }], labelled: [] });
  assert.equal(report.adopted, 0);
  assert.equal(w.job(r.job.id).state, 'interrupted'); assert.equal(w.attemptOf(r.attempt.id).state, 'abandoned');
  assert.ok(w.runner.sentOf('attempt.release').some((m) => m.attemptId === r.attempt.id));
});

// ---------- AT11 and AT12: the scheduler's waits ----------

test('AT11 Docker unavailable: the turn waits (waiting:docker) and leases once Docker answers', async () => {
  const w = await turnWorld({ probe: { docker: 'stopped' } });
  const r = w.start();
  w.tick(); await sleep(20); w.tick();
  assert.equal(w.job(r.job.id).state, 'queued'); assert.equal(w.job(r.job.id).phase, 'waiting:docker');
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM job_attempts').get().n, 0, 'no attempt for a waiting turn');
  w.runner.report(probeMsg());
  const { attempt } = await w.lease(r.job.id);
  assert.equal(attempt.state, 'starting');
});

test('AT12 with one concurrent turn a second conversation waits (waiting:slots) and runs when the first ends', async () => {
  const w = await turnWorld();
  const a = await w.running();
  const b = w.start();
  for (let i = 0; i < 20; i++) { w.tick(); await sleep(5); }
  assert.equal(w.job(b.job.id).state, 'queued'); assert.equal(w.job(b.job.id).phase, 'waiting:slots');
  w.ev(a.attempt.id, { t: 'run.completed', at: w.clock.t, stopReason: 'end_turn' });
  w.exit(a.attempt.id, 0);
  const { attempt } = await w.lease(b.job.id);
  assert.equal(attempt.state, 'starting');
});

test('the guards: runtime health from the cache, consent, budget and rate, at start and while queued', async () => {
  // Runtime health (carry-forward 8): the provider is the cache; unknown or unhealthy refuses start and holds a queued turn.
  const w = await turnWorld({ health: null });
  assert.throws(() => w.start(), (e) => e.code === 'unavailable' && e.detail.reason === 'runtime_unknown');
  w.health.current = { kind: 'scripted', health: { ok: false, reason: 'not_installed', detail: 'x' } };
  assert.throws(() => w.start(), (e) => e.code === 'unavailable' && e.detail.reason === 'runtime_not_installed');
  w.health.current = { kind: 'scripted', health: { ok: false, reason: 'not_authenticated', detail: 'x' } };
  assert.throws(() => w.start(), (e) => e.detail.reason === 'runtime_not_authenticated');
  w.health.current = { kind: 'other', health: { ok: true, version: '1' }, egressHosts: HOSTS };
  assert.throws(() => w.start(), (e) => e.detail.reason === 'runtime_mismatch');
  w.health.current = HEALTH_OK;
  const q = w.start();
  w.health.current = { kind: 'scripted', health: { ok: false, reason: 'version_unsupported', detail: 'x' } };
  w.tick(); await sleep(10); w.tick();
  assert.equal(w.job(q.job.id).phase, 'waiting:runtime');
  w.health.current = HEALTH_OK;
  await w.lease(q.job.id);
  // Consent.
  const c = await turnWorld({ noConsent: true });
  assert.throws(() => c.start(), (e) => e.code === 'unavailable' && e.detail.reason === 'consent_missing');
  const c2 = await turnWorld();
  const cq = c2.start();
  c2.nx.budget.revoke(c2.me);
  c2.tick(); await sleep(10); c2.tick();
  assert.equal(c2.job(cq.job.id).phase, 'waiting:consent');
  assert.throws(() => c2.start(), (e) => e.detail.reason === 'consent_missing');
  c2.nx.budget.grant(c2.me, { runtimeKind: 'scripted', hosts: HOSTS });
  await c2.lease(cq.job.id);
  // Rate: 2 turns an hour.
  const r = await turnWorld({ caps: { turnsPerHour: 2 } });
  const r1 = r.start(); r.start();
  assert.throws(() => r.start(), (e) => e.code === 'unavailable' && e.detail.reason === 'rate_limited');
  assert.equal(r.job(r1.job.id).state, 'queued');
  // A queued turn finds the hour already spent by turns made another way.
  const r2 = await turnWorld({ caps: { turnsPerHour: 1 } });
  const only = r2.start();
  r2.nx.jobs.create(r2.me, { kind: 'agent.run', projectId: PROJECT, workspaceId: WORKSPACE, sessionId: only.session.id, idempotencyKey: `x-${ulid()}`, params: { message: 'x' } });
  r2.tick(); await sleep(10); r2.tick();
  assert.equal(r2.job(only.job.id).phase, 'waiting:rate');
});

test('a budget spent while a turn waits holds it (waiting:budget), and a turn at its cap is refused at start', async () => {
  const w = await turnWorld({ caps: { dayUsdCents: 200, turnUsdCents: 200 } });
  const a = await w.running();
  const b = w.start();
  w.usage(a.attempt.id, { costUsdCents: 200 });
  assert.equal(w.job(a.job.id).outcome, 'limit');
  w.tick(); await sleep(10); w.tick();
  assert.equal(w.job(b.job.id).phase, 'waiting:budget');
});

// ---------- carry-forward 1: the consent hash ----------

test('a consent hash that does not match its hosts refuses the turn start (and holds a queued one)', async () => {
  const w = await turnWorld();
  const queued = w.start();
  // The record is immutable by trigger; the test breaks it the way only a damaged database could.
  w.db.exec('DROP TRIGGER tr_consents_update');
  w.db.prepare('UPDATE runtime_consents SET hosts_sha256 = ? WHERE revoked_at IS NULL').run('0'.repeat(64));
  assert.throws(() => w.start(), (e) => e.code === 'conflict' && e.detail.reason === 'consent_mismatch');
  w.tick(); await sleep(15); w.tick();
  assert.equal(w.job(queued.job.id).state, 'queued', 'never leased on a damaged permission');
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM job_attempts').get().n, 0);
  assert.equal(w.runner.sentOf('attempt.start').length, 0);
});

test('the plan\'s allow-list is the consent hosts only, and its hash is the live row\'s own', async () => {
  const w = await turnWorld();
  const r = await w.running();
  assert.deepEqual(r.plan.egress.allow, [{ host: 'api.anthropic.com', port: 443 }]);
  const row = w.db.prepare('SELECT hosts_json, hosts_sha256 FROM runtime_consents WHERE revoked_at IS NULL').get();
  assert.deepEqual(JSON.parse(row.hosts_json), ['api.anthropic.com:443']);
  assert.equal(r.plan.egress.consentHostsSha256, row.hosts_sha256);
});

// ---------- AT13: continueWith, from a review ----------

test('AT13 a review that asks for changes continues the session: the reviewing user requests the turn, the review is its input', async () => {
  const w = await turnWorld();
  const r = await w.running();
  const v = w.registerVersion(r.job.id, r.session.id);
  w.nx.artifacts.finalize(w.sys, v.versionId, 'candidate');
  w.ev(r.attempt.id, { t: 'run.completed', at: w.clock.t, stopReason: 'end_turn' });
  w.exit(r.attempt.id, 0);
  const reviewIntent = ulid();
  const res = w.nx.reviews.decide(w.me, v.versionId, { decision: 'request_changes', comment: 'please rename the helper', intentId: reviewIntent });
  assert.ok(res.job && res.job.id, 'a turn job was created');
  const job = w.job(res.job.id);
  assert.equal(job.kind, 'agent.run'); assert.equal(job.requested_by, 'user:local'); assert.equal(job.on_behalf_of, 'user:local');
  assert.equal(job.session_id, r.session.id); assert.equal(job.state, 'queued');
  const inputs = w.db.prepare('SELECT version_id, role FROM job_inputs WHERE job_id = ?').all(job.id);
  assert.deepEqual(inputs, [{ version_id: v.versionId, role: 'review' }], 'the review is the turn\'s input');
  assert.equal(JSON.parse(job.params_json).reviewId, res.review.id);
  assert.ok(!job.params_json.includes('rename'), 'the comment is not copied into the turn\'s params');
  // Idempotent per review id: a re-sent decision (the same intent) and a direct second call answer the same turn.
  const again = w.nx.reviews.decide(w.me, v.versionId, { decision: 'request_changes', comment: 'please rename the helper', intentId: reviewIntent });
  assert.equal(again.review.id, res.review.id);
  assert.equal(w.nx.agents.continueWith(w.me, r.session.id, res.review.id).job.id, job.id);
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'agent.run'").get().n, 2);
  // The turn leases and the reviewer's comment reaches the agent through its context file.
  const { plan } = await w.lease(job.id);
  assert.ok(fs.readFileSync(path.join(w.dataHome.root, 'jobs', job.id, 'agent', 'context.md'), 'utf8').includes('rename'));
  assert.ok(claimsOf(w, plan).inputs.includes(v.versionId));
});

test('AT13 only a stored user starts or continues a turn, and a refused continue records nothing (the review rolls back)', async () => {
  const w = await turnWorld();
  const r = await w.running();
  const v = w.registerVersion(r.job.id, r.session.id);
  w.nx.artifacts.finalize(w.sys, v.versionId, 'candidate');
  // A turn is still running in the session: the review cannot start another; nothing is recorded.
  assert.throws(() => w.nx.reviews.decide(w.me, v.versionId, { decision: 'request_changes', comment: 'change it', intentId: ulid() }),
    (e) => e.code === 'conflict' && e.detail.reason === 'turn_running');
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM reviews').get().n, 0);
  assert.throws(() => w.nx.agents.continueWith(w.sys, r.session.id, 'x'), (e) => e.code === 'denied');
  assert.throws(() => w.nx.agents.start(w.sys, { projectId: PROJECT, workspaceId: WORKSPACE, sessionId: null, focusVersionIds: [], message: 'x', intentId: ulid() }),
    (e) => e.code === 'denied');
  // After an interrupted turn the continued session is a NEW one on the same worktree.
  w.reboot();
  const res = w.nx.reviews.decide(w.me, v.versionId, { decision: 'request_changes', comment: 'change it', intentId: ulid() });
  const job = w.job(res.job.id);
  assert.notEqual(job.session_id, r.session.id);
  assert.equal(w.session(job.session_id).status, 'open');
});

// ---------- the start inputs ----------

test('start validates its input, authorizes the user, and is idempotent by intent', async () => {
  const w = await turnWorld();
  const bad = (x, reason) => assert.throws(() => w.nx.agents.start(w.me, { projectId: PROJECT, workspaceId: WORKSPACE, sessionId: null, focusVersionIds: [], message: 'ok', intentId: ulid(), ...x }),
    (e) => (reason ? e.detail && e.detail.reason === reason : e.code === 'invalid'));
  bad({ message: 'x'.repeat(8001) }, 'message_too_long');
  bad({ message: '   ' }, 'message_required');
  bad({ message: 'use sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA to log in' }, 'secret_in_message');
  bad({ focusVersionIds: Array.from({ length: 21 }, (_, i) => `v${i}`) }, 'too_many_focus');
  bad({ skillId: 'not-a-skill' }, 'unknown_skill');
  bad({ intentId: '' }, 'intent_required');
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'agent.run'").get().n, 0, 'nothing was created');
  // A viewer may not start a turn.
  w.db.prepare('INSERT INTO principals VALUES (?,?,?,NULL,?)').run('user:viewer', 'user', 'viewer', h.NOW);
  w.db.prepare('INSERT INTO memberships VALUES (?,?,?,?,?)').run('user:viewer', 'project', PROJECT, 'viewer', h.NOW);
  assert.throws(() => w.nx.agents.start({ id: 'user:viewer', kind: 'user', displayName: 'viewer' }, { projectId: PROJECT, workspaceId: WORKSPACE, sessionId: null, focusVersionIds: [], message: 'hi', intentId: ulid() }),
    (e) => e.code === 'denied');
  // Focus versions are job inputs; the same intent answers the same turn.
  const intentId = ulid();
  const one = w.nx.agents.start(w.me, { projectId: PROJECT, workspaceId: WORKSPACE, sessionId: null, focusVersionIds: [w.repoVersion], message: 'with focus', intentId, skillId: 'nexus-sde-change' });
  assert.deepEqual(w.db.prepare('SELECT version_id, role FROM job_inputs WHERE job_id = ?').all(one.job.id), [{ version_id: w.repoVersion, role: 'focus' }]);
  assert.equal(one.job.params.skillId, 'nexus-sde-change');
  const lim = JSON.parse(w.job(one.job.id).limits_json);
  assert.equal(lim.turnTokens, 400000); assert.equal(lim.wallClockMs, 30 * 60_000);
  const two = w.nx.agents.start(w.me, { projectId: PROJECT, workspaceId: WORKSPACE, sessionId: null, focusVersionIds: [w.repoVersion], message: 'with focus', intentId, skillId: 'nexus-sde-change' });
  assert.equal(two.job.id, one.job.id); assert.equal(two.session.id, one.session.id);
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM agent_sessions").get().n >= 1, true);
});

// ---------- AT15: the records hold nothing a turn must keep secret ----------

test('AT15 sandbox_json and environment_json hold no token, message, config path or worktree host path; no table, event, log or view holds the token', async () => {
  const w = await turnWorld();
  const r = await w.running();
  w.ev(r.attempt.id, { t: 'message.delta', text: 'Working on it.' });
  w.usage(r.attempt.id, { toolCalls: 1 });
  const v = w.registerVersion(r.job.id, r.session.id);
  w.ev(r.attempt.id, { t: 'run.completed', at: w.clock.t, stopReason: 'end_turn' });
  w.exit(r.attempt.id, 0);
  const token = r.plan.runtime.token;
  const jti = token.split('.')[0];
  const forbidden = { token, mac: token.split('.')[1], message: 'zebra-quartz-77', configDir: path.join(w.dataHome.root, 'jobs', r.job.id, 'agent'),
    worktree: r.plan.worktree.hostPath, dataHome: w.dataHome.root, repo: w.repoDir };
  const a = w.attemptOf(r.attempt.id);
  for (const col of ['sandbox_json', 'environment_json']) {
    const text = a[col];
    assert.ok(typeof text === 'string' && text.length > 2, `${col} is recorded`);
    for (const [what, needle] of Object.entries(forbidden)) {
      assert.ok(!text.includes(needle) && !text.includes(JSON.stringify(needle).slice(1, -1)), `${col} holds no ${what}`);
    }
  }
  const sb = JSON.parse(a.sandbox_json);
  assert.equal(sb.executor, 'agent'); assert.equal(sb.profile, 'sde-node'); assert.equal(sb.network.mode, 'none');
  assert.deepEqual(sb.mounts, [{ kind: 'worktree', containerPath: '/workspace', readOnly: false }], 'mounts: destination and kind only');
  assert.equal(sb.runtime.kind, 'scripted'); assert.equal(sb.runtime.adapterVersion, '1.0.0'); assert.equal(sb.runtime.flagsSha256, 'f'.repeat(64));
  assert.equal(sb.context.sha256, w.job(r.job.id).context_hash);
  assert.deepEqual(sb.egress.allow, ['api.anthropic.com:443']);
  assert.equal(sb.egress.consentHostsSha256, w.consent.hostsSha256);
  assert.ok(sb.limits && sb.image && sb.turn.tokens === 400000);
  const env = JSON.parse(a.environment_json);
  assert.equal(env.runtimeKind, 'scripted'); assert.equal(env.runtimeVersion, '1.0.0'); assert.equal(env.model, 'default'); assert.equal(env.imageId, IMAGE);
  // The token (carry-forward 6): in no table of the database, no event, no log, no view.
  const tables = w.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((t) => t.name);
  for (const t of tables) {
    for (const row of w.db.prepare(`SELECT * FROM "${t}"`).all()) {
      const text = JSON.stringify(row);
      assert.ok(!text.includes(token) && !text.includes(forbidden.mac), `table ${t} holds no token`);
      if (t !== 'jobs') assert.ok(!text.includes('zebra-quartz-77'), `table ${t} holds no message (only the job's own params do)`);
    }
  }
  assert.ok(!w.db.prepare('SELECT jti FROM capability_tokens').all().some((x) => x.jti === token));
  assert.equal(w.db.prepare('SELECT jti FROM capability_tokens WHERE job_id = ?').get(r.job.id).jti, jti, 'only the id is recorded');
  for (const view of [w.nx.exec.get(w.me, r.job.id), w.nx.exec.list(w.me, { projectId: PROJECT }), w.nx.jobs.get(w.me, r.job.id), w.nx.agents.list(w.me, PROJECT),
    await w.nx.agents.get(w.me, r.session.id), w.nx.exec.eventsSince(w.me, { sinceSeq: 0, projectId: PROJECT, limit: 500 }), w.nx.sessions.get(w.me, r.session.id)]) {
    const text = JSON.stringify(view);
    assert.ok(!text.includes(token), 'no view holds the token');
    for (const p of [forbidden.worktree, forbidden.dataHome, forbidden.configDir]) assert.ok(!text.includes(p) && !text.includes(JSON.stringify(p).slice(1, -1)), 'no view holds a host path');
  }
  assert.ok(!JSON.stringify(w.logs).includes(token), 'no log line holds the token');
  assert.ok(v.versionId);
});

// ---------- get, list, end ----------

test('get returns the turns, display-only messages from the redacted log frames, tool calls from events, versions and approvals; list and end', async () => {
  const w = await turnWorld();
  const r = await w.running();
  w.ev(r.attempt.id, { t: 'tool.started', callId: 'c1', tool: 'sandbox_exec', argsSummary: 'npm test' });
  w.usage(r.attempt.id, { inputTokens: 40, outputTokens: 2, costUsdCents: 2, toolCalls: 3 });
  const v = w.registerVersion(r.job.id, r.session.id);
  // The runner's log, as its LogWriter frames it: redacted `message:` lines of the agent.
  const logRel = w.attemptOf(r.attempt.id).log_path;
  fs.mkdirSync(path.dirname(path.join(w.dataHome.root, ...logRel.split('/'))), { recursive: true });
  fs.writeFileSync(path.join(w.dataHome.root, ...logRel.split('/')), [
    JSON.stringify({ ts: w.clock.t, stream: 'nexus', text: 'run started (run-1)' }),
    JSON.stringify({ ts: w.clock.t + 1, stream: 'nexus', text: 'message: Reading the context.' }),
    JSON.stringify({ ts: w.clock.t + 2, stream: 'stdout', text: 'message: this is not the agent' }),
    JSON.stringify({ ts: w.clock.t + 3, stream: 'nexus', text: 'tool sandbox_exec started' })].join('\n') + '\n');
  const d = await w.nx.agents.get(w.me, r.session.id);
  assert.equal(d.id, r.session.id); assert.equal(d.turns, 1); assert.equal(d.liveJobId, r.job.id);
  assert.equal(d.turnHistory.length, 1); assert.equal(d.turnHistory[0].jobId, r.job.id); assert.equal(d.turnHistory[0].usage.costUsdCents, 2);
  assert.deepEqual(d.messages.map((m) => [m.from, m.text, m.displayOnly]), [['user', MESSAGE, true], ['agent', 'Reading the context.', true]]);
  assert.ok(d.toolCalls.some((t) => t.tool === 'sandbox_exec'));
  assert.deepEqual(d.versions.map((x) => x.versionId), [v.versionId]);
  assert.deepEqual(d.approvals, []);
  assert.equal(w.nx.agents.list(w.me, PROJECT).length, 1);
  assert.equal(w.nx.agents.list(w.me, PROJECT)[0].liveJobId, r.job.id);
  // end: a live turn is cancelled, then the conversation is over; a new message in it is refused.
  const ended = w.nx.agents.end(w.me, r.session.id);
  assert.equal(ended.status, 'completed');
  assert.equal(w.job(r.job.id).state, 'cancelled'); assert.equal(tokenCode(w, r.plan), 'revoked');
  assert.throws(() => w.nx.agents.start(w.me, { projectId: PROJECT, workspaceId: WORKSPACE, sessionId: r.session.id, focusVersionIds: [], message: 'again', intentId: ulid() }),
    (e) => e.code === 'conflict' && e.detail.reason === 'session_ended');
  // A conversation that never ran is cancelled by end.
  const q = w.start();
  assert.equal(w.nx.agents.end(w.me, q.session.id).status, 'cancelled');
  assert.equal(w.job(q.job.id).state, 'cancelled');
});

test('a session with a running turn cannot be cancelled under it (SessionService.cancel refuses; cancel the turn first)', async () => {
  const w = await turnWorld();
  const r = await w.running();
  assert.throws(() => w.nx.sessions.cancel(w.me, r.session.id), (e) => e.code === 'conflict' && e.detail.reason === 'turn_running');
  assert.equal(w.job(r.job.id).state, 'running'); assert.equal(w.attemptOf(r.attempt.id).state, 'running');
});

// ---------- the runtime events the core does not trust ----------

test('runtime events of an unknown attempt, a stale seq or an attempt that is not running change nothing', async () => {
  const w = await turnWorld();
  const r = await w.running();
  w.runner.report({ op: 'attempt.runtime', attemptId: newId(w.clock.t), seq: 5, event: { t: 'usage', inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, costUsdCents: 1, toolCalls: 0, estimated: false } });
  w.usage(r.attempt.id, { inputTokens: 10 });
  w.runner.report({ op: 'attempt.runtime', attemptId: r.attempt.id, seq: 5, event: { t: 'usage', inputTokens: 999, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, costUsdCents: 1, toolCalls: 0, estimated: false } });
  assert.equal(JSON.parse(w.attemptOf(r.attempt.id).usage_json).inputTokens, 10, 'a seq that is not after the last one is dropped');
  w.nx.agents.cancel(w.me, r.session.id);
  w.usage(r.attempt.id, { inputTokens: 5000 });
  assert.equal(JSON.parse(w.attemptOf(r.attempt.id).usage_json).inputTokens, 10, 'a cancelled attempt takes no more usage');
});

// ---------- the plan builder, on its own ----------

test('a collect plans against the recorded worktree of a REUSED session (its folder, git folder and ref carry the name of the earlier session); a bad record is refused', () => {
  const root = path.join(h.tmpDir('nx-at-pb-'), 'nexus'); const repo = h.tmpDir('nx-at-pbr-');
  const earlier = ulid().toLowerCase(); const later = ulid();
  const base = { job: { id: ulid(), projectId: 'p' }, attempt: { id: ulid(), n: 1 }, bootId: ulid(), recipe: getRecipe('changeset.collect'), dataHomeRoot: root,
    workRel: 'work/j/1', logRel: 'logs/jobs/j/1.log', inputs: [], repoPath: repo,
    params: { sessionId: later, branch: 'main', scope: ['**', '!.git/**'], title: 'A change', turnJobId: ulid() } };
  const plain = buildPlan(base).task;
  assert.ok(plain.worktreePath.endsWith(later.toLowerCase())); assert.equal(plain.ref, `refs/nexus/job/${later.toLowerCase()}`);
  const reused = buildPlan({ ...base, worktree: { relPath: `wt/${earlier}`, ref: `refs/nexus/job/${earlier}` } }).task;
  assert.ok(reused.worktreePath.endsWith(earlier)); assert.equal(path.basename(reused.gitDir), earlier); assert.equal(reused.ref, `refs/nexus/job/${earlier}`);
  for (const worktree of [{ relPath: 'wt/../x', ref: 'refs/nexus/job/x' }, { relPath: `wt/${earlier}`, ref: `refs/nexus/job/${later.toLowerCase()}` }, { relPath: 'wt/short', ref: 'refs/nexus/job/short' }]) {
    assert.throws(() => buildPlan({ ...base, worktree }), (e) => e.code === 'invalid' && e.detail.reason === 'bad_input', JSON.stringify(worktree));
  }
});

test('the agent plan builder refuses what the runner would: no consent hash, a worktree that is not a session folder, no profile image', () => {
  const root = path.join(h.tmpDir('nx-at-pa-'), 'nexus');
  const sid = ulid().toLowerCase();
  const ctx = { job: { id: ulid(), projectId: 'p' }, attempt: { id: ulid(), n: 1 }, bootId: ulid(), dataHomeRoot: root, workRel: 'work/j/1', logRel: 'logs/jobs/j/1.log',
    profile: PROFILES[0], imageId: IMAGE, worktree: { relPath: `wt/${sid}`, gitDir: path.join(root, 'g'), ref: `refs/nexus/job/${sid}`, base: 'b'.repeat(40) },
    runtime: { kind: 'scripted', token: 'a'.repeat(22) + '.' + 'b'.repeat(43), sessionId: 'S', idempotencyKey: 'k', domainId: 'sde', skills: [], context: { hash: 'c'.repeat(64) },
      message: 'hi', mcpUrl: MCP_URL, model: { provider: 'runtime-owned', model: 'default' } },
    egress: { allow: HOSTS, consentHostsSha256: hostsSha256(HOSTS) }, caps: { turnTokens: 1, turnUsdCents: 2, dayRemainingUsdCents: 3, toolCalls: 4 }, wallClockMs: 60_000, mcpTools: ['context_get'] };
  const plan = buildAgentPlan(ctx);
  assert.equal(plan.recipe.id, 'agent.turn'); assert.deepEqual(plan.mcpTools, ['context_get']);
  assert.equal(plan.runtime.request.limits.maxCostUsd, 0.02);
  const refused = (patch, reason) => assert.throws(() => buildAgentPlan({ ...ctx, ...patch }), (e) => e.code === 'invalid' && e.detail.reason === reason, reason);
  refused({ egress: { allow: HOSTS, consentHostsSha256: 'nothex' } }, 'consent_mismatch');
  refused({ worktree: { ...ctx.worktree, relPath: 'wt/short' } }, 'bad_input');
  refused({ imageId: null }, 'image_missing');
  refused({ profile: null }, 'image_missing');
  refused({ wallClockMs: 0 }, 'bad_input');
});

// ---------- the contract with the real runner ----------

test('the plan main builds is accepted by the real runner core (labels, paths, mounts, tools, consent hash), and its reports finish the turn in main', async () => {
  const w = await turnWorld();
  const r = w.start();
  const { attempt, plan } = await w.lease(r.job.id);
  const { port1, port2 } = new MessageChannel();
  const got = [];
  port1.on('message', (m) => {
    got.push(m);
    // The runner's attempt reports are main's input, exactly as the port carries them (not its ready: that is a new runner).
    if (typeof m.op === 'string' && m.op.startsWith('attempt.')) w.runner.report(m);
  });
  const core = new RunnerCore(port2, { driver: new FakeSandboxDriver({}), now: () => Date.now(), fs: fsp, freeBytes: async () => 100 * GIB, sleep: async () => {},
    imagesDir: path.join(__dirname, '..', 'infra', 'images'), docker: null, agentRuntime: { scriptFor: () => [{ op: 'delta', text: 'nothing to change' }] } });
  try {
    port1.postMessage({ op: 'hello', bootId: w.nx.bootId, dataHome: w.dataHome.root, home: homeLabel(w.dataHome.root), profiles: PROFILES });
    await until(() => got.some((m) => m.op === 'ready'), 'the runner is ready');
    port1.postMessage({ op: 'attempt.start', attemptId: attempt.id, plan });
    await until(() => got.some((m) => m.op === 'attempt.exited' || m.op === 'attempt.refused'), 'the turn ends in the runner');
    assert.equal(got.find((m) => m.op === 'attempt.refused'), undefined, JSON.stringify(got.find((m) => m.op === 'attempt.refused')));
    assert.equal(got.find((m) => m.op === 'attempt.exited').exit.code, 0);
    assert.ok(got.some((m) => m.op === 'attempt.provisioned' && m.preflight.ok === true));
    assert.ok(got.filter((m) => m.op === 'attempt.runtime').some((m) => m.event.t === 'run.completed'));
    // Main finished it from those reports: nothing registered, so it is partial: no_change; the token is dead.
    assert.equal(w.job(r.job.id).state, 'partial'); assert.equal(w.job(r.job.id).outcome, 'no_change');
    assert.equal(w.session(r.session.id).status, 'running');
    assert.equal(tokenCode(w, plan), 'revoked');
    assert.equal(w.attemptOf(attempt.id).container_id.length, 64);
    assert.ok(!JSON.stringify(w.attemptOf(attempt.id)).includes(plan.worktree.hostPath), 'no host path in the attempt row');
  } finally {
    await core.shutdown(); port1.close();
  }
});

// ---------- fix round 1 ----------

test('I1 only work completes a turn: a discovery child that produced a test suite is no_change; a registered change set is completed', async () => {
  const w = await turnWorld();
  const a = await w.running();
  // The agent asked for a discovery run; its recipe produced a test_suite version. That is looking around, not work.
  const found = w.registerVersion(a.job.id, a.session.id, 'suite', { kind: 'test_suite', recipe: 'sde.test.discover' });
  assert.ok(found.versionId);
  assert.equal(w.nx.agents.registeredVersions(a.job.id).length, 1, 'the session view still lists what the turn produced');
  assert.equal(w.nx.agents.registeredCount(a.job.id), 0, 'but none of it is work');
  w.ev(a.attempt.id, { t: 'run.completed', at: w.clock.t, stopReason: 'end_turn' });
  w.exit(a.attempt.id, 0);
  assert.equal(w.job(a.job.id).state, 'partial'); assert.equal(w.job(a.job.id).outcome, 'no_change');
  // A change set from a collect child is work.
  const b = await w.running({ sessionId: a.session.id });
  w.registerVersion(b.job.id, b.session.id, 'real change');
  w.ev(b.attempt.id, { t: 'run.completed', at: w.clock.t, stopReason: 'end_turn' });
  w.exit(b.attempt.id, 0);
  assert.equal(w.job(b.job.id).state, 'completed');
  // A change-set-kind version produced by some OTHER recipe's child does not count either.
  const c = await w.running({ sessionId: a.session.id });
  w.registerVersion(c.job.id, c.session.id, 'odd', { recipe: 'sde.test.discover' });
  w.ev(c.attempt.id, { t: 'run.completed', at: w.clock.t, stopReason: 'end_turn' });
  w.exit(c.attempt.id, 0);
  assert.equal(w.job(c.job.id).outcome, 'no_change');
});

test('I2 the egress allow-list is the adapter\'s own hosts; a consent that names any other destination is refused, held and fails a leased turn before a token is minted', async () => {
  // The plan is built from the health entry (canonicalised), not from the consent row.
  const w = await turnWorld({ health: { ...HEALTH_OK, egressHosts: [{ host: 'API.Anthropic.com', port: 443 }] } });
  const r = await w.running();
  assert.deepEqual(r.plan.egress.allow, [{ host: 'api.anthropic.com', port: 443 }]);
  assert.equal(r.plan.egress.consentHostsSha256, w.consent.hostsSha256);
  // A health entry that does not carry the adapter's hosts is unknown: start refused.
  const noHosts = await turnWorld({ health: { kind: 'scripted', health: { ok: true, version: '1' } } });
  assert.throws(() => noHosts.start(), (e) => e.code === 'unavailable' && e.detail.reason === 'runtime_unknown');
  noHosts.health.current = { ...HEALTH_OK, egressHosts: [] };
  assert.throws(() => noHosts.start(), (e) => e.detail.reason === 'runtime_unknown');
  // A consent with an extra host, or a different one, is refused at start.
  for (const hosts of [[...HOSTS, { host: 'other.example.com', port: 443 }], [{ host: 'other.example.com', port: 443 }], [{ host: 'api.anthropic.com', port: 8443 }]]) {
    const x = await turnWorld({ noConsent: true });
    x.nx.budget.grant(x.me, { runtimeKind: 'scripted', hosts });
    assert.throws(() => x.start(), (e) => e.code === 'conflict' && e.detail.reason === 'consent_mismatch', JSON.stringify(hosts));
    assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'agent.run'").get().n, 0);
  }
  // The adapter's hosts changed under a consent that matched: a queued turn is held, never leased.
  const q = await turnWorld();
  const queued = q.start();
  q.health.current = { ...HEALTH_OK, egressHosts: [{ host: 'moved.example.com', port: 443 }] };
  q.tick(); await sleep(15); q.tick();
  assert.equal(q.job(queued.job.id).state, 'queued'); assert.equal(q.job(queued.job.id).phase, 'waiting:consent');
  assert.equal(q.db.prepare('SELECT COUNT(*) AS n FROM job_attempts').get().n, 0);
  // Past the guard (a race), the lease's own check fails before ANY token is minted.
  const job = q.db.prepare('SELECT * FROM jobs WHERE id = ?').get(queued.job.id);
  const lease = q.nx.agents.planTx(job, { id: ulid(), n: 1 }, { worktree: { relPath: `wt/${queued.session.id.toLowerCase()}`, gitDir: 'g', ref: 'refs/nexus/job/x', base: 'b'.repeat(40) }, contextSha256: 'c'.repeat(64), skills: [] },
    { bootId: q.nx.bootId, dataHomeRoot: q.dataHome.root, workRel: 'work/j/1', logRel: 'logs/jobs/j/1.log', profile: PROFILES[0], imageId: IMAGE, mcpUrl: MCP_URL, dockerVersion: null, nexusVersion: null });
  assert.equal(lease.failed.code, 'consent_mismatch');
  assert.equal(q.db.prepare('SELECT COUNT(*) AS n FROM capability_tokens').get().n, 0, 'no token was minted');
});

test('I3 fail closed: a token revocation that fails leaves the job and attempt running; a later event or tick retries and ends them', async () => {
  const w = await turnWorld();
  const r = await w.running();
  w.registerVersion(r.job.id, r.session.id);
  const real = w.nx.tokens.revokeForJob;
  w.nx.tokens.revokeForJob = () => { throw new Error('the revocation failed'); };
  w.ev(r.attempt.id, { t: 'run.completed', at: w.clock.t, stopReason: 'end_turn' });
  w.exit(r.attempt.id, 0);
  assert.equal(w.job(r.job.id).state, 'running', 'the end transition rolled back');
  assert.equal(w.attemptOf(r.attempt.id).state, 'running');
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM capability_tokens WHERE job_id = ? AND revoked_at IS NULL').get(r.job.id).n, 1, 'the token is live and so is its job');
  assert.equal(tokenCode(w, r.plan), 'ok');
  assert.ok(w.logs.some((l) => /not applied/.test(l)), 'the failure was logged, not swallowed');
  // The user cannot cancel it either while revocation fails: nothing half-ends.
  assert.throws(() => w.nx.agents.cancel(w.me, r.session.id));
  assert.equal(w.job(r.job.id).state, 'running'); assert.equal(w.attemptOf(r.attempt.id).state, 'running');
  // The runner reports its exit again once revocation works: the turn still knows how it ended, and it ends.
  w.nx.tokens.revokeForJob = real;
  w.exit(r.attempt.id, 0);
  assert.equal(w.job(r.job.id).state, 'completed'); assert.equal(tokenCode(w, r.plan), 'revoked');
  // A tick retries too: the wall clock ends a turn whose revocation failed until it works.
  const t = await w.running({ sessionId: r.session.id });
  w.nx.tokens.revokeForJob = () => { throw new Error('the revocation failed'); };
  w.run(31 * 60_000);
  assert.equal(w.job(t.job.id).state, 'running', 'still running: it could not end');
  w.nx.tokens.revokeForJob = real;
  w.run(10_000);
  assert.equal(w.job(t.job.id).state, 'timed_out'); assert.equal(tokenCode(w, t.plan), 'revoked');
});

test('I4 usage keeps the per-field maximum: an event that raises tokens and lowers tool calls still raises tokens, and a cap is enforced on the merged value', async () => {
  const w = await turnWorld();
  const r = await w.running();
  w.usage(r.attempt.id, { inputTokens: 100, outputTokens: 50, costUsdCents: 20, toolCalls: 7 });
  w.usage(r.attempt.id, { inputTokens: 300, outputTokens: 40, costUsdCents: null, toolCalls: 3, estimated: true });
  let u = JSON.parse(w.attemptOf(r.attempt.id).usage_json);
  assert.deepEqual([u.inputTokens, u.outputTokens, u.toolCalls, u.costUsdCents, u.estimated], [300, 50, 7, 20, false], 'tokens rose, the rest kept, a reported cost never goes null');
  w.usage(r.attempt.id, { inputTokens: 250, outputTokens: 10, costUsdCents: 5, toolCalls: 1 });
  u = JSON.parse(w.attemptOf(r.attempt.id).usage_json);
  assert.deepEqual([u.inputTokens, u.outputTokens, u.toolCalls, u.costUsdCents], [300, 50, 7, 20], 'nothing is ever lowered');
  assert.equal(w.job(r.job.id).state, 'running');
  // The cap is crossed by an event that also lowers another counter: the turn is cancelled failed: limit.
  w.usage(r.attempt.id, { inputTokens: 400_001, outputTokens: 0, costUsdCents: null, toolCalls: 1 });
  assert.equal(w.job(r.job.id).state, 'failed'); assert.equal(w.job(r.job.id).outcome, 'limit');
  assert.equal(JSON.parse(w.attemptOf(r.attempt.id).usage_json).toolCalls, 7);
});

test('a re-sent intent for another message, project or conversation is refused; the key belongs to its user', async () => {
  const w = await turnWorld();
  const intentId = ulid();
  const one = w.nx.agents.start(w.me, { projectId: PROJECT, workspaceId: WORKSPACE, sessionId: null, focusVersionIds: [], message: 'the first message', intentId });
  const same = w.nx.agents.start(w.me, { projectId: PROJECT, workspaceId: WORKSPACE, sessionId: null, focusVersionIds: [], message: 'the first message', intentId });
  assert.equal(same.job.id, one.job.id);
  assert.throws(() => w.nx.agents.start(w.me, { projectId: PROJECT, workspaceId: WORKSPACE, sessionId: null, focusVersionIds: [], message: 'a different message', intentId }),
    (e) => e.code === 'invalid' && e.detail.reason === 'intent_mismatch');
  assert.throws(() => w.nx.agents.start(w.me, { projectId: PROJECT, workspaceId: WORKSPACE, sessionId: ulid(), focusVersionIds: [], message: 'the first message', intentId }),
    (e) => e.code === 'invalid' || e.code === 'not_found');
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'agent.run'").get().n, 1);
  assert.ok(w.db.prepare("SELECT 1 FROM jobs WHERE idempotency_key = ?").get(`agent.turn:user:local:${intentId}`), 'the key is namespaced by the user');
});

test('a worktree that could not be reused is recorded (reused: false) and the agent is told in its context file that the earlier work was not carried over', async () => {
  const w = await turnWorld();
  const first = await w.running();
  w.reboot();
  // The first continuation takes the worktree; a second one for the same interrupted session cannot.
  const second = w.start({ sessionId: first.session.id, seed: false, message: 'carry on' });
  await w.lease(second.job.id);
  w.nx.exec.cancel(w.me, second.job.id);
  const third = w.nx.agents.start(w.me, { projectId: PROJECT, workspaceId: WORKSPACE, sessionId: first.session.id, focusVersionIds: [], message: 'and again', intentId: ulid() });
  const ensured = w.nx.worktrees.ensure(w.sys, third.session.id, third.job.id, { reuseFrom: first.session.id });
  assert.ok('waiting' in ensured, 'it does not get the worktree: a fresh one is asked for (A3 first)');
  const rows = w.db.prepare("SELECT details_json FROM activity WHERE action = 'repo.worktree' AND session_id = ?").all(third.session.id).map((x) => JSON.parse(x.details_json));
  assert.ok(rows.some((d) => d.reused === false && d.reuseRequested === true && d.reuseRefused === 'already_reused'), JSON.stringify(rows));
  // Its own fresh worktree arrives later; the turn's context says the earlier work was not carried over.
  w.seedWorktree(third.session.id);
  await w.lease(third.job.id);
  const context = fs.readFileSync(path.join(w.dataHome.root, 'jobs', third.job.id, 'agent', 'context.md'), 'utf8');
  assert.match(context, /NOT carried over/);
  // A continued worktree carries no such note.
  const okContext = fs.readFileSync(path.join(w.dataHome.root, 'jobs', second.job.id, 'agent', 'context.md'), 'utf8');
  assert.doesNotMatch(okContext, /NOT carried over/);
});

test('the host proxy decisions of an agent turn are persisted as attempt.progress job_events: exactly one row per decision, the cap marker too, the token nowhere', async () => {
  const w = await turnWorld();
  const { job, attempt, plan } = await w.running();
  const report = (seq, event) => w.runner.report({ op: 'attempt.event', attemptId: attempt.id, seq, event });
  const at = w.clock.t;
  report(2_000_001, { t: 'egress', decision: 'allowed', host: 'api.example.com', port: 443, reason: 'allowed', at });
  report(2_000_002, { t: 'egress', decision: 'refused', host: 'evil.example.org', port: 443, reason: 'host_not_allowed', at });
  report(2_000_003, { t: 'egress.truncated', count: 7, at });
  report(2_000_003, { t: 'egress', decision: 'allowed', host: 'dup.example.com', port: 443, reason: 'allowed', at });   // a repeated seq is dropped
  const rows = w.db.prepare("SELECT summary, data_json FROM job_events WHERE job_id = ? AND type = 'attempt.progress' ORDER BY seq").all(job.id)
    .map((r) => ({ summary: r.summary, data: JSON.parse(r.data_json) }));
  const egress = rows.filter((r) => r.data.egress);
  assert.deepEqual(egress.map((r) => r.data.egress), [
    { decision: 'allowed', host: 'api.example.com', port: 443, reason: 'allowed' },
    { decision: 'refused', host: 'evil.example.org', port: 443, reason: 'host_not_allowed' }]);
  assert.match(egress[0].summary, /egress allowed api\.example\.com:443/);
  assert.match(egress[1].summary, /egress refused evil\.example\.org:443 \(host_not_allowed\)/);
  const marks = rows.filter((r) => r.data.egressTruncated);
  assert.equal(marks.length, 1);
  assert.deepEqual(marks[0].data.egressTruncated, { count: 7 });
  assert.ok(!JSON.stringify(rows).includes(plan.runtime?.token ?? 'no-token-in-plan'), 'no token in any recorded event');
});

// ---------- final-review round ----------

test('B2 only a change set whose register-stage checks held counts as work: an empty register and a secret-scan failure end no_change, a good one completes', async () => {
  const w = await turnWorld();
  const empty = await w.running();
  // changeset_register after changing nothing (or only what the scope excludes): ingest makes a FAILED change set, diff_nonempty failed.
  w.registerVersion(empty.job.id, empty.session.id, 'nothing', { validators: [['git.diff_nonempty', 'failed']] });
  assert.equal(w.nx.agents.registeredCount(empty.job.id), 0);
  w.ev(empty.attempt.id, { t: 'run.completed', at: w.clock.t, stopReason: 'end_turn' });
  w.exit(empty.attempt.id, 0);
  assert.equal(w.job(empty.job.id).state, 'partial'); assert.equal(w.job(empty.job.id).outcome, 'no_change');
  const leaky = await w.running({ sessionId: empty.session.id });
  w.registerVersion(leaky.job.id, leaky.session.id, 'secret', { validators: [['git.diff_nonempty', 'passed'], ['git.paths_in_scope', 'passed'], ['sec.secret_scan', 'failed']] });
  w.ev(leaky.attempt.id, { t: 'run.completed', at: w.clock.t, stopReason: 'end_turn' });
  w.exit(leaky.attempt.id, 0);
  assert.notEqual(w.job(leaky.job.id).state, 'completed'); assert.equal(w.job(leaky.job.id).outcome, 'no_change');
  const noScope = await w.running({ sessionId: empty.session.id });
  w.registerVersion(noScope.job.id, noScope.session.id, 'out of scope', { validators: [['git.diff_nonempty', 'passed'], ['git.paths_in_scope', 'failed'], ['sec.secret_scan', 'passed']] });
  w.ev(noScope.attempt.id, { t: 'run.completed', at: w.clock.t, stopReason: 'end_turn' });
  w.exit(noScope.attempt.id, 0);
  assert.equal(w.job(noScope.job.id).outcome, 'no_change');
  // A register that left no results at all (ingest not finished) is not evidence either.
  const pending = await w.running({ sessionId: empty.session.id });
  w.registerVersion(pending.job.id, pending.session.id, 'pending', { validators: [] });
  w.ev(pending.attempt.id, { t: 'run.completed', at: w.clock.t, stopReason: 'end_turn' });
  w.exit(pending.attempt.id, 0);
  assert.equal(w.job(pending.job.id).outcome, 'no_change');
  const good = await w.running({ sessionId: empty.session.id });
  w.registerVersion(good.job.id, good.session.id, 'a real change');
  w.ev(good.attempt.id, { t: 'run.completed', at: w.clock.t, stopReason: 'end_turn' });
  w.exit(good.attempt.id, 0);
  assert.equal(w.job(good.job.id).state, 'completed');
});

test('B3 request_changes never depends on the runtime, the consent, the budget or the rate: the review is recorded and the turn waits, then runs', async () => {
  const w = await turnWorld();
  const r = await w.running();
  const v = w.registerVersion(r.job.id, r.session.id);
  w.nx.artifacts.finalize(w.sys, v.versionId, 'candidate');
  w.ev(r.attempt.id, { t: 'run.completed', at: w.clock.t, stopReason: 'end_turn' });
  w.exit(r.attempt.id, 0);
  // Five quiet minutes: the cached runtime health is stale. Consent revoked as well.
  w.health.current = null;
  w.nx.budget.revoke(w.me);
  const res = w.nx.reviews.decide(w.me, v.versionId, { decision: 'request_changes', comment: 'please rename the helper', intentId: ulid() });
  assert.ok(res.job && res.job.id, 'the review was recorded and a turn was queued');
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM reviews').get().n, 1);
  assert.equal(w.job(res.job.id).state, 'queued');
  w.tick(); await sleep(15); w.tick();
  assert.equal(w.job(res.job.id).phase, 'waiting:runtime');
  w.health.current = HEALTH_OK;
  w.tick(); await sleep(15); w.tick();
  assert.equal(w.job(res.job.id).phase, 'waiting:consent');
  w.nx.budget.grant(w.me, { runtimeKind: 'scripted', hosts: HOSTS });
  const { attempt } = await w.lease(res.job.id);
  assert.equal(attempt.state, 'starting');
  // An exhausted day and an exhausted hour do not lose the review either (the turn waits).
  const w2 = await turnWorld({ caps: { turnsPerHour: 1, dayUsdCents: 200, turnUsdCents: 200 } });
  const a = await w2.running();
  const va = w2.registerVersion(a.job.id, a.session.id);
  w2.nx.artifacts.finalize(w2.sys, va.versionId, 'candidate');
  w2.usage(a.attempt.id, { costUsdCents: 200 });
  assert.equal(w2.job(a.job.id).outcome, 'limit');
  assert.throws(() => w2.start({ sessionId: a.session.id }), (e) => e.detail.reason === 'budget_exhausted');
  const res2 = w2.nx.reviews.decide(w2.me, va.versionId, { decision: 'request_changes', comment: 'again', intentId: ulid() });
  assert.ok(res2.job.id);
  w2.tick(); await sleep(15); w2.tick();
  assert.equal(w2.job(res2.job.id).phase, 'waiting:budget');
});

test('B3 a turn held by waiting:runtime asks for a fresh probe once, at most every 30 s; nothing is probed with nothing queued or with agents off', async () => {
  const w = await turnWorld();
  const flagged = () => w.runner.sentOf('probe').filter((m) => m.runtimes === true).length;
  // Nothing queued: ticks over ten minutes ask for nothing.
  w.health.current = null;
  w.run(10 * 60_000);
  assert.equal(flagged(), 0);
  // Queued while the health is fine, then it goes stale: the held turn asks, once, and again only after the pause.
  w.health.current = HEALTH_OK;
  const q = w.start();
  w.health.current = null;
  w.tick(); await sleep(15);
  w.run(25_000);
  assert.equal(w.job(q.job.id).phase, 'waiting:runtime');
  assert.equal(flagged(), 1, 'asked once');
  w.run(10_000);
  assert.equal(flagged(), 2, 'asked again after 30 s');
  w.health.current = HEALTH_OK;
  await w.lease(q.job.id);
  w.run(120_000);
  assert.equal(flagged(), 2, 'a healthy runtime is never probed on a timer');
  // Agents off: there is no agent service and no probe to ask.
  const off = agentWorld({ agents: false });
  assert.equal(off.nx.agents, null); assert.equal(off.nx.agentProbe, null);
  off.nx.exec.tick(off.clock.t);
});

test('B3 the scheduler never turns a stuck runtime into a timer: no probe without a live consent, at most three in a row, a user trigger gives them back', async () => {
  const w = await turnWorld();
  const flagged = () => w.runner.sentOf('probe').filter((m) => m.runtimes === true).length;
  const q = w.start();
  // A CLI that is signed out: the runtime never turns ok, the turn stays queued for ever.
  w.health.current = { kind: 'scripted', health: { ok: false, reason: 'not_authenticated', detail: 'x' } };
  w.tick(); await sleep(15);
  w.run(10 * 60_000);
  assert.equal(w.job(q.job.id).phase, 'waiting:runtime');
  assert.equal(flagged(), 3, 'three refreshes, then none: not one every 30 s');
  // A user trigger (the setup sheet, Check again, a consent change, a start) gives the scheduler its refreshes back.
  assert.equal(w.nx.agentProbe.refresh(), true);
  assert.equal(flagged(), 4);
  w.run(10 * 60_000);
  assert.equal(flagged(), 7, 'the three it gets back, and no more');
  // A new start is a trigger too.
  const other = await turnWorld();
  other.start();
  other.health.current = null;
  other.tick(); await sleep(15);
  other.run(10 * 60_000);
  const n = other.runner.sentOf('probe').filter((m) => m.runtimes === true).length;
  assert.equal(n, 3);
  other.health.current = HEALTH_OK;
  other.start({ sessionId: null });
  other.health.current = null;
  other.run(10 * 60_000);
  assert.ok(other.runner.sentOf('probe').filter((m) => m.runtimes === true).length > n, 'a start gave the refreshes back');
  // No live consent: the turn waits for consent and the user's CLI is never asked for.
  const nc = await turnWorld();
  nc.start();
  nc.nx.budget.revoke(nc.me);
  nc.health.current = null;
  nc.tick(); await sleep(15);
  nc.run(10 * 60_000);
  assert.equal(nc.runner.sentOf('probe').filter((m) => m.runtimes === true).length, 0);
  // Agents off: nothing to ask.
  const off = agentWorld({ agents: false });
  assert.equal(off.nx.agentProbe, null);
});

test('B4 an attempt that never reached the runtime costs nothing and does not count toward the rate; one that started without a cost is charged the turn cap', async () => {
  const w = await turnWorld({ caps: { turnsPerHour: 3 } });
  // Seven turns each refused by the runner before anything ran: no spend, no rate.
  for (let i = 0; i < 7; i++) {
    const r = w.start();
    const { attempt } = await w.lease(r.job.id);
    w.runner.report({ op: 'attempt.refused', attemptId: attempt.id, reason: 'bad_plan', detail: 'x' });
    assert.equal(w.job(r.job.id).state, 'failed');
  }
  assert.equal(w.nx.budget.usageToday().usdCents, 0, 'refused attempts cost nothing');
  assert.equal(w.nx.budget.startGuard(PROJECT).ok, true, 'and do not count toward the hourly rate');
  // A preflight that failed, an attempt cancelled while provisioning, an abandoned (requeued) one, an unsent start.
  const pf = w.start(); const a1 = await w.lease(pf.job.id);
  w.runner.report({ op: 'attempt.provisioned', attemptId: a1.attempt.id, containerId: 'c'.repeat(64), imageDigest: IMAGE, preflight: { ...passingPreflight(), ok: false, problems: ['a mount is wrong'] } });
  assert.equal(w.attemptOf(a1.attempt.id).state, 'failed');
  const cp = w.start(); const a2 = await w.lease(cp.job.id);
  w.nx.agents.cancel(w.me, cp.session.id);
  assert.equal(w.attemptOf(a2.attempt.id).state, 'cancelled');
  const dk = w.start(); const a3 = await w.lease(dk.job.id);
  w.runner.report({ op: 'attempt.refused', attemptId: a3.attempt.id, reason: 'docker_stopped', detail: 'x' });
  assert.equal(w.attemptOf(a3.attempt.id).state, 'abandoned');
  assert.equal(w.nx.budget.usageToday().usdCents, 0);
  const g = w.nx.budget.startGuard(PROJECT);
  assert.ok(g.ok || g.reason === 'busy', 'only the requeued turn itself (busy) is in the way: no budget, no rate');
  // An attempt that started, ran and reported no cost is charged the cap, as an estimate.
  const run = await w.running();
  w.ev(run.attempt.id, { t: 'run.failed', at: w.clock.t, code: 'runtime_error', message: 'x' });
  w.exit(run.attempt.id, 1);
  const u = w.nx.budget.usageToday();
  assert.equal(u.usdCents, 200); assert.equal(u.estimated, true);
});

test('A2 one limit bounds everything a turn creates: its child jobs of every kind (the system collects too) and its requirement drafts', async () => {
  const call = (w, r, tool, args, id) => w.nx.mcpGateway.call({ op: 'mcp.call', callId: id, bearer: r.plan.runtime.token, tool, args });
  const w = await turnWorld();
  const r = await w.running();
  // Twenty system collect children (an agent registering change sets with fresh client keys): the next creating call of any kind is refused.
  for (let i = 0; i < 20; i++) w.registerVersion(r.job.id, r.session.id, `c${i}`, { validators: [] });
  for (const [tool, args] of [['job_request', { recipeId: 'sde.test.discover', inputs: [w.repoVersion] }],
    ['changeset_register', { title: 't', summary: 's', clientKey: 'k21' }],
    ['requirement_draft', { title: 'one more', criteria: [{ id: 'C1', text: 'x' }], clientKey: 'k22' }]]) {
    const x = await call(w, r, tool, args, `a-${tool}`);
    assert.equal(x.ok, false, tool); assert.equal(x.code, 'limit', tool);
  }
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE parent_job_id = ?').get(r.job.id).n, 20, 'no job was created past the limit');
  // Requirement drafts count toward it too.
  const w2 = await turnWorld();
  const r2 = await w2.running();
  for (let i = 0; i < 20; i++) {
    const x = await call(w2, r2, 'requirement_draft', { title: `draft number ${i}`, criteria: [{ id: 'C1', text: `criterion ${i}` }], clientKey: `d${i}` }, `d-${i}`);
    assert.equal(x.ok, true, JSON.stringify(x));
  }
  const over = await call(w2, r2, 'requirement_draft', { title: 'draft number 21', criteria: [{ id: 'C1', text: 'criterion 21' }], clientKey: 'd21' }, 'd-21');
  assert.equal(over.code, 'limit');
  // Reading is not creating: it is never refused by this limit.
  assert.equal((await call(w2, r2, 'context_get', {}, 'ctx')).ok, true);
});

test('A3 revoking the permission ends every live turn (cancel path, reason consent_revoked); the gateway cap is the turn\'s own, never the live consent', async () => {
  const w = await turnWorld({ caps: { toolCalls: 3 } });
  const r = await w.running();
  const queued = w.start({ message: 'waits behind it' });
  assert.equal(w.nx.agents.revokeConsent(w.me), true);
  const j = w.job(r.job.id);
  assert.equal(j.state, 'cancelled'); assert.equal(JSON.parse(j.error_json).code, 'consent_revoked');
  assert.equal(w.attemptOf(r.attempt.id).state, 'cancelled'); assert.equal(tokenCode(w, r.plan), 'revoked');
  assert.ok(w.runner.sentOf('attempt.cancel').some((m) => m.attemptId === r.attempt.id), 'the runner is told to stop it (CLI, proxy, container)');
  assert.equal(w.nx.budget.live(), null);
  assert.equal(w.job(queued.job.id).state, 'queued', 'a queued turn is held by the consent guard, not cancelled');
  w.tick(); await sleep(15); w.tick();
  assert.equal(w.job(queued.job.id).phase, 'waiting:consent');
  // The turn's tool-call cap comes from its attempt: revoking the consent directly (the ceilings are the fallback) does not raise it.
  const w2 = await turnWorld({ caps: { toolCalls: 3 } });
  const r2 = await w2.running();
  w2.nx.budget.revoke(w2.me);
  const calls = [];
  for (let i = 0; i < 4; i++) calls.push(await w2.nx.mcpGateway.call({ op: 'mcp.call', callId: `t${i}`, bearer: r2.plan.runtime.token, tool: 'context_get', args: {} }));
  assert.deepEqual(calls.map((c) => c.ok), [true, true, true, false]);
  assert.equal(calls[3].code, 'limit');
});

test('a turn ended by a cap cancels what it asked for (job_request children) and leaves the system children alone', async () => {
  const w = await turnWorld();
  const r = await w.running();
  const asked = await w.nx.mcpGateway.call({ op: 'mcp.call', callId: 'jr', bearer: r.plan.runtime.token, tool: 'job_request', args: { recipeId: 'sde.test.discover', inputs: [w.repoVersion] } });
  assert.equal(asked.ok, true, JSON.stringify(asked));
  const collect = w.registerVersion(r.job.id, r.session.id);
  w.usage(r.attempt.id, { inputTokens: 500_000 });
  assert.equal(w.job(r.job.id).outcome, 'limit');
  assert.equal(w.job(asked.value.jobId).state, 'cancelled', 'the turn\'s own request stopped with it');
  assert.equal(w.job(collect.childJobId).state, 'queued', 'the system collect keeps its place');
});

test('a turn that ends NATURALLY leaves what it asked for running; only a cap cancels it', async () => {
  const w = await turnWorld();
  const r = await w.running();
  const asked = await w.nx.mcpGateway.call({ op: 'mcp.call', callId: 'jr2', bearer: r.plan.runtime.token, tool: 'job_request', args: { recipeId: 'sde.test.discover', inputs: [w.repoVersion] } });
  assert.equal(asked.ok, true, JSON.stringify(asked));
  const collect = w.registerVersion(r.job.id, r.session.id);
  w.ev(r.attempt.id, { t: 'run.completed', at: w.clock.t, stopReason: 'end_turn' });
  w.exit(r.attempt.id, 0);
  assert.equal(w.job(r.job.id).state, 'completed');
  assert.equal(w.job(asked.value.jobId).state, 'queued', 'a natural end does not cancel what the turn asked for');
  assert.equal(w.job(collect.childJobId).state, 'queued');
  assert.equal(w.runner.sentOf('attempt.cancel').filter((m) => m.attemptId === r.attempt.id).length, 0);
});

test('a bare capability token in a tool argument is not kept in the call record', async () => {
  const w = await turnWorld();
  const r = await w.running();
  const token = r.plan.runtime.token;
  const x = await w.nx.mcpGateway.call({ op: 'mcp.call', callId: 'tk', bearer: token, tool: 'requirement_draft', args: { title: `note ${token}`, criteria: [{ id: 'C1', text: 'x' }], clientKey: 'tk1' } });
  void x;
  const rows = w.db.prepare("SELECT details_json FROM activity WHERE job_id = ? AND action = 'mcp.call'").all(r.job.id);
  assert.ok(rows.length >= 1);
  for (const row of rows) assert.ok(!row.details_json.includes(token) && !row.details_json.includes(token.split('.')[1]), row.details_json);
  for (const e of w.db.prepare('SELECT data_json, summary FROM job_events WHERE job_id = ?').all(r.job.id)) assert.ok(!(e.data_json + e.summary).includes(token));
});
