'use strict';
// The hosted-model flows' shared pieces (test/nexus-platform-b2b-flows-hostedmodel*.test.cjs, the gated test/nexus-exec-agent-hostedmodel.test.cjs):
// a world whose agent is the REAL hosted-model adapter, talking over loopback to a MOCK chat-completions server
// (test/helpers/mockOpenAiServer.cjs) through the runner's test seam, with the user's key stored through the REAL key store over a fake
// safeStorage and resolved by main at the lease. What the model "decides" is the script; what is real is everything the platform does with it:
// the adapter's tool loop, free-tier handling and host file tools, the runner's MCP server, sandbox_exec (fake or real Docker),
// changeset_register, the validators, review, accept and merge. No real provider, no real key, no network beyond 127.0.0.1.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const mock = require('./mockOpenAiServer.cjs');
const { flowWorld, useFixture } = require('./agentFlowWorld.cjs');
const loadTs = require('../load-ts.cjs');
const L = require('./localModelFlows.cjs');
const { PROVIDER_PRESETS, presetFor } = loadTs('src/runner/runtimes/hostedModel/presets.ts');

/** The first preset (the table is data: a test reads it, it never hard-codes a provider's host). */
const PRESET = PROVIDER_PRESETS[0];
const PROVIDER = PRESET.id;
const MODEL = PRESET.defaultModel;
const OTHER = PROVIDER_PRESETS[1];
/** A made-up key of the accepted shape (visible ASCII, 8..512): it works nowhere. */
const KEY = 'TESTKEY-flows-0123456789abcdefghij-NEVER-REAL';
const KEY2 = 'TESTKEY-flows-second-9876543210zyxwvu-NEVER-REAL';

/**
 * A world whose agent is the real hosted-model adapter over a mock provider. `o.script`: the mock's first script; `o.provider`/`o.model`: the
 * user's choice (default: the first preset and its default model); `o.apiKey`: the key to store (default KEY; `false`: none stored);
 * `o.noConsent`; `o.caps`: the consent's caps; `o.real`: the real Docker driver; `o.hostedSeam`, `o.startProxy`, `o.alsoLocal`, `o.mockOptions`:
 * see flowWorld and the mock. Returns the world with `w.api` (the mock), `w.provider`, `w.preset`, `w.key`.
 */
async function hmWorld(o = {}) {
  const provider = o.provider ?? PROVIDER;
  const preset = presetFor(provider);
  const model = o.model ?? preset.defaultModel;
  const api = await mock.start({ script: o.script ?? [], ...(o.mockOptions ?? {}) });
  let w;
  try {
    w = await flowWorld({ runtime: 'hosted-model', provider, model, modelUrl: api.url, real: o.real === true, hostedSeam: o.hostedSeam, startProxy: o.startProxy, alsoLocal: o.alsoLocal });
    await useFixture(w, o.fixture ?? 'node-test-app');
    await w.snapshot();
    const key = o.apiKey === undefined ? KEY : o.apiKey;
    if (key !== false) { const r = await w.setKey(key); assert.equal(r.ok, true, JSON.stringify(r)); }
    if (!o.noConsent) await w.consent(o.caps);
  } catch (e) { await api.stop(); if (w) { try { await w.close(); } catch { /* best effort */ } } throw e; }
  w.api = api; w.preset = preset; w.key = o.apiKey === undefined || o.apiKey === false ? KEY : o.apiKey;
  const close = w.close;
  w.close = async () => { try { await close(); } finally { await api.stop(); } };
  /** The next turn's replies (the mock's call counter restarts). */
  w.model = (script) => { api.setScript(script); return w; };
  /** The tool results the model was given, in order (the `tool` messages of the last chat request's history). */
  w.toolMessages = () => { const cs = api.chats(); return cs.length === 0 ? [] : cs[cs.length - 1].messages.filter((m) => m.role === 'tool').map((m) => String(m.content)); };
  return w;
}

const chatRequests = (w) => w.api.requests.filter((r) => r.chat);
const jobError = (job) => (job.error_json ? JSON.parse(job.error_json) : null);

