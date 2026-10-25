'use strict';
// B2b Task 4: capability tokens, token-only agent authorization, the runtime consent and the spend/rate guards.
// TK1-TK12 the token matrix (each refusal audited exactly once, no token text anywhere), AZ1-AZ2 agent authority and
// the unchanged decide(), BG1-BG8 consent and budget, HX the consent host rule shared with the runner's proxy, and the
// agent fixture itself. Temp databases only (schema v10 applied to a v9 file), a FakeRunner, no Docker.
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { agentWorld, openRunningTurn, endTurn, usage, ceilingCaps } = require('./helpers/agentFixtures.cjs');
const { TokenService, TOKEN_DEFAULT_TTL_MS } = loadTs('src/main/nexus/agents/tokenService.ts');
const { canonicalHostsJson, hostsSha256, localMidnight } = loadTs('src/main/nexus/agents/budgetService.ts');
const { TOKEN_RE } = loadTs('src/shared/nexus/tokens.ts');
const { AGENT_DEFAULTS } = loadTs('src/shared/nexus/agentPolicy.ts');
const P = loadTs('src/main/nexus/auth/policy.ts');
const { transitionAttemptTx, attemptRow } = loadTs('src/main/nexus/exec/attempts.ts');
const { immediateTx } = loadTs('src/main/nexus/db/tx.ts');

