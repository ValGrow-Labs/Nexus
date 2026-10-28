'use strict';
// The local-model runtime (kind `local-model`, src/runner/runtimes/localModel): the AgentRuntime contract, its tool loop, its
// confined host file tools, its loopback-only destination rule and its probe. Plain node: the model server is a MOCK on
// loopback (test/helpers/mockOllama.cjs), the runner's MCP server is a recorder (test/helpers/mcpRecorder.cjs). No real model
// server, no CLI, no Docker, no database, no network beyond 127.0.0.1.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const loadTs = require('./load-ts.cjs');
const mock = require('./helpers/mockOllama.cjs');
const recorder = require('./helpers/mcpRecorder.cjs');
const { collect, assertRuntimeContract } = require('./helpers/runtimeContract.cjs');

const adapterMod = loadTs('src/runner/runtimes/localModel/adapter.ts');
const endpointMod = loadTs('src/runner/runtimes/localModel/endpoint.ts');
const filesMod = loadTs('src/runner/runtimes/localModel/fileTools.ts');
const callsMod = loadTs('src/runner/runtimes/localModel/toolCalls.ts');
const registry = loadTs('src/runner/runtimes/registry.ts');
const { parseRunnerMessage } = loadTs('src/shared/nexus/runnerProtocol.ts');
const { createLocalModelAdapter, LOCAL_MODEL_KIND, ADAPTER_LABEL } = adapterMod;
const { FileTools, checkRelPath } = filesMod;

const TOKEN = `${'l'.repeat(22)}.${'m'.repeat(43)}`;
const MODEL = 'qwen2.5-coder:7b';

const TMP = [];
after(() => { for (const d of TMP) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ } } });
const tmpDir = (p = 'nx-lm-') => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); TMP.push(d); return d; };

// ---------------------------------------------------------------- helpers

