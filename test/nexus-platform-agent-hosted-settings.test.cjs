'use strict';
// Nexus hosted-model runtime, main + renderer models (Track HB), plain node: the key store with a fake safeStorage, the key IPC handlers,
// the shared rules, the plan builder's `apiKey`, parity with the runner's own sentences and key rule, the fixed sentences in main and the
// renderer, the picker and Settings models, and the neutral-copy scans. No database, no network, no real key.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const S = loadTs('src/main/nexus/agents/hostedModelSettings.ts');
const H = loadTs('src/shared/nexus/hostedModel.ts');
const P = loadTs('src/shared/nexus/runnerProtocol.ts');
const { buildAgentPlan } = loadTs('src/main/nexus/exec/planBuilder.ts');
const { hostsSha256 } = loadTs('src/main/nexus/agents/budgetService.ts');
const X = loadTs('src/renderer/src/nexus/data/executionModel.ts');
const E = loadTs('src/renderer/src/nexus/data/errorCopy.ts');
const A = loadTs('src/renderer/src/nexus/agent/agentModel.ts');
const K = loadTs('src/renderer/src/nexus/data/hostedKeysModel.ts');
const ENV = loadTs('src/main/nexusIpc/envelope.ts');
const MSG = loadTs('src/runner/runtimes/hostedModel/messages.ts').MSG;

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const KEY = 'TESTKEY-alpha-0123456789abcdef-ZZ';
const PROVIDERS = [
  { id: 'alpha', label: 'Alpha (free key)', hosts: ['alpha.example.com'], models: [{ name: 'a-big', tools: true }, { name: 'a-plain', tools: false }] },
  { id: 'beta', label: 'Beta (free key)', hosts: ['beta.example.com'], models: [{ name: 'b-fast', tools: true }] }
];

function fakeStore(o = {}) {
  const st = { available: o.available ?? true, blob: {}, failSet: false };
  const enc = (s) => Buffer.from(s, 'utf8').map((b) => b ^ 0x5a).toString('base64');
  const dec = (s) => Buffer.from(Buffer.from(s, 'base64').map((b) => b ^ 0x5a)).toString('utf8');
  return Object.assign(st, {
    encryptionAvailable: () => st.available,
    set(ref, v) { if (!st.available || st.failSet) return { ok: false, error: `could not store ${v}` }; st.blob[ref] = enc(v); return { ok: true }; },
    get(ref) { return st.blob[ref] === undefined ? undefined : dec(st.blob[ref]); },
    has(ref) { return st.blob[ref] !== undefined; },
    delete(ref) { delete st.blob[ref]; }
  });
}
const keysOver = (store, o = {}) => S.createHostedKeys({ store, providers: () => (o.providers === undefined ? PROVIDERS : o.providers), onChange: o.onChange });

// ---------- HS1: the key store ----------

test('HS1 a key is stored only in the encrypted store under config:hosted:<provider>, shape-checked, never plaintext, never returned', () => {
  const store = fakeStore();
  const seen = [];
  const keys = keysOver(store, { onChange: (op, p) => seen.push([op, p]) });
  assert.equal(S.hostedKeyRef('alpha'), 'config:hosted:alpha');
  assert.deepEqual(keys.set('alpha', `  ${KEY}\n`), { ok: true }, 'surrounding whitespace is dropped');
  assert.deepEqual(Object.keys(store.blob), ['config:hosted:alpha']);
  assert.equal(JSON.stringify(store.blob).includes(KEY), false, 'the store holds ciphertext');
  assert.equal(keys.resolve('alpha'), KEY);
  assert.equal(keys.present('alpha'), true);
  assert.equal(keys.present('beta'), false);
  assert.deepEqual(seen, [['set', 'alpha']], 'the audit hook gets the provider id and the operation only');
  assert.deepEqual(keys.list(), { ok: true, providers: [{ id: 'alpha', label: 'Alpha (free key)', present: true }, { id: 'beta', label: 'Beta (free key)', present: false }] });
  assert.equal(JSON.stringify(keys.list()).includes(KEY), false);
  assert.deepEqual(keys.delete('alpha'), { ok: true });
  assert.deepEqual(keys.delete('alpha'), { ok: true }, 'idempotent');
  assert.equal(keys.present('alpha'), false);
  assert.equal(keys.resolve('alpha'), null);
  assert.deepEqual(seen, [['set', 'alpha'], ['delete', 'alpha'], ['delete', 'alpha']]);
});

