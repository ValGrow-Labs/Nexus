'use strict';
// The Nexus local-model runtime, end to end through the real pipeline (LMF1-LMF2 here; the fault paths LMF3-LMF6 are in nexus-platform-b2b-flows-localmodel-faults.test.cjs, a second file so each stays well inside the runner's 180 s limit). The agent is the REAL local-model adapter
// (src/runner/runtimes/localModel/), built by the runner as in production and talking over loopback to a MOCK model server
// (test/helpers/mockOllama.cjs) whose replies are scripted per call; the rest is the node flows' world (test/helpers/agentFlowWorld.cjs):
// real main on a real SQLite database, the real runner core in this process (real git, the real loopback MCP server, the real
// worktree guard), the fake sandbox driver. The mock model is not a real model: what these prove is that a model that calls the file
// tools, sandbox_exec and changeset_register drives the whole platform from request to merge, that its failures end as the platform
// says, and that nothing it must not touch (the bearer, a path outside the worktree, a remote address) is reachable. A real model on a
// real Ollama is the controller's showcase (tools/nexus-demo-local-model.cjs); the real Docker variant is test/nexus-exec-agent-localmodel.test.cjs.
//
//   LMF1  the whole flow: consent for the local-model kind + a model (#51) -> a turn (write_file x2, sandbox_exec, changeset_register) ->
//         change set candidate (cs.tests_pass on its own head) -> review -> accept -> merge -> an iteration (request_changes -> a second
//         turn on the same worktree, v2 derived from v1) -> accepted and merged; the user's folder untouched until accept
//   LMF2  the model's own failing -> fixed loop inside one turn (sandbox_exec output reaches it), then a registered failing change set
//         is fixed by the next turn (v2 derived from v1)
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const H = require('./helpers/agentFlowWorld.cjs');
const { sound } = H;
const L = require('./helpers/localModelFlows.cjs');
const { lmWorld, buildTurn, calls, say, writeFile, exec, register, MODEL } = L;
const { NODE } = require('./helpers/agentFlowCode.cjs');
const { intent, noLeak } = require('./helpers/ipcExec.cjs');
const { AGENT_REASON_MESSAGES } = loadTs('src/main/nexusIpc/envelope.ts');

const CS_VALIDATORS = ['git.diff_nonempty', 'git.paths_in_scope', 'sec.secret_scan', 'cs.tests_pass', 'git.applies_cleanly'];
const metaOf = (w, v) => JSON.parse(w.versionRow(v).metadata_json);
const storageOf = (w, v) => JSON.parse(w.versionRow(v).storage_ref_json);
const { chatRequests, assertNoBearer, agentContainers } = L;

// ---------------------------------------------------------------- LMF1