const MCP_TOOLS = [
  { name: 'context_get', description: 'context', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'sandbox_exec', description: 'sandbox exec', inputSchema: { type: 'object', properties: {
    argv: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' }, timeoutMs: { type: 'integer' } }, required: ['argv', 'timeoutMs'] } },
  { name: 'changeset_register', description: 'register', inputSchema: { type: 'object', properties: {
    title: { type: 'string' }, summary: { type: 'string' }, clientKey: { type: 'string' } }, required: ['title', 'summary', 'clientKey'] } }
];

/** A turn's world: a worktree, a config dir, a context file, a mock model server and a recording MCP server. */
async function world(modelOpts = {}, mcpOpts = {}) {
  const root = tmpDir();
  const wt = path.join(root, 'wt');
  const cfg = path.join(root, 'job');
  fs.mkdirSync(wt); fs.mkdirSync(cfg);
  fs.writeFileSync(path.join(cfg, 'context.md'), '## context\nbuild a tiny add function\n');
  const model = await mock.start(modelOpts);
  const mcp = await recorder.start({ tools: MCP_TOOLS, ...mcpOpts });
  return { root, wt, cfg, model, mcp, async stop() { await model.stop(); await mcp.stop(); } };
}

const req = (w, over = {}) => ({
  jobId: 'j1', attempt: 1, sessionId: 's1', idempotencyKey: 'k1', domainId: 'd1', skills: [],
  context: { hash: 'h'.repeat(64), file: path.join(w.cfg, 'context.md') }, message: 'Write add(a, b) in src/add.js and test it.',
  worktree: { hostPath: w.wt, editable: ['/workspace'] }, container: { id: 'c1' }, mcp: { url: w.mcp.url },
  model: { provider: 'local-model', model: MODEL }, limits: { wallClockMs: 60_000, maxTurns: 30 },
  endpoint: { host: '127.0.0.1', port: w.model.port }, credential: { ref: 'runtime-owned' }, configDir: w.cfg, ...over
});
const adapter = (w, over = {}) => createLocalModelAdapter({ token: TOKEN, mcpUrl: w.mcp.url, consentedHosts: [{ host: '127.0.0.1', port: w.model.port }], ...over });
const run = async (w, script, { reqOver, adOver, signal } = {}) => {
  w.model.setScript(script);
  const events = await collect(adapter(w, adOver), req(w, reqOver), signal);
  return events;
};
const call = (name, args) => ({ calls: [{ name, args }] });
const terminal = (events) => events[events.length - 1];
const bytesOf = (events) => JSON.stringify(events);

// ---------------------------------------------------------------- LM1 happy path

test('LM1 a turn writes files on the host, runs a command and registers the change through the runner MCP server; events pair up, one terminal, usage is the server\'s own', async () => {
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
    // The MCP server saw tools/list, then the two runner calls, in order, each with the bearer.
    const calls = w.mcp.calls();
    assert.deepEqual(calls.map((c) => c.params.name), ['sandbox_exec', 'changeset_register']);
    assert.deepEqual(calls[0].params.arguments, { argv: ['node', 'test/add.test.js'], cwd: '/workspace', timeoutMs: 60000 });
    for (const r of w.mcp.records) assert.equal(r.headers.authorization, `Bearer ${TOKEN}`);
    // Event order: start, then per model call a usage, the tool events in call order.
    const tools = events.filter((e) => e.t === 'tool.started').map((e) => e.tool);
    assert.deepEqual(tools, ['write_file', 'write_file', 'sandbox_exec', 'changeset_register']);
    for (const e of events.filter((x) => x.t === 'tool.completed')) assert.equal(e.ok, true);
    const usage = events.filter((e) => e.t === 'usage');
    const last = usage[usage.length - 1];
    assert.equal(last.inputTokens, 50, 'five model calls x 10 prompt tokens, as the server counted');
    assert.equal(last.outputTokens, 25);
    assert.equal(last.costUsdCents, 0);
    assert.equal(last.estimated, false);
    assert.equal(last.toolCalls, 4);
    // The model was offered the file tools and the runner's tools, once each.
    const offered = w.model.chats()[0].tools.map((t) => t.function.name);
    assert.deepEqual(offered, ['read_file', 'write_file', 'list_files', 'delete_file', 'context_get', 'sandbox_exec', 'changeset_register']);
    assert.equal(w.model.chats()[0].stream, false);
    // The first prompt carries the task and the context file, and tells the workflow.
    const first = w.model.chats()[0].messages;
    assert.match(first[0].content, /sandbox_exec/);
    assert.match(first[1].content, /build a tiny add function/);
    assert.match(first[1].content, /Write add\(a, b\) in src\/add\.js/);
    // No temporary file is left behind by the atomic writes.
    assert.deepEqual(fs.readdirSync(path.join(w.wt, 'src')), ['add.js']);
  } finally { await w.stop(); }
});

test('LM2 a text-only reply ends the turn; a model that only talks is nudged twice and then ends; the mcpTools allow-list narrows what is offered', async () => {
  const w = await world();
  try {
    const events = await run(w, [{ text: 'I would do it like this.' }, { text: 'Sure.' }, { text: 'Really.' }, { text: 'bye' }], { adOver: { mcpTools: ['context_get'] } });
    assertRuntimeContract(events, { terminal: 'run.completed' });
    assert.equal(events.filter((e) => e.t === 'tool.started').length, 0);
    assert.equal(w.model.chats().length, 3, 'one reply + two nudged replies, then the end');
    assert.match(w.model.chats()[1].messages.slice(-1)[0].content, /did not call a tool/);
    assert.deepEqual(w.model.chats()[0].tools.map((t) => t.function.name), ['read_file', 'write_file', 'list_files', 'delete_file', 'context_get']);
    assert.equal(events.filter((e) => e.t === 'message.delta').length, 3);
  } finally { await w.stop(); }
});

test('LM3 files were written but nothing registered: the model is nudged to register; after two nudges the turn still ends', async () => {
  const w = await world();
  try {
    const events = await run(w, [call('write_file', { path: 'a.txt', content: 'a' }), { text: 'all done' }, { text: 'really done' }, { text: 'done done' }]);
    assertRuntimeContract(events, { terminal: 'run.completed' });
    const bodies = w.model.chats();
    assert.match(bodies[2].messages.slice(-1)[0].content, /changeset_register/);
    assert.equal(bodies.length, 4);
  } finally { await w.stop(); }
});

// ---------------------------------------------------------------- cancel and caps

test('LM4 cancel: aborting during a model call ends the turn with run.cancelled once; an abort before the start never reaches the server; cancel() aborts too', async () => {
  const w = await world();
  try {
    const ac = new AbortController();
    w.model.setScript([{ hang: true }]);
    const ad = adapter(w);
    const p = collect(ad, req(w), ac.signal);
    const t0 = Date.now();
    while (w.model.chats().length === 0 && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    const events = await p;
    assertRuntimeContract(events, { terminal: 'run.cancelled' });
    // Already aborted: a start and a cancel, no request to the model server.
    const before = w.model.requests.length;
    const pre = new AbortController(); pre.abort();
    const pe = await collect(adapter(w), req(w), pre.signal);
    assert.deepEqual(pe.map((e) => e.t), ['run.started', 'run.cancelled']);
    assert.equal(w.model.requests.length, before);
    // cancel() ends a running turn the same way.
    w.model.setScript([{ hang: true }]);
    const ad2 = adapter(w);
    const p2 = collect(ad2, req(w));
    const t1 = Date.now();
    while (w.model.requests.filter((r) => r.chat).length < 2 && Date.now() - t1 < 5000) await new Promise((r) => setTimeout(r, 10));
    await ad2.cancel('r', 0);
    assertRuntimeContract(await p2, { terminal: 'run.cancelled' });
  } finally { await w.stop(); }
});

test('LM5 cancel while a tool call is in flight ends the turn run.cancelled', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const w = await world({}, { onCall: () => 'ok' });
  try {
    const ac = new AbortController();
    const ad = adapter(w, { fetchImpl: async (url, init) => { if (JSON.parse(init.body).method === 'tools/call') { await gate; ac.abort(); } return fetch(url, init); } });
    w.model.setScript([call('context_get', {}), { text: 'x' }]);
    const p = collect(ad, req(w), ac.signal);
    setTimeout(release, 100);
    const events = await p;
    assertRuntimeContract(events, { terminal: 'run.cancelled' });
  } finally { await w.stop(); }
});

test('LM6 caps: wall clock, model calls, tool calls, tokens and the 200-call ceiling each end the turn failed limit', async () => {
  const w = await world();
  try {
    // Wall clock: a server that never answers.
    let events = await run(w, [{ hang: true }], { reqOver: { limits: { wallClockMs: 1200, maxTurns: 10 } } });
    assertRuntimeContract(events, { terminal: 'run.failed' });
    assert.equal(terminal(events).code, 'limit');
    assert.match(terminal(events).message, /wall clock/);
    // Model calls (maxTurns).
    events = await run(w, (_b, i) => call('write_file', { path: `f${i}.txt`, content: String(i) }), { reqOver: { limits: { wallClockMs: 60_000, maxTurns: 3 } } });
    assert.equal(terminal(events).code, 'limit');
    assert.match(terminal(events).message, /model-call limit/);
    assert.equal(events.filter((e) => e.t === 'tool.started').length, 3);
    // Tool calls: the turn's own cap, three calls in one reply.
    events = await run(w, [{ calls: [1, 2, 3].map((n) => ({ name: 'write_file', args: { path: `g${n}.txt`, content: 'x' } })) }], { adOver: { caps: { toolCalls: 2 } } });
    assert.equal(terminal(events).code, 'limit');
    assert.match(terminal(events).message, /tool-call cap/);
    assert.equal(events.filter((e) => e.t === 'tool.started').length, 2);
    assert.ok(!fs.existsSync(path.join(w.wt, 'g3.txt')), 'the call over the cap did not run');
    // Tokens: 15 per model call, cap 20 -> the second call goes over.
    events = await run(w, (_b, i) => call('write_file', { path: `t${i}.txt`, content: 'x' }), { adOver: { caps: { turnTokens: 20 } } });
    assert.equal(terminal(events).code, 'limit');
    assert.match(terminal(events).message, /token cap/);
    assert.equal(events.filter((e) => e.t === 'usage').pop().inputTokens, 20);
    // The 200-call ceiling holds even when the turn's own cap is far higher.
    events = await run(w, (_b, i) => call('list_files', { path: `nope${i}` }), { adOver: { caps: { toolCalls: 100000 } }, reqOver: { limits: { wallClockMs: 120_000, maxTurns: 1000 } } });
    assert.equal(terminal(events).code, 'limit');
    assert.match(terminal(events).message, /tool-call cap/);
    assert.equal(events.filter((e) => e.t === 'tool.started').length, 200);
    assertRuntimeContract(events, { terminal: 'run.failed' });
  } finally { await w.stop(); }
});

// ---------------------------------------------------------------- weak models

test('LM7 malformed arguments and unknown tools get a corrective result and a strike; the turn recovers; five in a row end it protocol', async () => {
  const w = await world();
  try {
    let events = await run(w, [
      call('write_file', 'not json {'),
      call('launch_missiles', { x: 1 }),
      call('write_file', { path: 'ok.txt', content: 'fine' }),
      { text: 'done' }
    ]);
    assertRuntimeContract(events, { terminal: 'run.completed' });
    const done = events.filter((e) => e.t === 'tool.completed');
    assert.deepEqual(done.map((e) => e.ok), [false, false, true]);
    assert.equal(fs.readFileSync(path.join(w.wt, 'ok.txt'), 'utf8'), 'fine');
    const toolMsgs = w.model.chats().flatMap((b) => b.messages).filter((m) => m.role === 'tool').map((m) => m.content);
    assert.ok(toolMsgs.some((m) => /must be a JSON object/.test(m)));
    assert.ok(toolMsgs.some((m) => /no tool named "launch_missiles"/.test(m) && /write_file/.test(m)));
    // Five unknown calls in a row.
    events = await run(w, (_b, i) => call(`nope${i}`, {}));
    assertRuntimeContract(events, { terminal: 'run.failed' });
    assert.equal(terminal(events).code, 'protocol');
    // An empty reply is nudged twice; a third, with no tool used, ends the turn protocol; after work was done it just ends it.
    const n0 = w.model.chats().length;
    events = await run(w, [{ text: '' }, { text: '' }, { text: '' }, { text: 'never reached' }]);
    assert.equal(terminal(events).code, 'protocol');
    const last3 = w.model.chats().slice(n0);
    assert.match(last3[1].messages.slice(-1)[0].content, /reply was empty/);
    assert.equal(last3.length, 3, 'three model calls, no fourth');
  } finally { await w.stop(); }
});

test('LM8 near misses are repaired: a namespaced or mis-cased name, a string of JSON for the arguments and a string-typed list', async () => {
  const w = await world();
  try {
    const events = await run(w, [
      call('functions.write_file', JSON.stringify({ path: 'a.txt', content: 'one' })),
      call('Write-File', { path: 'b.txt', content: 'two' }),
      call('sandbox_exec', { argv: '["echo","hi"]', timeoutMs: '60000', cwd: '/workspace' }),
      { text: 'ok' }
    ]);
    assertRuntimeContract(events, { terminal: 'run.completed' });
    assert.equal(fs.readFileSync(path.join(w.wt, 'a.txt'), 'utf8'), 'one');
    assert.equal(fs.readFileSync(path.join(w.wt, 'b.txt'), 'utf8'), 'two');
    assert.deepEqual(w.mcp.calls()[0].params.arguments, { argv: ['echo', 'hi'], timeoutMs: 60000, cwd: '/workspace' });
    assert.deepEqual(events.filter((e) => e.t === 'tool.started').map((e) => e.tool), ['write_file', 'write_file', 'sandbox_exec']);
  } finally { await w.stop(); }
});

test('LM9 a tool call written as JSON in the text (fenced, tagged or bare) is run as that call, with a note; plain prose containing braces is not', async () => {
  const w = await world();
  try {
    const events = await run(w, [
      { text: 'I will write it.\n```json\n{"name": "write_file", "arguments": {"path": "x.txt", "content": "from text"}}\n```' },
      { text: '<tool_call>{"name":"write_file","arguments":{"path":"y.txt","content":"tagged"}}</tool_call>' },
      { text: '{"tool": "write_file", "parameters": {"path": "z.txt", "content": "bare"}}' },
      { text: 'The function returns {a: 1} for input; nothing to call here.' }
    ]);
    assertRuntimeContract(events, { terminal: 'run.completed' });
    assert.equal(fs.readFileSync(path.join(w.wt, 'x.txt'), 'utf8'), 'from text');
    assert.equal(fs.readFileSync(path.join(w.wt, 'y.txt'), 'utf8'), 'tagged');
    assert.equal(fs.readFileSync(path.join(w.wt, 'z.txt'), 'utf8'), 'bare');
    const toolMsgs = w.model.chats().flatMap((b) => b.messages).filter((m) => m.role === 'tool').map((m) => m.content);
    assert.ok(toolMsgs.every((m) => /was written as text/.test(m)), 'each recovered call carries the note');
    // The recovered text was not shown as a message; the prose reply was.
    const deltas = events.filter((e) => e.t === 'message.delta').map((e) => e.text);
    assert.equal(deltas[0], 'The function returns {a: 1} for input; nothing to call here.');
    assert.ok(deltas.every((t) => !/"name"|"tool"|tool_call/.test(t)), 'no recovered call text was shown');
    // Unit: not a call unless it names a known tool.
    assert.equal(callsMod.recoverTextCalls('{"name":"nothing","arguments":{}}', ['write_file']), null);
    assert.equal(callsMod.recoverTextCalls('hello', ['write_file']), null);
  } finally { await w.stop(); }
});

test('LM10 loop detection: an exact call that failed three times is not run again; the fifth failure, or six identical calls in a row, end the turn protocol', async () => {
  const w = await world();
  try {
    let events = await run(w, (_b, i) => call('read_file', { path: 'missing.txt' }));
    assertRuntimeContract(events, { terminal: 'run.failed' });
    assert.equal(terminal(events).code, 'protocol');
    assert.match(terminal(events).message, /repeating a failing/);
    const toolMsgs = w.model.chats().flatMap((b) => b.messages).filter((m) => m.role === 'tool').map((m) => m.content);
    assert.ok(toolMsgs.filter((m) => /already failed 3 times/.test(m)).length >= 1, 'the model was told to stop repeating');
    assert.equal(events.filter((e) => e.t === 'tool.started').length, 5);
    // Six identical successful calls in a row.
    events = await run(w, (_b, i) => call('list_files', {}));
    assert.equal(terminal(events).code, 'protocol');
    assert.match(terminal(events).message, /same tool call/);
    assert.equal(events.filter((e) => e.t === 'tool.started').length, 6);
  } finally { await w.stop(); }
});

// ---------------------------------------------------------------- the file tools (R5)

test('LM11 file tools refuse every path that leaves the worktree or names a reserved entry; nothing is created outside', async () => {
  const root = tmpDir();
  const wt = path.join(root, 'wt'); fs.mkdirSync(wt);
  const outside = path.join(root, 'outside.txt');
  fs.writeFileSync(outside, 'SECRET');
  const ft = new FileTools(wt);
  const bad = ['../outside.txt', '..\\outside.txt', 'a/../../outside.txt', '/etc/passwd', '\\windows\\x', 'C:/Windows/x', 'C:\\Windows\\x', 'c:x', '\\\\server\\share\\x', '//server/share/x',
    '.git/config', '.git/hooks/pre-commit', '.GIT/x', '.git./x', 'GIT~1/x', 'sub/.git/config', '.claude/settings.json', '.claude-local/x', '.CLAUDE/x', '.nexus/state', 'nexus.json', 'nexus.config/x',
    '.env', 'a/.env.local', 'cert.pem', 'id_rsa', 'k.key', '.npmrc', 'x:stream', 'a.txt::$DATA', 'con', 'NUL.txt', 'a.', 'a ', 'a|b', 'a?b', 'a\u0000b', ''];
  for (const p of bad) {
    for (const [tool, args] of [['write_file', { path: p, content: 'pwned' }], ['read_file', { path: p }], ['delete_file', { path: p }]]) {
      const r = await ft.run(tool, args);
      assert.equal(r.ok, false, `${tool} ${JSON.stringify(p)} must be refused`);
      assert.ok(!r.text.includes(root) && !r.text.includes('SECRET'), 'no absolute path and no foreign content in a refusal');
    }
  }
  assert.equal(fs.readFileSync(outside, 'utf8'), 'SECRET');
  assert.deepEqual(fs.readdirSync(wt), [], 'nothing was created in the worktree');
  assert.deepEqual(fs.readdirSync(root).sort(), ['outside.txt', 'wt']);
  // Non-string and missing arguments.
  for (const args of [{}, { path: 7 }, { path: ['a'] }, { path: null }]) assert.equal((await ft.run('read_file', args)).ok, false);
  assert.equal((await ft.run('write_file', { path: 'a.txt' })).ok, false);
  assert.equal((await ft.run('write_file', { path: 'a.txt', content: 5 })).ok, false);
  assert.equal((await ft.run('nothing', {})).ok, false);
  // The same through a whole turn: the refusals come back to the model as results and the turn continues.
  const w = await world();
  try {
    const events = await run(w, [call('write_file', { path: '../escape.txt', content: 'x' }), call('write_file', { path: '.git/config', content: 'x' }),
      call('write_file', { path: 'fine/a.txt', content: 'x' }), { text: 'ok' }]);
    assertRuntimeContract(events, { terminal: 'run.completed' });
    assert.deepEqual(events.filter((e) => e.t === 'tool.completed').map((e) => e.ok), [false, false, true]);
    assert.ok(!fs.existsSync(path.join(w.root, 'escape.txt')));
    assert.ok(fs.existsSync(path.join(w.wt, 'fine', 'a.txt')));
  } finally { await w.stop(); }
  // Good paths still work, including a leading ./ and backslashes.
  for (const p of ['a.txt', './b.txt', 'src\\c.js', 'deep/er/d.txt', 'node_modules/x/index.js', '.gitignore']) {
    const r = await ft.run('write_file', { path: p, content: `content of ${p}` });
    assert.equal(r.ok, true, `${p}: ${r.text}`);
  }
  assert.equal((await ft.run('read_file', { path: 'src/c.js' })).text, 'content of src\\c.js');
  assert.equal(checkRelPath('a/./b').ok, true);
});

test('LM12 links are never followed: a junction or symlink to the outside, a hard link, a linked file and a linked root', async () => {
  const root = tmpDir();
  const wt = path.join(root, 'wt'); fs.mkdirSync(wt);
  const outDir = path.join(root, 'outdir'); fs.mkdirSync(outDir);
  fs.writeFileSync(path.join(outDir, 'secret.txt'), 'SECRET');
  const ft = new FileTools(wt);
  // A directory link (a junction needs no privilege on Windows; a symlink is the fallback elsewhere).
  let dirLink = false;
  try { fs.symlinkSync(outDir, path.join(wt, 'link'), 'junction'); dirLink = true; } catch { /* not creatable here */ }
  if (dirLink) {
    assert.equal((await ft.run('read_file', { path: 'link/secret.txt' })).ok, false);
    assert.equal((await ft.run('write_file', { path: 'link/new.txt', content: 'x' })).ok, false);
    assert.equal((await ft.run('write_file', { path: 'link/sub/new.txt', content: 'x' })).ok, false);
    assert.equal((await ft.run('delete_file', { path: 'link/secret.txt' })).ok, false);
    assert.equal((await ft.run('list_files', { path: 'link' })).ok, false);
    assert.ok(!(await ft.run('list_files', {})).text.includes('link'), 'a link is not listed');
    assert.deepEqual(fs.readdirSync(outDir), ['secret.txt']);
    assert.equal(fs.readFileSync(path.join(outDir, 'secret.txt'), 'utf8'), 'SECRET');
  }
  // A file symlink (may need a privilege on Windows).
  let fileLink = false;
  try { fs.symlinkSync(path.join(outDir, 'secret.txt'), path.join(wt, 'flink.txt'), 'file'); fileLink = true; } catch { /* not creatable here */ }
  if (fileLink) {
    assert.equal((await ft.run('read_file', { path: 'flink.txt' })).ok, false);
    assert.equal((await ft.run('write_file', { path: 'flink.txt', content: 'overwritten' })).ok, false);
    assert.equal(fs.readFileSync(path.join(outDir, 'secret.txt'), 'utf8'), 'SECRET');
  }
  // A hard link: a second name for bytes that live outside.
  let hard = false;
  try { fs.linkSync(path.join(outDir, 'secret.txt'), path.join(wt, 'hard.txt')); hard = true; } catch { /* not creatable here */ }
  if (hard) {
    assert.equal((await ft.run('read_file', { path: 'hard.txt' })).ok, false);
    assert.equal((await ft.run('write_file', { path: 'hard.txt', content: 'overwritten' })).ok, false);
    assert.equal(fs.readFileSync(path.join(outDir, 'secret.txt'), 'utf8'), 'SECRET');
  }
  // A root that is itself a link is refused for every tool.
  let rootLink = false;
  const lr = path.join(root, 'rootlink');
  try { fs.symlinkSync(wt, lr, 'junction'); rootLink = true; } catch { /* not creatable here */ }
  if (rootLink) assert.equal((await new FileTools(lr).run('write_file', { path: 'a.txt', content: 'x' })).ok, false);
  assert.equal((await new FileTools('relative/dir').run('list_files', {})).ok, false, 'a relative root is refused');
  assert.ok(dirLink || fileLink || hard, 'at least one kind of link could be created for this test');
});

test('LM13 sizes are capped: one file read, one file written, all bytes written in a turn, a listing; binary content is refused; writes are atomic and replace in place', async () => {
  const root = tmpDir();
  const wt = path.join(root, 'wt'); fs.mkdirSync(wt);
  const ft = new FileTools(wt, { readMaxBytes: 50, writeMaxBytes: 40, writeTotalBytes: 100, listMaxEntries: 5, listMaxDepth: 2 });
  assert.equal((await ft.run('write_file', { path: 'big.txt', content: 'x'.repeat(41) })).ok, false);
  assert.ok(!fs.existsSync(path.join(wt, 'big.txt')));
  assert.equal((await ft.run('write_file', { path: 'nul.txt', content: 'a\0b' })).ok, false);
  assert.equal((await ft.run('write_file', { path: 'a.txt', content: 'x'.repeat(40) })).ok, true);
  assert.equal((await ft.run('write_file', { path: 'a.txt', content: 'y'.repeat(40) })).ok, true, 'replaced in place');
  assert.equal(fs.readFileSync(path.join(wt, 'a.txt'), 'utf8'), 'y'.repeat(40));
  const over = await ft.run('write_file', { path: 'b.txt', content: 'z'.repeat(30) });
  assert.equal(over.ok, false, 'the turn has written 80 of its 100 bytes');
  assert.match(over.text, /written as much as it may/);
  fs.writeFileSync(path.join(wt, 'large.txt'), 'q'.repeat(51));
  assert.equal((await ft.run('read_file', { path: 'large.txt' })).ok, false);
  fs.writeFileSync(path.join(wt, 'bin.dat'), Buffer.from([1, 2, 0, 3]));
  assert.equal((await ft.run('read_file', { path: 'bin.dat' })).ok, false);
  for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(wt, `f${i}.txt`), 'x');
  const listing = await ft.run('list_files', {});
  assert.equal(listing.ok, true);
  assert.match(listing.text, /the listing stops at 5 entries/);
  assert.deepEqual(fs.readdirSync(wt).filter((n) => n.endsWith('.tmp')), [], 'no temporary file is left');
  assert.equal((await ft.run('read_file', { path: 'a.txt' })).text, 'y'.repeat(40));
  assert.equal((await ft.run('delete_file', { path: 'a.txt' })).ok, true);
  assert.equal((await ft.run('delete_file', { path: 'a.txt' })).ok, false);
  fs.mkdirSync(path.join(wt, 'dir'));
  assert.equal((await ft.run('delete_file', { path: 'dir' })).ok, false, 'a folder is not deleted');
  assert.equal((await ft.run('read_file', { path: 'dir' })).ok, false);
  // The summary of a write names its size, never its content.
  assert.equal(ft.summarize('write_file', { path: 'a.txt', content: 'SECRETCONTENT' }), 'a.txt (13 bytes)');
});

test('LM14 an event never carries a file\'s content; a result the model gets never carries an absolute path', async () => {
  const w = await world();
  try {
    const events = await run(w, [call('write_file', { path: 'sec.txt', content: 'TOP-SECRET-CONTENT' }), call('read_file', { path: 'sec.txt' }), call('list_files', {}), { text: 'done' }]);
    assertRuntimeContract(events, { terminal: 'run.completed' });
    assert.ok(!bytesOf(events).includes('TOP-SECRET-CONTENT'));
    for (const b of w.model.chats()) for (const m of b.messages) if (m.role === 'tool') assert.ok(!m.content.includes(w.root), 'no absolute path in a tool result');
  } finally { await w.stop(); }
});

// ---------------------------------------------------------------- destination rule (R2)

test('LM15 only a loopback endpoint on a consented port is ever used: other hosts and addresses, a name that resolves elsewhere, an unconsented port', async () => {
  const w = await world();
  try {
    const before = () => w.model.requests.length + w.mcp.records.length;
    const b0 = before();
    for (const host of ['example.com', '10.0.0.5', '192.168.1.10', '8.8.8.8', '0.0.0.0', '::ffff:127.0.0.1', '::2', 'localhost.evil.test', '127.0.0.1.nip.io', 'http://127.0.0.1', '', ' ']) {
      let looked = 0;
      const events = await run(w, [{ text: 'x' }], { reqOver: { endpoint: { host, port: w.model.port } }, adOver: { lookup: (_h, cb) => { looked++; cb(null, [{ address: '1.2.3.4', family: 4 }]); } } });
      assertRuntimeContract(events, { terminal: 'run.failed' });
      assert.equal(terminal(events).message, 'the local model endpoint must be a loopback address', host);
      assert.equal(looked, 0, `${host}: no name is resolved for a host that is not loopback by name`);
    }
    // `localhost` resolving to a non-loopback address, or to a mix, is refused.
    for (const answer of [[{ address: '8.8.8.8', family: 4 }], [{ address: '127.0.0.1', family: 4 }, { address: '8.8.8.8', family: 4 }], [], 'error']) {
      const lookup = (_h, cb) => (answer === 'error' ? cb(new Error('boom'), []) : cb(null, answer));
      const events = await run(w, [{ text: 'x' }], { reqOver: { endpoint: { host: 'localhost', port: w.model.port } }, adOver: { lookup } });
      assert.equal(terminal(events).message, 'the local model endpoint must be a loopback address');
    }
    // An unconsented port is refused with its own sentence.
    const events = await run(w, [{ text: 'x' }], { reqOver: { endpoint: { host: '127.0.0.1', port: w.model.port + 1 } } });
    assert.equal(terminal(events).message, 'the local model endpoint is not the one that was granted');
    assert.equal(before(), b0, 'none of those turns sent a request to the model server or to the MCP server');
    // `localhost` that resolves to loopback works, and the connection goes to the checked address.
    const ok = await run(w, [{ text: 'hello' }], { reqOver: { endpoint: { host: 'localhost', port: w.model.port } }, adOver: { lookup: (_h, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]) } });
    assertRuntimeContract(ok, { terminal: 'run.completed' });
    // The address forms the rule accepts.
    for (const h of ['127.0.0.1', '127.0.0.5', '::1', '[::1]', '0:0:0:0:0:0:0:1', 'LOCALHOST']) {
      const t = await endpointMod.resolveTarget({ host: h, port: 11434 }, { lookup: (_x, cb) => cb(null, [{ address: '::1', family: 6 }]) });
      assert.equal(t.ok, true, h);
      assert.ok(endpointMod.isLoopbackAddress(t.address));
    }
    for (const bad of [{ host: '127.0.0.1', port: 0 }, { host: '127.0.0.1', port: 70000 }, { host: '127.0.0.1', port: 1.5 }, { host: '127.0.0.1', port: '11434' }, { host: 5, port: 1 }]) {
      assert.equal((await endpointMod.resolveTarget(bad)).ok, false, JSON.stringify(bad));
    }
    // Without a consent list only the default address (127.0.0.1:11434) is consented: any other port is refused, before any request.
    assert.deepEqual({ ...endpointMod.DEFAULT_ENDPOINT }, { host: '127.0.0.1', port: 11434 });
    const b1 = before();
    const dflt = await collect(adapter(w, { consentedHosts: undefined }), req(w));
    assertRuntimeContract(dflt, { terminal: 'run.failed' });
    assert.equal(terminal(dflt).message, 'the local model endpoint is not the one that was granted');
    assert.equal(before(), b1, 'the refused turn sent nothing');
  } finally { await w.stop(); }
});

