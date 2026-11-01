'use strict';
// The hosted-model runtime (kind `hosted-model`, src/runner/runtimes/hostedModel): the AgentRuntime contract through its OpenAI-style
// chat client, the free tier's error mapping, the key's hygiene, the destination rule (the chosen provider's host only, https only,
// through the host egress proxy, no redirect) and its offline probe. Plain node: the provider is a MOCK on loopback
// (test/helpers/mockOpenAiServer.cjs), the proxy is a fake CONNECT proxy or the real host egress proxy with a fake resolver, the
// runner's MCP server is a recorder (test/helpers/mcpRecorder.cjs). No real key, no real provider, no network beyond 127.0.0.1.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const net = require('node:net');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');

const loadTs = require('./load-ts.cjs');
const mock = require('./helpers/mockOpenAiServer.cjs');
const recorder = require('./helpers/mcpRecorder.cjs');
const { collect, assertRuntimeContract } = require('./helpers/runtimeContract.cjs');

const ROOT = path.resolve(__dirname, '..');
const adapterMod = loadTs('src/runner/runtimes/hostedModel/adapter.ts');
const clientMod = loadTs('src/runner/runtimes/hostedModel/client.ts');
const transportMod = loadTs('src/runner/runtimes/hostedModel/transport.ts');
const presetsMod = loadTs('src/runner/runtimes/hostedModel/presets.ts');
const { MSG } = loadTs('src/runner/runtimes/hostedModel/messages.ts');
const registry = loadTs('src/runner/runtimes/registry.ts');
const { RuntimeProber } = loadTs('src/runner/runtimes/probe.ts');
const { startHostEgressProxy, hostsSha256 } = loadTs('src/runner/hostEgressProxy.ts');
const { parseRunnerMessage, isRuntimeApiKey, RUNTIME_API_KEY_RE } = loadTs('src/shared/nexus/runnerProtocol.ts');
const { MODEL_NAME_RE } = loadTs('src/shared/nexus/localModel.ts');
const { createHostedModelAdapter, HOSTED_MODEL_KIND, ADAPTER_LABEL } = adapterMod;
const { PROVIDER_PRESETS, presetFor, allPresetHosts } = presetsMod;

const TOKEN = `${'h'.repeat(22)}.${'i'.repeat(43)}`;
/** Not a key of any provider: a made-up string of the accepted shape. */
const KEY = 'testkey-Zq8mV3nR7pLx2WcD5aHb';
const GROQ = presetFor('groq');
const GEMINI = presetFor('gemini');
const MODEL = GROQ.defaultModel;

const TMP = [];
after(() => { for (const d of TMP) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ } } });
const tmpDir = (p = 'nx-hm-') => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); TMP.push(d); return d; };

// ---------------------------------------------------------------- helpers