test('HS1b a key that is not printable ASCII of 8..512 characters, or for an unlisted provider, is refused with a fixed sentence that never holds the key', () => {
  const store = fakeStore();
  const keys = keysOver(store);
  const bad = ['', 'short', 'a'.repeat(7), 'a'.repeat(513), 'has space inside key', 'tab\tinside-key-1234', 'ünïcode-key-1234567', 'new\nline-key-12345', '\u0000nul-key-12345678', 7, null, {}, 'x'.repeat(5000)];
  for (const k of bad) {
    const r = keys.set('alpha', k);
    assert.deepEqual([r.ok, r.reason, r.message], [false, 'bad_key', S.KEY_REFUSAL_TEXT.bad_key], JSON.stringify(k).slice(0, 30));
  }
  assert.equal(keys.set('alpha', 'a'.repeat(8)).ok, true);
  assert.equal(keys.set('alpha', 'a'.repeat(512)).ok, true);
  for (const p of ['gamma', 'Alpha', '', null, 7, '../x', 'a b']) assert.equal(keys.set(p, KEY).ok, false, String(p));
  assert.equal(keys.set('gamma', KEY).reason, 'bad_provider');
  assert.equal(keysOver(store, { providers: null }).set('alpha', KEY).reason, 'providers_unknown');
  assert.equal(keysOver(store, { providers: [] }).list().ok, false);
  assert.equal(P.isRuntimeApiKey(KEY) && H.isApiKeyShape(KEY), true);
  assert.equal(H.API_KEY_RE.source, P.RUNTIME_API_KEY_RE.source, 'the renderer\'s shape rule is the protocol\'s');
  for (const k of ['a'.repeat(7), 'a b' + 'c'.repeat(8), 'é' + 'c'.repeat(8)]) assert.equal(H.isApiKeyShape(k), P.isRuntimeApiKey(k));
});

test('HS1c without safeStorage nothing is stored (never plaintext); a store that fails or throws answers a fixed refusal, and no text carries the key', () => {
  const noEnc = fakeStore({ available: false });
  const r = keysOver(noEnc).set('alpha', KEY);
  assert.deepEqual([r.ok, r.reason, r.message], [false, 'encryption_unavailable', S.KEY_REFUSAL_TEXT.encryption_unavailable]);
  assert.deepEqual(noEnc.blob, {});
  const failing = fakeStore(); failing.failSet = true;
  const f = keysOver(failing).set('alpha', KEY);
  assert.deepEqual([f.ok, f.reason], [false, 'store_failed']);
  const throwing = { encryptionAvailable: () => true, set: () => { throw new Error(`disk ${KEY}`); }, get: () => { throw new Error(KEY); }, has: () => { throw new Error(KEY); }, delete: () => { throw new Error(KEY); } };
  const t = keysOver(throwing);
  for (const out of [t.set('alpha', KEY), t.delete('alpha'), t.list(), { p: t.present('alpha') }, { r: t.resolve('alpha') }]) assert.equal(JSON.stringify(out).includes(KEY), false);
  assert.equal(t.present('alpha'), false);
  assert.equal(t.resolve('alpha'), null);
  assert.equal(JSON.stringify(S.KEY_REFUSAL_TEXT).includes('config:'), false);
  // A stored value that is not of the accepted shape is never handed on.
  const odd = fakeStore(); odd.blob['config:hosted:alpha'] = Buffer.from('short', 'utf8').map((b) => b ^ 0x5a).toString('base64');
  assert.equal(keysOver(odd).resolve('alpha'), null);
  // An audit hook that throws never fails a key change.
  assert.equal(keysOver(fakeStore(), { onChange: () => { throw new Error('x'); } }).set('alpha', KEY).ok, true);
});

// ---------- HS2: the key IPC ----------

test('HS2 the key IPC handlers: owner only, exact payloads, booleans and fixed sentences back, never a key', () => {
  const store = fakeStore();
  let owner = true;
  const hs = S.hostedKeyHandlers({ keys: keysOver(store), authorize: () => { if (!owner) throw new Error('denied'); return true; } });
  assert.deepEqual(hs.set({ provider: 'alpha', key: KEY }), { ok: true });
  assert.deepEqual(hs.present(), { ok: true, providers: [{ id: 'alpha', label: 'Alpha (free key)', present: true }, { id: 'beta', label: 'Beta (free key)', present: false }] });
  assert.deepEqual(hs.present({ provider: 'alpha' }), { ok: true, present: true });
  assert.deepEqual(hs.present({ provider: 'beta' }), { ok: true, present: false });
  for (const bad of [null, undefined, 'x', [], { provider: 'alpha' }, { key: KEY }, { provider: 7, key: KEY }, { provider: 'alpha', key: 7 }, { provider: 'alpha', key: KEY, extra: 1 }]) {
    const r = hs.set(bad);
    assert.deepEqual([r.ok, r.reason], [false, 'bad_request'], JSON.stringify(bad));
  }
  assert.equal(hs.delete({ provider: 'alpha', x: 1 }).reason, 'bad_request');
  assert.equal(hs.present({ provider: 7 }).reason, 'bad_request');
  assert.equal(hs.present({}).reason, 'bad_request');
  owner = false;
  assert.equal(hs.set({ provider: 'beta', key: KEY }).reason, 'not_allowed');
  assert.equal(hs.delete({ provider: 'alpha' }).reason, 'not_allowed');
  assert.equal(store.has('config:hosted:alpha'), true, 'a refused delete changed nothing');
  assert.equal(store.has('config:hosted:beta'), false);
  // A payload whose read throws is a bad request, not an exception.
  const hostile = new Proxy({}, { ownKeys() { throw new Error('boom'); } });
  assert.equal(hs.set(hostile).reason, 'bad_request');
  assert.equal(JSON.stringify([hs.present(), hs.set({ provider: 'alpha', key: 'x' })]).includes(KEY), false);
});

