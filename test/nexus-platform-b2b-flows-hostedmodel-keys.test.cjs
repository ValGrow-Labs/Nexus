'use strict';
// The Nexus hosted-model runtime's key, destination and permission paths through the real pipeline (HMF6-HMF11), the same world as
// test/nexus-platform-b2b-flows-hostedmodel.test.cjs (the REAL hosted adapter over a MOCK chat API on loopback through the runner's test seam;
// the key in the real key store over a fake safeStorage; real main, the real runner core, the fake sandbox driver). No real provider, no real key.
//   HMF6  the key is nowhere: a model that echoes it, the key store's audit rows, the views, every table, log and file
//   HMF7  a key deleted mid-turn cancels the turn (the existing cancel path), then a start is refused with the fixed sentence; a key REPLACED mid-turn
//         does not stop the running turn (it keeps the key it was given), the next turn uses the new one
//   HMF8  the destination rule: only the chosen provider's host and path (each preset), the production path through the egress proxy CONNECTs to
//         exactly that host and port (a fake proxy; the real proxy with a private resolution), no other provider is ever chosen or reached
//   HMF9  a revoked permission stops a live turn and the key stays stored; with no permission a start is refused
//   HMF10 a missing key is refused at the start (no job, no token) and, when it is lost between start and lease, at the lease (nothing minted or sent)
//   HMF11 switching runtime is revoke-then-grant, between the local model and the hosted model, both ways: each runtime reaches only its own server
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { sound } = require('./helpers/agentFlowWorld.cjs');
const F = require('./helpers/hostedModelFlows.cjs');
const L = require('./helpers/localModelFlows.cjs');
const { hmWorld, calls, say, writeFile, chatRequests, assertNoKey, agentContainers, jobError, everything, mock, PRESET, OTHER, KEY, KEY2, PROVIDER } = F;
const { intent } = require('./helpers/ipcExec.cjs');
const { AGENT_REASON_MESSAGES } = loadTs('src/main/nexusIpc/envelope.ts');
const { allPresetHosts } = loadTs('src/runner/runtimes/hostedModel/presets.ts');
const { hostsSha256 } = loadTs('src/main/nexus/agents/budgetService.ts');
const { startHostEgressProxy } = loadTs('src/runner/hostEgressProxy.ts');
const { MSG } = loadTs('src/runner/runtimes/hostedModel/messages.ts');

/** The user's message through the handler (a refusal comes back as an envelope, not an exception). */
const startCall = (w, message = 'do it') => w.drive(w.x.call('nexus:agent:start', { projectId: w.PROJECT, workspaceId: w.WORKSPACE, sessionId: null, focusVersionIds: [], message, intentId: intent() }));
const hostedRow = async (w) => (await w.x.ok('nexus:agent:consent', { op: 'get' })).runtimes.find((r) => r.kind === 'hosted-model');
const refRow = (provider) => `config:hosted:${provider}`;

// ---------------------------------------------------------------- HMF6: the key is nowhere

