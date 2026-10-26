'use strict';
// B2b Task 16: the end-to-end SDE flow on the PYTHON fixture (pytest + pyproject), driven by ScriptedRuntime (no model, no
// network, no Docker), and the merge-side negative paths. Real main, the real runner core (real git, MCP server, egress proxy, worktree
// guard), the fake sandbox driver (test/helpers/agentFlowWorld.cjs). ScriptedRuntime proves the platform's wiring from request to
// merge; it does NOT prove a real model (the controller's Verification V5).
//
//   E2E-B2b-1  the whole flow on the python fixture: an agent requirement draft the user promotes -> a turn -> a change set ->
//              cs.tests_pass (pytest, on the staged head commit) -> review -> accept -> the confirmed merge -> tests and the wheel
//              build on the merged repository -> the iteration (request_changes, a second turn on the same worktree, v2 derived
//              from v1, accepted, merged). Every step this fixture can exercise is done from the records: the application, dev
//              deployment and diagnostics steps need a nexus.app.json, which a Python library does not have.
//   E2E-B2b-2  the merge-side negative paths: a dirty tree refuses the merge and the user's files are byte-identical; a
//              non-fast-forward; a ref moved after the dialog is not merged.
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const H = require('./helpers/agentFlowWorld.cjs');
const { flowWorld, useFixture, discoverTests, runBuild, makeChange, approveAndAccept, sound, implementing } = H;
const { PY } = require('./helpers/agentFlowCode.cjs');
const { intent } = require('./helpers/ipcExec.cjs');
const { DOMAINS, getDomain } = loadTs('src/shared/nexus/domains/index.ts');
const { isExecutableEndToEnd } = loadTs('src/shared/nexus/domainSpec.ts');

const CS_VALIDATORS = ['git.diff_nonempty', 'git.paths_in_scope', 'sec.secret_scan', 'cs.tests_pass', 'git.applies_cleanly'];
const DONE_STEPS = ['requirement', 'project', 'repository', 'code', 'ai-implementation', 'tests', 'review', 'build', 'iteration'];
const NEEDS_MANIFEST = ['application', 'dev-deployment', 'diagnostics'];
const PYTEST = ['python', '-m', 'pytest'];
const metaOf = (w, id) => JSON.parse(w.versionRow(id).metadata_json);
const storageOf = (w, id) => JSON.parse(w.versionRow(id).storage_ref_json);

/** A python world with the repository snapshotted and the agent's permission granted. */
async function ready() {
  const w = await flowWorld();
  await useFixture(w, 'pytest-app');
  const snap = await w.snapshot();
  await w.consent();
  return { w, snap };
}