test('LM16 a redirect is never followed, and the bearer is never sent to a non-loopback MCP address', async () => {
  const w = await world();
  const trap = await mock.start({ script: [{ text: 'trapped' }] });
  try {
    const events = await run(w, [{ redirect: `${trap.url}/api/chat`, status: 307 }]);
    assertRuntimeContract(events, { terminal: 'run.failed' });
    assert.equal(terminal(events).code, 'runtime_error');
    assert.match(terminal(events).message, /redirect/);
    assert.equal(trap.requests.length, 0, 'the redirect target (another loopback server) was never contacted');
    // The redirect to a remote host is refused the same way (nothing is resolved or contacted).
    const e2 = await run(w, [{ redirect: 'http://example.com/api/chat', status: 302 }]);
    assert.match(terminal(e2).message, /redirect/);
    // An MCP URL that is not 127.0.0.1 is refused before anything is sent.
    const sent = [];
    for (const url of ['http://example.com/mcp', 'http://localhost:1/mcp', 'https://127.0.0.1:1/mcp', 'http://user:pw@127.0.0.1:1/mcp', 'http://127.0.0.1/mcp', 'nonsense']) {
      const e3 = await collect(adapter(w, { mcpUrl: url, fetchImpl: async (u) => { sent.push(String(u)); throw new Error('must not be called'); } }), req(w, { mcp: { url } }));
      assertRuntimeContract(e3, { terminal: 'run.failed' });
      assert.match(terminal(e3).message, /MCP server address/);
    }
    assert.deepEqual(sent, []);
  } finally { await trap.stop(); await w.stop(); }
});

