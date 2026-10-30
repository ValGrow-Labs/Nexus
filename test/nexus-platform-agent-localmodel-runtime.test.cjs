'use strict';
// Nexus local-model runtime, main side (Track B): choosing the agent runtime and, for the local-model kind, its model.
// The REAL platform (v10 database, tokens, budgets, the agent service, the #51 handler); the runner is a FakeRunner that answers
// each runtime probe with two runtimes (the vendor-CLI kind and the local-model kind) and the test reads the plan main sends.
// No Docker, no process, no network, no real home. LM1-LM8.
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { agentWorld } = require('./helpers/agentFixtures.cjs');
const { FakeRunner } = require('./helpers/fakeRunner.cjs');
const { ipcOver, noLeak } = require('./helpers/ipcExec.cjs');
const { PROFILES, passingPreflight, GIB } = require('./helpers/execWorld.cjs');
const { newId } = loadTs('src/main/nexus/db/ids.ts');
const { resolveDataHome } = loadTs('src/main/nexusExec/dataHome.ts');
const { hostsSha256 } = loadTs('src/main/nexus/agents/budgetService.ts');
const { AGENT_REASON_MESSAGES } = loadTs('src/main/nexusIpc/envelope.ts');

const PROJECT = 'p-ledger';
const WORKSPACE = 'sde';
const CLI_HOSTS = [{ host: 'cli.example.com', port: 443 }];
const LOCAL_HOSTS = [{ host: '127.0.0.1', port: 11434 }];
const MODELS = [{ name: 'coder:7b', tools: true }, { name: 'plain:1b', tools: false }];
const MCP_URL = 'http://127.0.0.1:43111/mcp';
const IMAGE = 'sha256:' + '1'.repeat(64);
let seq = 0;
const ulid = () => newId(Date.now() + (++seq));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cliRuntime = (o = {}) => ({ kind: 'cli-agent', health: o.health ?? { ok: true, version: '2.0.0' },
  setup: { signedIn: 'yes', flagsOk: true, label: 'Test Engine', egressHosts: CLI_HOSTS } });
const localRuntime = (o = {}) => ({ kind: 'local-model', health: o.health ?? { ok: true, version: '0.5.0' },
  setup: { signedIn: 'yes', flagsOk: true, label: 'Local model (Test)', egressHosts: o.hosts ?? LOCAL_HOSTS, models: o.models ?? MODELS } });
const sandbox = (runtimes) => ({ op: 'probe.result',
  probe: { docker: 'running', version: '27.0.0', cpus: 4, memoryBytes: 8 * GIB, gpu: { detected: false, usableInContainers: false } },
  images: [{ profile: 'sde-node', present: true, digestMatches: true, imageId: IMAGE }, { profile: 'sde-python', present: true, digestMatches: true, imageId: 'sha256:' + '2'.repeat(64) }],
  freeBytes: 100 * GIB, runtimes });

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