const MCP_TOOLS = [
  { name: 'context_get', description: 'context', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'sandbox_exec', description: 'sandbox exec', inputSchema: { type: 'object', properties: {
    argv: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' }, timeoutMs: { type: 'integer' } }, required: ['argv', 'timeoutMs'] } },
  { name: 'changeset_register', description: 'register', inputSchema: { type: 'object', properties: {
    title: { type: 'string' }, summary: { type: 'string' }, clientKey: { type: 'string' } }, required: ['title', 'summary', 'clientKey'] } }
];

/** A turn's world: a worktree, a config dir, a context file, a mock provider and a recording MCP server. */
async function world(modelOpts = {}, mcpOpts = {}) {
  const root = tmpDir();
  const wt = path.join(root, 'wt');
  const cfg = path.join(root, 'job');
  fs.mkdirSync(wt); fs.mkdirSync(cfg);
  fs.writeFileSync(path.join(cfg, 'context.md'), '## context\nbuild a tiny add function\n');
  const model = await mock.start(modelOpts);
  const mcp = await recorder.start({ tools: MCP_TOOLS, ...mcpOpts });
  const logs = [];
  const sleeps = [];
  return { root, wt, cfg, model, mcp, logs, sleeps, async stop() { await model.stop(); await mcp.stop(); } };
}

const req = (w, over = {}) => ({
  jobId: 'j1', attempt: 1, sessionId: 's1', idempotencyKey: 'k1', domainId: 'd1', skills: [],
  context: { hash: 'h'.repeat(64), file: path.join(w.cfg, 'context.md') }, message: 'Write add(a, b) in src/add.js and test it.',
  worktree: { hostPath: w.wt, editable: ['/workspace'] }, container: { id: 'c1' }, mcp: { url: w.mcp.url },
  model: { provider: 'groq', model: MODEL }, limits: { wallClockMs: 60_000, maxTurns: 30 }, credential: { ref: 'runtime-owned' }, configDir: w.cfg, ...over
});
const GROQ_HOSTS = [{ host: GROQ.host, port: 443 }];
/** The test adapter: the loopback mock stands in for the provider through the seam; the production target check and refusals run unchanged. */
const adapter = (w, over = {}) => createHostedModelAdapter({
  token: TOKEN, mcpUrl: w.mcp.url, apiKey: KEY, consentedHosts: GROQ_HOSTS, seam: { plain: { host: '127.0.0.1', port: w.model.port } },
  sleep: async (ms) => { w.sleeps.push(ms); }, backoff: { baseMs: 10 }, log: (l) => w.logs.push(l), ...over
});
const run = async (w, script, { reqOver, adOver, signal } = {}) => {
  w.model.setScript(script);
  return collect(adapter(w, adOver), req(w, reqOver), signal);
};
const call = (name, args) => ({ calls: [{ name, args }] });
const terminal = (events) => events[events.length - 1];
const bytesOf = (x) => JSON.stringify(x);
const until = async (pred, ms = 5000) => { const t0 = Date.now(); while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10)); };

// ---------------------------------------------------------------- HM1 happy path

test('HM1 a turn writes files on the host, runs a command and registers the change through the runner MCP server; events pair up, one terminal, usage is the provider\'s own and free', async () => {
  const w = await world();
  try {
    const events = await run(w, [
      call('write_file', { path: 'src/add.js', content: 'exports.add = (a, b) => a + b;\n' }),
      call('write_file', { path: 'test/add.test.js', content: 'const { add } = require("../src/add");\nif (add(1, 2) !== 3) process.exit(1);\n' }),
      call('sandbox_exec', { argv: ['node', 'test/add.test.js'], cwd: '/workspace', timeoutMs: 60000 }),
      call('changeset_register', { title: 'add', summary: 'adds add()', clientKey: 'cs1' }),
      { text: 'Done.' }
    ]);
    assertRuntimeContract(events, { terminal: 'run.completed' });
    assert.equal(terminal(events).stopReason, 'end_turn');
    assert.equal(fs.readFileSync(path.join(w.wt, 'src', 'add.js'), 'utf8'), 'exports.add = (a, b) => a + b;\n');
    assert.ok(fs.existsSync(path.join(w.wt, 'test', 'add.test.js')));
    // The MCP server saw the two runner calls, in order, each with the bearer (and only the bearer: never the provider key).
    const calls = w.mcp.calls();
    assert.deepEqual(calls.map((c) => c.params.name), ['sandbox_exec', 'changeset_register']);
    for (const r of w.mcp.records) assert.equal(r.headers.authorization, `Bearer ${TOKEN}`);
    // Event order: per model call a usage, the tool events in call order, strictly paired.
    assert.deepEqual(events.filter((e) => e.t === 'tool.started').map((e) => e.tool), ['write_file', 'write_file', 'sandbox_exec', 'changeset_register']);
    for (const e of events.filter((x) => x.t === 'tool.completed')) assert.equal(e.ok, true);
    assert.equal(events[0].t, 'run.started');
    const usage = events.filter((e) => e.t === 'usage');
    const last = usage[usage.length - 1];
    assert.equal(last.inputTokens, 50, 'five model calls x 10 prompt tokens, as the provider counted');
    assert.equal(last.outputTokens, 25);
    assert.equal(last.costUsdCents, 0, 'a free tier costs nothing');
    assert.equal(last.estimated, false);
    assert.equal(last.toolCalls, 4);
    // The provider was offered the file tools and the runner's tools, once each, in the wire shape.
    const first = w.model.chatRecords()[0];
    assert.equal(first.method, 'POST');
    assert.equal(first.url, `${GROQ.basePath}/chat/completions`);
    assert.equal(first.headers.host, GROQ.host, 'the provider\'s own name is the Host, whatever the seam connected to');
    assert.equal(first.headers.authorization, `Bearer ${KEY}`);
    assert.deepEqual(first.json.tools.map((t) => t.function.name), ['read_file', 'write_file', 'list_files', 'delete_file', 'context_get', 'sandbox_exec', 'changeset_register']);
    assert.ok(first.json.tools.every((t) => t.type === 'function'));
    assert.equal(first.json.stream, false);
    assert.equal(first.json.tool_choice, 'auto');
    assert.equal(first.json.model, MODEL);
    assert.equal(first.json.messages[0].role, 'system');
    assert.match(first.json.messages[0].content, /sandbox_exec/);
    assert.match(first.json.messages[1].content, /build a tiny add function/);
    // The second request carries the first call as an assistant message with ids and JSON-text arguments, answered by a tool message with the same id.
    const second = w.model.chats()[1].messages;
    const asst = second[2];
    assert.equal(asst.role, 'assistant');
    assert.equal(asst.tool_calls.length, 1);
    assert.equal(asst.tool_calls[0].type, 'function');
    assert.equal(typeof asst.tool_calls[0].function.arguments, 'string');
    assert.equal(JSON.parse(asst.tool_calls[0].function.arguments).path, 'src/add.js');
    assert.equal(second[3].role, 'tool');
    assert.equal(second[3].tool_call_id, asst.tool_calls[0].id);
    assert.deepEqual(fs.readdirSync(path.join(w.wt, 'src')), ['add.js'], 'no temporary file is left behind');
  } finally { await w.stop(); }
});

test('HM2 the other provider: its own host, base path and quirks (schema keys it rejects removed, the tool name on a tool result) from the preset table', async () => {
  const w = await world();
  try {
    const events = await run(w, [call('context_get', {}), { text: 'done' }], {
      reqOver: { model: { provider: 'gemini', model: GEMINI.defaultModel } }, adOver: { consentedHosts: [{ host: GEMINI.host, port: 443 }] } });
    assertRuntimeContract(events, { terminal: 'run.completed' });
    const [first, second] = w.model.chatRecords();
    assert.equal(first.url, `${GEMINI.basePath}/chat/completions`);
    assert.equal(first.headers.host, GEMINI.host);
    assert.equal(first.json.model, GEMINI.defaultModel);
    const ctxTool = first.json.tools.find((t) => t.function.name === 'context_get');
    assert.equal('additionalProperties' in ctxTool.function.parameters, false, 'stripped for this provider');
    const toolMsg = second.json.messages.find((m) => m.role === 'tool');
    assert.equal(toolMsg.name, 'context_get');
    // The first provider keeps the schema as it is and sends no tool name.
    const w2 = await world();
    try {
      await run(w2, [call('context_get', {}), { text: 'done' }]);
      const [g1, g2] = w2.model.chatRecords();
      assert.equal(g1.json.tools.find((t) => t.function.name === 'context_get').function.parameters.additionalProperties, false);
      assert.equal('name' in g2.json.messages.find((m) => m.role === 'tool'), false);
    } finally { await w2.stop(); }
  } finally { await w.stop(); }
});

// ---------------------------------------------------------------- cancel and caps

test('HM3 cancel: aborting during a model call, during a backoff wait and via cancel() ends the turn with run.cancelled once; an abort before the start never reaches the provider', async () => {
  const w = await world();
  try {
    const ac = new AbortController();
    w.model.setScript([{ hang: true }]);
    const p = collect(adapter(w), req(w), ac.signal);
    await until(() => w.model.chats().length > 0);
    assert.equal(w.model.chats().length, 1);
    ac.abort();
    assertRuntimeContract(await p, { terminal: 'run.cancelled' });
    // Already aborted: a start and a cancel, no request.
    const before = w.model.requests.length;
    const pre = new AbortController(); pre.abort();
    assert.deepEqual((await collect(adapter(w), req(w), pre.signal)).map((e) => e.t), ['run.started', 'run.cancelled']);
    assert.equal(w.model.requests.length, before);
    // cancel() ends a running turn the same way.
    w.model.setScript([{ hang: true }]);
    const base2 = w.model.chats().length;
    const ad2 = adapter(w);
    const p2 = collect(ad2, req(w));
    await until(() => w.model.chats().length > base2);
    await ad2.cancel('r', 0);
    assertRuntimeContract(await p2, { terminal: 'run.cancelled' });
    // During the wait between retries: a real wait (a long Retry-After) that the signal ends at once.
    w.model.setScript([{ status: 429, retryAfter: 30 }]);
    const base3 = w.model.chats().length;
    const ac3 = new AbortController();
    const realSleep = (ms, signal) => new Promise((r) => { const t = setTimeout(r, ms); signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });
    const p3 = collect(adapter(w, { sleep: realSleep }), req(w), ac3.signal);
    await until(() => w.model.chats().length > base3);
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    ac3.abort();
    const ev3 = await p3;
    assertRuntimeContract(ev3, { terminal: 'run.cancelled' });
    assert.ok(Date.now() - t0 < 2000, 'the wait did not outlive the cancel');
  } finally { await w.stop(); }
});

test('HM4 caps: wall clock, model calls, tool calls, tokens and the 200-call ceiling each end the turn failed limit', async () => {
  const w = await world();
  try {
    let events = await run(w, [{ hang: true }], { reqOver: { limits: { wallClockMs: 1200, maxTurns: 10 } } });
    assertRuntimeContract(events, { terminal: 'run.failed' });
    assert.equal(terminal(events).code, 'limit');
    assert.match(terminal(events).message, /wall clock/);
    events = await run(w, (_b, i) => call('write_file', { path: `f${i}.txt`, content: String(i) }), { reqOver: { limits: { wallClockMs: 60_000, maxTurns: 3 } } });
    assert.equal(terminal(events).code, 'limit');
    assert.match(terminal(events).message, /model-call limit/);
    assert.equal(events.filter((e) => e.t === 'tool.started').length, 3);
    events = await run(w, [{ calls: [1, 2, 3].map((n) => ({ name: 'write_file', args: { path: `g${n}.txt`, content: 'x' } })) }], { adOver: { caps: { toolCalls: 2 } } });
    assert.equal(terminal(events).code, 'limit');
    assert.match(terminal(events).message, /tool-call cap/);
    assert.ok(!fs.existsSync(path.join(w.wt, 'g3.txt')), 'the call over the cap did not run');
    // Tokens: 15 per model call (the provider's counts), cap 20 -> the second call goes over.
    events = await run(w, (_b, i) => call('write_file', { path: `t${i}.txt`, content: 'x' }), { adOver: { caps: { turnTokens: 20 } } });
    assert.equal(terminal(events).code, 'limit');
    assert.match(terminal(events).message, /token cap/);
    assert.equal(events.filter((e) => e.t === 'usage').pop().inputTokens, 20);
    events = await run(w, (_b, i) => call('list_files', { path: `nope${i}` }), { adOver: { caps: { toolCalls: 100000 } }, reqOver: { limits: { wallClockMs: 120_000, maxTurns: 1000 } } });
    assert.equal(terminal(events).code, 'limit');
    assert.match(terminal(events).message, /tool-call cap/);
    assert.equal(events.filter((e) => e.t === 'tool.started').length, 200);
    assertRuntimeContract(events, { terminal: 'run.failed' });
  } finally { await w.stop(); }
});

// ---------------------------------------------------------------- weak models (the shared loop)

test('HM5 weak-model paths reach the provider as the same corrective messages: malformed and unknown calls, JSON written as text, a tool call the provider could not format, empty replies', async () => {
  const w = await world();
  try {
    let events = await run(w, [call('write_file', 'not json {'), call('launch_missiles', { x: 1 }), call('write_file', { path: 'ok.txt', content: 'fine' }), { text: 'done' }]);
    assertRuntimeContract(events, { terminal: 'run.completed' });
    assert.deepEqual(events.filter((e) => e.t === 'tool.completed').map((e) => e.ok), [false, false, true, true], 'the last true is Nexus handing in the written file');
    const toolMsgs = w.model.chats().flatMap((b) => b.messages).filter((m) => m.role === 'tool').map((m) => m.content);
    assert.ok(toolMsgs.some((m) => /must be a JSON object/.test(m)));
    assert.ok(toolMsgs.some((m) => /no tool named "launch_missiles"/.test(m)));
    // A call written as JSON in the text is run as that call.
    events = await run(w, [{ text: '```json\n{"name": "write_file", "arguments": {"path": "x.txt", "content": "from text"}}\n```' }, { text: 'all set' }]);
    assertRuntimeContract(events, { terminal: 'run.completed' });
    assert.equal(fs.readFileSync(path.join(w.wt, 'x.txt'), 'utf8'), 'from text');
    // Names and arguments near a miss are repaired.
    events = await run(w, [call('functions.write_file', JSON.stringify({ path: 'a.txt', content: 'one' })), call('sandbox_exec', { argv: '["echo","hi"]', timeoutMs: '60000', cwd: '/workspace' }), { text: 'ok' }]);
    assert.deepEqual(w.mcp.calls().filter((c) => c.params.name === 'sandbox_exec').pop().params.arguments, { argv: ['echo', 'hi'], timeoutMs: 60000, cwd: '/workspace' });
    // The provider answers 400 tool_use_failed (it could not parse the model's call): retried twice at once, then handed over as an empty reply
    // (nudged, never shown), and the turn goes on with the next reply.
    events = await run(w, [{ status: 400, code: 'tool_use_failed' }, { status: 400, code: 'tool_use_failed' }, call('write_file', { path: 'k.txt', content: 'recovered' }), { text: 'fin' }]);
    assertRuntimeContract(events, { terminal: 'run.completed' });
    assert.equal(fs.readFileSync(path.join(w.wt, 'k.txt'), 'utf8'), 'recovered');
    assert.equal(w.sleeps.length, 0, 'a badly formed call is retried at once, without a wait');
    const w3 = w.model.chats().length;
    events = await run(w, [{ status: 400, code: 'tool_use_failed' }, { status: 400, code: 'tool_use_failed' }, { status: 400, code: 'tool_use_failed' }, { text: 'recovered later' }]);
    assertRuntimeContract(events, { terminal: 'run.completed' });
    assert.ok(w.model.chats().length - w3 >= 4);
    assert.match(w.model.chats().flatMap((b) => b.messages).filter((m) => m.role === 'user').slice(-1)[0].content, /reply was empty|did not call a tool/);
    // Three empty replies with no tool used: the turn fails protocol.
    events = await run(w, [{ text: '' }, { text: '' }, { text: '' }, { text: 'never reached' }]);
    assert.equal(terminal(events).code, 'protocol');
    // Six identical calls in a row, and a call that keeps failing, end the turn protocol.
    events = await run(w, () => call('read_file', { path: 'missing.txt' }));
    assert.equal(terminal(events).code, 'protocol');
  } finally { await w.stop(); }
});

// ---------------------------------------------------------------- the free tier (H4)

const FAIL = (events) => { assertRuntimeContract(events, { terminal: 'run.failed' }); return terminal(events); };

test('HM6a a rejected key ends the turn auth (401 and 403), a missing model is the model sentence, a refused request its own: no retry, and the provider\'s text is never shown', async () => {
  const w = await world();
  try {
    for (const status of [401, 403]) {
      const before = w.model.chats().length;
      const events = await run(w, [{ status }]);
      const f = FAIL(events);
      assert.equal(f.code, 'auth');
      assert.equal(f.message, MSG.keyRejected);
      assert.equal(w.model.chats().length - before, 1, 'one request, no retry');
      assert.ok(!bytesOf(events).includes(mock.SECRET_TEXT));
    }
    // The mock behaves like the provider: a wrong key is a 401 of its own accord (requireKey).
    const strict = await world({ requireKey: 'some-other-key-0000' });
    try {
      const f = FAIL(await run(strict, [{ text: 'x' }]));
      assert.equal(f.code, 'auth');
      assert.equal(f.message, MSG.keyRejected);
    } finally { await strict.stop(); }
    let f = FAIL(await run(w, [{ status: 404 }]));
    assert.deepEqual([f.code, f.message], ['runtime_error', MSG.modelUnavailable]);
    f = FAIL(await run(w, [{ status: 400, code: 'model_not_found' }]));
    assert.deepEqual([f.code, f.message], ['runtime_error', MSG.modelUnavailable]);
    f = FAIL(await run(w, [{ status: 400, code: 'model_decommissioned' }]));
    assert.equal(f.message, MSG.modelUnavailable);
    f = FAIL(await run(w, [{ status: 400, code: 'invalid_request_error' }]));
    assert.deepEqual([f.code, f.message], ['runtime_error', MSG.refused]);
    f = FAIL(await run(w, [{ status: 418 }]));
    assert.equal(f.message, MSG.server(418));
    for (const m of [MSG.keyRejected, MSG.modelUnavailable, MSG.refused]) assert.ok(!/SECRET|quota details|\/home/.test(m));
  } finally { await w.stop(); }
});

test('HM6b 429 and 5xx: bounded backoff that honours Retry-After (counted against the wall clock); exhausted quota, a wait that does not fit and persistent errors end the turn with fixed sentences', async () => {
  const w = await world();
  try {
    // Retry-After honoured to the millisecond (seconds, fractions), then the turn goes on.
    let events = await run(w, [{ status: 429, retryAfter: 2 }, { status: 429, retryAfter: '1.5' }, { text: 'fine' }]);
    assertRuntimeContract(events, { terminal: 'run.completed' });
    assert.deepEqual(w.sleeps, [2000, 1500]);
    assert.equal(events.filter((e) => e.t === 'usage').pop().inputTokens >= 10, true, 'the answered call counted, the refused ones did not');
    // No Retry-After: doubling from the base, at most four retries, then the rate sentence with `limit`.
    w.sleeps.length = 0;
    let f = FAIL(await run(w, () => ({ status: 429 })));
    assert.deepEqual([f.code, f.message], ['limit', MSG.rateLimited]);
    assert.deepEqual(w.sleeps, [10, 20, 40, 80]);
    // The daily quota is gone: its own sentence at once, no wait.
    w.sleeps.length = 0;
    const before = w.model.chats().length;
    f = FAIL(await run(w, [{ status: 429, message: 'Rate limit reached for model on tokens per day (TPD): Limit 100000' }]));
    assert.deepEqual([f.code, f.message], ['limit', MSG.quotaExhausted]);
    assert.equal(w.model.chats().length - before, 1);
    assert.deepEqual(w.sleeps, []);
    f = FAIL(await run(w, [{ status: 429, body: { error: { code: 'insufficient_quota', message: 'x' } } }]));
    assert.equal(f.message, MSG.quotaExhausted);
    // The per-minute limit of the other provider says "quota" too, but it is not the daily one: it is waited out.
    w.sleeps.length = 0;
    events = await run(w, [{ status: 429, retryAfter: 1, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota, please check your plan and billing details.' } } }, { text: 'fine' }]);
    assertRuntimeContract(events, { terminal: 'run.completed' });
    assert.deepEqual(w.sleeps, [1000]);
    // A wait longer than the honoured maximum, or one that would pass the wall clock, ends the turn instead of sleeping.
    w.sleeps.length = 0;
    f = FAIL(await run(w, [{ status: 429, retryAfter: 3600 }]));
    assert.deepEqual([f.code, f.message], ['limit', MSG.rateLimited]);
    f = FAIL(await run(w, [{ status: 429, retryAfter: 5 }], { reqOver: { limits: { wallClockMs: 3000, maxTurns: 10 } } }));
    assert.deepEqual([f.code, f.message], ['limit', MSG.rateLimited]);
    assert.deepEqual(w.sleeps, [], 'nothing slept past the turn');
    // An HTTP-date Retry-After is read too.
    assert.ok(Math.abs(clientMod.retryAfterMs(new Date(Date.now() + 3000).toUTCString(), Date.now()) - 3000) < 1500);
    // 5xx: a transient one is retried, a persistent one ends the turn with the status named.
    w.sleeps.length = 0;
    events = await run(w, [{ status: 500 }, { status: 503, retryAfter: 1 }, { text: 'fine' }]);
    assertRuntimeContract(events, { terminal: 'run.completed' });
    assert.deepEqual(w.sleeps, [10, 1000]);
    w.sleeps.length = 0;
    f = FAIL(await run(w, () => ({ status: 502 })));
    assert.deepEqual([f.code, f.message], ['runtime_error', MSG.server(502)]);
    assert.deepEqual(w.sleeps, [10, 20, 40]);
    assert.ok(!bytesOf(f).includes(mock.SECRET_TEXT));
  } finally { await w.stop(); }
});

test('HM6c a context that is too long is trimmed in the turn\'s history and retried ONCE; a second time it ends the turn with its own sentence', async () => {
  const w = await world({}, { onCall: () => 'x'.repeat(5000) });
  try {
    const sizes = [];
    let events = await run(w, [call('context_get', {}), call('context_get', {}), call('context_get', {}), { status: 400, code: 'context_length_exceeded', message: 'maximum context length is 8192 tokens' }, { text: 'done' }],
      { adOver: { tuning: { toolResultMaxChars: 6000 } } });
    assertRuntimeContract(events, { terminal: 'run.completed' });
    for (const r of w.model.chatRecords()) sizes.push(r.body.length);
    // calls: 3 tool calls, the too-long answer (index 3), the retry (index 4, smaller), then the nudges of a talking reply.
    assert.ok(sizes[4] < sizes[3], `the retry is smaller (${sizes[3]} -> ${sizes[4]})`);
    assert.ok(w.model.chats()[4].messages.some((m) => /earlier output omitted/.test(m.content)));
    assert.ok(w.logs.some((l) => /trimmed once/.test(l)));
    // 413 (the other spelling of too large) is handled the same; twice in a row is the fixed sentence.
    const f = FAIL(await run(w, [{ status: 413 }, { status: 413 }]));
    assert.deepEqual([f.code, f.message], ['runtime_error', MSG.contextTooLong]);
    // The trim keeps the system prompt and the task, and never leaves a tool result without its call.
    const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'task' }];
    for (let i = 0; i < 6; i++) { msgs.push({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: {} } }] }); msgs.push({ role: 'tool', content: 'y'.repeat(900) }); }
    assert.equal(clientMod.trimHistory(msgs), true);
    assert.equal(msgs[0].content, 's'); assert.equal(msgs[1].content, 'task');
    assert.equal(msgs[2].role, 'user');
    assert.notEqual(msgs[3].role, 'tool', 'the cut does not strand a tool result');
    const wire = clientMod.toWireMessages(msgs, {});
    for (const m of wire) if (m.role === 'tool') assert.ok(wire.some((a) => a.tool_calls?.some((c) => c.id === m.tool_call_id)), 'every tool result has its call');
  } finally { await w.stop(); }
});

