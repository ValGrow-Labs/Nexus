'use strict';
// B2a Task 10: restart recovery in two phases (constraint 10: restart while queued, provisioning, running, during tool
// execution, during validation and while waiting for approval) and the platform startup hand-off. Real SQLite
// (Electron-as-node, `npm run test:db`), the execution core driven through FakeRunners (no Docker, no runner process).
// A restart is what main does after a crash: a NEW platform (a new ExecutionService and boot id) on the same database,
// its startup (phase A), a fresh runner attached with the new boot id, then phase B with a scripted reconcile result.
// Every case asserts the decision AND that recovery alone completed nothing: no job reached completed and no version
// reached candidate between the restart and the first report the runner made after it; O1-O17 stay 0, the
// foreign_key_check is empty and the activity chain verifies.
// RC1-RC20 are the brief's cases; D1-D11 pin the carried decisions; S1-S2 the startup switch.
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
// B2a Task 10 fix round 3: every store and raw handle this file opens is closed, and its temp dirs removed, by one after hook.
const C = require('./helpers/cleanup.cjs'); C.cleanupAfterAll();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { execWorld, passingPreflight, PROFILES, FWD_PROFILE, GIB, junit } = require('./helpers/execWorld.cjs');
const { FakeRunner } = require('./helpers/fakeRunner.cjs');
const { ALL_ZERO, execOrphanRows } = require('./helpers/orphans.cjs');
const { verifyActivityChain } = loadTs('src/main/nexus/activity/writer.ts');
const { createNexusPlatform } = loadTs('src/main/nexus/platform.ts');
const { PersistStore: PersistStoreUntracked } = loadTs('src/main/db.ts');
/** Every store this file opens is tracked: the cleanup hook closes it even when a test fails before its own close(). */
class PersistStore extends PersistStoreUntracked { constructor(...a) { super(...a); C.track(this); } }
const { newId } = loadTs('src/main/nexus/db/ids.ts');
const { LEASE_MS, insertAttemptTx, transitionAttemptTx, attemptRow } = loadTs('src/main/nexus/exec/attempts.ts');
const R = loadTs('src/main/nexus/exec/recovery.ts');
const ACT = loadTs('src/renderer/src/nexus/project/activityModel.ts');
const { homeLabel } = loadTs('src/main/nexus/exec/planBuilder.ts');
/** The labels the runner puts on an attempt's resources, as planBuilder plans them (fix round 1: with `nexus.home`). */
const labelsOf = (w, attemptId, jobId, extra = {}) => ({ 'nexus.job': jobId, 'nexus.attempt': attemptId, 'nexus.boot': w.bootId,
  'nexus.project': 'p-ledger', 'nexus.home': homeLabel(w.dataHome.root), ...extra });

const MIN = 60_000;
const LOCK = '3f'.repeat(32);
const CTX = { contextSha256: 'c4'.repeat(32), baseDigest: 'sha256:' + 'b5'.repeat(32), estimatedBytes: 3 * GIB };
const MANIFEST = { version: 1, profile: 'sde-node', run: ['node', 'dist/server.js'], port: 3000, healthPath: '/health', env: [] };
const code = (c, reason) => (e) => e.code === c && (reason === undefined || e.detail?.reason === reason);
const ACT_CTX = { names: new Map(), versionNos: new Map(), workspaceLabel: (x) => x, now: h.NOW };
// B2a final review C1: the view comes from the real IPC mapping (writer.toEntry, then dto.activityView), so a detail
// key the DTO drops is dropped here too and the sentence reads what the renderer really receives.
const ACT_DTO = loadTs('src/main/nexusIpc/dto.ts');
const { toEntry: actEntry } = loadTs('src/main/nexus/activity/writer.ts');
const actView = (r) => ACT_DTO.activityView(actEntry(r));