test('E2E-B2b-1 python: requirement -> turn -> change set -> cs.tests_pass -> review -> accept -> merge -> tests -> build -> iteration; e2e.sde.ai-implementation e2e.sde.review e2e.sde.iteration', async () => {
  const { w, snap } = await ready();
  const x = w.x;
  const tokens = [];
  // ----- the agent drafts the requirement; the user promotes it
  w.script((plan) => { tokens.push(plan.runtime.token); return [
    { op: 'call', tool: 'requirement_draft', args: { title: 'Export the ledger', body: 'A CSV export.',
      criteria: [{ id: 'C1', text: 'Exports every row' }, { id: 'C2', text: 'Escapes commas and quotes' }], clientKey: 'req-py' } },
    { op: 'usage', inputTokens: 800, outputTokens: 150, costUsdCents: 3, toolCalls: 1, estimated: false }, { op: 'complete' }]; });
  const a = await w.turn('Draft a requirement for exporting the ledger as CSV');
  assert.equal(a.job.state, 'completed', a.job.error_json);
  const req = w.db.prepare("SELECT v.id, v.status, v.produced_by_job_id AS job FROM artifact_versions v JOIN artifacts x ON x.id = v.artifact_id WHERE x.kind = 'requirement'").get();
  assert.deepEqual([req.status, req.job], ['candidate', a.jobId]);
  await x.ok('nexus:version:promote', req.id, null);
  assert.equal(w.stepOf('requirement'), 'done');

  // ----- the implementation
  const userBefore = w.userState();
  implementing(w, PY.ledger, { title: 'Add the ledger export', summary: 'to_csv and its tests.', requirementVersionIds: [req.id], clientKey: 'cs-a' }, { execArgv: PYTEST, tokens });
  const b = await w.turn('Implement the ledger export', { sessionId: a.sessionId });
  assert.equal(b.job.state, 'completed', b.job.error_json);
  const [csA] = w.changeSetsOf(b.jobId);
  assert.equal(await w.until_candidate(csA), 'candidate');
  for (const v of CS_VALIDATORS) assert.equal(w.checks(csA)[v], 'passed', v);
  const headA = storageOf(w, csA).commit;
  assert.ok(w.played.some((p) => p.files.includes('tests/test_ledger.py') && p.files.includes('src/pytest_app/ledger.py')), 'pytest ran on the staged head commit');
  assert.ok(w.played.some((p) => p.argv.includes('--collect-only')), 'the suite was discovered with pytest\'s collection');
  assert.ok(w.execs.some((e) => e.argv.join(' ') === 'python -m pytest'), 'the agent ran the tests in its own container first');
  assert.deepEqual(w.userState(), userBefore, 'the user\'s folder is untouched until the merge');
  assert.equal(w.stepOf('ai-implementation'), 'done');

  // ----- review, accept, merge
  assert.notEqual(await w.railStep('review'), 'done', 'unreviewed');
  const { status: st0, accept } = await approveAndAccept(w, csA, { afterApprove: async () => {
    assert.notEqual(await w.railStep('review'), 'done', 'approved but not accepted: the product rail does not show Review done');
  } });
  assert.equal(await w.railStep('review'), 'done', 'reviewed and accepted: the product rail shows Review done');
  assert.equal(accept.refBefore, st0.acceptedHead);
  assert.deepEqual(w.userState(), userBefore, 'accept never touches the user\'s branch, index or files');
  const st1 = await w.okd('nexus:repo:status', w.PROJECT);
  assert.equal(st1.acceptedNotMerged, 1); assert.equal(st1.canFastForward, true);
  const svc = await w.drive(w.nx.accepts.status(w.me, w.PROJECT));
  assert.equal(svc.integrationConsistent, true, 'O25');
  const m = await w.okd('nexus:repo:mergeAccepted', w.PROJECT, { branch: st1.branch, expectedAcceptedHead: st1.acceptedHead });
  assert.equal(m.after, accept.mergeCommit);
  assert.equal(w.userHead(), accept.mergeCommit);
  assert.equal(w.dialogs.length, 1); assert.deepEqual(w.dialogs[0].opts.buttons, ['Cancel', 'Merge']);
  assert.ok(fs.existsSync(path.join(w.repoDir, 'src', 'pytest_app', 'ledger.py')));
  assert.equal(w.db.prepare('SELECT confirmed_via FROM repo_merges').get().confirmed_via, 'dialog');

  // ----- tests and the wheel build on the merged repository
  const snap2 = await w.snapshot();
  assert.equal(storageOf(w, snap2.versionId).commit, accept.mergeCommit);
  const saved = w.nx.artifacts.saveUserVersion(w.me, { projectId: w.PROJECT, workspaceId: w.WORKSPACE, kind: 'git_commit', target: { name: 'Release' },
    storage: { kind: 'git', commit: accept.mergeCommit }, metadata: { source: 'git_commit' }, action: 'user.save_commit' });
  await x.ok('nexus:version:markReady', saved.version.id);
  const t = await discoverTests(w, snap2.versionId);
  assert.equal(w.versionRow(t.suite).status, 'candidate');
  const names = w.played.filter((p) => p.argv.includes('--collect-only')).at(-1).files;
  assert.ok(names.includes('tests/test_ledger.py'), 'the merged repository\'s own tests include the agent\'s');
  const bld = await runBuild(w, snap2.versionId, 'dist');
  assert.equal(w.versionRow(bld.build).status, 'candidate');

  // ----- the iteration on the same worktree
  implementing(w, PY.pageV1, { title: 'Paginate the ledger', summary: 'A page helper.', clientKey: 'cs-b1' }, { execArgv: PYTEST, tokens });
  const c = await w.turn('Add pagination to the ledger export', { sessionId: a.sessionId });
  assert.equal(c.job.state, 'completed', c.job.error_json);
  const [csB1] = w.changeSetsOf(c.jobId);
  assert.equal(await w.until_candidate(csB1), 'candidate');
  const headB1 = storageOf(w, csB1).commit;
  assert.equal(metaOf(w, csB1).base, w.git('merge-base', accept.mergeCommit, headB1));
  const artifactB = w.versionRow(csB1).artifact_id;
  const decided = await x.ok('nexus:review:decide', csB1, { decision: 'request_changes', comment: 'Please add the short last page and the empty ledger.' }, intent());
  assert.ok(decided.job);
  implementing(w, PY.pageV2, { title: 'Paginate the ledger', summary: 'Edge cases.', reviseArtifactId: artifactB, clientKey: 'cs-b2' }, { execArgv: PYTEST, tokens });
  await w.until(() => w.ended(decided.job.id), 'the revision turn ends', 15 * 60_000);
  assert.equal(w.jobRow(decided.job.id).state, 'completed', w.jobRow(decided.job.id).error_json);
  assert.equal(w.jobRow(decided.job.id).session_id, a.sessionId, 'the same conversation');
  const [csB2] = w.changeSetsOf(decided.job.id);
  assert.equal(await w.until_candidate(csB2), 'candidate');
  const headB2 = storageOf(w, csB2).commit;
  assert.equal(w.git('rev-parse', `${headB2}^`), headB1, 'v2 continues on the same worktree');
  assert.equal(metaOf(w, csB2).base, w.git('merge-base', accept.mergeCommit, headB2), 'v2\'s base is the merge-base with the accepted work');
  assert.ok(w.db.prepare("SELECT 1 FROM artifact_edges WHERE from_version_id = ? AND to_version_id = ? AND relation = 'derived_from'").get(csB2, csB1), 'v2 derived_from v1');
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM session_worktrees WHERE session_id = ?').get(a.sessionId).n, 1);
  const accB = (await approveAndAccept(w, csB2)).accept;
  assert.equal(accB.refBefore, accept.mergeCommit);
  const st2 = await w.okd('nexus:repo:status', w.PROJECT);
  await w.okd('nexus:repo:mergeAccepted', w.PROJECT, { branch: st2.branch, expectedAcceptedHead: st2.acceptedHead });
  assert.equal(w.userHead(), accB.mergeCommit);
  assert.ok(fs.readFileSync(path.join(w.repoDir, 'tests', 'test_page.py'), 'utf8').includes('empty_ledger'));
  assert.equal(w.versionRow(csB1).status, 'candidate', 'the superseded v1 is never accepted');

  // ----- evidence-based completion, the store
  for (const id of DONE_STEPS) assert.equal(id === 'review' ? await w.railStep('review') : w.stepOf(id), 'done', id);
  for (const id of NEEDS_MANIFEST) assert.notEqual(w.stepOf(id), 'done', `${id} needs a nexus.app.json: a Python library does not claim it`);
  for (const cs of [csA, csB2]) assert.deepEqual(CS_VALIDATORS.filter((v) => w.checks(cs)[v] !== 'passed'), []);
  assert.equal(isExecutableEndToEnd(getDomain('sde'), 'B2b'), true);
  assert.equal(isExecutableEndToEnd(getDomain('sde')), true);
  for (const d of DOMAINS.filter((y) => y.id !== 'sde')) assert.equal(isExecutableEndToEnd(d), false, d.id);
  assert.equal((await w.drive(w.nx.accepts.status(w.me, w.PROJECT))).integrationConsistent, true, 'O25 at the end');
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM capability_tokens WHERE revoked_at IS NULL').get().n, 0);
  assert.equal(w.driver.all().filter((r) => r.kind === 'container' && r.labels['nexus.kind'] === 'agent').length, 0);
  const blob = [];
  for (const tb of w.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) for (const r of w.db.prepare(`SELECT * FROM "${tb.name}"`).all()) blob.push(JSON.stringify(r));
  blob.push(...w.logs, ...w.runnerLogs);
  for (const tok of tokens) assert.ok(!blob.join('\n').includes(tok), 'a turn\'s bearer is in no row and no log');
  sound(w, 'E2E-B2b-1 python');
});

