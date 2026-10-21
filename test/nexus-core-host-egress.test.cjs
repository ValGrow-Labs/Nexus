'use strict';
// B2b Task 12: the host egress proxy for the agent process (src/runner/hostEgressProxy.ts). The runner loads B2a's own
// infra/images/sde-node/egress-proxy.js from the repository (F14: no copy, no image change) and listens on 127.0.0.1:0.
//  HE1  an allow-listed CONNECT with the matching TLS name is accepted and tunnelled (production path: no pinned entry)
//  HE2  another host, or another port of the allowed host, is refused before any lookup
//  HE3  plain HTTP is refused (no path or query in the decision)
//  HE4  an IP literal is refused
//  HE5  a TLS name other than the CONNECT host is refused before any lookup
//  HE6  source pin: production code passes no test lookup and no pinned entry
//  HE7  the image context is unchanged: tools/nexus-lock-images.cjs --check passes and infra/images has no diff
//  HE8  the proxy binds 127.0.0.1 only
//  HE9  a consent hash mismatch refuses the start
// Nothing leaves this machine: every DNS answer is a fake one, and net.connect is wrapped for the whole file so that a
// connect to anything but loopback throws (the one fake public address the tests use is redirected to a loopback server).
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const tls = require('node:tls');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const ROOT = path.resolve(__dirname, '..');
const IMAGES = path.join(ROOT, 'infra', 'images');
const PROXY_FILE = path.join(IMAGES, 'sde-node', 'egress-proxy.js');

// ---------------------------------------------------------------- loopback only, for the whole file

/** A public-looking address the fake DNS returns; the wrapper sends a connect to it to the local upstream instead. */
const FAKE_PUBLIC = '93.184.215.14';
const UPSTREAM = { port: 0 };
const CONNECTS = [];
const realConnect = net.connect;
const isLoopback = (h) => h === '127.0.0.1' || h === '::1' || h === 'localhost';
net.connect = net.createConnection = function loopbackOnly(...args) {
  const o = args[0];
  if (o && typeof o === 'object' && !Array.isArray(o) && typeof o.host === 'string') {
    CONNECTS.push(`${o.host}:${o.port}`);
    if (o.host === FAKE_PUBLIC) return realConnect.call(this, { ...o, host: '127.0.0.1', port: UPSTREAM.port }, ...args.slice(1));
    if (!isLoopback(o.host)) throw new Error(`test refuses a non-loopback connect to ${o.host}:${o.port}`);
  } else if (typeof o === 'number' && typeof args[1] === 'string' && !isLoopback(args[1])) {
    throw new Error(`test refuses a non-loopback connect to ${args[1]}:${o}`);
  }
  return realConnect.apply(this, args);
};

const hep = loadTs('src/runner/hostEgressProxy.ts');
const { startHostEgressProxy, hostsSha256, canonicalHostsJson, hostProxyModulePath, HostEgressProxyError, HOST_PROXY_BIND } = hep;
const { EGRESS_EVENT_MAX, parseRunnerMessage } = loadTs('src/shared/nexus/runnerProtocol.ts');
const { newId } = loadTs('src/main/nexus/db/ids.ts');

/** D-B2: the agent process's one destination. */
const API = { host: 'api.anthropic.com', port: 443 };
const ALLOW = [API];
const CONSENT = hostsSha256(ALLOW);

/** A fake resolver: every name answers the fake public address; the calls are recorded. */
function fakeLookup() {
  const calls = [];
  const fn = (host, cb) => { calls.push(host); cb(null, [FAKE_PUBLIC]); };
  fn.calls = calls;
  return fn;
}

/** A real TLS ClientHello from node's own TLS client, captured on loopback. */
function clientHello(servername) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((s) => { s.once('data', (d) => { resolve(Buffer.from(d)); s.destroy(); srv.close(); }); });
    srv.listen(0, '127.0.0.1', () => {
      const t = tls.connect({ host: '127.0.0.1', port: srv.address().port, servername, rejectUnauthorized: false });
      t.on('error', () => {}); setTimeout(() => t.destroy(), 2000).unref();
    });
    srv.on('error', reject);
  });
}

/** Sends `head` to the proxy; after a 200, sends `after` (the ClientHello). Resolves with everything received. */
function ask(url, head, after) {
  const { port } = new URL(url);
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: Number(port) });
    let got = Buffer.alloc(0);
    let sent = false;
    s.on('data', (d) => {
      got = Buffer.concat([got, d]);
      if (after && !sent && got.includes('200 Connection Established\r\n\r\n')) { sent = true; s.write(after); }
    });
    s.on('close', () => resolve(got.toString('latin1')));
    s.on('error', () => resolve(got.toString('latin1')));
    s.write(head);
    setTimeout(() => s.destroy(), 4000).unref();
  });
}

