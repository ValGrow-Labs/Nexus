'use strict';
// The hosted-model runtime on REAL Docker (XH1, XH2): the real hosted-model adapter (through the runner's test seam), the same main and runner
// core as the scripted flows (test/nexus-platform-b2b-flows-hostedmodel.test.cjs), the REAL Docker driver and the pinned sde-node image. The
// provider is still a MOCK chat-completions server on loopback (test/helpers/mockOpenAiServer.cjs) whose replies are scripted, and the key is a
// made-up string: what only Docker can add is that sandbox_exec runs the model's own tests for real (node --test inside the container, network
// none), the model is handed that real output, and cs.tests_pass runs for real on the change set's head (a real JUnit report). NO real provider is
// called by this file; the real provider with the user's own key is the controller's showcase (tools/nexus-demo-hosted-model.cjs), never a test.
// Runs only behind the test:exec resource gate (node tools/run-exec-tests.cjs).
// Estimated wall time (NOT measured, and NOT run when it was written: Docker was not touched): one world (about a minute), and three change-set
// checks (a discovery and a test container each, a minute or two each): XH1 about 3 minutes, XH2 about 5, so about 8 minutes for the file.
const test = require('node:test');
const { realDockerOrSkip } = require('./helpers/execGate.cjs');

if (realDockerOrSkip()) {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const { sound } = require('./helpers/agentFlowWorld.cjs');
  const { hmWorld, buildTurn, calls, say, writeFile, exec, register, assertNoKey } = require('./helpers/hostedModelFlows.cjs');
  const { NODE, REAL } = require('./helpers/agentFlowCode.cjs');
  const { intent } = require('./helpers/ipcExec.cjs');
  const { labelled } = require('./helpers/execReal.cjs');
  const { homeLabel } = require('./load-ts.cjs')('src/shared/nexus/homeLabel.ts');

  const LONG = { timeout: 25 * 60_000 };
  const MIN = 60_000;
  /** A real world (the real Docker driver) with the repository snapshotted, a (made-up) key saved and the permission granted for the hosted runtime. */
  async function withWorld(body) {
    const w = await hmWorld({ real: true });
    try { return await body(w); } finally { try { await w.close(); } catch { /* best effort */ } }
  }
  const chats = (w) => w.api.chats();
  const toolText = (w, n) => chats(w)[n].messages.filter((m) => m.role === 'tool').map((m) => String(m.content)).join('\n');

  test('XH1 the model writes a node:test app, node --test runs for real in the container and its output reaches the model, cs.tests_pass runs for real, and the change is reviewed, accepted and merged', LONG, () => withWorld(async (w) => {
    const userBefore = w.userState();
    w.model(buildTurn(NODE.ledger, { title: 'Add the ledger export', summary: 'toCsv with escaping, and its tests.', clientKey: 'xh1' }));
    const t = await w.turn('Implement the ledger export as CSV', { ms: 10 * MIN });
    assert.equal(t.job.state, 'completed', t.job.error_json);
    // the command ran in the real container: real node:test output, exit 0, two tests passed
    const ex = w.execResults(t.jobId);
    assert.equal(ex.length, 1, JSON.stringify(ex));
    assert.equal(ex[0].exit, 0, JSON.stringify(ex[0]));
    assert.match(ex[0].stdout, /ok \d+ - exports one line per row/); assert.match(ex[0].stdout, /# fail 0/);
    assert.match(toolText(w, 2), /exports one line per row/, 'the model was handed the real output of its own command');
    const [cs] = w.changeSetsOf(t.jobId);
    assert.ok(cs, 'changeset_register registered a change set');
    assert.equal(await w.until_candidate(cs, 20 * MIN), 'candidate', 'the real test run passed');
    for (const v of ['git.diff_nonempty', 'git.paths_in_scope', 'sec.secret_scan', 'cs.tests_pass', 'git.applies_cleanly']) assert.equal(w.checks(cs)[v], 'passed', v);
    const tp = w.db.prepare("SELECT summary, evidence_json FROM validations WHERE version_id = ? AND validator_id = 'cs.tests_pass' ORDER BY rowid DESC").get(cs);
    assert.match(tp.summary, /pass/i);
    assert.ok(JSON.parse(tp.evidence_json).some((e) => e.type === 'junit'), 'the evidence is the real JUnit report');
    assert.deepEqual(w.userState(), userBefore, 'the user\'s folder is untouched before accept');
    // review, accept, merge
    await w.x.ok('nexus:review:decide', cs, { decision: 'approve' }, intent());
    const st0 = await w.okd('nexus:repo:status', w.PROJECT);
    const acc = await w.okd('nexus:changeSet:accept', cs, st0.acceptedHead);
    assert.deepEqual(w.userState(), userBefore, 'accept never touches the user\'s branch');
    const st1 = await w.okd('nexus:repo:status', w.PROJECT);
    await w.okd('nexus:repo:mergeAccepted', w.PROJECT, { branch: st1.branch, expectedAcceptedHead: st1.acceptedHead });
    assert.equal(w.userHead(), acc.accept.mergeCommit);
    assert.ok(fs.existsSync(path.join(w.repoDir, 'src', 'ledger.js')), 'what the model wrote is in the user\'s folder');
    // nothing left in Docker, the token revoked (the key and the bearer scans run at the end)
    await w.until(() => labelled(homeLabel(w.dataHome.root), { 'nexus.kind': 'agent' }).containers.length === 0, 'the turn container is removed', 3 * MIN);
    assert.equal(w.db.prepare('SELECT COUNT(*) n FROM capability_tokens WHERE revoked_at IS NULL').get().n, 0);
    assertNoKey(w, 'XH1');
    sound(w, 'XH1');
  }));

  test('XH2 a real failing node:test: the model sees it and registers anyway, cs.tests_pass fails for real; the next turn fixes it and v2 (derived from v1) passes', LONG, () => withWorld(async (w) => {
    const code = REAL.node;
    w.model([
      calls(Object.entries(code.fail).map(([p, c]) => writeFile(p, c))),
      calls([exec(['node', '--test'])]),
      calls([register('Add a sum', 'sum with a test', 'xh2-v1')]),
      say('Registered.')
    ]);
    const t1 = await w.turn('Add a sum function with tests', { ms: 10 * MIN });
    assert.equal(t1.job.state, 'completed', t1.job.error_json);
    const ex = w.execResults(t1.jobId);
    assert.notEqual(ex[0].exit, 0, 'the real run failed');
    assert.match(ex[0].stdout, /not ok/);
    assert.match(toolText(w, 2), /not ok/, 'the model was handed the real failure');
    const [v1] = w.changeSetsOf(t1.jobId);
    assert.equal(await w.until_candidate(v1, 20 * MIN), 'failed', 'the real test run failed, so the change set is not a candidate');
    assert.equal(w.checks(v1)['cs.tests_pass'], 'failed');
    assert.ok(JSON.parse(w.db.prepare("SELECT evidence_json FROM validations WHERE version_id = ? AND validator_id = 'cs.tests_pass' ORDER BY rowid DESC").get(v1).evidence_json).some((e) => e.type === 'junit'));
    // the iteration: the same conversation, the model rewrites the test and runs it for real, v2 of the same change set
    const artifact = w.versionRow(v1).artifact_id;
    w.model(buildTurn(code.fixed, { title: 'Add a sum', clientKey: 'xh2-v2', reviseArtifactId: artifact }));
    const t2 = await w.turn('Fix the failing test', { sessionId: t1.sessionId, ms: 10 * MIN });
    assert.equal(t2.job.state, 'completed', t2.job.error_json);
    assert.equal(w.execResults(t2.jobId)[0].exit, 0, 'the real run passed');
    const [v2] = w.changeSetsOf(t2.jobId);
    assert.equal(w.versionRow(v2).artifact_id, artifact, 'v2 of the same change set');
    assert.equal(await w.until_candidate(v2, 20 * MIN), 'candidate', 'the real test run passed');
    assert.equal(w.checks(v2)['cs.tests_pass'], 'passed');
    assert.ok(w.db.prepare("SELECT 1 FROM artifact_edges WHERE from_version_id = ? AND to_version_id = ? AND relation = 'derived_from'").get(v2, v1), 'v2 derived_from v1');
    assert.equal(w.checks(v1)['cs.tests_pass'], 'failed', 'v1 keeps its own failed result');
    assert.equal(await w.railStep('iteration'), 'done');
    assertNoKey(w, 'XH2');
    sound(w, 'XH2');
  }));
}