// ---------------------------------------------------------------- E2E-B2b-2: the merge-side negative paths

/** A python world with one change set approved and accepted, not yet merged. */
async function accepted() {
  const { w } = await ready();
  const { cs } = await makeChange(w, { files: PY.ledger, title: 'Add the ledger export', execArgv: PYTEST });
  assert.equal(await w.until_candidate(cs), 'candidate');
  const r = await approveAndAccept(w, cs);
  const status = await w.okd('nexus:repo:status', w.PROJECT);
  return { w, cs, accept: r.accept, status };
}

test('E2E-B2b-2 python: a dirty tree refuses the merge with a sentence, the user\'s files stay byte-identical, and the merge works once the tree is clean', async () => {
  const { w, accept, status } = await accepted();
  fs.appendFileSync(path.join(w.repoDir, 'pyproject.toml'), '# an uncommitted local edit\n');
  const dirty = w.userState();
  assert.notEqual(dirty.status, '', 'the tracked file is modified');
  const st = await w.okd('nexus:repo:status', w.PROJECT);
  assert.deepEqual([st.canFastForward, st.reason, st.dirty], [false, 'tree_dirty', true]);
  const r = await w.refusedd('nexus:repo:mergeAccepted', [w.PROJECT, { branch: status.branch, expectedAcceptedHead: status.acceptedHead }], 'tree_dirty');
  assert.match(r.message, /tracked/i, 'the sentence says only tracked files count');
  assert.equal(w.dialogs.length, 0, 'no dialog was shown for a merge that cannot happen');
  assert.deepEqual(w.userState(), dirty, 'the user\'s files, index and branch are byte-identical after the refusal');
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM repo_merges').get().n, 0);
  // An untracked file does not block (only tracked files are checked); the same merge then succeeds.
  w.git('checkout', '--', 'pyproject.toml');
  fs.writeFileSync(path.join(w.repoDir, 'scratch-notes.txt'), 'untracked\n');
  const m = await w.okd('nexus:repo:mergeAccepted', w.PROJECT, { branch: status.branch, expectedAcceptedHead: status.acceptedHead });
  assert.equal(m.after, accept.mergeCommit);
  assert.equal(w.userHead(), accept.mergeCommit);
  assert.equal(fs.readFileSync(path.join(w.repoDir, 'scratch-notes.txt'), 'utf8'), 'untracked\n', 'the untracked file is still there');
  sound(w, 'dirty tree');
});