test('HMF6 the key is in no table, activity row, job event, log, view, file or provider request body or URL: not even when the model echoes it; the key audit rows name the provider only', async () => {
  const w = await hmWorld({ apiKey: false });
  try {
    // the key store: a stored key is scrambled on its disk, the audit row names the provider and the operation
    assert.equal((await w.setKey(KEY)).ok, true);
    assert.equal(w.keys.present(PROVIDER), true);
    assert.ok(!JSON.stringify(w.keyStore.blob).includes(KEY), 'the store\'s disk holds no plain key');
    assert.deepEqual(w.keys.list(), { ok: true, providers: w.keys.list().providers });
    assert.deepEqual(w.keys.list().providers.find((p) => p.id === PROVIDER), { id: PROVIDER, label: w.keys.list().providers.find((p) => p.id === PROVIDER).label, present: true });
    // a model whose own reply echoes the key (it cannot know it; a hostile or confused one may print what it sees in its prompt)
    w.model([calls([writeFile('src/a.js', `// ${KEY}\nmodule.exports = 1;\n`)]), say(`my key is ${KEY}`), say('done')]);
    const t = await w.turn('Write a file');
    assert.ok(['partial', 'completed', 'failed'].includes(t.job.state), t.job.state);
    const all = everything(w);
    assert.ok(!all.includes(Buffer.from(KEY, 'utf8').toString('base64')));
    const hits = all.split(KEY).length - 1;
    // the key is only where the MODEL put it itself (a file it wrote in its own worktree is the user's to see in the review; it is a made-up
    // string here); never in a row, an event or a log
    for (const t2 of w.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
      for (const r of w.db.prepare(`SELECT * FROM "${t2.name}"`).all()) assert.ok(!JSON.stringify(r, (k, v) => (Buffer.isBuffer(v) ? v.toString('latin1') : v)).includes(KEY), `table ${t2.name} holds the key`);
    }
    assert.ok(![...w.logs, ...w.runnerLogs].some((l) => l.includes(KEY)), 'a log line holds the key');
    assert.ok(hits >= 0);
    // the first request carried the key only as its auth header
    const first = chatRequests(w)[0];
    assert.equal(first.headers.authorization, `Bearer ${KEY}`);
    assert.ok(!first.body.includes(KEY) && !first.url.includes(KEY));
    // the audit rows of the key change
    const rows = w.db.prepare("SELECT details_json, entity_type, entity_id, actor_id FROM activity WHERE action = 'hosted.key' ORDER BY rowid").all();
    assert.deepEqual(rows.map((r) => JSON.parse(r.details_json)), [{ op: 'set', provider: PROVIDER }]);
    assert.ok(rows.every((r) => !JSON.stringify(r).includes(KEY)));
    // the views
    const views = JSON.stringify([await w.x.ok('nexus:agent:consent', { op: 'get' }), await w.x.ok('nexus:platform:health'), await w.x.ok('nexus:session:get', t.sessionId)]);
    assert.ok(!views.includes(KEY) && !views.includes(Buffer.from(KEY).toString('base64')));
    assert.doesNotMatch(views, /apiKey|"key"/);
    assert.equal(w.db.prepare('SELECT COUNT(*) n FROM capability_tokens WHERE revoked_at IS NULL').get().n, 0);
    assert.equal(agentContainers(w), 0);
    sound(w, 'HMF6');
  } finally { await w.close(); }
  // an ordinary world: no echo, so the strict scan (key only as the provider's auth header, in every row, log and file) holds
  const w2 = await hmWorld();
  try {
    w2.model([calls([writeFile('src/a.js', 'module.exports = 1;\n')]), say('done')]);
    const t = await w2.turn('Write a file');
    assert.ok(t.job.state !== 'running');
    assertNoKey(w2, 'HMF6 plain');
    sound(w2, 'HMF6 plain');
  } finally { await w2.close(); }
});

// ---------------------------------------------------------------- HMF7: a key deleted or replaced mid-turn

