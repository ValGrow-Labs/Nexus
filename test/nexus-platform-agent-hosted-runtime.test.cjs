'use strict';
// Nexus hosted-model runtime, main side (Track HB): choosing a provider and model, the permission for the kind (both providers' hosts,
// hash-bound), the key resolved at lease time into the plan's in-memory field and nowhere else, the fixed sentences, key deletion and
// revocation stopping live turns. The REAL platform (v10 database, tokens, budgets, the agent service, the #51 handler); the runner is a
// FakeRunner that answers each probe with three runtimes (vendor-CLI kind, local kind, hosted kind with two test providers) and the test
// reads the plan main sends. The key store is a fake safeStorage. No Docker, no process, no network, no real key.
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { agentWorld } = require('./helpers/agentFixtures.cjs');
const { FakeRunner } = require('./helpers/fakeRunner.cjs');
const { ipcOver, asLocalUser } = require('./helpers/ipcExec.cjs');
const { PROFILES, passingPreflight, GIB } = require('./helpers/execWorld.cjs');
const { newId } = loadTs('src/main/nexus/db/ids.ts');
const { resolveDataHome } = loadTs('src/main/nexusExec/dataHome.ts');
const { hostsSha256 } = loadTs('src/main/nexus/agents/budgetService.ts');
const { AGENT_REASON_MESSAGES } = loadTs('src/main/nexusIpc/envelope.ts');
const { createHostedKeys } = loadTs('src/main/nexus/agents/hostedModelSettings.ts');
const { HOSTED_RUNNER_MESSAGE_REASON } = loadTs('src/shared/nexus/hostedModel.ts');

const PROJECT = 'p-ledger';
const WORKSPACE = 'sde';
const CLI_HOSTS = [{ host: 'cli.example.com', port: 443 }];
const HOSTED_HOSTS = [{ host: 'alpha.example.com', port: 443 }, { host: 'beta.example.com', port: 443 }];
const PROVIDERS = [
  { id: 'alpha', label: 'Alpha (free key)', hosts: ['alpha.example.com'], models: [{ name: 'a-big', tools: true }, { name: 'a-plain', tools: false }] },
  { id: 'beta', label: 'Beta (free key)', hosts: ['beta.example.com'], models: [{ name: 'b-fast', tools: true }] }
];
const KEY_A = 'TESTKEY-alpha-0123456789abcdef-ZZ';
const KEY_B = 'TESTKEY-beta-fedcba9876543210-QQ';
const MCP_URL = 'http://127.0.0.1:43111/mcp';
const IMAGE = 'sha256:' + '1'.repeat(64);
let seq = 0;
const ulid = () => newId(Date.now() + (++seq));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cliRuntime = () => ({ kind: 'cli-agent', health: { ok: true, version: '2.0.0' }, setup: { signedIn: 'yes', flagsOk: true, label: 'Test Engine', egressHosts: CLI_HOSTS } });
const hostedRuntime = (o = {}) => ({ kind: 'hosted-model', health: { ok: true, version: 'presets-1' },
  setup: { signedIn: 'unknown', flagsOk: true, label: 'Hosted (Test)', egressHosts: o.hosts ?? HOSTED_HOSTS, providers: o.providers ?? PROVIDERS } });
const sandbox = (runtimes) => ({ op: 'probe.result',
  probe: { docker: 'running', version: '27.0.0', cpus: 4, memoryBytes: 8 * GIB, gpu: { detected: false, usableInContainers: false } },
  images: [{ profile: 'sde-node', present: true, digestMatches: true, imageId: IMAGE }, { profile: 'sde-python', present: true, digestMatches: true, imageId: 'sha256:' + '2'.repeat(64) }],
  freeBytes: 100 * GIB, runtimes });

/** A fake safeStorage-backed secret store: the "disk" holds only scrambled text; refuses when encryption is unavailable. */
function fakeStore(o = {}) {
  const st = { available: o.available ?? true, blob: {} };
  const enc = (s) => Buffer.from(s, 'utf8').map((b) => b ^ 0x5a).toString('base64');
  const dec = (s) => Buffer.from(Buffer.from(s, 'base64').map((b) => b ^ 0x5a)).toString('utf8');
  return Object.assign(st, {
    encryptionAvailable: () => st.available,
    set(ref, v) { if (!st.available) return { ok: false, error: 'unavailable' }; st.blob[ref] = enc(v); return { ok: true }; },
    get(ref) { return st.blob[ref] === undefined ? undefined : dec(st.blob[ref]); },
    has(ref) { return st.blob[ref] !== undefined; },
    delete(ref) { delete st.blob[ref]; }
  });
}