test('LMF1 a local model drives the whole flow: consent + model -> turn (file tools, sandbox_exec, changeset_register) -> cs.tests_pass -> review -> accept -> merge -> iteration', async () => {
  const w = await lmWorld();
  const x = w.x;
  assert.equal(w.stepOf('repository'), 'done');
  const view = await x.ok('nexus:agent:consent', { op: 'get' });
  assert.equal(view.state, 'ready'); assert.equal(view.consent.live, true); assert.equal(view.consent.hostsCount, 1);
  const rt = view.runtimes.find((r) => r.kind === 'local-model');
  assert.ok(rt, 'the picker lists the local-model runtime'); assert.equal(rt.selected, true); assert.equal(rt.model, MODEL);
  assert.deepEqual(rt.hosts, [`127.0.0.1:${new URL(w.ollama.url).port}`], 'the permission covers the loopback address of the model server and nothing else');
  const userBefore = w.userState();

  // ----- turn A: the model writes the code and its tests, runs them in the sandbox, registers the change
  w.model(buildTurn(NODE.ledger, { title: 'Add the ledger export', summary: 'toCsv with escaping, and its tests.', clientKey: 'cs-a', tokens: { in: 300, out: 80 } }));
  const a = await w.turn('Implement the ledger export as CSV');
  assert.equal(a.job.state, 'completed', a.job.error_json);
  const [csA] = w.changeSetsOf(a.jobId);
  assert.ok(csA, 'changeset_register through the real MCP server registered a change set');
  assert.equal(await w.until_candidate(csA), 'candidate');
  const checksA = w.checks(csA);
  for (const v of CS_VALIDATORS) assert.equal(checksA[v], 'passed', `${v}: ${JSON.stringify(checksA)}`);
  const headA = storageOf(w, csA).commit; const mA = metaOf(w, csA);
  assert.equal(mA.title, 'Add the ledger export');
  assert.equal(w.git('rev-parse', `${headA}^`), mA.base, 'one commit on its base');
  assert.match(w.git('log', '-1', '--format=%B', headA), new RegExp(`Nexus-Job: ${a.jobId}`));
  assert.ok(w.played.some((p) => p.files.includes('test/ledger.test.js') && p.files.includes('src/ledger.js')), 'cs.tests_pass ran on the staged head commit, which holds what the model wrote');
  assert.deepEqual(w.userState(), userBefore, 'the model wrote into the turn\'s worktree only: the user\'s folder, branch and index are untouched');
  assert.equal(w.stepOf('ai-implementation'), 'done');
  // the model's command ran through sandbox_exec (the container), the files through the adapter's host tools
  assert.equal(w.execs.filter((e) => e.argv[0] === 'node').length, 1, 'one command, in the container');
  assert.deepEqual(w.execResults(a.jobId).map((r) => [r.argv.includes('node') && r.argv.includes('--test'), r.exit]), [[true, 0]]);
  // what the attempt records: the runtime kind, the server's own token counts, no cost, not an estimate
  const attempt = w.db.prepare('SELECT * FROM job_attempts WHERE job_id = ?').get(a.jobId);
  assert.equal(attempt.runtime_kind, 'local-model'); assert.equal(attempt.state, 'succeeded');
  const usage = JSON.parse(attempt.usage_json);
  assert.equal(usage.inputTokens, 4 * 300); assert.equal(usage.outputTokens, 4 * 80); assert.equal(usage.costUsdCents, 0); assert.equal(usage.estimated, false);
  assert.equal(usage.toolCalls, 4, 'two writes, one command, one registration');
  const progress = (job, kind) => w.db.prepare("SELECT json_extract(data_json, '$.tool') t FROM job_events WHERE job_id = ? AND type = 'attempt.progress' AND json_extract(data_json, '$.t') = ? ORDER BY rowid").all(job, kind).map((e) => e.t);
  assert.deepEqual(progress(a.jobId, 'runtime.tool'), ['write_file', 'write_file', 'sandbox_exec', 'changeset_register'], 'every tool the model used: the host file tools and the runner tools');
  assert.deepEqual(progress(a.jobId, 'tool'), ['sandbox_exec', 'changeset_register'], 'the record of the calls that went through the MCP gateway');
  // the requests the model server received: its model, the tools offered (host file tools + the runner's), the loop's history
  const reqs = chatRequests(w);
  assert.equal(reqs.length, 4);
  assert.equal(reqs[0].headers.host, `127.0.0.1:${new URL(w.ollama.url).port}`);
  const body0 = JSON.parse(reqs[0].body);
  assert.equal(body0.model, MODEL); assert.equal(body0.stream, false);
  const offered = body0.tools.map((t) => t.function.name);
  for (const t of ['read_file', 'write_file', 'list_files', 'delete_file', 'sandbox_exec', 'changeset_register']) assert.ok(offered.includes(t), `offered: ${t}`);
  assert.match(body0.messages.map((m) => String(m.content)).join('\n'), /ledger export as CSV/, 'the user\'s message reached the model');
  assert.ok(JSON.parse(reqs[3].body).messages.some((m) => m.role === 'tool' && /ok - exports one line per row/.test(String(m.content))), 'the model saw the real test output of its own sandbox_exec');
  assert.equal(agentContainers(w), 0);

  // ----- review (#47) then accept (#48): the integration ref moves, the user's branch does not
  await x.ok('nexus:review:decide', csA, { decision: 'approve' }, intent());
  const st0 = await w.okd('nexus:repo:status', w.PROJECT);
  const acc = await w.okd('nexus:changeSet:accept', csA, st0.acceptedHead);
  const mergeA = acc.accept.mergeCommit;
  assert.deepEqual(w.git('rev-list', '--parents', '-1', mergeA).split(' ').slice(1), [st0.acceptedHead, headA]);
  assert.deepEqual(w.userState(), userBefore, 'accept never touches the user\'s branch, index or files');
  assert.equal(await w.railStep('review'), 'done');
  // ----- "Merge accepted work": the dialog confirms; the user's branch fast-forwards
  const st1 = await w.okd('nexus:repo:status', w.PROJECT);
  assert.equal(st1.acceptedNotMerged, 1); assert.equal(st1.canFastForward, true);
  await w.okd('nexus:repo:mergeAccepted', w.PROJECT, { branch: st1.branch, expectedAcceptedHead: st1.acceptedHead });
  assert.equal(w.userHead(), mergeA, 'the user\'s branch is fast-forwarded to the confirmed sha');
  assert.ok(fs.existsSync(path.join(w.repoDir, 'src', 'ledger.js')) && fs.existsSync(path.join(w.repoDir, 'test', 'ledger.test.js')), 'what the model wrote is now in the user\'s folder');
  assert.match(w.dialogs[0].opts.detail, /Add the ledger export/);

  // ----- the iteration: a first version of a second change, the reviewer asks for changes, the model revises it on the same worktree
  w.model(buildTurn(NODE.pageV1, { title: 'Paginate the ledger', summary: 'First try.', clientKey: 'cs-b1' }));
  const b = await w.turn('Add a pagination helper', { sessionId: a.sessionId });
  assert.equal(b.job.state, 'completed', b.job.error_json);
  const [csB1] = w.changeSetsOf(b.jobId);
  assert.equal(await w.until_candidate(csB1), 'candidate');
  const artifactB = w.versionRow(csB1).artifact_id;
  const comment = 'Please handle a short last page and an empty ledger.';
  w.model(buildTurn(NODE.pageV2, { title: 'Paginate the ledger', summary: 'Edge cases handled.', clientKey: 'cs-b2', reviseArtifactId: artifactB }));
  const decided = await x.ok('nexus:review:decide', csB1, { decision: 'request_changes', comment }, intent());
  assert.ok(decided.job, 'a request for changes starts the next turn');
  await w.until(() => w.ended(decided.job.id), 'the revision turn ends', 15 * 60_000);
  assert.equal(w.jobRow(decided.job.id).state, 'completed', w.jobRow(decided.job.id).error_json);
  assert.equal(w.jobRow(decided.job.id).session_id, a.sessionId, 'the same conversation');
  const rev0 = JSON.parse(chatRequests(w).at(-4).body);
  assert.match(rev0.messages.map((m) => String(m.content)).join('\n'), /short last page/, 'the reviewer\'s comment reached the model');
  const [csB2] = w.changeSetsOf(decided.job.id);
  assert.ok(csB2 && csB2 !== csB1);
  assert.equal(w.versionRow(csB2).artifact_id, artifactB, 'v2 is the next version of the same change set');
  assert.equal(await w.until_candidate(csB2), 'candidate');
  const headB2 = storageOf(w, csB2).commit;
  assert.equal(w.git('rev-parse', `${headB2}^`), storageOf(w, csB1).commit, 'v2 continues on the same worktree: its parent is v1\'s head');
  assert.ok(w.db.prepare("SELECT 1 FROM artifact_edges WHERE from_version_id = ? AND to_version_id = ? AND relation = 'derived_from'").get(csB2, csB1), 'v2 derived_from v1');
  for (const v of CS_VALIDATORS) assert.equal(w.checks(csB2)[v], 'passed', `v2 ${v}`);
  assert.equal(await w.railStep('iteration'), 'done');
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM session_worktrees WHERE session_id = ?').get(a.sessionId).n, 1);
  await x.ok('nexus:review:decide', csB2, { decision: 'approve' }, intent());
  const st3 = await w.okd('nexus:repo:status', w.PROJECT);
  const accB = await w.okd('nexus:changeSet:accept', csB2, st3.acceptedHead);
  assert.equal(accB.accept.refBefore, mergeA);
  const st4 = await w.okd('nexus:repo:status', w.PROJECT);
  await w.okd('nexus:repo:mergeAccepted', w.PROJECT, { branch: st4.branch, expectedAcceptedHead: st4.acceptedHead });
  assert.equal(w.userHead(), accB.accept.mergeCommit);
  assert.ok(fs.readFileSync(path.join(w.repoDir, 'test', 'page.test.js'), 'utf8').includes('empty ledger'));
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM repo_merges').get().n, 2);
  assert.equal((await w.drive(w.nx.accepts.status(w.me, w.PROJECT))).integrationConsistent, true);
  assert.ok(w.ollama.requests.every((r) => r.url.startsWith('/api/')), 'the only requests the model server saw are its own API calls');
  assertNoBearer(w, 'LMF1');
  sound(w, 'LMF1');
});