function healthy(w) {
  assert.deepEqual(w.orphans(), ALL_ZERO, JSON.stringify(execOrphanRows(w.db)));
  assert.deepEqual(w.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(verifyActivityChain(w.db).ok, true);
}
/** What counts as finished work: completed or partial jobs, candidate or active versions. Recovery alone never adds one. */
function completions(w) {
  return {
    jobs: w.db.prepare("SELECT id FROM jobs WHERE state IN ('completed','partial') ORDER BY id").all().map((r) => r.id),
    versions: w.db.prepare("SELECT id FROM artifact_versions WHERE status IN ('candidate','active') ORDER BY id").all().map((r) => r.id)
  };
}
const recoverActs = (w, jobId) => w.db.prepare(`SELECT * FROM activity WHERE action = 'exec.recover'${jobId ? ' AND job_id = ?' : ''} ORDER BY seq`)
  .all(...(jobId ? [jobId] : []));
const recoveryEvents = (w, jobId) => w.db.prepare(`SELECT * FROM job_events WHERE type = 'recovery'${jobId ? ' AND job_id = ?' : ''} ORDER BY seq`)
  .all(...(jobId ? [jobId] : []));
const decisionOf = (row) => JSON.parse(row.details_json ?? row.data_json).decision;
const count = (w, sql, ...a) => w.db.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get(...a).n;

/**
 * A restart: a new platform on the same database (a new ExecutionService and boot id), its startup (phase A), then a
 * fresh runner attached with the new boot id and its first probe. `o.approvals: 'real'` uses the platform's own
 * ApprovalService as the egress port (as execWorld does).
 */
function restart(w, o = {}) {
  const logs = [];
  const nx = createNexusPlatform(w.db, { now: () => w.now(), log: (l) => logs.push(l), execution: o.execution ?? true,
    dataHome: o.dataHome ?? w.dataHome, profiles: o.fwd ? [...PROFILES, FWD_PROFILE] : PROFILES, acceptFsRoot: (r) => r,
    approvals: o.approvals === 'real' ? undefined : null, imageContexts: o.imageContexts ?? null, executionUnavailableReason: o.unavailableReason });
  const sys = nx.principals.system();
  const report = o.skipStartup ? null : nx.startup();
  const runner = new FakeRunner();
  if (!o.noRunner && nx.executionAvailable) { nx.exec.attachRunner(runner, nx.bootId); runner.report(w.probeMsg()); }
  return { nx, exec: nx.exec, sys, logs, report, runner };
}
/** Waits for every asynchronous ingest and check of a restarted platform, then runs what became ready. */
async function settle(w, t) {
  for (let i = 0; i < 20; i++) {
    await t.exec.settled();
    if (t.nx.validation) await t.nx.validation.settled();
    await new Promise((res) => setImmediate(res));
    if (t.nx.validation) t.nx.validation.runPending(w.now());
  }
}
const rec = (attempts = [], labelled = [], docker = 'running') => ({ docker, attempts, labelled });
/** One reconcile entry for an attempt, as the runner reports it (its recorded container id when it has one). */
function entry(w, attemptId, container, extra = {}) {
  const a = w.attempt(attemptId);
  return { attemptId, container, ...(a.container_id ? { containerId: a.container_id } : {}), ...extra };
}
const exitAt = (w, c = 0, oom = false) => ({ code: c, oomKilled: oom, finishedAt: w.now() });
const reportExit = (w, runner, attemptId, outputs, parsed = [], c = 0) =>
  runner.report({ op: 'attempt.exited', attemptId, exit: exitAt(w, c), outputs, parsed, logBytes: 100 });
const provisionVia = (w, runner, jobId, c) => {
  const a = w.liveAttempt(jobId);
  runner.report({ op: 'attempt.provisioned', attemptId: a.id, containerId: c.repeat(64), imageDigest: w.IMAGE['sde-node'], preflight: passingPreflight() });
  return w.attempt(a.id);
};
/** A job started and provisioned in the first world (its container recorded). */
function provisioned(w, r, actionId, c) {
  const j = w.exec.start(w.me, w.req(actionId)).job;
  w.exec.tick(w.now());
  return { job: j, attempt: provisionVia(w, r, j.id, c) };
}
const discoveryOutputs = (w, files = ['test/a.test.js']) => {
  const ids = w.file('ids.txt', files.join('\n'));
  return { outputs: [ids], parsed: [{ parser: 'discovery', sourceSha256: ids.sha256, normalized: { framework: 'node-test', ids: files, files } }] };
};
const junitOutputs = (w, cases = [{ name: 'ok' }]) => {
  const J = junit(cases);
  const jf = w.file('junit.xml', JSON.stringify(J));
  return { outputs: [jf], parsed: [{ parser: 'junit', sourceSha256: jf.sha256, normalized: { sha256: jf.sha256, ...J } }] };
};
const suiteOf = (w, discoveryJobId) => w.db.prepare("SELECT id FROM artifact_versions WHERE produced_by_job_id = ? AND output_path = 'ids.txt'").get(discoveryJobId)?.id ?? null;
const testCheckOf = (w, discoveryJobId) => w.db.prepare("SELECT * FROM jobs WHERE kind = 'validate' AND validator_id = 'sde.tests_pass' AND parent_job_id = ? ORDER BY rowid DESC")
  .get(discoveryJobId);

// ---------- dev deployments (as in the Task 9 tests) ----------

async function appDraft(w) {
  const b = await w.runBuild({ files: [{ path: 'server.js', content: 'server a' }], exit: 0 });
  w.answerVerifies(w.attach(), true); await w.settle();
  const runner = w.attach();
  const job = w.exec.start(w.me, w.req('sde.app.assemble', { inputs: [{ versionId: b.buildVersionId, slot: 'build' }] })).job;
  w.exec.tick(w.now()); w.provisionEngine(runner, job.id);
  w.exitWith(runner, job.id, { code: 0, parsed: [{ parser: 'app-manifest', sourceSha256: 'd'.repeat(64), normalized: { manifest: MANIFEST } }] });
  await w.settle();
  return w.db.prepare('SELECT id FROM artifact_versions WHERE produced_by_job_id = ?').get(job.id).id;
}
function probe(w, runner, exec, attemptId, status) {
  w.advance(5_000);
  runner.report({ op: 'attempt.heartbeat', attemptId, at: w.now(), logBytes: 0, outBytes: 0, container: 'running' });
  runner.report({ op: 'service.health', attemptId, at: w.now(), status, ms: 4, container: 'running' });
  exec.tick(w.now());
}
/** A healthy dev deployment in the first world. */
async function deployed(w, port = 49200) {
  const app = await appDraft(w);
  const r = w.attach();
  const j = w.exec.start(w.me, w.req('sde.preview.start', { inputs: [{ versionId: app, slot: 'application' }] })).job;
  w.exec.tick(w.now());
  const a = w.liveAttempt(j.id);
  r.report({ op: 'attempt.provisioned', attemptId: a.id, containerId: 'e'.repeat(64), imageDigest: w.IMAGE['sde-node'], preflight: passingPreflight(), hostPort: port });
  probe(w, r, w.exec, a.id, 200);
  return { app, job: j, attempt: w.attempt(a.id) };
}
const dep = (w, jobId) => w.db.prepare('SELECT * FROM deployments WHERE job_id = ?').get(jobId);
const serviceWorld = () => execWorld({ realIngest: true, fwd: true, dockerMemoryBytes: 64 * GIB });
const egressWorld = (o = {}) => execWorld({ approvals: 'real', realIngest: true, repoMeta: { lockfile: { sha256: LOCK } }, dockerMemoryBytes: 64 * GIB, ...o });
const approvalOf = (w, jobId) => w.db.prepare('SELECT * FROM approvals WHERE job_id = ? ORDER BY requested_at DESC, rowid DESC').get(jobId);

// ---------- S: the startup hand-off ----------

test('S1 at v9 startup runs phase A, never jobs.recoverAfterRestart; the ready line keeps its format and the execution line follows', () => {
  const w = execWorld({ realIngest: true });
  const t = restart(w, { skipStartup: true, noRunner: true });
  let called = 0;
  t.nx.jobs.recoverAfterRestart = () => { called++; throw new Error('B1 recovery must not run at v9'); };
  const report = t.nx.startup();
  assert.equal(called, 0);
  assert.deepEqual(report.jobs, { interrupted: 0, requeued: 0 });
  assert.equal(report.execution.held, false);
  const ready = t.logs.findIndex((l) => l.startsWith('[nexus] platform ready:'));
  assert.equal(t.logs[ready], '[nexus] platform ready: principals ok, workspaces added=0, primaries set=0 cleared=0, sessions interrupted=0, jobs interrupted=0 requeued=0');
  assert.equal(t.logs[ready + 1], '[nexus] execution recovery: adopted=0 finalized=0 requeued=0 interrupted=0 expired=0 pending=0');
  // Recovery is system only: a user is denied (and audited), nothing else happens.
  assert.throws(() => t.exec.recoverPhaseA(w.me, t.nx.bootId), code('denied'));
  assert.throws(() => t.exec.recoverPhaseB(w.me, t.nx.bootId, rec()), code('denied'));
  assert.throws(() => t.exec.recoverPhaseA(t.sys, 'not-a-ulid'), code('invalid'));
  healthy(w); w.close();
});

test('S2 at v7/v8 startup runs B1 recovery and never phase A; no execution line and no execution key in the report', () => {
  const { file } = h.v6Fixture();
  const s = new PersistStore(file); s.open({ log: () => {}, backupDir: path.join(path.dirname(file), 'b'), now: () => h.NOW });
  assert.equal(s.schemaVersion, 8);
  const logs = [];
  const nx = createNexusPlatform(s.platformDatabase(), { now: () => h.NOW, log: (l) => logs.push(l) });
  let called = 0;
  nx.exec.recoverPhaseA = () => { called++; throw new Error('phase A must not run below v9'); };
  const r = nx.startup();
  assert.equal(called, 0);
  assert.deepEqual(Object.keys(r).sort(), ['catalogAdded', 'jobs', 'primaries', 'sessions']);
  assert.equal(logs.filter((l) => l.includes('execution recovery')).length, 0);
  assert.ok(logs.some((l) => l === '[nexus] platform ready: principals ok, workspaces added=0, primaries set=0 cleared=0, sessions interrupted=0, jobs interrupted=0 requeued=0'));
  s.close();
});

// ---------- RC1-RC20 ----------

test('RC1 queued: still queued after the restart (phase A writes nothing); it leases normally afterwards, owned by the new boot', () => {
  const w = execWorld({ realIngest: true });                    // no runner: the job waits (waiting:runner)
  const j = w.exec.start(w.me, w.req('sde.build.run')).job; w.exec.tick(w.now());
  assert.equal(w.jobState(j.id), 'queued');
  const before = count(w, 'job_events');
  const t = restart(w);
  assert.equal(w.jobState(j.id), 'queued'); assert.equal(w.attempts(j.id).length, 0);
  assert.equal(count(w, 'job_events'), before); assert.equal(recoverActs(w).length, 0);
  assert.deepEqual(t.report.execution, { held: false, requeued: 0, interrupted: 0, expired: 0, pending: 0, jobs: { interrupted: 0, requeued: 0 }, decisions: 0, errors: 0 });
  t.exec.tick(w.now());
  const a = w.liveAttempt(j.id);
  assert.equal(w.jobState(j.id), 'leased'); assert.equal(a.n, 1); assert.equal(a.lease_owner, t.nx.bootId);
  assert.equal(t.runner.lastStart().attemptId, a.id);
  healthy(w); w.close();
});

test('RC2 provisioning (leased, attempt starting, no container): attempt abandoned, job queued, the next lease is n = 2', () => {
  const w = execWorld({ realIngest: true }); w.attach();
  const j = w.exec.start(w.me, w.req('sde.build.run')).job; w.exec.tick(w.now());
  const a1 = w.liveAttempt(j.id);
  assert.equal(w.jobState(j.id), 'leased'); assert.equal(a1.state, 'starting'); assert.equal(a1.container_id, null);
  const c0 = completions(w);
  const t = restart(w);
  assert.equal(w.attempt(a1.id).state, 'abandoned'); assert.equal(w.attempt(a1.id).outcome, 'never_started');
  assert.equal(w.jobState(j.id), 'queued'); assert.equal(w.job(j.id).attempts, 1); assert.equal(w.job(j.id).phase, null);
  assert.equal(t.report.execution.requeued, 1); assert.deepEqual(t.report.jobs, { interrupted: 0, requeued: 1 });
  assert.equal(t.logs.find((l) => l.startsWith('[nexus] execution recovery:')), '[nexus] execution recovery: adopted=0 finalized=0 requeued=1 interrupted=0 expired=0 pending=0');
  // One decision: one exec.recover row and one recovery event.
  assert.deepEqual(recoverActs(w, j.id).map(decisionOf), ['requeue']);
  assert.deepEqual(recoveryEvents(w, j.id).map(decisionOf), ['requeue']);
  assert.deepEqual(completions(w), c0);
  t.exec.tick(w.now());
  const a2 = w.liveAttempt(j.id);
  assert.equal(a2.n, 2); assert.equal(w.job(j.id).attempts, 2); assert.equal(a2.lease_owner, t.nx.bootId);
  assert.equal(t.runner.lastStart().plan.attemptN, 2);
  healthy(w); w.close();
});

test('RC3 provisioning, container created but never started: the job is queued again and the runner is told to remove the container', () => {
  // (a) The provisioned report never reached main: the attempt is starting with no container recorded.
  const w = execWorld({ realIngest: true }); w.attach();
  const j = w.exec.start(w.me, w.req('sde.build.run')).job; w.exec.tick(w.now());
  const a1 = w.liveAttempt(j.id);
  const c0 = completions(w);
  const t = restart(w);
  assert.equal(w.attempt(a1.id).state, 'abandoned'); assert.equal(w.jobState(j.id), 'queued');
  const created = { kind: 'container', id: 'c'.repeat(64), labels: labelsOf(w, a1.id, j.id, { 'nexus.kind': 'tool' }) };
  const b = t.exec.recoverPhaseB(t.sys, t.nx.bootId, rec([{ attemptId: a1.id, container: 'created', containerId: 'c'.repeat(64) }], [created]));
  assert.deepEqual(b.remove, [{ kind: 'container', id: 'c'.repeat(64), reason: 'attempt_ended' }], 'the runner is told to remove it');
  assert.equal(w.jobState(j.id), 'queued'); assert.equal(w.attempt(a1.id).state, 'abandoned');
  assert.deepEqual(completions(w), c0);
  healthy(w); w.close();
  // (b) The container was recorded (preflight passed) but never started: removed, the attempt abandoned, the job waits
  // again through retry_scheduled (the v7 table has no running -> queued) and is queued when its backoff is due.
  const w2 = execWorld({ realIngest: true }); const r2 = w2.attach();
  const d = provisioned(w2, r2, 'sde.tests.discover', 'a');
  const t2 = restart(w2);
  assert.equal(t2.report.execution.pending, 1);
  const b2 = t2.exec.recoverPhaseB(t2.sys, t2.nx.bootId, rec([entry(w2, d.attempt.id, 'created')]));
  assert.equal(w2.attempt(d.attempt.id).state, 'abandoned'); assert.equal(w2.attempt(d.attempt.id).outcome, 'container_created');
  assert.equal(w2.jobState(d.job.id), 'retry_scheduled'); assert.equal(b2.requeued, 1);
  assert.ok(t2.runner.sentOf('attempt.release').some((m) => m.attemptId === d.attempt.id), 'the runner is told to remove the created container');
  w2.advance(10_000); t2.exec.tick(w2.now());
  assert.equal(w2.liveAttempt(d.job.id).n, 2, 'queued again, then leased as attempt 2');
  healthy(w2); w2.close();
});

test('RC4 running (tool execution), container running: attempt.adopt sent, the new boot owns the lease, heartbeats are accepted, a later exit ingests and completes', async () => {
  const w = execWorld({ realIngest: true }); const r = w.attach();
  const { job, attempt } = provisioned(w, r, 'sde.build.run', 'd');
  const c0 = completions(w);
  const t = restart(w);
  assert.equal(t.report.execution.pending, 1); assert.equal(w.attempt(attempt.id).lease_owner, w.bootId, 'phase A leaves a recorded container to phase B');
  // Before adoption, a report about the attempt is another boot's: dropped, nothing written.
  t.runner.report({ op: 'attempt.heartbeat', attemptId: attempt.id, at: w.now(), logBytes: 1, outBytes: 0, container: 'running' });
  t.exec.tick(w.now());
  assert.equal(w.attempt(attempt.id).heartbeat_at, null);
  assert.ok(t.logs.some((l) => /dropped runner message attempt\.heartbeat: attempt owned by another boot/.test(l)));
  const b = t.exec.recoverPhaseB(t.sys, t.nx.bootId, rec([entry(w, attempt.id, 'running')]));
  assert.equal(b.adopted, 1);
  const a = w.attempt(attempt.id);
  assert.equal(a.state, 'running'); assert.equal(a.lease_owner, t.nx.bootId); assert.equal(a.boot_id, w.bootId, 'the creating boot is immutable');
  assert.equal(a.lease_expires_at, w.now() + LEASE_MS);
  const adopt = t.runner.sentOf('attempt.adopt');
  assert.equal(adopt.length, 1); assert.equal(adopt[0].attemptId, attempt.id); assert.equal(adopt[0].containerId, 'd'.repeat(64));
  assert.equal(adopt[0].logPath, path.join(w.dataHome.root, 'logs', 'jobs', job.id, '1.log'));
  assert.deepEqual(recoverActs(w, job.id).map(decisionOf), ['adopt']); assert.deepEqual(recoveryEvents(w, job.id).map(decisionOf), ['adopt']);
  assert.deepEqual(completions(w), c0, 'adoption completes nothing');
  w.advance(30_000);
  t.runner.report({ op: 'attempt.heartbeat', attemptId: attempt.id, at: w.now(), logBytes: 7, outBytes: 0, container: 'running' });
  t.exec.tick(w.now());
  assert.equal(w.attempt(attempt.id).heartbeat_at, w.now()); assert.equal(w.attempt(attempt.id).log_bytes, 7);
  reportExit(w, t.runner, attempt.id, [w.file('dist/app.js', 'built')]);
  await settle(w, t);
  assert.equal(w.jobState(job.id), 'completed'); assert.equal(w.attempt(attempt.id).state, 'succeeded');
  assert.equal(count(w, 'artifact_versions WHERE produced_by_job_id = ?', job.id), 1);
  assert.equal(count(w, 'version_attempts WHERE job_id = ? AND attempt_n = 1', job.id), 1);
  healthy(w); w.close();
});

test('RC5 running (tool execution), container exited 0 with staged outputs: finalized from inspect, ingested once, validators queued; the suite is a candidate only after sde.tests_pass passes', async () => {
  const w = execWorld({ realIngest: true }); const r = w.attach();
  const d = provisioned(w, r, 'sde.tests.discover', 'a');
  const c0 = completions(w);
  const t = restart(w);
  const out = discoveryOutputs(w);
  const b = t.exec.recoverPhaseB(t.sys, t.nx.bootId, rec([entry(w, d.attempt.id, 'exited', { exit: exitAt(w), staged: out.outputs })]));
  assert.equal(b.finalized, 1);
  assert.equal(w.attempt(d.attempt.id).state, 'running'); assert.equal(w.attempt(d.attempt.id).lease_owner, t.nx.bootId);
  assert.equal(w.job(d.job.id).phase, 'collecting');
  assert.equal(t.runner.sentOf('attempt.adopt').length, 1, 'the runner re-hashes /out and reports the exit again');
  assert.equal(suiteOf(w, d.job.id), null, 'nothing is ingested from the reconcile answer alone');
  assert.deepEqual(completions(w), c0);
  assert.deepEqual(recoverActs(w, d.job.id).map(decisionOf), ['finalize']);
  // The runner's re-reported exit is ingested like a live one (twice reported: ingested once).
  reportExit(w, t.runner, d.attempt.id, out.outputs, out.parsed);
  reportExit(w, t.runner, d.attempt.id, out.outputs, out.parsed);
  await settle(w, t);
  assert.equal(w.jobState(d.job.id), 'completed');
  const suite = suiteOf(w, d.job.id);
  assert.equal(count(w, 'artifact_versions WHERE produced_by_job_id = ?', d.job.id), 1);
  assert.equal(w.version(suite).status, 'draft');
  const tj = testCheckOf(w, d.job.id);
  assert.equal(tj.state, 'queued', 'the suite\'s candidate check is queued');
  t.exec.tick(w.now());
  const ta = provisionVia(w, t.runner, tj.id, 'b');
  assert.equal(w.version(suite).status, 'draft');
  const jo = junitOutputs(w);
  reportExit(w, t.runner, ta.id, jo.outputs, jo.parsed);
  await settle(w, t);
  assert.equal(w.latest(suite, 'sde.tests_pass').status, 'passed'); assert.equal(w.version(suite).status, 'candidate');
  healthy(w); w.close();
});

test('RC6 running (tool execution), container exited 0 without its contract outputs: failed invalid_output, released, nothing candidate', async () => {
  const w = execWorld({ realIngest: true }); const r = w.attach();
  const d = provisioned(w, r, 'sde.tests.discover', 'a');
  const c0 = completions(w);
  const t = restart(w);
  const b = t.exec.recoverPhaseB(t.sys, t.nx.bootId, rec([entry(w, d.attempt.id, 'exited', { exit: exitAt(w), staged: [] })]));
  assert.equal(b.finalized, 1);
  const a = w.attempt(d.attempt.id);
  assert.equal(a.state, 'failed'); assert.equal(a.outcome, 'invalid_output'); assert.equal(JSON.parse(a.error_json).code, 'outputs_missing');
  assert.equal(a.exit_code, 0);
  assert.equal(w.jobState(d.job.id), 'failed'); assert.equal(w.job(d.job.id).outcome, 'invalid_output', 'never retried');
  assert.ok(t.runner.sentOf('attempt.release').some((m) => m.attemptId === d.attempt.id));
  assert.deepEqual(recoverActs(w, d.job.id).map(decisionOf), ['fail']);
  // A late re-report of that exit changes nothing.
  reportExit(w, t.runner, d.attempt.id, [], []);
  await settle(w, t);
  assert.equal(w.jobState(d.job.id), 'failed'); assert.equal(suiteOf(w, d.job.id), null);
  assert.deepEqual(completions(w), c0);
  healthy(w); w.close();
});

test('RC7 running (tool execution), container missing: attempt abandoned; an idempotent recipe is retry_scheduled, a non-idempotent one interrupted', () => {
  const w = execWorld({ realIngest: true }); const r = w.attach();
  const d = provisioned(w, r, 'sde.tests.discover', 'a');          // idempotent x2
  const bj = provisioned(w, r, 'sde.build.run', 'b');              // x1
  const c0 = completions(w);
  const t = restart(w);
  assert.equal(t.report.execution.pending, 2);
  const b = t.exec.recoverPhaseB(t.sys, t.nx.bootId, rec([entry(w, d.attempt.id, 'missing')]));   // the build is not reported at all: missing too
  assert.equal(b.requeued, 1); assert.equal(b.interrupted, 1);
  assert.equal(w.attempt(d.attempt.id).state, 'abandoned'); assert.equal(w.attempt(d.attempt.id).outcome, 'container_missing');
  assert.equal(w.jobState(d.job.id), 'retry_scheduled');
  assert.equal(w.job(d.job.id).next_attempt_at, w.now() + 10_000); assert.equal(w.job(d.job.id).phase, null);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/nexus/exec/recovery.ts'), 'utf8');
  assert.doesNotMatch(src, /'retry_scheduled', now\)|backoffMs|canRetry\(/, 'recovery reuses failJobTx (fix round 1, finding 10)');
  assert.equal(w.attempt(bj.attempt.id).state, 'abandoned');
  assert.equal(w.jobState(bj.job.id), 'interrupted'); assert.equal(JSON.parse(w.job(bj.job.id).error_json).code, 'container_missing');
  assert.deepEqual(recoverActs(w, d.job.id).map(decisionOf), ['retry']); assert.deepEqual(recoverActs(w, bj.job.id).map(decisionOf), ['interrupt']);
  assert.deepEqual(completions(w), c0);
  healthy(w); w.close();
});

test('RC8 running engine-side (the snapshot lived in the dead runner): attempt abandoned, job retry_scheduled, never a version from it', async () => {
  const w = execWorld({ realIngest: true }); const r = w.attach();
  const j = w.exec.start(w.me, w.req('sde.repository.snapshot')).job; w.exec.tick(w.now());
  const a = w.provisionEngine(r, j.id);
  assert.equal(w.attempt(a.id).state, 'running');
  const c0 = completions(w);
  const t = restart(w);
  assert.equal(w.attempt(a.id).state, 'abandoned'); assert.equal(w.attempt(a.id).outcome, 'engine_lost');
  assert.equal(w.jobState(j.id), 'retry_scheduled'); assert.equal(t.report.execution.requeued, 1);
  // The old runner's report of that work (it reached the new process somehow) is another boot's: dropped.
  t.runner.report({ op: 'attempt.exited', attemptId: a.id, exit: exitAt(w), outputs: [],
    parsed: [{ parser: 'repo-snapshot', sourceSha256: 'e'.repeat(64), normalized: { commit: w.COMMIT, branch: 'main', dirty: false, tree: 'a'.repeat(40) } }], logBytes: 1 });
  await settle(w, t);
  assert.equal(count(w, 'artifact_versions WHERE produced_by_job_id = ?', j.id), 0);
  assert.deepEqual(completions(w), c0);
  healthy(w); w.close();
});

test('RC9 validation: a check main was running (or had leased): attempt abandoned, the check runs again, the version stays draft until its result row', async () => {
  const w = execWorld({ realIngest: true }); const r = w.attach();
  const b = await w.runBuild({ files: [{ path: 'a.js', content: 'a' }], exit: 0 });   // blob.integrity waits for the runner
  assert.equal(w.version(b.buildVersionId).status, 'draft');
  const fresh = w.nx.validation.enqueueCandidate(w.sys, b.buildVersionId);
  const exitZero = w.db.prepare("SELECT id FROM jobs WHERE validator_id = 'build.exit_zero' AND state = 'queued'").get().id;
  const manifest = w.db.prepare("SELECT id FROM jobs WHERE validator_id = 'build.manifest_present' AND state = 'queued'").get().id;
  assert.ok(fresh.includes(exitZero) && fresh.includes(manifest));
  // The state a crash inside a main check would leave (CheckRunner leases, runs and completes in one transaction).
  const stuck = (jobId, to) => w.db.transaction(() => {
    w.nx.jobs.transitionTx(w.sys, jobId, 'leased', undefined, { expectState: 'queued', now: w.now() });
    const id = newId(w.now());
    insertAttemptTx(w.db, { id, jobId, projectId: 'p-ledger', n: w.job(jobId).attempts, bootId: w.nx.validation.mainBootId, now: w.now(), logPath: null,
      sandbox: { executor: 'main' }, environment: { executor: 'main' } });
    if (to === 'running') {
      transitionAttemptTx(w.db, attemptRow(w.db, id), 'running', w.now(), 'p-ledger');
      w.nx.jobs.transitionTx(w.sys, jobId, 'running', undefined, { expectState: 'leased', now: w.now() });
    }
    return id;
  }).immediate();
  const la = stuck(exitZero, 'leased'); const ra = stuck(manifest, 'running');
  const c0 = completions(w);
  const t = restart(w);
  assert.equal(w.attempt(la).state, 'abandoned'); assert.equal(w.jobState(exitZero), 'queued');
  assert.equal(w.attempt(ra).state, 'abandoned'); assert.equal(w.jobState(manifest), 'interrupted');
  const replacement = JSON.parse(recoverActs(w, manifest)[0].details_json).replacedBy;
  assert.ok(replacement); assert.equal(w.job(replacement).state, 'queued'); assert.equal(w.job(replacement).validator_id, 'build.manifest_present');
  assert.equal(t.report.execution.requeued, 2);
  assert.equal(w.version(b.buildVersionId).status, 'draft'); assert.deepEqual(completions(w), c0);
  t.nx.validation.runPending(w.now());
  assert.equal(w.jobState(exitZero), 'completed'); assert.equal(w.job(exitZero).attempts, 2);
  assert.equal(w.jobState(replacement), 'completed'); assert.equal(w.jobState(manifest), 'interrupted');
  assert.equal(w.version(b.buildVersionId).status, 'draft', 'blob.integrity has no result row yet');
  w.answerVerifies(t.runner, true); await settle(w, t);
  assert.equal(w.version(b.buildVersionId).status, 'candidate');
  healthy(w); w.close();
});

test('RC10 validation: the sde.tests_pass recipe child in a container, running (adopted) or exited (finalized); the suite stays draft until the result row', async () => {
  for (const variant of ['running', 'exited']) {
    const w = execWorld({ realIngest: true }); const r = w.attach();
    const d = w.exec.start(w.me, w.req('sde.tests.discover')).job; w.exec.tick(w.now()); provisionVia(w, r, d.id, 'a');
    const out = discoveryOutputs(w);
    w.exitWith(r, d.id, { outputs: out.outputs, parsed: out.parsed }); await w.settle();
    const suite = suiteOf(w, d.id); const tj = testCheckOf(w, d.id);
    w.exec.tick(w.now());
    const ta = provisionVia(w, r, tj.id, 'b');
    assert.equal(w.jobState(tj.id), 'running'); assert.equal(w.version(suite).status, 'draft');
    const c0 = completions(w);
    const t = restart(w);
    assert.equal(t.report.execution.pending, 1);
    assert.equal(t.exec.get(w.me, d.id).headline, 'validating', 'the parent waits for its check');
    const jo = junitOutputs(w);
    const e = variant === 'running' ? entry(w, ta.id, 'running') : entry(w, ta.id, 'exited', { exit: exitAt(w), staged: jo.outputs });
    const b = t.exec.recoverPhaseB(t.sys, t.nx.bootId, rec([e]));
    assert.equal(variant === 'running' ? b.adopted : b.finalized, 1, variant);
    assert.equal(w.version(suite).status, 'draft'); assert.deepEqual(completions(w), c0);
    assert.equal(w.latest(suite, 'sde.tests_pass'), undefined, 'no result row from a recovery decision');
    reportExit(w, t.runner, ta.id, jo.outputs, jo.parsed);
    await settle(w, t);
    assert.equal(w.jobState(tj.id), 'completed', variant);
    assert.equal(w.latest(suite, 'sde.tests_pass').status, 'passed'); assert.equal(w.latest(suite, 'sde.tests_pass').attempt_n, 1);
    assert.equal(w.version(suite).status, 'candidate', variant);
    assert.equal(t.exec.get(w.me, d.id).headline, 'checks_passed');
    healthy(w); w.close();
  }
});

test('RC11 waiting for approval, unexpired: the approval stays pending, the job waits, its attempt is re-owned; `once` later starts it', () => {
  const w = egressWorld(); w.attach();
  const d = w.exec.start(w.me, w.req('sde.deps.install')).job; w.exec.tick(w.now());
  assert.equal(w.jobState(d.id), 'awaiting_approval');
  const a = w.liveAttempt(d.id); const ap = approvalOf(w, d.id);
  w.advance(5 * MIN);
  const c0 = completions(w);
  const t = restart(w, { approvals: 'real' });
  assert.equal(approvalOf(w, d.id).status, 'pending'); assert.equal(w.jobState(d.id), 'awaiting_approval');
  assert.equal(w.attempt(a.id).state, 'starting'); assert.equal(w.attempt(a.id).lease_owner, t.nx.bootId);
  assert.equal(t.report.execution.pending, 1);
  assert.deepEqual(recoverActs(w, d.id).map(decisionOf), ['reown']); assert.deepEqual(recoveryEvents(w, d.id).map(decisionOf), ['reown']);
  assert.deepEqual(completions(w), c0);
  t.nx.approvals.respond(w.me, ap.id, 'once');
  assert.equal(w.jobState(d.id), 'running');
  const start = t.runner.lastStart();
  assert.equal(start.attemptId, a.id); assert.deepEqual(start.plan.container.network, { mode: 'egress-approved', approvalId: ap.id, purpose: 'deps' });
  healthy(w); w.close();
  // A consent given before the restart while the runner could not take the job: re-owned, then started by the scheduler.
  const w2 = egressWorld(); const r2 = w2.attach();
  const d2 = w2.exec.start(w2.me, w2.req('sde.deps.install')).job; w2.exec.tick(w2.now());
  r2.setState('unavailable');
  w2.nx.approvals.respond(w2.me, approvalOf(w2, d2.id).id, 'once');
  assert.equal(w2.jobState(d2.id), 'awaiting_approval'); assert.equal(approvalOf(w2, d2.id).status, 'approved');
  const t2 = restart(w2, { approvals: 'real' });
  assert.equal(w2.liveAttempt(d2.id).lease_owner, t2.nx.bootId);
  t2.exec.tick(w2.now());
  assert.equal(w2.jobState(d2.id), 'running'); assert.equal(t2.runner.lastStart().attemptId, w2.liveAttempt(d2.id).id);
  healthy(w2); w2.close();
});

test('RC12 waiting for approval, expired during the downtime: approval expired, job failed denied, attempt failed', () => {
  const w = egressWorld(); w.attach();
  const d = w.exec.start(w.me, w.req('sde.deps.install')).job; w.exec.tick(w.now());
  const a = w.liveAttempt(d.id);
  w.advance(16 * MIN);
  const c0 = completions(w);
  const t = restart(w, { approvals: 'real' });
  assert.equal(approvalOf(w, d.id).status, 'expired');
  assert.equal(w.jobState(d.id), 'failed'); assert.equal(w.job(d.id).outcome, 'denied'); assert.equal(JSON.parse(w.job(d.id).error_json).code, 'approval_expired');
  assert.equal(w.attempt(a.id).state, 'failed'); assert.equal(w.attempt(a.id).outcome, 'denied');
  assert.equal(t.report.execution.expired, 1);
  assert.deepEqual(recoverActs(w, d.id).map(decisionOf), ['expire']);
  const ev = recoveryEvents(w, d.id);
  assert.equal(ev.length, 1); assert.equal(ev[0].approval_id, approvalOf(w, d.id).id);
  assert.equal(t.runner.sentOf('attempt.start').length, 0);
  assert.deepEqual(completions(w), c0);
  healthy(w); w.close();
});

test('RC13 service: deployment healthy, container running: adopted, its status kept, its probes resume', async () => {
  const w = serviceWorld();
  const { job, attempt } = await deployed(w);
  assert.equal(dep(w, job.id).status, 'healthy');
  const probes = JSON.parse(dep(w, job.id).health_json).length;
  const c0 = completions(w);
  const t = restart(w, { fwd: true });
  assert.equal(t.report.execution.pending, 1); assert.equal(dep(w, job.id).status, 'healthy');
  t.runner.report({ op: 'service.health', attemptId: attempt.id, at: w.now(), status: 200, ms: 3, container: 'running' });
  assert.equal(JSON.parse(dep(w, job.id).health_json).length, probes, 'another boot\'s probe is dropped before adoption');
  const b = t.exec.recoverPhaseB(t.sys, t.nx.bootId, rec([entry(w, attempt.id, 'running')]));
  assert.equal(b.adopted, 1);
  assert.equal(dep(w, job.id).status, 'healthy'); assert.equal(w.jobState(job.id), 'running');
  assert.equal(t.runner.sentOf('attempt.adopt').length, 1); assert.equal(t.runner.sentOf('attempt.cancel').length, 0);
  assert.deepEqual(completions(w), c0);
  probe(w, t.runner, t.exec, attempt.id, 200);
  assert.equal(JSON.parse(dep(w, job.id).health_json).length, probes + 1, 'probes resume');
  assert.equal(dep(w, job.id).status, 'healthy');
  healthy(w); w.close();
});

test('RC14 service: container missing: the deployment is stopped (recovery), the job interrupted, the attempt abandoned; one already stopped ends exit_not_reported', async () => {
  const w = serviceWorld();
  const { job, attempt, app } = await deployed(w);
  const appStatus = w.version(app).status;
  const c0 = completions(w);
  const t = restart(w, { fwd: true });
  const b = t.exec.recoverPhaseB(t.sys, t.nx.bootId, rec([entry(w, attempt.id, 'missing')]));
  assert.equal(b.interrupted, 1);
  const dd = dep(w, job.id);
  assert.equal(dd.status, 'stopped'); assert.equal(dd.stop_reason, 'recovery'); assert.equal(dd.stopped_by, t.sys.id);
  assert.equal(w.jobState(job.id), 'interrupted'); assert.equal(w.attempt(attempt.id).state, 'abandoned');
  assert.equal(w.version(app).status, appStatus, 'the application keeps what its own check decided');
  assert.deepEqual(completions(w), c0);
  healthy(w); w.close();
  // Stopped by the user before the restart (its job waited for the exit), its containers then gone: the exit will never
  // be reported, so the job fails exit_not_reported; the deployment keeps its own end (user).
  const w2 = serviceWorld();
  const s2 = await deployed(w2);
  w2.nx.deployments.stop(w2.me, dep(w2, s2.job.id).id);
  assert.equal(w2.jobState(s2.job.id), 'running'); assert.equal(w2.job(s2.job.id).phase, 'stopping');
  const c2 = completions(w2);
  const t2 = restart(w2, { fwd: true });
  const b2 = t2.exec.recoverPhaseB(t2.sys, t2.nx.bootId, rec([entry(w2, s2.attempt.id, 'missing')]));
  assert.equal(b2.failed, 1, 'exit_lost counts as failed'); assert.equal(b2.interrupted, 0);
  assert.equal(w2.jobState(s2.job.id), 'failed'); assert.equal(w2.job(s2.job.id).outcome, 'exit_not_reported');
  assert.equal(w2.attempt(s2.attempt.id).state, 'abandoned');
  assert.equal(dep(w2, s2.job.id).status, 'stopped'); assert.equal(dep(w2, s2.job.id).stop_reason, 'user');
  assert.deepEqual(recoverActs(w2, s2.job.id).map(decisionOf), ['exit_lost']);
  assert.deepEqual(completions(w2), c2);
  healthy(w2); w2.close();
});

test('RC15 Docker unreachable during phase B: every container-backed attempt is missing, with reason docker_unavailable_at_recovery', async () => {
  const w = serviceWorld();
  const svc = await deployed(w);
  const r = w.attach();
  const d = provisioned(w, r, 'sde.tests.discover', 'a');
  const bj = provisioned(w, r, 'sde.build.run', 'b');
  const c0 = completions(w);
  const t = restart(w, { fwd: true });
  // The runner's per-attempt answers do not count when Docker itself is not running.
  const b = t.exec.recoverPhaseB(t.sys, t.nx.bootId, rec([entry(w, d.attempt.id, 'running'), entry(w, bj.attempt.id, 'running'),
    entry(w, svc.attempt.id, 'running')], [], 'stopped'));
  assert.equal(b.adopted, 0); assert.equal(b.requeued, 1); assert.equal(b.interrupted, 2);
  for (const a of [d.attempt, bj.attempt, svc.attempt]) {
    assert.equal(w.attempt(a.id).state, 'abandoned'); assert.equal(w.attempt(a.id).outcome, 'docker_unavailable_at_recovery');
  }
  assert.equal(w.jobState(d.job.id), 'retry_scheduled'); assert.equal(w.jobState(bj.job.id), 'interrupted'); assert.equal(w.jobState(svc.job.id), 'interrupted');
  assert.equal(dep(w, svc.job.id).stop_reason, 'recovery');
  for (const e of recoveryEvents(w)) assert.equal(JSON.parse(e.data_json).reason, 'docker_unavailable_at_recovery');
  assert.equal(t.runner.sentOf('attempt.adopt').length, 0);
  assert.deepEqual(completions(w), c0);
  healthy(w); w.close();
});

test('RC16 orphans (fix round 1: scoped to this install): an ended attempt\'s labelled container and volume are removed; another install\'s, an unlabelled nexus-x, a user\'s nexus.note, a live attempt\'s and an unknown attempt\'s never are', () => {
  const w = execWorld({ realIngest: true }); const r = w.attach();
  const kept = provisioned(w, r, 'sde.build.run', 'd');
  const ended = provisioned(w, r, 'sde.build.run', 'b');
  w.exec.cancel(w.me, ended.job.id);
  // The plans carry this install's nexus.home on every container and on the labels of every volume and network.
  const plan = r.sentOf('attempt.start').find((m) => m.attemptId === kept.attempt.id).plan;
  assert.equal(plan.container.labels['nexus.home'], homeLabel(w.dataHome.root)); assert.match(plan.container.labels['nexus.home'], /^[0-9a-f]{16}$/);
  assert.deepEqual(plan.resourceLabels, labelsOf(w, kept.attempt.id, kept.job.id));
  const t = restart(w);
  const unknownAttempt = newId(w.now());
  const otherHome = homeLabel(h.tmpDir('nx-other-home-'));
  assert.notEqual(otherHome, homeLabel(w.dataHome.root));
  const labelled = [
    { kind: 'container', id: 'd'.repeat(64), labels: labelsOf(w, kept.attempt.id, kept.job.id, { 'nexus.kind': 'tool' }) },            // live: kept
    { kind: 'volume', id: `nexus-ws-${kept.attempt.id}`, labels: labelsOf(w, kept.attempt.id, kept.job.id) },                         // live: kept
    { kind: 'container', id: 'b'.repeat(64), labels: labelsOf(w, ended.attempt.id, ended.job.id, { 'nexus.kind': 'tool' }) },          // ended: removed
    { kind: 'volume', id: `nexus-ws-${ended.attempt.id}`, labels: labelsOf(w, ended.attempt.id, ended.job.id) },                      // ended: removed
    { kind: 'container', id: 'a'.repeat(64), labels: labelsOf(w, ended.attempt.id, ended.job.id, { 'nexus.home': otherHome }) },     // another install
    { kind: 'container', id: 'f'.repeat(64), labels: labelsOf(w, unknownAttempt, newId(w.now())) },                                  // unknown attempt
    { kind: 'volume', id: 'nexus-ws-leftover', labels: { 'nexus.project': 'p-ledger', 'nexus.home': homeLabel(w.dataHome.root) } }, // no attempt label
    { kind: 'container', id: 'nexus-x', labels: {} },
    { kind: 'container', id: '9'.repeat(64), labels: { 'nexus.note': 'mine', 'com.example.name': 'nexus-x' } },
    { kind: 'volume', id: `nexus-deps-sde-node-${LOCK.slice(0, 12)}`, labels: labelsOf(w, ended.attempt.id, ended.job.id, { 'nexus.kind': 'deps' }) }
  ];
  const b = t.exec.recoverPhaseB(t.sys, t.nx.bootId, rec([entry(w, kept.attempt.id, 'running')], labelled));
  assert.equal(b.adopted, 1);
  assert.deepEqual(b.remove, [{ kind: 'container', id: 'b'.repeat(64), reason: 'attempt_ended' }, { kind: 'volume', id: `nexus-ws-${ended.attempt.id}`, reason: 'attempt_ended' }]);
  assert.deepEqual(b.unknown, [{ kind: 'container', id: 'f'.repeat(64) }], 'an unknown attempt is reported, never removed');
  for (const never of ['a'.repeat(64), 'nexus-x', '9'.repeat(64), 'nexus-ws-leftover', 'd'.repeat(64)]) assert.ok(!b.remove.some((x) => x.id === never), never);
  const rows = recoverActs(w).filter((x) => ['orphans', 'unknown_resources'].includes(decisionOf(x)));
  assert.deepEqual(rows.map((x) => JSON.parse(x.details_json)), [
    { decision: 'orphans', reason: 'attempt_ended', containers: 1, volumes: 1, networks: 0 },
    { decision: 'unknown_resources', reason: 'attempt_unknown', containers: 1, volumes: 0, networks: 0 }]);
  assert.ok(t.logs.some((l) => /1 labelled resource\(s\) of this install name an attempt this database does not know; left in place/.test(l)));
  // The rule itself (pure).
  const home = 'h'.repeat(16);
  const rule = R.orphanDecisions({ labelled: [
    { kind: 'container', id: 'x1', labels: { 'nexus.home': home, 'nexus.attempt': 'LIVE' } },
    { kind: 'container', id: 'x2', labels: { 'nexus.home': home, 'nexus.attempt': 'ENDED' } },
    { kind: 'network', id: 'nexus-svc-x', labels: { 'nexus.home': home, 'nexus.attempt': 'ENDED' } },
    { kind: 'container', id: 'x3', labels: { 'nexus.home': 'other', 'nexus.attempt': 'ENDED' } },
    { kind: 'container', id: 'x4', labels: { 'nexus.home': home, 'nexus.attempt': 'GONE' } },
    { kind: 'container', id: 'userdb', labels: { 'nexus.note': 'mine' } }
  ] }, { home, liveAttempts: new Set(['LIVE']), knownAttempts: new Set(['LIVE', 'ENDED']) });
  assert.deepEqual(rule, { remove: [{ kind: 'container', id: 'x2', reason: 'attempt_ended' }, { kind: 'network', id: 'nexus-svc-x', reason: 'attempt_ended' }],
    unknown: [{ kind: 'container', id: 'x4' }] });
  assert.deepEqual(R.orphanDecisions({ labelled: [{ kind: 'container', id: 'x2', labels: { 'nexus.home': home, 'nexus.attempt': 'ENDED' } }] },
    { home: null, liveAttempts: new Set(), knownAttempts: new Set(['ENDED']) }), { remove: [], unknown: [] }, 'no data home: nothing is removed');
  healthy(w); w.close();
});

test('RC17 an image build left running is interrupted (requestImage works again); an image approval past its time expires', () => {
  const w = execWorld({ approvals: 'real', imageContexts: () => CTX }); w.attach();
  const a1 = w.nx.approvals.requestImage(w.me, 'sde-node', 'intent-img-1').approval;
  w.nx.approvals.respond(w.me, a1.id, 'once');
  const build = w.db.prepare("SELECT * FROM image_builds WHERE status = 'running'").get();
  assert.ok(build);
  const a2 = w.nx.approvals.requestImage(w.me, 'sde-python', 'intent-img-2').approval;
  w.advance(16 * MIN);
  const t = restart(w, { approvals: 'real', imageContexts: () => CTX });
  const b = w.db.prepare('SELECT * FROM image_builds WHERE id = ?').get(build.id);
  assert.equal(b.status, 'interrupted'); assert.equal(JSON.parse(b.error_json).code, 'restarted'); assert.equal(b.finished_at, w.now());
  assert.equal(w.db.prepare('SELECT status FROM approvals WHERE id = ?').get(a2.id).status, 'expired');
  assert.equal(t.report.execution.interrupted, 1); assert.equal(t.report.execution.expired, 1); assert.deepEqual(t.report.jobs, { interrupted: 0, requeued: 0 });
  const decisions = recoverActs(w).map((x) => [x.entity_type, decisionOf(x)]);
  assert.deepEqual(decisions.sort(), [['approval', 'expire'], ['image_build', 'image_interrupted']]);
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM job_events WHERE type = 'recovery' AND image_build_id = ?").get(build.id).n, 1);
  const again = t.nx.approvals.requestImage(w.me, 'sde-node', 'intent-img-3');
  assert.equal(again.created, true, 'no leftover running build blocks a new request');
  healthy(w); w.close();
});

test('RC18 an ingest crash (exit durable, ingest never committed): phase B finalizes, the re-hashed exit is ingested exactly once', async () => {
  const w = execWorld({ realIngest: true }); const r = w.attach();
  const { job, attempt } = provisioned(w, r, 'sde.build.run', 'd');
  // The old process stops between the durable exit and the ingest commit (the ingest waits for a lock it never gets).
  const hold = w.nx.blobs.lock.tryExclusive();
  const files = [w.file('dist/app.js', 'built'), w.file('dist/lib.js', 'lib')];
  w.exitWith(r, job.id, { code: 0, outputs: files });
  assert.equal(w.job(job.id).phase, 'collecting'); assert.equal(w.attempt(attempt.id).state, 'running');
  assert.equal(w.events(job.id, 'attempt.output').length, 1); assert.equal(count(w, 'artifact_versions WHERE produced_by_job_id = ?', job.id), 0);
  const c0 = completions(w);
  const t = restart(w);
  assert.equal(t.report.execution.pending, 1);
  t.exec.recoverPhaseB(t.sys, t.nx.bootId, rec([entry(w, attempt.id, 'exited', { exit: exitAt(w), staged: files })]));
  assert.deepEqual(completions(w), c0);
  reportExit(w, t.runner, attempt.id, files);
  await settle(w, t);
  assert.equal(w.jobState(job.id), 'completed');
  assert.equal(count(w, 'artifact_versions WHERE produced_by_job_id = ?', job.id), 1);
  reportExit(w, t.runner, attempt.id, files);                          // replayed: dropped
  await settle(w, t);
  assert.equal(count(w, 'artifact_versions WHERE produced_by_job_id = ?', job.id), 1);
  // A second restart: the finished attempt's container is a leftover; nothing is ingested again.
  const t2 = restart(w);
  const b2 = t2.exec.recoverPhaseB(t2.sys, t2.nx.bootId, rec([{ attemptId: attempt.id, container: 'exited', containerId: 'd'.repeat(64) }],
    [{ kind: 'container', id: 'd'.repeat(64), labels: labelsOf(w, attempt.id, job.id) }]));
  assert.deepEqual(b2.remove.map((x) => x.id), ['d'.repeat(64)]); assert.equal(b2.finalized, 0);
  // The dead process's ingest, if it ever ran, finds the attempt finished and writes nothing.
  hold(); await w.exec.settled();
  assert.equal(count(w, 'artifact_versions WHERE produced_by_job_id = ?', job.id), 1);
  assert.equal(count(w, 'version_attempts WHERE job_id = ?', job.id), 1);
  healthy(w); w.close();
});

test('RC19 repeated restarts: phase A three times changes nothing after the first (same boot); new boots only re-own approval waits', () => {
  const w = egressWorld(); const r = w.attach();
  const run = provisioned(w, r, 'sde.tests.discover', 'a');
  const ap = w.exec.start(w.me, w.req('sde.deps.install')).job; w.exec.tick(w.now());
  const leased = w.exec.start(w.me, w.req('sde.tests.discover')).job; w.exec.tick(w.now());
  assert.equal(w.jobState(leased.id), 'leased'); assert.equal(w.jobState(ap.id), 'awaiting_approval');
  const t = restart(w, { approvals: 'real' });
  const snap = () => ({
    jobs: w.db.prepare('SELECT id, state, attempts, phase, outcome FROM jobs ORDER BY id').all(),
    attempts: w.db.prepare('SELECT id, state, lease_owner, lease_expires_at FROM job_attempts ORDER BY id').all(),
    activity: count(w, 'activity'), events: count(w, 'job_events')
  });
  const s1 = snap();
  for (let i = 0; i < 2; i++) {
    const again = t.exec.recoverPhaseA(t.sys, t.nx.bootId);
    assert.equal(again.decisions, 0); assert.equal(again.errors, 0);
    assert.equal(again.pending, 2, 'the recorded container and the approval wait');
  }
  assert.deepEqual(snap(), s1, 'the second and third runs write nothing');
  // Three successive restarts with new boot ids: states never change; only the approval wait is re-owned each time.
  const states = () => w.db.prepare('SELECT id, state, attempts FROM jobs ORDER BY id').all();
  const st = states();
  for (let i = 0; i < 2; i++) {
    const tn = restart(w, { approvals: 'real' });
    assert.deepEqual(states(), st);
    assert.equal(w.liveAttempt(ap.id).lease_owner, tn.nx.bootId);
    assert.equal(tn.report.execution.decisions, 1);
  }
  assert.equal(w.jobState(leased.id), 'queued'); assert.equal(w.jobState(run.job.id), 'running');
  healthy(w); w.close();
});

test('RC20 at v8 (execution unavailable): B0b recoverAfterRestart unchanged; at v9 a job without a live attempt gets the same B1 rule', () => {
  const RETRY = { idempotent: true, maxAttempts: 3, backoffMs: [10] };
  const make = (nx, me, sys) => {
    const job = (extra = {}) => nx.jobs.create(me, { kind: 'tool.run', projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: `k-${newId()}`, retry: RETRY, ...extra }).job;
    const q = job(); const l = job(); const ru = job(); const aw = job();
    nx.jobs.transition(sys, l.id, 'leased');
    for (const s of ['leased', 'running']) nx.jobs.transition(sys, ru.id, s);
    for (const s of ['leased', 'running', 'awaiting_approval']) nx.jobs.transition(sys, aw.id, s);
    return { q, l, ru, aw };
  };
  // v8
  const { file } = h.v6Fixture();
  const s = new PersistStore(file); s.open({ log: () => {}, backupDir: path.join(path.dirname(file), 'b'), now: () => h.NOW });
  const nx = createNexusPlatform(s.platformDatabase(), { now: () => h.NOW });
  const j8 = make(nx, nx.principals.localUser(), nx.principals.system());
  s.close();
  const s2 = new PersistStore(file); s2.open({ log: () => {}, backupDir: path.join(path.dirname(file), 'b'), now: () => h.NOW });
  const nx2 = createNexusPlatform(s2.platformDatabase(), { now: () => h.NOW });
  assert.deepEqual(nx2.startup().jobs, { interrupted: 2, requeued: 1 });
  const st8 = (id) => nx2.jobs.get(nx2.principals.localUser(), id).state;
  assert.deepEqual([st8(j8.q.id), st8(j8.l.id), st8(j8.ru.id), st8(j8.aw.id)], ['queued', 'queued', 'interrupted', 'interrupted']);
  assert.equal(s2.platformDatabase().prepare("SELECT COUNT(*) AS n FROM activity WHERE action = 'job.recover'").get().n, 3);
  assert.deepEqual(nx2.startup().jobs, { interrupted: 0, requeued: 0 });
  s2.close();
  // v9, the same jobs: phase A applies B1's rule to jobs without a live attempt (its job.recover rows), with its own decision rows.
  const w = execWorld({ realIngest: true });
  const j9 = make(w.nx, w.me, w.sys);
  const t = restart(w);
  assert.deepEqual(t.report.jobs, { interrupted: 2, requeued: 1 });
  assert.deepEqual([w.jobState(j9.q.id), w.jobState(j9.l.id), w.jobState(j9.ru.id), w.jobState(j9.aw.id)], ['queued', 'queued', 'interrupted', 'interrupted']);
  assert.equal(count(w, "activity WHERE action = 'job.recover'"), 3);
  assert.equal(recoverActs(w).length, 3); assert.equal(recoveryEvents(w).length, 3);
  healthy(w); w.close();
});

// ---------- carried decisions ----------

test('D1 a v9 file with live attempts, opened while v9 is off: platform ready without throwing, nothing corrupted; with v9 on again, recovery completes', () => {
  const w = execWorld({ realIngest: true }); const r = w.attach();
  const run = provisioned(w, r, 'sde.build.run', 'd');
  const leased = w.exec.start(w.me, w.req('sde.tests.discover')).job; w.exec.tick(w.now());
  const agentless = w.nx.jobs.create(w.me, { kind: 'tool.run', projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: 'plain-1' }).job;
  for (const st of ['leased', 'running']) w.nx.jobs.transition(w.sys, agentless.id, st);
  const file = w.s.dbPath; const backupDir = path.join(path.dirname(file), 'b');
  w.s.close();
  // Reopened without enableV9 (the default): the file is v9, execution is off.
  const s = new PersistStore(file);
  s.open({ log: () => {}, backupDir, now: () => w.now() });
  assert.equal(s.schemaVersion, 9); assert.equal(s.executionAvailable, false); assert.equal(s.executionUnavailableReason, 'not_enabled');
  const db = s.platformDatabase();
  const v9Rows = () => ({ events: db.prepare('SELECT COUNT(*) AS n FROM job_events').get().n, attempts: db.prepare('SELECT id, state, lease_owner FROM job_attempts ORDER BY id').all() });
  const before = v9Rows();
  const logs = [];
  const nx = createNexusPlatform(db, { now: () => w.now(), log: (l) => logs.push(l), execution: s.executionAvailable, executionUnavailableReason: s.executionUnavailableReason });
  let b1 = 0; nx.jobs.recoverAfterRestart = () => { b1++; throw new Error('B1 must not run on a v9 file'); };
  const report = nx.startup();
  assert.equal(b1, 0);
  assert.equal(report.execution.held, true); assert.equal(report.execution.pending, 2); assert.deepEqual(report.jobs, { interrupted: 1, requeued: 0 });
  assert.ok(logs.some((l) => l.startsWith('[nexus] platform ready:')));
  assert.ok(logs.includes('[nexus] execution recovery: adopted=0 finalized=0 requeued=0 interrupted=1 expired=0 pending=2'));
  assert.ok(logs.some((l) => l.startsWith('[nexus] execution recovery held: execution is off (not_enabled)')));
  assert.deepEqual(v9Rows(), before, 'no v9 table is written in hold mode');
  const state = (id) => db.prepare('SELECT state FROM jobs WHERE id = ?').get(id).state;
  assert.equal(state(run.job.id), 'running'); assert.equal(state(leased.id), 'leased'); assert.equal(state(agentless.id), 'interrupted');
  assert.deepEqual(execOrphanRows(db).O12, []);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); assert.equal(verifyActivityChain(db).ok, true);
  s.close();
  // v9 on again: the full recovery runs over what was left.
  const s3 = new PersistStore(file);
  s3.open({ log: () => {}, backupDir, now: () => w.now(), enableV9: true });
  assert.equal(s3.executionAvailable, true);
  const nx3 = createNexusPlatform(s3.platformDatabase(), { now: () => w.now(), execution: true, dataHome: w.dataHome, profiles: PROFILES, acceptFsRoot: (x) => x });
  const r3 = nx3.startup();
  assert.equal(r3.execution.held, false); assert.equal(r3.execution.requeued, 1); assert.equal(r3.execution.pending, 1);
  const db3 = s3.platformDatabase();
  assert.equal(db3.prepare('SELECT state FROM jobs WHERE id = ?').get(leased.id).state, 'queued');
  const runner = new FakeRunner(); nx3.exec.attachRunner(runner, nx3.bootId); runner.report(w.probeMsg());
  const b = nx3.exec.recoverPhaseB(nx3.principals.system(), nx3.bootId, rec([{ attemptId: run.attempt.id, container: 'running', containerId: 'd'.repeat(64) }]));
  assert.equal(b.adopted, 1);
  assert.deepEqual(execOrphanRows(db3).O12, []); assert.equal(verifyActivityChain(db3).ok, true);
  s3.close();
});