/** A platform whose runtime health is the REAL cache, filled by the runner's answers to `probe`; settings are `w.cfg.current`. */
async function world(o = {}) {
  const home = h.tmpDir('nx-lm-home-');
  const repoDir = h.tmpDir('nx-lm-repo-');
  const dataHome = resolveDataHome(home);
  await dataHome.ensure();
  const cfg = { current: o.cfg === undefined ? {} : o.cfg };
  const w = agentWorld({ platform: { dataHome, appVersion: 'test-1', localModelConfig: () => cfg.current, runtimeHealthTtlMs: 600_000, ...(o.platform ?? {}) } });
  w.db.prepare('UPDATE projects SET root_path = ? WHERE id = ?').run(repoDir, PROJECT);
  Object.assign(w, { dataHome, cfg, st: { runtimes: o.runtimes ?? [cliRuntime(), localRuntime()] } });
  addRepository(w);
  const runner = new FakeRunner({ probeReply: (msg) => (msg.runtimes === true ? [sandbox([]), sandbox(w.st.runtimes.filter((r) => !w.st.honorKinds || !msg.kinds || msg.kinds.includes(r.kind)))] : [sandbox([])]) });
  w.runner = runner;
  w.nx.exec.attachRunner(runner, w.nx.bootId);
  runner.report({ op: 'ready', bootId: w.nx.bootId, mcpUrl: MCP_URL });
  runner.report(sandbox([]));
  w.nx.agentProbe.refresh();
  w.x = ipcOver(w, { agentsUnavailableReason: () => null });
  Object.assign(w, {
    /** The runner's next runtime answer (tests change `w.st.runtimes` first). */
    reprobe() { w.nx.agentProbe.refresh(); },
    tick(ms = 0) { if (ms) w.clock.t += ms; w.nx.exec.tick(w.clock.t); },
    job: (id) => w.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id),
    consents: () => w.db.prepare('SELECT * FROM runtime_consents ORDER BY granted_at, rowid').all(),
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
    /** Ticks until the turn leaves the queue; returns its row and the plan the runner was sent (when it was leased). */
    async lease(jobId) {
      for (let i = 0; i < 400 && w.job(jobId).state === 'queued'; i++) { w.tick(); await sleep(5); }
      const attempt = w.db.prepare('SELECT * FROM job_attempts WHERE job_id = ? ORDER BY n DESC LIMIT 1').get(jobId);
      const sent = attempt ? w.runner.sentOf('attempt.start').filter((m) => m.attemptId === attempt.id).at(-1) : undefined;
      return { job: w.job(jobId), attempt, plan: sent ? sent.plan : null };
    }
  });
  return w;
}
const grant = (w, extra = {}) => w.x.ok('nexus:agent:consent', { op: 'grant', ...extra });
const refusedReason = async (w, args, code, reason) => {
  const r = await w.x.refused('nexus:agent:consent', [args], code);
  assert.equal(r.reason, reason, JSON.stringify(r));
  assert.equal(r.message, AGENT_REASON_MESSAGES[reason], 'the fixed sentence');
  return r;
};

// ---------- LM1: the picker's data, from the probe ----------

test('LM1 #51 lists every runtime the probe reported (label, state, models) and names the destination of each', async () => {
  const w = await world();
  const v = await w.x.ok('nexus:agent:consent', { op: 'get' });
  assert.equal(v.runtimes.length, 2);
  const [cli, local] = v.runtimes;
  assert.deepEqual([cli.kind, cli.label, cli.state, cli.selected, cli.models, cli.model, cli.problem, cli.hosts], ['cli-agent', 'Test Engine', 'ready', false, null, null, null, ['cli.example.com:443']]);
  assert.deepEqual([local.kind, local.label, local.state, local.selected, local.hosts], ['local-model', 'Local model (Test)', 'ready', false, ['127.0.0.1:11434']]);
  assert.deepEqual(local.models, MODELS);
  assert.equal(local.model, null);
  assert.equal(local.problem, 'model_not_chosen', 'no model is chosen and no settings default exists');
  // With the user's existing settings naming a local default model, it is the preselected one.
  w.cfg.current = { providerDefaultModels: { opencode: 'ollama/coder:7b' } };
  const v2 = await w.x.ok('nexus:agent:consent', { op: 'get' });
  assert.deepEqual([v2.runtimes[1].model, v2.runtimes[1].problem], ['coder:7b', null]);
  // A default that the server does not list, or that cannot use tools, is said.
  w.cfg.current = { providerDefaultModels: { opencode: 'local/gone:1b' } };
  assert.equal((await w.x.ok('nexus:agent:consent', { op: 'get' })).runtimes[1].problem, 'model_missing');
  w.cfg.current = { providerDefaultModels: { opencode: 'local/plain:1b' } };
  assert.equal((await w.x.ok('nexus:agent:consent', { op: 'get' })).runtimes[1].problem, 'model_no_tools');
  // A non-loopback address in the settings is never used.
  w.cfg.current = { providerBaseUrls: { opencode: 'http://192.168.1.20:11434/v1' }, providerDefaultModels: { opencode: 'local/coder:7b' } };
  assert.equal((await w.x.ok('nexus:agent:consent', { op: 'get' })).runtimes[1].problem, 'address_not_local');
  // The model names and the destinations are in #51's runtime rows and nowhere else.
  const health = await w.x.ok('nexus:platform:health');
  assert.doesNotMatch(JSON.stringify(health), /coder:7b|plain:1b|127\.0\.0\.1|cli\.example\.com/);
  noLeak(v);
  // A single default-kind runtime lists nothing extra (the sheet is as it was).
  const one = await world({ runtimes: [cliRuntime()] });
  assert.equal('runtimes' in (await one.x.ok('nexus:agent:consent', { op: 'get' })), false);
});

