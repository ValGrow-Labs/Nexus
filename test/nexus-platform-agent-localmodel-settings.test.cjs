'use strict';
// Nexus local-model runtime, main side (Track B), plain node: the settings reader (loopback only, never throws), the shared
// loopback and model-name rules, the runner protocol's model list, the plan builder's `endpoint` (only for the local kind, only
// loopback), the runner's plan check of the endpoint, and the renderer's picker and rows. No database, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const S = loadTs('src/main/nexus/agents/localModelSettings.ts');
const L = loadTs('src/shared/nexus/localModel.ts');
const { parseRunnerMessage } = loadTs('src/shared/nexus/runnerProtocol.ts');
const { buildAgentPlan } = loadTs('src/main/nexus/exec/planBuilder.ts');
const { hostsSha256 } = loadTs('src/main/nexus/agents/budgetService.ts');
const X = loadTs('src/renderer/src/nexus/data/executionModel.ts');
const E = loadTs('src/renderer/src/nexus/data/errorCopy.ts');
const A = loadTs('src/renderer/src/nexus/agent/agentModel.ts');
const ENV = loadTs('src/main/nexusIpc/envelope.ts');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const cfg = (base, model) => () => ({ ...(base === undefined ? {} : { providerBaseUrls: { opencode: base } }), ...(model === undefined ? {} : { providerDefaultModels: { opencode: model } }) });

// ---------- LS1: the settings reader ----------

test('LS1 the reader answers { endpoint, model } for loopback addresses and a local default model, and null for anything else', () => {
  assert.deepEqual(S.localModelSettings({ readConfig: cfg(undefined, 'ollama/coder:7b') }), { endpoint: { host: '127.0.0.1', port: 11434 }, model: 'coder:7b' }, 'no address set: the default');
  assert.deepEqual(S.localModelSettings({ readConfig: cfg('http://127.0.0.1:11434/v1', 'local/coder:7b') }), { endpoint: { host: '127.0.0.1', port: 11434 }, model: 'coder:7b' });
  assert.deepEqual(S.localModelSettings({ readConfig: cfg('http://localhost:11434', 'local/m') }).endpoint, { host: '127.0.0.1', port: 11434 }, 'localhost is the IPv4 loopback address');
  assert.deepEqual(S.localModelSettings({ readConfig: cfg('http://[::1]:8080/v1', 'local/m') }).endpoint, { host: '::1', port: 8080 });
  assert.deepEqual(S.localModelSettings({ readConfig: cfg('http://LOCALHOST:9/x', 'local/m') }).endpoint, { host: '127.0.0.1', port: 9 });
  // The chosen model wins over the settings default; a chosen model needs no default.
  assert.equal(S.localModelSettings({ readConfig: cfg(undefined, 'local/a'), chosenModel: 'b:1' }).model, 'b:1');
  assert.equal(S.localModelSettings({ readConfig: cfg(), chosenModel: 'b:1' }).model, 'b:1');
  // No model anywhere, or a default that is not a local model (a cloud model is never used): no settings, with the reason.
  assert.equal(S.localModelSettings({ readConfig: cfg() }), null);
  assert.equal(S.localModelSettings({ readConfig: cfg(undefined, 'some-cloud/model-x') }), null);
  assert.deepEqual(S.readLocalModelSettings({ readConfig: cfg() }), { ok: false, reason: 'model_missing', endpoint: { host: '127.0.0.1', port: 11434 }, model: null });
});