function addRepository(w) {
  const pw = w.nx.workspaces.primaryOf(w.me, PROJECT);
  const art = newId(w.clock.t);
  w.db.prepare(`INSERT INTO artifacts (id, project_id, kind, name, description, owner_scope, owner_participation_id, owner_workspace_id,
      created_by, status, current_version_id, metadata_json, created_at, updated_at)
    VALUES (?, ?, 'repository', 'ledger-api', NULL, 'participation', ?, ?, 'user:local', 'active', NULL, '{}', ?, ?)`)
    .run(art, PROJECT, pw.id, pw.workspaceId, w.clock.t, w.clock.t);
  const v = w.nx.artifacts.registerVersion(w.me, { artifactId: art, storage: { kind: 'git', commit: 'c0ffee'.padEnd(40, '0') },
    metadata: { profile: 'sde-node', branch: 'main', lockfile: { sha256: 'a'.repeat(64) } } }).version.id;
  w.nx.artifacts.finalize(w.sys, v, 'candidate');
  w.db.transaction(() => {
    w.db.prepare("UPDATE artifact_versions SET status = 'active' WHERE id = ?").run(v);
    w.db.prepare('UPDATE artifacts SET current_version_id = ? WHERE id = ?').run(v, art);
  })();
  return v;
}

async function world(o = {}) {
  const home = h.tmpDir('nx-hm-home-');
  const repoDir = h.tmpDir('nx-hm-repo-');
  const dataHome = resolveDataHome(home);
  await dataHome.ensure();
  const store = fakeStore();
  if (o.keys !== false) { store.blob['config:hosted:alpha'] = Buffer.from(KEY_A, 'utf8').map((b) => b ^ 0x5a).toString('base64'); }
  const ref = { nx: null };
  const keys = createHostedKeys({ store, providers: () => ref.nx?.agentProbe?.cache.fresh('hosted-model')?.setup?.providers ?? null,
    onChange: (op, provider) => ref.nx.agents.recordKeyChange(ref.nx.principals.localUser(), op, provider) });
  const w = agentWorld({ platform: { dataHome, appVersion: 'test-1', runtimeHealthTtlMs: 600_000, hostedKeys: keys } });
  ref.nx = w.nx;
  w.db.prepare('UPDATE projects SET root_path = ? WHERE id = ?').run(repoDir, PROJECT);
  Object.assign(w, { dataHome, store, keys, st: { runtimes: o.runtimes ?? [cliRuntime(), hostedRuntime()] } });
  addRepository(w);
  const runner = new FakeRunner({ probeReply: (msg) => (msg.runtimes === true ? [sandbox([]), sandbox(w.st.runtimes)] : [sandbox([])]) });
  w.runner = runner;
  w.nx.exec.attachRunner(runner, w.nx.bootId);
  runner.report({ op: 'ready', bootId: w.nx.bootId, mcpUrl: MCP_URL });
  runner.report(sandbox([]));
  w.nx.agentProbe.refresh();
  w.x = ipcOver(w, { agentsUnavailableReason: () => null });
  Object.assign(w, {
    reprobe() { w.nx.agentProbe.refresh(); },
    tick(ms = 0) { if (ms) w.clock.t += ms; w.nx.exec.tick(w.clock.t); },
    job: (id) => w.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id),
    live: () => w.db.prepare('SELECT * FROM runtime_consents WHERE revoked_at IS NULL').all(),
    start(x = {}) {
      const r = w.nx.agents.start(w.me, { projectId: PROJECT, workspaceId: WORKSPACE, sessionId: x.sessionId ?? null, focusVersionIds: [],
        message: x.message ?? 'Add the pagination helper to the ledger report', intentId: ulid() });
      if (!w.db.prepare('SELECT 1 FROM session_worktrees WHERE session_id = ?').get(r.session.id)) {
        const name = r.session.id.toLowerCase();
        const dir = path.join(dataHome.root, 'wt', name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
        w.db.prepare(`INSERT INTO session_worktrees (session_id, project_id, rel_path, ref, integration_ref, base_commit, locked, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 1, ?)`).run(r.session.id, PROJECT, `wt/${name}`, `refs/nexus/job/${name}`, 'refs/nexus/accepted/main', 'b'.repeat(40), w.clock.t);
      }
      return r;
    },
    async lease(jobId) {
      for (let i = 0; i < 400 && w.job(jobId).state === 'queued'; i++) { w.tick(); await sleep(5); }
      const attempt = w.db.prepare('SELECT * FROM job_attempts WHERE job_id = ? ORDER BY n DESC LIMIT 1').get(jobId);
      const sent = attempt ? w.runner.sentOf('attempt.start').filter((m) => m.attemptId === attempt.id).at(-1) : undefined;
      return { job: w.job(jobId), attempt, plan: sent ? sent.plan : null };
    }
  });
  return w;
}
const grantH = (w, extra = { provider: 'alpha', model: 'a-big' }) => w.x.ok('nexus:agent:consent', { op: 'grant', runtime: 'hosted-model', ...extra });
const refusedReason = async (w, args, code, reason) => {
  const r = await w.x.refused('nexus:agent:consent', [args], code);
  assert.equal(r.reason, reason, JSON.stringify(r));
  assert.equal(r.message, AGENT_REASON_MESSAGES[reason], 'the fixed sentence');
  return r;
};
/** Every table's rows as one text, to look for text that must never be stored. */
function dumpDb(db) {
  const out = [];
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
    for (const row of db.prepare(`SELECT * FROM "${name}"`).all()) out.push(`${name}: ${JSON.stringify(row, (k, v) => (Buffer.isBuffer(v) ? v.toString('latin1') : v))}`);
  }
  return out.join('\n');
}