test('D8 an adopted attempt gets exactly one fresh lease: no heartbeat within it fails runner_lost; one adopted for finalization has no wall clock left', async () => {
  const w = execWorld({ realIngest: true }); const r = w.attach();
  const lost = provisioned(w, r, 'sde.build.run', 'a');
  const late = provisioned(w, r, 'sde.build.run', 'b');
  w.advance(16 * MIN);                                       // the downtime ran past the 15 min wall clock
  const t = restart(w);
  t.exec.recoverPhaseB(t.sys, t.nx.bootId, rec([entry(w, lost.attempt.id, 'running'),
    entry(w, late.attempt.id, 'exited', { exit: exitAt(w), staged: [w.file('dist/app.js', 'x')] })]));
  assert.equal(w.attempt(lost.attempt.id).lease_expires_at, w.now() + LEASE_MS);
  assert.equal(w.attempt(late.attempt.id).lease_expires_at, w.now() + LEASE_MS);
  // The downtime counts for the adopted running attempt (its stall history is gone): it times out at the first tick.
  t.exec.tick(w.now());
  assert.equal(w.jobState(lost.job.id), 'timed_out');
  assert.ok(t.runner.sentOf('attempt.cancel').some((m) => m.attemptId === lost.attempt.id));
  // The one adopted for finalization already exited: no wall clock; its re-reported exit is ingested.
  assert.equal(w.attempt(late.attempt.id).state, 'running');
  reportExit(w, t.runner, late.attempt.id, [w.file('dist/app.js', 'x')]);
  await settle(w, t);
  assert.equal(w.jobState(late.job.id), 'completed');
  healthy(w); w.close();
  // Silence after adoption: the lease runs out and the attempt fails runner_lost (never completed).
  const w2 = execWorld({ realIngest: true }); const r2 = w2.attach();
  const quiet = provisioned(w2, r2, 'sde.build.run', 'c');
  const t2 = restart(w2);
  t2.exec.recoverPhaseB(t2.sys, t2.nx.bootId, rec([entry(w2, quiet.attempt.id, 'running')]));
  // The scheduler's normal cadence (a tick every 5 s; a longer gap is a stall of main and moves leases instead).
  const adoptedAt = w2.now();
  t2.exec.tick(w2.now());
  while (w2.now() + 5_000 < adoptedAt + LEASE_MS) { w2.advance(5_000); t2.exec.tick(w2.now()); }
  assert.equal(w2.attempt(quiet.attempt.id).state, 'running', 'within its one fresh lease');
  w2.advance(5_000); t2.exec.tick(w2.now());
  w2.advance(5_000); t2.exec.tick(w2.now());
  assert.equal(w2.attempt(quiet.attempt.id).state, 'failed'); assert.equal(w2.attempt(quiet.attempt.id).outcome, 'runner_lost');
  assert.equal(w2.jobState(quiet.job.id), 'failed');
  healthy(w2); w2.close();
});