test('E2E-B2b-2 python: a non-fast-forward is refused, and neither the branch nor the accepted ref moves', async () => {
  const { w, accept, status } = await accepted();
  fs.writeFileSync(path.join(w.repoDir, 'CHANGELOG.md'), 'a commit the user made meanwhile\n');
  w.git('add', 'CHANGELOG.md'); w.git('commit', '-q', '-m', 'the user commits on their own');
  const mine = w.userHead(); const ref = w.refOf(accept.integrationRef);
  const st = await w.okd('nexus:repo:status', w.PROJECT);
  assert.deepEqual([st.canFastForward, st.reason], [false, 'not_fast_forward']);
  await w.refusedd('nexus:repo:mergeAccepted', [w.PROJECT, { branch: status.branch, expectedAcceptedHead: status.acceptedHead }], 'not_fast_forward');
  assert.equal(w.dialogs.length, 0);
  assert.equal(w.userHead(), mine, 'the branch is where the user left it');
  assert.equal(w.refOf(accept.integrationRef), ref, 'the accepted ref did not move');
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM repo_merges').get().n, 0);
  assert.ok(!fs.existsSync(path.join(w.repoDir, 'src', 'pytest_app', 'ledger.py')), 'none of the agent\'s files reached the folder');
});

test('E2E-B2b-2 python: a ref moved after the dialog is not merged: the branch lands on the confirmed commit only', async () => {
  const { w, accept, status } = await accepted();
  const confirmed = status.acceptedHead;
  let moved = null;
  // While the dialog is open the accepted ref is moved on by hand to a commit the user never saw.
  w.onDialog = async () => {
    moved = w.git('commit-tree', `${confirmed}^{tree}`, '-p', confirmed, '-m', 'moved after the dialog');
    w.git('update-ref', accept.integrationRef, moved, confirmed);
  };
  const m = await w.okd('nexus:repo:mergeAccepted', w.PROJECT, { branch: status.branch, expectedAcceptedHead: confirmed });
  assert.equal(w.dialogs.length, 1);
  assert.ok(moved && moved !== confirmed);
  assert.equal(m.after, confirmed); assert.equal(w.userHead(), confirmed, 'the branch is the commit the dialog showed');
  assert.notEqual(w.userHead(), moved, 'the commit the ref moved to is not merged');
  assert.equal(w.refOf(accept.integrationRef), moved, 'merging never rewrites the accepted ref');
  const row = w.db.prepare('SELECT * FROM repo_merges').get();
  assert.deepEqual([row.sha_confirmed, row.after], [confirmed, confirmed]);
  // Nexus no longer offers the moved ref for merging (O25): the records and the ref disagree.
  const svc = await w.drive(w.nx.accepts.status(w.me, w.PROJECT));
  assert.equal(svc.integrationConsistent, false, 'the hand-moved ref no longer matches the newest accept');
  await w.refusedd('nexus:repo:mergeAccepted', [w.PROJECT, { branch: status.branch, expectedAcceptedHead: moved }], 'integration_unexpected');
});
