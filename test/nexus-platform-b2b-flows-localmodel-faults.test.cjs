'use strict';
// The Nexus local-model runtime's fault paths through the real pipeline (LMF3-LMF6): the same world as test/nexus-platform-b2b-flows-localmodel.test.cjs
// (the REAL local-model adapter over a MOCK model server on loopback; real main, the real runner core, the fake sandbox driver).
//   LMF3  caps: the token cap and the tool-call cap end the turn as a limit, a model that repeats itself is cut off; nothing registered; tokens revoked
//   LMF4  a weak model: a malformed call, an unknown tool, escaping paths and a call written as text get corrective results; the work still completes
//   LMF5  the destination rule through the product: a non-loopback address, a name, another port, credentials: refused with a fixed sentence,
//         at start and at the lease, before anything is sent to any model server
//   LMF6  a model that only talks ends partial / no_change; a model server that went away fails the turn with a fixed sentence
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { sound } = require('./helpers/agentFlowWorld.cjs');
const L = require('./helpers/localModelFlows.cjs');
const { lmWorld, buildTurn, calls, say, writeFile, exec, chatRequests, assertNoBearer, agentContainers } = L;
const { NODE } = require('./helpers/agentFlowCode.cjs');
const { intent, noLeak } = require('./helpers/ipcExec.cjs');
const { AGENT_REASON_MESSAGES } = loadTs('src/main/nexusIpc/envelope.ts');

const CS_VALIDATORS = ['git.diff_nonempty', 'git.paths_in_scope', 'sec.secret_scan', 'cs.tests_pass', 'git.applies_cleanly'];

// ---------------------------------------------------------------- LMF3: caps and a model that never stops

test('LMF3 the turn\'s token cap and tool-call cap end it as a limit, a model that repeats itself is cut off; nothing is registered and every token is revoked', async () => {
  // ----- tokens: the consent's cap is smaller than what the server reports for one reply
  const w1 = await lmWorld({ caps: { turnTokens: 500 } });
  w1.model([calls([writeFile('src/a.js', 'module.exports = 1;\n')], { in: 400, out: 400 }), calls([exec(['node', '--test'])]), say('never reached')]);
  const t1 = await w1.turn('Write a file');
  assert.equal(t1.job.state, 'failed'); assert.equal(t1.job.outcome, 'limit', t1.job.error_json);
  assert.match(JSON.parse(t1.job.error_json).message, /limit/);
  assert.equal(chatRequests(w1).length, 1, 'the model was not asked again after the cap');
  assert.equal(w1.changeSetsOf(t1.jobId).length, 0);
  assert.equal(w1.execs.length, 0, 'no command ran after the cap');
  assertNoBearer(w1, 'LMF3 tokens');
  assert.equal(agentContainers(w1), 0);
  sound(w1, 'LMF3 tokens');

  // ----- tool calls: three calls in one reply against a cap of two
  const w2 = await lmWorld({ caps: { toolCalls: 2 } });
  w2.model([calls([writeFile('a.txt', 'a\n'), writeFile('b.txt', 'b\n'), writeFile('c.txt', 'c\n')]), say('never reached')]);
  const t2 = await w2.turn('Write three files');
  assert.equal(t2.job.state, 'failed'); assert.equal(t2.job.outcome, 'limit', t2.job.error_json);
  assert.equal(w2.changeSetsOf(t2.jobId).length, 0);
  assertNoBearer(w2, 'LMF3 tool calls');
  sound(w2, 'LMF3 tool calls');

  // ----- a model that asks for the same thing for ever is stopped by the loop, not by the clock
  const w3 = await lmWorld({ script: () => calls([['list_files', { path: '' }]]) });
  const t3 = await w3.turn('Look around');
  assert.equal(t3.job.state, 'failed', t3.job.error_json);
  assert.equal(t3.job.outcome, 'runtime_protocol');
  assert.equal(JSON.parse(t3.job.error_json).message, 'the model kept repeating the same tool call');
  assert.ok(chatRequests(w3).length <= 8, `the loop cut it off (${chatRequests(w3).length} model calls)`);
  assert.equal(w3.changeSetsOf(t3.jobId).length, 0);
  assertNoBearer(w3, 'LMF3 repeat');
  sound(w3, 'LMF3 repeat');
});