// ---------- LM2: the consent grant for the local kind ----------

test('LM2 a grant for the local kind takes the destination from ITS probe entry, hash-bound, and records the chosen model; the default grant is unchanged', async () => {
  const w = await world();
  const g = await grant(w, { runtime: 'local-model', model: 'coder:7b' });
  assert.equal(g.consent.live, true);
  assert.deepEqual(g.consent.hosts, ['127.0.0.1:11434']);
  const row = w.live()[0];
  assert.equal(row.runtime_kind, 'local-model');
  assert.equal(row.hosts_json, JSON.stringify(['127.0.0.1:11434']));
  assert.equal(row.hosts_sha256, hostsSha256(LOCAL_HOSTS));
  assert.equal(w.nx.budget.liveModel(), 'coder:7b');
  const audit = w.db.prepare("SELECT details_json FROM activity WHERE entity_id = ? AND action = 'agent.consent'").all(row.id).map((r) => JSON.parse(r.details_json));
  assert.deepEqual(audit.map((d) => [d.op, d.model]), [['grant', 'coder:7b']]);
  assert.equal(g.runtimes.find((r) => r.kind === 'local-model').selected, true);
  assert.equal(g.runtimes.find((r) => r.kind === 'cli-agent').selected, false);
  assert.equal(g.kind, 'local-model', '#51 says which runtime its row is about');
  // The default (no runtime named) is the first runtime the probe reported, exactly as before.
  await w.x.ok('nexus:agent:consent', { op: 'revoke' });
  assert.equal(w.nx.budget.liveModel(), null);
  const d = await grant(w);
  assert.equal(w.live()[0].runtime_kind, 'cli-agent');
  assert.equal(w.live()[0].hosts_sha256, hostsSha256(CLI_HOSTS));
  assert.equal('kind' in d, false, 'the default runtime\'s row has no new key');
  assert.equal(w.nx.budget.liveModel(), null);
  const cliAudit = w.db.prepare("SELECT details_json FROM activity WHERE entity_id = ? AND action = 'agent.consent'").all(w.live()[0].id).map((r) => JSON.parse(r.details_json));
  assert.equal('model' in cliAudit[0], false, 'a grant for another runtime records no model');
});

test('LM2b a grant for the local kind is refused, with the fixed sentence, when the model or the address cannot be used', async () => {
  const w = await world();
  await refusedReason(w, { op: 'grant', runtime: 'local-model' }, 'invalid', 'local_model_not_chosen');
  await refusedReason(w, { op: 'grant', runtime: 'local-model', model: 'gone:1b' }, 'invalid', 'local_model_missing');
  await refusedReason(w, { op: 'grant', runtime: 'local-model', model: 'plain:1b' }, 'invalid', 'local_model_no_tools');
  w.cfg.current = { providerBaseUrls: { opencode: 'http://example.com:11434' } };
  await refusedReason(w, { op: 'grant', runtime: 'local-model', model: 'coder:7b' }, 'invalid', 'local_model_endpoint');
  // A loopback address on another port than the probe's destination is not the one a permission would cover.
  w.cfg.current = { providerBaseUrls: { opencode: 'http://127.0.0.1:9999' } };
  await refusedReason(w, { op: 'grant', runtime: 'local-model', model: 'coder:7b' }, 'invalid', 'local_model_endpoint');
  assert.equal(w.consents().length, 0, 'nothing was stored by any refusal');
  // A kind the probe did not report, a model for a runtime that takes none.
  await w.x.refused('nexus:agent:consent', [{ op: 'grant', runtime: 'not-there' }], 'unavailable', { reason: 'runtime_unknown' });
  const r = await w.x.refused('nexus:agent:consent', [{ op: 'grant', runtime: 'cli-agent', model: 'coder:7b' }], 'invalid', { reason: 'bad_model' });
  assert.equal(r.message, AGENT_REASON_MESSAGES.bad_model);
  assert.equal(w.consents().length, 0);
  // Localhost and the IPv4 loopback spelling are the same destination.
  w.cfg.current = { providerBaseUrls: { opencode: 'http://localhost:11434/v1' } };
  assert.equal((await grant(w, { runtime: 'local-model', model: 'coder:7b' })).consent.live, true);
});