test('LM17 the server\'s errors, oversize and unreadable answers fail the turn with fixed sentences; the server\'s own text is never shown', async () => {
  const w = await world();
  try {
    const cases = [[{ status: 500 }, /reported an error \(HTTP 500\)/], [{ status: 404 }, /model is not installed/], [{ status: 400 }, /refused the request/],
      [{ malformed: true }, /could not be read/], [{ raw: { nothing: true } }, /could not be read/], [{ huge: 5 * 1024 * 1024 }, /more than the allowed size/]];
    for (const [entry, re] of cases) {
      const events = await run(w, [entry]);
      assertRuntimeContract(events, { terminal: 'run.failed' });
      assert.equal(terminal(events).code, 'runtime_error');
      assert.match(terminal(events).message, re);
      assert.ok(!bytesOf(events).includes('SECRET-SERVER-ERROR-TEXT') && !bytesOf(events).includes('/home/secret'));
    }
    // A slow answer that exceeds the request timeout (tuned down here) fails; one that does not, succeeds.
    let events = await run(w, [{ hang: true }], { adOver: { tuning: { chatTimeoutMs: 300 } }, reqOver: { limits: { wallClockMs: 120_000, maxTurns: 5 } } });
    assert.match(terminal(events).message, /did not answer in time/);
    events = await run(w, [{ delayMs: 200, then: { text: 'slow but fine' } }], { adOver: { tuning: { chatTimeoutMs: 3000 } } });
    assertRuntimeContract(events, { terminal: 'run.completed' });
    // Nothing listening: unreachable.
    const dead = await mock.start(); const port = dead.port; await dead.stop();
    const e4 = await collect(createLocalModelAdapter({ token: TOKEN, mcpUrl: w.mcp.url, consentedHosts: [{ host: '127.0.0.1', port }] }), req(w, { endpoint: { host: '127.0.0.1', port } }));
    assert.match(terminal(e4).message, /could not be reached/);
  } finally { await w.stop(); }
});