// ---------- HB1: the picker's data ----------

test('HB1 #51 lists the hosted runtime with its providers (from the probe), key presence as booleans, both providers\' hosts, and the one problem to act on', async () => {
  const w = await world();
  const v = await w.x.ok('nexus:agent:consent', { op: 'get' });
  const hosted = v.runtimes.find((r) => r.kind === 'hosted-model');
  assert.deepEqual([hosted.label, hosted.state, hosted.selected, hosted.models, hosted.provider, hosted.model, hosted.problem], ['Hosted (Test)', 'ready', false, null, null, null, 'provider_not_chosen']);
  assert.deepEqual(hosted.hosts, ['alpha.example.com:443', 'beta.example.com:443']);
  assert.deepEqual(hosted.providers.map((p) => [p.id, p.label, p.hosts, p.keyPresent]), [['alpha', 'Alpha (free key)', ['alpha.example.com'], true], ['beta', 'Beta (free key)', ['beta.example.com'], false]]);
  assert.deepEqual(hosted.providers[0].models, PROVIDERS[0].models);
  assert.equal('providers' in v.runtimes.find((r) => r.kind === 'cli-agent'), false, 'another runtime\'s row has no provider keys');
  // No key text and no key field anywhere in the view.
  assert.doesNotMatch(JSON.stringify(v), /TESTKEY|apiKey|secret/i);
});

// ---------- HB2: the grant ----------

test('HB2 a grant for the hosted kind covers BOTH providers\' hosts (hash-bound, the probe\'s own list) and records the provider and model in its audit row', async () => {
  const w = await world();
  const g = await grantH(w);
  assert.equal(g.consent.live, true);
  assert.deepEqual(g.consent.hosts, ['alpha.example.com:443', 'beta.example.com:443']);
  const row = w.live()[0];
  assert.equal(row.runtime_kind, 'hosted-model');
  assert.equal(row.hosts_json, JSON.stringify(['alpha.example.com:443', 'beta.example.com:443']));
  assert.equal(row.hosts_sha256, hostsSha256(HOSTED_HOSTS));
  assert.deepEqual(w.nx.budget.liveChoice(), { provider: 'alpha', model: 'a-big' });
  const audit = w.db.prepare("SELECT details_json FROM activity WHERE entity_id = ? AND action = 'agent.consent'").all(row.id).map((r) => JSON.parse(r.details_json));
  assert.deepEqual(audit.map((d) => [d.op, d.provider, d.model]), [['grant', 'alpha', 'a-big']]);
  assert.equal(g.runtimes.find((r) => r.kind === 'hosted-model').selected, true);
  assert.deepEqual([g.kind, g.problem], ['hosted-model', undefined], 'the row is about the hosted runtime and nothing is wrong');
  // Another runtime records no provider.
  await w.x.ok('nexus:agent:consent', { op: 'revoke' });
  assert.deepEqual(w.nx.budget.liveChoice(), { provider: null, model: null });
  await w.x.ok('nexus:agent:consent', { op: 'grant' });
  assert.equal(w.live()[0].runtime_kind, 'cli-agent');
  const cliAudit = w.db.prepare("SELECT details_json FROM activity WHERE entity_id = ? AND action = 'agent.consent'").all(w.live()[0].id).map((r) => JSON.parse(r.details_json));
  assert.equal('provider' in cliAudit[0], false);
});