test('LM2c the request shapes: a runtime kind and a model name are checked in main; get and revoke take neither', async () => {
  const w = await world();
  const bad = async (args, field) => {
    const r = await w.x.call('nexus:agent:consent', args);
    assert.deepEqual([r.ok, r.code, r.reason, r.field], [false, 'invalid', 'bad_request', field], JSON.stringify(r));
  };
  await bad({ op: 'grant', runtime: 'Not A Kind' }, 'runtime');
  await bad({ op: 'grant', runtime: 7 }, 'runtime');
  await bad({ op: 'grant', model: '../../etc/passwd' }, 'model');
  await bad({ op: 'grant', model: 'a'.repeat(129) }, 'model');
  await bad({ op: 'grant', model: 'a b' }, 'model');
  await bad({ op: 'switch' }, 'runtime');
  await bad({ op: 'model' }, 'model');
  await bad({ op: 'model', model: 'x', runtime: 'local-model' }, 'runtime');
  await bad({ op: 'model', model: 'x', caps: {} }, 'caps');
  await bad({ op: 'get', runtime: 'local-model' }, 'runtime');
  await bad({ op: 'get', model: 'coder:7b' }, 'model');
  await bad({ op: 'revoke', model: 'coder:7b' }, 'model');
  await bad({ op: 'grant', host: 'evil.example.com' }, 'host');
  await bad({ op: 'grant', hosts: ['evil.example.com:443'] }, 'hosts');
  await bad({ op: 'switch', runtime: 'local-model', endpoint: { host: '127.0.0.1', port: 1 } }, 'endpoint');
});

// ---------- LM3: the turn's request ----------

test('LM3 a turn for the local kind carries the chosen model and the settings\' loopback endpoint; the CLI kind\'s request is as it always was', async () => {
  const w = await world({ cfg: { providerBaseUrls: { opencode: 'http://localhost:11434/v1' } } });
  await grant(w, { runtime: 'local-model', model: 'coder:7b' });
  const a = w.start();
  const { job, plan } = await w.lease(a.job.id);
  assert.equal(job.state, 'leased', JSON.stringify(job));
  assert.equal(plan.runtime.kind, 'local-model');
  assert.deepEqual(plan.runtime.request.model, { provider: 'local-model', model: 'coder:7b' });
  assert.deepEqual(plan.runtime.request.endpoint, { host: '127.0.0.1', port: 11434 }, 'localhost is the IPv4 loopback address');
  assert.deepEqual(plan.runtime.request.credential, { ref: 'runtime-owned' });
  assert.deepEqual(plan.egress.allow, LOCAL_HOSTS, 'the allow-list is the adapter\'s own host list');
  assert.equal(plan.egress.consentHostsSha256, hostsSha256(LOCAL_HOSTS));
  assert.equal(plan.container.network.mode, 'none');
  assert.doesNotMatch(JSON.stringify(plan.runtime.request), /ollama|qwen|llama/i);

  // The CLI kind: the request names the runtime-owned model and has no `endpoint` key at all.
  const c = await world();
  await grant(c);
  const b = c.start();
  const cli = await c.lease(b.job.id);
  assert.equal(cli.job.state, 'leased', JSON.stringify(cli.job));
  assert.equal(cli.plan.runtime.kind, 'cli-agent');
  assert.deepEqual(cli.plan.runtime.request.model, { provider: 'runtime-owned', model: 'default' });
  assert.equal('endpoint' in cli.plan.runtime.request, false);
  assert.deepEqual(cli.plan.egress.allow, CLI_HOSTS);
});

