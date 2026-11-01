'use strict';
// The Nexus hosted-model runtime's fault paths through the real pipeline (HMF3-HMF5): the same world as test/nexus-platform-b2b-flows-hostedmodel.test.cjs
// (the REAL hosted-model adapter over a MOCK chat API on loopback through the runner's test seam; the key in the real key store; real main, the
// real runner core, the fake sandbox driver). No real provider and no real key.
//   HMF3  caps: the token cap and the tool-call cap end the turn as a limit, a model that repeats itself is cut off; nothing registered; tokens revoked
//   HMF4  a weak model: a malformed call, an unknown tool, escaping paths and a call written as text get corrective results; the work still completes
//   HMF5  the free tier, end to end: 401 (key rejected, the conversation goes on, the setup row says so), 429 then success after Retry-After, the
//         free quota exhausted, the rate limit that never lets up, a model the provider does not have: each ends as its fixed sentence and job
//         outcome; the provider's own text is kept nowhere
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { sound } = require('./helpers/agentFlowWorld.cjs');
const F = require('./helpers/hostedModelFlows.cjs');
const { hmWorld, buildTurn, calls, say, writeFile, exec, chatRequests, assertNoKey, agentContainers, jobError, everything, mock } = F;
const { NODE } = require('./helpers/agentFlowCode.cjs');
const { MSG } = loadTs('src/runner/runtimes/hostedModel/messages.ts');

const CS_VALIDATORS = ['git.diff_nonempty', 'git.paths_in_scope', 'sec.secret_scan', 'cs.tests_pass', 'git.applies_cleanly'];

// ---------------------------------------------------------------- HMF3: caps and a model that never stops

test('HMF3 the turn\'s token cap and tool-call cap end it as a limit, a model that repeats itself is cut off; nothing is registered and every token is revoked', async () => {
  // ----- tokens: the consent's cap is smaller than what the provider reports for one reply
  const w1 = await hmWorld({ caps: { turnTokens: 500 } });
  try {
    w1.model([calls([writeFile('src/a.js', 'module.exports = 1;\n')], { in: 400, out: 400 }), calls([exec(['node', '--test'])]), say('never reached')]);
    const t1 = await w1.turn('Write a file');
    assert.equal(t1.job.state, 'failed'); assert.equal(t1.job.outcome, 'limit', t1.job.error_json);
    assert.match(jobError(t1.job).message, /limit/);
    assert.equal(chatRequests(w1).length, 1, 'the model was not asked again after the cap');
    assert.equal(w1.changeSetsOf(t1.jobId).length, 0);
    assert.equal(w1.execs.length, 0, 'no command ran after the cap');
    assertNoKey(w1, 'HMF3 tokens');
    assert.equal(agentContainers(w1), 0);
    sound(w1, 'HMF3 tokens');
  } finally { await w1.close(); }

  // ----- tool calls: three calls in one reply against a cap of two
  const w2 = await hmWorld({ caps: { toolCalls: 2 } });
  try {
    w2.model([calls([writeFile('a.txt', 'a\n'), writeFile('b.txt', 'b\n'), writeFile('c.txt', 'c\n')]), say('never reached')]);
    const t2 = await w2.turn('Write three files');
    assert.equal(t2.job.state, 'failed'); assert.equal(t2.job.outcome, 'limit', t2.job.error_json);
    assert.equal(w2.changeSetsOf(t2.jobId).length, 0);
    assertNoKey(w2, 'HMF3 tool calls');
    sound(w2, 'HMF3 tool calls');
  } finally { await w2.close(); }

  // ----- a model that asks for the same thing for ever is stopped by the loop, not by the clock
  const w3 = await hmWorld({ script: () => calls([['list_files', { path: '' }]]) });
  try {
    const t3 = await w3.turn('Look around');
    assert.equal(t3.job.state, 'failed', t3.job.error_json);
    assert.equal(t3.job.outcome, 'runtime_protocol');
    assert.equal(jobError(t3.job).message, 'the model kept repeating the same tool call');
    assert.ok(chatRequests(w3).length <= 8, `the loop cut it off (${chatRequests(w3).length} model calls)`);
    assert.equal(w3.changeSetsOf(t3.jobId).length, 0);
    assertNoKey(w3, 'HMF3 repeat');
    sound(w3, 'HMF3 repeat');
  } finally { await w3.close(); }
});