// ---------------------------------------------------------------- LMF2: the model's own loop, and the iteration after a failing change set

const SUM_SRC = "'use strict';\nmodule.exports = { sum: (a, b) => a + b };\n";
const sumTest = (title) => `'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { sum } = require('../src/sum');\ntest('${title}', () => { assert.equal(sum(1, 1), 2); });\ntest('sums zero', () => { assert.equal(sum(0, 0), 0); });\n`;

test('LMF2 the model reads its own failing sandbox_exec output and fixes it inside one turn; a failing change set it registered is fixed by the next turn (v2 derived from v1)', async () => {
  const w = await lmWorld();
  // ----- inside one turn: a failing run, a rewrite, a passing run, then the registration
  w.model([
    calls([writeFile('src/sum.js', SUM_SRC), writeFile('test/sum.test.js', sumTest('sums two numbers [fails]'))]),
    calls([exec(['node', '--test'])]),
    calls([writeFile('test/sum.test.js', sumTest('sums two numbers'))]),
    calls([exec(['node', '--test'])]),
    calls([register('Add sum', 'sum with tests', 'cs-sum')]),
    say('Done.')
  ]);
  const t1 = await w.turn('Add a sum function with tests');
  assert.equal(t1.job.state, 'completed', t1.job.error_json);
  const ex = w.execResults(t1.jobId);
  assert.deepEqual(ex.map((e) => e.exit), [1, 0], 'the first run failed, the second passed');
  const reqs = chatRequests(w).map((r) => JSON.parse(r.body));
  assert.equal(reqs.length, 6);
  const afterFirstRun = reqs[2].messages.filter((m) => m.role === 'tool').map((m) => String(m.content)).join('\n');
  assert.match(afterFirstRun, /not ok - sums two numbers \[fails\]/, 'the model was given the failing output of its own command');
  const [cs1] = w.changeSetsOf(t1.jobId);
  assert.equal(await w.until_candidate(cs1), 'candidate', 'the registered head holds the fixed test');
  assert.equal(w.checks(cs1)['cs.tests_pass'], 'passed');
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM job_events WHERE job_id = ? AND type = 'attempt.progress' AND json_extract(data_json, '$.t') = 'runtime.tool'").get(t1.jobId).n, 6, 'two writes, a run, a rewrite, a run, the registration');

  // ----- a model that registers anyway: the failing change set stays out of candidate; the next turn revises it
  w.model(buildTurn({ 'src/mul.js': "'use strict';\nmodule.exports = { mul: (a, b) => a * b };\n", 'test/mul.test.js': sumTest('multiplies [fails]').replace(/sum/g, 'mul') }, { title: 'Add mul', clientKey: 'cs-mul-1' }));
  const t2 = await w.turn('Add a mul function', { sessionId: t1.sessionId });
  const [v1] = w.changeSetsOf(t2.jobId);
  assert.equal(await w.until_candidate(v1), 'failed', 'a failing blocking check keeps it out of candidate');
  assert.equal(w.checks(v1)['cs.tests_pass'], 'failed');
  const tp1 = w.db.prepare("SELECT summary, evidence_json FROM validations WHERE version_id = ? AND validator_id = 'cs.tests_pass' ORDER BY rowid DESC").get(v1);
  assert.match(tp1.summary, /fail/i);
  const refused = await w.refusedd('nexus:changeSet:accept', [v1, w.refOf('HEAD')]);
  assert.equal(typeof refused.message, 'string'); noLeak(refused);
  const artifact = w.versionRow(v1).artifact_id;
  w.model(buildTurn({ 'test/mul.test.js': sumTest('multiplies').replace(/sum/g, 'mul') }, { title: 'Add mul', clientKey: 'cs-mul-2', reviseArtifactId: artifact }));
  const t3 = await w.turn('Fix the failing test', { sessionId: t1.sessionId });
  assert.equal(t3.job.state, 'completed', t3.job.error_json);
  const [v2] = w.changeSetsOf(t3.jobId);
  assert.equal(w.versionRow(v2).artifact_id, artifact, 'v2 of the same change set');
  assert.equal(await w.until_candidate(v2), 'candidate');
  assert.equal(w.checks(v2)['cs.tests_pass'], 'passed');
  assert.ok(w.db.prepare("SELECT 1 FROM artifact_edges WHERE from_version_id = ? AND to_version_id = ? AND relation = 'derived_from'").get(v2, v1), 'v2 derived_from v1');
  assert.equal(w.checks(v1)['cs.tests_pass'], 'failed', 'v1 keeps its own failed result');
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM session_worktrees WHERE session_id = ?').get(t1.sessionId).n, 1, 'one worktree for the conversation');
  assertNoBearer(w, 'LMF2');
  sound(w, 'LMF2');
});