test('HB2b a grant is refused, with the fixed sentence, for no choice, an unlisted provider or model, a model without tools; the provider is a choice, never a destination', async () => {
  const w = await world();
  await refusedReason(w, { op: 'grant', runtime: 'hosted-model' }, 'invalid', 'hosted_provider_not_chosen');
  await refusedReason(w, { op: 'grant', runtime: 'hosted-model', provider: 'alpha' }, 'invalid', 'hosted_provider_not_chosen');
  await refusedReason(w, { op: 'grant', runtime: 'hosted-model', provider: 'gamma', model: 'a-big' }, 'invalid', 'hosted_provider_not_chosen');
  await refusedReason(w, { op: 'grant', runtime: 'hosted-model', provider: 'alpha', model: 'b-fast' }, 'invalid', 'hosted_model_unavailable');
  await refusedReason(w, { op: 'grant', runtime: 'hosted-model', provider: 'alpha', model: 'a-plain' }, 'invalid', 'hosted_model_unavailable');
  assert.equal(w.live().length, 0, 'nothing was stored by any refusal');
  // Shape errors are request errors; another runtime does not take a provider.
  for (const provider of ['Alpha', 'a b', '', 7, 'x'.repeat(40), '../x']) await w.x.refused('nexus:agent:consent', [{ op: 'grant', runtime: 'hosted-model', provider, model: 'a-big' }], 'invalid');
  await refusedReason(w, { op: 'grant', runtime: 'cli-agent', provider: 'alpha' }, 'invalid', 'bad_provider');
  await w.x.refused('nexus:agent:consent', [{ op: 'get', provider: 'alpha' }], 'invalid');
  await w.x.refused('nexus:agent:consent', [{ op: 'revoke', provider: 'alpha' }], 'invalid');
  // A grant needs no key (a missing key is said when a turn starts), but it does need the owner role.
  assert.equal((await grantH(w, { provider: 'beta', model: 'b-fast' })).consent.live, true);
});

test('HB2c the model op changes provider and model of the live permission without touching it; it needs a hosted permission and a listed choice', async () => {
  const w = await world();
  await w.x.refused('nexus:agent:consent', [{ op: 'model', model: 'b-fast', provider: 'beta' }], 'unavailable', { reason: 'consent_missing' });
  await grantH(w);
  const id = w.live()[0].id;
  const v = await w.x.ok('nexus:agent:consent', { op: 'model', model: 'b-fast', provider: 'beta' });
  assert.deepEqual(w.nx.budget.liveChoice(), { provider: 'beta', model: 'b-fast' });
  assert.equal(w.live()[0].id, id, 'the permission is the same row');
  assert.equal(v.runtimes.find((r) => r.kind === 'hosted-model').provider, 'beta');
  // A model alone keeps the provider in force; a model of another provider is refused.
  await refusedReason(w, { op: 'model', model: 'a-big' }, 'invalid', 'hosted_model_unavailable');
  await refusedReason(w, { op: 'model', model: 'b-fast', provider: 'gamma' }, 'invalid', 'hosted_provider_not_chosen');
  assert.deepEqual(w.nx.budget.liveChoice(), { provider: 'beta', model: 'b-fast' });
  // Under a vendor permission the model op still answers as before.
  await w.x.ok('nexus:agent:consent', { op: 'revoke' });
  await w.x.ok('nexus:agent:consent', { op: 'grant' });
  await w.x.refused('nexus:agent:consent', [{ op: 'model', model: 'a-big', provider: 'alpha' }], 'unavailable', { reason: 'runtime_unknown' });
});