test('LM3b the model for a turn is the one chosen for the live permission, else the settings default; a model change applies to the next turn', async () => {
  const w = await world({ cfg: { providerDefaultModels: { opencode: 'local/coder:7b' } } });
  await grant(w, { runtime: 'local-model' });
  assert.equal(w.nx.budget.liveModel(), 'coder:7b', 'the grant without a model took the settings default (it is in the probe list)');
  w.st.runtimes = [cliRuntime(), localRuntime({ models: [...MODELS, { name: 'other:3b', tools: true }] })];
  w.reprobe();
  const g = await w.x.ok('nexus:agent:consent', { op: 'model', model: 'other:3b' });
  assert.equal(g.runtimes[1].model, 'other:3b');
  assert.equal(w.live().length, 1, 'the permission itself did not change');
  assert.equal(w.nx.budget.liveModel(), 'other:3b');
  const a = w.start();
  const { plan } = await w.lease(a.job.id);
  assert.equal(plan.runtime.request.model.model, 'other:3b');
  // The model op needs a model the probe listed, and one that can use tools.
  await refusedReason(w, { op: 'model', model: 'plain:1b' }, 'invalid', 'local_model_no_tools');
  await refusedReason(w, { op: 'model', model: 'nope:1b' }, 'invalid', 'local_model_missing');
  assert.equal(w.nx.budget.liveModel(), 'other:3b');
  // No live permission: nothing to change.
  await w.x.ok('nexus:agent:consent', { op: 'revoke' });
  await w.x.refused('nexus:agent:consent', [{ op: 'model', model: 'coder:7b' }], 'unavailable', { reason: 'consent_missing' });
  assert.equal(w.nx.budget.liveModel(), null, 'a revoked permission keeps no model');
});

// ---------- LM4: the fixed sentences ----------

test('LM4 a start is refused with the local runtime\'s own sentence: server not running, model missing, model cannot use tools, address not local, no model', async () => {
  const w = await world({ cfg: { providerDefaultModels: { opencode: 'local/coder:7b' } } });
  await grant(w, { runtime: 'local-model', model: 'coder:7b' });
  const startReason = (want, sentence) => {
    assert.throws(() => w.start(), (e) => e.code === 'unavailable' && e.detail.reason === want && e.message === sentence, want);
  };
  // The server is not running (the probe's "not installed" is the server being down for this runtime).
  w.st.runtimes = [cliRuntime(), localRuntime({ health: { ok: false, reason: 'not_installed', detail: 'the local model server did not answer' } })];
  w.reprobe();
  startReason('runtime_not_installed', 'the local model server is not running on this computer');
  w.st.runtimes = [cliRuntime(), localRuntime({ models: [{ name: 'plain:1b', tools: true }] })];
  w.reprobe();
  startReason('local_model_missing', 'the chosen local model is not installed on this computer');
  w.st.runtimes = [cliRuntime(), localRuntime({ models: [{ name: 'coder:7b', tools: false }] })];
  w.reprobe();
  startReason('local_model_no_tools', 'the chosen local model cannot use tools, which agent turns need');
  w.st.runtimes = [cliRuntime(), localRuntime()];
  w.reprobe();
  w.cfg.current = { providerBaseUrls: { opencode: 'http://10.0.0.5:11434' } };
  startReason('local_model_endpoint', 'the local model address is not on this computer, or is not the one that was given permission');
  w.cfg.current = {};
  assert.equal(w.start().job.state, 'queued', 'the same permission starts once everything is usable again');
  // The renderer-visible sentences (main\'s words) say the same thing in full.
  for (const k of ['local_model_not_chosen', 'local_model_endpoint', 'local_model_missing', 'local_model_no_tools', 'local_model_server_down', 'turn_live']) {
    assert.ok(AGENT_REASON_MESSAGES[k] && AGENT_REASON_MESSAGES[k].length > 20, k);
    assert.doesNotMatch(AGENT_REASON_MESSAGES[k], /ollama|qwen|llama|[a-z]+_[a-z_]+/i, `${k} is neutral and carries no code`);
  }
});

test('LM4b a queued turn whose settings broke before its lease fails with the fixed sentence, and nothing is minted', async () => {
  const w = await world({ cfg: { providerDefaultModels: { opencode: 'local/coder:7b' } } });
  await grant(w, { runtime: 'local-model', model: 'coder:7b' });
  const a = w.start();
  w.cfg.current = { providerBaseUrls: { opencode: 'http://evil.example.com:11434' } };
  const { job, plan } = await w.lease(a.job.id);
  assert.equal(plan, null, 'no plan was sent');
  assert.equal(job.state, 'failed');
  assert.equal(job.outcome, 'local_model_endpoint');
  assert.equal(JSON.parse(job.error_json ?? '{}').message ?? 'x', 'the local model address is not on this computer, or is not the one that was given permission');
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM capability_tokens WHERE job_id = ?').get(a.job.id).n, 0, 'no token was minted for the failed lease');
});