test('HM6d transport failures are fixed sentences: oversize and unreadable answers, a redirect (never followed), a hung provider; none carries the provider\'s text', async () => {
  const w = await world();
  const other = await mock.start({});
  try {
    let f = FAIL(await run(w, [{ huge: 5 * 1024 * 1024 }]));
    assert.equal(f.message, MSG.tooLarge);
    f = FAIL(await run(w, [{ malformed: true }]));
    assert.equal(f.message, MSG.badJson);
    f = FAIL(await run(w, [{ raw: { choices: [] } }]));
    assert.equal(f.message, MSG.badJson);
    f = FAIL(await run(w, [{ redirect: `${other.url}/openai/v1/chat/completions` }]));
    assert.equal(f.message, MSG.redirect);
    f = FAIL(await run(w, [{ redirect: 'https://elsewhere.invalid/x', status: 307 }]));
    assert.equal(f.message, MSG.redirect);
    assert.equal(other.requests.length, 0, 'the redirect target was never contacted');
    f = FAIL(await run(w, [{ hang: true }], { adOver: { tuning: { chatTimeoutMs: 1000 } } }));
    assert.deepEqual([f.code, f.message], ['runtime_error', MSG.timeout]);
    // A provider that is simply not there.
    const dead = await mock.start({}); const deadPort = dead.port; await dead.stop();
    f = FAIL(await collect(adapter(w, { seam: { plain: { host: '127.0.0.1', port: deadPort } } }), req(w)));
    assert.deepEqual([f.code, f.message], ['runtime_error', MSG.unreachable]);
  } finally { await w.stop(); await other.stop(); }
});