test('HS2b main registers the three key channels over the store, the audit hook and the owner check; the preload forwards them and nothing reads a key back', () => {
  const main = read('src/main/index.ts');
  assert.match(main, /ipcMain\.handle\('hostedKey:set', \(_evt, payload: unknown\) => hostedKeyIpc\.set\(payload\)\)/);
  assert.match(main, /ipcMain\.handle\('hostedKey:delete'/);
  assert.match(main, /ipcMain\.handle\('hostedKey:present'/);
  assert.match(main, /store: \{ encryptionAvailable: integrations\.encryptionAvailable, set: integrations\.setSecret, get: integrations\.getSecret, has: integrations\.hasSecret, delete: integrations\.deleteSecret \}/);
  assert.match(main, /nx\.budget\.requireOwner\(nx\.principals\.localUser\(\)\)/);
  assert.match(main, /hostedKeys\n?\s*\}\)/, 'the platform gets the keys');
  assert.equal((main.match(/hostedKeys\.resolve/g) || []).length, 0, 'main\'s entry point never resolves a key itself');
  const pre = read('src/preload/index.ts');
  for (const m of ['hostedKeySet', 'hostedKeyDelete', 'hostedKeyPresent']) assert.match(pre, new RegExp(`${m}:`));
  assert.equal(/hostedKey[A-Za-z]*: \([^)]*\): Promise<[^>]*\bkey\b/.test(pre.replace(/req: \{ provider: string; key: string \}/, '')), false, 'no answer type carries a key');
  // The only reader of a stored key is the agent service's lease step; views and IPC never call `resolve`.
  for (const f of ['src/main/nexusIpc/registerNexusIpc.ts', 'src/main/nexusIpc/agentSetup.ts', 'src/main/nexusIpc/dto.ts']) assert.doesNotMatch(read(f), /\.resolve\(/, f);
  assert.match(read('src/main/nexus/agents/agentService.ts'), /this\.deps\.hostedKeys\?\.resolve\(hp\.provider!\)/);
});

// ---------- HS3: the shared rules ----------

test('HS3 provider ids, the choice problem and the runner sentence mapping are exact; the mapping equals the runner\'s own sentences', () => {
  for (const ok of ['alpha', 'a', 'a-1', 'x'.repeat(32)]) assert.equal(H.isProviderId(ok), true, ok);
  for (const bad of ['', 'Alpha', '1a', 'a b', 'a_b', '-a', 'x'.repeat(33), '../x', 7, null]) assert.equal(H.isProviderId(bad), false, String(bad));
  assert.equal(H.HOSTED_MODEL_KIND, 'hosted-model');
  const p = H.hostedChoiceProblem;
  assert.equal(p(PROVIDERS, null, null), 'hosted_provider_not_chosen');
  assert.equal(p(PROVIDERS, 'alpha', null), 'hosted_provider_not_chosen');
  assert.equal(p(PROVIDERS, 'gamma', 'a-big'), 'hosted_provider_not_chosen');
  assert.equal(p(undefined, 'alpha', 'a-big'), 'hosted_provider_not_chosen');
  assert.equal(p(PROVIDERS, 'alpha', 'b-fast'), 'hosted_model_unavailable');
  assert.equal(p(PROVIDERS, 'alpha', 'a-plain'), 'hosted_model_unavailable');
  assert.equal(p(PROVIDERS, 'alpha', 'a-big'), null);
  assert.deepEqual(S.hostedChoice({ providers: PROVIDERS, chosen: { provider: 'beta', model: 'b-fast' } }), { ok: true, provider: 'beta', model: 'b-fast' });
  assert.equal(S.hostedChoice({ providers: PROVIDERS, chosen: { provider: 'beta', model: 'a-big' } }).reason, 'hosted_model_unavailable');
  // The runner's sentences, as main maps them.
  assert.deepEqual(Object.keys(H.HOSTED_RUNNER_MESSAGE_REASON).sort(), [MSG.keyMissing, MSG.keyRejected, MSG.rateLimited, MSG.quotaExhausted, MSG.modelUnavailable, MSG.notChosen].sort());
  assert.equal(H.hostedReasonOfMessage(MSG.keyRejected), 'hosted_key_rejected');
  assert.equal(H.hostedReasonOfMessage(MSG.quotaExhausted), 'hosted_quota_exhausted');
  assert.equal(H.hostedReasonOfMessage(MSG.rateLimited), 'hosted_rate_limited');
  assert.equal(H.hostedReasonOfMessage(MSG.keyMissing), 'hosted_key_missing');
  assert.equal(H.hostedReasonOfMessage(MSG.modelUnavailable), 'hosted_model_unavailable');
  assert.equal(H.hostedReasonOfMessage(MSG.notChosen), 'hosted_provider_not_chosen');
  for (const m of [MSG.unreachable, MSG.server(500), 'x', null, 7, `${MSG.keyRejected} extra`, '__proto__', 'constructor']) assert.equal(H.hostedReasonOfMessage(m), null, String(m));
});

