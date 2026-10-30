'use strict';
// B2a Task 9: once-only approvals for dependency egress (A1) and image preparation (A2), image build records, local dev
// deployments with health probes, and repository snapshot rules. Real SQLite (Electron-as-node, `npm run test:db`), the
// execution core driven through a FakeRunner (no Docker, no runner process). Authorization is never mocked.
// A1-A10 approvals and images; D1-D8 dev deployments (N9's deployment part in D1b); R1-R3 snapshots; then the network and
// approval bypasses (constraint 11), secrets (constraint 6) and state rebuilt from SQLite alone (constraint 9). Every flow
// ends with O1-O17 at 0, an empty foreign_key_check and a verified activity chain.
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const loadTs = require('./load-ts.cjs');
const { execWorld, passingPreflight, PROFILES, GIB } = require('./helpers/execWorld.cjs');
const { FakeRunner } = require('./helpers/fakeRunner.cjs');
const { ALL_ZERO, execOrphanRows } = require('./helpers/orphans.cjs');
const { verifyActivityChain } = loadTs('src/main/nexus/activity/writer.ts');
const { buildPlan } = loadTs('src/main/nexus/exec/planBuilder.ts');
const { getRecipe } = loadTs('src/shared/nexus/recipes.ts');
const { newId } = loadTs('src/main/nexus/db/ids.ts');
const { canonicalJson } = loadTs('src/main/nexus/db/canonical.ts');
const { parseRunnerMessage } = loadTs('src/shared/nexus/runnerProtocol.ts');
const { checkoutNote, snapshotFacts } = loadTs('src/shared/nexus/repoSnapshot.ts');
const { requestHoldsSecret } = loadTs('src/main/nexus/approvals/approvalService.ts');
const { acceptManifestReport, APP_MANIFEST_MAX_BYTES } = loadTs('src/main/nexus/repo/repoService.ts');
const { trailing } = loadTs('src/main/nexus/deployments/deploymentService.ts');
const { createNexusPlatform } = loadTs('src/main/nexus/platform.ts');
const { hasProviderKey } = loadTs('src/shared/nexus/secretShape.ts');
const { endCause } = loadTs('src/main/nexus/deployments/deploymentService.ts');

const code = (c, reason) => (e) => e.code === c && (reason === undefined || e.detail?.reason === reason);
const MIN = 60_000;
const LOCK = '3f'.repeat(32);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const MANIFEST = { version: 1, profile: 'sde-node', run: ['node', 'dist/server.js'], port: 3000, healthPath: '/health', env: [] };
const CTX = { contextSha256: 'c4'.repeat(32), baseDigest: 'sha256:' + 'b5'.repeat(32), estimatedBytes: 3 * GIB };
const count = (w, sql, ...a) => w.db.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get(...a).n;
// The renderer's sentences for activity rows (src/renderer/src/nexus/project/activityModel.ts), loaded as the UI does.
const ACT = loadTs('src/renderer/src/nexus/project/activityModel.ts');
const ACT_CTX = { names: new Map(), versionNos: new Map(), workspaceLabel: (x) => x, now: h.NOW };
/** An activity row as the activity channel shows it (no principal ids; the model reads only allow-listed details). */
// B2a final review C1: the view comes from the real IPC mapping (writer.toEntry, then dto.activityView), so a detail
// key the DTO drops is dropped here too and the sentence reads what the renderer really receives.
const ACT_DTO = loadTs('src/main/nexusIpc/dto.ts');
const { toEntry: actEntry } = loadTs('src/main/nexus/activity/writer.ts');
const actView = (r) => ACT_DTO.activityView(actEntry(r));
const acts = (w, action, entityId) => w.db.prepare(`SELECT * FROM activity WHERE action = ?${entityId ? ' AND entity_id = ?' : ''} ORDER BY seq`)
  .all(...(entityId ? [action, entityId] : [action]));
/** Every text column of the execution records, for secret scans. */
function recordTexts(w) {
  const out = [];
  for (const [t, cols] of [['approvals', ['summary', 'request_json']], ['image_builds', ['error_json', 'log_path']], ['deployments', ['health_json']],
    ['job_events', ['summary', 'data_json']], ['activity', ['details_json']], ['jobs', ['error_json', 'params_json', 'phase']],
    ['job_attempts', ['error_json', 'sandbox_json', 'environment_json']]]) {
    for (const r of w.db.prepare(`SELECT ${cols.join(', ')} FROM ${t}`).all()) for (const c of cols) if (typeof r[c] === 'string') out.push(`${t}.${c}: ${r[c]}`);
  }
  return out;
}
const approvalOf = (w, jobId) => w.db.prepare('SELECT * FROM approvals WHERE job_id = ? ORDER BY requested_at DESC, rowid DESC').get(jobId);