// ---------------------------------------------------------------- LMF4: a weak model

test('LMF4 a weak model: a malformed call, an unknown tool, an escaping path and a call written as text each get a corrective result, and the work still completes', async () => {
  const w = await lmWorld();
  const outside = path.join(w.dataHome.root, 'wt');
  const before = w.userState();
  const registerText = JSON.stringify({ name: 'changeset_register', arguments: { title: 'Add the ledger export', summary: 'Done.', clientKey: 'cs-weak' } });
  w.model([
    { calls: [{ name: 'write_file', args: '{"path": "src/ledger.js", "content": ' }] },       // arguments that are not JSON
    calls([['run_shell', { cmd: 'ls' }]]),                                                    // a tool that does not exist
    calls([writeFile('../escape.txt', 'out\n'), writeFile('.git/config', '[core]\n'), writeFile('C:/Windows/x.txt', 'x\n')]),  // paths that leave the worktree
    calls(Object.entries(NODE.ledger).map(([p, c]) => writeFile(p, c))),                       // then the real work
    calls([exec(['node', '--test'])]),
    { text: registerText },                                                                    // the registration, as text instead of a tool call
    say('Done.')
  ]);
  const t = await w.turn('Implement the ledger export');
  assert.equal(t.job.state, 'completed', t.job.error_json);
  const reqs = chatRequests(w).map((r) => JSON.parse(r.body));
  const toolText = (n) => reqs[n].messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
  assert.ok(toolText(1).length >= 1 && /arguments|invalid|json/i.test(toolText(1).join('\n')), `a malformed call got a corrective result: ${toolText(1).join(' | ')}`);
  assert.ok(/no tool named|unknown/i.test(toolText(2).join('\n')), `an unknown tool got a corrective result: ${toolText(2).join(' | ')}`);
  const refusals = toolText(3).slice(-3);
  assert.equal(refusals.length, 3);
  for (const r of refusals) {
    assert.match(r, /^ERROR: /, `an escaping path is refused with an error result: ${r}`);
    assert.ok(!/escape.txt|Windows/.test(r), 'the refusal does not echo the path');
  }
  // nothing was written outside the worktree, and the user's folder is unchanged
  assert.equal(fs.existsSync(path.join(outside, 'escape.txt')), false);
  assert.equal(fs.existsSync(path.join(w.dataHome.root, 'escape.txt')), false);
  assert.equal(fs.existsSync('C:/Windows/x.txt'), false);
  const wt = w.db.prepare('SELECT rel_path FROM session_worktrees WHERE session_id = ?').get(t.sessionId);
  const dir = path.join(w.dataHome.root, ...wt.rel_path.split('/'));
  assert.equal(fs.existsSync(path.join(dir, 'escape.txt')), false);
  assert.deepEqual(w.userState(), before);
  // the work that followed was registered, and the text call was run as the call it meant
  const [cs] = w.changeSetsOf(t.jobId);
  assert.ok(cs, 'the change set registered by a call written as text');
  assert.equal(await w.until_candidate(cs), 'candidate');
  for (const v of CS_VALIDATORS) assert.equal(w.checks(cs)[v], 'passed', v);
  assert.match(JSON.stringify(reqs.at(-1).messages), /written as text/, 'the model was told to use the tool interface');
  const used = w.db.prepare("SELECT json_extract(data_json, '$.tool') t FROM job_events WHERE job_id = ? AND type = 'attempt.progress' AND json_extract(data_json, '$.t') = 'runtime.tool' ORDER BY rowid").all(t.jobId).map((e) => e.t);
  assert.ok(used.includes('run_shell') || used.includes('tool'), `the unknown call is in the record under a fixed name (${used.join(',')})`);
  assertNoBearer(w, 'LMF4');
  sound(w, 'LMF4');
});

// ---------------------------------------------------------------- LMF5: the destination rule