/** Every row of every table, every log main and the runner kept, the key store's disk, and every file under the data home (except git objects): one text. */
function everything(w) {
  const out = [];
  for (const t of w.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) for (const r of w.db.prepare(`SELECT * FROM "${t.name}"`).all()) out.push(JSON.stringify(r, (k, v) => (Buffer.isBuffer(v) ? v.toString('latin1') : v)));
  out.push(...w.logs, ...w.runnerLogs);
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === '.git' || e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && fs.statSync(p).size < 4 * 1024 * 1024) out.push(fs.readFileSync(p).toString('latin1'));
    }
  };
  walk(w.dataHome.root);
  if (w.keyStore) out.push(JSON.stringify(w.keyStore.blob));
  return out.join('\n');
}

/**
 * The key (and the turn's bearer) are where they may be and nowhere else: the key is the `authorization` header of the chat requests the
 * mock received and in no other header, no URL, no body; no row, log, attempt log, context file or file under the data home holds it (nor its
 * base64); the key store's disk holds only scrambled text; no capability token is live; the mock saw only chat requests for the chosen provider.
 */
function assertNoKey(w, name, key = w.key, o = {}) {
  const keys = [key, ...(o.also ?? [])].filter((k) => typeof k === 'string' && k.length > 0);
  const chats = chatRequests(w);
  if (o.noChat !== true) assert.ok(chats.length > 0, `${name}: the model was asked`);
  for (const r of w.api.requests) {
    assert.equal(r.method, 'POST', `${name}: only POSTs reached the provider`);
    assert.ok(r.url.endsWith('/chat/completions') && r.url.startsWith(w.preset.basePath), `${name}: only the chat endpoint of the chosen provider: ${r.url}`);
    assert.equal(String(r.headers.host).split(':')[0], w.preset.host, `${name}: the Host is the chosen provider's`);
    for (const k of keys) {
      assert.ok(!r.url.includes(k), `${name}: the key is in a URL`);
      assert.ok(!r.body.includes(k), `${name}: the key is in a request body`);
      for (const [h, v] of Object.entries(r.headers)) if (h !== 'authorization') assert.ok(!String(v).includes(k), `${name}: the key is in header ${h}`);
    }
    assert.ok(/^Bearer \S+$/.test(String(r.headers.authorization)), `${name}: the auth header carries a bearer value`);
  }
  if (key === w.key && o.mixed !== true) for (const r of w.api.requests) assert.equal(r.headers.authorization, `Bearer ${key}`, `${name}: the key is the provider's auth header`);
  const all = everything(w);
  for (const k of keys) {
    assert.ok(!all.includes(k), `${name}: the key is in a row, a log or a file`);
    assert.ok(!all.includes(Buffer.from(k, 'utf8').toString('base64')), `${name}: the key's base64 is in a row, a log or a file`);
  }
  if (w.keyStore) for (const v of Object.values(w.keyStore.blob)) for (const k of keys) assert.ok(!String(v).includes(k), `${name}: the store's disk holds the key as plain text`);
  // the MCP bearer never reached the provider either
  for (const tok of new Set(w.bearers)) {
    for (const r of w.api.requests) assert.ok(!`${JSON.stringify(r.headers)}\n${r.url}\n${r.body}`.includes(tok), `${name}: a bearer reached the provider`);
    assert.ok(!all.includes(tok), `${name}: a bearer is in a row, a log or a file`);
  }
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM capability_tokens WHERE revoked_at IS NULL').get().n, 0, `${name}: every turn's token is revoked at its end`);
}

const agentContainers = (w) => w.driver.all().filter((r) => r.kind === 'container' && r.labels['nexus.kind'] === 'agent').length;

module.exports = { hmWorld, chatRequests, everything, assertNoKey, agentContainers, jobError, PROVIDER, MODEL, PRESET, OTHER, KEY, KEY2, mock,
  buildTurn: L.buildTurn, calls: L.calls, say: L.say, writeFile: L.writeFile, exec: L.exec, register: L.register };
