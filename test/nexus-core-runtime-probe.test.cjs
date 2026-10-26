'use strict';
// B2b Task 14: what the runner reports in `probe.result.runtimes`, and under which proxy it checks the engine.
//   RP1  before any consent the adapter's health and setup run THROUGH a deny-all proxy (an empty allow list)
//   RP2  after a live consent (its hash is the adapter's own host list) they run through the allow-list proxy, bound to that hash
//   RP3  a hash that is not the adapter's own host list is never an allow list: deny-all again
//   RP4  no proxy, no engine run: a proxy that cannot start leaves health and setup unasked
//   RP5  through RunnerCore: the `probe` op carries the consent hash; the result passes main's own parser; no dep, no runtimes
//   RP6  the REAL deny-all proxy refuses the engine's way out (a CONNECT to the model host answers 403)
//   RP7  the result is kept briefly per consent state (one engine run per burst), and a consent change runs it again
//   RP8  the runner entry reports the real adapters; building them runs nothing; a RunnerCore built without them runs no engine
// Plain node: no Docker, no Electron, no database, no network (the engine here is a fake adapter object).
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { MessageChannel } = require('node:worker_threads');
const C = require('./helpers/cleanup.cjs');
C.cleanupAfterAll();
const h = require('./helpers/sqlite.cjs');
const loadTs = require('./load-ts.cjs');
const { FakeSandboxDriver } = require('./helpers/fakeSandboxDriver.cjs');
const { RuntimeProber } = loadTs('src/runner/runtimes/probe.ts');
const { RunnerCore } = loadTs('src/runner/core.ts');
const { hostsSha256, startHostEgressProxy } = loadTs('src/runner/hostEgressProxy.ts');
const { parseRunnerMessage } = loadTs('src/shared/nexus/runnerProtocol.ts');
const { probeAdapters } = loadTs('src/runner/runtimes/registry.ts');
const { newId } = loadTs('src/main/nexus/db/ids.ts');

const ROOT = path.resolve(__dirname, '..');
const IMAGES = path.join(ROOT, 'infra', 'images');
const HOSTS = [{ host: 'engine.example.com', port: 443 }];
const HASH = hostsSha256(HOSTS);
const KIND = 'cli-agent';

/** A fake adapter that records the proxy URL each call ran under. */
function adapter(o = {}) {
  const a = {
    kind: KIND, calls: [],
    async describe() { a.calls.push(['describe']); return { egressHosts: o.hosts ?? HOSTS }; },
    async health(x) { a.calls.push(['health', x.proxyUrl]); return o.health ?? { ok: true, version: '2.1.9' }; },
    async setup(x) { a.calls.push(['setup', x.proxyUrl]); return { signedIn: 'yes', flagsOk: true, label: 'Test Engine', egressHosts: o.hosts ?? HOSTS }; }
  };
  return a;
}
/** A recording proxy starter: each start is one entry; `close` is counted. */
function fakeProxies(o = {}) {
  const started = [];
  const startProxy = async (opts) => {
    if (o.fail) throw new Error('listen failed');
    const n = started.length + 1;
    const p = { url: `http://127.0.0.1:${40000 + n}`, port: 40000 + n, decisions: 0, dropped: 0, closed: 0, opts, async close() { p.closed++; } };
    started.push(p);
    return p;
  };
  return { started, startProxy };
}
const proberOf = (a, px, extra = {}) => new RuntimeProber({ adapters: () => [a], now: extra.now ?? (() => Date.now()), startProxy: px.startProxy, imagesDir: IMAGES, ...extra });

test('RP1 before consent the adapter is checked through a deny-all proxy; the proxy is closed afterwards', async () => {
  const a = adapter(); const px = fakeProxies();
  const out = await proberOf(a, px).probe(null);
  assert.equal(px.started.length, 1);
  assert.deepEqual(px.started[0].opts.allow, [], 'an empty allow list is deny-all');
  assert.equal(px.started[0].opts.consentHostsSha256, undefined);
  const url = px.started[0].url;
  assert.deepEqual(a.calls.filter((c) => c[0] !== 'describe'), [['health', url], ['setup', url]]);
  assert.equal(px.started[0].closed, 1);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].health, { ok: true, version: '2.1.9' });
  assert.equal(out[0].setup.label, 'Test Engine');
});