// ---------- LM5: health per runtime ----------

test('LM5 the cache keeps every runtime: a turn is judged by the live permission\'s own runtime, never by the first one', async () => {
  const w = await world();
  const cache = w.nx.agentProbe.cache;
  assert.deepEqual(cache.all().map((e) => e.kind), ['cli-agent', 'local-model']);
  assert.equal(cache.fresh().kind, 'cli-agent', 'no kind named: the default runtime, as before');
  assert.deepEqual(cache.egressHosts('local-model'), LOCAL_HOSTS);
  assert.deepEqual(cache.egressHosts(), CLI_HOSTS);
  assert.equal(cache.fresh('nope'), null);
  // The default runtime is down; a permission for the local kind still starts a turn (its own health is what counts).
  w.st.runtimes = [cliRuntime({ health: { ok: false, reason: 'not_authenticated', detail: 'x' } }), localRuntime()];
  w.reprobe();
  await grant(w, { runtime: 'local-model', model: 'coder:7b' });
  assert.equal(w.start().job.state, 'queued');
  // And the other way round: the local server is down; a permission for the default runtime is unaffected.
  await w.x.ok('nexus:agent:consent', { op: 'revoke' });
  w.st.runtimes = [cliRuntime(), localRuntime({ health: { ok: false, reason: 'not_installed', detail: 'x' } })];
  w.reprobe();
  await grant(w);
  assert.equal(w.start({ sessionId: null }).job.state, 'queued');
  // A permission for a kind the runner does not report is a mismatch with the default runtime, as it always was.
  await w.x.ok('nexus:agent:consent', { op: 'revoke' });
  w.nx.budget.grant(w.me, { runtimeKind: 'gone-kind', hosts: [{ host: 'x.example.com', port: 443 }] });
  assert.throws(() => w.start(), (e) => e.code === 'unavailable' && e.detail.reason === 'runtime_mismatch');
});

// ---------- LM6: switching ----------

test('LM6 switching revokes one permission and grants the other as one step: the caps carry over, one permission is live, and a refused switch changes nothing', async () => {
  const w = await world();
  await grant(w, { caps: { turnUsdCents: 50, toolCalls: 10 } });
  const cliId = w.live()[0].id;
  const s = await w.x.ok('nexus:agent:consent', { op: 'switch', runtime: 'local-model', model: 'coder:7b' });
  assert.equal(w.live().length, 1);
  const live = w.live()[0];
  assert.notEqual(live.id, cliId);
  assert.equal(live.runtime_kind, 'local-model');
  assert.equal(live.hosts_sha256, hostsSha256(LOCAL_HOSTS));
  assert.deepEqual([live.turn_usd_cents, live.tool_calls], [50, 10], 'the caps carried over');
  assert.equal(w.db.prepare('SELECT revoked_at FROM runtime_consents WHERE id = ?').get(cliId).revoked_at !== null, true, 'the earlier permission was revoked');
  assert.equal(s.runtimes.find((r) => r.selected).kind, 'local-model');
  assert.equal(w.nx.budget.liveModel(), 'coder:7b');
  // Back to the default runtime; the model record goes with the local permission.
  await w.x.ok('nexus:agent:consent', { op: 'switch', runtime: 'cli-agent' });
  assert.equal(w.live()[0].runtime_kind, 'cli-agent');
  assert.equal(w.nx.budget.liveModel(), null);
  // A switch that is refused (a model that cannot use tools) leaves the live permission exactly as it was.
  const before = w.live()[0].id;
  await refusedReason(w, { op: 'switch', runtime: 'local-model', model: 'plain:1b' }, 'invalid', 'local_model_no_tools');
  assert.deepEqual(w.live().map((r) => r.id), [before]);
  // The revoke and the grant are one transaction: when the grant itself fails, the revocation is undone.
  const orig = w.nx.budget.grant.bind(w.nx.budget);
  w.nx.budget.grant = () => { throw new Error('boom'); };
  const r = await w.x.call('nexus:agent:consent', { op: 'switch', runtime: 'local-model', model: 'coder:7b' });
  w.nx.budget.grant = orig;
  assert.equal(r.ok, false);
  assert.deepEqual(w.live().map((x) => x.id), [before], 'the earlier permission is still live');
  assert.equal(w.db.prepare('SELECT revoked_at FROM runtime_consents WHERE id = ?').get(before).revoked_at, null);
});