/** Waits until `pred()` holds (decisions are logged asynchronously to the client's close). */
async function until(pred, ms = 3000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function withProxy(o, fn) {
  const events = [];
  const proxy = await startHostEgressProxy({ allow: ALLOW, consentHostsSha256: CONSENT, onDecision: (e) => events.push(e), imagesDir: IMAGES, ...o });
  try { return await fn(proxy, events); } finally { await proxy.close(); }
}

/** Every decision event is the runner protocol's strict `egress` progress event. */
function assertEventsValid(events) {
  for (const e of events) {
    assert.deepEqual(Object.keys(e).sort(), ['at', 'decision', 'host', 'port', 'reason', 't']);
    const msg = parseRunnerMessage({ op: 'attempt.event', attemptId: newId(Date.now()), seq: 1, event: e });
    assert.ok(msg && msg.op === 'attempt.event', `main accepts ${JSON.stringify(e)}`);
    assert.deepEqual(msg.event, e);
  }
}

// ---------------------------------------------------------------- HE1-HE5: the real file, through startHostEgressProxy

test('HE1 an allow-listed CONNECT with the matching TLS name is accepted: resolved once by the proxy, tunnelled, one allowed event', async () => {
  const upstreamSeen = [];
  const upstream = net.createServer((s) => { s.once('data', (d) => { upstreamSeen.push(Buffer.from(d)); s.end('upstream-ok\n'); }); });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  UPSTREAM.port = upstream.address().port;
  const lookup = fakeLookup();
  try {
    await withProxy({ lookup }, async (proxy, events) => {
      assert.equal(hostProxyModulePath(IMAGES), PROXY_FILE, 'the runner loads B2a\'s own proxy file');
      const hello = await clientHello(API.host);
      const before = CONNECTS.length;
      const got = await ask(proxy.url, `CONNECT ${API.host}:${API.port} HTTP/1.1\r\nHost: ${API.host}:${API.port}\r\n\r\n`, hello);
      assert.match(got, /^HTTP\/1\.1 200 Connection Established\r\n\r\nupstream-ok\n$/);
      assert.deepEqual(upstreamSeen.map((b) => b.equals(hello)), [true], 'the upstream received exactly the ClientHello');
      assert.deepEqual(lookup.calls, [API.host], 'the proxy resolved the name itself, once');
      assert.ok(CONNECTS.slice(before).includes(`${FAKE_PUBLIC}:443`), 'it connected to the very address it checked, on the entry port');
      await until(() => events.length === 1);
      assert.deepEqual(events.map(({ decision, host, port, reason }) => ({ decision, host, port, reason })),
        [{ decision: 'allowed', host: API.host, port: 443, reason: 'allowed' }]);
      assert.equal(typeof events[0].at, 'number');
      assertEventsValid(events);
    });
  } finally { upstream.close(); }
});

test('HE2 another host, or another port of the allowed host, is refused (403) before any lookup', async () => {
  const lookup = fakeLookup();
  await withProxy({ lookup }, async (proxy, events) => {
    const r1 = await ask(proxy.url, 'CONNECT evil.example.com:443 HTTP/1.1\r\n\r\n');
    assert.match(r1, /^HTTP\/1\.1 403 Forbidden\r\nX-Nexus-Egress: host_not_allowed\r\n/);
    const r2 = await ask(proxy.url, `CONNECT ${API.host}:80 HTTP/1.1\r\n\r\n`);
    assert.match(r2, /^HTTP\/1\.1 403 Forbidden\r\nX-Nexus-Egress: port_not_allowed\r\n/);
    const r3 = await ask(proxy.url, `CONNECT x.${API.host}:443 HTTP/1.1\r\n\r\n`);
    assert.match(r3, /X-Nexus-Egress: host_not_allowed/, 'no suffix match');
    await until(() => events.length === 3);
    assert.deepEqual(events.map((e) => [e.decision, e.host, e.port, e.reason]), [
      ['refused', 'evil.example.com', 443, 'host_not_allowed'], ['refused', API.host, 80, 'port_not_allowed'],
      ['refused', `x.${API.host}`, 443, 'host_not_allowed']]);
    assert.deepEqual(lookup.calls, []);
    assertEventsValid(events);
  });
  // Deny-all mode (health probes before consent): an empty allow list refuses even the production host.
  const denyEvents = [];
  const deny = await startHostEgressProxy({ allow: [], onDecision: (e) => denyEvents.push(e), imagesDir: IMAGES, lookup });
  try {
    const r = await ask(deny.url, `CONNECT ${API.host}:443 HTTP/1.1\r\n\r\n`, await clientHello(API.host));
    assert.match(r, /^HTTP\/1\.1 403 Forbidden\r\nX-Nexus-Egress: host_not_allowed\r\n/);
    await until(() => denyEvents.length === 1);
    assert.equal(denyEvents[0].reason, 'host_not_allowed');
    assert.deepEqual(lookup.calls, []);
  } finally { await deny.close(); }
});

test('HE3 plain HTTP is refused (403 plain_http); the decision carries the host only, never the path or query', async () => {
  const lookup = fakeLookup();
  await withProxy({ lookup }, async (proxy, events) => {
    const r = await ask(proxy.url, `GET http://${API.host}/v1/secret-path?key=abc123 HTTP/1.1\r\nHost: ${API.host}\r\nAuthorization: Bearer zzz\r\n\r\n`);
    assert.match(r, /^HTTP\/1\.1 403 Forbidden\r\nX-Nexus-Egress: plain_http\r\n/);
    const r2 = await ask(proxy.url, `POST http://${API.host}:443/ HTTP/1.1\r\n\r\n`);
    assert.match(r2, /X-Nexus-Egress: plain_http/);
    await until(() => events.length === 2);
    assert.deepEqual(events.map((e) => [e.decision, e.reason]), [['refused', 'plain_http'], ['refused', 'plain_http']]);
    assert.equal(events[0].host, API.host);
    assert.doesNotMatch(JSON.stringify(events), /secret-path|key=|abc123|Bearer|zzz/);
    assert.deepEqual(lookup.calls, []);
    assertEventsValid(events);
  });
});

test('HE4 an IP literal (v4, v6, bracketed) is refused (403 ip_literal), never resolved or connected', async () => {
  const lookup = fakeLookup();
  await withProxy({ lookup }, async (proxy, events) => {
    const before = CONNECTS.length;
    for (const target of ['160.79.104.10:443', '127.0.0.1:443', '[::1]:443', '[2607:6bc0::10]:443']) {
      const r = await ask(proxy.url, `CONNECT ${target} HTTP/1.1\r\n\r\n`);
      assert.match(r, /^HTTP\/1\.1 403 Forbidden\r\nX-Nexus-Egress: ip_literal\r\n/, target);
    }
    await until(() => events.length === 4);
    assert.ok(events.every((e) => e.decision === 'refused' && e.reason === 'ip_literal'));
    assert.deepEqual(lookup.calls, []);
    assert.equal(CONNECTS.slice(before).filter((c) => !c.startsWith('127.0.0.1:')).length, 0, 'nothing was connected');
    assertEventsValid(events);
  });
});

test('HE5 a TLS name other than the CONNECT host is refused (sni_mismatch) before any lookup or connect; no TLS is not_tls', async () => {
  const lookup = fakeLookup();
  await withProxy({ lookup }, async (proxy, events) => {
    const before = CONNECTS.length;
    const r = await ask(proxy.url, `CONNECT ${API.host}:443 HTTP/1.1\r\n\r\n`, await clientHello('evil.example.com'));
    assert.match(r, /^HTTP\/1\.1 200 Connection Established\r\n\r\n$/, 'the tunnel closes without a byte');
    const r2 = await ask(proxy.url, `CONNECT ${API.host}:443 HTTP/1.1\r\n\r\n`, Buffer.from('GET / HTTP/1.1\r\n\r\n'));
    assert.match(r2, /^HTTP\/1\.1 200 Connection Established\r\n\r\n$/);
    await until(() => events.length === 2);
    assert.deepEqual(events.map((e) => [e.decision, e.host, e.port, e.reason]),
      [['refused', API.host, 443, 'sni_mismatch'], ['refused', API.host, 443, 'not_tls']]);
    assert.deepEqual(lookup.calls, []);
    assert.equal(CONNECTS.slice(before).filter((c) => !c.startsWith('127.0.0.1:')).length, 0);
    assertEventsValid(events);
  });
});

test('HE5b at most EGRESS_EVENT_MAX decision events per proxy (the CLI retries a refused CONNECT); the rest are counted', async () => {
  assert.equal(EGRESS_EVENT_MAX, 200);
  await withProxy({ lookup: fakeLookup() }, async (proxy, events) => {
    const N = EGRESS_EVENT_MAX + 5;
    for (let i = 0; i < N; i += 25) {
      await Promise.all(Array.from({ length: Math.min(25, N - i) }, () => ask(proxy.url, 'CONNECT evil.example.com:443 HTTP/1.1\r\n\r\n')));
    }
    await until(() => proxy.decisions === N);
    assert.equal(events.length, EGRESS_EVENT_MAX);
    assert.equal(proxy.dropped, 5);
  });
  // A throwing onDecision never breaks the proxy.
  const proxy = await startHostEgressProxy({ allow: ALLOW, consentHostsSha256: CONSENT, onDecision: () => { throw new Error('boom'); },
    imagesDir: IMAGES, lookup: fakeLookup() });
  try {
    assert.match(await ask(proxy.url, 'CONNECT evil.example.com:443 HTTP/1.1\r\n\r\n'), /host_not_allowed/);
    assert.match(await ask(proxy.url, 'CONNECT evil.example.com:443 HTTP/1.1\r\n\r\n'), /host_not_allowed/);
  } finally { await proxy.close(); }
});

// ---------------------------------------------------------------- HE6: source pin

const SRC = path.join(ROOT, 'src', 'runner', 'hostEgressProxy.ts');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(ts|tsx|cjs|js|mjs)$/.test(e.name) ? [path.join(dir, e.name)] : []);