test('HS3b the probe\'s providers (Track A\'s shape) pass the runner protocol validator; hostile ones do not', () => {
  const msg = (providers) => ({ op: 'probe.result', freeBytes: null, images: [], probe: { docker: 'missing', gpu: { detected: false, usableInContainers: false } },
    runtimes: [{ kind: 'hosted-model', health: { ok: true, version: 'presets-1' }, setup: { signedIn: 'unknown', flagsOk: true, label: 'Hosted (Test)',
      egressHosts: [{ host: 'alpha.example.com', port: 443 }], providers } }] });
  const parsed = P.parseRunnerMessage(msg(PROVIDERS));
  assert.deepEqual(parsed.runtimes[0].setup.providers, PROVIDERS);
  for (const bad of [[{ ...PROVIDERS[0], id: 'Alpha' }], [{ ...PROVIDERS[0], hosts: [] }], [{ ...PROVIDERS[0], extra: 1 }], 'x']) assert.equal(P.parseRunnerMessage(msg(bad)), null, JSON.stringify(bad).slice(0, 50));
});

// ---------- HS4: the plan builder ----------

const HOSTS = [{ host: 'alpha.example.com', port: 443 }, { host: 'beta.example.com', port: 443 }];
const ctx = (runtime = {}) => ({ job: { id: 'J'.repeat(26), projectId: 'P' }, attempt: { id: 'A'.repeat(26), n: 1 }, bootId: 'B'.repeat(26), dataHomeRoot: path.join(require('node:os').tmpdir(), 'nexus-hm-plan'),
  workRel: 'work/J/1', logRel: 'logs/jobs/J/1.log',
  profile: { id: 'sde-node', image: { repository: 'nexus/sde-node', digest: `sha256:${'7'.repeat(64)}` }, user: { uid: 10001, gid: 10001 },
    defaults: { cpus: 1, memoryMb: 1024, pids: 512, wallClockMs: 60000, outputMaxBytes: 2 ** 20, tmpfsMb: 512 }, entrypoint: ['/opt/nexus/entry'], imageEnv: ['PATH', 'HOME', 'LANG'] },
  imageId: `sha256:${'1'.repeat(64)}`, worktree: { relPath: `wt/${'a'.repeat(26)}`, gitDir: 'g', ref: 'refs/nexus/job/x', base: 'b'.repeat(40) },
  runtime: { kind: 'hosted-model', token: `${'a'.repeat(22)}.${'b'.repeat(43)}`, sessionId: 'S', idempotencyKey: 'k', domainId: 'sde', skills: [], context: { hash: 'c'.repeat(64) },
    message: 'hi', mcpUrl: 'http://127.0.0.1:1/mcp', model: { provider: 'alpha', model: 'a-big' }, ...runtime },
  egress: { allow: HOSTS, consentHostsSha256: hostsSha256(HOSTS) }, caps: { turnTokens: 1, turnUsdCents: 2, dayRemainingUsdCents: 3, toolCalls: 4 }, wallClockMs: 60_000, mcpTools: ['context_get'] });

test('HS4 the plan carries the key in plan.runtime.apiKey only (hosted kind, accepted shape); the request and every record built from the plan hold none; other kinds are unchanged', () => {
  const plan = buildAgentPlan(ctx({ apiKey: KEY }));
  assert.equal(plan.runtime.apiKey, KEY);
  assert.deepEqual(plan.runtime.request.model, { provider: 'alpha', model: 'a-big' });
  assert.equal(JSON.stringify(plan.runtime.request).includes(KEY), false);
  const rest = { ...plan, runtime: { kind: plan.runtime.kind, request: plan.runtime.request, token: plan.runtime.token } };
  assert.equal(JSON.stringify(rest).includes(KEY), false);
  const records = JSON.stringify([require_('agentSandboxRecord')(plan, { adapterVersion: 'v', flagsSha256: null }), require_('agentEnvironmentRecord')(plan, { runtimeVersion: 'v', nexusVersion: 'n', dockerVersion: 'd', runnerBootId: 'b' })]);
  assert.equal(records.includes(KEY), false, 'the sandbox and environment records are built without the key');
  assert.equal('apiKey' in buildAgentPlan(ctx()).runtime, false, 'no key given: no field');
  assert.equal('apiKey' in buildAgentPlan(ctx({ kind: 'cli-agent', model: { provider: 'runtime-owned', model: 'default' } })).runtime, false);
  for (const bad of ['short', 'has space inside', 'é-key-1234567', 'x'.repeat(513), '', 7]) {
    assert.throws(() => buildAgentPlan(ctx({ apiKey: bad })), (e) => e.code === 'invalid' && e.detail.reason === 'bad_input' && (String(bad).length < 5 || !String(e.message).includes(String(bad))), String(bad));
  }
  for (const kind of ['cli-agent', 'local-model']) assert.throws(() => buildAgentPlan(ctx({ kind, apiKey: KEY })), (e) => e.detail.reason === 'bad_input' && !e.message.includes(KEY), kind);
  assert.equal(P.isRuntimeApiKey(plan.runtime.apiKey), true);
});
function require_(name) { return loadTs('src/main/nexus/exec/planBuilder.ts')[name]; }

