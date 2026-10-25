'use strict';
// B2b Task 4 (F21): the agent test fixture. Tasks 4-9 use it to get a running agent turn before Task 10's AgentService
// exists. Everything goes through the real services; nothing mocks authorization:
//   - agentWorld(o): a temp v9 database (the v6 fixture migrated by the store) with schema v10 in place (the store's own
//     v10 step when it has one and is enabled, else applyV10 on the v9 file, the way the v10 schema tests do), and the
//     platform composed with execution and agents on. No Docker, no runner process, no real userData.
//   - openRunningTurn(db, services, { project, repoPath? }) -> { session, job, claims, token, attempt, runner, user, system }:
//       1. the session-open transaction: SessionService.open and the session's agent principal (ensureAgentPrincipalTx);
//       2. an `agent.run` job created by the local user (JobService.create);
//       3. the lease transaction: queued -> leased, the attempt row, and the token minted inside it (TokenService.mintTx),
//          with a FakeRunner attached to the execution core (its `ready` goes through the platform's revocation hook);
//       4. the runner's provisioned report as the core would record it: attempt and job running, session running.
//     Until Task 10 adds the execution core's own agent lease, step 3 is performed here with the core's own transaction
//     helpers (JobService.transitionTx, insertAttemptTx, TokenService.mintTx); Task 10 switches it to the core's lease.
//   - endTurn(db, services, turn, { attempt, job, usage }): records the turn's usage (as Task 10's usage events will),
//     then ends the attempt and the job (the token stays as it is unless `revoke` is given).
const path = require('node:path');
const h = require('./sqlite.cjs');
const loadTs = require('../load-ts.cjs');
const { PersistStore } = loadTs('src/main/db.ts');
const { track } = require('./cleanup.cjs');
const { PROFILES } = require('./execWorld.cjs');
const { FakeRunner } = require('./fakeRunner.cjs');
const { createNexusPlatform } = loadTs('src/main/nexus/platform.ts');
const { applyV10, v10ShapeProblem } = loadTs('src/main/nexus/db/schemaV10.ts');
const { newId } = loadTs('src/main/nexus/db/ids.ts');
const { immediateTx } = loadTs('src/main/nexus/db/tx.ts');
const { ensureAgentPrincipalTx } = loadTs('src/main/nexus/auth/authService.ts');
const { insertAttemptTx, transitionAttemptTx, attemptRow } = loadTs('src/main/nexus/exec/attempts.ts');
const { resolveDataHome } = loadTs('src/main/nexusExec/dataHome.ts');
const { MCP_TOOLS } = loadTs('src/shared/nexus/mcpTools.ts');
const { getDomain } = loadTs('src/shared/nexus/domains/index.ts');

/** A temp world with schema v10 and the agent services composed. `o.platform` adds platform options. */
function agentWorld(o = {}) {
  const { file } = h.v6Fixture();
  const s = track(new PersistStore(file));
  s.open({ log: () => {}, backupDir: path.join(path.dirname(file), 'b'), now: () => h.NOW, enableV9: true, enableV10: true });
  const db = s.platformDatabase();
  if (v10ShapeProblem(db, true) !== null) {
    db.transaction(() => applyV10(db, { now: () => h.NOW, appVersion: 't', fromVersion: 9, preCounts: null, backup: null }))();
  }
  const clock = { t: h.NOW + 1000 };
  const logs = [];
  const nx = createNexusPlatform(db, { now: () => clock.t, log: (l) => logs.push(l), execution: true, agents: o.agents ?? true,
    dataHome: resolveDataHome(h.tmpDir('nx-agent-home-')), profiles: PROFILES, acceptFsRoot: (r) => (typeof r === 'string' && r ? r : null),
    approvals: null, ingest: null, ...(o.platform ?? {}) });
  return { s, db, nx, clock, logs, me: nx.principals.localUser(), sys: nx.principals.system(), advance(ms) { clock.t += ms; return clock.t; } };
}

const runners = new WeakMap();
let seq = 0;

/** The SDE ceiling, as a token's grant (the default of a fixture turn). */
const ceilingCaps = (workspaceId = 'sde') => (getDomain(workspaceId)?.capabilities ?? []).map((c) => (c.scope
  ? { id: c.id, scope: Object.fromEntries(Object.entries(c.scope).filter(([k]) => k !== 'note')) } : { id: c.id }));