test('LS1b the reader refuses every non-loopback address and every unusable value, and never throws on bad config', () => {
  const bad = ['http://example.com:11434', 'http://192.168.1.5:11434', 'http://10.0.0.1', 'http://0.0.0.0:11434', 'http://127.0.0.2:11434', 'http://[::]:11434',
    'http://127.0.0.1.example.com:11434', 'http://localhost.example.com', 'http://user:pw@127.0.0.1:11434', 'http://127.0.0.1:11434/?x=1', 'http://127.0.0.1:11434/#f',
    'ftp://127.0.0.1:11434', 'file:///etc/passwd', 'not a url', 'http://', '127.0.0.1:11434', 'http://127.0.0.1:99999', 'http://127.0.0.1:0', 'x'.repeat(400),
    42, {}, [], true];
  for (const v of bad) {
    const r = S.readLocalModelSettings({ readConfig: () => ({ providerBaseUrls: { opencode: v }, providerDefaultModels: { opencode: 'local/m' } }) });
    assert.deepEqual([r.ok, r.reason, r.endpoint], [false, 'endpoint_not_local', null], JSON.stringify(v));
    assert.equal(S.localModelSettings({ readConfig: () => ({ providerBaseUrls: { opencode: v }, providerDefaultModels: { opencode: 'local/m' } }) }), null);
  }
  // Config that throws, is missing, or holds hostile getters / odd shapes: a refusal, never an exception.
  const hostile = [() => { throw new Error('disk'); }, () => null, () => undefined, () => 7, () => 'x', () => [],
    () => ({ get providerBaseUrls() { throw new Error('boom'); } }), () => ({ providerBaseUrls: { get opencode() { throw new Error('boom'); } } }),
    () => ({ providerDefaultModels: { get opencode() { throw new Error('boom'); } } }), () => ({ providerDefaultModels: { opencode: { x: 1 } } }),
    () => ({ providerBaseUrls: null, providerDefaultModels: null })];
  for (const readConfig of hostile) {
    let r;
    assert.doesNotThrow(() => { r = S.readLocalModelSettings({ readConfig }); });
    assert.equal(r.ok, false);
    assert.doesNotThrow(() => S.localModelSettings({ readConfig, chosenModel: undefined }));
  }
  // A hostile model name is never returned.
  for (const m of ['local/../x', 'local/a b', 'local/', 'local/;rm -rf', `local/${'a'.repeat(200)}`, 'local/C:\\x']) assert.equal(S.localModelSettings({ readConfig: cfg(undefined, m) }), null, m);
  assert.equal(S.localModelSettings({ readConfig: cfg(undefined, 'local/m'), chosenModel: '../x' }).model, 'm', 'a chosen name that is not a model name is ignored');
});

test('LS1c the word for the vendor appears only in the settings reader among the main-side Nexus files and the neutral surfaces', () => {
  const WORD = /ollama|qwen|llama/i;
  assert.match(read('src/main/nexus/agents/localModelSettings.ts'), WORD, 'the reader is the one allowed place');
  const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
  const scanned = ['src/main/nexus', 'src/main/nexusIpc', 'src/shared/nexus', 'src/renderer/src/nexus'].flatMap(walk)
    .filter((f) => /\.(ts|tsx|css)$/.test(f) && f !== 'src/main/nexus/agents/localModelSettings.ts' && !f.startsWith('src/renderer/src/nexus/agents/') && !f.startsWith('src/renderer/src/nexus/hairline/'));
  assert.ok(scanned.length > 200, 'the walk sees the Nexus code');
  const hits = scanned.flatMap((f) => read(f).split(/\r?\n/).map((l, i) => [f, i + 1, l]).filter(([, , l]) => WORD.test(l)).map(([ff, n, l]) => `${ff}:${n}: ${l.trim()}`));
  assert.deepEqual(hits, []);
});

// ---------- LS2: the shared rules ----------