// ---------------------------------------------------------------- HMF4: a weak model

test('HMF4 a weak model: a malformed call, an unknown tool, an escaping path and a call written as text each get a corrective result, and the work still completes', async () => {
  const w = await hmWorld();
  try {
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
    assert.equal(fs.existsSync(path.join(outside, 'escape.txt')), false);
    assert.equal(fs.existsSync(path.join(w.dataHome.root, 'escape.txt')), false);
    assert.equal(fs.existsSync('C:/Windows/x.txt'), false);
    const wt = w.db.prepare('SELECT rel_path FROM session_worktrees WHERE session_id = ?').get(t.sessionId);
    const dir = path.join(w.dataHome.root, ...wt.rel_path.split('/'));
    assert.equal(fs.existsSync(path.join(dir, 'escape.txt')), false);
    assert.deepEqual(w.userState(), before);
    const [cs] = w.changeSetsOf(t.jobId);
    assert.ok(cs, 'the change set registered by a call written as text');
    assert.equal(await w.until_candidate(cs), 'candidate');
    for (const v of CS_VALIDATORS) assert.equal(w.checks(cs)[v], 'passed', v);
    assert.match(JSON.stringify(reqs.at(-1).messages), /written as text/, 'the model was told to use the tool interface');
    assertNoKey(w, 'HMF4');
    sound(w, 'HMF4');
  } finally { await w.close(); }
});

// ---------------------------------------------------------------- HMF5: the free tier, end to end

