'use strict';
// B2b Task 5: the MCP gateway in main (token/tool/scope/cap verification, one service call, audit), exec grants
// without an output relay, the main-written context file and the skill bundle.
// MG1-MG14 (MG1-MG12 as in Revision 0 with the renamed, underscore tool names; MG13 the exec grant/callId idempotency
// and the forged-execId drop; MG14 the context file at scale). Driven entirely through `agentFixtures` and a
// `FakeRunner`'s `report()`, exactly as the runner relay (Task 6) will deliver `mcp.call` and `agent.exec.done`.
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { agentWorld, openRunningTurn, endTurn } = require('./helpers/agentFixtures.cjs');
const loadTs = require('./load-ts.cjs');
const { JOB_REQUEST_RECIPES } = loadTs('src/shared/nexus/mcpTools.ts');
const { resolveDataHome } = loadTs('src/main/nexusExec/dataHome.ts');
const { newId } = loadTs('src/main/nexus/db/ids.ts');
const { TOKEN_DEFAULT_TTL_MS } = loadTs('src/main/nexus/agents/tokenService.ts');

const ROOT = path.resolve(__dirname, '..');

async function world(o = {}) {
  const homeRoot = h.tmpDir('nx-agent-mcp-home-');
  const dataHome = resolveDataHome(homeRoot);
  await dataHome.ensure();
  const w = agentWorld({ ...o, platform: { dataHome, ...(o.platform ?? {}) } });
  w.turn = (opts = {}) => openRunningTurn(w.db, w.nx, opts);
  w.homeRoot = dataHome.root;
  w.readWritten = (rel) => require('node:fs').readFileSync(path.join(w.homeRoot, rel), 'utf8');
  return w;
}

/** Sends one mcp.call through the real relay path (FakeRunner.report -> ExecutionService.onRunnerMessage -> the
 *  gateway -> ExecutionService.send). Waits for the gateway's promise to settle, then returns the LATEST mcp.reply
 *  sent for this callId (a reused callId, as MG13 does on purpose, may be answered more than once). */
async function mcpCall(w, turn, tool, args, callId) {
  const id = callId ?? `c${crypto.randomBytes(8).toString('hex')}`;
  turn.runner.report({ op: 'mcp.call', callId: id, bearer: turn.token, tool, args });
  await w.nx.exec.mcpCallsSettled();
  const replies = turn.runner.sentOf('mcp.reply').filter((m) => m.callId === id);
  assert.ok(replies.length >= 1, `at least one mcp.reply for ${tool}/${id}`);
  return replies[replies.length - 1].result;
}

function mcpCallRows(w) { return w.db.prepare("SELECT * FROM activity WHERE action = 'mcp.call' ORDER BY seq").all(); }
function toolEvents(w, jobId) {
  return w.db.prepare("SELECT * FROM job_events WHERE job_id = ? AND type = 'attempt.progress' ORDER BY seq").all(jobId)
    .map((r) => ({ ...r, data: JSON.parse(r.data_json) }));
}

const COMMIT = 'c0ffee'.padEnd(40, '0');
const IMAGE = { 'sde-node': 'sha256:' + '1'.repeat(64), 'sde-python': 'sha256:' + '2'.repeat(64) };

/** A candidate repository version (project data the snapshot ingest writes; the fixture inserts the artifact row itself). */
function addRepository(w, profile = 'sde-node', artifactId = null, commit = COMMIT) {
  const pw = w.nx.workspaces.primaryOf(w.me, 'p-ledger');
  let art = artifactId;
  if (!art) {
    art = newId(w.clock.t);
    w.db.prepare(`INSERT INTO artifacts (id, project_id, kind, name, description, owner_scope, owner_participation_id, owner_workspace_id,
        created_by, status, current_version_id, metadata_json, created_at, updated_at)
      VALUES (?, 'p-ledger', 'repository', 'ledger-api', NULL, 'participation', ?, ?, 'user:local', 'active', NULL, '{}', ?, ?)`)
      .run(art, pw.id, pw.workspaceId, w.clock.t, w.clock.t);
  }
  const v = w.nx.artifacts.registerVersion(w.me, { artifactId: art, storage: { kind: 'git', commit }, metadata: { profile, lockfile: { sha256: 'a'.repeat(64) } } }).version.id;
  w.nx.artifacts.finalize(w.sys, v, 'candidate');
  return { artifactId: art, versionId: v };
}