test('LS2 loopback hosts, endpoints, model names and the model problem are exact', () => {
  assert.equal(L.LOCAL_MODEL_KIND, 'local-model');
  for (const [i, o] of [['127.0.0.1', '127.0.0.1'], ['localhost', '127.0.0.1'], [' LocalHost ', '127.0.0.1'], ['::1', '::1'], ['[::1]', '::1']]) assert.equal(L.normalizeLoopbackHost(i), o, i);
  for (const x of ['127.0.0.2', '0.0.0.0', 'example.com', '::', '', 'localhost.', '127.0.0.1.nip.io', null, 7, undefined]) assert.equal(L.normalizeLoopbackHost(x), null, String(x));
  assert.deepEqual(L.loopbackEndpoint({ host: 'localhost', port: 11434 }), { host: '127.0.0.1', port: 11434 });
  for (const x of [{ host: 'example.com', port: 1 }, { host: '127.0.0.1', port: 0 }, { host: '127.0.0.1', port: 65536 }, { host: '127.0.0.1', port: 1.5 }, { host: '127.0.0.1', port: '1' },
    { host: '127.0.0.1' }, null, [], 'x']) assert.equal(L.loopbackEndpoint(x), null, JSON.stringify(x));
  for (const ok of ['coder:7b', 'qwen2.5-coder:7b', 'library/x:latest', 'hf.co/u/m:Q4_K_M', 'a', 'M_1.5']) assert.equal(L.isModelName(ok), true, ok);
  for (const bad of ['', ' a', 'a b', '../x', 'a..b', '/abs', 'C:\\x', 'a\0b', '-x', '.x', 'a'.repeat(129), 7, null]) assert.equal(L.isModelName(bad), false, String(bad));
  assert.equal(L.modelProblem(undefined, 'a'), 'local_model_missing');
  assert.equal(L.modelProblem([], 'a'), 'local_model_missing');
  assert.equal(L.modelProblem([{ name: 'a', tools: false }], 'a'), 'local_model_no_tools');
  assert.equal(L.modelProblem([{ name: 'a', tools: true }], 'a'), null);
  assert.equal(L.modelProblem([{ name: 'a', tools: true }], null), 'local_model_missing');
});

// ---------- LS3: the runner protocol ----------

const probeMsg = (setup) => ({ op: 'probe.result', freeBytes: null, images: [], probe: { docker: 'missing', gpu: { detected: false, usableInContainers: false } },
  runtimes: [{ kind: 'local-model', health: { ok: true, version: '0.5.0' }, ...(setup === undefined ? {} : { setup }) }] });
const SETUP = { signedIn: 'yes', flagsOk: true, label: 'Local model (Test)', egressHosts: [{ host: '127.0.0.1', port: 11434 }] };

test('LS3 the probe\'s model list passes the validator (names, tool flags, bounded) and nothing else does', () => {
  const ok = (setup) => parseRunnerMessage(probeMsg(setup));
  assert.ok(ok(SETUP), 'a setup without models is as before');
  assert.deepEqual(ok({ ...SETUP, models: [{ name: 'coder:7b', tools: true }, { name: 'plain:1b', tools: false }] }).runtimes[0].setup.models, [{ name: 'coder:7b', tools: true }, { name: 'plain:1b', tools: false }]);
  assert.ok(ok({ ...SETUP, models: [] }));
  assert.equal(ok({ ...SETUP, egressHosts: [{ host: '127.0.0.1', port: 11434 }] }).runtimes[0].setup.egressHosts[0].host, '127.0.0.1', 'a loopback host is a valid egress host entry');
  const bad = [{ models: 'x' }, { models: [{ name: 'a' }] }, { models: [{ tools: true }] }, { models: [{ name: 'a', tools: 1 }] }, { models: [{ name: '../x', tools: true }] },
    { models: [{ name: 'a b', tools: true }] }, { models: [{ name: 'a', tools: true, extra: 1 }] }, { models: Array.from({ length: 65 }, (_, i) => ({ name: `m${i}`, tools: true })) },
    { models: [{ name: 'a'.repeat(129), tools: true }] }, { models: null }, { modelz: [] }];
  for (const b of bad) assert.equal(ok({ ...SETUP, ...b }), null, JSON.stringify(b).slice(0, 80));
  assert.ok(ok({ ...SETUP, models: Array.from({ length: 64 }, (_, i) => ({ name: `m${i}`, tools: true })) }), '64 is the bound');
});

// ---------- LS4: the plan ----------