function healthy(w) {
  assert.deepEqual(w.orphans(), ALL_ZERO, JSON.stringify(execOrphanRows(w.db)));
  assert.deepEqual(w.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(verifyActivityChain(w.db).ok, true);
}

/** A world whose egress port is the platform's own ApprovalService, with a locked repository snapshot. */
function egressWorld(o = {}) {
  const w = execWorld({ approvals: 'real', repoMeta: { lockfile: { sha256: LOCK } }, dockerMemoryBytes: 64 * GIB, ...o });
  const r = w.attach();
  return { w, r };
}

/** Starts a dependency install and leases it (it waits for approval). */
function depsJob(w) {
  const d = w.exec.start(w.me, w.req('sde.deps.install')).job;
  w.exec.tick(w.now());
  return d;
}

// ---------- A: approvals ----------

test('A1 a dependency install waits in awaiting_approval with one pending approval naming the registries and the lockfile hash; nothing starts', () => {
  const { w, r } = egressWorld();
  const d = depsJob(w);
  assert.equal(w.jobState(d.id), 'awaiting_approval');
  assert.equal(w.liveAttempt(d.id).state, 'starting');
  const aps = w.db.prepare('SELECT * FROM approvals WHERE job_id = ?').all(d.id);
  assert.equal(aps.length, 1);
  const ap = aps[0];
  assert.equal(ap.status, 'pending'); assert.equal(ap.reason, 'egress.deps'); assert.equal(ap.project_id, 'p-ledger');
  const req = JSON.parse(ap.request_json);
  assert.deepEqual(req, { recipeId: 'sde.deps.node', recipeVersion: '1', jobId: d.id, lockfileSha256: LOCK, profile: 'sde-node',
    registries: ['registry.npmjs.org'] });
  assert.equal(ap.request_sha256, sha(canonicalJson({ recipeId: 'sde.deps.node', recipeVersion: '1', jobId: d.id, lockfileSha256: LOCK, profile: 'sde-node' })));
  assert.equal(ap.expires_at - ap.requested_at, 15 * MIN);
  assert.equal(ap.requested_by, 'system'); assert.equal(ap.on_behalf_of, w.me.id);
  assert.equal(r.sentOf('attempt.start').length, 0, 'the runner received no start');
  // leased -> running (phase approval) -> awaiting_approval, with the approval, in ONE transaction (one timestamp).
  const moves = w.events(d.id, 'job.transition').map((e) => ({ ...JSON.parse(e.data_json), ts: e.ts }));
  assert.deepEqual(moves.slice(-3).map((m) => `${m.from}>${m.to}`), ['queued>leased', 'leased>running', 'running>awaiting_approval']);
  assert.equal(new Set([...moves.slice(-3).map((m) => m.ts), ap.requested_at]).size, 1);
  assert.equal(w.exec.list(w.me, { projectId: 'p-ledger' }).jobs.find((j) => j.id === d.id).headline, 'waiting_for_approval');
  // Observability: who asked (the system), for whom (the user), why (egress.deps), and the event of the wait.
  const ev = w.db.prepare("SELECT * FROM job_events WHERE approval_id = ? AND type = 'approval'").all(ap.id);
  assert.equal(ev.length, 1); assert.equal(ev[0].job_id, d.id); assert.equal(ev[0].attempt_n, 1);
  // The activity row (constraint 13): the system asked, on the user's behalf, with the request's facts (fix round 1, AR1).
  const act = w.db.prepare("SELECT * FROM activity WHERE action = 'approval.request' AND entity_id = ?").all(ap.id);
  assert.equal(act.length, 1);
  assert.equal(act[0].actor_kind, 'system'); assert.equal(act[0].on_behalf_of, w.me.id); assert.equal(act[0].job_id, d.id);
  assert.equal(act[0].attempt_n, 1); assert.equal(act[0].project_id, 'p-ledger'); assert.equal(act[0].workspace_id, 'sde');
  assert.deepEqual(JSON.parse(act[0].details_json), { reason: 'egress.deps', recipeId: 'sde.deps.node', recipeVersion: '1', profile: 'sde-node',
    registries: ['registry.npmjs.org'], lockfile: { sha256: LOCK }, request: { sha256: ap.request_sha256 }, expiresAt: ap.expires_at });
  assert.equal(ACT.activityText(actView(act[0]), ACT_CTX), 'Asked for your OK: download the add-ons your project needs');
  // The view names no principal and shows the request's known fields.
  const view = w.nx.approvals.list(w.me, { projectId: 'p-ledger' }).approvals[0];
  assert.equal(view.id, ap.id); assert.deepEqual(view.request.registries, ['registry.npmjs.org']); assert.equal(view.request.lockfileSha256, LOCK);
  assert.ok(!JSON.stringify(view).includes('user:local') && !JSON.stringify(view).includes('"system"'));
  healthy(w); w.close();
});

test('A1b a Python install names its two registries; a snapshot without a lockfile hash fails at lease and asks nothing', () => {
  const { w } = egressWorld({ profile: 'sde-python' });
  const d = depsJob(w);
  assert.deepEqual(JSON.parse(approvalOf(w, d.id).request_json).registries, ['pypi.org', 'files.pythonhosted.org']);
  assert.equal(JSON.parse(approvalOf(w, d.id).request_json).recipeId, 'sde.deps.python');
  w.close();
  const w2 = execWorld({ approvals: 'real' }); const r2 = w2.attach();
  const d2 = depsJob(w2);
  assert.equal(w2.jobState(d2.id), 'failed');
  assert.equal(JSON.parse(w2.job(d2.id).error_json).code, 'lockfile_missing');
  assert.equal(count(w2, 'approvals'), 0); assert.equal(r2.sentOf('attempt.start').length, 0);
  assert.equal(w2.attempts(d2.id)[0].state, 'failed');
  healthy(w2); w2.close();
});

test('A2 once: approved, consumed by the current attempt, the job running and the plan egress-approved with this approval, in one transaction', () => {
  const { w, r } = egressWorld();
  const d = depsJob(w); const ap = approvalOf(w, d.id); const a = w.liveAttempt(d.id);
  w.advance(1000);
  const v = w.nx.approvals.respond(w.me, ap.id, 'once');
  assert.equal(v.status, 'approved'); assert.equal(v.decision, 'once');
  const row = approvalOf(w, d.id);
  assert.equal(row.decided_by, w.me.id); assert.equal(row.consumed_at, w.now()); assert.equal(row.consumed_by_job_id, d.id);
  assert.equal(row.consumed_by_attempt_n, a.n);
  assert.equal(w.jobState(d.id), 'running');
  assert.equal(w.job(d.id).state_changed_at, row.consumed_at, 'the job moved in the approval transaction');
  const starts = r.sentOf('attempt.start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].attemptId, a.id);
  assert.deepEqual(starts[0].plan.container.network, { mode: 'egress-approved', approvalId: ap.id, purpose: 'deps' });
  assert.equal(JSON.parse(w.attempt(a.id).sandbox_json).network.approvalId, ap.id);
  const ev = w.db.prepare("SELECT * FROM job_events WHERE approval_id = ? AND type = 'approval' ORDER BY seq").all(ap.id).map((e) => JSON.parse(e.data_json));
  assert.equal(ev.length, 2); assert.equal(ev[0].approvalId, ap.id); assert.equal(ev[1].status, 'approved');
  assert.ok(!JSON.stringify(w.exec.eventsSince(w.me, { sinceSeq: 0, projectId: 'p-ledger' })).includes('user:local'), 'events name no principal');
  // The install runs and reports; dependency installs are ingested in Task 12 (no rule yet): never completed here.
  w.provision(r, d.id);
  assert.equal(w.jobState(d.id), 'running');
  healthy(w); w.close();
});

test('A2b once while the caps refuse: the approval is consumed, the job waits (phase waiting:slots), and the scheduler starts it later', () => {
  const { w, r } = egressWorld();
  const d = depsJob(w); const ap = approvalOf(w, d.id);
  const builds = [0, 1, 2].map(() => w.exec.start(w.me, w.req('sde.build.run')).job); w.exec.tick(w.now());
  assert.ok(builds.every((b) => w.jobState(b.id) === 'leased'));
  const v = w.nx.approvals.respond(w.me, ap.id, 'once');
  assert.equal(v.status, 'approved'); assert.notEqual(v.consumedAt, null);
  assert.equal(w.jobState(d.id), 'awaiting_approval'); assert.equal(w.job(d.id).phase, 'waiting:slots');
  assert.equal(r.sentOf('attempt.start').filter((m) => m.plan.jobId === d.id).length, 0);
  w.exec.tick(w.now());
  assert.equal(w.jobState(d.id), 'awaiting_approval', 'still no slot');
  w.exec.cancel(w.me, builds[0].id);
  w.exec.tick(w.now());
  assert.equal(w.jobState(d.id), 'running');
  assert.equal(r.lastStart().plan.container.network.approvalId, ap.id);
  healthy(w); w.close();
});

test('A3 deny: the approval is denied, the job fails denied, no plan is sent', () => {
  const { w, r } = egressWorld();
  const d = depsJob(w); const ap = approvalOf(w, d.id); const a = w.liveAttempt(d.id);
  const v = w.nx.approvals.respond(w.me, ap.id, 'deny');
  assert.equal(v.status, 'denied'); assert.equal(v.decision, 'deny'); assert.equal(v.consumedAt, null);
  assert.equal(w.jobState(d.id), 'failed'); assert.equal(w.job(d.id).outcome, 'denied');
  assert.equal(JSON.parse(w.job(d.id).error_json).code, 'approval_denied');
  assert.equal(w.attempt(a.id).state, 'failed'); assert.equal(w.attempt(a.id).outcome, 'denied');
  assert.equal(r.sentOf('attempt.start').length, 0);
  w.run(r, 2 * MIN);
  assert.equal(w.jobState(d.id), 'failed', 'never retried'); assert.equal(r.sentOf('attempt.start').length, 0);
  healthy(w); w.close();
});

test('A4 expiry: unanswered for 15 minutes the approval expires and the job fails denied; an answer after that is refused', () => {
  const { w, r } = egressWorld();
  const d = depsJob(w); const ap = approvalOf(w, d.id);
  w.run(r, 14 * MIN);
  assert.equal(approvalOf(w, d.id).status, 'pending'); assert.equal(w.jobState(d.id), 'awaiting_approval');
  w.run(r, 90_000);
  assert.equal(approvalOf(w, d.id).status, 'expired');
  assert.equal(w.jobState(d.id), 'failed'); assert.equal(w.job(d.id).outcome, 'denied');
  assert.equal(JSON.parse(w.job(d.id).error_json).code, 'approval_expired');
  assert.throws(() => w.nx.approvals.respond(w.me, ap.id, 'once'), code('illegal_transition'));
  assert.equal(r.sentOf('attempt.start').length, 0);
  // An answer that arrives after expires_at but before the sweep expires it and is refused.
  const d2 = depsJob(w); const ap2 = approvalOf(w, d2.id);
  w.advance(15 * MIN + 1);
  assert.throws(() => w.nx.approvals.respond(w.me, ap2.id, 'once'), code('illegal_transition', 'expired'));
  assert.equal(approvalOf(w, d2.id).status, 'expired'); assert.equal(w.jobState(d2.id), 'failed');
  assert.equal(r.sentOf('attempt.start').length, 0);
  healthy(w); w.close();
});

test('A5 a second answer is illegal_transition (after once and after deny)', () => {
  const { w } = egressWorld();
  const d1 = depsJob(w); const a1 = approvalOf(w, d1.id);
  w.nx.approvals.respond(w.me, a1.id, 'once');
  assert.throws(() => w.nx.approvals.respond(w.me, a1.id, 'once'), code('illegal_transition'));
  assert.throws(() => w.nx.approvals.respond(w.me, a1.id, 'deny'), code('illegal_transition'));
  const d2 = depsJob(w); const a2 = approvalOf(w, d2.id);
  w.nx.approvals.respond(w.me, a2.id, 'deny');
  assert.throws(() => w.nx.approvals.respond(w.me, a2.id, 'once'), code('illegal_transition'));
  assert.equal(approvalOf(w, d2.id).status, 'denied');
  // No "always" or "for the session": only once or deny.
  const d3 = depsJob(w); const a3 = approvalOf(w, d3.id);
  for (const bad of ['always', 'session', 'ONCE', '', null]) assert.throws(() => w.nx.approvals.respond(w.me, a3.id, bad), code('invalid', 'bad_decision'));
  assert.equal(approvalOf(w, d3.id).status, 'pending');
  healthy(w); w.close();
});

test('A6 an approval of job A never starts job B: the plan builder refuses it, the database refuses it, the runner\'s refusal fails the job', () => {
  const { w, r } = egressWorld();
  const A = depsJob(w); const B = depsJob(w);
  const apA = approvalOf(w, A.id); const apB = approvalOf(w, B.id);
  w.nx.approvals.respond(w.me, apA.id, 'once');
  assert.equal(w.jobState(A.id), 'running'); assert.equal(w.jobState(B.id), 'awaiting_approval');
  assert.equal(r.sentOf('attempt.start').filter((m) => m.plan.jobId === B.id).length, 0);
  // The plan builder: A's consumed approval in B's plan.
  const rowA = w.db.prepare('SELECT id, job_id, status, consumed_at, consumed_by_job_id, consumed_by_attempt_n FROM approvals WHERE id = ?').get(apA.id);
  const bA = w.liveAttempt(B.id);
  const base = { job: { id: B.id, projectId: 'p-ledger' }, attempt: { id: bA.id, n: bA.n }, bootId: w.bootId, recipe: getRecipe('sde.deps.node'),
    profile: PROFILES[0], imageId: w.IMAGE['sde-node'], dataHomeRoot: w.dataHome.root, workRel: 'work/b/1', logRel: 'logs/jobs/b/1.log', inputs: [] };
  assert.throws(() => buildPlan({ ...base, approval: rowA }), code('invalid', 'network_not_approved'));
  // The core: resuming B with only A's approval in the database is refused, and nothing is sent for B.
  assert.throws(() => w.exec.resumeApproved(B.id), code('invalid', 'network_not_approved'));
  assert.equal(w.jobState(B.id), 'awaiting_approval');
  w.exec.tick(w.now());
  assert.equal(r.sentOf('attempt.start').filter((m) => m.plan.jobId === B.id).length, 0);
  // The database: B's approval cannot be consumed for another job (CHECK consumed_by_job_id IS job_id).
  assert.throws(() => w.db.prepare(`UPDATE approvals SET status = 'approved', decided_by = 'user:local', decided_at = ?, decision = 'once',
    consumed_at = ?, consumed_by_job_id = ?, consumed_by_attempt_n = 1, status_changed_at = ? WHERE id = ?`).run(w.now(), w.now(), A.id, w.now(), apB.id), /CHECK/);
  assert.equal(approvalOf(w, B.id).status, 'pending');
  // The runner refuses a plan whose approval id does not match: the job fails (not requeued, not retried).
  const aA = w.liveAttempt(A.id);
  r.report({ op: 'attempt.refused', attemptId: aA.id, reason: 'network_not_approved', detail: 'approval id mismatch' });
  assert.equal(w.jobState(A.id), 'failed'); assert.equal(w.attempt(aA.id).outcome, 'network_not_approved');
  w.run(r, 2 * MIN);
  assert.equal(w.jobState(A.id), 'failed');
  healthy(w); w.close();
});

test('A6b an approval consumed by attempt 1 never serves attempt 2 of the same job', () => {
  const { w, r } = egressWorld();
  const d = depsJob(w); const ap1 = approvalOf(w, d.id);
  w.nx.approvals.respond(w.me, ap1.id, 'once');
  const a1 = w.provision(r, d.id);
  // The container vanishes: an idempotent install is retried with attempt 2.
  r.report({ op: 'attempt.heartbeat', attemptId: a1.id, at: w.now(), logBytes: 0, outBytes: 0, container: 'missing' });
  assert.equal(w.jobState(d.id), 'retry_scheduled');
  w.run(r, 15_000);
  assert.equal(w.jobState(d.id), 'awaiting_approval'); assert.equal(w.liveAttempt(d.id).n, 2);
  const ap2 = approvalOf(w, d.id);
  assert.notEqual(ap2.id, ap1.id); assert.equal(ap2.status, 'pending');
  const startsBefore = r.sentOf('attempt.start').length;
  assert.throws(() => w.exec.resumeApproved(d.id), code('invalid', 'network_not_approved'));
  w.run(r, 30_000);
  assert.equal(r.sentOf('attempt.start').length, startsBefore, 'attempt 1\'s approval starts nothing');
  w.nx.approvals.respond(w.me, ap2.id, 'once');
  assert.equal(r.lastStart().plan.container.network.approvalId, ap2.id); assert.equal(r.lastStart().plan.attemptN, 2);
  healthy(w); w.close();
});

test('A7 cancel while waiting withdraws the pending approval; a withdrawn approval starts nothing', () => {
  const { w, r } = egressWorld();
  const d = depsJob(w); const ap = approvalOf(w, d.id);
  w.exec.cancel(w.me, d.id);
  assert.equal(approvalOf(w, d.id).status, 'withdrawn'); assert.equal(w.jobState(d.id), 'cancelled');
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM activity WHERE action = 'approval.withdraw' AND entity_id = ?").get(ap.id).n, 1);
  assert.throws(() => w.nx.approvals.respond(w.me, ap.id, 'once'), code('illegal_transition'));
  assert.throws(() => w.exec.resumeApproved(d.id), code('illegal_transition'));
  w.run(r, MIN);
  assert.equal(r.sentOf('attempt.start').length, 0);
  healthy(w); w.close();
});

test('A8 only a user answers: the system principal, an agent or a non-owner is denied (audited); the database refuses a non-user decision (T11)', () => {
  const { w, r } = egressWorld();
  const d = depsJob(w); const ap = approvalOf(w, d.id);
  assert.throws(() => w.nx.approvals.respond(w.sys, ap.id, 'once'), code('denied', 'user_only'));
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM activity WHERE status = 'denied' AND actor_id = 'system' AND action = 'approval.respond'").get().n, 1);
  w.db.prepare("INSERT INTO principals VALUES ('agent:bot', 'agent', 'bot', NULL, ?)").run(h.NOW);
  assert.throws(() => w.nx.approvals.respond({ id: 'agent:bot', kind: 'agent', displayName: 'bot' }, ap.id, 'once'), code('denied', 'user_only'));
  assert.throws(() => w.nx.approvals.respond({ id: 'system', kind: 'user', displayName: 'forged' }, ap.id, 'once'), code('denied', 'user_only'));
  const member = w.addUser('user:member', 'project', 'p-ledger', 'member');
  assert.throws(() => w.nx.approvals.respond(member, ap.id, 'once'), code('denied'));
  assert.equal(approvalOf(w, d.id).status, 'pending'); assert.equal(w.jobState(d.id), 'awaiting_approval');
  // T11: the trigger refuses an approval decided by the system, whatever the service says.
  assert.throws(() => w.db.prepare(`UPDATE approvals SET status = 'approved', decided_by = 'system', decided_at = ?, decision = 'once',
    status_changed_at = ? WHERE id = ?`).run(w.now(), w.now(), ap.id), /only a user approves or denies/);
  assert.throws(() => w.db.prepare(`UPDATE approvals SET status = 'denied', decided_by = 'agent:bot', decided_at = ?, decision = 'deny',
    status_changed_at = ? WHERE id = ?`).run(w.now(), w.now(), ap.id), /only a user approves or denies/);
  assert.equal(approvalOf(w, d.id).status, 'pending');
  assert.equal(r.sentOf('attempt.start').length, 0);
  healthy(w); w.close();
});

// ---------- A9-A10: image preparation and image builds ----------

function imageWorld(o = {}) {
  const w = execWorld({ approvals: 'real', imageContexts: (id) => (id === 'sde-node' || id === 'nexus-fwd' ? CTX : null), ...o });
  const r = w.attach();
  return { w, r };
}

test('A9 image preparation: below 30 GiB free nothing is written; then an approval with sizes, once -> a running build, done -> succeeded', () => {
  const { w, r } = imageWorld({ freeBytes: 20 * GIB });
  assert.throws(() => w.nx.approvals.requestImage(w.me, 'sde-node', 'img-1'), code('unavailable', 'setup:disk_low'));
  assert.equal(count(w, 'approvals'), 0);
  w.setProbe({ freeBytes: 45 * GIB });
  const { approval, created } = w.nx.approvals.requestImage(w.me, 'sde-node', 'img-1');
  assert.equal(created, true); assert.equal(approval.status, 'pending'); assert.equal(approval.reason, 'image.prepare');
  assert.deepEqual(approval.request, { profileId: 'sde-node', contextSha256: CTX.contextSha256, baseDigest: CTX.baseDigest,
    estimatedBytes: 3 * GIB, freeBytesNow: 45 * GIB });
  assert.equal(approval.projectId, null); assert.equal(approval.jobId, null);
  const row = w.db.prepare('SELECT * FROM approvals WHERE id = ?').get(approval.id);
  assert.equal(row.request_sha256, sha(canonicalJson({ profileId: 'sde-node', contextSha256: CTX.contextSha256, baseDigest: CTX.baseDigest, estimatedBytes: 3 * GIB })));
  // A second request while one is pending returns it.
  assert.equal(w.nx.approvals.requestImage(w.me, 'sde-node', 'img-2').approval.id, approval.id);
  assert.equal(w.nx.approvals.requestImage(w.me, 'sde-node', 'img-2').created, false);
  const v = w.nx.approvals.respond(w.me, approval.id, 'once');
  assert.equal(v.status, 'approved'); assert.equal(v.imageBuild.status, 'running');
  const b = w.db.prepare('SELECT * FROM image_builds WHERE approval_id = ?').get(approval.id);
  assert.equal(b.status, 'running'); assert.equal(b.profile_id, 'sde-node'); assert.equal(b.context_sha256, CTX.contextSha256);
  assert.equal(b.requested_by, w.me.id); assert.equal(b.started_at, w.db.prepare('SELECT consumed_at FROM approvals WHERE id = ?').get(approval.id).consumed_at);
  assert.deepEqual(r.sentOf('image.build.start'), [{ op: 'image.build.start', buildId: b.id, profile: 'sde-node', approvalId: approval.id, contextSha256: CTX.contextSha256 }]);
  // A second request while the build runs: conflict.
  assert.throws(() => w.nx.approvals.requestImage(w.me, 'sde-node', 'img-3'), code('conflict', 'build_running'));
  r.report({ op: 'image.build.progress', buildId: b.id, at: w.now(), phase: 'pulling base', bytes: 100 });
  r.report({ op: 'image.build.progress', buildId: b.id, at: w.now(), phase: 'pulling base', bytes: 200 });
  assert.equal(count(w, "job_events WHERE image_build_id = ? AND type = 'image_build' AND summary LIKE '%pulling base%'", b.id), 1, 'one event per phase');
  r.report({ op: 'image.build.done', buildId: b.id, outcome: 'succeeded', imageId: 'sha256:' + 'e6'.repeat(32), sizeBytes: 2 * GIB });
  const done = w.db.prepare('SELECT * FROM image_builds WHERE id = ?').get(b.id);
  assert.equal(done.status, 'succeeded'); assert.equal(done.image_id, 'sha256:' + 'e6'.repeat(32)); assert.equal(done.size_bytes, 2 * GIB);
  assert.ok(r.sentOf('probe').length >= 2, 'a fresh probe is asked for');
  assert.equal(w.nx.approvals.imageBuilds(w.me)[0].status, 'succeeded');
  // A late report for a finished build changes nothing.
  r.report({ op: 'image.build.done', buildId: b.id, outcome: 'failed', error: 'late' });
  assert.equal(w.db.prepare('SELECT status FROM image_builds WHERE id = ?').get(b.id).status, 'succeeded');
  healthy(w); w.close();
});

test('A9b a failed build stores its error redacted; Docker stopped or an unknown profile is refused before any row; deny writes no build', () => {
  const { w, r } = imageWorld({ freeBytes: 45 * GIB });
  const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  const { approval } = w.nx.approvals.requestImage(w.me, 'nexus-fwd', 'f-1');
  w.nx.approvals.respond(w.me, approval.id, 'once');
  const b = w.db.prepare('SELECT * FROM image_builds WHERE approval_id = ?').get(approval.id);
  r.report({ op: 'image.build.done', buildId: b.id, outcome: 'failed', error: `step 3 failed: pip said token=${token}` });
  const failed = w.db.prepare('SELECT * FROM image_builds WHERE id = ?').get(b.id);
  assert.equal(failed.status, 'failed'); assert.equal(JSON.parse(failed.error_json).code, 'build_failed');
  for (const t of ['image_builds', 'approvals', 'job_events', 'activity']) {
    assert.equal(w.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE CAST(${t === 'image_builds' ? 'error_json' : t === 'approvals' ? 'request_json' : t === 'job_events' ? 'data_json' : 'details_json'} AS TEXT) LIKE ?`).get(`%${token}%`).n, 0, t);
  }
  // After a failure a new request is allowed.
  const again = w.nx.approvals.requestImage(w.me, 'nexus-fwd', 'f-2').approval;
  assert.equal(w.nx.approvals.respond(w.me, again.id, 'deny').status, 'denied');
  assert.equal(count(w, 'image_builds WHERE approval_id = ?', again.id), 0);
  assert.throws(() => w.nx.approvals.requestImage(w.me, 'qa-web', 'q-1'), code('invalid', 'unknown_profile'));
  assert.throws(() => w.nx.approvals.requestImage(w.me, 'sde-python', 'p-1'), code('invalid', 'unknown_profile'), 'no build context for it');
  const before = count(w, 'approvals');
  w.setProbe({ docker: 'stopped' });
  assert.throws(() => w.nx.approvals.requestImage(w.me, 'sde-node', 'n-1'), code('unavailable', 'setup:docker_stopped'));
  assert.equal(count(w, 'approvals'), before);
  // Only a user (owner) asks.
  assert.throws(() => w.nx.approvals.requestImage(w.sys, 'sde-node', 'n-2'), code('denied', 'user_only'));
  const viewer = w.addUser('user:viewer', 'platform', '*', 'viewer');
  assert.throws(() => w.nx.approvals.requestImage(viewer, 'sde-node', 'n-3'), code('denied'));
  healthy(w); w.close();
});

test('A10 health: an image whose context label differs from the latest succeeded build is image_mismatch', () => {
  const { w, r } = imageWorld({ freeBytes: 45 * GIB });
  const { approval } = w.nx.approvals.requestImage(w.me, 'sde-node', 'i-1');
  w.nx.approvals.respond(w.me, approval.id, 'once');
  const b = w.db.prepare('SELECT * FROM image_builds WHERE approval_id = ?').get(approval.id);
  r.report({ op: 'image.build.done', buildId: b.id, outcome: 'succeeded', imageId: w.IMAGE['sde-node'], sizeBytes: GIB });
  const img = (ctx) => [{ profile: 'sde-node', present: true, digestMatches: true, imageId: w.IMAGE['sde-node'], contextSha256: ctx },
    { profile: 'sde-python', present: true, digestMatches: true, imageId: w.IMAGE['sde-python'] }];
  w.setProbe({ images: img('d7'.repeat(32)) });
  const node = () => w.exec.health().images.find((i) => i.profile === 'sde-node');
  assert.equal(node().present, true); assert.equal(node().matches, false);
  assert.ok(w.exec.health().gate.problems.some((p) => p.id === 'image_mismatch' && p.profile === 'sde-node'));
  assert.deepEqual(w.exec.setupAvailability({ actionId: 'sde.build.run' }), { available: false, reason: 'setup:image_mismatch' });
  const j = w.exec.start(w.me, w.req('sde.build.run')).job; w.exec.tick(w.now());
  assert.equal(w.jobState(j.id), 'queued'); assert.equal(w.job(j.id).phase, 'waiting:image');
  // A python image with no build of its own is judged by its digest only.
  assert.equal(w.exec.health().images.find((i) => i.profile === 'sde-python').matches, true);
  // The image built from this context matches again.
  w.setProbe({ images: img(CTX.contextSha256) });
  assert.equal(node().matches, true);
  w.exec.tick(w.now());
  assert.equal(w.jobState(j.id), 'leased');
  healthy(w); w.close();
});

// ---------- D: local dev deployments ----------

/** A candidate build and a draft application assembled from it (manifest_schema passed, waiting for its deployment). */
async function appDraft(w, manifest = MANIFEST, tag = 'a') {
  const b = await w.runBuild({ files: [{ path: 'server.js', content: `server ${tag}` }], exit: 0 });
  w.answerVerifies(w.attach(), true); await w.settle();
  assert.equal(w.version(b.buildVersionId).status, 'candidate');
  const runner = w.attach();
  const job = w.exec.start(w.me, w.req('sde.app.assemble', { inputs: [{ versionId: b.buildVersionId, slot: 'build' }] })).job;
  w.exec.tick(w.now()); w.provisionEngine(runner, job.id);
  w.exitWith(runner, job.id, { code: 0, parsed: [{ parser: 'app-manifest', sourceSha256: 'd'.repeat(64), normalized: { manifest } }] });
  await w.settle();
  const app = w.db.prepare('SELECT id FROM artifact_versions WHERE produced_by_job_id = ?').get(job.id).id;
  assert.equal(w.version(app).status, 'draft');
  return { app, build: b.buildVersionId };
}

async function deployWorld(o = {}) {
  const w = execWorld({ realIngest: true, fwd: true, dockerMemoryBytes: 64 * GIB, ...o });
  const { app, build } = await appDraft(w, o.manifest);
  return { w, r: w.attach(), app, build };
}

const preview = (w, app) => w.exec.start(w.me, w.req('sde.preview.start', { inputs: [{ versionId: app, slot: 'application' }] })).job;
const dep = (w, jobId) => w.db.prepare('SELECT * FROM deployments WHERE job_id = ?').get(jobId);
function provisionService(w, r, jobId, port, c = 'e') {
  const a = w.liveAttempt(jobId);
  r.report({ op: 'attempt.provisioned', attemptId: a.id, containerId: c.repeat(64), imageDigest: w.IMAGE['sde-node'], preflight: passingPreflight(), hostPort: port });
  return a;
}
/** One probe 5 s later (main's clock), with the scheduler's tick and a heartbeat, as a live runner sends them. */
function probe(w, r, a, status, container = 'running') {
  w.advance(5_000);
  r.report({ op: 'attempt.heartbeat', attemptId: a.id, at: w.now(), logBytes: 0, outBytes: 0, container: container === 'running' ? 'running' : 'exited' });
  r.report({ op: 'service.health', attemptId: a.id, at: w.now(), status, ms: status === null ? null : 4, container });
  w.exec.tick(w.now());
}

/**
 * `n` application versions that can each run a dev deployment at the same time (main allows one live deployment per
 * version): each but the last is made a candidate through a healthy preview that is then stopped and exits; the last
 * is a fresh draft. The previews it runs have ended, so they hold no service slot and no port.
 */
async function previewableApps(w, r, first, n) {
  const apps = [first];
  for (let i = 1; i < n; i++) {
    const j = preview(w, apps[i - 1]); w.exec.tick(w.now());
    const a = provisionService(w, r, j.id, 49400 + i, String.fromCharCode(97 + i));
    probe(w, r, a, 200);
    w.nx.deployments.stop(w.me, dep(w, j.id).id);
    r.report({ op: 'attempt.exited', attemptId: a.id, exit: { code: 0, oomKilled: false, finishedAt: w.now() }, outputs: [], parsed: [], logBytes: 10 });
    assert.equal(w.jobState(j.id), 'completed');
    apps.push((await appDraft(w, MANIFEST, `v${i}`)).app);
  }
  return apps;
}

test('D1 preview of a draft application: the job runs the build, the deployment previews the draft; a 200 makes it healthy and the draft a candidate', async () => {
  const { w, r, app, build } = await deployWorld();
  const j = preview(w, app);
  assert.deepEqual(w.db.prepare('SELECT version_id, role FROM job_inputs WHERE job_id = ?').all(j.id), [{ version_id: build, role: 'build' }]);
  w.exec.tick(w.now());
  const d0 = dep(w, j.id);
  assert.equal(d0.status, 'starting'); assert.equal(d0.subject_version_id, app); assert.equal(d0.bind_address, '127.0.0.1');
  assert.equal(d0.host_port, null); assert.equal(d0.environment, 'local-preview');
  const plan = r.lastStart().plan;
  assert.equal(plan.kind, 'service'); assert.equal(plan.deploymentId, d0.id);
  assert.deepEqual(plan.app.argv, MANIFEST.run); assert.deepEqual(plan.app.network, { mode: 'service-internal', network: `nexus-svc-${j.id.toLowerCase()}` });
  assert.deepEqual(plan.app.service, { containerPort: 3000, healthPath: '/health' });
  assert.deepEqual(plan.forwarder.publish, { hostIp: '127.0.0.1', hostPort: 0, containerPort: 8080 });
  assert.deepEqual(plan.forwarder.argv, ['socat', 'TCP-LISTEN:8080,fork,reuseaddr', 'TCP:app:3000']);
  assert.deepEqual(plan.networks, { internal: `nexus-svc-${j.id.toLowerCase()}`, publish: `nexus-pub-${j.id.toLowerCase()}` });
  assert.equal(plan.staging.blobs.length, 1); assert.equal(plan.staging.blobs[0].relPath, 'dist/server.js');
  assert.equal(plan.idleTtlMs, 2 * 60 * MIN);
  const a = provisionService(w, r, j.id, 49200);
  assert.equal(w.jobState(j.id), 'running'); assert.equal(dep(w, j.id).host_port, 49200);
  probe(w, r, a, null); probe(w, r, a, 503);
  assert.equal(dep(w, j.id).status, 'starting'); assert.equal(w.version(app).status, 'draft');
  probe(w, r, a, 200);
  assert.equal(dep(w, j.id).status, 'healthy');
  const v = w.latest(app, 'app.preview_health');
  assert.equal(v.status, 'passed'); assert.equal(v.job_id, j.id); assert.equal(v.attempt_n, a.n); assert.equal(v.blocking, 1);
  assert.equal(w.version(app).status, 'candidate');
  assert.equal(JSON.parse(dep(w, j.id).health_json).length, 3);
  const view = w.nx.deployments.list(w.me, { projectId: 'p-ledger' }).deployments[0];
  assert.equal(view.url, 'http://127.0.0.1:49200/health'); assert.equal(view.status, 'healthy'); assert.equal(view.lifetimeMs, 2 * 60 * MIN);
  assert.equal(view.endsAt, view.startedAt + 2 * 60 * MIN);
  assert.equal(w.exec.list(w.me, { projectId: 'p-ledger' }).jobs.find((x) => x.id === j.id).headline, 'running');
  healthy(w); w.close();
});

test('D1b (N9) no 200 within 60 s: the deployment fails probe_failed, app.preview_health fails and the draft fails; the job fails', async () => {
  const { w, r, app } = await deployWorld();
  const j = preview(w, app); w.exec.tick(w.now());
  const a = provisionService(w, r, j.id, 49201);
  for (let i = 0; i < 12; i++) probe(w, r, a, i < 4 ? null : 503);
  assert.equal(dep(w, j.id).status, 'starting');
  probe(w, r, a, 503);
  const d = dep(w, j.id);
  assert.equal(d.status, 'failed'); assert.equal(d.stop_reason, 'probe_failed'); assert.equal(d.stopped_by, null);
  const v = w.latest(app, 'app.preview_health');
  assert.equal(v.status, 'failed'); assert.match(v.summary, /no_health/);
  assert.equal(w.version(app).status, 'failed');
  assert.equal(w.jobState(j.id), 'failed'); assert.equal(w.job(j.id).outcome, 'probe_failed');
  assert.ok(r.sentOf('attempt.cancel').some((m) => m.attemptId === a.id));
  // A container that never started within the window: start_timeout, the check could not run (the draft stays a draft).
  const w2 = await deployWorld();
  const j2 = preview(w2.w, w2.app); w2.w.exec.tick(w2.w.now());
  w2.w.run(w2.r, 65_000);
  assert.equal(dep(w2.w, j2.id).stop_reason, 'start_timeout');
  assert.equal(w2.w.latest(w2.app, 'app.preview_health').status, 'error');
  assert.equal(w2.w.version(w2.app).status, 'draft');
  assert.equal(w2.w.jobState(j2.id), 'failed');
  healthy(w); healthy(w2.w); w.close(); w2.w.close();
});

test('D2 three failed probes make a healthy deployment unhealthy; two good ones make it healthy again', async () => {
  const { w, r, app } = await deployWorld();
  const j = preview(w, app); w.exec.tick(w.now());
  const a = provisionService(w, r, j.id, 49202);
  probe(w, r, a, 200);
  assert.equal(dep(w, j.id).status, 'healthy');
  probe(w, r, a, 500); probe(w, r, a, null);
  assert.equal(dep(w, j.id).status, 'healthy', 'two failures');
  probe(w, r, a, 502);
  assert.equal(dep(w, j.id).status, 'unhealthy');
  probe(w, r, a, 200);
  assert.equal(dep(w, j.id).status, 'unhealthy', 'one success');
  probe(w, r, a, 200);
  assert.equal(dep(w, j.id).status, 'healthy');
  const moves = w.db.prepare("SELECT data_json FROM job_events WHERE deployment_id = ? AND type = 'deployment' ORDER BY seq").all(dep(w, j.id).id)
    .map((e) => JSON.parse(e.data_json)).filter((x) => x.to && x.from).map((x) => `${x.from}>${x.to}`);
  assert.deepEqual(moves, ['starting>healthy', 'healthy>unhealthy', 'unhealthy>healthy']);
  // health_json keeps the last 50 probes.
  for (let i = 0; i < 60; i++) probe(w, r, a, 200);
  assert.equal(JSON.parse(dep(w, j.id).health_json).length, 50);
  assert.equal(trailing([{ status: 200 }, { status: 500 }, { status: null }], (p) => p.status !== 200), 2);
  healthy(w); w.close();
});

test('D3 the container exits: the deployment fails (exited); the job completes stopped only if it had been healthy', async () => {
  const { w, r, app } = await deployWorld();
  // (a) healthy, then the container exits.
  const j = preview(w, app); w.exec.tick(w.now());
  const a = provisionService(w, r, j.id, 49203);
  probe(w, r, a, 200);
  probe(w, r, a, null, 'exited');
  assert.equal(dep(w, j.id).status, 'failed'); assert.equal(dep(w, j.id).stop_reason, 'exited');
  assert.equal(w.jobState(j.id), 'running', 'it waits for the exit report'); assert.equal(w.job(j.id).phase, 'stopping');
  r.report({ op: 'attempt.exited', attemptId: a.id, exit: { code: 137, oomKilled: false, finishedAt: w.now() }, outputs: [], parsed: [], logBytes: 10 });
  assert.equal(w.jobState(j.id), 'completed'); assert.equal(w.job(j.id).outcome, 'stopped');
  assert.equal(w.attempt(a.id).state, 'succeeded'); assert.equal(w.attempt(a.id).exit_code, 137);
  assert.ok(r.sentOf('attempt.release').some((m) => m.attemptId === a.id));
  assert.equal(w.exec.list(w.me, { projectId: 'p-ledger' }).jobs.find((x) => x.id === j.id).headline, 'checks_passed');
  // (b) never healthy: the exit fails the deployment, the check and the job (a second application draft).
  const { app: app2 } = await appDraft(w, MANIFEST, 'b');
  const j2 = preview(w, app2); w.exec.tick(w.now());
  const a2 = provisionService(w, r, j2.id, 49204, 'f');
  probe(w, r, a2, 503);
  r.report({ op: 'attempt.exited', attemptId: a2.id, exit: { code: 1, oomKilled: false, finishedAt: w.now() }, outputs: [], parsed: [], logBytes: 10 });
  assert.equal(dep(w, j2.id).status, 'failed'); assert.equal(dep(w, j2.id).stop_reason, 'exited');
  assert.equal(w.jobState(j2.id), 'failed'); assert.equal(w.job(j2.id).outcome, 'exited');
  assert.equal(w.latest(app2, 'app.preview_health').status, 'failed'); assert.match(w.latest(app2, 'app.preview_health').summary, /container_exited/);
  assert.equal(w.version(app2).status, 'failed');
  healthy(w); w.close();
});

test('D4 a user stop: stopped (user); the runner is told; the job completes stopped; a stop of a stopped deployment is illegal_transition', async () => {
  const { w, r, app } = await deployWorld();
  const j = preview(w, app); w.exec.tick(w.now());
  const a = provisionService(w, r, j.id, 49205);
  probe(w, r, a, 200);
  const d = dep(w, j.id);
  const viewer = w.addUser('user:viewer', 'project', 'p-ledger', 'viewer');
  assert.throws(() => w.nx.deployments.stop(viewer, d.id), code('denied'));
  const v = w.nx.deployments.stop(w.me, d.id);
  assert.equal(v.status, 'stopped'); assert.equal(v.stopReason, 'user'); assert.equal(v.url, null);
  assert.equal(dep(w, j.id).stopped_by, w.me.id);
  assert.ok(r.sentOf('attempt.cancel').some((m) => m.attemptId === a.id && m.reason === 'user'));
  const stopEv = w.db.prepare("SELECT data_json FROM job_events WHERE deployment_id = ? AND type = 'deployment' ORDER BY seq DESC LIMIT 1").get(d.id);
  assert.deepEqual(JSON.parse(stopEv.data_json), { from: 'healthy', to: 'stopped', reason: 'user', hostPort: 49205, by: 'user' });
  assert.throws(() => w.nx.deployments.stop(w.me, d.id), code('illegal_transition'));
  assert.equal(w.jobState(j.id), 'running'); assert.equal(w.job(j.id).phase, 'stopping');
  r.report({ op: 'attempt.exited', attemptId: a.id, exit: { code: 0, oomKilled: false, finishedAt: w.now() }, outputs: [], parsed: [], logBytes: 10 });
  assert.equal(w.jobState(j.id), 'completed'); assert.equal(w.job(j.id).outcome, 'stopped');
  // A deployment stopped before its health check ends its job cancelled at once.
  const j2 = preview(w, app); w.exec.tick(w.now());
  const a2 = provisionService(w, r, j2.id, 49206, 'f');
  w.nx.deployments.stop(w.me, dep(w, j2.id).id);
  assert.equal(w.jobState(j2.id), 'cancelled'); assert.equal(w.attempt(a2.id).state, 'cancelled');
  assert.throws(() => w.nx.deployments.stop(w.me, 'nope'), code('not_found'));
  healthy(w); w.close();
});

test('D4b (B2a stabilization) one live dev deployment per application version: a second start is refused deployment_live and writes nothing; another version still starts', async () => {
  const { w, r, app } = await deployWorld();
  const written = () => [count(w, 'jobs'), count(w, 'deployments'), count(w, 'job_events'), count(w, 'activity'), count(w, 'job_inputs')];
  const startReq = w.req('sde.preview.start', { inputs: [{ versionId: app, slot: 'application' }] });
  const j = w.exec.start(w.me, startReq).job;
  // (1) The first job is queued and has no deployment row yet: its live preview job already holds the version.
  let before = written();
  assert.throws(() => preview(w, app), code('conflict', 'deployment_live'));
  assert.deepEqual(written(), before, 'nothing is written by the refusal');
  // The same intent repeated still answers its own job (never a conflict).
  const again = w.exec.start(w.me, startReq);
  assert.deepEqual([again.job.id, again.created], [j.id, false]);
  // (2) Starting, then (3) healthy: refused each time, nothing written.
  w.exec.tick(w.now());
  assert.equal(dep(w, j.id).status, 'starting');
  before = written();
  assert.throws(() => preview(w, app), code('conflict', 'deployment_live'));
  assert.deepEqual(written(), before);
  const a = provisionService(w, r, j.id, 49230);
  probe(w, r, a, 200);
  assert.equal(dep(w, j.id).status, 'healthy');
  before = written();
  assert.throws(() => preview(w, app), code('conflict', 'deployment_live'));
  assert.deepEqual(written(), before);
  // A viewer is refused by authorization first (denied), never told about the live deployment.
  const viewer = w.addUser('user:viewer2', 'project', 'p-ledger', 'viewer');
  assert.throws(() => w.exec.start(viewer, w.req('sde.preview.start', { inputs: [{ versionId: app, slot: 'application' }] })), code('denied'));
  // (4) Another application version still starts its own dev deployment.
  const { app: app2 } = await appDraft(w, MANIFEST, 'b');
  const j2 = preview(w, app2);
  assert.equal(w.jobState(j2.id), 'queued');
  // (5) Once the first deployment is stopped and its job has ended, its version can start again.
  w.nx.deployments.stop(w.me, dep(w, j.id).id);
  assert.throws(() => preview(w, app), code('conflict', 'deployment_live'), 'its job still runs until the app exits');
  r.report({ op: 'attempt.exited', attemptId: a.id, exit: { code: 0, oomKilled: false, finishedAt: w.now() }, outputs: [], parsed: [], logBytes: 10 });
  assert.equal(w.jobState(j.id), 'completed');
  const j3 = preview(w, app);
  assert.equal(w.jobState(j3.id), 'queued');
  w.close();
});

test('D5 the service cap is 2: a third preview waits waiting:slots and starts when a slot frees', async () => {
  const { w, r, app } = await deployWorld();
  // One live dev deployment per application version (B2a stabilization): concurrent previews need their own versions.
  const apps = await previewableApps(w, r, app, 3);
  const jobs = apps.map((x) => preview(w, x)); w.exec.tick(w.now());
  assert.equal(w.jobState(jobs[0].id), 'leased'); assert.equal(w.jobState(jobs[1].id), 'leased');
  assert.equal(w.jobState(jobs[2].id), 'queued'); assert.equal(w.job(jobs[2].id).phase, 'waiting:slots');
  assert.equal(dep(w, jobs[2].id), undefined, 'no deployment row before its lease');
  w.nx.deployments.stop(w.me, dep(w, jobs[0].id).id);
  w.exec.tick(w.now());
  assert.equal(w.jobState(jobs[2].id), 'leased'); assert.equal(dep(w, jobs[2].id).status, 'starting');
  healthy(w); w.close();
});

test('D6 two live deployments never share a port: the core refuses a held port and the unique index is the backstop', async () => {
  const { w, r, app } = await deployWorld();
  // One live dev deployment per application version (B2a stabilization): concurrent previews need their own versions.
  const [v1, v2, v3] = await previewableApps(w, r, app, 3);
  const j1 = preview(w, v1); const j2 = preview(w, v2); w.exec.tick(w.now());
  provisionService(w, r, j1.id, 49207);
  const a2 = provisionService(w, r, j2.id, 49207, 'f');
  assert.equal(dep(w, j1.id).host_port, 49207); assert.equal(dep(w, j2.id).host_port, null);
  assert.equal(w.attempt(a2.id).outcome, 'limits_not_applied'); assert.equal(w.jobState(j2.id), 'failed');
  assert.equal(dep(w, j2.id).status, 'failed'); assert.equal(dep(w, j2.id).stop_reason, 'preflight_failed', 'the true cause on the row');
  assert.ok(r.sentOf('attempt.release').some((m) => m.attemptId === a2.id));
  // The index: a live deployment cannot take a port another live one holds; a finished one frees it.
  const j3 = preview(w, v3); w.exec.tick(w.now());
  assert.throws(() => w.db.prepare('UPDATE deployments SET host_port = 49207 WHERE job_id = ?').run(j3.id), /UNIQUE/);
  w.nx.deployments.stop(w.me, dep(w, j1.id).id);
  provisionService(w, r, j3.id, 49207, 'a');
  assert.equal(dep(w, j3.id).host_port, 49207);
  // A port is stored once; a tool container may never report one.
  assert.throws(() => w.db.prepare('UPDATE deployments SET host_port = 49299 WHERE job_id = ?').run(j3.id), /immutable/);
  const b = w.exec.start(w.me, w.req('sde.build.run')).job; w.exec.tick(w.now());
  const ba = w.liveAttempt(b.id);
  r.report({ op: 'attempt.provisioned', attemptId: ba.id, containerId: 'b'.repeat(64), imageDigest: w.IMAGE['sde-node'], preflight: passingPreflight(), hostPort: 50000 });
  assert.equal(w.jobState(b.id), 'failed'); assert.match(JSON.parse(w.job(b.id).error_json).message, /published port/);
  // The protocol carries a port only with a container, in the ephemeral range 49152-65535 (M3).
  assert.equal(parseRunnerMessage({ op: 'attempt.provisioned', attemptId: ba.id, hostPort: 50000 }), null);
  const prov = (port) => parseRunnerMessage({ op: 'attempt.provisioned', attemptId: ba.id, containerId: 'b'.repeat(64), preflight: passingPreflight(), hostPort: port });
  for (const port of [80, 1024, 3306, 8080, 49151, 65536]) assert.equal(prov(port), null, `port ${port}`);
  for (const port of [49152, 60000, 65535]) assert.ok(prov(port), `port ${port}`);
  healthy(w); w.close();
});

test('M3 a dev deployment whose runner reports a port outside the ephemeral range (3306) never runs', async () => {
  const { w, r, app } = await deployWorld();
  const j = preview(w, app); w.exec.tick(w.now());
  const a = w.liveAttempt(j.id);
  // Dropped by the protocol: nothing is recorded, the deployment never gets the port, and its start window ends it.
  r.report({ op: 'attempt.provisioned', attemptId: a.id, containerId: 'e'.repeat(64), imageDigest: w.IMAGE['sde-node'], preflight: passingPreflight(), hostPort: 3306 });
  assert.equal(w.attempt(a.id).state, 'starting'); assert.equal(dep(w, j.id).host_port, null);
  assert.ok(w.logs.some((l) => /dropped runner message \?: malformed/.test(l)));
  w.run(r, 65_000);
  assert.equal(dep(w, j.id).status, 'failed'); assert.equal(dep(w, j.id).stop_reason, 'start_timeout'); assert.equal(w.jobState(j.id), 'failed');
  assert.equal(count(w, 'deployments WHERE host_port = 3306'), 0);
  healthy(w); w.close();
});

test('D7 a manifest that names environment variables cannot start: secrets for dev deployments are not supported yet (no job)', async () => {
  const { w, app } = await deployWorld({ manifest: { ...MANIFEST, env: ['DATABASE_URL'] } });
  const before = count(w, 'jobs');
  assert.throws(() => preview(w, app), (e) => e.code === 'unavailable' && e.detail?.reason === 'secrets_not_supported'
    && /This app needs DATABASE_URL; secrets for dev deployments are not supported yet/.test(e.message));
  assert.equal(count(w, 'jobs'), before); assert.equal(count(w, 'deployments'), 0);
  healthy(w); w.close();
});

test('D8 app quit stops every live deployment (app_quit) in one bounded pass and tells the runner', async () => {
  const { w, r, app } = await deployWorld();
  // One live dev deployment per application version (B2a stabilization): concurrent previews need their own versions.
  const [v1, v2] = await previewableApps(w, r, app, 2);
  const j1 = preview(w, v1); const j2 = preview(w, v2); w.exec.tick(w.now());
  const a1 = provisionService(w, r, j1.id, 49210); probe(w, r, a1, 200);
  const a2 = w.liveAttempt(j2.id);
  const t = performance.now();
  assert.equal(w.nx.deployments.stopAllForQuit(), 2);
  assert.ok(performance.now() - t < 200, 'bounded');
  for (const j of [j1, j2]) { const d = dep(w, j.id); assert.equal(d.status, 'stopped'); assert.equal(d.stop_reason, 'app_quit'); assert.equal(d.stopped_by, 'system'); }
  for (const a of [a1, a2]) assert.ok(r.sentOf('attempt.cancel').some((m) => m.attemptId === a.id && m.reason === 'shutdown'));
  assert.equal(w.nx.deployments.stopAllForQuit(), 0);
  healthy(w); w.close();
});

test('D9 the fixed 2 h lifetime stops a healthy deployment (idle); a cancelled preview job stops its deployment (cancel)', async () => {
  const { w, r, app } = await deployWorld();
  // One live dev deployment per application version (B2a stabilization): concurrent previews need their own versions.
  const [v1, v2] = await previewableApps(w, r, app, 2);
  const j = preview(w, v1); w.exec.tick(w.now());
  const a = provisionService(w, r, j.id, 49211); probe(w, r, a, 200);
  for (let i = 0; i < 24 * 5; i++) probe(w, r, a, 200);       // 10 min of probes
  w.run(r, 2 * 60 * MIN - 11 * MIN);
  assert.equal(dep(w, j.id).status, 'healthy');
  w.run(r, 75_000);
  assert.equal(dep(w, j.id).status, 'stopped'); assert.equal(dep(w, j.id).stop_reason, 'idle');
  assert.equal(w.job(j.id).phase, 'stopping');
  assert.ok(r.sentOf('attempt.cancel').some((m) => m.attemptId === a.id && m.reason === 'timeout'));
  const j2 = preview(w, v2); w.exec.tick(w.now());
  w.exec.cancel(w.me, j2.id);
  assert.equal(dep(w, j2.id).status, 'stopped'); assert.equal(dep(w, j2.id).stop_reason, 'cancel'); assert.equal(dep(w, j2.id).stopped_by, w.me.id);
  healthy(w); w.close();
});

test('D10 a dev deployment is never requeued: a runner refusal or an unsent plan fails its job and ends the deployment', async () => {
  const { w, r, app } = await deployWorld();
  const j = preview(w, app); w.exec.tick(w.now());
  const a = w.liveAttempt(j.id);
  r.report({ op: 'attempt.refused', attemptId: a.id, reason: 'busy' });
  assert.equal(w.jobState(j.id), 'failed'); assert.equal(w.attempts(j.id).length, 1);
  assert.equal(dep(w, j.id).status, 'failed'); assert.equal(dep(w, j.id).stop_reason, 'refused', 'the true cause on the row');
  assert.equal(w.latest(app, 'app.preview_health').status, 'error', 'the check could not run; the draft stays a draft');
  assert.equal(w.version(app).status, 'draft');
  w.run(r, MIN);
  assert.equal(w.jobState(j.id), 'failed', 'not requeued');
  r.o.failSend = (m) => m.op === 'attempt.start';
  const j2 = preview(w, app); w.exec.tick(w.now());
  assert.equal(w.jobState(j2.id), 'failed'); assert.equal(dep(w, j2.id).status, 'failed'); assert.equal(dep(w, j2.id).stop_reason, 'runner_lost');
  r.o.failSend = null;
  // A preview of a version that is not an application, or of a failed application, is refused before any job.
  assert.throws(() => w.exec.start(w.me, w.req('sde.preview.start', { inputs: [{ versionId: w.repoV, slot: 'application' }] })), code('invalid', 'input_not_allowed'));
  healthy(w); w.close();
});

// ---------- R: repository snapshots ----------

test('R1 a snapshot of a folder that is not a git repository is invalid: not_a_repository, and no job is created', async () => {
  const seen = [];
  const w = execWorld({ isRepository: async (root) => { seen.push(root); return false; } });
  w.attach();
  const before = count(w, 'jobs');
  await assert.rejects(w.nx.repo.requestSnapshot(w.me, { projectId: 'p-ledger', workspaceId: 'sde', intentId: 'snap-1' }), code('invalid', 'not_a_repository'));
  assert.equal(count(w, 'jobs'), before); assert.deepEqual(seen, ['C:/work/ledger-api']);
  // A folder main refuses never reaches git; no repository check in this build: unavailable.
  const w2 = execWorld({ acceptFsRoot: () => null, isRepository: async () => true });
  await assert.rejects(w2.nx.repo.requestSnapshot(w2.me, { projectId: 'p-ledger', workspaceId: 'sde', intentId: 's' }), code('invalid', 'project_folder_unavailable'));
  const w3 = execWorld();
  await assert.rejects(w3.nx.repo.requestSnapshot(w3.me, { projectId: 'p-ledger', workspaceId: 'sde', intentId: 's' }), code('unavailable', 'setup:git_missing'));
  // Authorization comes first.
  const viewer = w.addUser('user:viewer', 'project', 'p-ledger', 'viewer');
  await assert.rejects(w.nx.repo.requestSnapshot(viewer, { projectId: 'p-ledger', workspaceId: 'sde', intentId: 's2' }), code('denied'));
  assert.equal(seen.length, 1);
  healthy(w); w.close(); w2.close(); w3.close();
});

test('R1b (Task 11 review round 2) no git installed: the repository check says git_missing and the snapshot request is unavailable setup:git_missing (never not_a_repository); no job is created', async () => {
  const seen = [];
  const w = execWorld({ isRepository: async (root) => { seen.push(root); return 'git_missing'; } });
  w.attach();
  const before = count(w, 'jobs');
  await assert.rejects(w.nx.repo.requestSnapshot(w.me, { projectId: 'p-ledger', workspaceId: 'sde', intentId: 'snap-g' }), code('unavailable', 'setup:git_missing'));
  assert.equal(count(w, 'jobs'), before); assert.deepEqual(seen, ['C:/work/ledger-api']);
  // The platform kept working: a repository check that answers true starts the job as before.
  const w2 = execWorld({ isRepository: async () => true }); w2.attach();
  assert.equal((await w2.nx.repo.requestSnapshot(w2.me, { projectId: 'p-ledger', workspaceId: 'sde', intentId: 'snap-ok' })).created, true);
  healthy(w); w.close(); w2.close();
});

test('R2 two snapshot requests at once leave one live job: the second returns it (created: false)', async () => {
  const w = execWorld({ isRepository: () => new Promise((res) => setImmediate(() => res(true))) });
  w.attach();
  const req = (k) => w.nx.repo.requestSnapshot(w.me, { projectId: 'p-ledger', workspaceId: 'sde', intentId: k });
  const [x, y] = await Promise.all([req('s-1'), req('s-2')]);
  assert.equal(x.job.id, y.job.id);
  assert.deepEqual([x.created, y.created].sort(), [false, true]);
  assert.equal(count(w, "jobs WHERE recipe_id = 'repo.snapshot'"), 1);
  // While it is live, a later request returns it too; once it ended, a new one is created.
  const z = await req('s-3');
  assert.equal(z.created, false); assert.equal(z.job.id, x.job.id);
  assert.equal(count(w, "jobs WHERE recipe_id = 'repo.snapshot'"), 1);
  w.exec.cancel(w.me, x.job.id);
  const n = await req('s-4');
  assert.equal(n.created, true); assert.notEqual(n.job.id, x.job.id);
  healthy(w); w.close();
});

test('R3 a dirty tree is recorded on the snapshot (dirty: true) and drives the note "uncommitted changes are not included"', async () => {
  const resolveCommit = async (_root, c) => ({ commit: c, subject: 's', committedAt: 1 });
  const w = execWorld({ realIngest: true, resolveCommit });
  const C1 = 'a1b2c3'.padEnd(40, '0'); const C2 = 'b2c3d4'.padEnd(40, '0');
  const j1 = await w.snapshot({ commit: C1, branch: 'main', dirty: true, tree: 'e'.repeat(40) });
  const v1 = w.db.prepare("SELECT * FROM artifact_versions WHERE produced_by_job_id = ? AND output_path = 'facts'").get(j1);
  assert.equal(JSON.parse(v1.metadata_json).dirty, true);
  const view = w.nx.repo.snapshotView(w.me, v1.id);
  assert.equal(view.dirty, true); assert.equal(view.commit, C1);
  assert.equal(view.note, 'Tests run on commit a1b2c30; uncommitted changes are not included.');
  const j2 = await w.snapshot({ commit: C2, branch: 'main', dirty: false, tree: 'f'.repeat(40) });
  const v2 = w.db.prepare("SELECT id FROM artifact_versions WHERE produced_by_job_id = ? AND output_path = 'facts'").get(j2).id;
  assert.equal(w.nx.repo.snapshotView(w.me, v2).note, 'Tests run on commit b2c3d40.');
  assert.equal(checkoutNote(snapshotFacts({ kind: 'git', commit: C1 }, { dirty: true })), 'Tests run on commit a1b2c30; uncommitted changes are not included.');
  assert.equal(snapshotFacts({ kind: 'inline', json: {} }, {}), null);
  assert.throws(() => w.nx.repo.snapshotView(w.me, w.suiteV), code('invalid', 'not_a_snapshot'));
  healthy(w); w.close();
});

test('R4 the app manifest reader contract: a plain object of at most 16 KiB, nothing secret-shaped', () => {
  assert.deepEqual(acceptManifestReport({ manifest: MANIFEST }), { ok: true, manifest: MANIFEST });
  assert.deepEqual(acceptManifestReport({ manifest: [] }), { ok: false, reason: 'parser_contract' });
  assert.deepEqual(acceptManifestReport(null), { ok: false, reason: 'parser_contract' });
  assert.deepEqual(acceptManifestReport({ manifest: { ...MANIFEST, run: ['x'.repeat(APP_MANIFEST_MAX_BYTES)] } }), { ok: false, reason: 'manifest_too_large' });
  assert.deepEqual(acceptManifestReport({ manifest: { ...MANIFEST, run: ['node', '--key=sk-abcdefghijklmnopqrstuvwx1234'] } }), { ok: false, reason: 'secret_in_output' });
});

// ---------- security: network and approval bypasses (constraint 11) ----------

test('S1 no network escape: only a consumed once approval of this job and attempt opens egress; tampered rows and params never do', () => {
  const { w, r } = egressWorld();
  // Params cannot name a network, an image or an approval.
  for (const params of [{ network: 'host' }, { approvalId: 'x' }, { egress: true }]) {
    assert.throws(() => w.exec.start(w.me, w.req('sde.deps.install', { params })), code('invalid', 'bad_params'));
  }
  const d = depsJob(w); const ap = approvalOf(w, d.id);
  // A row set to approved without a user decision is refused (T11); one approved without consumption starts nothing.
  assert.throws(() => w.db.prepare("UPDATE approvals SET status = 'approved', status_changed_at = ? WHERE id = ?").run(w.now(), ap.id), /only a user/);
  w.db.prepare(`UPDATE approvals SET status = 'approved', decided_by = 'user:local', decided_at = ?, decision = 'once', status_changed_at = ? WHERE id = ?`)
    .run(w.now(), w.now(), ap.id);
  assert.throws(() => w.exec.resumeApproved(d.id), code('invalid', 'network_not_approved'));
  w.run(r, MIN);
  assert.equal(r.sentOf('attempt.start').length, 0, 'an unconsumed approval starts nothing');
  // Consumption names an existing attempt of the approval's own job.
  assert.throws(() => w.db.prepare('UPDATE approvals SET consumed_at = ?, consumed_by_job_id = ?, consumed_by_attempt_n = 9 WHERE id = ?')
    .run(w.now(), d.id, ap.id), /FOREIGN KEY|constraint/i);
  w.exec.cancel(w.me, d.id);
  // A properly answered approval: its consumption is recorded once and can never be moved to another attempt.
  const d2 = depsJob(w); const ap2 = approvalOf(w, d2.id);
  w.nx.approvals.respond(w.me, ap2.id, 'once');
  assert.throws(() => w.db.prepare('UPDATE approvals SET consumed_by_attempt_n = 2 WHERE id = ?').run(ap2.id), /recorded once/);
  assert.throws(() => w.db.prepare("UPDATE approvals SET status = 'pending' WHERE id = ?").run(ap2.id), /illegal approval transition|recorded once/);
  // A non-egress recipe never gets egress, whatever approval exists.
  const b = w.exec.start(w.me, w.req('sde.build.run')).job; w.exec.tick(w.now());
  assert.deepEqual(r.lastStart().plan.container.network, { mode: 'none' }); assert.equal(r.lastStart().plan.jobId, b.id);
  assert.equal(r.sentOf('attempt.start').filter((m) => m.plan.jobId === d.id).length, 0);
  healthy(w); w.close();
});

test('S2 secrets: approval requests, deployment rows, events and activity hold no secret-shaped value', () => {
  assert.equal(requestHoldsSecret({ recipeId: 'sde.deps.node', jobId: newId(), lockfileSha256: LOCK, profile: 'sde-node', registries: ['registry.npmjs.org'] }), false);
  assert.equal(requestHoldsSecret({ profileId: 'sde-node', contextSha256: CTX.contextSha256, baseDigest: CTX.baseDigest, estimatedBytes: 1 }), false);
  assert.equal(requestHoldsSecret({ profile: 'sde-node', lockfileSha256: 'sk-' + 'a'.repeat(40) }), true, 'a malformed digest is refused');
  assert.equal(requestHoldsSecret({ profile: 'token=ghp_' + 'a1'.repeat(20) }), true);
  assert.equal(requestHoldsSecret({ registries: ['https://user:pass@registry.example'] }), true);
  // An app manifest argument that is secret-shaped never reaches a plan.
  const { checkRunArgv } = loadTs('src/main/nexus/exec/planBuilder.ts');
  assert.throws(() => checkRunArgv(['node', '--token=ghp_' + 'Ab1'.repeat(14)]), code('invalid', 'secret_in_argv'));
  assert.throws(() => checkRunArgv([]), code('invalid', 'bad_input'));
  assert.throws(() => checkRunArgv(['a\0b']), code('invalid', 'bad_input'));
  assert.deepEqual(checkRunArgv(['node', 'dist/server.js']), ['node', 'dist/server.js']);
});

test('S3 state is rebuilt from SQLite alone: a second platform on the same database expires, judges and lists exactly what the first left', async () => {
  const { w, r, app } = await deployWorld({ approvals: 'real', repoMeta: { lockfile: { sha256: LOCK } } });
  const d = depsJob(w);
  const j = preview(w, app); w.exec.tick(w.now());
  const a = provisionService(w, r, j.id, 49220);
  probe(w, r, a, 200); probe(w, r, a, 500); probe(w, r, a, 500);
  assert.equal(dep(w, j.id).status, 'healthy');
  // A fresh composition over the same rows (no memory of the first).
  const nx2 = createNexusPlatform(w.db, { now: () => w.now(), execution: true, profiles: PROFILES, acceptFsRoot: (x) => x, dataHome: w.dataHome });
  nx2.deployments.onHealth(dep(w, j.id).id, { status: 503, ms: 3, container: 'running' });
  assert.equal(dep(w, j.id).status, 'unhealthy', 'the third failure in a row, counted from health_json');
  assert.equal(nx2.deployments.healthyEver(j.id, a.n), true);
  assert.equal(nx2.approvals.list(w.me, { projectId: 'p-ledger', status: 'pending' }).approvals[0].jobId, d.id);
  w.advance(16 * MIN);
  assert.equal(nx2.approvals.expireDue(w.now()), 1);
  assert.equal(approvalOf(w, d.id).status, 'expired'); assert.equal(w.jobState(d.id), 'failed');
  healthy(w); w.close();
});

// ---------- fix round 1 (review of e212fca2) ----------

test('AR1 approval answers, expiry and image builds write their activity rows with their facts and plain sentences', () => {
  const gate = { ok: true };
  const { w, r } = egressWorld({ acceptFsRoot: (root) => (gate.ok ? root : null), imageContexts: (id) => (id === 'sde-node' ? CTX : null),
    freeBytes: 45 * GIB });
  // Five installs wait for approval (an awaiting job holds no slot).
  const [d1, d2, d3, d4, d5] = [0, 1, 2, 3, 4].map(() => depsJob(w));
  // once, started
  w.nx.approvals.respond(w.me, approvalOf(w, d1.id).id, 'once');
  const r1 = acts(w, 'approval.respond', approvalOf(w, d1.id).id)[0];
  assert.equal(r1.actor_kind, 'user'); assert.equal(r1.actor_id, w.me.id); assert.equal(r1.job_id, d1.id); assert.equal(r1.attempt_n, 1);
  assert.deepEqual(JSON.parse(r1.details_json), { reason: 'egress.deps', decision: 'once', consumedBy: { jobId: d1.id, attemptN: 1 }, effect: 'started' });
  assert.equal(ACT.activityText(actView(r1), ACT_CTX), 'Allowed once: download the add-ons your project needs');
  // once while the slots are full: waiting:slots
  const builds = [0, 1].map(() => w.exec.start(w.me, w.req('sde.build.run')).job); w.exec.tick(w.now());
  assert.ok(builds.every((b) => w.jobState(b.id) === 'leased'));
  w.nx.approvals.respond(w.me, approvalOf(w, d2.id).id, 'once');
  assert.equal(JSON.parse(acts(w, 'approval.respond', approvalOf(w, d2.id).id)[0].details_json).effect, 'waiting:slots');
  // deny
  w.nx.approvals.respond(w.me, approvalOf(w, d3.id).id, 'deny');
  const r3 = acts(w, 'approval.respond', approvalOf(w, d3.id).id)[0];
  assert.deepEqual(JSON.parse(r3.details_json), { reason: 'egress.deps', decision: 'deny', consumedBy: null, effect: 'job_failed_denied' });
  assert.equal(ACT.activityText(actView(r3), ACT_CTX), 'The request for your OK was turned down');
  // once when the plan cannot be built (the project folder is gone): failed:<code>
  w.exec.cancel(w.me, builds[0].id);
  gate.ok = false;
  w.nx.approvals.respond(w.me, approvalOf(w, d5.id).id, 'once');
  assert.equal(JSON.parse(acts(w, 'approval.respond', approvalOf(w, d5.id).id)[0].details_json).effect, 'failed:project_folder_unavailable');
  assert.equal(w.jobState(d5.id), 'failed');
  gate.ok = true;
  // expiry
  w.advance(15 * MIN);
  assert.equal(w.nx.approvals.expireDue(w.now()), 1);
  const ex = acts(w, 'approval.expire', approvalOf(w, d4.id).id)[0];
  assert.equal(ex.actor_kind, 'system'); assert.equal(ex.job_id, d4.id);
  assert.deepEqual(JSON.parse(ex.details_json), { approvalId: approvalOf(w, d4.id).id, reason: 'egress.deps', expiredAt: approvalOf(w, d4.id).expires_at,
    job: { outcome: 'denied', error: 'approval_expired' } });
  assert.equal(ACT.activityText(actView(ex), ACT_CTX), 'The request for your OK ran out: it was not answered within 15 minutes');
  // Image: request (the user), answer, start (the deciding user, for the requester), finish (the system).
  const { approval } = w.nx.approvals.requestImage(w.me, 'sde-node', 'img-ar1');
  const rq = acts(w, 'approval.request', approval.id)[0];
  const rqRow = w.db.prepare('SELECT * FROM approvals WHERE id = ?').get(approval.id);
  assert.equal(rq.actor_id, w.me.id);
  assert.deepEqual(JSON.parse(rq.details_json), { reason: 'image.prepare', profileId: 'sde-node', context: { sha256: CTX.contextSha256 },
    base: { sha256: CTX.baseDigest.slice(7) }, estimatedBytes: CTX.estimatedBytes, freeBytesNow: 45 * GIB, request: { sha256: rqRow.request_sha256 },
    expiresAt: rqRow.expires_at });
  assert.equal(ACT.activityText(actView(rq), ACT_CTX), 'Asked for your OK: prepare a safe-space kit');
  w.nx.approvals.respond(w.me, approval.id, 'once');
  const b = w.db.prepare('SELECT * FROM image_builds WHERE approval_id = ?').get(approval.id);
  assert.deepEqual(JSON.parse(acts(w, 'approval.respond', approval.id)[0].details_json), { reason: 'image.prepare', decision: 'once', profileId: 'sde-node', buildId: b.id });
  const st = acts(w, 'image_build.start', b.id)[0];
  assert.equal(st.actor_id, w.me.id); assert.equal(st.on_behalf_of, w.me.id); assert.equal(st.status, 'started');
  assert.deepEqual(JSON.parse(st.details_json), { buildId: b.id, profileId: 'sde-node', approvalId: approval.id, context: { sha256: CTX.contextSha256 },
    base: { sha256: CTX.baseDigest.slice(7) } });
  w.advance(90_000);
  r.report({ op: 'image.build.done', buildId: b.id, outcome: 'succeeded', imageId: 'sha256:' + 'e6'.repeat(32), sizeBytes: 2 * GIB });
  const fin = acts(w, 'image_build.finish', b.id)[0];
  assert.equal(fin.actor_kind, 'system'); assert.equal(fin.status, 'succeeded');
  assert.deepEqual(JSON.parse(fin.details_json), { buildId: b.id, profileId: 'sde-node', status: 'succeeded', image: { sha256: 'e6'.repeat(32) },
    sizeBytes: 2 * GIB, error: null, durationMs: 90_000 });
  assert.equal(ACT.activityText(actView(fin), ACT_CTX), 'Safe-space kit prepared');
  assert.equal(ACT.activityText(actView(st), ACT_CTX), 'Preparing a safe-space kit started');
  for (const t of recordTexts(w)) assert.ok(!hasProviderKey(t), t.slice(0, 120));
  healthy(w); w.close();
});

test('AR1 dev deployments write deployment.start, deployment.transition and deployment.stop rows with their facts', async () => {
  const { w, r, app, build } = await deployWorld();
  const j = preview(w, app); w.exec.tick(w.now());
  const d = dep(w, j.id);
  const start = acts(w, 'deployment.start', d.id)[0];
  assert.equal(start.actor_kind, 'system'); assert.equal(start.on_behalf_of, w.me.id); assert.equal(start.job_id, j.id); assert.equal(start.attempt_n, 1);
  assert.equal(start.version_id, app);
  assert.deepEqual(JSON.parse(start.details_json), { deploymentId: d.id, jobId: j.id, attemptN: 1, subjectVersionId: app, buildVersionId: build,
    profile: 'sde-node', image: { sha256: w.IMAGE['sde-node'].slice(7) }, forwarderImage: { sha256: w.IMAGE['nexus-fwd'].slice(7) },
    environment: 'local-preview', bindAddress: '127.0.0.1', lifetimeMs: 2 * 60 * MIN });
  assert.equal(ACT.activityText(actView(start), ACT_CTX), 'Test run of your app started. Only this computer can reach it');
  const a = provisionService(w, r, j.id, 49300);
  probe(w, r, a, 503); probe(w, r, a, 200);
  const healthyRow = acts(w, 'deployment.transition', d.id)[0];
  const check = w.latest(app, 'app.preview_health');
  assert.deepEqual(JSON.parse(healthyRow.details_json), { deploymentId: d.id, from: 'starting', to: 'healthy', reason: null, hostPort: 49300,
    healthyEver: true, lastProbeStatus: 200, check: { id: check.id, status: 'passed' } });
  assert.equal(ACT.activityText(actView(healthyRow), ACT_CTX), 'Your app answered the app check');
  probe(w, r, a, 500); probe(w, r, a, 500); probe(w, r, a, 500);
  const unhealthy = acts(w, 'deployment.transition', d.id)[1];
  assert.deepEqual(JSON.parse(unhealthy.details_json), { deploymentId: d.id, from: 'healthy', to: 'unhealthy', reason: null, hostPort: 49300,
    healthyEver: true, lastProbeStatus: 500, check: null });
  w.nx.deployments.stop(w.me, d.id);
  const stop = acts(w, 'deployment.stop', d.id)[0];
  assert.equal(stop.actor_kind, 'user'); assert.equal(stop.actor_id, w.me.id);
  assert.deepEqual(JSON.parse(stop.details_json), { deploymentId: d.id, from: 'unhealthy', to: 'stopped', reason: 'user', job: 'completes_on_exit', hostPort: 49300 });
  assert.equal(ACT.activityText(actView(stop), ACT_CTX), 'Test run of your app stopped; its task ends once the app has stopped');
  // One live dev deployment per version (B2a stabilization): the stopped app exits, so its job ends, before the next.
  r.report({ op: 'attempt.exited', attemptId: a.id, exit: { code: 0, oomKilled: false, finishedAt: w.now() }, outputs: [], parsed: [], logBytes: 10 });
  assert.equal(w.jobState(j.id), 'completed');
  // A failure in words: the start window passes without a 200.
  const j2 = preview(w, app); w.exec.tick(w.now());
  const a2 = provisionService(w, r, j2.id, 49301, 'f');
  for (let i = 0; i < 13; i++) probe(w, r, a2, 503);
  const failed = acts(w, 'deployment.transition', dep(w, j2.id).id).pop();
  assert.equal(JSON.parse(failed.details_json).reason, 'probe_failed'); assert.equal(JSON.parse(failed.details_json).check.status, 'failed');
  assert.equal(ACT.activityText(actView(failed), ACT_CTX), 'Test run of your app failed: it did not answer the app check within 60 seconds');
  for (const t of recordTexts(w)) assert.ok(!hasProviderKey(t), t.slice(0, 120));
  healthy(w); w.close();
});

test('AR2 unavailable is a shared error code with its own plain sentence; the services answer with it', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const E = loadTs('src/renderer/src/nexus/data/errorCopy.ts');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'nexus', 'platform.ts'), 'utf8');
  assert.match(src.match(/export type PlatformErrorCode =([^;]+);/)[1], /'unavailable'/);
  assert.ok(E.NEXUS_ERROR_CODES.includes('unavailable'));
  const c = E.errorCopy('unavailable', 'setup:disk_low');
  assert.equal(c.kind, 'refused'); assert.equal(c.retry, false);
  assert.equal(c.text, 'This cannot run on this computer yet. Open “Get this computer ready” to see what is missing.');
  const { w } = imageWorld({ freeBytes: 20 * GIB });
  assert.throws(() => w.nx.approvals.requestImage(w.me, 'sde-node', 'u-1'), (e) => e.code === 'unavailable' && e.detail.reason === 'setup:disk_low');
  w.close();
});

test('I1 image builds always end: a runner-wide fault or a port leaving ready interrupts them; a deadline fails them; a user cancels one', () => {
  const { w, r } = imageWorld({ freeBytes: 45 * GIB });
  const build = (profile, k) => {
    const { approval } = w.nx.approvals.requestImage(w.me, profile, k);
    w.nx.approvals.respond(w.me, approval.id, 'once');
    return w.db.prepare('SELECT * FROM image_builds WHERE approval_id = ?').get(approval.id);
  };
  const statusOf = (b) => w.db.prepare('SELECT status, error_json FROM image_builds WHERE id = ?').get(b.id);
  // A runner-wide fault: interrupted, and a new request is accepted again.
  const b1 = build('sde-node', 'i-1');
  r.report({ op: 'fault', message: 'the runner lost its Docker connection' });
  assert.equal(statusOf(b1).status, 'interrupted'); assert.equal(JSON.parse(statusOf(b1).error_json).code, 'runner_lost');
  assert.equal(JSON.parse(acts(w, 'image_build.finish', b1.id)[0].details_json).status, 'interrupted');
  assert.ok(r.sentOf('image.build.cancel').some((m) => m.buildId === b1.id), 'the still-attached runner is told to stop it');
  // The port leaves ready (a crash) while a build runs.
  const b2 = build('sde-node', 'i-2');
  w.exec.tick(w.now());                                       // the scheduler sees the port ready
  r.setState('crashed'); w.exec.tick(w.now());
  assert.equal(statusOf(b2).status, 'interrupted');
  r.setState('ready'); w.exec.tick(w.now());
  // The inactivity deadline (fix round 3): no progress for 10 minutes -> cancelled at the runner, failed `timeout`.
  const b3 = build('sde-node', 'i-3');
  w.run(r, 9 * MIN);
  assert.equal(statusOf(b3).status, 'running');
  w.run(r, 90_000);
  assert.equal(statusOf(b3).status, 'failed'); assert.equal(JSON.parse(statusOf(b3).error_json).code, 'timeout');
  assert.ok(r.sentOf('image.build.cancel').some((m) => m.buildId === b3.id));
  // A late report changes nothing.
  r.report({ op: 'image.build.done', buildId: b3.id, outcome: 'succeeded', imageId: 'sha256:' + 'e6'.repeat(32), sizeBytes: 1 });
  assert.equal(statusOf(b3).status, 'failed');
  // A user cancels a running build; the system cannot; a second cancel is refused.
  const b4 = build('nexus-fwd', 'i-4');
  assert.throws(() => w.nx.approvals.cancelImageBuild(w.sys, b4.id), code('denied', 'user_only'));
  assert.equal(w.nx.approvals.cancelImageBuild(w.me, b4.id).status, 'cancelled');
  assert.ok(r.sentOf('image.build.cancel').some((m) => m.buildId === b4.id));
  assert.throws(() => w.nx.approvals.cancelImageBuild(w.me, b4.id), code('illegal_transition'));
  const fin = acts(w, 'image_build.finish', b4.id)[0];
  assert.equal(fin.actor_id, w.me.id); assert.equal(fin.status, 'cancelled');
  // A replaced runner port interrupts what the old one was building.
  const b5 = build('sde-node', 'i-5');
  w.exec.attachRunner(new FakeRunner(), w.bootId);
  assert.equal(statusOf(b5).status, 'interrupted');
  assert.equal(count(w, "image_builds WHERE status = 'running'"), 0);
  healthy(w); w.close();
});

test('M1 only a user stops a dev deployment: the system and an agent with a project role are denied and audited', async () => {
  const { w, r, app } = await deployWorld();
  const j = preview(w, app); w.exec.tick(w.now());
  const a = provisionService(w, r, j.id, 49310); probe(w, r, a, 200);
  const d = dep(w, j.id);
  assert.throws(() => w.nx.deployments.stop(w.sys, d.id), code('denied', 'user_only'));
  assert.equal(count(w, "activity WHERE status = 'denied' AND actor_id = 'system' AND action = 'deployment.stop'"), 1);
  w.db.prepare("INSERT INTO principals VALUES ('agent:bot', 'agent', 'bot', NULL, ?)").run(h.NOW);
  w.db.prepare("INSERT INTO memberships VALUES ('agent:bot', 'project', 'p-ledger', 'owner', ?)").run(h.NOW);
  assert.throws(() => w.nx.deployments.stop({ id: 'agent:bot', kind: 'agent', displayName: 'bot' }, d.id), code('denied', 'user_only'));
  assert.throws(() => w.nx.deployments.stop({ id: 'system', kind: 'user', displayName: 'forged' }, d.id), code('denied', 'user_only'));
  assert.throws(() => w.nx.deployments.stop(null, d.id), code('denied', 'user_only'));
  assert.equal(dep(w, j.id).status, 'healthy'); assert.equal(r.sentOf('attempt.cancel').length, 0);
  healthy(w); w.close();
});

test('M2 a dev deployment ends with its true cause: a refused preflight, a runner refusal, the app quitting', async () => {
  const { w, r, app } = await deployWorld();
  const reasonOf = (j) => JSON.parse(acts(w, 'deployment.transition', dep(w, j.id).id).pop().details_json).reason;
  // One live dev deployment per application version (B2a stabilization): concurrent previews need their own versions.
  const [v1, v2, v3, v4] = await previewableApps(w, r, app, 4);
  // A port conflict at preflight.
  const j1 = preview(w, v1); const j2 = preview(w, v2); w.exec.tick(w.now());
  provisionService(w, r, j1.id, 49320); provisionService(w, r, j2.id, 49320, 'f');
  assert.equal(reasonOf(j2), 'preflight_failed'); assert.equal(dep(w, j2.id).stop_reason, 'preflight_failed', 'the true cause on the row');
  assert.equal(ACT.activityText(actView(acts(w, 'deployment.transition', dep(w, j2.id).id).pop()), ACT_CTX),
    'Test run of your app failed: its safe space did not pass the safety checks');
  // A runner refusal.
  const j3 = preview(w, v3); w.exec.tick(w.now());
  r.report({ op: 'attempt.refused', attemptId: w.liveAttempt(j3.id).id, reason: 'docker_stopped' });
  assert.equal(reasonOf(j3), 'refused'); assert.equal(dep(w, j3.id).stop_reason, 'refused');
  // The app quits: a deployment that never passed its check ends its job cancelled (app_quit), not "exited".
  w.nx.deployments.stop(w.me, dep(w, j1.id).id);
  const j4 = preview(w, v4); w.exec.tick(w.now());
  const a4 = provisionService(w, r, j4.id, 49321, 'a');
  w.nx.deployments.stopAllForQuit();
  r.report({ op: 'attempt.exited', attemptId: a4.id, exit: { code: 143, oomKilled: false, finishedAt: w.now() }, outputs: [], parsed: [], logBytes: 1 });
  assert.equal(w.jobState(j4.id), 'cancelled'); assert.equal(w.job(j4.id).outcome, 'app_quit'); assert.equal(dep(w, j4.id).stop_reason, 'app_quit');
  assert.equal(w.attempt(a4.id).state, 'cancelled'); assert.equal(w.attempt(a4.id).exit_code, 143);
  // The pure mapping.
  assert.equal(endCause('failed', 'limits_not_applied', false), 'preflight_failed');
  assert.equal(endCause('failed', 'busy', false), 'refused');
  assert.equal(endCause('failed', 'not_sent', false), 'runner_lost');
  assert.equal(endCause('failed', 'container_vanished', true), 'exited');
  assert.equal(endCause('failed', null, false), 'start_timeout');
  assert.equal(endCause('interrupted', null, true), 'recovery');
  healthy(w); w.close();
});

test('M4 with a repository check configured a snapshot starts only through the snapshot request; a retry is refused too', async () => {
  const w = execWorld({ isRepository: async () => true }); w.attach();
  assert.throws(() => w.exec.start(w.me, w.req('sde.repository.snapshot')), code('invalid', 'repository_check_required'));
  assert.equal(count(w, "jobs WHERE recipe_id = 'repo.snapshot'"), 0);
  const { job, created } = await w.nx.repo.requestSnapshot(w.me, { projectId: 'p-ledger', workspaceId: 'sde', intentId: 'm4-1' });
  assert.equal(created, true);
  w.exec.cancel(w.me, job.id);
  assert.throws(() => w.exec.retry(w.me, job.id, 'm4-2'), code('invalid', 'repository_check_required'));
  // A forged token is not the token.
  assert.throws(() => w.exec.start(w.me, w.req('sde.repository.snapshot'), Symbol('nexus.repository-checked')), code('invalid', 'repository_check_required'));
  // Without a repository check (no checker in the composition) the core still keeps one live snapshot per project.
  const w2 = execWorld(); w2.attach();
  const s1 = w2.exec.start(w2.me, w2.req('sde.repository.snapshot'));
  const s2 = w2.exec.start(w2.me, w2.req('sde.repository.snapshot'));
  assert.equal(s1.created, true); assert.equal(s2.created, false); assert.equal(s2.job.id, s1.job.id);
  healthy(w); w.close(); w2.close();
});

test('M5 a stopped deployment whose exit is never reported frees its slot: the job fails exit_not_reported after the bound', async () => {
  const { w, r, app } = await deployWorld();
  // One live dev deployment per application version (B2a stabilization): concurrent previews need their own versions.
  const [v1, v2] = await previewableApps(w, r, app, 2);
  const j = preview(w, v1); w.exec.tick(w.now());
  const a = provisionService(w, r, j.id, 49330); probe(w, r, a, 200);
  w.nx.deployments.stop(w.me, dep(w, j.id).id);
  assert.equal(w.job(j.id).phase, 'stopping');
  w.run(r, 55_000);
  assert.equal(w.jobState(j.id), 'running');
  w.run(r, 10_000);
  assert.equal(w.jobState(j.id), 'failed'); assert.equal(w.job(j.id).outcome, 'exit_not_reported');
  assert.equal(w.attempt(a.id).state, 'failed');
  assert.equal(r.sentOf('attempt.cancel').filter((m) => m.attemptId === a.id).length, 2, 'told again');
  // The slot is free: two new previews both lease.
  const k = [preview(w, v1), preview(w, v2)]; w.exec.tick(w.now());
  assert.deepEqual(k.map((x) => w.jobState(x.id)), ['leased', 'leased']);
  healthy(w); w.close();
});

test('M6 a consumed approval never starts network work much later: a job not started within 15 minutes fails approval_stale', () => {
  const { w, r } = egressWorld();
  const d = depsJob(w); const ap = approvalOf(w, d.id);
  r.setState('starting');                                     // the runner is not ready: the job cannot start
  w.nx.approvals.respond(w.me, ap.id, 'once');
  assert.equal(w.jobState(d.id), 'awaiting_approval'); assert.equal(w.job(d.id).phase, 'waiting:runner');
  w.run(r, 14 * MIN);
  assert.equal(w.jobState(d.id), 'awaiting_approval');
  w.run(r, 90_000);
  assert.equal(w.jobState(d.id), 'failed'); assert.equal(w.job(d.id).outcome, 'denied');
  assert.equal(JSON.parse(w.job(d.id).error_json).code, 'approval_stale');
  r.setState('ready'); w.run(r, MIN);
  assert.equal(r.sentOf('attempt.start').length, 0, 'never started');
  assert.throws(() => w.exec.resumeApproved(d.id), code('illegal_transition'));
  healthy(w); w.close();
});

test('M7 an attempt another boot owns is never started from this process: the job waits (waiting:runner)', () => {
  const { w, r } = egressWorld();
  const d = depsJob(w);
  w.exec.attachRunner(r, newId(w.now() + 1));                 // this process is now another boot
  w.nx.approvals.respond(w.me, approvalOf(w, d.id).id, 'once');
  assert.equal(w.jobState(d.id), 'awaiting_approval'); assert.equal(w.job(d.id).phase, 'waiting:runner');
  assert.equal(approvalOf(w, d.id).consumed_by_attempt_n, 1);
  w.exec.tick(w.now());
  assert.equal(r.sentOf('attempt.start').length, 0);
  assert.throws(() => w.exec.resumeApproved(d.id), code('conflict', 'waiting:runner'));
  w.close();
});

test('M8 the consent says exactly what is enforced: one job, through the Nexus egress proxy, ONLY the allow-listed hosts (the same list the proxy gets), no install scripts, lockfile hashes', () => {
  // B2a stabilization (constraint 5): the hosts are now enforced, so the consent names them as the only reachable ones.
  const { w } = egressWorld({ imageContexts: (id) => (id === 'sde-node' ? CTX : null), freeBytes: 45 * GIB });
  const d = depsJob(w);
  assert.equal(approvalOf(w, d.id).summary, 'Network access for this one Node dependency install job, through the Nexus egress proxy. '
    + 'Only registry.npmjs.org (HTTPS, port 443) can be reached; every other host, private and loopback addresses, cloud metadata and this computer are refused. '
    + `Install scripts are disabled and packages must match the lockfile hashes (${LOCK.slice(0, 12)}).`);
  assert.doesNotMatch(approvalOf(w, d.id).summary, /not blocked|expected from/i);
  // The hosts in the consent are exactly the allow-list the plan gives the proxy.
  const { EGRESS_ALLOWLISTS, formatAllow } = require('./load-ts.cjs')('src/shared/nexus/egressPolicy.ts');
  assert.deepEqual(JSON.parse(approvalOf(w, d.id).request_json).registries, EGRESS_ALLOWLISTS['sde.deps.node'].map((e) => e.host));
  assert.equal(formatAllow(EGRESS_ALLOWLISTS['sde.deps.node']), 'registry.npmjs.org:443');
  const { approval } = w.nx.approvals.requestImage(w.me, 'sde-node', 'm8');
  assert.match(approval.summary, /not limited to particular hosts/);
  w.close();
});

test('M9 the deployment service job helpers act on dev deployment jobs only', () => {
  const w = execWorld(); w.attach();
  const b = w.exec.start(w.me, w.req('sde.build.run')).job; w.exec.tick(w.now());
  assert.throws(() => w.db.transaction(() => w.exec.endServiceJobTx(b.id, { state: 'failed', outcome: 'x', error: { code: 'x', message: 'x' } }, w.now())).immediate(),
    code('invalid', 'not_a_service_job'));
  assert.throws(() => w.db.transaction(() => w.exec.setJobPhaseTx(b.id, 'stopping', w.now())).immediate(), code('invalid', 'not_a_service_job'));
  assert.equal(w.jobState(b.id), 'leased'); assert.equal(w.job(b.id).phase, 'provisioning');
  w.close();
});

test('M10 (A6) the runner refuses an approval id bound to another job: a genuinely mismatched plan fails its job, never retried', () => {
  /** A runner that binds each approval id to the (job, attempt) it first carried, refusing it for any other. */
  class BindingRunner extends FakeRunner {
    constructor() { super(); this.bound = new Map(); this.tamper = null; }
    send(msg) {
      if (msg.op === 'attempt.start' && this.tamper) msg = this.tamper(JSON.parse(JSON.stringify(msg)));
      super.send(msg);
      const net = msg.op === 'attempt.start' && msg.plan.kind === 'tool' ? msg.plan.container.network : null;
      if (!net || net.mode !== 'egress-approved') return;
      const key = `${msg.plan.jobId}/${msg.plan.attemptN}`;
      const seen = this.bound.get(net.approvalId);
      if (seen && seen !== key) {
        this.report({ op: 'attempt.refused', attemptId: msg.attemptId, reason: 'network_not_approved', detail: 'approval id bound to another job' });
        return;
      }
      this.bound.set(net.approvalId, key);
    }
  }
  const w = execWorld({ approvals: 'real', repoMeta: { lockfile: { sha256: LOCK } }, dockerMemoryBytes: 64 * GIB });
  const r = new BindingRunner(); w.exec.attachRunner(r, w.bootId);
  const A = depsJob(w); const B = depsJob(w);
  const apA = approvalOf(w, A.id);
  w.nx.approvals.respond(w.me, apA.id, 'once');
  assert.equal(w.jobState(A.id), 'running');
  // The transport (not main) swaps B's approval id for A's: the runner refuses the mismatch.
  r.tamper = (m) => { if (m.plan.jobId === B.id) m.plan.container.network.approvalId = apA.id; return m; };
  w.nx.approvals.respond(w.me, approvalOf(w, B.id).id, 'once');
  assert.equal(r.lastStart().plan.container.network.approvalId, apA.id, 'the tampered plan reached the runner');
  assert.equal(w.jobState(B.id), 'failed'); assert.equal(w.attempts(B.id)[0].outcome, 'network_not_approved');
  assert.equal(JSON.parse(w.job(B.id).error_json).code, 'network_not_approved');
  w.run(r, 2 * MIN);
  assert.equal(w.jobState(B.id), 'failed', 'never retried'); assert.equal(w.jobState(A.id), 'running');
  healthy(w); w.close();
});

test('M10 (S2) planted secrets in every free-text report never reach approvals, builds, deployments, events, activity, jobs or attempts', async () => {
  const token = 'ghp_' + 'Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8';
  const { w, r, app } = await deployWorld({ approvals: 'real', repoMeta: { lockfile: { sha256: LOCK } }, imageContexts: (id) => (id === 'sde-node' ? CTX : null) });
  // Image build: progress phase and failure text.
  const { approval } = w.nx.approvals.requestImage(w.me, 'sde-node', 's2');
  w.nx.approvals.respond(w.me, approval.id, 'once');
  const b = w.db.prepare('SELECT id FROM image_builds WHERE approval_id = ?').get(approval.id);
  r.report({ op: 'image.build.progress', buildId: b.id, at: w.now(), phase: `pulling with token=${token}` });
  r.report({ op: 'image.build.done', buildId: b.id, outcome: 'failed', error: `npm said: //registry/:_authToken=${token}` });
  // A dev deployment: a refusal detail and a runner-wide fault message.
  const j = preview(w, app); w.exec.tick(w.now());
  r.report({ op: 'attempt.refused', attemptId: w.liveAttempt(j.id).id, reason: 'busy', detail: `daemon said ${token}` });
  const j2 = preview(w, app); w.exec.tick(w.now());
  const a2 = provisionService(w, r, j2.id, 49340); probe(w, r, a2, 200);
  r.report({ op: 'fault', message: `fatal: ${token}` });
  w.nx.deployments.stop(w.me, dep(w, j2.id).id);
  // An egress approval and its answer.
  const d = depsJob(w); w.nx.approvals.respond(w.me, approvalOf(w, d.id).id, 'deny');
  const texts = recordTexts(w);
  assert.ok(texts.length > 50, `the scan sees the records (${texts.length})`);
  for (const t of texts) {
    assert.ok(!t.includes(token) && !t.includes('ghp_'), t.slice(0, 160));
    assert.ok(!hasProviderKey(t), t.slice(0, 160));
  }
  healthy(w); w.close();
});

test('M10 (D8) app quit stops at most 100 deployments in one bounded pass; the next pass stops the rest', async () => {
  const { w, app } = await deployWorld();
  const ins = w.db.prepare(`INSERT INTO deployments (id, project_id, participation_id, subject_version_id, job_id, environment, bind_address, host_port,
    status, health_json, created_by, started_at, status_changed_at, updated_at) VALUES (?, 'p-ledger', ?, ?, ?, 'local-preview', '127.0.0.1', NULL, 'starting', '[]',
    'user:local', ?, ?, ?)`);
  for (let i = 0; i < 101; i++) {
    const job = w.nx.jobs.create(w.me, { kind: 'tool.run', projectId: 'p-ledger', workspaceId: 'sde', idempotencyKey: `quit-${i}` }).job;
    ins.run(newId(w.now() + i), w.pw.id, app, job.id, w.now() + i, w.now(), w.now());
  }
  const t = performance.now();
  assert.equal(w.nx.deployments.stopAllForQuit(), 100);
  const ms = performance.now() - t;
  assert.ok(ms < 2_000, `one bounded pass (${ms.toFixed(0)} ms)`);
  assert.equal(count(w, "deployments WHERE status = 'stopped' AND stop_reason = 'app_quit'"), 100);
  assert.equal(count(w, "deployments WHERE status = 'starting'"), 1, 'the 101st waits for the next pass');
  assert.equal(count(w, "activity WHERE action = 'deployment.transition'"), 100);
  assert.equal(w.nx.deployments.stopAllForQuit(), 1);
  assert.equal(count(w, "deployments WHERE status = 'starting'"), 0);
  healthy(w); w.close();
});

// ---------- fix round 2: the true end cause on the deployment row ----------

test('F2 deployments.stop_reason holds the true cause: the v9 CHECK takes refused, preflight_failed, runner_lost and exit_not_reported', async () => {
  const { w, r, app } = await deployWorld();
  const { V9_DDL } = loadTs('src/main/nexus/db/schemaV9.ts');
  const check = V9_DDL.match(/stop_reason\s+TEXT CHECK \(stop_reason IS NULL OR stop_reason IN \(([^)]*)\)\)/);
  assert.ok(check, 'the stop_reason CHECK is in V9_DDL');
  assert.deepEqual(check[1].replace(/\s+/g, '').split(',').map((x) => x.replace(/'/g, '')),
    ['user', 'idle', 'cancel', 'app_quit', 'recovery', 'exited', 'probe_failed', 'start_timeout', 'refused', 'preflight_failed', 'runner_lost', 'exit_not_reported']);
  // Every value is accepted on a row; anything else is refused by the database.
  const fail = (reason) => {
    const j = preview(w, app); w.exec.tick(w.now());
    const d = dep(w, j.id);
    w.db.prepare("UPDATE deployments SET status = 'failed', stop_reason = ?, stopped_at = ?, status_changed_at = ?, updated_at = ? WHERE id = ?")
      .run(reason, w.now(), w.now(), w.now(), d.id);
    w.exec.cancel(w.me, j.id);
    return dep(w, j.id).stop_reason;
  };
  for (const reason of ['refused', 'preflight_failed', 'runner_lost', 'exit_not_reported']) assert.equal(fail(reason), reason);
  assert.throws(() => fail('timeout_or_whatever'), /CHECK/);
  for (const j of w.db.prepare("SELECT id FROM jobs WHERE recipe_id = 'sde.preview.start' AND state NOT IN ('cancelled','failed','completed')").all()) {
    w.exec.cancel(w.me, j.id);
  }
  // A runner lost after the container started: the row says runner_lost (not exited).
  const j = preview(w, app); w.exec.tick(w.now());
  const a = provisionService(w, r, j.id, 49350);
  w.run(null, 65_000);                                        // no heartbeat: the lease runs out
  assert.equal(w.attempt(a.id).outcome, 'runner_lost');
  assert.equal(dep(w, j.id).status, 'failed'); assert.equal(dep(w, j.id).stop_reason, 'runner_lost');
  assert.equal(JSON.parse(acts(w, 'deployment.transition', dep(w, j.id).id).pop().details_json).reason, 'runner_lost');
  assert.equal(endCause('failed', 'exit_not_reported', true), 'exit_not_reported');
  assert.equal(ACT.activityText(actView({ ...acts(w, 'deployment.transition', dep(w, j.id).id).pop(),
    details_json: JSON.stringify({ to: 'failed', reason: 'exit_not_reported' }) }), ACT_CTX), 'Test run of your app failed: Nexus never heard that it had stopped');
  healthy(w); w.close();
});

// ---------- fix round 3 ----------

test('N1 cancelling a healthy preview job records deployment.transition (cancel), matching the row; only a user stop is deployment.stop', async () => {
  const { w, r, app } = await deployWorld();
  const j = preview(w, app); w.exec.tick(w.now());
  const a = provisionService(w, r, j.id, 49360); probe(w, r, a, 200);
  const d = dep(w, j.id);
  w.exec.cancel(w.me, j.id);
  assert.equal(dep(w, j.id).status, 'stopped'); assert.equal(dep(w, j.id).stop_reason, 'cancel'); assert.equal(dep(w, j.id).stopped_by, w.me.id);
  assert.equal(acts(w, 'deployment.stop', d.id).length, 0, 'not a stop of the deployment itself');
  const t = acts(w, 'deployment.transition', d.id).pop();
  assert.equal(t.actor_id, w.me.id);
  assert.equal(JSON.parse(t.details_json).to, 'stopped'); assert.equal(JSON.parse(t.details_json).reason, 'cancel');
  assert.equal(ACT.activityText(actView(t), ACT_CTX), 'Test run of your app stopped with its task');
  // A user's stop of a deployment is still deployment.stop with reason user.
  const j2 = preview(w, app); w.exec.tick(w.now());
  const a2 = provisionService(w, r, j2.id, 49361, 'f'); probe(w, r, a2, 200);
  w.nx.deployments.stop(w.me, dep(w, j2.id).id);
  assert.equal(JSON.parse(acts(w, 'deployment.stop', dep(w, j2.id).id)[0].details_json).reason, 'user');
  healthy(w); w.close();
});

test('N2 builds interrupted by a runner-wide fault are cancelled at the runner that is still attached, so none keeps running', () => {
  const { w, r } = imageWorld({ freeBytes: 45 * GIB });
  const build = (profile, k) => {
    const { approval } = w.nx.approvals.requestImage(w.me, profile, k);
    w.nx.approvals.respond(w.me, approval.id, 'once');
    return w.db.prepare('SELECT * FROM image_builds WHERE approval_id = ?').get(approval.id);
  };
  const b1 = build('sde-node', 'n2-1'); const b2 = build('nexus-fwd', 'n2-2');
  r.report({ op: 'fault', message: 'the runner lost its Docker connection' });
  for (const b of [b1, b2]) {
    assert.equal(w.db.prepare('SELECT status FROM image_builds WHERE id = ?').get(b.id).status, 'interrupted');
    assert.equal(r.sentOf('image.build.cancel').filter((m) => m.buildId === b.id).length, 1, 'told once, best effort');
  }
  // A new build of the same profile is accepted and is the only one the runner was not told to stop.
  const b3 = build('sde-node', 'n2-3');
  assert.equal(r.sentOf('image.build.cancel').filter((m) => m.buildId === b3.id).length, 0);
  assert.equal(count(w, "image_builds WHERE status = 'running'"), 1);
  // A port that throws on send does not stop the interruption (best effort).
  r.o.failSend = (m) => m.op === 'image.build.cancel';
  r.report({ op: 'fault', message: 'again' });
  assert.equal(w.db.prepare('SELECT status FROM image_builds WHERE id = ?').get(b3.id).status, 'interrupted');
  r.o.failSend = null;
  healthy(w); w.close();
});

test('N3 a build that keeps reporting progress is not killed at 60 minutes; no progress for 10 minutes or 180 minutes in all fails it', () => {
  const { w, r } = imageWorld({ freeBytes: 45 * GIB });
  const build = (profile, k) => {
    const { approval } = w.nx.approvals.requestImage(w.me, profile, k);
    w.nx.approvals.respond(w.me, approval.id, 'once');
    return w.db.prepare('SELECT * FROM image_builds WHERE approval_id = ?').get(approval.id);
  };
  const statusOf = (b) => w.db.prepare('SELECT status, error_json FROM image_builds WHERE id = ?').get(b.id);
  const progress = (b, minutes, phase = 'installing packages') => {
    for (let m = 0; m < minutes; m += 5) {
      w.run(r, 5 * MIN, 60_000);
      r.report({ op: 'image.build.progress', buildId: b.id, at: w.now(), phase, bytes: m });
    }
  };
  // Progress in one phase every 5 minutes for 65 minutes: still running (the old absolute 60 minutes is gone).
  const b1 = build('sde-node', 'n3-1');
  progress(b1, 65);
  assert.equal(statusOf(b1).status, 'running');
  assert.ok(count(w, "job_events WHERE image_build_id = ? AND type = 'image_build'", b1.id) >= 13, 'the progress is durable');
  // Then silence: 9 minutes later still running, 10 minutes later failed and cancelled.
  w.run(r, 9 * MIN, 30_000);
  assert.equal(statusOf(b1).status, 'running');
  w.run(r, 90_000, 30_000);
  assert.equal(statusOf(b1).status, 'failed'); assert.equal(JSON.parse(statusOf(b1).error_json).code, 'timeout');
  assert.match(JSON.parse(statusOf(b1).error_json).message, /no progress for 10 minutes/);
  assert.ok(r.sentOf('image.build.cancel').some((m) => m.buildId === b1.id));
  // Progress the whole time: failed at the 180 minute cap, and cancelled.
  const b2 = build('nexus-fwd', 'n3-2');
  progress(b2, 175);
  assert.equal(statusOf(b2).status, 'running');
  progress(b2, 10);
  assert.equal(statusOf(b2).status, 'failed'); assert.match(JSON.parse(statusOf(b2).error_json).message, /longer than 180 minutes/);
  assert.ok(r.sentOf('image.build.cancel').some((m) => m.buildId === b2.id));
  // The last progress is read back from the rows: a fresh composition judges a silent build the same way.
  const b3 = build('sde-node', 'n3-3');
  progress(b3, 5);
  const nx2 = createNexusPlatform(w.db, { now: () => w.now(), execution: true, imageContexts: () => CTX });
  w.advance(9 * MIN); nx2.approvals.tick(w.now());
  assert.equal(statusOf(b3).status, 'running', 'its last progress, read from job_events, is 9 minutes old');
  w.advance(2 * MIN); nx2.approvals.tick(w.now());
  assert.equal(statusOf(b3).status, 'failed');
  healthy(w); w.close();
});