// ---------------------------------------------------------------- the key (H3)

test('HM7 the key is the value of the one auth header and appears nowhere else: not in a URL, body, other header, log line, MCP record, event or failure; an echo of it is scrubbed', async () => {
  const w = await world();
  try {
    const keyed = () => [...w.model.requests.map((r) => ({ ...r, headers: { ...r.headers, authorization: undefined } })), w.mcp.records, w.logs, w.sleeps];
    const clean = (events) => {
      assert.ok(!bytesOf(events).includes(KEY), 'no event carries the key');
      assert.ok(!bytesOf(keyed()).includes(KEY), 'no request body, URL, header, MCP record or log line carries the key');
    };
    // A whole working turn.
    let events = await run(w, [
      call('write_file', { path: 'src/add.js', content: 'exports.add = (a, b) => a + b;\n' }),
      call('sandbox_exec', { argv: ['node', '-v'], cwd: '/workspace', timeoutMs: 60000 }),
      call('changeset_register', { title: 'add', summary: 'adds add()', clientKey: 'cs1' }),
      { text: 'Done.' }
    ]);
    assertRuntimeContract(events, { terminal: 'run.completed' });
    clean(events);
    const chats = w.model.chatRecords();
    assert.ok(chats.length >= 4);
    for (const r of chats) assert.equal(r.headers.authorization, `Bearer ${KEY}`, 'sent as the provider\'s auth header, on every call');
    // Failures: every kind carries a fixed sentence, never the key.
    for (const script of [[{ status: 401 }], [{ status: 429 }], [{ status: 500 }], [{ status: 404 }], [{ malformed: true }]]) clean(await run(w, script));
    // A model that echoes the key (it cannot know it; a hostile prompt could still make it say one) is scrubbed on the way out.
    events = await run(w, [{ text: `my key is ${KEY} ok` }, { text: 'bye' }]);
    assert.ok(events.some((e) => e.t === 'message.delta'));
    assert.ok(!bytesOf(events).includes(KEY));
    // A file written by the model that holds it is the model's own content (it never had the key); the adapter's own files: none.
    assert.ok(!fs.readdirSync(w.cfg).some((n) => fs.readFileSync(path.join(w.cfg, n), 'utf8').includes(KEY)));
    // The key shape: visible ASCII, no space, 8..512.
    for (const ok of [KEY, 'a'.repeat(8), 'A'.repeat(512), 'sk-abc_DEF.123~!@#$%^&*()']) assert.equal(isRuntimeApiKey(ok), true, ok.slice(0, 12));
    for (const bad of ['', 'short', 'a'.repeat(7), 'a'.repeat(513), 'has space in it', 'tab\tkey-12345', 'new\nline-12345', 'café-key-12345', 'nul\u0000key-12345', 7, null, undefined, {}]) assert.equal(isRuntimeApiKey(bad), false, String(bad));
    assert.ok(RUNTIME_API_KEY_RE.test(KEY));
    // No key given or a malformed one: auth failures with fixed sentences, nothing sent.
    const n = w.model.requests.length;
    let f = FAIL(await collect(adapter(w, { apiKey: undefined }), req(w)));
    assert.deepEqual([f.code, f.message], ['auth', MSG.keyMissing]);
    f = FAIL(await collect(adapter(w, { apiKey: '' }), req(w)));
    assert.equal(f.message, MSG.keyMissing);
    const BAD = 'bad key\nwith-header-injection';
    f = FAIL(await collect(adapter(w, { apiKey: BAD }), req(w)));
    assert.deepEqual([f.code, f.message], ['auth', MSG.keyRejected]);
    assert.ok(!bytesOf(f).includes('injection'));
    assert.equal(w.model.requests.length, n, 'nothing was sent without a usable key');
  } finally { await w.stop(); }
});

