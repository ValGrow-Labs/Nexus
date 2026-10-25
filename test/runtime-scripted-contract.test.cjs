'use strict';
// B2b Task 13, SR1-SR3: the ScriptedRuntime holds the same AgentRuntime contract a real adapter does. Plain node: no
// CLI, no Docker, no database; the real loopback MCP server (src/runner/mcpServer.ts) answers every `tools/call`.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { collect, assertRuntimeContract } = require('./helpers/runtimeContract.cjs');
const { textTurn, execTurn, failTurn } = require('./helpers/scriptedFixtures.cjs');

const { McpServer } = loadTs('src/runner/mcpServer.ts');
const { ScriptedRuntime, SCRIPTED_KIND } = loadTs('src/runner/runtimes/scripted.ts');

const TOKEN = `${'s'.repeat(22)}.${'t'.repeat(43)}`;
const req = (over = {}) => ({
  jobId: 'j', attempt: 1, sessionId: 'sess1', idempotencyKey: 'k', domainId: 'd', skills: [], context: { hash: 'h', file: 'c' }, message: 'm',
  worktree: { hostPath: 'w', editable: [] }, container: { id: 'c' }, mcp: { url: 'x' }, model: { provider: 'x', model: 'y' },
  limits: { wallClockMs: 60_000, maxTurns: 10 }, credential: { ref: 'runtime-owned' }, configDir: 'd', ...over
});

async function withServer(fn, onCall) {
  const calls = [];
  const server = await McpServer({
    onCall: async (callId, bearer, tool, args) => { calls.push({ bearer, tool, args }); await onCall?.(calls.length); return { ok: true, value: { tool } }; },
    onExecGrant: async () => ({ ok: true, value: 'ran' })
  });
  try { return await fn(server, calls); } finally { await server.close(); }
}

test('SR1 a scripted turn yields start, its steps in order and exactly one terminal; usage is cumulative; tool calls pair up', async () => {
  await withServer(async (server, calls) => {
    const steps = [{ op: 'delta', text: 'hi' }, { op: 'usage', inputTokens: 5, outputTokens: 1, toolCalls: 0 }, { op: 'call', tool: 'context_get', args: {} },
      { op: 'usage', inputTokens: 9, outputTokens: 3, toolCalls: 1 }, { op: 'complete' }];
    const events = await collect(new ScriptedRuntime({ token: TOKEN, mcpUrl: server.url, steps }), req());
    assertRuntimeContract(events, { terminal: 'run.completed' });
    assert.deepEqual(events.map((e) => e.t), ['run.started', 'message.delta', 'usage', 'tool.started', 'tool.completed', 'usage', 'run.completed']);
    assert.equal(calls.length, 1);
    // A turn with no explicit end completes; a failing turn fails once; the shared fixtures hold the same contract.
    assertRuntimeContract(await collect(new ScriptedRuntime({ token: TOKEN, mcpUrl: server.url, steps: textTurn('only text') }), req()), { terminal: 'run.completed' });
    assertRuntimeContract(await collect(new ScriptedRuntime({ token: TOKEN, mcpUrl: server.url, steps: execTurn(['echo', 'hi']) }), req()));
    const failed = await collect(new ScriptedRuntime({ token: TOKEN, mcpUrl: server.url, steps: failTurn('refused', 'limit') }), req());
    assertRuntimeContract(failed, { terminal: 'run.failed' });
    assert.equal(failed[failed.length - 1].code, 'limit');
  });
});

test('SR2 aborting the signal ends the turn with run.cancelled once, and no later step runs', async () => {
  const ac = new AbortController();
  await withServer(async (server, calls) => {
    const steps = [{ op: 'call', tool: 'context_get', args: {} }, { op: 'call', tool: 'artifact_list', args: {} }, { op: 'call', tool: 'job_status', args: {} }, { op: 'complete' }];
    const events = await collect(new ScriptedRuntime({ token: TOKEN, mcpUrl: server.url, steps }), req(), ac.signal);
    assertRuntimeContract(events, { terminal: 'run.cancelled' });
    assert.equal(calls.length, 1, 'only the call before the abort ran');
  }, () => ac.abort());
  // Already aborted before the first step: a start and a cancel, nothing else.
  const pre = new AbortController(); pre.abort();
  const events = await collect(new ScriptedRuntime({ token: TOKEN, mcpUrl: 'http://127.0.0.1:1/mcp', steps: [{ op: 'call', tool: 'context_get', args: {} }] }), req(), pre.signal);
  assert.deepEqual(events.map((e) => e.t), ['run.started', 'run.cancelled']);
});

test('SR3 the bearer is only an Authorization header; the runtime describes itself neutrally, with no egress', async () => {
  await withServer(async (server, calls) => {
    const seen = [];
    const fetchImpl = (url, init) => { seen.push({ url: String(url), headers: { ...init.headers }, body: String(init.body) }); return fetch(url, init); };
    const rt = new ScriptedRuntime({ token: TOKEN, mcpUrl: server.url, steps: [{ op: 'call', tool: 'context_get', args: { part: 'x' } }], fetchImpl });
    const events = await collect(rt, req());
    assertRuntimeContract(events, { terminal: 'run.completed' });
    assert.equal(calls[0].bearer, TOKEN, 'the server received the bearer');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.ok(!seen[0].url.includes(TOKEN) && !seen[0].body.includes(TOKEN), 'not in the URL or the body');
    assert.ok(!JSON.stringify(events).includes(TOKEN), 'not in any event');
    const d = await rt.describe();
    assert.equal(rt.kind, SCRIPTED_KIND);
    assert.deepEqual(d.egressHosts, []);
    assert.equal(d.supportsHttpMcp, true);
    assert.equal((await rt.health()).ok, true);
    await rt.cancel('r', 0);
  });
});