test('HE6 source pin: production code passes no test lookup and no pinned entry; lookup is injected only from tests', async () => {
  const text = fs.readFileSync(SRC, 'utf8');
  // The entries handed to serve() are built here, each with `pin: null`; nothing else builds an entry.
  const pins = text.match(/pin:[^,;}\r\n]*/g) ?? [];
  assert.ok(pins.length >= 1 && pins.every((p) => /^pin: null\s*$/.test(p)), `every entry is built with pin: null (${pins.join(' | ')})`);
  assert.match(text, /return \{ host, port: Number\(k\.slice\(i \+ 1\)\), pin: null \}/);
  assert.doesNotMatch(text, /parseAllow|NEXUS_EGRESS_ALLOW|`[^`]*=\$\{/, 'no allow text with an =ip pin is ever formatted');
  assert.doesNotMatch(text, /dns\.|node:dns|require\(['"]dns/, 'the module never brings its own resolver');
  // The only lookup handed to serve() is the caller's optional one (undefined in production: the proxy's own dns lookup).
  assert.match(text, /serve\(entries, \{ log, lookup: o\.lookup \}\)/);
  // No production caller passes `lookup` (or `imagesDir` pointing anywhere but the runner's own images dir).
  const callers = walk(path.join(ROOT, 'src')).filter((f) => f !== SRC && fs.readFileSync(f, 'utf8').includes('startHostEgressProxy'));
  for (const f of callers) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/startHostEgressProxy\s*\(([\s\S]{0,600}?)\)\s*;/g)) {
      assert.doesNotMatch(m[1], /\blookup\b/, `${path.relative(ROOT, f)} passes a lookup`);
      assert.doesNotMatch(m[1], /\bpin\b/, `${path.relative(ROOT, f)} passes a pin`);
    }
  }
  // Runtime: an entry carrying a pin (or any extra key), an allow text, an IP host, a bad port, are all refused.
  for (const allow of [[{ ...API, pin: '127.0.0.1' }], [{ host: `${API.host}:443=127.0.0.1`, port: 443 }], [{ host: '127.0.0.1', port: 443 }],
    [{ host: API.host, port: 0 }], [{ host: API.host, port: '443' }], [{ host: 'Bad_Host', port: 443 }], ['api.example.com:443'],
    Array.from({ length: 17 }, (_, i) => ({ host: `h${i}.example.com`, port: 443 }))]) {
    await assert.rejects(startHostEgressProxy({ allow, consentHostsSha256: hostsSha256Safe(allow), onDecision: () => {}, imagesDir: IMAGES }),
      (e) => e instanceof HostEgressProxyError && e.code === 'allow_invalid', JSON.stringify(allow).slice(0, 80));
  }
  // The loaded module is the repository file itself (no copy under src or out).
  assert.equal(hostProxyModulePath(IMAGES), PROXY_FILE);
  assert.equal(walk(path.join(ROOT, 'src')).filter((f) => path.basename(f) === 'egress-proxy.js').length, 0, 'no copy of the proxy');
  // A missing images dir is a clear failure, not a fallback.
  await assert.rejects(startHostEgressProxy({ allow: [], onDecision: () => {}, imagesDir: path.join(os.tmpdir(), `nexus-no-images-${crypto.randomUUID()}`) }),
    (e) => e instanceof HostEgressProxyError && e.code === 'proxy_unavailable');
});
function hostsSha256Safe(allow) { try { return hostsSha256(allow); } catch { return 'f'.repeat(64); } }