test('LMF5 a non-loopback address, a name, or an address other than the one granted is refused with a fixed sentence before anything is sent to any model server', async () => {
  const w = await lmWorld();
  const port = new URL(w.ollama.url).port;
  const startRefused = async (baseUrl, why) => {
    w.lmCfg.baseUrl = baseUrl;
    const r = await w.drive(w.x.call('nexus:agent:start', { projectId: w.PROJECT, workspaceId: w.WORKSPACE, sessionId: null, focusVersionIds: [], message: 'do it', intentId: intent() }));
    assert.equal(r.ok, false, `${why}: ${JSON.stringify(r)}`);
    assert.equal(r.reason, 'local_model_endpoint', why);
    assert.equal(r.message, AGENT_REASON_MESSAGES.local_model_endpoint, 'the fixed sentence');
    noLeak(r);
    assert.ok(!JSON.stringify(r).includes(String(baseUrl).replace(/^https?:\/\//, '').split('/')[0].split(':')[0]) || /^127\./.test(baseUrl.replace(/^https?:\/\//, '')), `${why}: the refused address is not echoed`);
  };
  await startRefused('http://192.168.1.20:11434/v1', 'a LAN address');
  await startRefused('http://evil.example.com:11434/v1', 'a remote name');
  await startRefused('http://10.0.0.5:11434/v1', 'a private address');
  await startRefused('http://[::ffff:127.0.0.1]:' + port + '/v1', 'an IPv4-mapped IPv6 address');
  await startRefused(`http://127.0.0.1:${Number(port) === 11434 ? 11435 : 11434}/v1`, 'a loopback address on a port that was not granted');
  await startRefused(`http://user:pw@127.0.0.1:${port}/v1`, 'an address with credentials');
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind = 'agent.run'").get().n, 0, 'no turn was created');
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM capability_tokens').get().n, 0, 'no token was minted');
  assert.equal(chatRequests(w).length, 0, 'no chat request went to any server');

  // the address changes between the user's message and the lease: the turn fails at the lease with the same sentence, nothing is minted
  w.lmCfg.baseUrl = `http://127.0.0.1:${port}/v1`;
  const r = await w.start('Write a file');
  w.lmCfg.baseUrl = 'http://192.168.1.20:11434/v1';
  await w.approveA3();
  await w.until(() => w.ended(r.job.id), 'the turn ends');
  const job = w.jobRow(r.job.id);
  assert.equal(job.state, 'failed', job.error_json);
  assert.equal(JSON.parse(job.error_json).code, 'local_model_endpoint');
  assert.match(JSON.parse(job.error_json).message, /^the local model address is not on this computer, or is not the one that was given permission/, 'the lease-time sentence is fixed and names no address');
  assert.ok(!job.error_json.includes('192.168'));
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM capability_tokens').get().n, 0, 'nothing was minted for it');
  assert.equal(chatRequests(w).length, 0, 'still nothing sent to any model server');
  assert.equal(agentContainers(w), 0);
  sound(w, 'LMF5');
});

// ---------------------------------------------------------------- LMF6: a turn that changes nothing, and a model server that went away

test('LMF6 a model that only talks ends partial / no_change, and a model server that went away fails the turn plainly: nothing registered, the token revoked, no raw error text kept', async () => {
  const w = await lmWorld();
  w.model([say('I looked at it and think it is fine.'), say('Nothing to change.'), say('Still nothing.'), say('Really nothing.')]);
  const t = await w.turn('Please look at the ledger');
  assert.deepEqual([t.job.state, t.job.outcome], ['partial', 'no_change'], 'talking is not a change');
  assert.equal(w.changeSetsOf(t.jobId).length, 0);
  assert.notEqual(w.stepOf('ai-implementation'), 'done');
  // the model server goes away
  const requests = w.ollama.requests;
  await w.ollama.stop();
  w.ollama = { requests, chats: () => [], stop: async () => {}, url: w.modelUrl };
  const t2 = await w.turn('Try again', { sessionId: t.sessionId });
  assert.deepEqual([t2.job.state, t2.job.outcome], ['failed', 'runtime_error'], t2.job.error_json);
  assert.equal(JSON.parse(t2.job.error_json).message, 'the local model server could not be reached', 'a fixed sentence: no socket error text');
  assert.ok(!/ECONNREFUSED|connect/i.test(t2.job.error_json));
  assert.equal(w.changeSetsOf(t2.jobId).length, 0);
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM capability_tokens WHERE revoked_at IS NULL').get().n, 0);
  assert.equal(agentContainers(w), 0);
  sound(w, 'LMF6');
});