test('HB2d grant, switch and model with a provider need the owner role', async () => {
  const w = await world();
  await grantH(w);
  w.db.prepare('INSERT INTO principals VALUES (?,?,?,NULL,?)').run('u-viewer', 'user', 'u-viewer', h.NOW);
  w.db.prepare('INSERT INTO memberships VALUES (?,?,?,?,?)').run('u-viewer', 'project', PROJECT, 'viewer', h.NOW);
  const restore = asLocalUser(w.nx, { id: 'u-viewer', kind: 'user', displayName: 'u-viewer' });
  try {
    await w.x.refused('nexus:agent:consent', [{ op: 'model', model: 'b-fast', provider: 'beta' }], 'denied');
    await w.x.refused('nexus:agent:consent', [{ op: 'switch', runtime: 'hosted-model', provider: 'beta', model: 'b-fast' }], 'denied');
    assert.throws(() => w.nx.agents.recordKeyChange({ id: 'u-viewer', kind: 'user', displayName: 'u-viewer' }, 'set', 'alpha'), (e) => e.code === 'denied');
  } finally { restore(); }
  assert.deepEqual(w.nx.budget.liveChoice(), { provider: 'alpha', model: 'a-big' });
});

// ---------- HB3: start and lease ----------

test('HB3 a start is refused with the fixed sentence when no key is saved for the chosen provider, and works once it is; the sentence at start equals the one at lease', async () => {
  const w = await world();
  await grantH(w, { provider: 'beta', model: 'b-fast' });
  assert.throws(() => w.start(), (e) => e.code === 'unavailable' && e.detail.reason === 'hosted_key_missing');
  assert.equal(AGENT_REASON_MESSAGES.hosted_key_missing, 'Add your access key in Settings first.');
  assert.equal(w.keys.set('beta', KEY_B).ok, true);
  assert.equal(w.start().job.state, 'queued');
  // The model the user chose must still be offered (the probe changed under them).
  w.st.runtimes = [cliRuntime(), hostedRuntime({ providers: [{ ...PROVIDERS[1], models: [{ name: 'b-fast', tools: false }] }, PROVIDERS[0]] })];
  w.reprobe();
  assert.throws(() => w.start(), (e) => e.code === 'unavailable' && e.detail.reason === 'hosted_model_unavailable');
});

test('HB3b the lease puts the provider, the model and the key (in memory, in plan.runtime.apiKey) into the plan, and the key nowhere else: not the request, the records, any row, event, activity row or log', async () => {
  const w = await world();
  await grantH(w);
  const a = w.start();
  const { job, attempt, plan } = await w.lease(a.job.id);
  assert.equal(job.state, 'leased');
  assert.equal(plan.runtime.kind, 'hosted-model');
  assert.equal(plan.runtime.apiKey, KEY_A);
  assert.deepEqual(plan.runtime.request.model, { provider: 'alpha', model: 'a-big' });
  assert.equal('endpoint' in plan.runtime.request, false, 'the provider is chosen by id; main sends no endpoint');
  assert.deepEqual(plan.egress.allow, HOSTED_HOSTS);
  assert.equal(plan.egress.consentHostsSha256, hostsSha256(HOSTED_HOSTS));
  assert.equal(JSON.stringify(plan.runtime.request).includes(KEY_A), false, 'not in the request');
  const { runtime: _rt, ...rest } = plan;
  assert.equal(JSON.stringify(rest).includes(KEY_A), false, 'not anywhere else in the plan');
  assert.equal(attempt.sandbox_json.includes(KEY_A) || attempt.environment_json.includes(KEY_A), false);
  // Provisioned, running, then a failure with a message that (wrongly) echoes the key: nothing stored holds it.
  w.runner.report({ op: 'attempt.provisioned', attemptId: attempt.id, containerId: 'c'.repeat(64), imageDigest: IMAGE, preflight: passingPreflight() });
  assert.equal(w.job(a.job.id).state, 'running');
  const running = w.db.prepare('SELECT * FROM job_attempts WHERE id = ?').get(attempt.id);
  const settled = w.nx.agents.settle(running, w.job(a.job.id), { t: 'run.failed', at: 1, code: 'runtime_error', message: `boom ${KEY_A} boom` }, { code: 1 });
  assert.equal(JSON.stringify(settled).includes(KEY_A), false, 'a runtime message that echoes the key is scrubbed from the recorded error');
  assert.match(settled.error.message, /\[redacted\]/);
  // The activity rows, job events, every table, the platform's log lines and the views.
  w.nx.exec.cancel(w.me, a.job.id);
  const everything = [dumpDb(w.db), w.logs.join('\n'), JSON.stringify(w.runner.sent.map((m) => (m.op === 'attempt.start' ? { ...m, plan: { ...m.plan, runtime: { ...m.plan.runtime, apiKey: undefined } } } : m))),
    JSON.stringify(await w.x.ok('nexus:agent:consent', { op: 'get' })), JSON.stringify(await w.x.ok('nexus:platform:health')),
    JSON.stringify(await w.x.ok('nexus:session:get', a.session.id))].join('\n');
  assert.equal(everything.includes(KEY_A), false, 'the key is in no row, event, activity row, log line, message to the runner (other than the plan field) or view');
  assert.equal(everything.includes(Buffer.from(KEY_A, 'utf8').toString('base64')), false);
});