const HOSTS = [{ host: '127.0.0.1', port: 11434 }];
const ctx = (runtime = {}) => ({ job: { id: 'J'.repeat(26), projectId: 'P' }, attempt: { id: 'A'.repeat(26), n: 1 }, bootId: 'B'.repeat(26), dataHomeRoot: path.join(require('node:os').tmpdir(), 'nexus-lm-plan'),
  workRel: 'work/J/1', logRel: 'logs/jobs/J/1.log',
  profile: { id: 'sde-node', image: { repository: 'nexus/sde-node', digest: `sha256:${'7'.repeat(64)}` }, user: { uid: 10001, gid: 10001 },
    defaults: { cpus: 1, memoryMb: 1024, pids: 512, wallClockMs: 60000, outputMaxBytes: 2 ** 20, tmpfsMb: 512 }, entrypoint: ['/opt/nexus/entry'], imageEnv: ['PATH', 'HOME', 'LANG'] },
  imageId: `sha256:${'1'.repeat(64)}`, worktree: { relPath: `wt/${'a'.repeat(26)}`, gitDir: 'g', ref: 'refs/nexus/job/x', base: 'b'.repeat(40) },
  runtime: { kind: 'local-model', token: `${'a'.repeat(22)}.${'b'.repeat(43)}`, sessionId: 'S', idempotencyKey: 'k', domainId: 'sde', skills: [], context: { hash: 'c'.repeat(64) },
    message: 'hi', mcpUrl: 'http://127.0.0.1:1/mcp', model: { provider: 'local-model', model: 'coder:7b' }, ...runtime },
  egress: { allow: HOSTS, consentHostsSha256: hostsSha256(HOSTS) }, caps: { turnTokens: 1, turnUsdCents: 2, dayRemainingUsdCents: 3, toolCalls: 4 }, wallClockMs: 60_000, mcpTools: ['context_get'] });
test('LS4 the plan carries `endpoint` only when main gives one, and only a loopback one; without it the request has no such key', () => {
  const withEp = buildAgentPlan(ctx({ endpoint: { host: '127.0.0.1', port: 11434 } }));
  assert.deepEqual(withEp.runtime.request.endpoint, { host: '127.0.0.1', port: 11434 });
  assert.deepEqual(withEp.runtime.request.model, { provider: 'local-model', model: 'coder:7b' });
  const without = buildAgentPlan(ctx({ kind: 'cli-agent', model: { provider: 'runtime-owned', model: 'default' } }));
  assert.equal('endpoint' in without.runtime.request, false);
  assert.deepEqual(without.runtime.request.model, { provider: 'runtime-owned', model: 'default' });
  assert.equal(JSON.stringify(Object.keys(without.runtime.request)), JSON.stringify(['jobId', 'attempt', 'sessionId', 'idempotencyKey', 'domainId', 'skills', 'context', 'message', 'worktree', 'container', 'mcp', 'model', 'limits', 'credential', 'configDir']),
    'the CLI kind\'s request has exactly the keys it always had');
  for (const ep of [{ host: 'example.com', port: 11434 }, { host: '10.0.0.1', port: 1 }, { host: '127.0.0.1', port: 0 }, {}, { host: '127.0.0.1' }]) {
    assert.throws(() => buildAgentPlan(ctx({ endpoint: ep })), (e) => e.code === 'invalid' && e.detail.reason === 'bad_input', JSON.stringify(ep));
  }
});

// ---------- LS5: the renderer ----------

const opt = (o = {}) => ({ kind: 'cli-agent', label: 'Test Engine', version: '1', state: 'ready', signedIn: 'yes', selected: false, models: null, model: null, problem: null, hosts: ['cli.example.com:443'], ...o });
const localOpt = (o = {}) => opt({ kind: 'local-model', label: 'Local model (Test)', models: [{ name: 'coder:7b', tools: true }, { name: 'plain:1b', tools: false }], model: null, problem: 'model_not_chosen', hosts: ['127.0.0.1:11434'], ...o });
const view = (runtimes, live = false) => ({ runtimes, consent: { live, caps: null, hostsCount: 0, grantedAt: null, hosts: [] } });

