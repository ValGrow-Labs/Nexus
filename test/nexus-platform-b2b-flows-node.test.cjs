'use strict';
// B2b Task 16: the end-to-end SDE flow on the NODE fixture (node:test + nexus.app.json), driven by ScriptedRuntime: no model,
// no network, no Docker. Real main, the real runner core (real git, the real loopback MCP server, the real host egress proxy,
// the real worktree guard), the fake sandbox driver (test/helpers/agentFlowWorld.cjs). ScriptedRuntime proves the platform's
// wiring from request to merge; it does NOT prove a real model (that is the controller's Verification V5).
//
//   E2E-B2b-1  the whole flow on the node fixture: an agent's requirement draft the user promotes -> a turn (ScriptedRuntime through
//              the REAL MCP server) -> a change set registered by changeset_register -> cs.tests_pass -> review -> accept ->
//              the merge the user confirms -> the B2a half on the merged repository (snapshot, tests, build, application, dev
//              deployment, diagnosis) -> the iteration (request_changes, a second turn on the same worktree, v2 derived from v1,
//              accepted, merged). Every SDE step done from the records; O1-O22 and O25 hold.
//   E2E-B2b-3  the constraint-13 observability query per agent job, over that flow.
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const H = require('./helpers/agentFlowWorld.cjs');
const { flowWorld, useFixture, discoverTests, runBuild, deployAndDiagnose, stopDeployment, makeChange } = H;
const { NODE } = require('./helpers/agentFlowCode.cjs');
const { intent, noLeak } = require('./helpers/ipcExec.cjs');
const { DOMAINS, getDomain } = loadTs('src/shared/nexus/domains/index.ts');
const { isExecutableEndToEnd } = loadTs('src/shared/nexus/domainSpec.ts');
const { containsSecret } = loadTs('src/main/nexus/activity/redact.ts');
const { AGENT_REASON_MESSAGES } = loadTs('src/main/nexusIpc/envelope.ts');

const CS_VALIDATORS = ['git.diff_nonempty', 'git.paths_in_scope', 'sec.secret_scan', 'cs.tests_pass', 'git.applies_cleanly'];
const SDE_STEPS = ['requirement', 'project', 'repository', 'code', 'ai-implementation', 'tests', 'review', 'build', 'application', 'dev-deployment', 'diagnostics', 'iteration'];
const ctx = { tokens: [] };

const { sound, implementing } = H;
const metaOf = (w, versionId) => JSON.parse(w.versionRow(versionId).metadata_json);
const storageOf = (w, versionId) => JSON.parse(w.versionRow(versionId).storage_ref_json);