// ---------- HS5: the sentences ----------

test('HS5 the six hosted reasons have one plain sentence in main and the renderer, word for word, naming no vendor and no code', () => {
  const VENDOR = /claude|anthropic|hermes|sonnet|opus|haiku|openai|gpt-|ollama|qwen|llama|groq|gemini|google/i;
  for (const k of H.HOSTED_MODEL_REASONS.concat(['bad_provider'])) {
    assert.ok(ENV.AGENT_REASON_MESSAGES[k], k);
    assert.equal(E.AGENT_REASON_TEXT[k], ENV.AGENT_REASON_MESSAGES[k], `${k} reads as main words it`);
    assert.equal(E.errorCopy('invalid', k).text, ENV.AGENT_REASON_MESSAGES[k], k);
    assert.doesNotMatch(ENV.AGENT_REASON_MESSAGES[k], VENDOR);
    assert.doesNotMatch(ENV.AGENT_REASON_MESSAGES[k], /hosted_|_/, 'no code in the sentence');
  }
  assert.equal(E.AGENT_REASON_TEXT.hosted_key_missing, 'Add your access key in Settings first.');
  // A failed hosted turn reads as its sentence in the run list (the renderer's failure text falls back to the reason copy; a headline has no trailing period, the next step is shown apart).
  const J = loadTs('src/renderer/src/nexus/runs/jobRunModel.ts');
  for (const k of H.HOSTED_MODEL_REASONS) assert.equal(J.agentTurnHeadline({ state: 'failed', outcome: k, phase: null, headline: 'failed', cancelRequested: false }), E.AGENT_REASON_TEXT[k].replace(/\.$/, ''), k);
});

// ---------- HS6: the picker ----------

const opt = (o = {}) => ({ kind: 'cli-agent', label: 'Test Engine', version: '1', state: 'ready', signedIn: 'yes', selected: false, models: null, model: null, problem: null, hosts: ['cli.example.com:443'], ...o });
const provView = (keyA = true, keyB = false) => PROVIDERS.map((p, i) => ({ ...p, keyPresent: i === 0 ? keyA : keyB }));
const hostedOpt = (o = {}) => opt({ kind: 'hosted-model', label: 'Hosted (Test)', signedIn: 'unknown', providers: provView(), provider: null, model: null, problem: 'provider_not_chosen',
  hosts: ['alpha.example.com:443', 'beta.example.com:443'], ...o });
const view = (runtimes, live = false) => ({ runtimes, consent: { live, caps: null, hostsCount: 0, grantedAt: null, hosts: [] } });
const pick = (o, chosen = {}, prov = {}, live = false, last = null) => X.runtimeChoices(view([opt(), o], live), chosen, last, prov)[1];