test('D9 every decision is one transaction with one exec.recover row and one recovery event; a failing decision rolls back alone', () => {
  const w = execWorld({ realIngest: true }); w.attach();
  const a = w.exec.start(w.me, w.req('sde.build.run')).job;
  const b = w.exec.start(w.me, w.req('sde.tests.discover')).job;
  w.exec.tick(w.now());
  assert.equal(w.jobState(a.id), 'leased'); assert.equal(w.jobState(b.id), 'leased');
  const la = w.liveAttempt(a.id); const lb = w.liveAttempt(b.id);
  w.db.exec(`CREATE TEMP TRIGGER t10_fail BEFORE UPDATE OF state ON jobs WHEN NEW.id = '${b.id}' AND NEW.state = 'queued'
    BEGIN SELECT RAISE(ABORT, 'injected'); END`);
  const t = restart(w);
  assert.equal(t.report.execution.errors, 1); assert.equal(t.report.execution.requeued, 1);
  assert.equal(w.jobState(a.id), 'queued'); assert.equal(w.attempt(la.id).state, 'abandoned');
  assert.equal(w.jobState(b.id), 'leased'); assert.equal(w.attempt(lb.id).state, 'starting', 'the failed decision rolled back whole');
  assert.equal(recoverActs(w, b.id).length, 0); assert.equal(recoveryEvents(w, b.id).length, 0);
  assert.ok(t.logs.some((l) => /a decision about a job was not applied \(/.test(l)));
  assert.ok(t.logs.includes('[nexus] execution recovery: 1 decision(s) not applied; those jobs are left as they were'));
  w.db.exec('DROP TRIGGER t10_fail');
  const again = t.exec.recoverPhaseA(t.sys, t.nx.bootId);
  assert.equal(again.requeued, 1); assert.equal(w.jobState(b.id), 'queued');
  // One row each per decision, naming the same job and attempt.
  for (const id of [a.id, b.id]) {
    const acts = recoverActs(w, id); const evs = recoveryEvents(w, id);
    assert.equal(acts.length, 1); assert.equal(evs.length, 1);
    assert.equal(acts[0].attempt_n, 1); assert.equal(evs[0].attempt_n, 1);
    assert.equal(acts[0].actor_kind, 'system'); assert.equal(acts[0].status, 'succeeded');
  }
  healthy(w); w.close();
});

test('D10 the runner\'s reconcile only informs: a finished attempt reported running, an unknown attempt, another container id, a malformed answer', () => {
  const w = execWorld({ realIngest: true }); const r = w.attach();
  const done = provisioned(w, r, 'sde.build.run', 'a');
  w.exec.cancel(w.me, done.job.id);
  const live = provisioned(w, r, 'sde.build.run', 'b');
  const bare = provisioned(w, r, 'sde.build.run', 'c');
  const t = restart(w);
  const before = { jobs: w.db.prepare('SELECT id, state FROM jobs ORDER BY id').all(), acts: count(w, 'activity') };
  assert.throws(() => t.exec.recoverPhaseB(t.sys, t.nx.bootId, { docker: 'running', attempts: [{ attemptId: 'x', container: 'running' }], labelled: [] }),
    code('invalid', 'bad_reconcile'));
  assert.throws(() => t.exec.recoverPhaseB(t.sys, t.nx.bootId, { docker: 'up', attempts: [], labelled: [] }), code('invalid', 'bad_reconcile'));
  assert.throws(() => t.exec.recoverPhaseB(t.sys, newId(w.now()), rec()), code('invalid', 'boot_mismatch'));
  assert.deepEqual({ jobs: w.db.prepare('SELECT id, state FROM jobs ORDER BY id').all(), acts: count(w, 'activity') }, before);
  const b = t.exec.recoverPhaseB(t.sys, t.nx.bootId, rec([
    { attemptId: done.attempt.id, container: 'running', containerId: 'a'.repeat(64) },        // cancelled in SQLite: stays cancelled
    { attemptId: newId(w.now()), container: 'running', containerId: 'c'.repeat(64) },        // not this database's
    { attemptId: live.attempt.id, container: 'running', containerId: 'e'.repeat(64) },        // not the recorded container
    { attemptId: bare.attempt.id, container: 'running' }                                     // no container id at all (finding 4)
  ]));
  assert.equal(b.adopted, 0);
  assert.equal(w.attempt(bare.attempt.id).state, 'abandoned'); assert.equal(w.attempt(bare.attempt.id).outcome, 'container_missing');
  assert.equal(w.attempt(done.attempt.id).state, 'cancelled'); assert.equal(w.jobState(done.job.id), 'cancelled');
  assert.equal(w.attempt(live.attempt.id).state, 'abandoned'); assert.equal(w.attempt(live.attempt.id).outcome, 'container_missing');
  assert.equal(t.runner.sentOf('attempt.adopt').length, 0);
  healthy(w); w.close();
});

test('D7 blob store hygiene: stale tmp files and unindexed objects older than 24 h go; indexed and fresh ones stay; an unfinished GC is closed only once nothing it may have left remains; a hard link is reported', async () => {
  const w = execWorld({ realIngest: true }); w.attach();
  await w.dataHome.ensure();
  const root = w.dataHome.root;
  const sha = (c) => c.repeat(64);
  const put = (s, content = s) => { const d = path.join(root, 'objects', s.slice(0, 2)); fs.mkdirSync(d, { recursive: true }); const p = path.join(d, s.slice(2)); fs.writeFileSync(p, content); return p; };
  const age = (p, ms) => { const t = new Date(w.now() - ms); fs.utimesSync(p, t, t); };
  const oldUnindexed = put(sha('a')); age(oldUnindexed, 25 * 3600_000);
  const freshUnindexed = put(sha('b')); age(freshUnindexed, 3600_000);
  const indexed = put(sha('c')); age(indexed, 25 * 3600_000);
  w.db.prepare('INSERT INTO blobs (sha256, bytes, media_type, created_at, last_referenced_at) VALUES (?, 1, ?, ?, ?)').run(sha('c'), 'text/plain', w.now(), w.now());
  const linked = put(sha('d')); age(linked, 25 * 3600_000);
  fs.linkSync(linked, path.join(root, 'work', 'second-name'));
  const tmpOld = path.join(root, 'objects', 'tmp', 'partial-1'); fs.writeFileSync(tmpOld, 'x'); age(tmpOld, 25 * 3600_000);
  const tmpNew = path.join(root, 'objects', 'tmp', 'partial-2'); fs.writeFileSync(tmpNew, 'x');
  const outside = h.tmpDir('nx-outside-'); fs.writeFileSync(path.join(outside, 'e'.repeat(62)), 'keep'); age(path.join(outside, 'e'.repeat(62)), 25 * 3600_000);
  fs.symlinkSync(outside, path.join(root, 'objects', 'ee'), 'junction');
  // A GC whose process stopped after its rows were deleted, before its file delete was recorded.
  const { appendActivityRow } = loadTs('src/main/nexus/activity/writer.ts');
  w.db.transaction(() => appendActivityRow(w.db, { actorKind: 'user', actorId: w.me.id, entityType: 'blob', action: 'blob.gc', status: 'started',
    details: { removed: 1, bytes: 1 } }, w.now())).immediate();
  const t = restart(w);
  // While an attempt is live, unindexed objects are not touched (a landing object is never raced); tmp is.
  const busy = t.exec.start(w.me, w.req('sde.build.run')).job; t.exec.tick(w.now()); provisionVia(w, t.runner, busy.id, 'f');
  const r1 = await t.exec.recoverBlobStore(t.sys);
  assert.equal(r1.ran, true); assert.equal(r1.objectsDeferred, true); assert.equal(r1.tmpRemoved, 1);
  assert.equal(fs.existsSync(tmpOld), false); assert.equal(fs.existsSync(tmpNew), true); assert.equal(fs.existsSync(oldUnindexed), true);
  assert.equal(r1.finishedGc, false);
  t.exec.cancel(w.me, busy.id);
  // GC or ingest holding the store: the pass does not run.
  const hold = t.nx.blobs.lock.tryExclusive();
  assert.equal((await t.exec.recoverBlobStore(t.sys)).reason, 'busy');
  hold();
  const r2 = await t.exec.recoverBlobStore(t.sys);
  assert.equal(r2.objectsRemoved, 1); assert.equal(r2.objectsFailed, 1); assert.equal(r2.hardLinked, 1); assert.equal(r2.hardLinkedIndexed, 0);
  assert.equal(r2.finishedGc, false, 'a GC is not finished while unindexed files remain (one too young, one undeletable)');
  assert.equal(fs.existsSync(oldUnindexed), false);
  assert.equal(fs.existsSync(freshUnindexed), true); assert.equal(fs.existsSync(indexed), true); assert.equal(fs.existsSync(linked), true);
  assert.equal(fs.readFileSync(path.join(outside, 'e'.repeat(62)), 'utf8'), 'keep', 'nothing behind a junction');
  const last = () => w.db.prepare("SELECT * FROM activity WHERE action = 'blob.gc' ORDER BY seq DESC LIMIT 1").get();
  assert.equal(last().status, 'failed', 'an undeletable file is reported, never silent');
  assert.deepEqual(JSON.parse(last().details_json), { recovered: true, removed: 1, fileDeleteFailed: 1, hardLinked: 1, hardLinkedIndexed: 0, tmpRemoved: 0,
    objectsDeferred: false, leftover: 1, finishedGc: false });
  assert.ok(t.logs.some((l) => /blob store hygiene: .*hardLinked=1/.test(l)));
  // Once nothing the GC may have left remains (the second name gone, the young file aged), it is finished and closed.
  fs.unlinkSync(path.join(root, 'work', 'second-name')); age(freshUnindexed, 25 * 3600_000);
  const r3 = await t.exec.recoverBlobStore(t.sys);
  assert.equal(r3.objectsRemoved, 2); assert.equal(r3.objectsFailed, 0); assert.equal(r3.finishedGc, true);
  assert.equal(fs.existsSync(linked), false); assert.equal(fs.existsSync(freshUnindexed), false); assert.equal(fs.existsSync(indexed), true);
  assert.equal(last().status, 'succeeded'); assert.equal(JSON.parse(last().details_json).finishedGc, true);
  const r4 = await t.exec.recoverBlobStore(t.sys);
  assert.equal(r4.finishedGc, false); assert.equal(r4.objectsRemoved, 0);
  await assert.rejects(t.exec.recoverBlobStore(w.me), code('denied'));
  healthy(w); w.close();
});

test('D11 every recovery decision reads as a sentence; none says completed', () => {
  // B2a final review C1: through the real IPC mapping (dto.activityView), as the renderer receives the row.
  const say = (details) => ACT.activityText(ACT_DTO.activityView({ seq: 1, id: 'a', ts: h.NOW, actorKind: 'system', actorId: 'system', onBehalfOf: null,
    sessionId: null, jobId: 'j', attemptN: 1, workspaceId: 'sde', projectId: 'p', artifactId: null, versionId: null, entityType: 'job', entityId: 'j',
    action: 'exec.recover', status: 'succeeded', details, prevHash: '', hash: '' }), ACT_CTX);
  for (const d of ['requeue', 'retry', 'interrupt', 'reown', 'expire', 'adopt', 'finalize', 'fail', 'exit_lost', 'image_interrupted', 'orphans',
    'unknown_resources', 'unreconciled']) {
    const text = say({ decision: d, reason: 'x' });
    assert.ok(text.length > 0 && !text.startsWith('Recorded'), `${d}: ${text}`);
    assert.doesNotMatch(text, /\bcompleted\b/i, d);
  }
  assert.ok(ACT.ACTIVITY_ACTIONS.includes('exec.recover'));
  // finalize is said before the result is known (a non-zero exit too): it never reads as success.
  assert.doesNotMatch(say({ decision: 'finalize' }), /finish|success|succeed|complete|done|passed/i);
  assert.equal(say({ decision: 'fail', status: 'oom' }), 'Task failed: it ran out of memory while the app was closed');
  assert.equal(say({ decision: 'fail', status: 'nonzero_exit' }), 'Task failed: it stopped with an error while the app was closed');
  assert.equal(say({ decision: 'fail', status: 'invalid_output' }), 'Task failed: it stopped while the app was closed without the results it needs');
  assert.equal(say({ decision: 'fail' }), 'Task failed: it stopped while the app was closed');
  assert.match(say({ decision: 'exit_lost' }), /failed/);
  // Rows written by a real phase A read through the model.
  const w = execWorld({ realIngest: true }); w.attach();
  const j = w.exec.start(w.me, w.req('sde.build.run')).job; w.exec.tick(w.now());
  restart(w);
  const row = recoverActs(w, j.id)[0];
  assert.equal(ACT.activityText(actView(row), ACT_CTX), 'Task queued again after a restart: it had not started yet');
  assert.equal(actView(row).details.decision, 'requeue', 'the decision survives the IPC mapping');
  // Each decision keeps its own words; one this build does not know reads neutrally, never "recovered".
  assert.equal(say({ decision: 'interrupt' }), 'Task interrupted by a restart');
  assert.match(say({ decision: 'fail', status: 'something_new' }), /^Task failed/);
  assert.equal(say({ decision: 'brand_new' }), ACT.RECOVER_NEUTRAL);
  assert.equal(say({}), 'After a restart, Nexus recorded what to do with a task');
  assert.doesNotMatch(ACT.RECOVER_NEUTRAL, /recovered|complet|success/i);
  assert.equal(row.on_behalf_of, w.me.id);
  healthy(w); w.close();
});

// ---------- fix round 1 (review of b8b9bebd) ----------

test('F1 a durable exit is adopted for finalization whatever Docker says: Docker not up at the app restart, its container gone, a runner restart mid-ingest', async () => {
  // (a) RC18's state (exit durable, ingest never committed) and Docker not yet running at reconcile (the Windows boot order).
  const w = execWorld({ realIngest: true }); const r = w.attach();
  const d = provisioned(w, r, 'sde.tests.discover', 'a');
  const bj = provisioned(w, r, 'sde.build.run', 'b');
  const out = discoveryOutputs(w);
  const files = [w.file('dist/app.js', 'built')];
  const hold = w.nx.blobs.lock.tryExclusive();
  w.exitWith(r, d.job.id, { outputs: out.outputs, parsed: out.parsed });
  w.exitWith(r, bj.job.id, { code: 0, outputs: files });
  assert.equal(w.job(d.job.id).phase, 'collecting'); assert.equal(w.job(bj.job.id).phase, 'collecting');
  const c0 = completions(w);
  const t = restart(w);
  const b = t.exec.recoverPhaseB(t.sys, t.nx.bootId, rec([], [], 'stopped'));
  assert.equal(b.finalized, 2); assert.equal(b.interrupted, 0); assert.equal(b.requeued, 0);
  for (const a of [d.attempt, bj.attempt]) { assert.equal(w.attempt(a.id).state, 'running'); assert.equal(w.attempt(a.id).lease_owner, t.nx.bootId); }
  assert.deepEqual(t.runner.sentOf('attempt.adopt').map((m) => m.attemptId).sort(), [d.attempt.id, bj.attempt.id].sort());
  const ev = JSON.parse(recoveryEvents(w, bj.job.id)[0].data_json);
  assert.equal(ev.decision, 'finalize'); assert.equal(ev.reason, 'exit_durable'); assert.equal(ev.docker, 'down');
  assert.deepEqual(completions(w), c0);
  // The runner re-hashes /out from the data home (no Docker) and reports the exits again: each ingested once.
  reportExit(w, t.runner, d.attempt.id, out.outputs, out.parsed); reportExit(w, t.runner, bj.attempt.id, files);
  await settle(w, t);
  assert.equal(w.jobState(d.job.id), 'completed'); assert.equal(w.jobState(bj.job.id), 'completed');
  assert.equal(count(w, 'artifact_versions WHERE produced_by_job_id = ?', bj.job.id), 1);
  hold(); await w.exec.settled();
  assert.equal(count(w, 'artifact_versions WHERE produced_by_job_id = ?', bj.job.id), 1, 'the dead process\'s ingest writes nothing');
  healthy(w); w.close();
  // (b) Docker running, the container gone: a durable exit is still finalized, never abandoned.
  const w2 = execWorld({ realIngest: true }); const r2 = w2.attach();
  const d2 = provisioned(w2, r2, 'sde.tests.discover', 'a');
  const o2 = discoveryOutputs(w2);
  const hold2 = w2.nx.blobs.lock.tryExclusive();
  w2.exitWith(r2, d2.job.id, { outputs: o2.outputs, parsed: o2.parsed });
  const t2 = restart(w2);
  const b2 = t2.exec.recoverPhaseB(t2.sys, t2.nx.bootId, rec([entry(w2, d2.attempt.id, 'missing')]));
  assert.equal(b2.finalized, 1); assert.equal(w2.attempt(d2.attempt.id).state, 'running');
  reportExit(w2, t2.runner, d2.attempt.id, o2.outputs, o2.parsed); await settle(w2, t2);
  assert.equal(w2.jobState(d2.job.id), 'completed');
  hold2(); await w2.exec.settled();
  healthy(w2); w2.close();
  // (c) Mid-session: the runner restarts while this process ingests an exit; Docker reported stopped, then an empty staged
  // list for the same container. Recovery leaves the exit to the ingest in flight.
  const w3 = execWorld({ realIngest: true }); const r3 = w3.attach();
  const d3 = provisioned(w3, r3, 'sde.tests.discover', 'a');
  const o3 = discoveryOutputs(w3);
  const hold3 = w3.nx.blobs.lock.tryExclusive();
  w3.exitWith(r3, d3.job.id, { outputs: o3.outputs, parsed: o3.parsed });
  const b3 = w3.exec.recoverPhaseB(w3.sys, w3.bootId, rec([], [], 'stopped'));
  assert.equal(b3.decisions, 0);
  w3.exec.recoverPhaseB(w3.sys, w3.bootId, rec([entry(w3, d3.attempt.id, 'exited', { exit: exitAt(w3), staged: [] })]));
  assert.equal(w3.attempt(d3.attempt.id).state, 'running'); assert.equal(w3.jobState(d3.job.id), 'running');
  hold3(); await w3.settle();
  assert.equal(w3.jobState(d3.job.id), 'completed'); assert.ok(suiteOf(w3, d3.job.id));
  healthy(w3); w3.close();
});

test('F8 an attempt no phase B reconciled reads waiting:runner and fails runner_lost after 10 minutes; a durable exit keeps waiting', async () => {
  const w = execWorld({ realIngest: true }); const r = w.attach();
  const lost = provisioned(w, r, 'sde.tests.discover', 'a');
  const done = provisioned(w, r, 'sde.build.run', 'b');
  const files = [w.file('dist/app.js', 'x')];
  const hold = w.nx.blobs.lock.tryExclusive();
  w.exitWith(r, done.job.id, { code: 0, outputs: files });
  const t = restart(w);                                     // the runner is attached, but no reconcile answer ever comes
  assert.equal(t.exec.get(w.me, lost.job.id).headline, 'waiting:runner');
  assert.equal(t.exec.get(w.me, done.job.id).headline, 'waiting:runner');
  t.exec.tick(w.now());
  w.advance(R.RECONCILE_BOUND_MS - 5_000); t.exec.tick(w.now());
  assert.equal(w.attempt(lost.attempt.id).state, 'running', 'within the bound');
  w.advance(5_000); t.exec.tick(w.now());
  assert.equal(w.attempt(lost.attempt.id).state, 'failed'); assert.equal(w.attempt(lost.attempt.id).outcome, 'runner_lost');
  assert.equal(w.jobState(lost.job.id), 'retry_scheduled', 'runner_lost is retried when idempotent');
  assert.deepEqual(t.runner.sentOf('attempt.cancel').filter((m) => m.attemptId === lost.attempt.id).map((m) => m.reason), ['timeout'],
    'its container is told to stop (fix round 2)');
  assert.equal(t.runner.sentOf('attempt.cancel').filter((m) => m.attemptId === done.attempt.id).length, 0);
  assert.deepEqual(recoverActs(w, lost.job.id).map(decisionOf), ['unreconciled']);
  assert.deepEqual(recoveryEvents(w, lost.job.id).map(decisionOf), ['unreconciled']);
  assert.equal(w.attempt(done.attempt.id).state, 'running', 'a durable exit keeps waiting for finalization');
  w.advance(60_000); t.exec.tick(w.now());
  assert.equal(w.attempt(done.attempt.id).state, 'running');
  // A late phase B still finalizes it; its re-reported exit is ingested.
  t.exec.recoverPhaseB(t.sys, t.nx.bootId, rec());
  reportExit(w, t.runner, done.attempt.id, files); await settle(w, t);
  assert.equal(w.jobState(done.job.id), 'completed');
  hold(); await w.exec.settled();
  healthy(w); w.close();
});

test('F3 a phase B decision that fails keeps its attempt\'s resources (never listed for removal); the reconcile bound ends the attempt later', () => {
  const w = execWorld({ realIngest: true }); const r = w.attach();
  const stuck = provisioned(w, r, 'sde.build.run', 'a');
  const t = restart(w);
  w.db.exec(`CREATE TEMP TRIGGER t10_busy BEFORE UPDATE OF lease_owner ON job_attempts WHEN NEW.id = '${stuck.attempt.id}'
    BEGIN SELECT RAISE(ABORT, 'busy'); END`);
  const b = t.exec.recoverPhaseB(t.sys, t.nx.bootId, rec([entry(w, stuck.attempt.id, 'running')],
    [{ kind: 'container', id: 'a'.repeat(64), labels: labelsOf(w, stuck.attempt.id, stuck.job.id, { 'nexus.kind': 'tool' }) }]));
  w.db.exec('DROP TRIGGER t10_busy');
  assert.equal(b.errors, 1); assert.deepEqual(b.remove, []);
  assert.equal(w.attempt(stuck.attempt.id).state, 'running'); assert.equal(w.attempt(stuck.attempt.id).lease_owner, w.bootId);
  assert.equal(t.exec.get(w.me, stuck.job.id).headline, 'waiting:runner');
  t.exec.tick(w.now()); w.advance(R.RECONCILE_BOUND_MS); t.exec.tick(w.now());
  assert.equal(w.attempt(stuck.attempt.id).state, 'failed'); assert.equal(w.attempt(stuck.attempt.id).outcome, 'runner_lost');
  assert.equal(w.jobState(stuck.job.id), 'failed');
  healthy(w); w.close();
});

test('F6 blob hygiene: an indexed object with a second hard link is surfaced and kept; a failing listing never rejects and frees the lock', async () => {
  const w = execWorld({ realIngest: true }); w.attach();
  await w.dataHome.ensure();
  const root = w.dataHome.root;
  const sha = 'c'.repeat(64);
  const dir = path.join(root, 'objects', 'cc'); fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, sha.slice(2)); fs.writeFileSync(p, 'bytes');
  w.db.prepare('INSERT INTO blobs (sha256, bytes, media_type, created_at, last_referenced_at) VALUES (?, 5, ?, ?, ?)').run(sha, 'text/plain', w.now(), w.now());
  fs.linkSync(p, path.join(root, 'work', 'writable-second-name'));
  const t = restart(w);
  const r1 = await t.exec.recoverBlobStore(t.sys);
  assert.equal(r1.hardLinkedIndexed, 1); assert.equal(r1.objectsRemoved, 0); assert.equal(fs.existsSync(p), true);
  const last = w.db.prepare("SELECT * FROM activity WHERE action = 'blob.gc' ORDER BY seq DESC LIMIT 1").get();
  assert.equal(last.status, 'failed'); assert.equal(JSON.parse(last.details_json).hardLinkedIndexed, 1);
  assert.ok(t.logs.some((l) => /hardLinkedIndexed=1/.test(l)));
  const broken = { ...w.dataHome, listObjectFiles: () => Promise.reject(new Error('EIO')) };
  const t2 = restart(w, { dataHome: broken });
  const r2 = await t2.exec.recoverBlobStore(t2.sys);
  assert.equal(r2.ran, true); assert.equal(r2.reason, 'error');
  assert.equal(t2.nx.blobs.isExclusiveHeld(), false);
  assert.ok(t2.logs.some((l) => /blob store hygiene stopped \(Error\)/.test(l)));
  healthy(w); w.close();
});