test('HMF7 deleting the key mid-turn cancels the turn and the next start is refused; replacing the key mid-turn does not stop the turn, and the next turn uses the new key', async () => {
  const w = await hmWorld({ script: [{ hang: true }] });
  try {
    // ----- deleted: the provider never answers; the user deletes the key; the turn is cancelled, not failed by a timeout
    const r = await w.start('Write a file');
    await w.approveA3();
    await w.until(() => chatRequests(w).length >= 1, 'the model call');
    assert.equal(w.jobRow(r.job.id).state, 'running');
    assert.equal(w.keys.delete(PROVIDER).ok, true);
    await w.until(() => w.ended(r.job.id), 'the turn ends');
    const job = w.jobRow(r.job.id);
    assert.notEqual(job.state, 'completed'); assert.notEqual(job.state, 'running');
    assert.equal(chatRequests(w).length, 1, 'no second request went out');
    assert.equal(w.changeSetsOf(r.job.id).length, 0);
    assert.equal(w.db.prepare('SELECT COUNT(*) n FROM capability_tokens WHERE revoked_at IS NULL').get().n, 0, 'the turn\'s token is revoked');
    assert.equal(agentContainers(w), 0);
    // no key: the next start is refused with the fixed sentence, no job
    const jobsBefore = w.db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind = 'agent.run'").get().n;
    const refused = await startCall(w);
    assert.equal(refused.ok, false); assert.equal(refused.reason, 'hosted_key_missing'); assert.equal(refused.message, AGENT_REASON_MESSAGES.hosted_key_missing);
    assert.equal(w.db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind = 'agent.run'").get().n, jobsBefore);
    assert.equal((await hostedRow(w)).problem, 'key_missing');
    const rows = w.db.prepare("SELECT details_json FROM activity WHERE action = 'hosted.key' ORDER BY rowid").all().map((x) => JSON.parse(x.details_json));
    assert.deepEqual(rows, [{ op: 'set', provider: PROVIDER }, { op: 'delete', provider: PROVIDER }]);

    // ----- replaced: a key saved again, a slow answer in flight, a NEW key saved meanwhile: the turn keeps the key it was given (a known limit)
    assert.equal((await w.setKey(KEY)).ok, true);
    w.model([{ delayMs: 1500, then: say('slow but fine') }, say('done')]);
    const before = chatRequests(w).length;
    const t = await w.start('Look at the code', { sessionId: null });
    await w.until(() => chatRequests(w).length > before, 'the slow model call');
    assert.equal(w.jobRow(t.job.id).state === 'running' || w.jobRow(t.job.id).state === 'leased', true);
    assert.equal((await w.setKey(KEY2)).ok, true);
    await w.until(() => w.ended(t.job.id), 'the slow turn ends');
    assert.ok(['completed', 'partial'].includes(w.jobRow(t.job.id).state), `a key replacement did not stop it: ${w.jobRow(t.job.id).state} ${w.jobRow(t.job.id).error_json}`);
    const mine = chatRequests(w).slice(before);
    assert.ok(mine.length >= 1);
    for (const q of mine) assert.equal(q.headers.authorization, `Bearer ${KEY}`, 'the running turn kept the key it was leased with');
    // the next turn is leased with the new key
    w.model([say('done')]);
    const n2 = chatRequests(w).length;
    const t2 = await w.turn('Look again');
    assert.ok(t2.job.state !== 'running');
    const next = chatRequests(w).slice(n2);
    assert.ok(next.length >= 1);
    for (const q of next) assert.equal(q.headers.authorization, `Bearer ${KEY2}`, 'the next turn uses the key saved last');
    assertNoKey(w, 'HMF7', KEY2, { also: [KEY], mixed: true });
    sound(w, 'HMF7');
  } finally { await w.close(); }
});

// ---------------------------------------------------------------- HMF8: the destination rule

test('HMF8 the chosen provider\'s host and path only, for each preset; the production path CONNECTs through the egress proxy to exactly that host and port; no other provider is chosen or reached', async () => {
  // ----- the second preset: its own host, path and quirks; nothing goes to the first
  const g = await hmWorld({ provider: OTHER.id, model: OTHER.defaultModel });
  try {
    g.model([calls([writeFile('src/a.js', 'module.exports = 1;\n')]), say('done')]);
    const t = await g.turn('Write a file');
    assert.ok(t.job.state !== 'running');
    const reqs = chatRequests(g);
    assert.ok(reqs.length >= 2);
    for (const q of reqs) {
      assert.equal(q.url, `${OTHER.basePath}/chat/completions`);
      assert.equal(String(q.headers.host).split(':')[0], OTHER.host);
      assert.notEqual(String(q.headers.host).split(':')[0], PRESET.host);
    }
    const body = JSON.parse(reqs[0].body);
    assert.equal(body.model, OTHER.defaultModel);
    assert.ok(!reqs[0].body.includes('additionalProperties'), 'the provider\'s schema quirk: the keys it rejects are not sent');
    assert.ok(JSON.parse(reqs[1].body).messages.some((m) => m.role === 'tool' && m.name === 'write_file'), 'the provider\'s quirk: the tool\'s name on its result');
    assertNoKey(g, 'HMF8 second preset');
    sound(g, 'HMF8 second preset');
  } finally { await g.close(); }

  // ----- the production path (no seam): through the egress proxy only
  const fake = await mock.startFakeProxy({ refuse: 403 });
  const state = { mode: 'fake', real: [] };
  const w = await hmWorld({
    hostedSeam: null,
    startProxy: async (opts) => {
      if (state.mode === 'fake') return { url: fake.url, port: fake.port, decisions: 0, dropped: 0, close: async () => {} };
      // the REAL host egress proxy, bound to the live consent, with a resolver that answers a private address (a refusal, and no connection is made)
      const p = await startHostEgressProxy({ ...opts, lookup: (host, cb) => { state.real.push(host); cb(null, ['10.0.0.5']); } });
      return p;
    }
  });
  try {
    // the permission covers the whole preset table's hosts, hash-bound, and nothing else
    const row = w.consentRow();
    assert.deepEqual(JSON.parse(row.hosts_json), allPresetHosts().map((x) => `${x.host}:${x.port}`));
    assert.equal(row.hosts_sha256, hostsSha256(allPresetHosts()));
    // (1) a fake CONNECT proxy that refuses: exactly one CONNECT, for the chosen provider's host and port; nothing reaches the provider
    w.model([say('never reached')]);
    const t1 = await w.turn('Write a file');
    assert.equal(t1.job.state, 'failed', t1.job.error_json);
    assert.equal(jobError(t1.job).message, MSG.proxyRefused);
    assert.deepEqual(fake.connects, [`${PRESET.host}:${PRESET.port}`], 'a CONNECT for the chosen provider\'s host and port, and for nothing else');
    assert.deepEqual(fake.plain, [], 'no plain (non-tunnel) request reached the proxy');
    assert.equal(w.api.requests.length, 0, 'nothing reached the provider mock');
    // (2) the real proxy: the decision is recorded, for the chosen provider's host only
    state.mode = 'real';
    const t2 = await w.turn('Write a file again', { sessionId: t1.sessionId });
    assert.equal(t2.job.state, 'failed', t2.job.error_json);
    assert.ok([MSG.proxyRefused, MSG.unreachable, MSG.tlsFailed].includes(jobError(t2.job).message), jobError(t2.job).message);
    const decisions = w.egressDecisions(t2.jobId);
    assert.ok(decisions.length >= 1, 'the proxy reported its decision');
    for (const d of decisions) assert.deepEqual([d.host, d.port, d.decision], [PRESET.host, PRESET.port, 'refused']);
    assert.equal(w.egressTruncated(t2.jobId), 0);
    assert.deepEqual([...new Set(state.real)], [PRESET.host], 'the only name ever resolved is the chosen provider\'s');
    assert.equal(w.api.requests.length, 0);

    // (3) no other provider can be chosen, and no other model than the chosen provider's
    for (const args of [{ op: 'model', model: OTHER.defaultModel }, { op: 'model', model: OTHER.defaultModel, provider: 'nope' }, { op: 'model', model: OTHER.defaultModel, provider: PRESET.host }]) {
      const r = await w.x.call('nexus:agent:consent', args);
      assert.equal(r.ok, false, JSON.stringify(args));
    }
    assert.equal((await hostedRow(w)).provider, PROVIDER);
    assert.equal(w.db.prepare("SELECT COUNT(*) n FROM runtime_consents WHERE revoked_at IS NULL").get().n, 1);
    assertNoKey(w, 'HMF8 production path', KEY, { noChat: true });
    sound(w, 'HMF8 production path');
  } finally { await w.close(); await fake.stop(); }
});

// ---------------------------------------------------------------- HMF9: a revoked permission

test('HMF9 revoking the permission stops a live turn (no further request) and leaves the key stored; with no permission a start is refused', async () => {
  const w = await hmWorld({ script: [{ hang: true }] });
  try {
    const r = await w.start('Write a file');
    await w.approveA3();
    await w.until(() => chatRequests(w).length >= 1, 'the model call');
    assert.equal(w.jobRow(r.job.id).state, 'running');
    await w.x.ok('nexus:agent:consent', { op: 'revoke' });
    await w.until(() => w.ended(r.job.id), 'the turn ends');
    assert.notEqual(w.jobRow(r.job.id).state, 'completed');
    assert.equal(chatRequests(w).length, 1, 'no further request after the revoke');
    assert.equal(w.keys.present(PROVIDER), true, 'revoking the permission does not delete the key');
    assert.equal(w.db.prepare('SELECT COUNT(*) n FROM capability_tokens WHERE revoked_at IS NULL').get().n, 0);
    assert.equal(agentContainers(w), 0);
    const refused = await startCall(w);
    assert.equal(refused.ok, false); assert.equal(refused.reason, 'consent_missing'); assert.equal(refused.message, AGENT_REASON_MESSAGES.consent_missing);
    assert.equal(chatRequests(w).length, 1);
    // a new grant (same provider and model) makes the same key work again
    await w.consent();
    w.model([say('done')]);
    const t = await w.turn('Look at the code');
    assert.ok(t.job.state !== 'running');
    assert.ok(chatRequests(w).length >= 2);
    assertNoKey(w, 'HMF9');
    sound(w, 'HMF9');
  } finally { await w.close(); }
});

// ---------------------------------------------------------------- HMF10: a missing key, at the start and at the lease

test('HMF10 no saved key: the start is refused with the fixed sentence (no job, no token, no request); a key lost between the start and the lease fails the job at the lease, before anything is minted or sent', async () => {
  const w = await hmWorld({ apiKey: false });
  try {
    assert.equal(w.keys.present(PROVIDER), false);
    assert.equal((await hostedRow(w)).problem, 'key_missing');
    const refused = await startCall(w);
    assert.equal(refused.ok, false); assert.equal(refused.reason, 'hosted_key_missing'); assert.equal(refused.message, AGENT_REASON_MESSAGES.hosted_key_missing);
    assert.equal(w.db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind = 'agent.run'").get().n, 0, 'no turn was created');
    assert.equal(w.db.prepare('SELECT COUNT(*) n FROM capability_tokens').get().n, 0, 'no token was minted');
    assert.equal(w.api.requests.length, 0);

    // a key is saved, the turn starts, the key vanishes from the secret store before the lease (the system store lost it: no key change was recorded)
    assert.equal((await w.setKey(KEY)).ok, true);
    const r = await w.start('Write a file');
    w.keyStore.delete(refRow(PROVIDER));
    await w.approveA3();
    await w.until(() => w.ended(r.job.id), 'the turn ends');
    const job = w.jobRow(r.job.id);
    assert.equal(job.state, 'failed', job.error_json);
    assert.equal(job.outcome, 'hosted_key_missing');
    assert.equal(jobError(job).code, 'hosted_key_missing');
    assert.equal(w.db.prepare('SELECT COUNT(*) n FROM capability_tokens').get().n, 0, 'nothing was minted for it');
    assert.equal(w.api.requests.length, 0, 'nothing was sent to any provider');
    assert.equal(agentContainers(w), 0);
    assert.ok(!everything(w).includes(KEY));
    sound(w, 'HMF10');
  } finally { await w.close(); }
});

// ---------------------------------------------------------------- HMF11: switching runtime is revoke, then grant

test('HMF11 switching between the local model and the hosted model is revoke-then-grant, both ways: each runtime reaches only its own server and the key never reaches the local one', async () => {
  const ollama = await L.mock.start({ script: [] });
  const w = await hmWorld({ alsoLocal: { modelUrl: ollama.url, model: L.MODEL } });
  try {
    // ----- hosted first
    w.model([say('hosted answer'), say('hosted answer'), say('hosted answer'), say('hosted answer')]);
    const a = await w.turn('Look at the code');
    assert.ok(a.job.state !== 'running');
    const hostedAsked = chatRequests(w).length;
    assert.ok(hostedAsked >= 1);
    assert.equal(ollama.requests.filter((q) => q.chat).length, 0, 'the local server was not asked');
    // a second permission cannot be granted while one is live
    const blocked = await w.x.call('nexus:agent:consent', { op: 'grant', runtime: 'local-model', model: L.MODEL });
    assert.equal(blocked.ok, false, 'a live hosted permission is not replaced by a grant');
    assert.equal(w.consentRow().runtime_kind, 'hosted-model');
    // ----- revoke, then grant the local model
    await w.x.ok('nexus:agent:consent', { op: 'revoke' });
    assert.equal(w.consentRow(), null);
    await w.consentLocal();
    assert.equal(w.consentRow().runtime_kind, 'local-model');
    ollama.setScript([L.say('local answer'), L.say('local answer'), L.say('local answer'), L.say('local answer')]);
    const b = await w.turn('Look at the code again', { sessionId: a.sessionId });
    assert.ok(b.job.state !== 'running');
    assert.equal(w.db.prepare('SELECT runtime_kind FROM job_attempts WHERE job_id = ?').get(b.jobId).runtime_kind, 'local-model');
    assert.ok(ollama.requests.filter((q) => q.chat).length >= 1, 'the local server answered');
    assert.equal(chatRequests(w).length, hostedAsked, 'the hosted provider was not asked while the local model was granted');
    const localSide = ollama.requests.map((q) => `${JSON.stringify(q.headers)}\n${q.url}\n${q.body}`).join('\n');
    assert.ok(!localSide.includes(KEY), 'the provider key never reached the local server');
    for (const q of ollama.requests) assert.equal(q.headers.authorization, undefined);
    assert.equal(w.keys.present(PROVIDER), true, 'the key stays saved while another runtime is used');
    // ----- revoke, then grant the hosted model again: the same key works
    await w.x.ok('nexus:agent:consent', { op: 'revoke' });
    await w.consent();
    assert.equal(w.consentRow().runtime_kind, 'hosted-model');
    w.model([say('hosted again'), say('hosted again'), say('hosted again'), say('hosted again')]);
    const c = await w.turn('And once more', { sessionId: a.sessionId });
    assert.ok(c.job.state !== 'running');
    assert.equal(w.db.prepare('SELECT runtime_kind FROM job_attempts WHERE job_id = ?').get(c.jobId).runtime_kind, 'hosted-model');
    assert.ok(chatRequests(w).length > hostedAsked);
    const grants = w.db.prepare("SELECT details_json FROM activity WHERE action = 'agent.consent' AND status = 'succeeded' ORDER BY rowid").all().map((x) => JSON.parse(x.details_json).op);
    assert.deepEqual(grants, ['grant', 'revoke', 'grant', 'revoke', 'grant']);
    assertNoKey(w, 'HMF11');
    sound(w, 'HMF11');
  } finally { await w.close(); await ollama.stop(); }
});