test('RP2 after a live consent the adapter is checked through the allow-list proxy bound to that consent', async () => {
  const a = adapter(); const px = fakeProxies();
  await proberOf(a, px).probe(HASH);
  assert.equal(px.started.length, 1);
  assert.deepEqual(px.started[0].opts.allow, HOSTS);
  assert.equal(px.started[0].opts.consentHostsSha256, HASH);
  const url = px.started[0].url;
  assert.deepEqual(a.calls.filter((c) => c[0] !== 'describe'), [['health', url], ['setup', url]]);
  assert.equal(px.started[0].closed, 1);
});

test('RP3 a consent hash that is not the adapter\'s own host list never makes an allow list', async () => {
  for (const bad of [hostsSha256([{ host: 'other.example.com', port: 443 }]), 'f'.repeat(64), 'nothex', '', 42]) {
    const a = adapter(); const px = fakeProxies();
    await proberOf(a, px).probe(bad);
    assert.deepEqual(px.started[0].opts.allow, [], String(bad));
  }
  // An adapter that names no host has nothing to allow, whatever the consent says.
  const a = adapter({ hosts: [] }); const px = fakeProxies();
  await proberOf(a, px).probe(HASH);
  assert.deepEqual(px.started[0].opts.allow, []);
});

test('RP4 a proxy that cannot start leaves the engine unasked, and the failure is a plain health answer', async () => {
  const a = adapter(); const px = fakeProxies({ fail: true });
  const out = await proberOf(a, px).probe(HASH);
  assert.deepEqual(a.calls.filter((c) => c[0] !== 'describe'), [], 'neither health nor setup ran');
  assert.equal(out[0].health.ok, false);
  assert.equal(out[0].health.reason, 'error');
  assert.equal(out[0].setup, undefined);
  // An adapter that throws is an answer too, never a thrown probe.
  const bad = { kind: KIND, describe: async () => ({ egressHosts: HOSTS }), health: async () => { throw new Error('boom'); }, setup: async () => { throw new Error('boom'); } };
  const out2 = await proberOf(bad, fakeProxies()).probe(null);
  assert.equal(out2[0].health.ok, false);
});

test('RP7 the answer is kept per consent state for a few seconds; a consent change or an expiry runs the engine again', async () => {
  let t = 1_000_000;
  const a = adapter(); const px = fakeProxies();
  const p = proberOf(a, px, { now: () => t, ttlMs: 10_000 });
  await p.probe(null); await p.probe(null);
  assert.equal(px.started.length, 1, 'a burst costs one engine run');
  await p.probe(HASH);
  assert.equal(px.started.length, 2, 'a consent change runs it again');
  t += 11_000;
  await p.probe(HASH);
  assert.equal(px.started.length, 3, 'an old answer is not reused');
});

// ---------- RP5: through RunnerCore ----------

const WORLDS = [];
after(async () => { for (const w of WORLDS) { try { await w.core.shutdown(); } catch { /* best effort */ } try { w.port1.close(); } catch { /* closed */ } } });

async function coreWorld(deps = {}) {
  const dir = h.tmpDir('nx-rp-');
  const home = path.join(dir, 'nexus');
  for (const d of ['objects/tmp', 'logs/jobs', 'logs/images', 'work']) fs.mkdirSync(path.join(home, d), { recursive: true });
  const { port1, port2 } = new MessageChannel();
  const got = [];
  port1.on('message', (m) => got.push(m));
  const core = new RunnerCore(port2, { driver: new FakeSandboxDriver({}), now: () => Date.now(), fs: fsp, log: () => {}, freeBytes: async () => 10 ** 12,
    sleep: async () => {}, imagesDir: IMAGES, ...deps });
  const w = { core, port1, got, home, send: (m) => port1.postMessage(m) };
  WORLDS.push(w);
  const BOOT = newId(Date.now());
  w.send({ op: 'hello', bootId: BOOT, dataHome: home, home: require('./load-ts.cjs')('src/shared/nexus/homeLabel.ts').homeLabel(home), profiles: [] });
  await until(() => got.some((m) => m.op === 'ready'));
  w.nextProbe = async (msg) => { const n = got.filter((m) => m.op === 'probe.result').length; w.send(msg); await until(() => got.filter((m) => m.op === 'probe.result').length > n); return got.filter((m) => m.op === 'probe.result').at(-1); };
  return w;
}
async function until(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 5)); }
}