test('F7 a staged list over 20,000 entries is dropped for its attempt only (it is adopted to report again); the runner contract is exported', () => {
  const w = execWorld({ realIngest: true }); const r = w.attach();
  const big = provisioned(w, r, 'sde.build.run', 'a');
  const other = provisioned(w, r, 'sde.build.run', 'b');
  const t = restart(w);
  const staged = Array.from({ length: 20_001 }, (_, i) => ({ relPath: `dist/f${i}.js`, sha256: 'a'.repeat(64), bytes: 1, mediaType: 'text/plain' }));
  const b = t.exec.recoverPhaseB(t.sys, t.nx.bootId, rec([entry(w, big.attempt.id, 'exited', { exit: exitAt(w), staged }), entry(w, other.attempt.id, 'running')]));
  assert.equal(b.finalized, 1); assert.equal(b.adopted, 1);
  assert.equal(JSON.parse(recoveryEvents(w, big.job.id)[0].data_json).staged, null);
  assert.ok(t.logs.some((l) => /1 staged list\(s\) over 20000 entries ignored/.test(l)));
  // A malformed staged entry still refuses the whole answer: nothing is decided from it.
  const acts = count(w, 'activity');
  assert.throws(() => t.exec.recoverPhaseB(t.sys, t.nx.bootId, rec([entry(w, other.attempt.id, 'exited', { exit: exitAt(w),
    staged: [{ relPath: '../evil', sha256: 'a'.repeat(64), bytes: 1, mediaType: 'text/plain' }] })])), code('invalid', 'bad_reconcile'));
  assert.equal(count(w, 'activity'), acts);
  const contract = R.RUNNER_RECOVERY_CONTRACT.join('\n');
  for (const needle of ['platform.bootId', 'reconcile.result', 'recoverPhaseB', 'never truncated', '20,000', 'nexus.home', 'resourceLabels',
    'reconcile.remove', 'no Docker needed', 'container: \'missing\'', 'recoverBlobStore', 'mid-session runner restart', '10 minutes']) {
    assert.ok(contract.includes(needle), needle);
  }
  healthy(w); w.close();
});