test('HS6 the hosted row: provider and model preselected from the probe (first provider with a usable model), the button needs a saved key, a model without tools cannot be picked', () => {
  const c = pick(hostedOpt());
  assert.deepEqual([c.provider, c.model, c.models, c.action.disabled, c.action.op, c.action.label], ['alpha', 'a-big', null, false, 'grant', 'Use this AI service']);
  assert.deepEqual(c.providers.map((p) => [p.id, p.keyPresent, p.destination]), [['alpha', true, 'alpha.example.com'], ['beta', false, 'beta.example.com']]);
  assert.deepEqual(c.providers[0].models, [{ name: 'a-big', label: 'a-big', disabled: false }, { name: 'a-plain', label: 'a-plain (cannot use tools)', disabled: true }]);
  assert.equal(c.destination, 'alpha.example.com:443, beta.example.com:443', 'the row names both hosts a permission covers');
  assert.deepEqual([c.word, c.state], ['Ready', 'ok']);
  // Another provider with no key: needs attention, the sentence, a button to Settings, and no way to use it yet.
  const b = pick(hostedOpt(), {}, { 'hosted-model': 'beta' });
  assert.deepEqual([b.provider, b.model, b.word, b.action.disabled, b.keyHelp.settings], ['beta', 'b-fast', 'Needs attention', true, true]);
  assert.ok(b.keyHelp.text.startsWith(`${E.AGENT_REASON_TEXT.hosted_key_missing} To get a free access key, open the website of the AI service`), 'the missing-key sentence, then how to get a free access key');
  assert.match(b.keyHelp.text, /Settings > Agents & Models > access keys/, 'the full path to the keys is stated');
  assert.doesNotMatch(b.keyHelp.text, /https?:|www\./, 'no address in code: the person finds the provider\'s own page');
  // A picked model that cannot use tools, or that the provider does not list, is ignored.
  assert.equal(pick(hostedOpt(), { 'hosted-model': 'a-plain' }).model, 'a-big');
  assert.equal(pick(hostedOpt(), { 'hosted-model': 'b-fast' }).model, 'a-big', 'a model of another provider is ignored');
  // A provider that does not exist is ignored.
  assert.equal(pick(hostedOpt(), {}, { 'hosted-model': 'gamma' }).provider, 'alpha');
  // No usable model anywhere: nothing to choose.
  const none = pick(hostedOpt({ providers: [{ ...provView()[0], models: [{ name: 'a-plain', tools: false }] }] }));
  assert.deepEqual([none.provider === null, none.model, none.action.disabled, none.text], [true, null, true, E.AGENT_REASON_TEXT.hosted_provider_not_chosen]);
});

test('HS6b in use, rejected, remembered: the runtime in use says "In use" once, a rejected key says so with a Settings button, and the memory keeps the provider across a revoke', () => {
  const inUse = pick(hostedOpt({ selected: true, provider: 'alpha', model: 'a-big', problem: null }), {}, {}, true);
  assert.deepEqual([inUse.word, inUse.action, inUse.text], ['In use', null, 'An AI service, a model and your access key are set up.']);
  const rej = pick(hostedOpt({ selected: true, provider: 'alpha', model: 'a-big', problem: 'key_rejected' }), {}, {}, true);
  assert.deepEqual([rej.word, rej.state, rej.text, rej.keyHelp.text], ['Needs attention', 'problem', `In use. ${E.AGENT_REASON_TEXT.hosted_key_rejected}`, E.AGENT_REASON_TEXT.hosted_key_rejected]);
  assert.equal(rej.keyHelp.settings, true);
  // The provider in force wins over the default; a model change of the live provider is kept.
  const beta = pick(hostedOpt({ selected: true, provider: 'beta', model: 'b-fast', problem: null, providers: provView(true, true) }), {}, {}, true);
  assert.deepEqual([beta.provider, beta.model], ['beta', 'b-fast']);
  // Memory: the provider and model picked survive a revoke; the button grants them again.
  X.runtimeMemory.clear();
  const live = view([opt(), hostedOpt({ selected: true, provider: 'beta', model: 'b-fast', problem: null, providers: provView(true, true) })], true);
  assert.deepEqual(X.runtimeInUse(live), { kind: 'hosted-model', model: 'b-fast', provider: 'beta' });
  assert.deepEqual(X.runtimeInUse(view([opt({ selected: true }), hostedOpt()], true)), { kind: 'cli-agent', model: null }, 'a runtime without providers keeps its two keys');
  X.runtimeMemory.rememberInUse('hosted-model', 'b-fast'); X.runtimeMemory.rememberProvider('hosted-model', 'beta');
  const after = X.runtimeChoices(view([opt(), hostedOpt({ providers: provView(true, true) })], false), X.runtimeMemory.models(), X.runtimeMemory.kind(), X.runtimeMemory.providers())[1];
  assert.deepEqual([after.provider, after.model, after.action.op, after.action.disabled], ['beta', 'b-fast', 'grant', false]);
  assert.match(after.text, /It was in use before the permission was taken back\./);
  X.runtimeMemory.clear();
  assert.deepEqual(X.runtimeMemory.providers(), {});
  // Switching: with another runtime live the button switches.
  assert.equal(pick(hostedOpt(), {}, {}, true).action.op, 'switch');
  // Alone in the list (a live hosted permission scopes the probe to its kind) the picker is still shown.
  assert.equal(X.runtimeChoices(view([hostedOpt({ selected: true, provider: 'alpha', model: 'a-big', problem: null })], true)).length, 1);
  assert.equal(X.runtimeChoices(view([opt()])).length, 0);
});