test('E2E-B2b-1 node: requirement -> turn -> change set -> cs.tests_pass -> review -> accept -> merge -> build -> deploy -> diagnose -> iteration; e2e.sde.ai-implementation e2e.sde.review e2e.sde.iteration', async () => {
  const w = await flowWorld();
  ctx.w = w;
  const x = w.x;
  await useFixture(w, 'node-test-app');

  // ----- the setup the user does: a repository snapshot, and the agent's one network permission (#51)
  const snap = await w.snapshot();
  assert.equal(w.stepOf('repository'), 'done');
  const consent = await w.consent();
  assert.equal(consent.state, 'ready'); assert.equal(consent.consent.live, true); assert.equal(consent.consent.hostsCount, 1);
  for (const id of ['project', 'repository']) assert.equal(w.stepOf(id), 'done', id);
  assert.notEqual(w.stepOf('ai-implementation'), 'done', 'no change set yet: the step is not done by anything else');
  const userBefore = w.userState();

  // ----- turn A: the agent drafts the requirement; the user promotes it
  w.script((plan) => {
    ctx.tokens.push(plan.runtime.token);
    return [{ op: 'delta', text: 'Drafting the requirement.' },
      { op: 'call', tool: 'requirement_draft', args: { title: 'Export the ledger', body: 'Finance needs a CSV export of the ledger.',
        criteria: [{ id: 'C1', text: 'Exports every ledger row as CSV' }, { id: 'C2', text: 'Escapes commas and quotes' }], clientKey: 'req-1' } },
      { op: 'usage', inputTokens: 900, outputTokens: 200, costUsdCents: 4, toolCalls: 1, estimated: false }, { op: 'complete' }];
  });
  const a = await w.turn('Draft a requirement for exporting the ledger as CSV');
  assert.equal(a.job.state, 'completed', a.job.error_json);
  assert.equal(a.job.outcome, 'completed');
  const req = w.db.prepare("SELECT v.id, v.status, v.produced_by_job_id AS job, v.produced_by_session_id AS session, v.on_behalf_of AS onBehalf FROM artifact_versions v JOIN artifacts x ON x.id = v.artifact_id WHERE x.kind = 'requirement' ORDER BY v.rowid DESC").get();
  assert.equal(req.status, 'candidate', 'an agent draft is a candidate: only the user promotes it');
  assert.deepEqual([req.job, req.session, req.onBehalf], [a.jobId, a.sessionId, 'user:local'], 'the draft names the turn and the session that made it');
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM activity WHERE job_id = ? AND action = 'mcp.call' AND json_extract(details_json, '$.tool') = 'requirement_draft' AND status = 'succeeded'").get(a.jobId).n, 1);
  await x.ok('nexus:version:promote', req.id, null);
  assert.equal(w.versionRow(req.id).status, 'active');
  assert.equal(w.stepOf('requirement'), 'done');

  // ----- turn B: the implementation, in the same conversation
  // The host proxy's decisions of this turn (the test seam: real traffic is only seen by the gated real-Docker suite, XA2/XA7).
  w.injectEgress({ decision: 'allowed', host: 'api.anthropic.com', port: 443, reason: 'allowed' }, { decision: 'refused', host: 'evil.example.com', port: 443, reason: 'host_not_allowed' });
  implementing(w, NODE.ledger, { title: 'Add the ledger export', summary: 'toCsv with escaping, and its tests.', requirementVersionIds: [req.id], clientKey: 'cs-a' }, { tokens: ctx.tokens });
  const b = await w.turn('Implement the ledger export', { sessionId: a.sessionId });
  assert.equal(b.sessionId, a.sessionId);
  assert.equal(b.job.state, 'completed', b.job.error_json);
  const [csA] = w.changeSetsOf(b.jobId);
  assert.ok(csA, 'the turn registered a change set through changeset_register');
  assert.equal(await w.until_candidate(csA), 'candidate');
  const checksA = w.checks(csA);
  for (const v of CS_VALIDATORS) assert.equal(checksA[v], 'passed', `${v}: ${JSON.stringify(checksA)}`);
  const mA = metaOf(w, csA); const headA = storageOf(w, csA).commit;
  assert.equal(mA.title, 'Add the ledger export');
  assert.match(headA, /^[0-9a-f]{40}$/);
  assert.equal(w.git('rev-parse', `${headA}^`), mA.base, 'the change set is one commit on its base');
  assert.equal(w.git('log', '-1', '--format=%an <%ae>', headA), 'Nexus agent <agent@nexus.invalid>');
  assert.match(w.git('log', '-1', '--format=%B', headA), new RegExp(`Nexus-Job: ${b.jobId}`));
  // cs.tests_pass ran on the change set's own head: the recorded container was staged with the agent's files.
  assert.ok(w.played.some((p) => p.files.includes('test/ledger.test.js') && p.files.includes('src/ledger.js')), 'the tests ran on the staged head commit');
  const csTests = w.db.prepare("SELECT evidence_json FROM validations WHERE version_id = ? AND validator_id = 'cs.tests_pass' ORDER BY rowid DESC LIMIT 1").get(csA);
  assert.match(csTests.evidence_json, /junit/);
  // lineage: it implements the requirement and derives from the repository it was made on
  const edges = w.db.prepare('SELECT to_version_id AS id, relation FROM artifact_edges WHERE from_version_id = ?').all(csA);
  assert.ok(edges.some((e) => e.id === req.id && e.relation === 'implements'));
  assert.ok(edges.some((e) => e.id === snap.versionId && e.relation === 'derived_from'));
  // The user's own folder and branch were not touched by any of it (hidden refs only).
  assert.deepEqual(w.userState(), userBefore, 'nothing of the user\'s changed before accept');
  assert.equal(w.stepOf('ai-implementation'), 'done');
  // the agent's own tool-call and usage record
  const attemptB = w.db.prepare('SELECT * FROM job_attempts WHERE job_id = ?').get(b.jobId);
  assert.equal(JSON.parse(attemptB.usage_json).costUsdCents, 9);
  assert.equal(attemptB.state, 'succeeded');

  // ----- review: the user approves (#47); accept moves the integration ref only (#48)
  assert.notEqual(await w.railStep('review'), 'done', 'unreviewed: the product rail does not show Review done');
  const rv = await x.ok('nexus:review:decide', csA, { decision: 'approve' }, intent());
  assert.notEqual(await w.railStep('review'), 'done', 'approved but not accepted: the rail does not show Review done');
  assert.equal(rv.review.decision, 'approve'); assert.equal(rv.job, null);
  const st0 = await w.okd('nexus:repo:status', w.PROJECT);
  assert.equal(st0.acceptedNotMerged, 0); assert.equal(st0.dirty, false);
  const base0 = st0.acceptedHead;
  assert.ok(base0, 'the integration ref exists once the worktree was made');
  const acc = await w.okd('nexus:changeSet:accept', csA, base0);
  assert.equal(await w.railStep('review'), 'done', 'reviewed and accepted: the product rail (railFor over the artifact summaries) shows Review done');
  assert.equal(acc.version.status, 'active'); assert.equal(acc.accept.refBefore, base0);
  const mergeA = acc.accept.mergeCommit;
  assert.equal(w.refOf(acc.accept.integrationRef), mergeA);
  assert.deepEqual(w.git('rev-list', '--parents', '-1', mergeA).split(' ').slice(1), [base0, headA], 'the accept commit joins the integration head and the change set head');
  assert.deepEqual(w.userState(), userBefore, 'accept never touches the user\'s branch, index or files');
  const st1 = await w.okd('nexus:repo:status', w.PROJECT);
  assert.equal(st1.acceptedNotMerged, 1, 'status counts accepted CHANGES: one change set is one change, however many commits it adds');
  assert.equal(st1.canFastForward, true); assert.equal(st1.acceptedHead, mergeA);
  const svc1 = await w.drive(w.nx.accepts.status(w.me, w.PROJECT));
  assert.equal(svc1.integrationConsistent, true, 'O25: the integration ref is the newest accept ref_after');
  assert.equal(svc1.acceptedNotMerged, 1);
  assert.equal(svc1.commitCount, Number(w.git('rev-list', '--count', `refs/heads/${st1.branch}..${acc.accept.integrationRef}`)), 'commitCount is the git count of the commits the branch lacks');
  assert.ok(svc1.commitCount >= 2, 'the change commit and the accept commit');

  // ----- "Merge accepted work": the dialog confirms (faked at its show seam only); a fast-forward to the confirmed sha
  const merge = await w.okd('nexus:repo:mergeAccepted', w.PROJECT, { branch: st1.branch, expectedAcceptedHead: st1.acceptedHead });
  assert.equal(merge.after, mergeA);
  assert.equal(w.dialogs.length, 1);
  assert.deepEqual(w.dialogs[0].opts.buttons, ['Cancel', 'Merge']);
  assert.equal(w.dialogs[0].opts.defaultId, 0);
  assert.match(w.dialogs[0].opts.detail, /Add the ledger export/);
  assert.match(w.dialogs[0].opts.message, /^Merge 1 accepted change into /, 'one accepted change set is one change, not its two commits');
  assert.match(w.dialogs[0].opts.detail, /^Your branch .* will move from [0-9a-f]{8} to [0-9a-f]{8}/);
  assert.equal(w.userHead(), mergeA, 'the user\'s branch is fast-forwarded to the confirmed sha');
  assert.equal(w.git('symbolic-ref', 'HEAD'), `refs/heads/${st1.branch}`);
  assert.ok(fs.existsSync(path.join(w.repoDir, 'src', 'ledger.js')) && fs.existsSync(path.join(w.repoDir, 'test', 'ledger.test.js')));
  const mrow = w.db.prepare('SELECT * FROM repo_merges WHERE project_id = ?').get(w.PROJECT);
  assert.deepEqual([mrow.sha_confirmed, mrow.after, mrow.confirmed_via, mrow.merged_by, mrow.before], [mergeA, mergeA, 'dialog', 'user:local', st1.head]);
  const st2 = await w.okd('nexus:repo:status', w.PROJECT);
  assert.equal((await w.drive(w.nx.accepts.status(w.me, w.PROJECT))).integrationConsistent, true, 'O25 after the first merge');
  assert.equal(st2.acceptedNotMerged, 0); assert.equal(st2.head, mergeA);

  // ----- the B2a half, on the merged repository: snapshot, code, tests, build, application, dev deployment, diagnosis
  const snap2 = await w.snapshot();
  assert.notEqual(snap2.versionId, snap.versionId);
  assert.equal(storageOf(w, snap2.versionId).commit, mergeA, 'the new snapshot is of the merged branch');
  // The "code" step: the user saves the merged commit (#9's service call, after the commit resolves) and marks it ready (#11).
  const saved = w.nx.artifacts.saveUserVersion(w.me, { projectId: w.PROJECT, workspaceId: w.WORKSPACE, kind: 'git_commit', target: { name: 'Release' },
    storage: { kind: 'git', commit: mergeA }, metadata: { source: 'git_commit' }, action: 'user.save_commit' });
  await x.ok('nexus:version:markReady', saved.version.id);
  const t = await discoverTests(w, snap2.versionId);
  assert.equal(w.versionRow(t.suite).status, 'candidate');
  assert.ok(w.played.some((p) => p.argv[0] === 'nexus-glob' && p.files.includes('test/ledger.test.js')), 'the tests of the merged repository include the agent\'s');
  const bld = await runBuild(w, snap2.versionId, 'dist');
  assert.equal(w.versionRow(bld.build).status, 'candidate');
  const dep = await deployAndDiagnose(w, bld.build);
  assert.equal(w.versionRow(dep.report).status, 'candidate');
  assert.equal(w.stepOf('dev-deployment'), 'done');

  // ----- the iteration: a change set on top of the merged work, the diagnostic as input; request_changes; v2 on the same worktree
  implementing(w, NODE.pageV1, { title: 'Paginate the ledger', summary: 'A page helper.', clientKey: 'cs-b1' }, { say: 'Adding pagination.', tokens: ctx.tokens });
  const c = await w.turn('Add pagination to the ledger export; the diagnostic report is attached', { sessionId: a.sessionId, focus: [dep.report] });
  assert.equal(c.job.state, 'completed', c.job.error_json);
  // M1: the diagnostic report really reached the turn: it is a focus input of the job and the token names it among its inputs.
  assert.deepEqual(w.db.prepare("SELECT version_id, role FROM job_inputs WHERE job_id = ?").all(c.jobId).map((r) => [r.version_id, r.role]), [[dep.report, 'focus']], 'the diagnostic is the turn input');
  assert.ok(JSON.parse(w.db.prepare('SELECT inputs_json FROM capability_tokens WHERE job_id = ?').get(c.jobId).inputs_json).includes(dep.report), 'the token names it as an input');
  const [csB1] = w.changeSetsOf(c.jobId);
  assert.equal(await w.until_candidate(csB1), 'candidate');
  const headB1 = storageOf(w, csB1).commit;
  assert.equal(metaOf(w, csB1).base, w.git('merge-base', mergeA, headB1), 'v1 is based on the merge-base with the accepted work');
  assert.equal(metaOf(w, csB1).base, headA);
  const artifactB = w.versionRow(csB1).artifact_id;
  const comment = 'Please handle a short last page and an empty ledger.';
  // The revision turn's proxy reports more decisions than the cap: 200 events, then one marker.
  w.injectEgress(...Array.from({ length: 205 }, (_, i) => ({ decision: 'refused', host: 'blocked' + i + '.example.com', port: 443, reason: 'host_not_allowed' })));
  const decided = await x.ok('nexus:review:decide', csB1, { decision: 'request_changes', comment }, intent());
  assert.equal(decided.review.decision, 'request_changes');
  assert.ok(decided.job, 'a request for changes starts the next turn');
  assert.equal(w.versionRow(csB1).status, 'candidate', 'v1 stays a candidate; it is simply not accepted');
  const turnsBefore = w.db.prepare("SELECT COUNT(*) n FROM job_attempts a JOIN jobs j ON j.id = a.job_id WHERE j.kind = 'agent.run'").get().n;
  implementing(w, NODE.pageV2, { title: 'Paginate the ledger', summary: 'Edge cases handled.', reviseArtifactId: artifactB, clientKey: 'cs-b2' }, { say: 'Handling the edge cases.', tokens: ctx.tokens });
  await w.until(() => w.ended(decided.job.id), 'the revision turn ends', 15 * 60_000);
  assert.equal(w.jobRow(decided.job.id).state, 'completed', w.jobRow(decided.job.id).error_json);
  assert.equal(w.jobRow(decided.job.id).session_id, a.sessionId, 'the same conversation');
  assert.equal(w.jobRow(decided.job.id).requested_by, 'user:local', 'the reviewing user is the turn\'s requester');
  assert.ok(turnsBefore >= 3);
  const [csB2] = w.changeSetsOf(decided.job.id);
  assert.ok(csB2 && csB2 !== csB1);
  assert.equal(w.versionRow(csB2).artifact_id, artifactB, 'v2 is the next version of the same change set');
  assert.equal(await w.until_candidate(csB2), 'candidate');
  const headB2 = storageOf(w, csB2).commit;
  assert.equal(w.git('rev-parse', `${headB2}^`), headB1, 'v2 continues on the same worktree: its parent is v1\'s head');
  assert.equal(metaOf(w, csB2).base, w.git('merge-base', mergeA, headB2), 'v2\'s base is the merge-base with the accepted work');
  assert.ok(w.db.prepare("SELECT 1 FROM artifact_edges WHERE from_version_id = ? AND to_version_id = ? AND relation = 'derived_from'").get(csB2, csB1), 'v2 derived_from v1');
  for (const v of CS_VALIDATORS) assert.equal(w.checks(csB2)[v], 'passed', `v2 ${v}`);
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM session_worktrees WHERE session_id = ?').get(a.sessionId).n, 1, 'one worktree for the conversation');
  const ctxText = fs.readFileSync(path.join(w.dataHome.root, 'jobs', decided.job.id, 'agent', 'context.md'), 'utf8');
  assert.match(ctxText, /short last page/, 'the reviewer\'s comment reached the agent through its context file');
  assert.equal(w.db.prepare('SELECT comment FROM reviews WHERE id = ?').get(decided.review.id).comment, comment);
  await x.ok('nexus:review:decide', csB2, { decision: 'approve' }, intent());
  const st3 = await w.okd('nexus:repo:status', w.PROJECT);
  const accB = await w.okd('nexus:changeSet:accept', csB2, st3.acceptedHead);
  assert.equal(accB.accept.refBefore, mergeA);
  const st4 = await w.okd('nexus:repo:status', w.PROJECT);
  assert.equal(st4.acceptedNotMerged, 1, 'the iteration: one more accepted change; the merged one is not counted again'); assert.equal(st4.canFastForward, true);
  assert.equal((await w.drive(w.nx.accepts.status(w.me, w.PROJECT))).integrationConsistent, true, 'O25 after the second accept');
  await w.okd('nexus:repo:mergeAccepted', w.PROJECT, { branch: st4.branch, expectedAcceptedHead: st4.acceptedHead });
  assert.equal(w.userHead(), accB.accept.mergeCommit, 'the user\'s branch fast-forwarded again, to v2\'s accept commit');
  assert.ok(fs.readFileSync(path.join(w.repoDir, 'test', 'page.test.js'), 'utf8').includes('empty ledger'));
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM repo_merges').get().n, 2);
  assert.equal(w.versionRow(csB1).status, 'candidate', 'the reviewed-and-superseded v1 is never accepted');
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM change_set_accepts').get().n, 2);

  // ----- evidence-based completion, the orphan queries, the store
  // Every step from the records: `review` through the product own rail reader, the rest by stepStateFrom over the database. The
  // `iteration` step's proof is the explicit v1 / v2 assertions above (same session and worktree, derived_from, base = merge-base);
  // the rail's iteration step reads the same change-set records as ai-implementation and adds nothing to them.
  const stepStates = {};
  for (const id of SDE_STEPS) stepStates[id] = id === 'review' ? await w.railStep('review', { deploymentHealthy: true }) : w.stepOf(id);
  assert.deepEqual(stepStates, Object.fromEntries(SDE_STEPS.map((id) => [id, 'done'])), 'every SDE step is done, from the records');
  // Each change-set step is done because of validation rows, not because a job exited 0:
  for (const cs of [csA, csB2]) assert.deepEqual(CS_VALIDATORS.filter((v) => w.checks(cs)[v] !== 'passed'), []);
  const svc2 = await w.drive(w.nx.accepts.status(w.me, w.PROJECT));
  assert.equal(svc2.integrationConsistent, true, 'O25 after the second accept and merge');
  assert.equal(svc2.acceptedNotMerged, 0);
  await stopDeployment(w, dep);
  const sde = getDomain('sde');
  assert.equal(isExecutableEndToEnd(sde, 'B2b'), true);
  assert.equal(isExecutableEndToEnd(sde), true, 'as delivered (DELIVERED_SUB_PHASE = B2b)');
  for (const d of DOMAINS.filter((y) => y.id !== 'sde')) {
    assert.equal(isExecutableEndToEnd(d, 'B2b'), false, `${d.id} at B2b`);
    assert.equal(isExecutableEndToEnd(d), false, `${d.id} as delivered`);
  }
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM capability_tokens WHERE revoked_at IS NULL").get().n, 0, 'every turn\'s token was revoked at its end');
  assert.equal(w.driver.all().filter((r) => r.kind === 'container' && r.labels['nexus.kind'] === 'agent').length, 0, 'no agent container is left');
  sound(w, 'E2E-B2b-1 node');
  ctx.flow = { a, b, c, d: decided.job.id, csA, csB1, csB2, req, headA, mergeA, mergeB: accB.accept.mergeCommit };
});