function openRunningTurn(db, services, opts = {}) {
  const nx = services;
  if (!nx.tokens) throw new Error('openRunningTurn needs a platform with agents available');
  const project = opts.project ?? 'p-ledger';
  const workspaceId = opts.workspaceId ?? 'sde';
  const user = nx.principals.localUser();
  const system = nx.principals.system();
  let runner = runners.get(nx);
  if (!runner) { runner = new FakeRunner(); nx.exec.attachRunner(runner, nx.bootId); runners.set(nx, runner); }
  if (typeof opts.repoPath === 'string') db.prepare('UPDATE projects SET root_path = ? WHERE id = ?').run(opts.repoPath, project);
  const key = `agent-fixture-${++seq}-${Math.random().toString(36).slice(2)}`;
  // 1. The session-open transaction: the session and its agent principal.
  const session = immediateTx(db, () => {
    const r = nx.sessions.open(user, { projectId: project, workspaceId, idempotencyKey: `${key}-s` });
    ensureAgentPrincipalTx(db, r.session.id, nowOf(nx));
    return r.session;
  });
  // 2. The turn's job, requested by the user.
  const created = nx.jobs.create(user, { kind: 'agent.run', projectId: project, workspaceId, sessionId: session.id, idempotencyKey: `${key}-j`,
    params: {}, inputs: (opts.inputs ?? []).map((versionId) => ({ versionId, role: 'focus' })) }).job;
  // 3. The lease transaction: leased, the attempt, the token.
  let token = null; let attemptId = null;
  immediateTx(db, () => {
    const leased = nx.jobs.transitionTx(system, created.id, 'leased', undefined, { expectState: 'queued' });
    attemptId = newId(nowOf(nx));
    insertAttemptTx(db, { id: attemptId, jobId: created.id, projectId: project, n: leased.attempts, bootId: nx.bootId, now: nowOf(nx), logPath: null,
      sandbox: { kind: 'agent', network: 'none' }, environment: { runtimeKind: 'scripted' } });
    token = nx.tokens.mintTx(system, { jobId: created.id, sessionId: session.id, caps: opts.caps ?? ceilingCaps(workspaceId),
      inputs: opts.inputs ?? [], mcpTools: opts.mcpTools ?? MCP_TOOLS.map((t) => t.name), maxChildJobs: opts.maxChildJobs, ttlMs: opts.ttlMs });
  });
  // 4. Provisioned: the attempt and the job run, and so does the session.
  immediateTx(db, () => {
    transitionAttemptTx(db, attemptRow(db, attemptId), 'running', nowOf(nx), project);
    nx.jobs.transitionTx(system, created.id, 'running', undefined, { expectState: 'leased' });
    nx.sessions.transition(system, session.id, 'running');
  });
  const v = nx.tokens.verify(token);
  if (!v.ok) throw new Error(`the fixture token does not verify: ${v.code}`);
  return { session: nx.sessions.get(user, session.id), job: nx.jobs.get(user, created.id), claims: v.claims, token, attempt: attemptRow(db, attemptId),
    runner, user, system };
}

/** The platform clock (the services' own `now`). */
function nowOf(nx) { return nx.jobs.deps.now(); }

/**
 * Ends a fixture turn: records `usage` on its attempt first (null: none reported), then the attempt (`attempt`, default
 * 'succeeded') and the job (`job`, default 'completed'; 'cancelled' for a cancelled attempt).
 */
function endTurn(db, services, turn, o = {}) {
  const nx = services;
  const a = attemptRow(db, turn.attempt.id);
  const to = o.attempt ?? 'succeeded';
  const jobTo = o.job ?? (to === 'succeeded' ? 'completed' : to === 'cancelled' ? 'cancelled' : 'failed');
  immediateTx(db, () => {
    if (o.usage !== undefined && o.usage !== null) db.prepare('UPDATE job_attempts SET usage_json = ? WHERE id = ?').run(JSON.stringify(o.usage), a.id);
    const change = to === 'succeeded' ? { outcome: 'completed', exit: { code: 0, oomKilled: false } } : { outcome: to, error: { code: to, message: to } };
    transitionAttemptTx(db, attemptRow(db, a.id), to, nowOf(nx), turn.job.projectId, change);
    nx.jobs.transitionTx(turn.system, turn.job.id, jobTo, jobTo === 'failed' ? { error: { code: 'failed', message: 'failed' } } : undefined);
  });
  if (o.revoke) nx.tokens.revokeForJob(turn.system, turn.job.id, 'job_ended');
}

/** A usage record as the runtime reports it (AgentUsage). */
const usage = (costUsdCents, extra = {}) => ({ inputTokens: 10, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0, costUsdCents,
  toolCalls: 1, estimated: false, ...extra });

module.exports = { agentWorld, openRunningTurn, endTurn, usage, ceilingCaps };