test('LM6b a switch never cancels work: it is refused while a turn runs (the permission stays), and works once the turn has ended', async () => {
  const w = await world({ cfg: { providerDefaultModels: { opencode: 'local/coder:7b' } } });
  await grant(w);
  const a = w.start();
  const { attempt, plan } = await w.lease(a.job.id);
  assert.equal(w.job(a.job.id).state, 'leased');
  w.runner.report({ op: 'attempt.provisioned', attemptId: attempt.id, containerId: 'c'.repeat(64), imageDigest: IMAGE, preflight: passingPreflight() });
  assert.ok(plan);
  const id = w.live()[0].id;
  await refusedReason(w, { op: 'switch', runtime: 'local-model', model: 'coder:7b' }, 'conflict', 'turn_live');
  assert.deepEqual(w.live().map((r) => r.id), [id], 'nothing changed');
  assert.equal(w.job(a.job.id).state, 'running', 'the turn was not cancelled');
  // A plain grant while a permission is live is still refused as it always was.
  await w.x.refused('nexus:agent:consent', [{ op: 'grant', runtime: 'local-model', model: 'coder:7b' }], 'conflict', { reason: 'consent_live' });
});

test('LM6c grant, switch and model need the owner role', async () => {
  const w = await world();
  await grant(w, { runtime: 'local-model', model: 'coder:7b' });
  w.db.prepare('INSERT INTO principals VALUES (?,?,?,NULL,?)').run('u-viewer', 'user', 'u-viewer', h.NOW);
  w.db.prepare('INSERT INTO memberships VALUES (?,?,?,?,?)').run('u-viewer', 'project', PROJECT, 'viewer', h.NOW);
  const { asLocalUser } = require('./helpers/ipcExec.cjs');
  const restore = asLocalUser(w.nx, { id: 'u-viewer', kind: 'user', displayName: 'u-viewer' });
  try {
    await w.x.refused('nexus:agent:consent', [{ op: 'switch', runtime: 'cli-agent' }], 'denied');
    await w.x.refused('nexus:agent:consent', [{ op: 'model', model: 'coder:7b' }], 'denied');
    await w.x.refused('nexus:agent:consent', [{ op: 'revoke' }], 'denied');
  } finally { restore(); }
  assert.equal(w.live()[0].runtime_kind, 'local-model', 'still live and unchanged');
});

// ---------- LM7: the views ----------

test('LM7 #23 says which runtime the row is about and why a chosen model cannot be used, only for the local kind', async () => {
  const w = await world({ cfg: { providerDefaultModels: { opencode: 'local/coder:7b' } } });
  assert.equal('kind' in (await w.x.ok('nexus:platform:health')).agent, false, 'the default runtime\'s row is as before');
  await grant(w, { runtime: 'local-model', model: 'coder:7b' });
  const a = (await w.x.ok('nexus:platform:health')).agent;
  assert.deepEqual([a.kind, a.state, a.label, a.signedIn, 'problem' in a], ['local-model', 'ready', 'Local model (Test)', 'yes', false]);
  w.st.runtimes = [cliRuntime(), localRuntime({ models: [{ name: 'coder:7b', tools: false }] })];
  w.reprobe();
  const b = (await w.x.ok('nexus:platform:health')).agent;
  assert.deepEqual([b.kind, b.problem], ['local-model', 'model_no_tools']);
  assert.equal(b.consent.hostsCount, 1);
  assert.ok(!('hosts' in b.consent));
  assert.doesNotMatch(JSON.stringify(b), /127\.0\.0\.1|coder/);
});

// ---------- LM9: the probe is per kind (the permission is for ONE runtime) ----------

