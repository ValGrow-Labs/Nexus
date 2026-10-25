'use strict';
// B2b Task 6: the runner's loopback Streamable-HTTP MCP server (src/runner/mcpServer.ts) and the sandbox-exec relay
// wired into RunnerCore (src/runner/core.ts). Plain node: no Electron, no Docker, no database. A fake main answers
// `mcp.call` over the same in-process MessageChannel RunnerCore already uses; a fake driver stands in for Docker.
//
//   MS1  the Host header must name this server's own loopback port
//   MS2  a request carrying Origin is refused (browser requests never reach this server)
//   MS3  Content-Type must be application/json
//   MS4  a body over 1 MiB is refused
//   MS5  only POST /mcp is served
//   MS6  a malformed JSON-RPC message, and unparsable JSON, each get a JSON-RPC-shaped error
//   MS7  Accept lacking application/json -> 406
//   MS8  a notification -> 202 with no body
//   MS9  initialize negotiates the pinned protocol version and assigns Mcp-Session-Id
//   MS10 an error never echoes Authorization (or any other secret the tool result text might carry)
//   MS11 the full sandbox_exec flow: the CLI gets the redacted output, main hears only counts and a sha256
//   MS12 after close(), the port refuses connections
'use strict';
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { MessageChannel } = require('node:worker_threads');
const fsp = require('node:fs/promises');

const loadTs = require('./load-ts.cjs');
const { McpServer, MCP_PATH, MCP_PROTOCOL_VERSION, MCP_MAX_BODY_BYTES } = loadTs('src/runner/mcpServer.ts');
const { RunnerCore } = loadTs('src/runner/core.ts');
const { scrub, BEARER_TOKEN_RE } = loadTs('src/runner/logs.ts');
const { newId } = loadTs('src/main/nexus/db/ids.ts');

// ---------- small helpers ----------

/** A token shaped exactly like shared/nexus/tokens.ts's TOKEN_RE: 22 b64url chars, '.', 43 b64url chars. */
function fakeToken() { return `${crypto.randomBytes(16).toString('base64url')}.${crypto.randomBytes(32).toString('base64url')}`; }

function post(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'content-length': data.length, ...headers }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

function rawGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

const SERVERS = [];
after(async () => { for (const s of SERVERS) { try { await s.close(); } catch { /* already closed */ } } });

async function startServer(o = {}) {
  const s = await McpServer({
    onCall: o.onCall ?? (async (_callId, _bearer, tool) => ({ ok: true, value: { echoed: tool } })),
    onExecGrant: o.onExecGrant ?? (async () => ({ ok: true, value: { stdout: '', stderr: '', exit: { code: 0, oomKilled: false, finishedAt: 0 }, truncated: false } })),
    log: o.log
  });
  SERVERS.push(s);
  return s;
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '0' } } };

// ---------- MS1-MS6: transport hygiene ----------

test('MS1: the Host header must name this server\'s own loopback port', async () => {
  const s = await startServer();
  const r = await post(s.url, INIT, { host: 'evil.example.invalid:80' });
  assert.equal(r.status, 400);
  assert.equal(JSON.parse(r.text).error.code, -32600);
});

test('MS2: a request carrying Origin is refused', async () => {
  const s = await startServer();
  const r = await post(s.url, INIT, { origin: 'http://attacker.example.invalid' });
  assert.equal(r.status, 403);
});

test('MS3: Content-Type must be application/json', async () => {
  const s = await startServer();
  const r = await post(s.url, INIT, { 'content-type': 'text/plain' });
  assert.equal(r.status, 415);
});

test('MS4: a body over 1 MiB is refused', async () => {
  const s = await startServer();
  const big = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x', arguments: { pad: 'x'.repeat(MCP_MAX_BODY_BYTES + 1024) } } };
  const r = await post(s.url, big);
  assert.equal(r.status, 413);
});

test('MS5: only POST /mcp is served', async () => {
  const s = await startServer();
  const get = await rawGet(s.url);
  assert.equal(get.status, 405);
  assert.match(get.headers.allow, /POST/);
  const wrongPath = await post(s.url.replace(MCP_PATH, '/other'), INIT);
  assert.equal(wrongPath.status, 404);
});

test('MS6: a malformed JSON-RPC message and unparsable JSON each answer with a JSON-RPC error', async () => {
  const s = await startServer();
  const bad = await post(s.url, { id: 1, method: 'initialize' }); // no "jsonrpc": "2.0"
  assert.equal(bad.status, 200);
  const badBody = JSON.parse(bad.text);
  assert.equal(badBody.error.code, -32600);
  const notJson = await post(s.url, '{not json');
  assert.equal(notJson.status, 400);
  assert.equal(JSON.parse(notJson.text).error.code, -32700);
});

// ---------- MS7-MS10 ----------

test('MS7: Accept lacking application/json answers 406', async () => {
  const s = await startServer();
  const r = await post(s.url, INIT, { accept: 'text/event-stream' });
  assert.equal(r.status, 406);
  const none = await post(s.url, INIT, { accept: '' });
  assert.equal(none.status, 406);
});