test('HS6c the setup rows and the agent panel word the hosted problems; the permission row names every host and says what the key is', () => {
  const agentRow = (o = {}) => ({ state: 'ready', label: 'Hosted (Test)', version: 'presets-1', signedIn: 'unknown', flagsOk: true, kind: 'hosted-model',
    consent: { live: false, caps: null, hostsCount: 0, grantedAt: null }, usageToday: { usdCents: 0, turns: 0, estimated: false }, ...o });
  const hosts = ['alpha.example.com:443', 'beta.example.com:443'];
  const rows = X.agentSetupRows(agentRow(), { hosts });
  assert.deepEqual([rows[0].state, rows[0].text], ['ok', 'An AI service, a model and your access key are set up.']);
  assert.match(rows[1].text, /Giving permission lets your AI helper reach only alpha\.example\.com:443, beta\.example\.com:443\./);
  assert.match(rows[1].text, /Limits: up to \$2\.00 per request, \$10\.00 per day\./, 'the two limits that matter, in plain words');
  assert.equal(rows[1].label, 'Internet permission');
  assert.equal(rows[1].action, X.HOSTED_MODEL_DISCLOSURE);
  assert.match(X.HOSTED_MODEL_DISCLOSURE, /allows only that service’s addresses/);
  assert.match(X.HOSTED_MODEL_DISCLOSURE, /never shown again/);
  assert.equal(X.HOSTED_MODEL_DISCLOSURE.split('. ').length, 2, 'the disclosure is two short sentences');
  assert.match(rows[1].more, /Every command the AI helper runs goes into a safe space with no internet/, 'the honest limits sit behind More details');
  assert.doesNotMatch(rows.map((r) => `${r.text} ${r.action ?? ''}`).join(' '), /signed in|program/i);
  assert.equal(X.agentSetupRows(agentRow({ problem: 'key_missing' }))[0].text, E.AGENT_REASON_TEXT.hosted_key_missing);
  assert.match(X.agentSetupRows(agentRow({ problem: 'key_rejected' }))[0].action, /Open Settings > Agents & Models > access keys/);
  assert.equal(X.agentSetupRows(agentRow({ problem: 'provider_not_chosen' }))[0].text, E.AGENT_REASON_TEXT.hosted_provider_not_chosen);
  const map = { provider_not_chosen: 'hosted_provider_not_chosen', key_missing: 'hosted_key_missing', key_rejected: 'hosted_key_rejected', model_unavailable: 'hosted_model_unavailable' };
  for (const [problem, reason] of Object.entries(map)) assert.equal(X.LOCAL_PROBLEM_TEXT[problem], ENV.AGENT_REASON_MESSAGES[reason], problem);
  const h = (agent) => ({ db: { version: 10, platform: true, handoffs: true, execution: true, subReason: null }, agent });
  const panel = (agent) => A.agentPanelModel({ health: h(agent), availability: { kind: 'ready', advisories: [] }, sessions: [], sessionsFail: null });
  assert.deepEqual(panel(agentRow({ problem: 'key_missing', consent: { live: true, caps: null, hostsCount: 2, grantedAt: 1 } })).blockers, [E.AGENT_REASON_TEXT.hosted_key_missing]);
  assert.deepEqual(panel(agentRow({ problem: 'key_rejected', consent: { live: true, caps: null, hostsCount: 2, grantedAt: 1 } })).blockers, [E.AGENT_REASON_TEXT.hosted_key_rejected]);
  const ok = panel(agentRow({ consent: { live: true, caps: null, hostsCount: 2, grantedAt: 1 } }));
  assert.deepEqual([ok.canAsk, ok.note], [true, null], 'no "could not confirm sign-in" note for a runtime with no sign-in');
});

// ---------- HS7: Settings ----------