test('E2E-B2b-3 node: the observability query of constraint 13, one query per agent job: who and where, inputs, session, token and its tools, attempt and sandbox, usage, tool calls, egress, versions, checks, review, accept and merge', async () => {
  const w = ctx.w;
  assert.ok(w && ctx.flow, 'E2E-B2b-3 reads the world that E2E-B2b-1 built: run this file whole, never with E2E-B2b-1 filtered out');
  const f = ctx.flow;
  // ONE query answers all of it for a turn's job.
  const QUERY = `SELECT j.id AS job, j.requested_by, j.on_behalf_of, j.project_id, j.workspace_id, j.session_id, j.state, j.outcome,
      (SELECT json_group_array(json_object('version', i.version_id, 'role', i.role)) FROM job_inputs i WHERE i.job_id = j.id) AS inputs,
      (SELECT t.principal_id FROM capability_tokens t WHERE t.job_id = j.id) AS agent_principal,
      (SELECT json_object('jti', t.jti, 'caps', t.caps_sha256, 'tools', json(t.tools_json), 'issued', t.issued_at, 'expires', t.expires_at, 'revoked', t.revoke_reason)
         FROM capability_tokens t WHERE t.job_id = j.id) AS capability,
      (SELECT json_group_array(json_extract(e.data_json, '$.egress')) FROM job_events e WHERE e.job_id = j.id AND e.type = 'attempt.progress'
         AND json_extract(e.data_json, '$.egress') IS NOT NULL) AS egress,
      (SELECT json_group_array(json_extract(e.data_json, '$.egressTruncated.count')) FROM job_events e WHERE e.job_id = j.id AND e.type = 'attempt.progress'
         AND json_extract(e.data_json, '$.egressTruncated') IS NOT NULL) AS egress_truncated,
      (SELECT json_object('attempt', a.id, 'n', a.n, 'state', a.state, 'container', a.container_id, 'runtime', a.runtime_kind, 'sandbox', json(a.sandbox_json), 'environment', json(a.environment_json), 'usage', json(a.usage_json))
         FROM job_attempts a WHERE a.job_id = j.id ORDER BY a.n DESC LIMIT 1) AS attempt,
      (SELECT json_group_array(json_object('tool', json_extract(e.data_json, '$.tool'), 'ok', json_extract(e.data_json, '$.ok'))) FROM job_events e
         WHERE e.job_id = j.id AND e.type = 'attempt.progress' AND json_extract(e.data_json, '$.t') = 'tool') AS tool_calls,
      (SELECT json_group_array(json_object('version', v.id, 'kind', x.kind, 'status', v.status)) FROM artifact_versions v JOIN artifacts x ON x.id = v.artifact_id
         WHERE v.produced_by_job_id = j.id OR v.produced_by_job_id IN (SELECT id FROM jobs WHERE parent_job_id = j.id)) AS registered,
      (SELECT json_group_array(json_object('version', y.version_id, 'validator', y.validator_id, 'status', y.status)) FROM validations y
         WHERE y.version_id IN (SELECT v.id FROM artifact_versions v WHERE v.produced_by_job_id IN (SELECT id FROM jobs WHERE parent_job_id = j.id))) AS validations,
      (SELECT json_group_array(json_object('review', r.id, 'decision', r.decision, 'by', r.principal_id)) FROM reviews r
         WHERE r.version_id IN (SELECT v.id FROM artifact_versions v WHERE v.produced_by_job_id IN (SELECT id FROM jobs WHERE parent_job_id = j.id))) AS reviews,
      (SELECT json_group_array(json_object('version', c.version_id, 'before', c.ref_before, 'after', c.ref_after, 'by', c.accepted_by)) FROM change_set_accepts c
         WHERE c.version_id IN (SELECT v.id FROM artifact_versions v WHERE v.produced_by_job_id IN (SELECT id FROM jobs WHERE parent_job_id = j.id))) AS accepts,
      (SELECT json_group_array(json_object('merge', m.id, 'after', m.after, 'confirmed', m.sha_confirmed, 'via', m.confirmed_via)) FROM repo_merges m
         WHERE m.after IN (SELECT c.merge_commit FROM change_set_accepts c WHERE c.version_id IN
           (SELECT v.id FROM artifact_versions v WHERE v.produced_by_job_id IN (SELECT id FROM jobs WHERE parent_job_id = j.id)))) AS merges
    FROM jobs j WHERE j.id = ?`;
  const row = w.db.prepare(QUERY).get(f.b.jobId);
  assert.equal(row.requested_by, 'user:local'); assert.equal(row.on_behalf_of, 'user:local');
  assert.equal(row.session_id, f.b.sessionId);
  assert.match(row.agent_principal, /^agent:/, 'the session\'s agent principal');
  const token = JSON.parse(row.capability);
  assert.match(token.jti, /^[A-Za-z0-9_-]{22}$/); assert.match(token.caps, /^[0-9a-f]{64}$/); assert.equal(token.revoked, 'job_ended');
  // who asked, for which project and domain, with which inputs; and the tools its token allowed, by name.
  assert.deepEqual([row.project_id, row.workspace_id], [w.PROJECT, w.WORKSPACE]);
  assert.deepEqual(JSON.parse(row.inputs), [], 'the implementation turn had no focus input');
  const { MCP_TOOL_NAMES } = loadTs('src/shared/nexus/mcpTools.ts');
  assert.ok(token.tools.length >= 5 && token.tools.every((t) => MCP_TOOL_NAMES.includes(t)), 'the token names tools of the MCP table');
  for (const t of ['changeset_register', 'sandbox_exec', 'requirement_draft']) assert.ok(token.tools.includes(t), t);
  assert.ok(!token.tools.includes('handoff_create'));
  // The proxy's decisions of the turn: host and reason only (injected through the test seam: nothing flows under ScriptedRuntime).
  assert.deepEqual(JSON.parse(row.egress), [{ decision: 'allowed', host: 'api.anthropic.com', port: 443, reason: 'allowed' }, { decision: 'refused', host: 'evil.example.com', port: 443, reason: 'host_not_allowed' }]);
  assert.deepEqual(JSON.parse(row.egress_truncated), []);
  const attempt = JSON.parse(row.attempt);
  assert.equal(attempt.state, 'succeeded'); assert.match(attempt.container, /^[0-9a-f]{64}$/); assert.equal(attempt.runtime, 'scripted');
  assert.equal(attempt.sandbox.network.mode, 'none'); assert.equal(attempt.sandbox.mounts[0].containerPath, '/workspace');
  assert.equal(attempt.usage.costUsdCents, 9); assert.equal(attempt.usage.toolCalls, 3);
  assert.deepEqual(JSON.parse(row.tool_calls).map((c) => c.tool), ['sandbox_exec', 'changeset_register']);
  const registered = JSON.parse(row.registered);
  assert.deepEqual(registered.map((r) => [r.version, r.kind]), [[f.csA, 'change_set']]);
  const validators = JSON.parse(row.validations).map((v) => `${v.validator}:${v.status}`);
  for (const v of CS_VALIDATORS) assert.ok(validators.includes(`${v}:passed`), v);
  assert.equal(JSON.parse(row.reviews)[0].decision, 'approve');
  assert.equal(JSON.parse(row.accepts)[0].after, f.mergeA);
  assert.deepEqual(JSON.parse(row.merges).map((m) => [m.after, m.confirmed, m.via]), [[f.mergeA, f.mergeA, 'dialog']]);
  // The requirement-draft turn answers it with the draft it registered.
  const draftTurn = w.db.prepare(QUERY).get(f.a.jobId);
  assert.deepEqual(JSON.parse(draftTurn.registered).map((r) => [r.version, r.kind]), [[f.req.id, 'requirement']]);
  assert.equal(JSON.parse(draftTurn.tool_calls)[0].tool, 'requirement_draft');
  // The iteration's revision turn answers the same query with its request-changes input.
  const rev = w.db.prepare(QUERY).get(f.d);
  assert.equal(rev.session_id, f.b.sessionId);
  assert.equal(JSON.parse(rev.egress).length, 200, 'at most 200 decisions are recorded');
  assert.deepEqual(JSON.parse(rev.egress_truncated), [5], 'then one marker counts the rest');
  assert.deepEqual(JSON.parse(rev.inputs).map((i) => i.role), ['review'], 'the revision turn input is the reviewed change set');
  // The turn that was given the diagnostic names it as its input.
  const withDiag = w.db.prepare(QUERY).get(f.c.jobId);
  assert.deepEqual(JSON.parse(withDiag.inputs).map((i) => i.role), ['focus']);
  assert.equal(JSON.parse(rev.registered)[0].version, f.csB2);
  // No secret anywhere the query reached, and no turn's token text anywhere at all.
  // (a 64-hex digest is public and looks secret-shaped to the redactor; the jti is a public id: everything else must pass it as is)
  const flat = (r) => JSON.stringify(r).replace(/(sha256:)?[0-9a-f]{64}/g, 'DIGEST');
  assert.equal(containsSecret(flat(row)), false); assert.equal(containsSecret(flat(rev)), false); assert.equal(containsSecret(flat(draftTurn)), false);
  assert.ok(ctx.tokens.length >= 4);
  const everywhere = [];
  for (const t of w.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    for (const r of w.db.prepare(`SELECT * FROM "${t.name}"`).all()) everywhere.push(JSON.stringify(r));
  }
  everywhere.push(...w.logs, ...w.runnerLogs);
  const attemptLogs = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.log$|\.md$|\.json$/.test(e.name)) attemptLogs.push(fs.readFileSync(p, 'utf8')); } };
  walk(path.join(w.dataHome.root, 'logs')); walk(path.join(w.dataHome.root, 'jobs'));
  everywhere.push(...attemptLogs);
  const blob = everywhere.join('\n');
  for (const tok of ctx.tokens) assert.ok(!blob.includes(tok), 'a turn\'s bearer token is in no row, log or file');
  noLeak(await w.x.ok('nexus:session:get', f.b.sessionId));
  // The session view (#44) answers the same questions for the renderer: turns, tool calls, registered versions.
  const detail = await w.x.ok('nexus:session:get', f.b.sessionId);
  assert.ok(detail.turnHistory.length >= 4);
  assert.ok(detail.versions.some((v) => v.versionId === f.csA));
  assert.ok(detail.toolCalls.some((c) => c.tool === 'changeset_register'));
  sound(w, 'E2E-B2b-3 node');
});