const ROOT = path.resolve(__dirname, '..');
const TOKEN_ANYWHERE = /[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/;
const HOSTS = [{ host: 'api.example.test', port: 443 }];

function world(o) {
  const w = agentWorld(o);
  w.turn = (opts = {}) => openRunningTurn(w.db, w.nx, opts);
  w.denials = () => w.db.prepare("SELECT * FROM activity WHERE action = 'auth.denied' ORDER BY seq").all();
  return w;
}
const scope = (extra = {}) => ({ projectId: 'p-ledger', ...extra });

/** No activity row, token row, job event or log line holds anything shaped like a token, nor the given raw tokens. */
function assertNoTokenText(w, raws) {
  const tables = ['activity', 'capability_tokens', 'job_events', 'job_attempts', 'jobs', 'agent_sessions', 'principals'];
  for (const t of tables) {
    for (const row of w.db.prepare(`SELECT * FROM ${t}`).all()) {
      const text = JSON.stringify(row);
      assert.doesNotMatch(text, TOKEN_ANYWHERE, `${t} holds a token-shaped value`);
      for (const r of raws) assert.ok(!text.includes(r.split('.')[1]), `${t} holds a MAC`);
    }
  }
  for (const l of w.logs) { assert.doesNotMatch(l, TOKEN_ANYWHERE); for (const r of raws) assert.ok(!l.includes(r)); }
}

/** One authorizeBearer call: refused with `reason`, and exactly one new auth.denied row. */
function deniedOnce(w, raw, action, sc, reason) {
  const before = w.denials().length;
  const r = w.nx.auth.authorizeBearer(w.nx.tokens, raw, action, sc);
  assert.deepEqual(r, { allowed: false, reason });
  const rows = w.denials();
  assert.equal(rows.length, before + 1, `${reason}: exactly one audit row`);
  const row = rows[rows.length - 1];
  assert.equal(row.actor_kind, 'agent');
  assert.equal(row.status, 'denied');
  assert.equal(JSON.parse(row.details_json).reason, reason);
  assert.equal(JSON.parse(row.details_json).requested, action);
  return row;
}

// ---------- the fixture and the happy path ----------

test('fixture: a running turn through the real services; principal in the session-open transaction; the token verifies and authorizes', () => {
  const w = world();
  const t = w.turn();
  assert.equal(t.session.status, 'running');
  assert.equal(t.job.kind, 'agent.run');
  assert.equal(t.job.state, 'running');
  assert.equal(t.attempt.state, 'running');
  assert.match(t.token, TOKEN_RE);
  const p = w.db.prepare('SELECT * FROM principals WHERE id = ?').get(`agent:${t.session.id}`);
  assert.equal(p.kind, 'agent'); assert.equal(p.display_name, 'the agent');
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE principal_id = ?').get(p.id).n, 0, 'an agent has no membership');
  assert.equal(t.claims.sub, `agent:${t.session.id}`);
  assert.equal(t.claims.onBehalfOf, 'user:local');
  assert.equal(t.claims.jobId, t.job.id);
  assert.equal(t.claims.exp - t.claims.iat, TOKEN_DEFAULT_TTL_MS);
  // The row the mint wrote passes every v10 CHECK: caps_json is the object { caps, maxChildJobs }.
  const row = w.db.prepare('SELECT * FROM capability_tokens WHERE jti = ?').get(t.claims.jti);
  assert.deepEqual(JSON.parse(row.caps_json), { caps: ceilingCaps('sde'), maxChildJobs: AGENT_DEFAULTS.childJobs });
  assert.equal(row.caps_sha256, crypto.createHash('sha256').update(row.caps_json).digest('hex'));
  assert.equal(row.principal_id, `agent:${t.session.id}`);
  assert.equal(row.revoked_at, null);
  // Allowed calls write no denial.
  for (const [action, sc] of [['artifact.read', scope({ tool: 'artifact_list' })], ['job.create', scope({ tool: 'job_request', recipeId: 'sde.test.node' })],
    ['version.register', scope({ tool: 'changeset_register', kind: 'change_set' })], ['version.register', scope({ kind: 'change_set', path: 'src/a.ts' })],
    ['job.create', scope({ recipeId: 'sde.deps.node' })], ['job.create', scope({ tool: 'sandbox_exec' })]]) {
    const r = w.nx.auth.authorizeBearer(w.nx.tokens, t.token, action, sc);
    assert.equal(r.allowed, true, `${action} ${JSON.stringify(sc)}`);
  }
  assert.equal(w.denials().length, 0);
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM activity WHERE action = 'token.mint' AND job_id = ?").get(t.job.id).n, 1);
  assertNoTokenText(w, [t.token]);
});

test('mintTx runs only inside the caller transaction, for the system, within the ceiling', () => {
  const w = world();
  const t = w.turn();
  const base = { jobId: t.job.id, sessionId: t.session.id, caps: ceilingCaps('sde'), inputs: [], mcpTools: [] };
  assert.throws(() => w.nx.tokens.mintTx(w.sys, base), (e) => e.code === 'platform_unavailable');
  const inTx = (fn) => immediateTx(w.db, fn);
  assert.throws(() => inTx(() => w.nx.tokens.mintTx(w.me, base)), (e) => e.code === 'denied');
  assert.throws(() => inTx(() => w.nx.tokens.mintTx(w.sys, { ...base, caps: [{ id: 'host.exec' }] })), (e) => e.code === 'invalid');
  assert.throws(() => inTx(() => w.nx.tokens.mintTx(w.sys, { ...base, caps: [{ id: 'code.edit', scope: { paths: ['**'] } }] })), (e) => e.code === 'invalid',
    'a path scope keeps the ceiling exclusion of .git/**');
  assert.throws(() => inTx(() => w.nx.tokens.mintTx(w.sys, { ...base, caps: [{ id: 'job.request', scope: { recipes: ['repo.ff'] } }] })),
    (e) => e.code === 'invalid');
  assert.throws(() => inTx(() => w.nx.tokens.mintTx(w.sys, { ...base, caps: [{ id: 'artifact.read' }], mcpTools: ['sandbox_exec'] })),
    (e) => e.code === 'invalid', 'a tool needs its capability');
  assert.throws(() => inTx(() => w.nx.tokens.mintTx(w.sys, { ...base, maxChildJobs: 21 })), (e) => e.code === 'invalid');
  assert.throws(() => inTx(() => w.nx.tokens.mintTx(w.sys, { ...base, ttlMs: TOKEN_DEFAULT_TTL_MS + 1 })), (e) => e.code === 'invalid');
  assert.throws(() => inTx(() => w.nx.tokens.mintTx(w.sys, { ...base, inputs: ['nope'] })), (e) => e.code === 'invalid');
  // A narrower grant is fine (still running: the job is `running`).
  const raw = inTx(() => w.nx.tokens.mintTx(w.sys, { ...base, caps: [{ id: 'code.edit', scope: { paths: ['src/**', '!.git/**'] } }, { id: 'artifact.read' }],
    mcpTools: ['context_get'] }));
  assert.equal(w.nx.tokens.verify(raw).ok, true);
});

// ---------- TK1-TK10: the token matrix ----------

test('TK1 forged signature and TK2 an altered id of the same length: bad_signature, one audit row each, actor unknown', () => {
  const w = world();
  const t = w.turn();
  const [jti, mac] = t.token.split('.');
  const flip = (s, i) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
  const r1 = deniedOnce(w, `${jti}.${flip(mac, 5)}`, 'artifact.read', scope({ tool: 'artifact_list' }), 'bad_signature');
  assert.equal(r1.actor_id, 'agent:unknown');
  assert.equal(r1.job_id, null, 'nothing of a token that failed its signature is trusted');
  deniedOnce(w, `${flip(jti, 3)}.${mac}`, 'artifact.read', scope(), 'bad_signature');
  deniedOnce(w, 'not-a-token', 'artifact.read', scope(), 'malformed');
  deniedOnce(w, `${t.token}x`, 'artifact.read', scope(), 'malformed');
  deniedOnce(w, 'x'.repeat(4096), 'artifact.read', scope(), 'malformed');
  assertNoTokenText(w, [t.token]);
});

test('TK3 expired and TK4 revoked: refused with the stored job recorded, one audit row each', () => {
  const w = world();
  const a = w.turn();
  w.advance(TOKEN_DEFAULT_TTL_MS + 1);
  const r3 = deniedOnce(w, a.token, 'artifact.read', scope({ tool: 'artifact_list' }), 'expired');
  assert.equal(r3.job_id, a.job.id); assert.equal(r3.actor_id, `agent:${a.session.id}`);
  endTurn(w.db, w.nx, a);
  const b = w.turn();
  assert.equal(w.nx.tokens.revokeForJob(w.sys, b.job.id, 'job_ended'), 1);
  assert.equal(w.nx.tokens.revokeForJob(w.sys, b.job.id, 'job_ended'), 0, 'revocation is recorded once');
  const r4 = deniedOnce(w, b.token, 'artifact.read', scope({ tool: 'artifact_list' }), 'revoked');
  assert.equal(r4.job_id, b.job.id);
  // authorizeWithToken with the claims of a revoked token refuses too (it re-reads the row).
  const before = w.denials().length;
  assert.deepEqual(w.nx.auth.authorizeWithToken(b.claims, 'artifact.read', scope()), { allowed: false, reason: 'revoked' });
  assert.equal(w.denials().length, before + 1);
  assert.equal(w.db.prepare('SELECT revoke_reason FROM capability_tokens WHERE jti = ?').get(b.claims.jti).revoke_reason, 'job_ended');
  assert.throws(() => w.db.prepare("UPDATE capability_tokens SET revoke_reason = 'budget' WHERE jti = ?").run(b.claims.jti), /recorded once/);
  assert.throws(() => w.nx.tokens.revokeForJob(w.me, b.job.id, 'job_ended'), (e) => e.code === 'denied');
  assertNoTokenText(w, [a.token, b.token]);
});

test("TK5 job A's token on job B's versions: out_of_scope; its own inputs are readable", () => {
  const w = world();
  const art = w.nx.artifacts.create(w.me, { projectId: 'p-ledger', workspaceId: 'sde', kind: 'requirement', name: 'req' });
  const mk = (i) => {
    const v = w.nx.artifacts.registerVersion(w.me, { artifactId: art.id, storage: { kind: 'inline', json: { title: `r${i}` } } }).version.id;
    w.nx.artifacts.finalize(w.sys, v, 'candidate');
    return v;
  };
  const v1 = mk(1); const v2 = mk(2);
  const a = w.turn({ inputs: [v1] });
  assert.equal(w.nx.auth.authorizeBearer(w.nx.tokens, a.token, 'artifact.read', scope({ tool: 'artifact_read', versionId: v1 })).allowed, true);
  const r = deniedOnce(w, a.token, 'artifact.read', scope({ tool: 'artifact_read', versionId: v2 }), 'out_of_scope');
  assert.equal(JSON.parse(r.details_json).field, 'versionId');
  deniedOnce(w, a.token, 'artifact.read', scope({ projectId: 'p-invoice', tool: 'artifact_read' }), 'out_of_scope');
  deniedOnce(w, a.token, 'artifact.read', scope({ versionId: 'no-such-version' }), 'out_of_scope');
});

test('TK6 a path, recipe or kind out of scope: out_of_scope, one audit row each', () => {
  const w = world();
  const t = w.turn();
  for (const p of ['.git/config', '../x', 'C:/x', 'a/../../b', '.env']) {
    const r = deniedOnce(w, t.token, 'version.register', scope({ kind: 'change_set', path: p }), 'out_of_scope');
    assert.equal(JSON.parse(r.details_json).field, 'path');
  }
  deniedOnce(w, t.token, 'job.create', scope({ tool: 'job_request', recipeId: 'repo.ff' }), 'out_of_scope');
  deniedOnce(w, t.token, 'job.create', scope({ recipeId: 'sde.build.nothing' }), 'out_of_scope');
  deniedOnce(w, t.token, 'version.register', scope({ tool: 'changeset_register', kind: 'dataset' }), 'out_of_scope');
  // A token narrower than the ceiling: its own lists bind.
  endTurn(w.db, w.nx, t);
  const n = w.turn({ caps: [{ id: 'code.edit', scope: { paths: ['src/**', '!.git/**'] } }, { id: 'artifact.register', scope: { kinds: ['change_set'] } },
    { id: 'job.request', scope: { recipes: ['sde.test.node'] } }], mcpTools: ['job_request', 'changeset_register'] });
  deniedOnce(w, n.token, 'version.register', scope({ kind: 'change_set', path: 'docs/a.md' }), 'out_of_scope');
  deniedOnce(w, n.token, 'version.register', scope({ kind: 'requirement' }), 'out_of_scope');
  deniedOnce(w, n.token, 'job.create', scope({ tool: 'job_request', recipeId: 'sde.build.node' }), 'out_of_scope');
  assert.equal(w.nx.auth.authorizeBearer(w.nx.tokens, n.token, 'job.create', scope({ tool: 'job_request', recipeId: 'sde.test.node' })).allowed, true);
  deniedOnce(w, n.token, 'artifact.read', scope({ tool: 'artifact_list' }), 'tool_not_granted');
  deniedOnce(w, n.token, 'artifact.read', scope(), 'no_capability');
});

test('TK7 a tool not in mcpTools (or not a tool, or named as another action): refused, one audit row each', () => {
  const w = world();
  const t = w.turn({ mcpTools: ['context_get', 'artifact_list'] });
  const r = deniedOnce(w, t.token, 'job.create', scope({ tool: 'sandbox_exec' }), 'tool_not_granted');
  assert.equal(JSON.parse(r.details_json).tool, 'sandbox_exec');
  const r2 = deniedOnce(w, t.token, 'artifact.read', scope({ tool: 'shell; rm -rf /' }), 'tool_not_granted');
  assert.equal(JSON.parse(r2.details_json).tool, undefined, 'free text from the call is not recorded');
  deniedOnce(w, t.token, 'version.register', scope({ tool: 'artifact_list' }), 'agent_forbidden');
});

test('TK8 the job is terminal: job_ended, one audit row', () => {
  const w = world();
  const t = w.turn();
  immediateTx(w.db, () => {
    transitionAttemptTx(w.db, attemptRow(w.db, t.attempt.id), 'cancelled', w.clock.t, 'p-ledger', { outcome: 'cancelled' });
    w.nx.jobs.transitionTx(w.sys, t.job.id, 'cancelled');
  });
  assert.equal(w.nx.tokens.verify(t.token).ok, true, 'the token itself still verifies (no revocation yet)');
  const r = deniedOnce(w, t.token, 'artifact.read', scope({ tool: 'artifact_list' }), 'job_ended');
  assert.equal(JSON.parse(r.details_json).jobState, 'cancelled');
});

test('TK9 the key changed after a restart: bad_signature', () => {
  const w = world();
  const t = w.turn();
  const fresh = new TokenService(w.db, { auth: w.nx.auth, now: () => w.clock.t });
  assert.deepEqual(fresh.verify(t.token, w.clock.t), { ok: false, code: 'bad_signature' });
  const before = w.denials().length;
  assert.deepEqual(w.nx.auth.authorizeBearer(fresh, t.token, 'artifact.read', scope()), { allowed: false, reason: 'bad_signature' });
  assert.equal(w.denials().length, before + 1);
  // The key is not reachable from the instance (no own enumerable property holds 32 bytes or a key).
  for (const v of Object.values(fresh)) assert.ok(!(Buffer.isBuffer(v) && v.length === 32));
  assert.doesNotMatch(JSON.stringify(Object.keys(fresh)), /key/i);
  const src = fs.readFileSync(path.join(ROOT, 'src/main/nexus/agents/tokenService.ts'), 'utf8');
  assert.doesNotMatch(src, /export\s+(const|let|function)\s+\w*key/i);
  assert.doesNotMatch(src, /log\([^)]*(key|raw|token)\b/i);
});

test('TK10 a token for a user principal: not_agent; the store refuses such a row', () => {
  const w = world();
  const t = w.turn();
  const before = w.denials().length;
  for (const forged of [{ ...t.claims, sub: 'user:local' }, { ...t.claims, sub: 'system' }, { ...t.claims, sessionId: 'X'.repeat(26) }]) {
    assert.deepEqual(w.nx.auth.authorizeWithToken(forged, 'artifact.read', scope()), { allowed: false, reason: 'not_agent' });
  }
  assert.equal(w.denials().length, before + 3);
  // Claims widened in memory widen nothing: the grant is the stored row's.
  const widened = { ...t.claims, caps: [...t.claims.caps, { id: 'host.exec' }], mcpTools: ['sandbox_exec'] };
  assert.deepEqual(w.nx.auth.authorizeWithToken({ ...widened, jti: 'A'.repeat(22) }, 'artifact.read', scope()), { allowed: false, reason: 'unknown' });
  assert.throws(() => w.db.prepare(`INSERT INTO capability_tokens (jti, job_id, session_id, principal_id, on_behalf_of, caps_json, inputs_json, tools_json,
      caps_sha256, issued_at, expires_at) VALUES (?, ?, ?, 'user:local', 'user:local', '{}', '[]', '[]', ?, 1, 2)`)
    .run('B'.repeat(22), t.job.id, t.session.id, 'a'.repeat(64)), /agent of its session/);
  assertNoTokenText(w, [t.token]);
});

// ---------- TK11, TK12 ----------

test('TK11 a runner ready revokes live agent tokens (runner_restart); startup revokes them (restart)', () => {
  const w = world();
  const t = w.turn();
  assert.equal(w.nx.tokens.verify(t.token).ok, true);
  t.runner.report({ op: 'ready', bootId: w.nx.bootId, mcpUrl: null });
  assert.deepEqual(w.nx.tokens.verify(t.token), { ok: false, code: 'revoked', claims: t.claims });
  assert.equal(w.db.prepare('SELECT revoke_reason FROM capability_tokens WHERE jti = ?').get(t.claims.jti).revoke_reason, 'runner_restart');
  deniedOnce(w, t.token, 'artifact.read', scope({ tool: 'artifact_list' }), 'revoked');
  // A token minted after that ready is live; the next platform startup revokes it with `restart`.
  endTurn(w.db, w.nx, t);
  const u = w.turn();
  assert.equal(w.nx.tokens.verify(u.token).ok, true);
  const report = w.nx.startup();
  assert.deepEqual(report.agents, { tokensRevoked: 1 });
  assert.equal(w.db.prepare('SELECT revoke_reason FROM capability_tokens WHERE jti = ?').get(u.claims.jti).revoke_reason, 'restart');
  assert.equal(w.nx.tokens.verify(u.token).code, 'revoked');
  assert.ok(w.logs.some((l) => /agent tokens revoked at runner ready: 1/.test(l)));
  assertNoTokenText(w, [t.token, u.token]);
});

test('TK12 a malformed mcp.call is dropped without logging the bearer; drop() lines never hold one; scrub() leaves the bearer alone', () => {
  const w = world();
  const t = w.turn();
  const exec = w.nx.exec;
  const sent = [
    { op: 'mcp.call', callId: 'c1', bearer: t.token, tool: 'not a tool name!', args: {} },
    { op: 'mcp.call', callId: 'c2', bearer: t.token, tool: 'context_get' },
    { op: 'mcp.call', bearer: t.token, tool: 'context_get', args: {}, extra: t.token },
    { op: 'mcp.call', callId: 'c3', bearer: `${t.token}${t.token}`, tool: 'context_get', args: {} },
    { op: 'mcp.call', callId: 'c4', bearer: t.token, tool: 'context_get', args: {} }
  ];
  const before = w.logs.length;
  for (const m of sent) exec.onRunnerMessage(m);
  const lines = w.logs.slice(before);
  assert.ok(lines.length >= sent.length, 'each message was dropped with a line');
  for (const l of lines) {
    assert.match(l, /dropped runner message/);
    assert.doesNotMatch(l, TOKEN_ANYWHERE);
    assert.ok(!l.includes(t.token.split('.')[1]));
  }
  // Source pin: drop() takes the op and a fixed reason only, and onRunnerMessage never interpolates the raw message.
  const ex = fs.readFileSync(path.join(ROOT, 'src/main/nexus/exec/executionService.ts'), 'utf8');
  assert.match(ex, /private drop\(op: string, why: string\): void \{ this\.log\(`\[nexus\] exec: dropped runner message \$\{op\}: \$\{why\}`\); \}/);
  assert.doesNotMatch(ex, /bearer/);
  assert.doesNotMatch(ex, /this\.drop\([^)]*(raw|JSON\.stringify)/);
  // The runner's scrub(): no rule for mcp.call (the bearer is exempt from redaction, which would destroy it), at runtime too.
  const core = fs.readFileSync(path.join(ROOT, 'src/runner/core.ts'), 'utf8');
  const body = core.slice(core.indexOf('private scrub('), core.indexOf('private scrub(') + 3000);
  assert.ok(body.includes('default: return m;'));
  assert.doesNotMatch(body.slice(0, body.indexOf('default: return m;')), /mcp\.call|bearer/);
  const { RunnerCore } = loadTs('src/runner/core.ts');
  const logs = [];
  const msg = { op: 'mcp.call', callId: 'c5', bearer: t.token, tool: 'context_get', args: {} };
  const out = RunnerCore.prototype.scrub.call({ log: (l) => logs.push(l) }, msg);
  assert.equal(out.bearer, t.token);
  assert.deepEqual(logs, []);
});

// ---------- AZ1, AZ2 ----------

test('AZ1 an agent cannot promote, discard, accept, merge, decide a review, answer approvals, grant consent or mint', () => {
  const w = world();
  const t = w.turn();
  const agentP = { id: t.claims.sub, kind: 'agent', displayName: 'the agent' };
  for (const action of ['version.promote', 'version.discard', 'changeset.accept', 'repo.merge', 'review.decide', 'approval.respond', 'agent.consent',
    'token.mint', 'version.finalize', 'job.cancel', 'session.cancel', 'artifact.archive', 'handoff.send', 'agent.start']) {
    deniedOnce(w, t.token, action, scope(), 'agent_forbidden');
    assert.equal(w.nx.auth.authorize(agentP, action, { type: 'project', projectId: 'p-ledger' }).reason, 'agent_requires_token', action);
  }
  assert.throws(() => w.nx.budget.grant(agentP, { runtimeKind: 'cli', hosts: HOSTS }), (e) => e.code === 'denied');
  assert.throws(() => w.nx.budget.grant(w.sys, { runtimeKind: 'cli', hosts: HOSTS }), (e) => e.code === 'denied');
  assert.equal(w.nx.budget.live(), null);
  // The new user actions: classified once; review and accept are the user's own (the system principal never).
  for (const a of ['agent.start', 'review.decide', 'changeset.accept']) assert.ok(P.MEMBER_ACTIONS.includes(a), a);
  for (const a of ['repo.merge', 'agent.consent']) assert.ok(P.OWNER_ACTIONS.includes(a), a);
  assert.ok(P.SYSTEM_ONLY_ACTIONS.includes('token.mint'));
  const sys = { id: 'system', kind: 'system', displayName: 'Nexus platform' };
  const user = { id: 'user:local', kind: 'user', displayName: 'Local owner' };
  for (const a of ['review.decide', 'changeset.accept']) {
    assert.deepEqual(P.decide({ principal: sys, roles: ['admin'], action: a }), { allowed: false, reason: 'user_only' });
    assert.equal(P.decide({ principal: user, roles: ['member'], action: a }).allowed, true);
    assert.deepEqual(P.decide({ principal: user, roles: ['viewer'], action: a }), { allowed: false, reason: 'role', needed: 'member' });
  }
  assert.deepEqual(P.decide({ principal: user, roles: ['admin'], action: 'repo.merge' }), { allowed: false, reason: 'role', needed: 'owner' });
  assert.deepEqual(P.decide({ principal: user, roles: ['owner'], action: 'token.mint' }), { allowed: false, reason: 'system_only' });
  assert.equal(P.decide({ principal: sys, roles: ['admin'], action: 'token.mint' }).allowed, true);
});

test('AZ2 decide() is unchanged for every B2a action, principal and role set (against the B2a-close policy)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-az2-'));
  try {
    const text = execFileSync('git', ['show', '4aec76f6:src/main/nexus/auth/policy.ts'], { cwd: ROOT, encoding: 'utf8' });
    const f = path.join(dir, 'policy.ts');
    fs.writeFileSync(f, text);
    const OLD = loadTs.loadAbsolute(f);
    const oldActions = [...OLD.READ_ACTIONS, ...OLD.MEMBER_ACTIONS, ...OLD.ADMIN_ACTIONS, ...OLD.OWNER_ACTIONS, ...OLD.SYSTEM_ONLY_ACTIONS];
    assert.ok(oldActions.length >= 35);
    const principals = [null, { id: 'user:local', kind: 'user' }, { id: 'system', kind: 'system' }, { id: 'agent:x', kind: 'agent' }, { id: 'q', kind: 'other' }];
    const roleSets = [[], ['viewer'], ['member'], ['admin'], ['owner'], ['viewer', 'admin']];
    let n = 0;
    for (const action of [...oldActions, 'not.an.action']) for (const principal of principals) for (const roles of roleSets) for (const disabled of [false, true]) {
      assert.deepEqual(P.decide({ principal, roles, action, disabled }), OLD.decide({ principal, roles, action, disabled }), `${action} ${principal?.kind} ${roles}`);
      n++;
    }
    assert.ok(n > 2000);
    // The old lists are kept, each new action added once.
    for (const k of ['READ_ACTIONS', 'MEMBER_ACTIONS', 'ADMIN_ACTIONS', 'OWNER_ACTIONS', 'SYSTEM_ONLY_ACTIONS']) for (const a of OLD[k]) assert.ok(P[k].includes(a), `${k} ${a}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- consent and budget ----------

test('HX the consent host rule is the proxy rule: sorted, lowercased, de-duplicated host:port strings and their sha256', () => {
  assert.equal(canonicalHostsJson([{ host: 'api.anthropic.com', port: 443 }]), '["api.anthropic.com:443"]');
  // Pinned: the sha256 of the UTF-8 text ["api.anthropic.com:443"] (hostEgressProxy hostsSha256 gives the same).
  assert.equal(hostsSha256([{ host: 'api.anthropic.com', port: 443 }]), '8d9ed3dfa0a0aab7e116da63d4c39b9b662a1ffd3319d1029b2ddbdaed434c15');
  assert.equal(hostsSha256([{ host: 'API.Anthropic.com', port: 443 }, { host: 'api.anthropic.com', port: 443 }]),
    '8d9ed3dfa0a0aab7e116da63d4c39b9b662a1ffd3319d1029b2ddbdaed434c15');
  assert.equal(canonicalHostsJson([{ host: 'B.example.test', port: 8443 }, { host: 'a.example.test', port: 443 }, { host: 'b.EXAMPLE.test', port: 8443 }]),
    '["a.example.test:443","b.example.test:8443"]');
  for (const bad of [[], [{ host: 'a b', port: 443 }], [{ host: 'x.test', port: 0 }], [{ host: 'x.test', port: 70000 }], [{ host: '', port: 1 }]]) {
    assert.throws(() => canonicalHostsJson(bad), (e) => e.code === 'invalid');
  }
  // The runner's proxy module, when present, computes the same text and hash.
  const proxy = path.join(ROOT, 'src/runner/hostEgressProxy.ts');
  if (fs.existsSync(proxy)) {
    const m = loadTs('src/runner/hostEgressProxy.ts');
    if (typeof m.canonicalHostsJson === 'function' && typeof m.hostsSha256 === 'function') {
      const hs = [{ host: 'api.anthropic.com', port: 443 }];
      assert.equal(m.canonicalHostsJson(hs), canonicalHostsJson(hs));
      assert.equal(m.hostsSha256(hs), hostsSha256(hs));
    }
  }
});

test('BG1 no consent: consent_missing', () => {
  const w = world();
  assert.equal(w.nx.budget.live(), null);
  assert.deepEqual(w.nx.budget.startGuard('p-ledger'), { ok: false, reason: 'consent_missing', dayRemainingUsdCents: AGENT_DEFAULTS.dayUsdCents });
  w.nx.budget.grant(w.me, { runtimeKind: 'cli', hosts: HOSTS });
  assert.equal(w.nx.budget.startGuard('p-ledger').ok, true);
  w.nx.budget.revoke(w.me);
  assert.equal(w.nx.budget.startGuard('p-ledger').reason, 'consent_missing');
});

test('BG2 grant and revoke are each set once', () => {
  const w = world();
  const c = w.nx.budget.grant(w.me, { runtimeKind: 'cli', hosts: HOSTS, caps: { turnUsdCents: 100 } });
  assert.equal(c.caps.turnUsdCents, 100);
  assert.deepEqual(c.hosts, ['api.example.test:443']);
  assert.equal(c.hostsSha256, hostsSha256(HOSTS));
  assert.throws(() => w.nx.budget.grant(w.me, { runtimeKind: 'cli', hosts: HOSTS }), (e) => e.code === 'conflict');
  assert.throws(() => w.db.prepare('UPDATE runtime_consents SET turn_usd_cents = 50 WHERE id = ?').run(c.id), /immutable/);
  assert.equal(w.nx.budget.revoke(w.me), true);
  const row = w.db.prepare('SELECT * FROM runtime_consents WHERE id = ?').get(c.id);
  assert.equal(row.revoked_by, 'user:local');
  w.advance(1000);
  assert.equal(w.nx.budget.revoke(w.me), false, 'nothing live: nothing changes');
  assert.equal(w.db.prepare('SELECT revoked_at FROM runtime_consents WHERE id = ?').get(c.id).revoked_at, row.revoked_at);
  assert.throws(() => w.db.prepare('UPDATE runtime_consents SET revoked_at = revoked_at + 1 WHERE id = ?').run(c.id), /recorded once/);
  assert.throws(() => w.db.prepare('DELETE FROM runtime_consents').run(), /never deleted/);
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM activity WHERE action = 'agent.consent'").get().n, 2);
  for (const r of w.db.prepare("SELECT details_json FROM activity WHERE action = 'agent.consent'").all()) assert.doesNotMatch(r.details_json, /example/);
  // A second grant after the revoke is a new row.
  const c2 = w.nx.budget.grant(w.me, { runtimeKind: 'cli', hosts: HOSTS });
  assert.notEqual(c2.id, c.id);
});

test('BG3 the day cap is reached from recorded usage only', () => {
  const w = world();
  w.nx.budget.grant(w.me, { runtimeKind: 'cli', hosts: HOSTS });
  const t1 = w.turn(); endTurn(w.db, w.nx, t1, { usage: usage(600) });
  assert.equal(w.nx.budget.startGuard('p-ledger').ok, true);
  assert.equal(w.nx.budget.usageToday().usdCents, 600);
  // Usage on a tool job's attempt does not count; nothing the renderer could say is read.
  const t2 = w.turn(); endTurn(w.db, w.nx, t2, { usage: usage(399) });
  let g = w.nx.budget.startGuard('p-ledger');
  assert.equal(g.ok, true); assert.equal(g.dayRemainingUsdCents, 1); assert.equal(g.turnBudgetUsdCents, 1);
  const t3 = w.turn(); endTurn(w.db, w.nx, t3, { usage: usage(1) });
  g = w.nx.budget.startGuard('p-ledger');
  assert.deepEqual(g, { ok: false, reason: 'budget_exhausted', dayRemainingUsdCents: 0 });
  // Tomorrow the day starts again.
  w.advance(24 * 60 * 60_000 + 1);
  assert.equal(w.nx.budget.usageToday().usdCents, 0);
  assert.equal(w.nx.budget.startGuard('p-ledger').ok, true);
  assert.ok(localMidnight(w.clock.t) <= w.clock.t && w.clock.t - localMidnight(w.clock.t) < 25 * 60 * 60_000);
});

test('BG4 a 7th turn within one hour answers rate_limited', () => {
  const w = world();
  w.nx.budget.grant(w.me, { runtimeKind: 'cli', hosts: HOSTS });
  for (let i = 0; i < 6; i++) {
    assert.equal(w.nx.budget.startGuard('p-ledger').ok, true, `turn ${i + 1}`);
    const t = w.turn(); endTurn(w.db, w.nx, t, { usage: usage(1) });
    w.advance(60_000);
  }
  assert.equal(w.nx.budget.startGuard('p-ledger').reason, 'rate_limited');
  w.advance(60 * 60_000);
  assert.equal(w.nx.budget.startGuard('p-ledger').ok, true, 'an hour later');
});

test('BG5 with a live turn and concurrentTurns = 1, a new turn answers busy (the turn itself may be excluded)', () => {
  const w = world();
  w.nx.budget.grant(w.me, { runtimeKind: 'cli', hosts: HOSTS });
  const t = w.turn();
  assert.equal(w.nx.budget.startGuard('p-ledger').reason, 'busy');
  assert.equal(w.nx.budget.startGuard('p-ledger', { excludeJobId: t.job.id }).ok, true);
  endTurn(w.db, w.nx, t, { usage: usage(5) });
  assert.equal(w.nx.budget.startGuard('p-ledger').ok, true);
});

test('BG6 a grant above D-B4 is clamped; a raw insert above a ceiling is refused by the CHECK', () => {
  const w = world();
  const c = w.nx.budget.grant(w.me, { runtimeKind: 'cli', hosts: HOSTS, caps: { turnUsdCents: 5000, dayUsdCents: 99999, turnsPerHour: 60,
    concurrentTurns: 4, turnTokens: 10_000_000, toolCalls: 10_000, wallClockMs: 1e9, childJobs: 500 } });
  assert.deepEqual(c.caps, { ...AGENT_DEFAULTS });
  const row = w.db.prepare('SELECT * FROM runtime_consents WHERE id = ?').get(c.id);
  assert.deepEqual([row.turn_usd_cents, row.day_usd_cents, row.turns_per_hour, row.concurrent_turns, row.turn_tokens, row.tool_calls],
    [200, 1000, 6, 1, 400000, 200]);
  w.nx.budget.revoke(w.me);
  const lower = w.nx.budget.grant(w.me, { runtimeKind: 'cli', hosts: HOSTS, caps: { dayUsdCents: 150, turnsPerHour: 2 } });
  assert.equal(lower.caps.dayUsdCents, 150); assert.equal(lower.caps.turnUsdCents, 150, 'the turn cap never exceeds the day cap');
  assert.equal(lower.caps.turnsPerHour, 2);
  w.nx.budget.revoke(w.me);
  assert.throws(() => w.nx.budget.grant(w.me, { runtimeKind: 'cli', hosts: HOSTS, caps: { toolCalls: 0 } }), (e) => e.code === 'invalid');
  const ins = (over) => w.db.prepare(`INSERT INTO runtime_consents (id, runtime_kind, hosts_json, hosts_sha256, turn_usd_cents, day_usd_cents, turns_per_hour,
      concurrent_turns, turn_tokens, tool_calls, granted_by, granted_at) VALUES (@id, 'cli', '["x:1"]', @sha, @turn, @day, @rate, @conc, @tok, @tools, 'user:local', 1)`)
    .run({ id: 'raw', sha: 'a'.repeat(64), turn: 200, day: 1000, rate: 6, conc: 1, tok: 400000, tools: 200, ...over });
  for (const over of [{ turn: 201 }, { day: 1001 }, { rate: 7 }, { conc: 2 }, { tok: 400001 }, { tools: 201 }]) {
    assert.throws(() => ins(over), /CHECK constraint failed/, JSON.stringify(over));
  }
  assert.equal(w.nx.budget.live(), null);
});

test('BG7 a cancelled turn with no reported cost counts at the turn cap as estimated', () => {
  const w = world();
  w.nx.budget.grant(w.me, { runtimeKind: 'cli', hosts: HOSTS, caps: { turnUsdCents: 150 } });
  const live = w.turn();
  assert.deepEqual(w.nx.budget.usageToday(), { usdCents: 0, turns: 1, estimated: false }, 'a live turn counts what it reported so far');
  endTurn(w.db, w.nx, live, { attempt: 'cancelled' });
  assert.deepEqual(w.nx.budget.usageToday(), { usdCents: 150, turns: 1, estimated: true });
  const t2 = w.turn(); endTurn(w.db, w.nx, t2, { usage: usage(null), attempt: 'cancelled' });
  assert.deepEqual(w.nx.budget.usageToday(), { usdCents: 300, turns: 2, estimated: true });
  const t3 = w.turn(); endTurn(w.db, w.nx, t3, { usage: usage(7) });
  assert.deepEqual(w.nx.budget.usageToday(), { usdCents: 307, turns: 3, estimated: true });
});

test('BG8 dayRemainingCents = day cap - today\'s usage, never below 0', () => {
  const w = world();
  assert.equal(w.nx.budget.dayRemainingCents(), AGENT_DEFAULTS.dayUsdCents, 'no consent: the D-B4 day cap');
  w.nx.budget.grant(w.me, { runtimeKind: 'cli', hosts: HOSTS, caps: { dayUsdCents: 500 } });
  assert.equal(w.nx.budget.dayRemainingCents(), 500);
  const t = w.turn(); endTurn(w.db, w.nx, t, { usage: usage(120) });
  assert.equal(w.nx.budget.dayRemainingCents(), 380);
  const t2 = w.turn(); endTurn(w.db, w.nx, t2, { usage: usage(900) });
  assert.equal(w.nx.budget.dayRemainingCents(), 0);
  assert.equal(w.nx.budget.startGuard('p-ledger').reason, 'budget_exhausted');
});

test('composition: agents stay off without the flag, below v10, or without execution; the startup report keeps its B2a shape then', () => {
  const off = world({ agents: false });
  assert.equal(off.nx.agentsAvailable, false); assert.equal(off.nx.tokens, null); assert.equal(off.nx.budget, null);
  assert.equal('agents' in off.nx.startup(), false);
  const noExec = world({ platform: { execution: false } });
  assert.equal(noExec.nx.agentsAvailable, false);
  assert.ok(noExec.logs.some((l) => /agents unavailable/.test(l)));
  const on = world();
  assert.equal(on.nx.agentsAvailable, true);
  assert.deepEqual(on.nx.startup().agents, { tokensRevoked: 0 });
});