test('LM9 a flagged probe names the live permission\'s own kind (and only it); with no permission it names none and every runtime is checked', async () => {
  const w = await world();
  w.st.honorKinds = true; // the fake runner answers like the real one: only the kinds it is asked for
  const flagged = () => w.runner.sentOf('probe').filter((p) => p.runtimes === true);
  const kindsOfCache = () => w.nx.agentProbe.cache.all().map((e) => e.kind);
  // Before any permission: the setup sheet's probe asks for nothing in particular, so both runtimes are checked (deny-all).
  w.reprobe();
  assert.deepEqual(flagged().at(-1), { op: 'probe', runtimes: true });
  assert.deepEqual(kindsOfCache(), ['cli-agent', 'local-model']);
  // A live local-model permission: every refresh names that kind only, with its own hash; the vendor runtime is not in the answer.
  await grant(w, { runtime: 'local-model', model: 'coder:7b' });
  assert.deepEqual(flagged().at(-1), { op: 'probe', runtimes: true, consentHostsSha256: hostsSha256(LOCAL_HOSTS), kinds: ['local-model'] });
  assert.deepEqual(kindsOfCache(), ['local-model']);
  const since = flagged().length;
  w.reprobe();
  await w.x.ok('nexus:agent:consent', { op: 'revoke' }).then(() => grant(w, { runtime: 'local-model', model: 'coder:7b' }));
  assert.ok(flagged().length > since);
  for (const p of flagged().slice(since).filter((q) => q.consentHostsSha256 !== undefined)) assert.deepEqual(p.kinds, ['local-model'], 'a probe under the permission asks for no other kind');
  // The scheduler's plain probe never carries the flag or a kind.
  w.nx.exec.requestProbe();
  assert.deepEqual(w.runner.sentOf('probe').at(-1).kinds, undefined);
  // Revoked: back to every runtime. A permission for the vendor runtime names that kind and the local server is not asked about.
  await w.x.ok('nexus:agent:consent', { op: 'revoke' });
  assert.deepEqual(flagged().at(-1), { op: 'probe', runtimes: true });
  assert.deepEqual(kindsOfCache(), ['cli-agent', 'local-model']);
  await grant(w);
  assert.deepEqual(flagged().at(-1), { op: 'probe', runtimes: true, consentHostsSha256: hostsSha256(CLI_HOSTS), kinds: ['cli-agent'] });
  assert.deepEqual(kindsOfCache(), ['cli-agent']);
  // The turn still starts: the live permission's own runtime is what the gate reads.
  assert.equal(w.start().job.state, 'queued');
});

// ---------- LM10: a server with no tool-capable model says so ----------

test('LM10 the local runtime\'s "unsupported" health (no model can use tools) reads as the "cannot use tools" sentence, in the start refusal and in #23 and #51', async () => {
  const w = await world({ cfg: { providerDefaultModels: { opencode: 'local/coder:7b' } } });
  await grant(w, { runtime: 'local-model', model: 'coder:7b' });
  const none = [{ name: 'plain:1b', tools: false }];
  w.st.runtimes = [cliRuntime(), localRuntime({ health: { ok: false, reason: 'version_unsupported', detail: 'no installed model supports tool calls' }, models: none })];
  w.reprobe();
  assert.throws(() => w.start(), (e) => e.code === 'unavailable' && e.detail.reason === 'local_model_no_tools'
    && e.message === 'the chosen local model cannot use tools, which agent turns need');
  const a = (await w.x.ok('nexus:platform:health')).agent;
  assert.deepEqual([a.kind, a.state, a.problem], ['local-model', 'version_unsupported', 'model_no_tools']);
  const v = await w.x.ok('nexus:agent:consent', { op: 'get' });
  const row = v.runtimes.find((r) => r.kind === 'local-model');
  assert.deepEqual([row.state, row.problem], ['version_unsupported', 'model_no_tools']);
  assert.match(AGENT_REASON_MESSAGES.local_model_no_tools, /cannot take actions such as reading and changing files/, 'main envelope carries the sentence for that reason');
  // The vendor runtime's "unsupported" is untouched: still a program version.
  const c = await world();
  await grant(c);
  c.st.runtimes = [cliRuntime({ health: { ok: false, reason: 'version_unsupported', detail: 'old' } }), localRuntime()];
  c.reprobe();
  assert.throws(() => c.start(), (e) => e.detail.reason === 'runtime_version_unsupported');
  assert.equal((await c.x.ok('nexus:platform:health')).agent.state, 'version_unsupported');
  assert.equal('problem' in (await c.x.ok('nexus:platform:health')).agent, false);
});