test('LM18 request validation: the provider and model name, the token, the worktree path', async () => {
  const w = await world();
  try {
    let e = await collect(adapter(w), req(w, { model: { provider: 'runtime-owned', model: 'default' } }));
    assert.equal(terminal(e).code, 'protocol');
    e = await collect(adapter(w), req(w, { model: { provider: 'local-model', model: 'bad name; rm -rf' } }));
    assert.equal(terminal(e).code, 'protocol');
    e = await collect(createLocalModelAdapter({ mcpUrl: w.mcp.url, consentedHosts: [{ host: '127.0.0.1', port: w.model.port }] }), req(w));
    assert.equal(terminal(e).code, 'auth');
    e = await collect(adapter(w), req(w, { worktree: { hostPath: 'relative', editable: [] } }));
    assert.equal(terminal(e).code, 'protocol');
    assert.equal(w.model.chats().length, 0);
  } finally { await w.stop(); }
});

// ---------------------------------------------------------------- the bearer

test('LM19 the bearer appears in no request to the model server, no prompt, no event and no tool result (a result that echoes it is redacted)', async () => {
  const w = await world({}, { onCall: (name, _a, rec) => `echo:${rec.headers.authorization} and ${TOKEN}` });
  try {
    const events = await run(w, [call('context_get', {}), call('sandbox_exec', { argv: ['echo'], timeoutMs: 1000 }), { text: `my token is ${TOKEN}` }],
      { reqOver: { message: `Task mentioning ${TOKEN}` } });
    assertRuntimeContract(events, { terminal: 'run.completed' });
    for (const r of w.model.requests) {
      assert.ok(!r.body.includes(TOKEN), `${r.method} ${r.url} body`);
      assert.ok(!JSON.stringify(r.headers).includes(TOKEN), 'headers');
      assert.ok(!r.url.includes(TOKEN));
    }
    assert.ok(!bytesOf(events).includes(TOKEN));
    assert.ok(w.model.chats().flatMap((b) => b.messages).some((m) => m.role === 'tool' && m.content.includes('[redacted]')));
    // The MCP server did get it, in the header only.
    assert.ok(w.mcp.records.every((r) => r.headers.authorization === `Bearer ${TOKEN}`));
    assert.ok(w.mcp.records.every((r) => !JSON.stringify(r.params ?? {}).includes(TOKEN)));
  } finally { await w.stop(); }
});