test('RP5 RunnerCore: the probe op carries main\'s consent hash; the result passes main\'s parser; deny-all first, allow-list after consent', async () => {
  const a = adapter(); const px = fakeProxies();
  const w = await coreWorld({ runtimeProbe: { adapters: () => [a], startProxy: px.startProxy, ttlMs: 1 } });
  const r1 = await w.nextProbe({ op: 'probe' });
  const m1 = parseRunnerMessage(r1);
  assert.ok(m1 && m1.op === 'probe.result', 'main\'s parser accepts the result');
  assert.equal(m1.runtimes.length, 1);
  assert.equal(m1.runtimes[0].kind, KIND);
  assert.equal(m1.runtimes[0].setup.label, 'Test Engine');
  assert.deepEqual(px.started.map((p) => p.opts.allow), [[]], 'before consent: one proxy, deny-all');
  await new Promise((r) => setTimeout(r, 5));
  const r2 = await w.nextProbe({ op: 'probe', consentHostsSha256: HASH });
  assert.ok(parseRunnerMessage(r2));
  assert.deepEqual(px.started.map((p) => p.opts.allow), [[], HOSTS], 'after consent: the allow-list proxy');
  assert.equal(px.started[1].opts.consentHostsSha256, HASH);
  const lastHealth = a.calls.filter((c) => c[0] === 'health').at(-1);
  assert.equal(lastHealth[1], px.started[1].url, 'the engine was checked THROUGH that proxy');
  // A consent hash that is not a hash is no consent.
  await new Promise((r) => setTimeout(r, 5));
  await w.nextProbe({ op: 'probe', consentHostsSha256: 'not-a-hash' });
  assert.deepEqual(px.started.at(-1).opts.allow, []);
});

test('RP5b a RunnerCore built without runtime probe deps reports no runtimes and starts no proxy', async () => {
  const w = await coreWorld();
  const r = await w.nextProbe({ op: 'probe', consentHostsSha256: HASH });
  assert.deepEqual(r.runtimes, []);
  assert.ok(parseRunnerMessage(r));
});

// ---------- RP6: the real deny-all proxy ----------

function connect(proxyUrl, host) {
  const { port } = new URL(proxyUrl);
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: Number(port) });
    let got = '';
    s.on('data', (d) => { got += d.toString('latin1'); });
    s.on('close', () => resolve(got));
    s.on('error', () => resolve(got));
    s.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
    setTimeout(() => s.destroy(), 3000).unref();
  });
}

test('RP6 the real deny-all proxy a probe uses before consent refuses the engine\'s way out', async () => {
  const seen = [];
  const a = adapter();
  a.health = async (x) => { seen.push(await connect(x.proxyUrl, HOSTS[0].host)); return { ok: true, version: '2.1.9' }; };
  const prober = new RuntimeProber({ adapters: () => [a], now: () => Date.now(), imagesDir: IMAGES });
  const out = await prober.probe(null);
  assert.equal(out[0].health.ok, true);
  assert.match(seen[0], /^HTTP\/1\.1 403 Forbidden/, 'a CONNECT to the engine\'s own host is refused before consent');
  assert.doesNotMatch(seen[0], /200 Connection Established/);
});

// ---------- RP8: the entry and production adapters ----------

test('RP8 the runner entry reports the real adapters (nothing is run when they are built); production code has no other probe path', () => {
  const index = fs.readFileSync(path.join(ROOT, 'src/runner/index.ts'), 'utf8');
  assert.match(index, /runtimeProbe: \{ adapters: probeAdapters \}/);
  const cp = require('node:child_process');
  const real = cp.spawn; let spawned = 0;
  cp.spawn = function spy() { spawned++; return real.apply(this, arguments); };
  try {
    const list = probeAdapters();
    assert.equal(list.length, 1);
    assert.equal(list[0].kind, KIND);
    for (const m of ['describe', 'health', 'setup']) assert.equal(typeof list[0][m], 'function', m);
  } finally { cp.spawn = real; }
  assert.equal(spawned, 0, 'building the probe adapters starts no process');
  // The engine's raw status output never leaves the adapter: the runtimes entry holds a closed shape only.
  const probe = fs.readFileSync(path.join(ROOT, 'src/runner/runtimes/probe.ts'), 'utf8');
  assert.doesNotMatch(probe, /child_process|spawn\(|process\.env/);
  const core = fs.readFileSync(path.join(ROOT, 'src/runner/core.ts'), 'utf8');
  assert.equal((core.match(/runtimes: await this\.probeRuntimes\(/g) || []).length, 1);
  assert.doesNotMatch(core, /runtimes: \[\]/);
});

void startHostEgressProxy;