test('HB3c a key deleted between start and lease fails the turn with the fixed sentence at lease, and nothing is minted or sent', async () => {
  const w = await world();
  await grantH(w);
  const a = w.start();
  w.keys.delete('alpha');
  const { job, plan } = await w.lease(a.job.id);
  assert.equal(plan, null, 'no plan was sent');
  assert.equal(job.state, 'failed');
  assert.equal(job.outcome, 'hosted_key_missing');
  assert.equal(JSON.parse(job.error_json).message, 'no API key is saved for the chosen model provider');
  assert.equal(w.runner.sentOf('attempt.start').length, 0);
});

test('HB3d a vendor-CLI turn is unchanged: no key field in its plan, no provider in its request', async () => {
  const w = await world();
  await w.x.ok('nexus:agent:consent', { op: 'grant' });
  const a = w.start();
  const { plan } = await w.lease(a.job.id);
  assert.equal('apiKey' in plan.runtime, false);
  assert.deepEqual(plan.runtime.request.model, { provider: 'runtime-owned', model: 'default' });
  assert.equal(plan.runtime.kind, 'cli-agent');
});

// ---------- HB4: how a hosted turn ends ----------

test('HB4 the runner\'s fixed failure sentences become the reasons main has copy for; a key problem does not end the conversation; every sentence is in main and the renderer', async () => {
  const w = await world();
  await grantH(w);
  const a = w.start();
  const { attempt } = await w.lease(a.job.id);
  const row = w.db.prepare('SELECT * FROM job_attempts WHERE id = ?').get(attempt.id);
  const j = w.job(a.job.id);
  for (const [message, reason] of Object.entries(HOSTED_RUNNER_MESSAGE_REASON)) {
    const s = w.nx.agents.settle(row, j, { t: 'run.failed', at: 1, code: reason === 'hosted_key_rejected' || reason === 'hosted_key_missing' ? 'auth' : 'runtime_error', message }, { code: 1 });
    assert.deepEqual([s.job, s.outcome, s.error.code, s.sessionFailed], ['failed', reason, reason, undefined], reason);
    assert.ok(AGENT_REASON_MESSAGES[reason], `${reason} has a sentence`);
  }
  // Another sentence keeps the generic outcome of its code; another runtime's `auth` still fails the session.
  assert.equal(w.nx.agents.settle(row, j, { t: 'run.failed', at: 1, code: 'auth', message: 'something else' }, { code: 1 }).outcome, 'runtime_auth');
  assert.equal(w.nx.agents.settle({ ...row, runtime_kind: 'cli-agent' }, j, { t: 'run.failed', at: 1, code: 'auth', message: 'the model provider rejected the API key' }, { code: 1 }).outcome, 'runtime_auth');
});

test('HB4b a turn the provider rejected reads as "key rejected" on the selected row until a key or a choice changes; the key IPC leaves an audit row without the key', async () => {
  const w = await world();
  await grantH(w);
  const a = w.start();
  const { attempt } = await w.lease(a.job.id);
  w.clock.t += 1000;
  w.db.prepare("UPDATE job_attempts SET outcome = 'hosted_key_rejected', state = 'failed', finished_at = ? WHERE id = ?").run(w.clock.t, attempt.id);
  w.clock.t += 1000;
  const probs = async () => (await w.x.ok('nexus:agent:consent', { op: 'get' })).runtimes.find((r) => r.kind === 'hosted-model').problem;
  assert.equal(await probs(), 'key_rejected');
  assert.equal((await w.x.ok('nexus:platform:health')).agent.problem, 'key_rejected');
  w.clock.t += 1000;
  assert.equal(w.keys.set('alpha', KEY_B).ok, true);
  assert.equal(await probs(), null, 'a new key clears it');
  const rows = w.db.prepare("SELECT details_json FROM activity WHERE action = 'hosted.key'").all().map((r) => r.details_json);
  assert.deepEqual(rows.map((r) => JSON.parse(r)), [{ op: 'set', provider: 'alpha' }]);
  assert.equal(rows.join('').includes(KEY_B), false);
});