// ---------- fix round 2 (review of edb4089b) ----------

test('G1 the reconcile bound waits for a reconcile in flight: asked at 9:50, still live at 10:30, adopted at 10:40; an unanswered one waits at most 5 more minutes', () => {
  const MIN = 60_000;
  const w = execWorld({ realIngest: true }); const r = w.attach();
  const d = provisioned(w, r, 'sde.build.run', 'a');
  const t = restart(w);
  w.advance(9 * MIN + 50_000); t.exec.tick(w.now());
  assert.deepEqual(t.exec.reconcileList().map((x) => x.attemptId), [d.attempt.id]);     // main sends reconcile.list now
  w.advance(10_000); t.exec.tick(w.now());                                                 // 10:00
  w.advance(30_000); t.exec.tick(w.now());                                                 // 10:30
  assert.equal(w.attempt(d.attempt.id).state, 'running'); assert.equal(w.jobState(d.job.id), 'running');
  w.advance(10_000);                                                                        // 10:40: the answer
  const b = t.exec.recoverPhaseB(t.sys, t.nx.bootId, rec([entry(w, d.attempt.id, 'running')],
    [{ kind: 'container', id: 'a'.repeat(64), labels: labelsOf(w, d.attempt.id, d.job.id, { 'nexus.kind': 'tool' }) }]));
  assert.equal(b.adopted, 1); assert.deepEqual(b.remove, []);
  assert.equal(w.attempt(d.attempt.id).lease_owner, t.nx.bootId);
  healthy(w); w.close();
  // A request that is never answered: the bound counts from it (9:50 + 10 min) and waits 5 minutes more, then ends it.
  const w2 = execWorld({ realIngest: true }); const r2 = w2.attach();
  const d2 = provisioned(w2, r2, 'sde.build.run', 'b');
  const t2 = restart(w2);
  const a0 = w2.now();
  w2.advance(9 * MIN + 50_000); t2.exec.tick(w2.now()); t2.exec.reconcileList();
  w2.advance(10 * MIN + 5_000); t2.exec.tick(w2.now());                                    // past 19:50, but outstanding
  assert.equal(w2.attempt(d2.attempt.id).state, 'running');
  w2.advance(5 * MIN); t2.exec.tick(w2.now());                                             // past 24:50
  assert.equal(w2.attempt(d2.attempt.id).state, 'failed'); assert.equal(w2.attempt(d2.attempt.id).outcome, 'runner_lost');
  assert.ok(w2.now() - a0 >= 9 * MIN + 50_000 + R.RECONCILE_BOUND_MS + R.RECONCILE_WAIT_CAP_MS);
  healthy(w2); w2.close();
  // The rule itself (pure).
  const due = (s, now) => R.reconcileBoundDue(s, now);
  assert.equal(due({ recoveredAt: 0, requestedAt: null, outstanding: false }, 10 * MIN - 1), false);
  assert.equal(due({ recoveredAt: 0, requestedAt: null, outstanding: false }, 10 * MIN), true);
  assert.equal(due({ recoveredAt: 0, requestedAt: 9 * MIN, outstanding: false }, 10 * MIN), false, 'counted from the later request');
  assert.equal(due({ recoveredAt: 0, requestedAt: 9 * MIN, outstanding: false }, 19 * MIN), true);
  assert.equal(due({ recoveredAt: 0, requestedAt: 9 * MIN, outstanding: true }, 19 * MIN), false, 'an outstanding request waits');
  assert.equal(due({ recoveredAt: 0, requestedAt: 9 * MIN, outstanding: true }, 24 * MIN), true, 'at most 5 minutes more');
});