test('MS8: a notification answers 202 with no body', async () => {
  const s = await startServer();
  const r = await post(s.url, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(r.status, 202);
  assert.equal(r.text, '');
});

test('MS9: initialize negotiates the pinned protocol version and assigns Mcp-Session-Id', async () => {
  const s = await startServer();
  const r = await post(s.url, INIT);
  assert.equal(r.status, 200);
  const body = JSON.parse(r.text);
  assert.equal(body.result.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.match(r.headers['mcp-session-id'], /^[0-9a-f-]{36}$/);
  // a second initialize gets a fresh session id (assigned per turn, not fixed for the server's life)
  const r2 = await post(s.url, INIT);
  assert.notEqual(r2.headers['mcp-session-id'], r.headers['mcp-session-id']);
});

test('MS10: an error never echoes Authorization, and a tool result scrubs a bearer-shaped value', async () => {
  const sentinel = 'Bearer NOT-A-TOKEN-SHAPE-SECRET';
  const s = await startServer();
  // A malformed bearer: the server answers without ever naming it.
  const call = await post(s.url, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'context_get', arguments: {} } }, { authorization: sentinel });
  assert.equal(call.status, 200);
  assert.ok(!call.text.includes(sentinel), 'the malformed Authorization header never appears in the response');
  assert.equal(JSON.parse(call.text).result.isError, true);

  // A tool failure whose message happens to carry a real-shaped token: scrub() strips it before it ever leaves.
  const token = fakeToken();
  const s2 = await startServer({ onCall: async () => ({ ok: false, code: 'denied', message: `refused for Bearer ${token}` }) });
  const r2 = await post(s2.url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'context_get' } }, { authorization: `Bearer ${fakeToken()}` });
  assert.ok(!r2.text.includes(token), 'a bearer-shaped value in a tool result is redacted');
  assert.match(r2.text, /\[redacted\]/);
  assert.ok(BEARER_TOKEN_RE.test(`x ${token} y`), 'sanity: the token really is bearer-shaped');
  assert.equal(scrub(`Bearer ${token}`), 'Bearer [redacted]');
});

// ---------- MS12 ----------

test('MS12: after close(), the port refuses connections', async () => {
  const s = await McpServer({ onCall: async () => ({ ok: true, value: null }), onExecGrant: async () => ({ ok: true, value: null }) });
  await s.close();
  await assert.rejects(post(s.url, INIT), /ECONNREFUSED/);
});

// ---------- RunnerCore wiring: hello starts the server and reports mcpUrl; mcp.call/mcp.reply relay ----------

const WORLDS = [];
after(async () => { for (const w of WORLDS) { try { await w.core.shutdown(); } catch { /* best effort */ } try { w.port1.close(); } catch { /* closed */ } } });

async function until(pred, what, ms = 5000) {
  const t0 = Date.now();
  for (;;) { if (pred()) return; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 2)); }
}

/** A RunnerCore + fake driver + fake main over an in-process MessageChannel. `onMcpCall(msg)`, if given, auto-answers
 *  a relayed `mcp.call` with the `McpReplyResult` it returns (or undefined to leave it pending). */
async function world(o = {}) {
  const driver = o.driver ?? { exec: async () => ({ exit: { code: 0, oomKilled: false, finishedAt: 0 }, stdout: '', stderr: '', truncated: false }) };
  const { port1, port2 } = new MessageChannel();
  const got = [];
  port1.on('message', (m) => {
    got.push(m);
    if (m.op === 'mcp.call' && typeof o.onMcpCall === 'function') {
      const result = o.onMcpCall(m);
      if (result) port1.postMessage({ op: 'mcp.reply', callId: m.callId, result });
    }
  });
  const logs = [];
  const core = new RunnerCore(port2, { driver, now: () => Date.now(), fs: fsp, log: (l) => logs.push(l) });
  const w = {
    core, got, logs, port1, port2,
    send: (m) => port1.postMessage(m),
    one: (op) => got.find((m) => m.op === op),
    of: (op) => got.filter((m) => m.op === op)
  };
  WORLDS.push(w);
  w.send({ op: 'hello', bootId: newId(Date.now()), dataHome: '', home: '', profiles: [] });
  await until(() => w.one('ready') !== undefined, 'ready');
  return w;
}

test('CORE1: hello starts the loopback server and reports a well-formed mcpUrl in ready', async () => {
  const w = await world();
  const ready = w.one('ready');
  assert.match(ready.mcpUrl, /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/mcp$/);
  const r = await post(ready.mcpUrl, INIT);
  assert.equal(r.status, 200);
});

test('CORE2: a second hello replaces the server (the old port stops answering) and reports a fresh one', async () => {
  const w = await world();
  const first = w.one('ready').mcpUrl;
  w.send({ op: 'hello', bootId: newId(Date.now()), dataHome: '', home: '', profiles: [] });
  await until(() => w.of('ready').length === 2, 'a second ready');
  const second = w.of('ready')[1].mcpUrl;
  assert.notEqual(first, second);
  await assert.rejects(post(first, INIT), /ECONNREFUSED/);
  assert.equal((await post(second, INIT)).status, 200);
});