// ---------- HB5: stopping live turns ----------

test('HB5 deleting the chosen provider\'s key stops a live turn through the existing cancel path; deleting another provider\'s key does not; revoking the permission stops it too', async () => {
  const w = await world();
  await grantH(w);
  const a = w.start();
  const { attempt } = await w.lease(a.job.id);
  w.runner.report({ op: 'attempt.provisioned', attemptId: attempt.id, containerId: 'c'.repeat(64), imageDigest: IMAGE, preflight: passingPreflight() });
  assert.equal(w.job(a.job.id).state, 'running');
  w.keys.set('beta', KEY_B);
  w.keys.delete('beta');
  assert.equal(w.job(a.job.id).state, 'running', 'another provider\'s key does not matter');
  const before = w.runner.sentOf('attempt.cancel').length;
  assert.equal(w.keys.delete('alpha').ok, true);
  assert.notEqual(w.job(a.job.id).state, 'running');
  const cancels = w.runner.sentOf('attempt.cancel');
  assert.equal(cancels.length, before + 1);
  assert.equal(cancels.at(-1).attemptId, attempt.id);
  const err = JSON.parse(w.job(a.job.id).error_json ?? 'null');
  assert.ok(err === null || err.code === 'hosted_key_missing');
  // Revocation of the permission: the existing path.
  const w2 = await world();
  await grantH(w2);
  const b = w2.start();
  const l2 = await w2.lease(b.job.id);
  w2.runner.report({ op: 'attempt.provisioned', attemptId: l2.attempt.id, containerId: 'c'.repeat(64), imageDigest: IMAGE, preflight: passingPreflight() });
  await w2.x.ok('nexus:agent:consent', { op: 'revoke' });
  assert.notEqual(w2.job(b.job.id).state, 'running');
  assert.equal(w2.runner.sentOf('attempt.cancel').at(-1).attemptId, l2.attempt.id);
});

// ---------- HB6: switching ----------

test('HB6 switching to the hosted runtime carries the caps and records the provider; switching away drops it; a refused switch changes nothing', async () => {
  const w = await world();
  await w.x.ok('nexus:agent:consent', { op: 'grant', caps: { turnUsdCents: 50, toolCalls: 10 } });
  const cliId = w.live()[0].id;
  const s = await w.x.ok('nexus:agent:consent', { op: 'switch', runtime: 'hosted-model', provider: 'beta', model: 'b-fast' });
  const live = w.live()[0];
  assert.notEqual(live.id, cliId);
  assert.deepEqual([live.runtime_kind, live.turn_usd_cents, live.tool_calls, live.hosts_sha256], ['hosted-model', 50, 10, hostsSha256(HOSTED_HOSTS)]);
  assert.deepEqual(w.nx.budget.liveChoice(), { provider: 'beta', model: 'b-fast' });
  assert.equal(s.runtimes.find((r) => r.selected).kind, 'hosted-model');
  await w.x.ok('nexus:agent:consent', { op: 'switch', runtime: 'cli-agent' });
  assert.deepEqual(w.nx.budget.liveChoice(), { provider: null, model: null });
  const before = w.live()[0].id;
  await refusedReason(w, { op: 'switch', runtime: 'hosted-model', provider: 'alpha', model: 'a-plain' }, 'invalid', 'hosted_model_unavailable');
  assert.deepEqual(w.live().map((r) => r.id), [before]);
});

// ---------- HB7: the key IPC's audit and the platform without keys ----------

test('HB7 with no key saved a hosted start is refused with the fixed sentence, and the hosted probe entry is what feeds the key list', async () => {
  const w = await world({ keys: false });
  const list = w.keys.list();
  assert.equal(list.ok, true);
  assert.deepEqual(list.providers.map((p) => [p.id, p.present]), [['alpha', false], ['beta', false]]);
  await grantH(w);
  assert.throws(() => w.start(), (e) => e.detail.reason === 'hosted_key_missing');
  w.st.runtimes = [cliRuntime()];
  w.reprobe();
  assert.equal(w.keys.list().ok, false, 'no providers known without the hosted probe entry');
  assert.equal(w.keys.set('alpha', KEY_A).ok, false);
});
