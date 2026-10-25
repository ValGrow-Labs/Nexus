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
  const t = w.turn({ inputs: [v1] });
  await w.nx.contextResolver.resolve({ id: t.job.id, projectId: t.job.projectId, workspaceId: t.job.workspaceId, sessionId: t.session.id });

  const cases = [
    ['context_get', {}],
    ['artifact_list', {}],
    ['artifact_read', { versionId: v1 }],
    ['validations_get', { versionId: v1 }],
    ['job_status', { jobId: t.job.id }],
    ['job_logs', { jobId: t.job.id }],
    ['sandbox_exec', { argv: ['echo', 'hi'], cwd: '/workspace', timeoutMs: 5000 }],
    ['job_request', { recipeId: 'sde.test.discover' }],
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
  const t = w.turn({ maxChildJobs: 2 });
  const r1 = await mcpCall(w, t, 'job_request', { recipeId: 'sde.test.discover' }, 'call-1');
  assert.equal(r1.ok, true);
  const r2 = await mcpCall(w, t, 'job_request', { recipeId: 'sde.test.discover' }, 'call-2');
  assert.equal(r2.ok, true);
  const r3 = await mcpCall(w, t, 'job_request', { recipeId: 'sde.test.discover' }, 'call-3');
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