test('G2 an attempt the bound fails is told attempt.cancel after the commit when a runner is attached; without one nothing is sent and nothing throws', () => {
  const w = execWorld({ realIngest: true }); const r = w.attach();
  const d = provisioned(w, r, 'sde.build.run', 'a');
  const t = restart(w);
  t.exec.tick(w.now()); w.advance(R.RECONCILE_BOUND_MS); t.exec.tick(w.now());
  assert.equal(w.attempt(d.attempt.id).state, 'failed');
  const cancels = t.runner.sentOf('attempt.cancel').filter((m) => m.attemptId === d.attempt.id);
  assert.deepEqual(cancels, [{ op: 'attempt.cancel', attemptId: d.attempt.id, graceMs: 10_000, reason: 'timeout' }]);
  healthy(w); w.close();
  const w2 = execWorld({ realIngest: true }); const r2 = w2.attach();
  const d2 = provisioned(w2, r2, 'sde.build.run', 'b');
  const t2 = restart(w2, { noRunner: true });
  t2.exec.tick(w2.now()); w2.advance(R.RECONCILE_BOUND_MS); t2.exec.tick(w2.now());
  assert.equal(w2.attempt(d2.attempt.id).state, 'failed');
  assert.equal(t2.runner.sent.length, 0);
  healthy(w2); w2.close();
});