test('LS5 the picker rows: one per runtime, labels from the probe, a model list that disables tool-less models, a button that needs a usable choice', () => {
  assert.deepEqual(X.runtimeChoices(null), []);
  assert.deepEqual(X.runtimeChoices(view([opt()])), [], 'one default runtime: the sheet is as it was');
  assert.deepEqual(X.runtimeChoices({ consent: { live: false } }), []);
  const rows = X.runtimeChoices(view([opt(), localOpt()]));
  assert.deepEqual(rows.map((r) => r.label), ['Test Engine', 'Local model (Test)']);
  const [cli, local] = rows;
  assert.deepEqual([cli.models, cli.model, cli.action.op, cli.action.label, cli.action.disabled, cli.destination], [null, null, 'grant', 'Use this runtime', false, 'cli.example.com:443']);
  assert.deepEqual(local.models, [{ name: 'coder:7b', label: 'coder:7b', disabled: false }, { name: 'plain:1b', label: 'plain:1b (cannot use tools)', disabled: true }]);
  assert.equal(local.action.disabled, true, 'no model is chosen yet');
  assert.equal(local.text, 'No local model is chosen yet. Choose one in Setup.');
  assert.equal(local.state, 'problem');
  // Picking a model that can use tools readies the button; one that cannot does not.
  const picked = X.runtimeChoices(view([opt(), localOpt()]), { 'local-model': 'coder:7b' })[1];
  assert.deepEqual([picked.model, picked.action.disabled, picked.state], ['coder:7b', false, 'ok']);
  assert.equal(picked.text, 'The local model server is running and the chosen model can use tools.');
  assert.equal(X.runtimeChoices(view([opt(), localOpt()]), { 'local-model': 'plain:1b' })[1].action.disabled, true);
  assert.equal(X.runtimeChoices(view([opt(), localOpt()]), { 'local-model': 'unknown:1b' })[1].model, null, 'a name the list does not hold is ignored');
  // With a permission live the button switches; the runtime in use has none.
  const live = X.runtimeChoices(view([opt({ selected: true }), localOpt({ model: 'coder:7b', problem: null })], true));
  assert.deepEqual([live[0].action, live[0].word, live[0].text.startsWith('In use.')], [null, 'In use', true]);
  assert.deepEqual([live[1].action.op, live[1].action.label, live[1].action.disabled], ['switch', 'Switch to this runtime', false]);
  // A local-only list still shows the picker (it has models to choose from).
  assert.equal(X.runtimeChoices(view([localOpt()])).length, 1);
});

test('LS5b the fixed sentences: server not running, model missing, model cannot use tools, address not on this computer', () => {
  const sentence = (o) => X.runtimeChoices(view([opt(), localOpt(o)]))[1].text;
  assert.equal(sentence({ state: 'not_installed', models: [], problem: null }), 'The local model server is not running on this computer. Start it, then check again in Setup.');
  assert.equal(sentence({ problem: 'model_missing', model: 'gone:1b' }), 'The chosen local model is not installed on this computer. Choose another in Setup.');
  assert.equal(sentence({ problem: 'model_no_tools', model: 'plain:1b' }), 'The chosen local model cannot use tools, which agent turns need. Choose another in Setup.');
  assert.equal(sentence({ problem: 'address_not_local', model: 'coder:7b' }), 'The local model address is not on this computer, or is not the one that was given permission. Check it in Setup.');
  assert.equal(X.runtimeChoices(view([opt(), localOpt({ state: 'not_installed', models: [], problem: null })]))[1].action.disabled, true);
  // A sentence for every problem word, equal to main's words for the same reason, and no raw code or vendor word in any.
  const MAIN = { model_not_chosen: 'local_model_not_chosen', address_not_local: 'local_model_endpoint', model_missing: 'local_model_missing', model_no_tools: 'local_model_no_tools' };
  for (const [problem, reason] of Object.entries(MAIN)) assert.equal(X.LOCAL_PROBLEM_TEXT[problem], ENV.AGENT_REASON_MESSAGES[reason], problem);
  for (const k of L.LOCAL_MODEL_REASONS.concat(['turn_live', 'bad_model'])) {
    assert.equal(E.AGENT_REASON_TEXT[k], ENV.AGENT_REASON_MESSAGES[k], `${k} reads as main words it`);
    assert.equal(E.errorCopy('invalid', k).text, ENV.AGENT_REASON_MESSAGES[k], k);
    assert.equal(A.agentFailText({ code: 'invalid', reason: k }).startsWith(E.AGENT_REASON_TEXT[k]), true, k);
  }
});

const agentRow = (o = {}) => ({ state: 'ready', label: 'Local model (Test)', version: '0.5.0', signedIn: 'yes', flagsOk: true, kind: 'local-model',
  consent: { live: false, caps: null, hostsCount: 0, grantedAt: null }, usageToday: { usdCents: 0, turns: 0, estimated: false }, ...o });