// ---------------------------------------------------------------- the destination (H2)

test('HM8a only the chosen provider\'s host: other hosts, plain http, IP literals, other ports, user info and other providers are refused before any connection', async () => {
  const allowed = [{ host: GROQ.host, port: 443 }];
  const ok = transportMod.checkTarget(`https://${GROQ.host}${GROQ.basePath}/chat/completions`, allowed);
  assert.deepEqual(ok, { host: GROQ.host, port: 443, path: `${GROQ.basePath}/chat/completions` });
  assert.ok(transportMod.checkTarget(`https://${GROQ.host.toUpperCase()}:443/x`, allowed), 'host names compare in lower case');
  for (const bad of [
    `http://${GROQ.host}/x`, `https://${GEMINI.host}/x`, 'https://example.com/x', `https://${GROQ.host}.evil.example/x`, `https://evil.example/${GROQ.host}`,
    `https://${GROQ.host}:8443/x`, `https://${GROQ.host}:80/x`, 'https://127.0.0.1/x', 'https://[::1]/x', 'https://8.8.8.8/x', 'https://localhost/x',
    `https://user:pw@${GROQ.host}/x`, `https://user@${GROQ.host}/x`, `ftp://${GROQ.host}/x`, `//${GROQ.host}/x`, GROQ.host, '', 'https://', `https://${GROQ.host}/x#frag`, 7, null, undefined]) {
    assert.equal(transportMod.checkTarget(bad, allowed), null, String(bad));
  }
  // The transport itself refuses before connecting (a seam pointing at a live server is never reached).
  const m = await mock.start({});
  try {
    for (const url of ['https://example.com/x', `http://${GROQ.host}/x`, `https://${GEMINI.host}/x`]) {
      const r = await transportMod.postJson({ url, allowed, headers: {}, body: '{}', proxyUrl: null, timeoutMs: 2000, maxBytes: 1000, seam: { plain: { host: '127.0.0.1', port: m.port } } });
      assert.deepEqual(r, { ok: false, kind: 'bad_target' }, url);
    }
    assert.equal(m.requests.length, 0);
  } finally { await m.stop(); }
});

test('HM8b the adapter refuses a request for another endpoint, another provider, an unconsented host and an unknown provider or model name, with nothing sent', async () => {
  const w = await world();
  try {
    const n = () => w.model.requests.length;
    const cases = [
      ['an endpoint that is not the chosen provider\'s', { endpoint: { host: '127.0.0.1', port: w.model.port } }, {}, 'runtime_error', MSG.notGranted],
      ['another provider\'s host as the endpoint', { endpoint: { host: GEMINI.host, port: 443 } }, {}, 'runtime_error', MSG.notGranted],
      ['the right host on another port', { endpoint: { host: GROQ.host, port: 8443 } }, {}, 'runtime_error', MSG.notGranted],
      ['a provider whose host the consent does not list', { model: { provider: 'gemini', model: GEMINI.defaultModel } }, {}, 'runtime_error', MSG.notGranted],
      ['no consent at all', {}, { consentedHosts: undefined }, 'runtime_error', MSG.notGranted],
      ['an empty consent', {}, { consentedHosts: [] }, 'runtime_error', MSG.notGranted],
      ['a consent for another port of the host', {}, { consentedHosts: [{ host: GROQ.host, port: 8443 }] }, 'runtime_error', MSG.notGranted],
      ['a provider id that is not a preset', { model: { provider: 'local-model', model: MODEL } }, {}, 'protocol', MSG.notChosen],
      ['a provider id that is a host', { model: { provider: GROQ.host, model: MODEL } }, {}, 'protocol', MSG.notChosen],
      ['a model name with a path in it', { model: { provider: 'groq', model: '../etc/passwd' } }, {}, 'protocol', MSG.notChosen],
      ['an empty model name', { model: { provider: 'groq', model: '' } }, {}, 'protocol', MSG.notChosen]
    ];
    for (const [what, reqOver, adOver, code, message] of cases) {
      const before = n();
      const f = FAIL(await collect(adapter(w, adOver), req(w, reqOver)));
      assert.deepEqual([f.code, f.message], [code, message], what);
      assert.equal(n(), before, `${what}: nothing was sent`);
    }
    // The chosen provider's own endpoint, spelled in any case, is accepted.
    const good = await collect(adapter(w), req(w, { endpoint: { host: GROQ.host.toUpperCase(), port: 443 } }));
    assert.equal(terminal(good).t, 'run.completed');
  } finally { await w.stop(); }
});