test('CORE3: tools/call relays mcp.call to main and answers with main\'s reply', async () => {
  const w = await world({ onMcpCall: (m) => (m.tool === 'context_get' ? { ok: true, value: { part: 'hello' } } : { ok: false, code: 'unknown_tool', message: 'no' }) });
  const bearer = fakeToken();
  const r = await post(w.one('ready').mcpUrl, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'context_get', arguments: { part: 'x' } } }, { authorization: `Bearer ${bearer}` });
  const body = JSON.parse(r.text);
  assert.equal(body.result.isError, false);
  assert.deepEqual(JSON.parse(body.result.content[0].text), { part: 'hello' });
  const call = w.one('mcp.call');
  assert.equal(call.tool, 'context_get');
  assert.equal(call.bearer, bearer);
  assert.deepEqual(call.args, { part: 'x' });
});

test('CORE4: a sandbox_exec grant for a bearer with no bound turn is refused (defence in depth), never run', async () => {
  const execCalls = [];
  const w = await world({
    driver: { exec: async (...args) => { execCalls.push(args); return { exit: { code: 0, oomKilled: false, finishedAt: 0 }, stdout: '', stderr: '', truncated: false }; } },
    onMcpCall: () => ({ ok: true, value: { grant: { execId: 'exec-core4-001', argv: ['echo', 'hi'], cwd: '/workspace', timeoutMs: 5000 } } })
  });
  const bearer = fakeToken(); // never bound via core.bindAgentTurn
  const r = await post(w.one('ready').mcpUrl, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'sandbox_exec', arguments: { argv: ['echo', 'hi'], cwd: '/workspace', timeoutMs: 5000 } } }, { authorization: `Bearer ${bearer}` });
  const body = JSON.parse(r.text);
  assert.equal(body.result.isError, true);
  assert.equal(execCalls.length, 0, 'the runner never ran the command for an unbound bearer');
  assert.equal(w.of('agent.exec.done').length, 0);
});

test('MS11: the full sandbox_exec flow — the CLI gets the redacted output, main hears only counts and a sha256', async () => {
  const secret = fakeToken();
  const attemptId = newId(Date.now());
  const containerId = crypto.randomBytes(32).toString('hex');
  const execId = 'exec-ms11-001';
  const stdout = `build ok, token=${secret}\n`;
  const stderr = 'a warning';
  const execCalls = [];
  const w = await world({
    driver: {
      exec: async (cid, argv, o) => {
        execCalls.push({ cid, argv, o });
        return { exit: { code: 0, oomKilled: false, finishedAt: 1234 }, stdout, stderr, truncated: false };
      }
    },
    onMcpCall: (m) => {
      if (m.tool !== 'sandbox_exec') return { ok: false, code: 'unknown_tool', message: 'no' };
      return { ok: true, value: { grant: { execId, argv: m.args.argv, cwd: m.args.cwd, timeoutMs: m.args.timeoutMs } } };
    }
  });
  const bearer = fakeToken();
  w.core.bindAgentTurn(bearer, attemptId, containerId);

  const r = await post(w.one('ready').mcpUrl, {
    jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: { name: 'sandbox_exec', arguments: { argv: ['node', 'build.js'], cwd: '/workspace', timeoutMs: 5000 } }
  }, { authorization: `Bearer ${bearer}` });

  const body = JSON.parse(r.text);
  assert.equal(body.result.isError, false);
  const value = JSON.parse(body.result.content[0].text);
  assert.ok(!value.stdout.includes(secret), 'the agent never gets the raw secret back');
  assert.match(value.stdout, /\[redacted\]/);
  assert.equal(value.stderr, stderr);
  assert.equal(value.exit.code, 0);

  // the runner ran the exec in exactly the bound container, capped at the sandbox_exec output bound
  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0].cid, containerId);
  assert.deepEqual(execCalls[0].argv, ['node', 'build.js']);
  assert.equal(execCalls[0].o.timeoutMs, 5000);

  // main hears only agent.exec.done: counts and a sha256 of the RAW stdout, never its text
  const done = w.one('agent.exec.done');
  assert.ok(done, 'main was told the exec finished');
  assert.equal(done.attemptId, attemptId);
  assert.equal(done.execId, execId);
  assert.equal(done.stdoutBytes, Buffer.byteLength(stdout, 'utf8'));
  assert.equal(done.stderrBytes, Buffer.byteLength(stderr, 'utf8'));
  assert.equal(done.stdoutSha256, crypto.createHash('sha256').update(stdout, 'utf8').digest('hex'));
  assert.ok(!JSON.stringify(done).includes(secret), 'the message to main never carries the output text');

  // mcp.call bodies are never logged: the runner's own log callback never saw the bearer or the argv/secret.
  const logText = w.logs.join('\n');
  assert.ok(!logText.includes(bearer), 'the bearer never reaches the log');
  assert.ok(!logText.includes(secret), 'the exec output never reaches the log');
  assert.ok(!logText.includes('build.js'), 'the call\'s arguments never reach the log');
});