test('LS6 the setup rows of the local kind say what is true of it (no program, no sign-in, no proxy); every other kind\'s rows are as before', () => {
  const rows = X.agentSetupRows(agentRow(), { hosts: ['127.0.0.1:11434'] });
  assert.deepEqual([rows[0].label, rows[0].state, rows[0].text], ['Local model (Test)', 'ok', 'The local model server is running and the chosen model can use tools (version 0.5.0).']);
  assert.match(rows[1].text, /^Not granted\. Granting lets Nexus use the local model only at 127\.0\.0\.1:11434\./);
  assert.equal(rows[1].action, X.LOCAL_MODEL_DISCLOSURE);
  assert.doesNotMatch(rows.map((r) => `${r.text} ${r.action ?? ''}`).join(' '), /signed in|proxy|program/i);
  assert.equal(X.agentSetupRows(agentRow({ state: 'not_installed' }))[0].text, E.AGENT_REASON_TEXT.local_model_server_down);
  assert.equal(X.agentSetupRows(agentRow({ problem: 'model_no_tools' }))[0].text, E.AGENT_REASON_TEXT.local_model_no_tools);
  const live = X.agentSetupRows(agentRow({ consent: { live: true, caps: null, hostsCount: 1, grantedAt: 1 } }), { hosts: ['127.0.0.1:11434'], fmt: () => '10:00' });
  assert.match(live[1].text, /^Granted at 10:00\. Nexus may use the local model only at 127\.0\.0\.1:11434\./);
  assert.deepEqual(live[1].consent, { op: 'revoke', label: 'Revoke permission' });
  // Without `kind` (every other runtime) the rows are the ones they always were.
  const cli = X.agentSetupRows(agentRow({ kind: undefined, label: 'Acme Agent' }), { hosts: ['cli.example.com:443'] });
  assert.equal(cli[0].text, 'The agent program is installed and signed in (version 0.5.0).');
  assert.match(cli[1].text, /^Not granted\. Granting lets Nexus’s proxy allow the agent only cli\.example\.com:443\. Agent turns need it\./);
  assert.equal(cli[1].action, X.AGENT_STATE_DISCLOSURE);
});

test('LS6b the agent panel words the local runtime\'s problems and nothing else changes', () => {
  const h = (agent) => ({ db: { version: 10, platform: true, handoffs: true, execution: true, subReason: null }, agent });
  const blockers = (agent) => A.agentPanelModel({ health: h(agent), availability: { kind: 'ready', advisories: [] }, sessions: [], sessionsFail: null }).blockers;
  assert.deepEqual(blockers(agentRow({ state: 'not_installed' })), [E.AGENT_REASON_TEXT.local_model_server_down]);
  assert.deepEqual(blockers(agentRow({ problem: 'model_missing', consent: { live: true, caps: null, hostsCount: 1, grantedAt: 1 } })), [E.AGENT_REASON_TEXT.local_model_missing]);
  assert.deepEqual(blockers(agentRow({ kind: undefined, state: 'not_installed' })), [E.AGENT_REASON_TEXT.runtime_not_installed], 'another runtime keeps its own sentence');
});

test('LS7 the sheet and the model add no vendor word, no host and no code to their copy; the picker is shown only from the model\'s rows', () => {
  const VENDOR = /claude|anthropic|hermes|sonnet|opus|haiku|openai|gpt-|ollama|qwen|llama/i;
  for (const f of ['src/renderer/src/nexus/components/ExecutionSetupSheet.tsx', 'src/renderer/src/nexus/data/executionModel.ts', 'src/renderer/src/nexus/data/errorCopy.ts',
    'src/renderer/src/nexus/data/useAgents.ts', 'src/renderer/src/nexus/agent/agentModel.ts', 'src/shared/nexus/localModel.ts', 'src/main/nexusIpc/agentSetup.ts']) {
    const hits = read(f).split(/\r?\n/).filter((l) => VENDOR.test(l));
    assert.deepEqual(hits, [], f);
  }
  const sheet = read('src/renderer/src/nexus/components/ExecutionSetupSheet.tsx');
  assert.match(sheet, /runtimeChoices\(consent\.view, picked\)/);
  assert.match(sheet, /consent\.send\(/);
  assert.doesNotMatch(sheet, /127\.0\.0\.1|localhost|:11434/);
});