test('HM8c production path: no proxy, no request; the connection is a CONNECT to the chosen provider\'s host:443 on the loopback proxy only; a refusal of the proxy is a fixed sentence', async () => {
  const w = await world();
  const proxy = await mock.startFakeProxy({ refuse: 403 });
  try {
    // No seam. No proxy URL: nothing is attempted, nothing is sent anywhere.
    const noSeam = (over = {}) => createHostedModelAdapter({ token: TOKEN, mcpUrl: w.mcp.url, apiKey: KEY, consentedHosts: GROQ_HOSTS, ...over });
    let f = FAIL(await collect(noSeam(), req(w)));
    assert.deepEqual([f.code, f.message], ['runtime_error', MSG.noProxy]);
    f = FAIL(await collect(noSeam({ proxyUrl: () => null }), req(w)));
    assert.equal(f.message, MSG.noProxy);
    // A proxy URL that is not the runner's loopback proxy is never used.
    for (const u of ['http://10.0.0.1:3128', 'https://127.0.0.1:3128', 'http://localhost:3128', 'http://user:pw@127.0.0.1:3128', 'http://127.0.0.1', 'socks5://127.0.0.1:1080', 'nonsense']) {
      f = FAIL(await collect(noSeam({ proxyUrl: () => u }), req(w)));
      assert.equal(f.message, MSG.noProxy, u);
    }
    assert.deepEqual(proxy.connects, []);
    // The loopback proxy refuses (the real one answers 403 for a host that is not on its list): the fixed sentence, one CONNECT, to the provider's name only.
    f = FAIL(await collect(noSeam({ proxyUrl: () => proxy.url }), req(w)));
    assert.deepEqual([f.code, f.message], ['runtime_error', MSG.proxyRefused]);
    assert.deepEqual(proxy.connects, [`${GROQ.host}:443`]);
    f = FAIL(await collect(noSeam({ proxyUrl: () => proxy.url, consentedHosts: [{ host: GEMINI.host, port: 443 }] }), req(w, { model: { provider: 'gemini', model: GEMINI.defaultModel } })));
    assert.equal(f.message, MSG.proxyRefused);
    assert.deepEqual(proxy.connects, [`${GROQ.host}:443`, `${GEMINI.host}:443`]);
    assert.deepEqual(proxy.plain, [], 'nothing but CONNECT was sent to the proxy');
    assert.ok(!bytesOf(f).includes(KEY));
    // A 5xx or odd answer of the proxy is also a refusal, never a retry loop.
    const odd = await mock.startFakeProxy({ refuse: 502 });
    try {
      f = FAIL(await collect(noSeam({ proxyUrl: () => odd.url }), req(w)));
      assert.equal(f.message, MSG.proxyRefused);
      assert.equal(odd.connects.length, 1);
    } finally { await odd.stop(); }
    assert.equal(w.model.requests.length, 0);
  } finally { await w.stop(); await proxy.stop(); }
});

/** A throwaway self-signed certificate for the provider's name, made with the OpenSSL that ships with Git (skipped when none is found). */
function makeCert(host) {
  const dir = tmpDir('nx-hm-cert-');
  const r = cp.spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '2',
    '-subj', `/CN=${host}`, '-addext', `subjectAltName=DNS:${host}`], { encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) };
}

test('HM8d the whole production path end to end: CONNECT through the proxy, then TLS with the provider\'s name checked, the key as the auth header inside the tunnel; a certificate that does not verify is refused', async (t) => {
  const pair = makeCert(GROQ.host);
  if (!pair) { t.skip('no openssl available to make a test certificate'); return; }
  const w = await world({ tls: pair });
  const proxy = await mock.startFakeProxy({ map: { [`${GROQ.host}:443`]: { host: '127.0.0.1', port: w.model.port } } });
  try {
    const noPlain = (over = {}) => createHostedModelAdapter({ token: TOKEN, mcpUrl: w.mcp.url, apiKey: KEY, consentedHosts: GROQ_HOSTS, proxyUrl: () => proxy.url,
      seam: { ca: pair.cert.toString() }, sleep: async () => {}, ...over });
    w.model.setScript([call('write_file', { path: 'tls.txt', content: 'over tls' }), { text: 'done' }]);
    const events = await collect(noPlain(), req(w));
    assertRuntimeContract(events, { terminal: 'run.completed' });
    assert.equal(fs.readFileSync(path.join(w.wt, 'tls.txt'), 'utf8'), 'over tls');
    assert.deepEqual([...new Set(proxy.connects)], [`${GROQ.host}:443`]);
    const rec = w.model.chatRecords();
    assert.ok(rec.length >= 2);
    for (const r of rec) { assert.equal(r.headers.authorization, `Bearer ${KEY}`); assert.equal(r.headers.host, GROQ.host); assert.equal(r.url, `${GROQ.basePath}/chat/completions`); }
    // Without the test trust root the self-signed certificate does not verify: a fixed sentence, and the key is not sent (no request reached the origin).
    const n = w.model.requests.length;
    const f = FAIL(await collect(noPlain({ seam: undefined }), req(w)));
    assert.deepEqual([f.code, f.message], ['runtime_error', MSG.tlsFailed]);
    assert.equal(w.model.requests.length, n, 'the handshake failed before any request');
    // A certificate for another name does not verify either.
    const other = makeCert('not-the-provider.example');
    const w2 = await world({ tls: other });
    const proxy2 = await mock.startFakeProxy({ map: { [`${GROQ.host}:443`]: { host: '127.0.0.1', port: w2.model.port } } });
    try {
      const f2 = FAIL(await collect(createHostedModelAdapter({ token: TOKEN, mcpUrl: w2.mcp.url, apiKey: KEY, consentedHosts: GROQ_HOSTS, proxyUrl: () => proxy2.url,
        seam: { ca: other.cert.toString() } }), req(w2)));
      assert.equal(f2.message, MSG.tlsFailed, 'the certificate must name the provider');
      assert.equal(w2.model.requests.length, 0);
    } finally { await proxy2.stop(); await w2.stop(); }
  } finally { await w.stop(); await proxy.stop(); }
});