// ---------------------------------------------------------------- HE7: the image context is unchanged

test('HE7 the image context is unchanged: nexus-lock-images --check passes and infra/images has no diff', () => {
  const r = cp.spawnSync(process.execPath, [path.join(ROOT, 'tools', 'nexus-lock-images.cjs'), '--check'], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const d = cp.spawnSync('git', ['diff', '--quiet', 'HEAD', '--', 'infra/images'], { cwd: ROOT });
  assert.equal(d.status, 0, 'infra/images is unchanged against HEAD');
});

// ---------------------------------------------------------------- HE8: loopback binding

test('HE8 the proxy binds 127.0.0.1 only', async () => {
  assert.equal(HOST_PROXY_BIND, '127.0.0.1');
  const text = fs.readFileSync(SRC, 'utf8');
  assert.match(text, /\.listen\(0, HOST_PROXY_BIND/);
  assert.equal((text.match(/\.listen\(/g) ?? []).length, 1);
  await withProxy({ lookup: fakeLookup() }, async (proxy) => {
    const u = new URL(proxy.url);
    assert.equal(u.protocol, 'http:');
    assert.equal(u.hostname, '127.0.0.1');
    assert.match(proxy.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(proxy.port, Number(u.port));
    // Another local interface on the same port is not served (refused, or another process's socket: never this proxy).
    const others = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
    for (const addr of [...others.slice(0, 1), '::1']) {
      const r = await new Promise((resolve) => {
        const s = realConnect({ host: addr, port: proxy.port });
        s.once('connect', () => { s.write('CONNECT evil.example.com:443 HTTP/1.1\r\n\r\n'); });
        let got = '';
        s.on('data', (d) => { got += d; });
        s.once('error', (e) => resolve(e.code));
        s.once('close', () => resolve(got));
        setTimeout(() => { s.destroy(); resolve('timeout'); }, 1500).unref();
      });
      assert.doesNotMatch(String(r), /X-Nexus-Egress/, `${addr} must not reach the proxy`);
    }
  });
});

// ---------------------------------------------------------------- HE9: bound to the live consent

test('HE9 the allow list is bound to the live consent\'s hosts_sha256: a mismatch (or no consent) refuses the start', async () => {
  assert.equal(canonicalHostsJson(ALLOW), '["api.anthropic.com:443"]');
  assert.equal(CONSENT, crypto.createHash('sha256').update('["api.anthropic.com:443"]', 'utf8').digest('hex'));
  // Canonical: order and duplicates do not change the hash; case is normalized.
  const two = [{ host: 'b.example.com', port: 443 }, { host: 'A.example.com', port: 443 }];
  assert.equal(hostsSha256(two), hostsSha256([...two].reverse().concat(two[0])));
  assert.equal(canonicalHostsJson(two), '["a.example.com:443","b.example.com:443"]');
  const other = hostsSha256([{ host: 'evil.example.com', port: 443 }]);
  for (const consent of [other, hostsSha256([{ ...API, port: 444 }]), undefined, null, '', 'x'.repeat(64), CONSENT.toUpperCase()]) {
    let called = 0;
    await assert.rejects(startHostEgressProxy({ allow: ALLOW, consentHostsSha256: consent, onDecision: () => { called++; }, imagesDir: IMAGES }),
      (e) => e instanceof HostEgressProxyError && e.code === 'consent_mismatch' && /consent_mismatch/.test(e.message), String(consent));
    assert.equal(called, 0);
  }
  // An extra host the consent did not grant: refused.
  await assert.rejects(startHostEgressProxy({ allow: [...ALLOW, { host: 'evil.example.com', port: 443 }], consentHostsSha256: CONSENT,
    onDecision: () => {}, imagesDir: IMAGES }), (e) => e.code === 'consent_mismatch');
  // The matching consent starts it.
  const p = await startHostEgressProxy({ allow: ALLOW, consentHostsSha256: CONSENT, onDecision: () => {}, imagesDir: IMAGES });
  await p.close();
  await p.close(); // idempotent
});