// ---------------------------------------------------------------- the probe

test('LM20 the probe: not running, model missing, no tool support, ok; fixed sentences only; the entry parses as a runner message', async () => {
  const sentinel = 'RAW-SERVER-TEXT';
  const up = await mock.start({ models: [{ name: MODEL, capabilities: ['completion', 'tools'] }, { name: 'plain:1b', capabilities: ['completion'] },
    { name: 'old:7b', template: '{{ if .Tools }}x{{ end }}' }, { name: 'older:7b', template: 'no tools here' }] });
  const mk = (port, model) => createLocalModelAdapter({ consentedHosts: [{ host: '127.0.0.1', port }], model });
  try {
    // ok: the chosen model is installed and reports tools; the `:latest` suffix is optional.
    let a = mk(up.port, MODEL);
    let c = await a.check();
    assert.deepEqual(c.health, { ok: true, version: '0.5.7' });
    // The setup row also lists the installed models with their tool support (main offers them as the model choices).
    assert.deepEqual(c.setup, { signedIn: 'yes', flagsOk: true, label: ADAPTER_LABEL, egressHosts: [{ host: '127.0.0.1', port: up.port }],
      models: [{ name: MODEL, tools: true }, { name: 'plain:1b', tools: false }, { name: 'old:7b', tools: true }, { name: 'older:7b', tools: false }] });
    assert.equal((await mk(up.port, 'old:7b').health()).ok, true, 'an older server: the template names tools');
    // model missing
    c = await mk(up.port, 'absent:1b').check();
    assert.deepEqual(c.health, { ok: false, reason: 'error', detail: 'the chosen model is not installed on the local model server' });
    assert.equal(c.setup.flagsOk, false);
    // no tool support
    assert.deepEqual((await mk(up.port, 'plain:1b').health()), { ok: false, reason: 'version_unsupported', detail: 'the chosen model does not support tool calls' });
    assert.equal((await mk(up.port, 'older:7b').health()).ok, false);
    // no model chosen: any tool-capable installed model is enough
    assert.equal((await mk(up.port, undefined).health()).ok, true);
    // describe: the label, the loopback host and the installed models
    const d = await mk(up.port, MODEL).describe();
    assert.equal(d.label, 'Local model (Ollama)');
    assert.deepEqual(d.egressHosts, [{ host: '127.0.0.1', port: up.port }]);
    assert.deepEqual(d.models, [MODEL, 'plain:1b', 'old:7b', 'older:7b']);
    assert.equal(d.supportsHttpMcp, true);
    // The probe entry is a well-formed runner message.
    const msg = { op: 'probe.result', freeBytes: null, images: [], probe: { docker: 'missing', gpu: { detected: false, usableInContainers: false } },
      runtimes: [{ kind: a.kind, health: c.health, setup: c.setup }] };
    assert.ok(parseRunnerMessage(msg));
  } finally { await up.stop(); }
  // not running
  const dead = await mock.start(); const port = dead.port; await dead.stop();
  const nr = await mk(port, MODEL).check();
  assert.deepEqual(nr.health, { ok: false, reason: 'not_installed', detail: 'the local model server is not running' });
  assert.deepEqual(nr.setup, { signedIn: 'unknown', flagsOk: false, label: ADAPTER_LABEL, egressHosts: [{ host: '127.0.0.1', port }] });
  // tags failing, no models, no tool model among them
  const bad = await mock.start({ tagsStatus: 500 });
  try { assert.deepEqual((await mk(bad.port, MODEL).health()), { ok: false, reason: 'error', detail: 'the local model server did not list its models' }); } finally { await bad.stop(); }
  const none = await mock.start({ models: [] });
  try { assert.deepEqual((await mk(none.port, undefined).health()), { ok: false, reason: 'error', detail: 'no model is installed on the local model server' }); } finally { await none.stop(); }
  const notools = await mock.start({ models: [{ name: 'plain:1b', capabilities: ['completion'] }] });
  try { assert.deepEqual((await mk(notools.port, undefined).health()), { ok: false, reason: 'version_unsupported', detail: 'no installed model supports tool calls' }); } finally { await notools.stop(); }
  // A server that answers rubbish is reported without echoing it.
  const rubbish = await mock.start({ versionStatus: 500 });
  try { const h = await mk(rubbish.port, MODEL).health(); assert.equal(h.ok, false); assert.ok(!JSON.stringify(h).includes(sentinel)); } finally { await rubbish.stop(); }
  // The probe never reaches a non-loopback endpoint either.
  const nl = await createLocalModelAdapter({ consentedHosts: [{ host: 'example.com', port: 11434 }] }).health();
  assert.deepEqual(nl, { ok: false, reason: 'error', detail: 'the local model endpoint must be a loopback address' });
});