test('HMF5 free-tier errors end as their fixed sentences and outcomes: 401, 429 then success, quota exhausted, a rate limit that never lets up, a missing model; the provider\'s text is kept nowhere', async () => {
  const w = await hmWorld();
  try {
    const consentProblem = async () => (await w.x.ok('nexus:agent:consent', { op: 'get' })).runtimes.find((r) => r.kind === 'hosted-model').problem;
    const failedTurn = async (script, message, sessionId) => {
      w.model(script);
      const before = chatRequests(w).length;
      const t = await w.turn(message, { sessionId });
      return { t, asked: chatRequests(w).length - before };
    };
    let session = null;

    // ----- 401: the key was rejected. One request, no retry; the outcome is the reason main has copy for; the conversation is not over
    const r401 = await failedTurn([{ status: 401, code: 'invalid_api_key' }], 'Write a file', session);
    session = r401.t.sessionId;
    assert.deepEqual([r401.t.job.state, r401.t.job.outcome], ['failed', 'hosted_key_rejected'], r401.t.job.error_json);
    assert.equal(r401.asked, 1, 'a rejected key is not retried');
    assert.equal(jobError(r401.t.job).code, 'hosted_key_rejected');
    assert.equal(await consentProblem(), 'key_rejected', 'the setup row says the key was rejected');
    assert.equal((await w.x.ok('nexus:platform:health')).agent.problem, 'key_rejected');
    assert.equal(w.changeSetsOf(r401.t.jobId).length, 0);

    // ----- 429 with a Retry-After, then success: the turn waits, retries and completes; only the answered request counts as tokens
    const ok429 = await failedTurn([{ status: 429, retryAfter: 0.05 }, ...buildTurn(NODE.ledger, { title: 'Add the ledger export', clientKey: 'cs-429', tokens: { in: 100, out: 40 } })], 'Implement the ledger export', session);
    assert.equal(ok429.t.job.state, 'completed', ok429.t.job.error_json);
    assert.equal(ok429.asked, 5, 'one throttled request, then the four of the turn');
    const [cs] = w.changeSetsOf(ok429.t.jobId);
    assert.ok(cs);
    assert.equal(await w.until_candidate(cs), 'candidate');
    const usage = JSON.parse(w.db.prepare('SELECT usage_json FROM job_attempts WHERE job_id = ?').get(ok429.t.jobId).usage_json);
    assert.deepEqual([usage.inputTokens, usage.outputTokens, usage.costUsdCents, usage.estimated], [400, 160, 0, false], 'the provider\'s counts for the answers it gave');
    assert.equal(await consentProblem(), null, 'a good turn after the rejection: no problem shown');

    // ----- the free daily quota is gone: its own outcome at once, no waiting, no retry
    const quota = await failedTurn([{ status: 429, body: { error: { code: 'insufficient_quota', message: 'You exceeded your free tier. requests per day' } } }], 'Write a file', session);
    assert.deepEqual([quota.t.job.state, quota.t.job.outcome], ['failed', 'hosted_quota_exhausted'], quota.t.job.error_json);
    assert.equal(quota.asked, 1);
    assert.equal(jobError(quota.t.job).code, 'hosted_quota_exhausted');

    // ----- a rate limit that never lets up: bounded retries (4), then its own outcome
    const rate = await failedTurn(() => ({ status: 429, retryAfter: 0.01 }), 'Write a file', session);
    assert.deepEqual([rate.t.job.state, rate.t.job.outcome], ['failed', 'hosted_rate_limited'], rate.t.job.error_json);
    assert.equal(rate.asked, 5, 'one try and four retries, then the turn ends');
    assert.equal(jobError(rate.t.job).code, 'hosted_rate_limited');

    // ----- the provider does not have the model: its own outcome
    const gone = await failedTurn([{ status: 404, code: 'model_not_found' }], 'Write a file', session);
    assert.deepEqual([gone.t.job.state, gone.t.job.outcome], ['failed', 'hosted_model_unavailable'], gone.t.job.error_json);
    assert.equal(gone.asked, 1);

    // ----- the provider refused the request (HTTP 400): the turn keeps the one fixed sentence, and the adapter's own short diagnostic line (status and the provider's
    // short label, never its text) reaches the turn's job log, because the runner hands the adapter a logger.
    const refused = await failedTurn([{ status: 400, code: 'invalid_request_error' }], 'Write a file', session);
    assert.notEqual(refused.t.job.state, 'completed');
    const logText = fs.readdirSync(path.join(w.dataHome.root, 'logs', 'jobs', refused.t.jobId)).map((f) => fs.readFileSync(path.join(w.dataHome.root, 'logs', 'jobs', refused.t.jobId, f), 'utf8')).join('\n');
    assert.ok(logText.includes('hosted model: the provider refused a request (HTTP 400, invalid_request_error error)'), `the diagnostic line is in the job log: ${logText.slice(-400)}`);

    // ----- the provider's own text (mock: a secret-looking message with a path) is in no row, log or file; each sentence is main's own
    const all = everything(w);
    assert.ok(!all.includes('SECRET-PROVIDER-ERROR-TEXT') && !all.includes('You exceeded your free tier'),'the provider\'s error text is kept nowhere');
    for (const t of [r401.t, quota.t, rate.t, gone.t]) {
      const e = jobError(t.job);
      assert.ok(e && typeof e.message === 'string' && e.message.length > 0 && e.message.length < 200, 'a short fixed sentence');
      assert.ok(!/SECRET|\/home|quota details/.test(JSON.stringify(e)));
      assert.equal(w.changeSetsOf(t.jobId).length, 0);
    }
    assert.ok(Object.values(MSG).filter((m) => typeof m === 'string').every((m) => !/groq|gemini/i.test(m)), 'the runner\'s sentences name no provider');
    assert.equal(agentContainers(w), 0);
    assertNoKey(w, 'HMF5');
    sound(w, 'HMF5');
  } finally { await w.close(); }
});