/** The runner's probe: Docker up, both images present, plenty of disk (what lets the scheduler lease). */
function readyProbe(turn) {
  turn.runner.report({ op: 'probe.result', probe: { docker: 'running', version: '27.0.0', cpus: 4, memoryBytes: 8 * 2 ** 30,
    gpu: { detected: false, usableInContainers: false } },
  images: ['sde-node', 'sde-python'].map((profile) => ({ profile, present: true, digestMatches: true, imageId: IMAGE[profile] })),
  freeBytes: 100 * 2 ** 30, runtimes: [] });
}

function makeVersion(w, kind, content, workspaceId = 'sde') {
  const art = w.nx.artifacts.create(w.me, { projectId: 'p-ledger', workspaceId, kind, name: `${kind}-${crypto.randomBytes(3).toString('hex')}` });
  const v = w.nx.artifacts.registerVersion(w.me, { artifactId: art.id, storage: { kind: 'inline', json: content } }).version.id;
  w.nx.artifacts.finalize(w.sys, v, 'candidate');
  return v;
}

// ---------- MG1: every allowed tool's happy path ----------

test('MG1 every allowed tool answers ok and writes one mcp.call row plus one attempt.progress {t:"tool"} event', async () => {
  const w = await world();
  const v1 = makeVersion(w, 'requirement', { title: 'r1', criteria: [{ id: 'c1', text: 'works' }] });
  const repo = addRepository(w);
  const t = w.turn({ inputs: [v1, repo.versionId] });
  await w.nx.contextResolver.resolve({ id: t.job.id, projectId: t.job.projectId, workspaceId: t.job.workspaceId, sessionId: t.session.id });

  const cases = [
    ['context_get', {}],
    ['artifact_list', {}],
    ['artifact_read', { versionId: v1 }],
    ['validations_get', { versionId: v1 }],
    ['job_status', { jobId: t.job.id }],
    ['job_logs', { jobId: t.job.id }],
    ['sandbox_exec', { argv: ['echo', 'hi'], cwd: '/workspace', timeoutMs: 5000 }],
    ['job_request', { recipeId: 'sde.test.discover', inputs: [repo.versionId] }],
    ['requirement_draft', { title: 'From the agent', criteria: [{ id: 'c1', text: 'it works' }], clientKey: 'k1' }],
    ['review_request', { versionId: v1, note: 'please look' }]
  ];
  for (const [tool, args] of cases) {
    const before = mcpCallRows(w).length;
    const result = await mcpCall(w, t, tool, args);
    assert.equal(result.ok, true, `${tool}: ${JSON.stringify(result)}`);
    const rows = mcpCallRows(w);
    assert.equal(rows.length, before + 1, `${tool}: exactly one mcp.call row`);
    const row = rows[rows.length - 1];
    assert.equal(row.actor_kind, 'agent');
    assert.equal(row.status, 'succeeded');
    assert.equal(JSON.parse(row.details_json).tool, tool);
  }
  const events = toolEvents(w, t.job.id).filter((e) => e.data.t === 'tool');
  assert.equal(events.length, cases.length);
  for (const e of events) assert.equal(e.data.ok, true);
});

// ---------- MG2: artifact_read of a version not in the inputs is denied ----------