test('HS7 the Settings model: a row per probe provider, "Saved" or "Not set", a write-only field, drafts judged by the key shape, a plain explanation and no address', () => {
  const list = { ok: true, providers: [{ id: 'alpha', label: 'Alpha (free key)', present: true }, { id: 'beta', label: 'Beta (free key)', present: false }] };
  const rows = K.keyRows(list, { beta: `  ${KEY} ` });
  assert.deepEqual(rows.map((r) => [r.id, r.word, r.canDelete, r.canSave, r.problem]), [['alpha', 'Saved', true, false, null], ['beta', 'Not set', false, true, null]]);
  // Three states, each with one plain line: not set / saved / refused (a refused save says so until a key is saved).
  const refusedRows = K.keyRows(list, {}, { beta: S.KEY_REFUSAL_TEXT.bad_key, alpha: 'x' });
  assert.deepEqual(refusedRows.map((r) => [r.word, r.refusal !== null]), [['Saved', true], ['Refused', true]], 'a key already saved stays Saved');
  assert.deepEqual(rows.map((r) => r.line), ['Saved on this computer. Paste a new key below to replace it.', 'No key yet. Paste one below and press Save.']);
  assert.equal(refusedRows[1].line, 'Not saved. Check the key and try again.');
  assert.equal(rows[0].placeholder, 'Saved. Paste a new key to replace it');
  assert.equal(rows[1].placeholder, 'Paste your key here');
  assert.equal(K.keyRows(list, { beta: 'short' })[1].problem, K.KEY_SHAPE_TEXT);
  assert.equal(K.keyRows(list, { beta: 'short' })[1].canSave, false);
  assert.equal(K.keyRows(list, { beta: 'has a space inside it' })[1].canSave, false);
  assert.deepEqual(K.keyRows(null), []);
  assert.deepEqual(K.keyRows({ ok: false, reason: 'providers_unknown', message: 'x' }), []);
  assert.equal(K.keysNotice({ ok: false, reason: 'providers_unknown', message: 'x' }), K.KEYS_WAITING);
  assert.equal(K.keysNotice(null), K.KEYS_WAITING);
  assert.equal(K.keysNotice({ ok: false, reason: 'not_allowed', message: S.KEY_REFUSAL_TEXT.not_allowed }), S.KEY_REFUSAL_TEXT.not_allowed);
  assert.equal(K.keysNotice(list), null);
  assert.equal(K.KEYS_TITLE, 'Access keys');
  assert.equal(K.KEYS_PATH, 'Settings > Agents & Models > access keys');
  assert.match(K.KEYS_INTRO, /A secret code that lets Nexus use an AI service for you/);
  assert.match(K.KEYS_INTRO, /free/);
  assert.equal(K.KEYS_STEPS.length, 3, 'how to get a free key, in three plain steps (text only)');
  assert.match(K.KEYS_STEPS.join(' '), /sign up for free/);
  assert.match(K.KEYS_SAFETY, /locked on this computer/);
  assert.match(K.KEYS_SAFETY, /never shown again/);
  const comp = read('src/renderer/src/components/HostedKeysSettings.tsx');
  assert.match(comp, /type="password"/);
  assert.match(comp, /autoComplete="off"/);
  assert.match(comp, /window\.cth\.hostedKeySet\(\{ provider: id, key: row\.draft \}\)/);
  assert.match(comp, /setDrafts\(\(d\) => \(\{ \.\.\.d, \[id\]: '' \}\)\)/, 'the typed text leaves the field once sent');
  // The access keys come first in Agents & Models ("Add my key" lands there), above the default model and the engines.
  assert.match(read('src/renderer/src/components/SettingsModal.tsx'), /<HostedKeysSettings \/>[\s\S]{0,600}Default model for AI helpers[\s\S]*<AiEnginesSettings config=\{config\} \/>/);
  assert.match(comp, /requestKeysFocus/, 'the block scrolls itself into view and takes the cursor when it was asked for');
  assert.match(comp, /scrollIntoView/);
  // The sheet opens Settings (and closes itself first) and only from the hosted row's key help.
  const sheet = read('src/renderer/src/nexus/components/ExecutionSetupSheet.tsx');
  assert.match(sheet, /onClose\(\); requestKeysFocus\(\); shell\.openSettings\('Agents & Models'\)/);
  assert.match(sheet, /\{c\.keyHelp\.settings && shell && <Button onClick=\{addKey\}>Add my key<\/Button>\}/, 'the key help button is "Add my key" and uses the same landing');
});

// ---------- HS8: neutral copy ----------

test('HS8 no provider, vendor or address in Nexus-owned code, the model, the Settings text or the key store; the key is never named in a log line', () => {
  const WORD = /groq|gemini|google|openai|anthropic|claude|llama|ollama|qwen|gpt-/i;
  const files = ['src/main/nexus/agents/hostedModelSettings.ts', 'src/shared/nexus/hostedModel.ts', 'src/renderer/src/nexus/data/hostedKeysModel.ts', 'src/renderer/src/components/HostedKeysSettings.tsx',
    'src/renderer/src/nexus/components/ExecutionSetupSheet.tsx', 'src/renderer/src/nexus/data/executionModel.ts', 'src/renderer/src/nexus/data/errorCopy.ts', 'src/renderer/src/nexus/agent/agentModel.ts',
    'src/main/nexusIpc/agentSetup.ts', 'src/main/nexus/agents/agentService.ts', 'src/main/nexus/agents/budgetService.ts', 'src/main/nexusIpc/envelope.ts', 'src/main/nexusIpc/registerNexusIpc.ts'];
  for (const f of files) assert.deepEqual(read(f).split(/\r?\n/).filter((l) => WORD.test(l)), [], f);
  for (const f of ['src/main/nexus/agents/hostedModelSettings.ts', 'src/shared/nexus/hostedModel.ts', 'src/renderer/src/nexus/data/hostedKeysModel.ts', 'src/renderer/src/components/HostedKeysSettings.tsx']) {
    assert.doesNotMatch(read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), /https?:\/\/|www\./, `${f} holds no address`);
  }
  // No log call anywhere in the key code names a key value.
  assert.doesNotMatch(read('src/main/nexus/agents/hostedModelSettings.ts'), /console\.|\.log\(/);
  // The key never reaches the legacy config: the config redactor and the secrets migration know no hosted field.
  assert.doesNotMatch(read('src/main/configSecrets.ts'), /hosted/);
});