// ---------------------------------------------------------------- E2E-B2b-2: the negative paths (agent side)

/** A world with the repository snapshotted and the agent's permission granted. */
async function ready(fixture = 'node-test-app', o = {}) {
  const w = await flowWorld(o);
  await useFixture(w, fixture);
  await w.snapshot();
  if (!o.noConsent) await w.consent();
  return w;
}
const BAD_TEST = { 'test/bad.test.js': "'use strict';\nconst test = require('node:test');\ntest('adds up [fails]', () => { throw new Error('no'); });\ntest('still fine', () => {});\n", 'src/x.js': "'use strict';\nmodule.exports = 1;\n" };
const AWS = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');

test('E2E-B2b-2 node: consent missing refuses a start with a sentence, and nothing is created', async () => {
  const w = await ready('node-test-app', { noConsent: true });
  const r = await w.drive(w.x.call('nexus:agent:start', { projectId: w.PROJECT, workspaceId: w.WORKSPACE, sessionId: null, focusVersionIds: [], message: 'do it', intentId: intent() }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'consent_missing');
  assert.equal(r.message, AGENT_REASON_MESSAGES.consent_missing);
  assert.match(r.message, /network permission/);
  noLeak(r);
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind = 'agent.run'").get().n, 0);
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM agent_sessions').get().n, 0);
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM capability_tokens').get().n, 0, 'no token was minted');
});

test('E2E-B2b-2 node: a turn that registers nothing ends partial / no_change, and no step is done by its exit code', async () => {
  const w = await ready();
  w.script([{ op: 'delta', text: 'I looked around and changed nothing.' }, { op: 'usage', inputTokens: 100, outputTokens: 20, costUsdCents: 1, toolCalls: 0, estimated: false }, { op: 'complete' }]);
  const t = await w.turn('Please look at the ledger');
  assert.equal(t.job.state, 'partial'); assert.equal(t.job.outcome, 'no_change');
  const a = w.db.prepare('SELECT state, exit_code FROM job_attempts WHERE job_id = ?').get(t.jobId);
  assert.deepEqual([a.state, a.exit_code], ['succeeded', 0], 'the process exited 0 and the attempt succeeded');
  assert.equal(w.changeSetsOf(t.jobId).length, 0);
  assert.notEqual(w.stepOf('ai-implementation'), 'done', 'an exit code of 0 completes no step');
  const view = (await w.x.ok('nexus:jobs:list', { projectId: w.PROJECT, limit: 50 })).find((j) => j.id === t.jobId);
  assert.deepEqual([view.state, view.outcome], ['partial', 'no_change'], 'the job view says no change; the renderer words it by this outcome');
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM capability_tokens WHERE revoked_at IS NULL').get().n, 0);
});

test('E2E-B2b-2 node: a failing test keeps the change set out of candidate, and Accept is a sentence', async () => {
  const w = await ready();
  const { turn, cs } = await makeChange(w, { files: BAD_TEST, title: 'A change with a failing test', execArgv: ['node', '--test'] });
  assert.equal(turn.job.state, 'completed', 'the turn registered work');
  const st = await w.until_candidate(cs);
  assert.equal(st, 'failed', 'a failing blocking check keeps it out of candidate');
  assert.equal(w.checks(cs)['cs.tests_pass'], 'failed');
  assert.equal(w.checks(cs)['git.diff_nonempty'], 'passed');
  assert.notEqual(w.stepOf('ai-implementation'), 'done');
  const tp = (await w.x.ok('nexus:version:validations', cs)).find((v) => v.validatorId === 'cs.tests_pass');
  assert.deepEqual([tp.status, tp.blocking], ['failed', true]);
  // Accept and review are refused in a sentence (never "passed"); the integration ref and the user's branch did not move.
  const before = w.userState(); const ref0 = w.refOf('refs/nexus/accepted/' + (await w.okd('nexus:repo:status', w.PROJECT)).branch);
  const acc = await w.refusedd('nexus:changeSet:accept', [cs, ref0]);
  assert.equal(typeof acc.message, 'string'); assert.ok(acc.message.length > 10); noLeak(acc);
  const rev = await w.x.call('nexus:review:decide', cs, { decision: 'approve' }, intent());
  assert.equal(rev.ok, false); noLeak(rev);
  assert.deepEqual(w.userState(), before);
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM change_set_accepts').get().n, 0);
});

test('E2E-B2b-2 node: a secret in an added line fails sec.secret_scan with path:line only, and the secret text is nowhere', async () => {
  const w = await ready();
  const { cs } = await makeChange(w, { files: { 'src/config.js': `'use strict';\n\nmodule.exports = { key: '${AWS}' };\n`, 'test/c.test.js': "'use strict';\nconst test = require('node:test');\ntest('loads', () => {});\n" },
    title: 'Add a config' });
  assert.equal(await w.until_candidate(cs), 'failed');
  assert.equal(w.checks(cs)['sec.secret_scan'], 'failed');
  const sc = (await w.x.ok('nexus:version:validations', cs)).find((v) => v.validatorId === 'sec.secret_scan');
  assert.equal(sc.blocking, true);
  assert.deepEqual(sc.evidence.map((e) => [e.type, e.name]), [['location', 'src/config.js']], 'the view names the place only');
  const raw = JSON.parse(w.db.prepare("SELECT evidence_json FROM validations WHERE version_id = ? AND validator_id = 'sec.secret_scan' ORDER BY rowid DESC LIMIT 1").get(cs).evidence_json);
  assert.deepEqual(Object.keys(raw[0]).sort(), ['line', 'path', 'rule', 'type'], 'the stored evidence is path:line and the rule, nothing else');
  assert.deepEqual([raw[0].path, raw[0].line], ['src/config.js', 3]);
  assert.ok(!JSON.stringify(sc).includes(AWS), 'the evidence names the place, never the value');
  const dump = [];
  for (const t of w.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) for (const r of w.db.prepare(`SELECT * FROM "${t.name}"`).all()) dump.push(JSON.stringify(r));
  dump.push(...w.logs, ...w.runnerLogs);
  assert.ok(!dump.join('\n').includes(AWS), 'the secret is in no row and no log');
  const acc = await w.refusedd('nexus:changeSet:accept', [cs, w.refOf('HEAD')]);
  noLeak(acc);
});

test('E2E-B2b-2 node: a link planted in the worktree fails the turn worktree_guard, registers nothing, and touches nothing outside', async () => {
  const w = await ready();
  const outside = h.tmpDir('nx-outside-');
  fs.writeFileSync(path.join(outside, 'private.txt'), 'outside the worktree\n');
  w.script((plan) => { ctx.tokens.push(plan.runtime.token); return [
    { op: 'call', tool: 'sandbox_exec', args: { argv: ['plant-link', 'evil', outside], cwd: '/workspace', timeoutMs: 5000 } },
    { op: 'call', tool: 'changeset_register', args: { title: 'After the link', summary: 'x', clientKey: 'cs-link' } },
    { op: 'complete' }]; });
  const before = w.userState();
  const t = await w.turn('Run a command');
  const wt = w.db.prepare('SELECT rel_path FROM session_worktrees WHERE session_id = ?').get(t.sessionId);
  assert.ok(fs.lstatSync(path.join(w.dataHome.root, ...wt.rel_path.split('/'), 'evil')).isSymbolicLink(), 'the command did plant a link in the bind-mounted worktree');
  assert.equal(t.job.state, 'failed');
  assert.equal(t.job.outcome, 'worktree_guard', t.job.error_json);
  assert.equal(w.changeSetsOf(t.jobId).length, 0, 'nothing was registered');
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM capability_tokens WHERE revoked_at IS NULL').get().n, 0, 'the token is revoked');
  assert.equal(w.driver.all().filter((r) => r.kind === 'container' && r.labels['nexus.kind'] === 'agent').length, 0, 'the turn container was removed');
  assert.equal(fs.readFileSync(path.join(outside, 'private.txt'), 'utf8'), 'outside the worktree\n');
  assert.deepEqual(w.userState(), before, 'the user\'s folder is untouched');
  assert.equal(w.stepOf('ai-implementation') === 'done', false);
  // The link also stops a later collect: the worktree is never committed with it.
  w.script([{ op: 'call', tool: 'changeset_register', args: { title: 'Try again', summary: 'x', clientKey: 'cs-link2' } }, { op: 'complete' }]);
  const t2 = await w.turn('Try to register', { sessionId: t.sessionId });
  assert.equal(w.changeSetsOf(t2.jobId).length, 0, 'a worktree holding a link is never collected');
});

test('E2E-B2b-2 node: a restart mid-turn leaves the job and session interrupted, the worktree kept, and no container or token left', async () => {
  const w = await ready();
  w.hold();
  w.script((plan) => { ctx.tokens.push(plan.runtime.token); return [{ op: 'call', tool: 'sandbox_exec', args: { argv: ['hold'], cwd: '/workspace', timeoutMs: 600000 } }, { op: 'complete' }]; });
  const r = await w.start('Run the long command');
  await w.approveA3();
  await w.until(() => w.execs.some((e) => e.argv[0] === 'hold'), 'the command is running');
  assert.equal(w.jobRow(r.job.id).state, 'running');
  const agentContainers = () => w.driver.all().filter((x) => x.kind === 'container' && x.labels['nexus.kind'] === 'agent');
  assert.equal(agentContainers().length, 1, 'the turn container is up');
  const wt = w.db.prepare('SELECT rel_path, ref FROM session_worktrees WHERE session_id = ?').get(r.session.id);
  const dir = path.join(w.dataHome.root, ...wt.rel_path.split('/'));
  const refBefore = w.refOf(wt.ref);
  // The process dies here: main and its runner. A new boot on the same data, with the same Docker.
  const w2 = await w.restart();
  await w2.until(() => w2.jobRow(r.job.id).state === 'interrupted', 'the turn is interrupted');
  assert.equal(w2.db.prepare('SELECT status FROM agent_sessions WHERE id = ?').get(r.session.id).status, 'interrupted');
  const a = w2.db.prepare('SELECT state FROM job_attempts WHERE job_id = ?').get(r.job.id);
  assert.equal(a.state, 'abandoned', 'the attempt the old runner held is abandoned, never adopted');
  assert.equal(w2.db.prepare('SELECT COUNT(*) n FROM capability_tokens WHERE revoked_at IS NULL').get().n, 0, 'its token is revoked');
  assert.equal(w2.db.prepare('SELECT revoke_reason FROM capability_tokens WHERE job_id = ?').get(r.job.id).revoke_reason, 'restart');
  await w2.until(() => agentContainers().length === 0, 'the new runner removes the turn container', 120_000);
  assert.ok(fs.existsSync(dir), 'the worktree folder is kept');
  assert.ok(w2.db.prepare('SELECT 1 FROM session_worktrees WHERE session_id = ? AND removed_at IS NULL').get(r.session.id), 'its row is kept');
  assert.equal(w2.refOf(wt.ref), refBefore, 'its session ref is kept');
  assert.equal(w2.driver.all().filter((x) => x.labels && x.labels['nexus.kind'] === 'agent').length, 0, 'no container of the turn is left');
  w.release();
  sound(w2, 'restart mid-turn');
});

test('E2E-B2b-2 node: the restart test\'s miniature reconcile-at-ready wiring still mirrors main\'s own (src/main/nexusExec/execWiring.ts)', () => {
  // The flows copy main\'s wiring at every runner ready in miniature (the real one forks a runner process). If the real sequence
  // changes, this fails and the copy in test/helpers/agentFlowWorld.cjs must be brought in line.
  const KEYS = ['reconcile.list', 'exec.reconcileCandidates()', 'reconcileList()', 'reconcile.result', 'recoverPhaseB(', 'reconcile.remove', 'report.remove', 'recordOrphanRemoval('];
  const real = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'nexusExec', 'execWiring.ts'), 'utf8');
  const copy = fs.readFileSync(path.join(__dirname, 'helpers', 'agentFlowWorld.cjs'), 'utf8');
  for (const [name, text] of [['execWiring.ts', real], ['agentFlowWorld.cjs', copy]]) {
    assert.deepEqual(KEYS.filter((k) => !text.includes(k)), [], `${name} holds the whole reconcile sequence`);
  }
});