test('LM21 the registry builds the kind and the probe reports it next to the other adapter; nothing runs when building', () => {
  assert.equal(registry.LOCAL_MODEL_KIND, 'local-model');
  assert.equal(LOCAL_MODEL_KIND, 'local-model');
  const rt = registry.runtimeFor(LOCAL_MODEL_KIND, { token: TOKEN, mcpUrl: 'http://127.0.0.1:1/mcp' });
  assert.equal(rt.kind, 'local-model');
  for (const m of ['describe', 'health', 'start', 'cancel']) assert.equal(typeof rt[m], 'function', m);
  const kinds = registry.probeAdapters().map((a) => a.kind);
  assert.deepEqual(kinds, ['cli-agent', 'local-model']);
  for (const a of registry.probeAdapters()) for (const m of ['describe', 'health', 'setup']) assert.equal(typeof a[m], 'function', m);
  assert.throws(() => registry.runtimeFor('no-such-kind', { token: TOKEN, mcpUrl: '' }), /no runtime is registered/);
});

test('LM22 the runtime keeps its words neutral in what it reports: the display label is the only place the server\'s name appears among values the UI can show', async () => {
  const w = await world();
  try {
    const events = await run(w, [call('write_file', { path: 'a.txt', content: 'x' }), { text: 'done' }]);
    assert.ok(!/ollama|qwen|llama/i.test(bytesOf(events)), 'no vendor word in any event');
    const c = await adapter(w, { model: MODEL }).check();
    const shown = JSON.stringify({ health: c.health, detail: c.health.ok ? '' : c.health.detail });
    assert.ok(!/ollama/i.test(shown));
  } finally { await w.stop(); }
});