test('MG2 artifact_read of a version outside the turn is denied, no mcp.call row', async () => {
  const w = await world();
  const v1 = makeVersion(w, 'requirement', { title: 'in', criteria: [{ id: 'c1', text: 'x' }] });
  const v2 = makeVersion(w, 'requirement', { title: 'out', criteria: [{ id: 'c1', text: 'x' }] });
  const t = w.turn({ inputs: [v1] });
  const before = mcpCallRows(w).length;
  const result = await mcpCall(w, t, 'artifact_read', { versionId: v2 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'out_of_scope');
  assert.equal(mcpCallRows(w).length, before, 'a token-level denial writes no extra mcp.call row (auth.denied already audits it)');
  const denied = w.db.prepare("SELECT * FROM activity WHERE action = 'auth.denied' ORDER BY seq DESC LIMIT 1").get();
  assert.equal(JSON.parse(denied.details_json).reason, 'out_of_scope');
});

// ---------- MG3: job_request for sde.build.node is denied ----------

test('MG3 job_request for sde.build.node is denied (not one of the three allowed recipes)', async () => {
  const w = await world();
  const t = w.turn();
  const result = await mcpCall(w, t, 'job_request', { recipeId: 'sde.build.node' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'bad_args');
  assert.deepEqual(JOB_REQUEST_RECIPES, ['sde.deps.node', 'sde.deps.python', 'sde.test.discover']);
});

// ---------- MG4: the 21st child job is denied ----------

test('MG4 the 21st child job_request is denied', async () => {
  const w = await world();
  const repo = addRepository(w);
  const t = w.turn({ maxChildJobs: 2, inputs: [repo.versionId] });
  const req = { recipeId: 'sde.test.discover', inputs: [repo.versionId] };
  const r1 = await mcpCall(w, t, 'job_request', req, 'call-1');
  assert.equal(r1.ok, true);
  const r2 = await mcpCall(w, t, 'job_request', req, 'call-2');
  assert.equal(r2.ok, true);
  const r3 = await mcpCall(w, t, 'job_request', req, 'call-3');
  assert.equal(r3.ok, false);
  assert.equal(r3.code, 'limit');
  const children = w.db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE parent_job_id = ?').get(t.job.id).n;
  assert.equal(children, 2, 'the third request created no job');
});

// ---------- MG5: sandbox_exec for another job's attempt (no live attempt of this job) is denied ----------

test("MG5 sandbox_exec is scoped to the calling job's own live attempt; without one it is denied", async () => {
  const w = await world();
  const t = w.turn();
  // End the attempt without ending the token: the job still looks "running" to the token, but has no live attempt.
  w.db.prepare("UPDATE job_attempts SET state = 'succeeded', outcome = 'completed', exit_code = 0, oom_killed = 0, finished_at = ? WHERE id = ?")
    .run(w.clock.t, t.attempt.id);
  const result = await mcpCall(w, t, 'sandbox_exec', { argv: ['echo', 'hi'], cwd: '/workspace', timeoutMs: 5000 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'no_attempt');
});

// ---------- MG6: the tool-call cap answers limit ----------

test('MG6 the per-turn tool-call cap answers limit once reached', async () => {
  const w = await world();
  w.nx.budget.grant(w.me, { runtimeKind: 'scripted', hosts: [{ host: 'api.example.test', port: 443 }], caps: { toolCalls: 2 } });
  const t = w.turn();
  const r1 = await mcpCall(w, t, 'context_get', {}, 'cap-1');
  assert.equal(r1.ok, false, 'no context written yet, but it counted against the cap');
  const r2 = await mcpCall(w, t, 'context_get', {}, 'cap-2');
  assert.equal(r2.ok, false);
  const r3 = await mcpCall(w, t, 'context_get', {}, 'cap-3');
  assert.equal(r3.ok, false);
  assert.equal(r3.code, 'limit');
  const row = mcpCallRows(w).pop();
  assert.equal(JSON.parse(row.details_json).code, 'limit');
});

// ---------- MG7: malformed args answer bad_args, with one audit row ----------

test('MG7 malformed args answer bad_args with exactly one mcp.call audit row', async () => {
  const w = await world();
  const t = w.turn();
  const before = mcpCallRows(w).length;
  const result = await mcpCall(w, t, 'sandbox_exec', { argv: [], cwd: '/workspace', timeoutMs: 5000 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'bad_args');
  const rows = mcpCallRows(w);
  assert.equal(rows.length, before + 1);
  assert.equal(rows[rows.length - 1].status, 'failed');
});

// ---------- MG8: an unknown tool is refused ----------

test('MG8 an unknown (free-text) tool is refused, no mcp.call row', async () => {
  const w = await world();
  const t = w.turn();
  const before = mcpCallRows(w).length;
  const result = await mcpCall(w, t, 'delete_everything', {});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'unknown_tool');
  assert.equal(mcpCallRows(w).length, before);
});

// ---------- MG9: a secret-shaped argument is stored redacted ----------

test('MG9 a secret-shaped argument is stored redacted in argsSummary', async () => {
  const w = await world();
  const secretNote = 'sk-ant-abcdefghijklmnopqrstuvwxyzABCD1234';
  const v1 = makeVersion(w, 'requirement', { title: 'r', criteria: [{ id: 'c1', text: 'x' }] });
  const t = w.turn({ inputs: [v1] });
  const result = await mcpCall(w, t, 'review_request', { versionId: v1, note: secretNote });
  // The note is secret-shaped: review_request itself refuses it (never stored, never returned).
  assert.equal(result.ok, false);
  const row = mcpCallRows(w).pop();
  const summary = JSON.parse(row.details_json).argsSummary;
  assert.ok(!summary.includes('sk-ant-'), 'argsSummary never holds the raw secret');
  assert.match(summary, /redacted/);
});

// ---------- MG10: a requirement draft runs req.schema, then finalizes to candidate ----------

test('MG10 requirement_draft runs req.schema then finalizes to candidate', async () => {
  const w = await world();
  const t = w.turn();
  const result = await mcpCall(w, t, 'requirement_draft', { title: 'A new requirement', body: 'details',
    criteria: [{ id: 'c1', text: 'acceptance' }], clientKey: 'rd1' });
  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'candidate');
  const v = w.nx.artifacts.getVersion(w.me, result.value.versionId);
  assert.equal(v.status, 'candidate');
  assert.deepEqual(v.storage.json, { title: 'A new requirement', body: 'details', criteria: [{ id: 'c1', text: 'acceptance' }] });

  // req.schema refuses bad content before anything is written.
  const bad = await mcpCall(w, t, 'requirement_draft', { title: '', criteria: [], clientKey: 'rd2' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'bad_args', 'the MCP schema itself already refuses an empty title/criteria');
});

// ---------- MG11: a call after the job ends answers revoked ----------

test('MG11 a call after the turn ends answers revoked', async () => {
  const w = await world();
  const t = w.turn();
  endTurn(w.db, w.nx, t, { revoke: true });
  const result = await mcpCall(w, t, 'context_get', {});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'revoked');
});

// ---------- MG12 / MG14: the context file ----------

function insertUserMessage(w, t, id, text) {
  w.db.prepare('INSERT INTO activity (id, ts, actor_kind, actor_id, session_id, job_id, entity_type, action, status, details_json, prev_hash, hash) '
    + "VALUES (?, ?, 'user', ?, ?, ?, 'session', 'user.message', 'succeeded', ?, '', '')")
    .run(id, w.clock.t, w.me.id, t.session.id, t.job.id, JSON.stringify({ text }));
}
function contextJob(t) { return { id: t.job.id, projectId: t.job.projectId, workspaceId: t.job.workspaceId, sessionId: t.session.id }; }

test('MG12 the context file holds no secret and its hash is stored in jobs.context_hash', async () => {
  const w = await world();
  const v1 = makeVersion(w, 'requirement', { title: 'focus one', criteria: [{ id: 'c1', text: 'x' }] });
  const t = w.turn({ inputs: [v1] });
  assert.ok(w.nx.contextResolver, 'agentWorld composes a ContextResolver when agents are available');
  insertUserMessage(w, t, 'msg1', 'here is a secret: password=hunter2hunter2');
  const r = await w.nx.contextResolver.resolve(contextJob(t));
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
  const row = w.db.prepare('SELECT context_hash FROM jobs WHERE id = ?').get(t.job.id);
  assert.equal(row.context_hash, r.sha256);
  const written = w.readWritten(r.path);
  assert.ok(!written.includes('hunter2'), 'no secret in the context file');
  assert.match(written, new RegExp(v1), 'the focus version is still there');
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM activity WHERE action = 'context_redacted' AND job_id = ?").get(t.job.id).n, 1);
});

test('MG14 the context file holds a 200 KiB history intact and contains no secret', async () => {
  const w = await world();
  const t = w.turn();
  const big = 'x'.repeat(200 * 1024);
  insertUserMessage(w, t, 'msg-big', big);
  const r = await w.nx.contextResolver.resolve(contextJob(t));
  const written = w.readWritten(r.path);
  assert.ok(written.includes(big), 'the large history survives intact');
  assert.doesNotMatch(written, /password|secret/i, 'no secret-shaped content leaks into the file');
});

// ---------- MG13: a grant is issued once per callId; a forged execId is dropped ----------

test('MG13 a grant is issued once per callId; agent.exec.done with a forged execId is dropped', async () => {
  const w = await world();
  const t = w.turn();
  const r1 = await mcpCall(w, t, 'sandbox_exec', { argv: ['echo', 'hi'], cwd: '/workspace', timeoutMs: 5000 }, 'exec-call-1');
  assert.equal(r1.ok, true);
  const execId = r1.value.grant.execId;
  const r2 = await mcpCall(w, t, 'sandbox_exec', { argv: ['echo', 'bye'], cwd: '/workspace', timeoutMs: 5000 }, 'exec-call-1');
  assert.deepEqual(r2, r1, 'the same callId gets the same grant, never a second one');

  t.runner.report({ op: 'agent.exec.done', attemptId: t.attempt.id, execId: 'forged-exec-id-00000000000000', exit: { code: 0, oomKilled: false, finishedAt: w.clock.t },
    stdoutBytes: 10, stderrBytes: 0, stdoutSha256: '0'.repeat(64), truncated: false });
  assert.equal(w.logs.some((l) => l.includes('unknown exec')), true, 'one log line for the forged execId');
  const before = toolEvents(w, t.job.id).filter((e) => e.data.t === 'exec.done').length;
  assert.equal(before, 0);

  t.runner.report({ op: 'agent.exec.done', attemptId: t.attempt.id, execId, exit: { code: 0, oomKilled: false, finishedAt: w.clock.t },
    stdoutBytes: 10, stderrBytes: 0, stdoutSha256: '1'.repeat(64), truncated: false });
  const done = toolEvents(w, t.job.id).filter((e) => e.data.t === 'exec.done');
  assert.equal(done.length, 1);
  assert.equal(done[0].data.execId, execId);
  assert.equal(done[0].data.stdoutSha256, '1'.repeat(64));
});

// ---------- Skills.write ----------

test('Skills.write writes skills.md with the requested, domain-matching skills only', async () => {
  const w = await world({ platform: { skillsResourcesDir: path.join(ROOT, 'resources') } });
  const t = w.turn();
  const skills = w.nx.skills;
  assert.ok(skills, 'agentWorld composes Skills when agents are available');
  const written = await skills.write({ id: t.job.id, workspaceId: t.job.workspaceId },
    ['nexus-sde-change', 'not-a-real-skill', 'nexus-sde-change']);
  assert.equal(written.length, 1, 'an unknown id is dropped and a duplicate is written once');
  assert.equal(written[0].id, 'nexus-sde-change');
  assert.match(written[0].sha256, /^[0-9a-f]{64}$/);
  const fs = require('node:fs');
  const text = fs.readFileSync(require('node:path').join(w.homeRoot, `jobs/${t.job.id}/agent/skills.md`), 'utf8');
  assert.match(text, /nexus-sde-change/);
});

// ---------- fix round 1 ----------

const jobRow = (w, id) => w.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);

test('FR1 a job_request job is written with capability and limits and the scheduler leases it (it never stays queued forever)', async () => {
  const w = await world();
  const repo = addRepository(w);
  const t = w.turn({ inputs: [repo.versionId] });
  readyProbe(t);
  const r = await mcpCall(w, t, 'job_request', { recipeId: 'sde.test.discover', inputs: [repo.versionId] });
  assert.equal(r.ok, true, JSON.stringify(r));
  const j = jobRow(w, r.value.jobId);
  assert.equal(j.kind, 'tool.run'); assert.equal(j.recipe_id, 'sde.test.discover');
  assert.equal(j.parent_job_id, t.job.id); assert.equal(j.session_id, t.session.id);
  const cap = JSON.parse(j.capabilities_json);
  assert.equal(cap.length, 1); assert.equal(cap[0].action, 'sde.tests.discover'); assert.equal(cap[0].recipe, 'sde.test.discover');
  assert.equal(cap[0].network, 'none');
  const limits = JSON.parse(j.limits_json);
  assert.ok(limits.wallClockMs > 0 && limits.memoryMb > 0, "limits are the recipe's");
  assert.equal(j.state, 'queued');
  assert.equal(w.db.prepare('SELECT role FROM job_inputs WHERE job_id = ?').get(j.id).role, 'repository', "the input fills the action's slot");
  // The scheduler's pass picks it up: a leased attempt, and the runner is told to start it.
  w.nx.exec.tick(w.advance(1000));
  assert.equal(jobRow(w, j.id).state, 'leased');
  const attempt = w.db.prepare('SELECT * FROM job_attempts WHERE job_id = ?').get(j.id);
  assert.ok(attempt, 'an attempt exists');
  assert.ok(t.runner.sentOf('attempt.start').some((m) => m.attemptId === attempt.id), 'attempt.start was sent');
});

test('FR1b a retried job_request (same callId) creates one job; a missing repository input is refused', async () => {
  const w = await world();
  const repo = addRepository(w);
  const t = w.turn({ inputs: [repo.versionId] });
  const a = await mcpCall(w, t, 'job_request', { recipeId: 'sde.test.discover', inputs: [repo.versionId] }, 'jr-1');
  const b = await mcpCall(w, t, 'job_request', { recipeId: 'sde.test.discover', inputs: [repo.versionId] }, 'jr-1');
  assert.deepEqual(a, b);
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE parent_job_id = ?').get(t.job.id).n, 1);
  const none = await mcpCall(w, t, 'job_request', { recipeId: 'sde.test.discover' });
  assert.equal(none.ok, false); assert.equal(none.code, 'invalid');
});

test('FR3 sde.deps.node and sde.deps.python (the approval.request ceiling path): created with capability, then held for the A1 approval, never straight to running', async () => {
  const w = await world({ platform: { approvals: undefined } });
  const node = addRepository(w, 'sde-node');
  const py = addRepository(w, 'sde-python', node.artifactId, 'd0d0'.padEnd(40, '0'));
  const t = w.turn({ inputs: [node.versionId, py.versionId] });
  readyProbe(t);
  for (const [recipeId, repo, other] of [['sde.deps.node', node, py], ['sde.deps.python', py, node]]) {
    const r = await mcpCall(w, t, 'job_request', { recipeId, inputs: [repo.versionId] });
    assert.equal(r.ok, true, `${recipeId}: ${JSON.stringify(r)}`);
    const j = jobRow(w, r.value.jobId);
    const cap = JSON.parse(j.capabilities_json)[0];
    assert.equal(cap.recipe, recipeId); assert.equal(cap.action, 'sde.deps.install'); assert.equal(cap.network, 'egress-approved');
    assert.equal(j.parent_job_id, t.job.id);
    // The scheduler asks the user (A1): a pending approval and a job awaiting it; no container was started.
    w.nx.exec.tick(w.advance(1000));
    assert.equal(jobRow(w, j.id).state, 'awaiting_approval', `${recipeId} waits for approval`);
    const approval = w.db.prepare('SELECT * FROM approvals WHERE job_id = ?').get(j.id);
    assert.ok(approval && approval.status === 'pending', 'a pending approval exists');
    assert.ok(!t.runner.sentOf('attempt.start').some((m) => w.db.prepare('SELECT job_id FROM job_attempts WHERE id = ?').get(m.attemptId)?.job_id === j.id),
      'nothing was started for the install');
    // A repository the recipe cannot run on is refused (never silently swapped for the other install).
    const wrong = await mcpCall(w, t, 'job_request', { recipeId, inputs: [other.versionId] });
    assert.equal(wrong.ok, false); assert.equal(wrong.code, 'invalid');
  }
});

test('FR2 a retried non-exec call is answered from memory: one service call, one mcp.call row, one budget count', async () => {
  const w = await world();
  w.nx.budget.grant(w.me, { runtimeKind: 'scripted', hosts: [{ host: 'api.example.test', port: 443 }], caps: { toolCalls: 2 } });
  const t = w.turn();
  const before = mcpCallRows(w).length;
  const draft = { title: 'Retry me', criteria: [{ id: 'c1', text: 'x' }], clientKey: 'k' };
  const a = await mcpCall(w, t, 'requirement_draft', draft, 'retry-1');
  const b = await mcpCall(w, t, 'requirement_draft', draft, 'retry-1');
  assert.equal(a.ok, true); assert.deepEqual(b, a, 'the retry gets the very same reply (created stays true)');
  assert.equal(mcpCallRows(w).length, before + 1, 'one audit row');
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE kind = 'requirement'").get().n, 1);
  // One count against the cap of 2: a second distinct call still fits, a third is the one over.
  assert.equal((await mcpCall(w, t, 'artifact_list', {}, 'retry-2')).ok, true);
  assert.equal((await mcpCall(w, t, 'artifact_list', {}, 'retry-2')).ok, true, 'a retry of a call that fit never counts');
  assert.equal((await mcpCall(w, t, 'artifact_list', {}, 'retry-3')).code, 'limit');
  // A denial is remembered too: its retry writes no second auth.denied row.
  const t2 = w.turn({ mcpTools: ['artifact_list'] });
  const deniedBefore = w.db.prepare("SELECT COUNT(*) AS n FROM activity WHERE action = 'auth.denied'").get().n;
  const d1 = await mcpCall(w, t2, 'context_get', {}, 'den-1');
  const d2 = await mcpCall(w, t2, 'context_get', {}, 'den-1');
  assert.equal(d1.code, 'tool_not_granted'); assert.deepEqual(d2, d1);
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM activity WHERE action = 'auth.denied'").get().n, deniedBefore + 1);
});

test('FR4 what the gateway keeps for a turn is evicted when its tokens are revoked, and once they expire', async () => {
  const w = await world();
  const gw = w.nx.mcpGateway;
  const a = w.turn();
  await mcpCall(w, a, 'artifact_list', {}, 'e1');
  const ex = await mcpCall(w, a, 'sandbox_exec', { argv: ['echo'], cwd: '/workspace', timeoutMs: 5000 }, 'e2');
  assert.equal(ex.ok, true);
  assert.equal(gw.repliedCalls.size, 2); assert.equal(gw.callCounts.get(a.job.id), 2); assert.equal(gw.pendingExecs.size, 1);
  w.nx.tokens.revokeForJob(w.sys, a.job.id, 'job_ended');
  assert.equal(gw.repliedCalls.size, 0); assert.equal(gw.callCounts.size, 0); assert.equal(gw.pendingExecs.size, 0);
  // The expiry backstop: a turn that is never revoked is dropped once its token has expired, at the next call of any turn.
  const b = w.turn();
  await mcpCall(w, b, 'artifact_list', {}, 'x1');
  assert.equal(gw.repliedCalls.size, 1);
  w.advance(TOKEN_DEFAULT_TTL_MS + 5000);
  const c = w.turn();
  await mcpCall(w, c, 'artifact_list', {}, 'y1');
  assert.deepEqual([...gw.repliedCalls.values()].map((e) => e.jobId), [c.job.id]);
  assert.equal(gw.callCounts.has(b.job.id), false);
  // A runner restart revokes every live token: nothing is kept.
  w.nx.tokens.revokeLiveAgentTokens(w.sys, 'runner_restart');
  assert.equal(gw.repliedCalls.size, 0); assert.equal(gw.callCounts.size, 0);
});

test("FR5 job_status and job_logs reach only the turn's own job and its children: another project's job and another job of the same project are out_of_scope", async () => {
  const w = await world();
  const repo = addRepository(w);
  const a = w.turn({ inputs: [repo.versionId] });
  const b = w.turn();                                           // another turn's job, same project
  w.nx.workspaces.attach(w.me, 'p-invoice', 'sde');
  const foreign = w.turn({ project: 'p-invoice' });             // a job of another project
  const child = await mcpCall(w, a, 'job_request', { recipeId: 'sde.test.discover', inputs: [repo.versionId] });
  assert.equal(child.ok, true);
  for (const tool of ['job_status', 'job_logs']) {
    assert.equal((await mcpCall(w, a, tool, { jobId: a.job.id })).ok, true, `${tool}: own job`);
    assert.equal((await mcpCall(w, a, tool, { jobId: child.value.jobId })).ok, true, `${tool}: its child job`);
  }
  for (const [label, jobId] of [['another project', foreign.job.id], ['another job of the same project', b.job.id], ['an unknown id', '0'.repeat(26)]]) {
    for (const tool of ['job_status', 'job_logs']) {
      const before = w.db.prepare("SELECT COUNT(*) AS n FROM activity WHERE action = 'auth.denied'").get().n;
      const r = await mcpCall(w, a, tool, { jobId });
      assert.equal(r.ok, false, `${tool} / ${label}`);
      assert.equal(r.code, 'out_of_scope', `${tool} / ${label}`);
      assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM activity WHERE action = 'auth.denied'").get().n, before + 1, `${tool} / ${label}: one audit row`);
      assert.ok(!JSON.stringify(r).includes(jobId), 'the reply never echoes the id');
    }
  }
});

test('FR6 a secret straddling the 4000-character cut of the diagnostic facts is never written to the context file', async () => {
  const w = await world();
  const t = w.turn();
  const art = w.nx.artifacts.create(w.me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'diagnostic_report', name: 'diag' });
  const secret = 'sk-ant-' + 'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(2);
  const filler = 'x'.repeat(3985);   // the secret starts at character 3995 of the JSON: the 4000-character cut keeps only 5 of its characters
  const v = w.nx.artifacts.registerVersion(w.me, { artifactId: art.id, storage: { kind: 'inline', json: { ok: true } }, metadata: {} }).version.id;
  // Registration refuses secret-shaped metadata, so plant it in the draft directly (what a bug elsewhere could leave behind).
  w.db.prepare('UPDATE artifact_versions SET metadata_json = ? WHERE id = ?').run(JSON.stringify({ note: `${filler} ${secret}` }), v);
  w.nx.artifacts.finalize(w.sys, v, 'candidate');
  const r = await w.nx.contextResolver.resolve(contextJob(t));
  const text = w.readWritten(r.path);
  assert.ok(!text.includes('sk-ant'), 'no part of the secret');
  assert.doesNotMatch(text, /## Diagnostic facts/, 'the whole field is dropped');
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM activity WHERE action = 'context_redacted' AND job_id = ?").get(t.job.id).n, 1);
});

// ---------- fix round 2 ----------

test("FR7 job_request inputs must be the turn's own: a readable repository version outside the token is denied and creates no job", async () => {
  const w = await world();
  const inTurn = addRepository(w);
  const other = addRepository(w, 'sde-node', inTurn.artifactId, 'beef'.padEnd(40, '0'));   // readable by the user, not in the token
  const t = w.turn({ inputs: [inTurn.versionId] });
  const denials = () => w.db.prepare("SELECT * FROM activity WHERE action = 'auth.denied' ORDER BY seq").all();
  const jobsBefore = w.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
  const before = denials().length;
  const r = await mcpCall(w, t, 'job_request', { recipeId: 'sde.test.discover', inputs: [other.versionId] });
  assert.equal(r.ok, false); assert.equal(r.code, 'out_of_scope');
  assert.ok(!JSON.stringify(r).includes(other.versionId), 'the reply never echoes the id');
  assert.equal(denials().length, before + 1, 'one auth.denied row');
  const row = denials().pop();
  assert.equal(JSON.parse(row.details_json).reason, 'out_of_scope'); assert.equal(JSON.parse(row.details_json).field, 'versionId');
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, jobsBefore, 'no job was created');
  // Same for an install, and for a list that mixes an allowed version with a foreign one.
  const dep = await mcpCall(w, t, 'job_request', { recipeId: 'sde.deps.node', inputs: [other.versionId] });
  assert.equal(dep.code, 'out_of_scope');
  const mixed = await mcpCall(w, t, 'job_request', { recipeId: 'sde.test.discover', inputs: [inTurn.versionId, other.versionId] });
  assert.equal(mixed.code, 'out_of_scope');
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, jobsBefore);
  // The token's own repository still works.
  const ok = await mcpCall(w, t, 'job_request', { recipeId: 'sde.test.discover', inputs: [inTurn.versionId] });
  assert.equal(ok.ok, true, JSON.stringify(ok));
});

test('FR8 an exec granted under a token that has expired is dropped by the expiry sweep, not kept until the next runner ready', async () => {
  const w = await world();
  const gw = w.nx.mcpGateway;
  const a = w.turn();
  const ex = await mcpCall(w, a, 'sandbox_exec', { argv: ['echo'], cwd: '/workspace', timeoutMs: 5000 }, 'pe-1');
  assert.equal(ex.ok, true);
  assert.equal(gw.pendingExecs.size, 1);
  w.advance(TOKEN_DEFAULT_TTL_MS + 5000);
  const b = w.turn();
  await mcpCall(w, b, 'artifact_list', {}, 'pe-2');
  assert.equal(gw.pendingExecs.size, 0, 'the unfinished exec of the expired turn is gone');
  // Its late agent.exec.done is dropped like any unknown exec.
  const logsBefore = w.logs.length;
  a.runner.report({ op: 'agent.exec.done', attemptId: a.attempt.id, execId: ex.value.grant.execId, exit: { code: 0, oomKilled: false, finishedAt: w.clock.t },
    stdoutBytes: 1, stderrBytes: 0, stdoutSha256: '1'.repeat(64), truncated: false });
  assert.ok(w.logs.slice(logsBefore).some((l) => l.includes('unknown exec')));
});