test('HM8e through the REAL host egress proxy: a provider whose name resolves to a private address, or that is not on the proxy\'s list, is refused by the proxy and the turn fails with a fixed sentence', async () => {
  const w = await world();
  const decisions = [];
  const hosts = allPresetHosts();
  const open = [];
  const startReal = async (allow, lookup) => {
    const p = await startHostEgressProxy({ allow, consentHostsSha256: hostsSha256(allow), onDecision: (e) => decisions.push(e), imagesDir: path.join(ROOT, 'infra', 'images'), lookup });
    open.push(p);
    return p;
  };
  try {
    const noSeam = (proxy) => createHostedModelAdapter({ token: TOKEN, mcpUrl: w.mcp.url, apiKey: KEY, consentedHosts: GROQ_HOSTS, proxyUrl: () => proxy.url });
    // The provider's name resolves to loopback (as a hostile resolver could make it): the proxy's private-address rule refuses; nothing is connected.
    const looped = await startReal(hosts, (_h, cb) => cb(null, ['127.0.0.1']));
    let f = FAIL(await collect(noSeam(looped), req(w)));
    assert.equal(f.code, 'runtime_error');
    assert.ok([MSG.unreachable, MSG.tlsFailed, MSG.proxyRefused].includes(f.message), f.message);
    assert.ok(decisions.some((d) => d.decision === 'refused' && d.host === GROQ.host && d.reason === 'private_address'), JSON.stringify(decisions));
    // The proxy's list holds only the OTHER provider: it answers 403 host_not_allowed to the chosen one.
    const onlyGemini = await startReal([{ host: GEMINI.host, port: 443 }], (_h, cb) => cb(null, ['127.0.0.1']));
    f = FAIL(await collect(noSeam(onlyGemini), req(w)));
    assert.equal(f.message, MSG.proxyRefused);
    assert.ok(decisions.some((d) => d.decision === 'refused' && d.host === GROQ.host && d.reason === 'host_not_allowed'));
    assert.equal(w.model.requests.length, 0);
    assert.ok(!bytesOf(decisions).includes(KEY));
  } finally { for (const p of open) await p.close(); await w.stop(); }
});

// ---------------------------------------------------------------- the probe (H7)

test('HM9 the probe is offline and key-blind: no network call of any kind, hosts = every preset host, providers and models from the table; it parses as a probe result', async () => {
  const calls = [];
  const orig = { connect: net.Socket.prototype.connect, lookup: dns.lookup, hreq: http.request, sreq: https.request, tconn: tls.connect, fetch: globalThis.fetch };
  net.Socket.prototype.connect = function () { calls.push('socket.connect'); throw new Error('no network in the probe'); };
  dns.lookup = function () { calls.push('dns.lookup'); throw new Error('no dns in the probe'); };
  http.request = function () { calls.push('http.request'); throw new Error('no http in the probe'); };
  https.request = function () { calls.push('https.request'); throw new Error('no https in the probe'); };
  tls.connect = function () { calls.push('tls.connect'); throw new Error('no tls in the probe'); };
  globalThis.fetch = function () { calls.push('fetch'); throw new Error('no fetch in the probe'); };
  let entry;
  try {
    const list = registry.probeAdapters();
    const a = list.find((x) => x.kind === 'hosted-model');
    assert.ok(a, 'the registry\'s probe adapters include the hosted-model kind');
    const d = await a.describe();
    assert.equal(d.label, ADAPTER_LABEL);
    assert.deepEqual(d.egressHosts, allPresetHosts());
    assert.deepEqual(d.egressHosts.map((h) => h.host).sort(), [GEMINI.host, GROQ.host].sort());
    assert.ok(d.egressHosts.every((h) => h.port === 443));
    assert.deepEqual(await a.health({ proxyUrl: 'http://127.0.0.1:9' }), { ok: true, version: adapterMod.PROBE_VERSION });
    const c = await a.check({ proxyUrl: 'http://127.0.0.1:9' });
    const s = await a.setup({});
    assert.deepEqual(c.setup, s);
    assert.equal(s.signedIn, 'unknown', 'whether a key exists is main\'s knowledge');
    assert.equal(s.flagsOk, true);
    assert.equal(s.label, 'Hosted free-API model');
    assert.deepEqual(s.providers.map((p) => p.id), ['groq', 'gemini']);
    for (const p of s.providers) {
      assert.deepEqual(Object.keys(p).sort(), ['hosts', 'id', 'label', 'models']);
      assert.deepEqual(p.hosts, [presetFor(p.id).host]);
      assert.ok(p.models.length >= 2 && p.models.every((m) => typeof m.name === 'string' && typeof m.tools === 'boolean'));
      assert.ok(p.models.some((m) => m.name === presetFor(p.id).defaultModel && m.tools), 'the default model is listed and tool-capable');
    }
    assert.deepEqual(s.models.map((m) => m.name).sort(), [...new Set(s.providers.flatMap((p) => p.models.map((m) => m.name)))].sort());
    // Through the runner's prober (the way the runner reports it): no key, no network, a probe entry that parses.
    const prober = new RuntimeProber({ adapters: () => [a], now: () => Date.now(), startProxy: async () => ({ url: 'http://127.0.0.1:1', port: 1, decisions: 0, dropped: 0, close: async () => {} }) });
    const entries = await prober.probe(null, ['hosted-model']);
    entry = entries[0];
    assert.equal(entry.kind, 'hosted-model');
    assert.equal(entry.health.ok, true);
  } finally {
    net.Socket.prototype.connect = orig.connect; dns.lookup = orig.lookup; http.request = orig.hreq; https.request = orig.sreq; tls.connect = orig.tconn; globalThis.fetch = orig.fetch;
  }
  assert.deepEqual(calls, [], 'not one network call');
  const msg = { op: 'probe.result', freeBytes: null, images: [], probe: { docker: 'missing', gpu: { detected: false, usableInContainers: false } }, runtimes: [entry] };
  const parsed = parseRunnerMessage(msg);
  assert.ok(parsed, 'the probe result with providers parses');
  assert.deepEqual(parsed.runtimes[0].setup.providers.map((p) => p.id), ['groq', 'gemini']);
  // The optional `providers` field is validated: bad ids, labels, hosts, models and sizes are refused; its absence is fine.
  const withProviders = (providers) => parseRunnerMessage({ ...msg, runtimes: [{ ...entry, setup: { ...entry.setup, providers } }] });
  const P = { id: 'p1', label: 'Provider', hosts: ['api.example.test'], models: [{ name: 'm-1', tools: true }] };
  assert.ok(withProviders([P]));
  assert.ok(withProviders([]));
  for (const bad of [[{ ...P, id: 'P1' }], [{ ...P, id: '' }], [{ ...P, label: '' }], [{ ...P, label: 'a\nb' }], [{ ...P, hosts: [] }], [{ ...P, hosts: ['bad host'] }], [{ ...P, hosts: ['h1', 'h2', 'h3', 'h4', 'h5'] }],
    [{ ...P, models: [{ name: '../x', tools: true }] }], [{ ...P, models: [{ name: 'm', tools: 'yes' }] }], [{ ...P, extra: 1 }], [P, P, P, P, P, P, P, P, P], 'groq', [null], [{ id: 'p1' }]]) {
    assert.equal(withProviders(bad), null, JSON.stringify(bad).slice(0, 80));
  }
  const noProviders = { ...entry, setup: { ...entry.setup } }; delete noProviders.setup.providers;
  assert.ok(parseRunnerMessage({ ...msg, runtimes: [noProviders] }));
});

// ---------------------------------------------------------------- the table and the registry