test('G3 nexus.home is one label per data home: Windows case variants, slashes, a trailing separator and the \\\\?\\ prefix agree; distinct homes differ', () => {
  const { homeLabel: shared, normalizeHomeRoot } = loadTs('src/shared/nexus/homeLabel.ts');
  const root = 'C:\\Users\\Pc\\AppData\\Roaming\\nexus-app\\nexus';
  const label = shared(root, 'win32');
  for (const v of [root.toLowerCase(), root.toUpperCase(), root.replace(/\\/g, '/'), `${root}\\`, `\\\\?\\${root}`, `\\\\?\\${root.toLowerCase()}`]) {
    assert.equal(shared(v, 'win32'), label, v);
  }
  assert.equal(normalizeHomeRoot(`\\\\?\\${root}`, 'win32'), root.toLowerCase());
  assert.equal(shared('\\\\?\\UNC\\server\\share\\nexus', 'win32'), shared('\\\\SERVER\\share\\nexus', 'win32'));
  assert.notEqual(shared('C:\\Users\\pc\\other\\nexus', 'win32'), label);
  // POSIX paths are case-sensitive: only resolution applies.
  assert.equal(shared('/home/u/.config/nexus/', 'linux'), shared('/home/u/.config/nexus', 'linux'));
  assert.notEqual(shared('/home/u/Nexus', 'linux'), shared('/home/u/nexus', 'linux'));
  assert.match(label, /^[0-9a-f]{16}$/);
});

test('G4 main and the runner share one homeLabel: hello carries home, and every plan label equals it', () => {
  const { homeLabel: shared } = loadTs('src/shared/nexus/homeLabel.ts');
  const w = execWorld({ realIngest: true }); const r = w.attach();
  const hello = r.sentOf('hello')[0];
  assert.equal(hello.home, shared(w.dataHome.root)); assert.equal(hello.dataHome, w.dataHome.root);
  assert.equal(homeLabel, shared, 'planBuilder re-exports the shared function');
  const d = provisioned(w, r, 'sde.build.run', 'a');
  const plan = r.sentOf('attempt.start').find((m) => m.attemptId === d.attempt.id).plan;
  assert.equal(plan.container.labels['nexus.home'], hello.home); assert.equal(plan.resourceLabels['nexus.home'], hello.home);
  const contract = R.RUNNER_RECOVERY_CONTRACT.join('\n');
  for (const needle of ['`hello` carries `home`', 'src/shared/nexus/homeLabel.ts', 'exactly when it sends `reconcile.list`', 'up to 5 more minutes',
    'main sends `attempt.cancel`']) {
    assert.ok(contract.includes(needle), needle);
  }
  healthy(w); w.close();
});

test('G5 a GC run whose only leftovers are refused deletes is closed (leftover counted); the hard link is still reported failed on every pass', async () => {
  const w = execWorld({ realIngest: true }); w.attach();
  await w.dataHome.ensure();
  const root = w.dataHome.root;
  const sha = 'd'.repeat(64);
  const dir = path.join(root, 'objects', 'dd'); fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, sha.slice(2)); fs.writeFileSync(p, 'left');
  const t0 = new Date(w.now() - 25 * 3600_000); fs.utimesSync(p, t0, t0);
  fs.linkSync(p, path.join(root, 'work', 'second-name'));
  const { appendActivityRow } = loadTs('src/main/nexus/activity/writer.ts');
  w.db.transaction(() => appendActivityRow(w.db, { actorKind: 'system', actorId: w.sys.id, entityType: 'blob', action: 'blob.gc', status: 'started',
    details: { removed: 1, bytes: 4 } }, w.now())).immediate();
  const t = restart(w);
  const r1 = await t.exec.recoverBlobStore(t.sys);
  assert.equal(r1.finishedGc, true, 'closed: the only leftover is a refused delete');
  assert.equal(r1.leftover, 1); assert.equal(r1.objectsFailed, 1); assert.equal(r1.hardLinked, 1); assert.equal(fs.existsSync(p), true);
  const rows = () => w.db.prepare("SELECT status, details_json FROM activity WHERE action = 'blob.gc' ORDER BY seq").all();
  const first = rows().at(-1);
  assert.equal(first.status, 'failed');
  assert.deepEqual(JSON.parse(first.details_json), { recovered: true, removed: 0, fileDeleteFailed: 1, hardLinked: 1, hardLinkedIndexed: 0, tmpRemoved: 0,
    objectsDeferred: false, leftover: 1, finishedGc: true });
  const r2 = await t.exec.recoverBlobStore(t.sys);
  assert.equal(r2.finishedGc, false, 'the run is closed'); assert.equal(r2.objectsFailed, 1); assert.equal(r2.leftover, 1);
  assert.equal(rows().at(-1).status, 'failed', 'the hard link is reported again');
  assert.equal(rows().length, 3);
  healthy(w); w.close();
});

// ---------- fix round 3 (review of 889ca6ad) ----------

test('G6 repeated reconcile requests never postpone the bound: unanswered requests every 4 minutes end the attempt by the first request + 15 minutes', () => {
  const MIN = 60_000;
  const w = execWorld({ realIngest: true }); const r = w.attach();
  const d = provisioned(w, r, 'sde.build.run', 'a');
  const t = restart(w);
  w.advance(MIN); t.exec.tick(w.now());
  const first = w.now(); t.exec.reconcileList();                       // the first request after phase A
  let failedAt = null;
  while (w.now() - first < 20 * MIN) {
    w.advance(MIN);
    if ((w.now() - first) % (4 * MIN) === 0) t.exec.reconcileList();   // a crash-looping runner asks again every 4 minutes
    t.exec.tick(w.now());
    if (failedAt === null && w.attempt(d.attempt.id).state === 'failed') failedAt = w.now();
  }
  assert.ok(failedAt !== null, 'ended by the bound');
  assert.ok(failedAt - first >= R.RECONCILE_BOUND_MS, 'not before the first request + 10 minutes');
  assert.ok(failedAt - first <= R.RECONCILE_BOUND_MS + R.RECONCILE_WAIT_CAP_MS, `by the first request + 15 minutes (${(failedAt - first) / MIN} min)`);
  assert.equal(w.attempt(d.attempt.id).outcome, 'runner_lost');
  healthy(w); w.close();
});

test('G7 a runner that answers every 8 minutes while its decision keeps failing cannot postpone the bound: ended by the first request + 10 minutes', () => {
  const MIN = 60_000;
  const w = execWorld({ realIngest: true }); const r = w.attach();
  const d = provisioned(w, r, 'sde.build.run', 'a');
  const t = restart(w);
  w.db.exec(`CREATE TEMP TRIGGER t10_r3 BEFORE UPDATE OF lease_owner ON job_attempts WHEN NEW.id = '${d.attempt.id}'
    BEGIN SELECT RAISE(ABORT, 'busy'); END`);
  let first = null; let failedAt = null; let answers = 0;
  for (let m = 1; m <= 16; m++) {
    w.advance(MIN);
    if (m % 8 === 1) {                                                    // ready, reconcile.list, the answer: its adopt fails
      t.exec.reconcileList(); first ??= w.now();
      const b = t.exec.recoverPhaseB(t.sys, t.nx.bootId, rec([entry(w, d.attempt.id, 'running')]));
      assert.equal(b.errors, 1); answers++;
    }
    t.exec.tick(w.now());
    if (failedAt === null && w.attempt(d.attempt.id).state === 'failed') failedAt = w.now();
  }
  w.db.exec('DROP TRIGGER t10_r3');
  assert.equal(answers, 2, 'answered at 1 and 9 minutes');
  assert.ok(failedAt !== null && failedAt - first >= R.RECONCILE_BOUND_MS && failedAt - first <= R.RECONCILE_BOUND_MS + MIN,
    `ended at the first request + 10 minutes (${failedAt === null ? 'never' : (failedAt - first) / MIN} min)`);
  assert.equal(w.attempt(d.attempt.id).outcome, 'runner_lost'); assert.equal(w.jobState(d.job.id), 'failed');
  healthy(w); w.close();
});