test('HM10 the preset table: opaque ids, DNS hosts on 443, tool-capable default models, neutral shapes; the only place provider words live', () => {
  assert.ok(PROVIDER_PRESETS.length >= 2);
  const ids = new Set(); const hosts = new Set();
  for (const p of PROVIDER_PRESETS) {
    assert.match(p.id, /^[a-z][a-z0-9-]{0,31}$/);
    assert.ok(!ids.has(p.id) && !hosts.has(p.host)); ids.add(p.id); hosts.add(p.host);
    assert.equal(p.port, 443);
    assert.equal(transportMod.checkTarget(`https://${p.host}${p.basePath}/chat/completions`, [{ host: p.host, port: 443 }]) !== null, true);
    assert.match(p.basePath, /^\/[A-Za-z0-9/_.-]*[A-Za-z0-9_.-]$/);
    assert.ok(p.label.length >= 1 && p.label.length <= 64);
    assert.ok(p.models.some((m) => m.name === p.defaultModel && m.tools === true));
    for (const m of p.models) assert.match(m.name, MODEL_NAME_RE);
    assert.equal(p.authHeader, p.authHeader.toLowerCase());
    assert.ok(/^[\x21-\x7e ]*$/.test(p.authPrefix));
  }
  assert.equal(presetFor('nope'), null);
  assert.equal(presetFor(undefined), null);
  assert.equal(presetFor('__proto__'), null);
  assert.ok(Object.isFrozen(PROVIDER_PRESETS) && PROVIDER_PRESETS.every((p) => Object.isFrozen(p)));
});

test('HM11 the registry builds the kind (the key and the proxy accessor reach the adapter); the probe lists it next to the other adapters; the wire helpers behave', async () => {
  assert.equal(registry.HOSTED_MODEL_KIND, 'hosted-model');
  assert.equal(HOSTED_MODEL_KIND, 'hosted-model');
  const w = await world();
  const proxy = await mock.startFakeProxy({ refuse: 403 });
  try {
    const rt = registry.runtimeFor(HOSTED_MODEL_KIND, { token: TOKEN, mcpUrl: w.mcp.url, apiKey: KEY, egressProxyUrl: () => proxy.url, consentedHosts: GROQ_HOSTS });
    assert.equal(rt.kind, 'hosted-model');
    assert.equal(typeof rt.start, 'function'); assert.equal(typeof rt.cancel, 'function');
    // The registry-built runtime really uses ctx.egressProxyUrl and ctx.consentedHosts: its CONNECT reaches the proxy for the chosen provider.
    const f = FAIL(await collect(rt, req(w)));
    assert.equal(f.message, MSG.proxyRefused);
    assert.deepEqual(proxy.connects, [`${GROQ.host}:443`]);
    // Without ctx.apiKey the turn fails auth (nothing is sent); the test seam arrives only through ctx.hostedTestSeam.
    const noKey = registry.runtimeFor(HOSTED_MODEL_KIND, { token: TOKEN, mcpUrl: w.mcp.url, consentedHosts: GROQ_HOSTS });
    assert.equal(FAIL(await collect(noKey, req(w))).code, 'auth');
    w.model.setScript([{ text: 'seam' }]);
    const seamed = registry.runtimeFor(HOSTED_MODEL_KIND, { token: TOKEN, mcpUrl: w.mcp.url, apiKey: KEY, consentedHosts: GROQ_HOSTS, hostedTestSeam: { plain: { host: '127.0.0.1', port: w.model.port } } });
    assert.equal(terminal(await collect(seamed, req(w))).t, 'run.completed');
    assert.deepEqual(registry.probeAdapters().map((a) => a.kind), ['cli-agent', 'local-model', 'hosted-model']);
    for (const a of registry.probeAdapters()) for (const m of ['describe', 'health', 'setup']) assert.equal(typeof a[m], 'function', m);
  } finally { await w.stop(); await proxy.stop(); }
  // Wire helpers.
  const wire = clientMod.toWireMessages([
    { role: 'system', content: 's' }, { role: 'user', content: 'u' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'a', arguments: { x: 1 } } }, { function: { name: 'b', arguments: {} } }] },
    { role: 'tool', content: 'ra' },
    { role: 'user', content: 'nudge' }
  ], {});
  assert.deepEqual(wire.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'tool', 'user']);
  assert.equal(wire[2].tool_calls[0].function.arguments, '{"x":1}');
  assert.equal(wire[3].tool_call_id, wire[2].tool_calls[0].id);
  assert.equal(wire[4].tool_call_id, wire[2].tool_calls[1].id, 'a call that got no result is answered, never left open');
  assert.equal(clientMod.classify(429, '{"error":{"message":"requests per day"}}', {}), 'quota');
  assert.equal(clientMod.classify(429, '{"error":{"message":"slow down"}}', {}), 'rate');
  assert.equal(clientMod.classify(401, '', {}), 'auth');
  assert.equal(clientMod.classify(503, '', {}), 'transient');
  // The provider's short label goes to the local log only, and only plain label characters pass: never a sentence, prompt text or key.
  assert.equal(clientMod.errorLabel('{"error":{"code":"invalid_request_error","type":"invalid_request_error","message":"Bad: my secret prompt text sk-123"}}'), 'invalid_request_error invalid_request_error');
  assert.equal(clientMod.errorLabel('{"error":{"code":"Please do not log THIS sentence, it has punctuation: sk-123","type":"tool_use_failed"}}'), 'tool_use_failed');
  assert.equal(clientMod.errorLabel('not json'), '');
  assert.equal(clientMod.errorLabel('{"error":{"code":"' + 'a'.repeat(41) + '"}}'), '');
  assert.equal(clientMod.retryAfterMs('2', 0), 2000);
  assert.equal(clientMod.retryAfterMs(undefined, 0), null);
  assert.equal(clientMod.retryAfterMs('soon', 0), null);
  const r = clientMod.parseWireReply(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'c', function: { name: 'read_file', arguments: '{"path":"a"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 7, completion_tokens: 3 } }));
  assert.deepEqual([r.content, r.toolCalls.length, r.inputTokens, r.outputTokens], ['', 1, 7, 3]);
  assert.equal(clientMod.parseWireReply('nope'), null);
});

test('HM12 no vendor or provider word in a runtime event, and the runner\'s source outside the preset table names no provider', async () => {
  const w = await world();
  try {
    const events = await run(w, [call('write_file', { path: 'a.txt', content: 'x' }), { text: 'done' }]);
    assert.ok(!/claude|anthropic|groq|gemini|openai|google/i.test(bytesOf(events)));
    for (const script of [[{ status: 401 }], [{ status: 429 }], [{ status: 404 }]]) assert.ok(!/claude|anthropic|groq|gemini|openai|google/i.test(bytesOf(await run(w, script))));
  } finally { await w.stop(); }
  const dir = path.join(ROOT, 'src', 'runner', 'runtimes', 'hostedModel');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.ts') && n !== 'presets.ts')) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r/g, '');
    assert.ok(!/groq|gemini|googleapis|openai/i.test(text), `${f} names no provider (only presets.ts does)`);
  }
});

test('HM-chat a capable hosted model that only talks (a greeting, a question) ends the turn after its one reply, like any coding agent: no nudge, no repeated apology; its system prompt allows answering in words', async () => {
  const w = await world();
  try {
    const events = await run(w, [{ text: 'Hi! What would you like to build or change?' }, { text: 'second reply that must never be asked for' }]);
    assertRuntimeContract(events, { terminal: 'run.completed' });
    assert.equal(w.model.chats().length, 1, 'one reply, no nudge');
    assert.equal(events.filter((e) => e.t === 'message.delta').length, 1);
    assert.equal(events.filter((e) => e.t === 'tool.started').length, 0);
    const system = w.model.chats()[0].messages[0].content;
    assert.match(system, /only greet you, chat, or ask a question, answer in one or two plain, friendly sentences/);
  } finally { await w.stop(); }
});
