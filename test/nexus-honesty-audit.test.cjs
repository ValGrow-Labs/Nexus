// test/nexus-honesty-audit.test.cjs
// B2a Task 15: the honesty audit. For every domain and every availability state of this computer, even when
// main's action answer claims every action is available, no enabled action maps to a FUTURE step, an unmet
// machine prerequisite or a missing input; no shown number lacks a source; no domain is ever called complete;
// and the registry strings and the new copy pass the identity guard's rules.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const L = loadTs('src/renderer/src/nexus/workspaces/lifecycleModel.ts');
const AM = loadTs('src/renderer/src/nexus/project/actionModel.ts');
const X = loadTs('src/renderer/src/nexus/data/executionModel.ts');
const { DOMAINS } = loadTs('src/shared/nexus/domains/index.ts');
const { USER_ACTIONS } = loadTs('src/shared/nexus/actions.ts');
const { copyItems, scanText } = require('./helpers/identityGuard.cjs');

const GIB = 2 ** 30;
const NEXUS = path.join(__dirname, '..', 'src', 'renderer', 'src', 'nexus');
const health = (o = {}) => ({
  db: { version: 9, platform: true, handoffs: true, execution: true }, registry: { valid: true, problems: 0 },
  runner: { state: 'ready', attached: true, restarts: 0 }, docker: { state: 'running', version: '29', cpus: 8, memoryBytes: 8 * GIB },
  images: ['sde-node', 'sde-python', 'nexus-fwd'].map((profile) => ({ profile, present: true, matches: true })),
  disk: { dataHomeFreeBytes: 52 * GIB, requiredBytes: 30 * GIB, recommendedBytes: 40 * GIB, leaseFloorBytes: 5 * GIB, gate: 'ok' },
  problems: [], gpu: { detected: false, supported: false }, checkedAt: 1, ...o
});
const ok = (h) => ({ ok: true, data: h });
const STATES = {
  'platform off': X.availabilityFrom({ unavailable: { reason: 'held' } }, null),
  'execution held': X.availabilityFrom({ unavailable: null }, { ok: false, code: 'platform_unavailable', reason: 'execution_unavailable', subReason: 'held', message: 'm' }),
  'execution not connected': X.availabilityFrom({ unavailable: null }, { ok: false, code: 'platform_unavailable', reason: 'execution_unavailable', subReason: 'unreachable', message: 'm' }),
  'Docker stopped': X.availabilityFrom({ unavailable: null }, ok(health({ docker: { state: 'stopped' }, problems: ['docker_stopped'] }))),
  'disk below the gate': X.availabilityFrom({ unavailable: null }, ok(health({ disk: { dataHomeFreeBytes: 18 * GIB, requiredBytes: 30 * GIB, recommendedBytes: 40 * GIB, leaseFloorBytes: 5 * GIB, gate: 'below_required' }, problems: ['disk_low'] }))),
  // Final review C2 (ruled): below 30 GB jobs still run (an advisory); below the lease floor no job starts.
  'disk below the lease floor': X.availabilityFrom({ unavailable: null }, ok(health({ disk: { dataHomeFreeBytes: 3 * GIB, requiredBytes: 30 * GIB, recommendedBytes: 40 * GIB, leaseFloorBytes: 5 * GIB, gate: 'below_required' }, problems: ['disk_low'] }))),
  'image missing': X.availabilityFrom({ unavailable: null }, ok(health({ images: [{ profile: 'sde-node', present: false, matches: false }], problems: ['image_missing:sde-node'] }))),
  'not checked yet': X.availabilityFrom({ unavailable: null }, ok(health({ checkedAt: null, docker: { state: 'unknown' },
    disk: { dataHomeFreeBytes: null, requiredBytes: 30 * GIB, recommendedBytes: 40 * GIB, leaseFloorBytes: 5 * GIB, gate: 'unknown' } }))),
  'git missing': X.availabilityFrom({ unavailable: null }, ok(health({ problems: ['git_missing'] }))),
  'all ready': X.availabilityFrom({ unavailable: null }, ok(health()))
};
const MACHINE = /^(docker|disk:|image:)/;
const KINDS = [...new Set(DOMAINS.flatMap((d) => d.kindsProduced))];

/** main's answer at its most generous: every action of the domain "available", with its real input slots. */
const generous = (d) => USER_ACTIONS.filter((a) => d.actions.includes(a.id)).map((a) => ({
  actionId: a.id, label: a.label, available: true, reason: null, needsApproval: false, inputs: a.inputs.map((s) => ({ ...s })),
  stepId: d.lifecycle.find((s) => s.via.some((v) => v.userAction === a.id))?.id ?? null
}));
// Plus answers main never sends today: this domain's actions pointed at every FUTURE step or at no step, and every
// other domain's actions answered under this one.
const futureFakes = (d) => [
  ...d.lifecycle.filter((s) => s.status === 'FUTURE').flatMap((s) => d.actions.map((id) => ({
    actionId: id, label: `pointed at ${s.id}`, available: true, reason: null, needsApproval: false, inputs: [], stepId: s.id }))),
  ...d.actions.map((id) => ({ actionId: id, label: `no step ${id}`, available: true, reason: null, needsApproval: false, inputs: [], stepId: null })),
  ...USER_ACTIONS.filter((a) => !d.actions.includes(a.id)).map((a) => ({
    actionId: a.id, label: `fake cross ${a.id}`, available: true, reason: null, needsApproval: false, inputs: [], stepId: null }))
];

test('HA1 no enabled action maps to a FUTURE step, an unmet machine prerequisite or a missing input (every domain x every state)', () => {
  let checked = 0;
  for (const d of DOMAINS) {
    for (const [state, availability] of Object.entries(STATES)) {
      const contexts = [{ version: null }, ...KINDS.flatMap((k) => ['draft', 'candidate', 'active'].map((st) => ({ version: { kind: k, status: st } })))];
      for (const c of contexts) {
        const bar = AM.actionBar([...generous(d), ...futureFakes(d)], { workspaceId: d.id, availability, ...c });
        for (const b of bar.buttons) {
          checked++;
          const def = USER_ACTIONS.find((a) => a.id === b.actionId);
          const step = d.lifecycle.find((s) => s.via.some((v) => v.userAction === b.actionId));
          const where = `${d.id} / ${state} / ${b.actionId} / ${c.version ? `${c.version.kind}:${c.version.status}` : 'project'}`;
          assert.ok(!/^fake cross /.test(b.label), `${where}: another domain's action offered`);
          assert.ok(d.actions.includes(b.actionId), `${where}: not this domain's action`);
          assert.ok(step && step.status !== 'FUTURE', `${where}: its step is in this release`);
          if (def.prerequisites.some((p) => MACHINE.test(p))) assert.equal(availability.kind, 'ready', `${where}: machine prerequisite unmet`);
          for (const slot of def.inputs.filter((s) => s.min >= 1)) {
            // An input-taking action is a button only on a usable version of its input kind (never on the project bar).
            const filled = !!c.version && slot.kinds.includes(c.version.kind) && (['candidate', 'active'].includes(c.version.status)
              || (b.actionId === 'sde.preview.start' && c.version.status === 'draft'));
            assert.ok(filled, `${where}: input ${slot.slot} missing`);
          }
          // A version bar never shows an action that does not take the version.
          if (c.version) assert.ok(def.inputs.some((s) => s.kinds.includes(c.version.kind)), `${where}: not an action on this version`);
        }
      }
    }
  }
  assert.ok(checked > 0, 'some actions were offered (the audit is not vacuous)');
});

test('HA1 a domain a project cannot take part in, or a registry-only one, offers nothing', () => {
  for (const id of ['data-scientist', 'research', 'uiux', 'devops']) {
    const d = DOMAINS.find((x) => x.id === id);
    assert.deepEqual(d.actions, [], id);
    const bar = AM.actionBar([...generous(d), ...futureFakes(d)], { workspaceId: id, availability: STATES['all ready'], version: null });
    assert.equal(bar.buttons.length, 0, id);
  }
});

/** Every shown string of a rail. */
const railTexts = (r) => [r.label, r.statusNote, r.availability, L.railSummary(r), ...r.steps.flatMap((s) => [s.label, s.word, s.note]),
  ...r.modules.flatMap((m) => [m.label, m.note])].filter((x) => typeof x === 'string');
const RECORDS = [null, { versions: [], liveActions: [], participation: true, deploymentHealthy: false },
  { versions: KINDS.map((kind) => ({ kind, status: 'active', validators: {} })), liveActions: USER_ACTIONS.map((a) => a.id), participation: true, deploymentHealthy: true }];

test('HA1 no domain is ever called complete; FUTURE steps never carry a state', () => {
  for (const v of L.bundledDomainViews()) {
    // Wave-1 review, ruling on finding 1 (a restoration, not a weakening): the view reads the delivered sub-phase, so a domain is
    // executable end to end only when the build has proven its flow. B2b Task 16 proved the SDE flow (scripted end to end, node and
    // python fixtures) and set DELIVERED_SUB_PHASE = B2b: SDE is, the other five are not.
    assert.equal(v.currentSubPhase, 'B2b', `${v.id}: the view carries the delivered sub-phase`);
    assert.equal(v.executableEndToEnd, v.id === 'sde', `${v.id} is executable end to end as delivered (B2b) only if it is SDE`);
    for (const records of RECORDS) {
      const r = L.railFor(v, records);
      for (const t of railTexts(r)) assert.doesNotMatch(t, /\bcomplete(d)?\b|finished|end to end/i, `${v.id}: ${t}`);
      for (const s of r.steps.filter((x) => x.future)) {
        assert.ok(s.state === null || s.state === 'unavailable', `${v.id}/${s.id}`);
        assert.equal(s.word, 'Not in this release');
      }
    }
  }
});

// Final review C6a: the B2a activity sentences (rows built as main writes them, mapped by the real dto.activityView)
// and every job-run headline join the "never called complete" scan.
const ACT = loadTs('src/renderer/src/nexus/project/activityModel.ts');
const DTO = loadTs('src/main/nexusIpc/dto.ts');
const R = loadTs('src/renderer/src/nexus/runs/jobRunModel.ts');
const NEVER_COMPLETE = /\bcomplete(d)?\b|finished|end to end/i;
const ACT_CTX = { names: new Map(), versionNos: new Map(), workspaceLabel: (x) => x, now: 1 };
/** One activity row as main writes it (writer.ts ActivityEntry), with principal ids the DTO never sends. */
const entry = (action, details, status = 'succeeded') => ({ seq: 1, id: 'act1', ts: 1, actorKind: 'system', actorId: 'system', onBehalfOf: 'user:local',
  sessionId: null, jobId: 'j1', attemptN: 1, workspaceId: 'sde', projectId: 'p', artifactId: null, versionId: null, entityType: 'job', entityId: 'j1',
  action, status, details, prevHash: '', hash: '' });
const B2A_ROWS = [
  ...['egress.deps', 'image.prepare'].map((reason) => ['approval.request', { reason }]),
  ...['once', 'deny'].flatMap((decision) => ['egress.deps', 'image.prepare'].map((reason) => ['approval.respond', { reason, decision, consumedBy: null }])),
  ['approval.expire', { reason: 'egress.deps' }], ['approval.withdraw', {}],
  ['image_build.start', { buildId: 'b', profileId: 'sde-node' }],
  ...['succeeded', 'interrupted', 'failed', 'cancelled'].map((status) => ['image_build.finish', { status, profileId: 'sde-node' }]),
  ['deployment.start', { deploymentId: 'd' }],
  ...['healthy', 'unhealthy'].map((to) => ['deployment.transition', { to }]),
  ...['idle', 'app_quit', 'recovery', 'cancel', 'user', 'new_reason'].map((reason) => ['deployment.transition', { to: 'stopped', reason }]),
  ...['probe_failed', 'exited', 'start_timeout', 'refused', 'preflight_failed', 'runner_lost', 'exit_not_reported'].map((reason) => ['deployment.transition', { to: 'failed', reason }]),
  ...['completes_on_exit', 'cancelled', 'none'].map((job) => ['deployment.stop', { reason: 'user', job }]),
  ...['requeue', 'retry', 'interrupt', 'reown', 'expire', 'adopt', 'finalize', 'fail', 'exit_lost', 'image_interrupted', 'orphans', 'unknown_resources',
    'unreconciled', 'brand_new'].map((decision) => ['exec.recover', { decision, reason: 'container_exited', to: 'running' }]),
  ...['oom', 'nonzero_exit', 'invalid_output', 'outputs_missing'].map((status) => ['exec.recover', { decision: 'fail', reason: 'container_exited', status, to: 'failed' }]),
  ...[0, 1, 3].map((requested) => ['exec.orphan_removed', { requested }]),
  ['version.revalidate', { intent: 'i', jobs: ['j2'] }],
  // B2b: the agent flow's rows (decision words only; no sentence calls the work complete or the change merged before it was).
  ...['grant', 'revoke', 'other'].map((op) => ['agent.consent', { op }]), ['auth.denied', { reason: 'out_of_scope' }], ['token.mint', {}], ['token.revoke', {}],
  ['repo.worktree', { reused: true }], ['repo.worktree', { reused: false }], ['mcp.call', {}], ['context_redacted', {}],
  ...['approve', 'request_changes', 'reject', 'other'].map((decision) => ['review.decide', { decision }]),
  ['changeset.accept', {}], ['changeset.rollback', {}], ['repo.merge', {}],
  ['job.create', {}], ['job.cancel', {}],
  ...['queued', 'leased', 'running', 'awaiting_approval', 'retry_scheduled', 'completed', 'partial', 'failed', 'cancelled', 'timed_out', 'interrupted']
    .map((to) => ['job.transition', { from: 'running', to }])
];

test('HA1 (final review C6a) no B2a activity sentence or job-run headline calls work complete', () => {
  const texts = [];
  for (const [action, details] of B2A_ROWS) {
    for (const status of ['succeeded', 'failed', 'denied', 'cancelled']) {
      const view = DTO.activityView(entry(action, details, status));
      const text = ACT.activityText(view, ACT_CTX);
      texts.push(text);
      assert.doesNotMatch(text, NEVER_COMPLETE, `${action} ${JSON.stringify(details)} ${status}: ${text}`);
      assert.ok(!text.startsWith('Recorded '), `${action}: a sentence, not the bare action name`);
    }
  }
  // The sentences really read the details (the DTO keeps them): answers differ, and recovery decisions keep their words.
  const say = (action, details) => ACT.activityText(DTO.activityView(entry(action, details)), ACT_CTX);
  assert.notEqual(say('approval.respond', { reason: 'egress.deps', decision: 'once' }), say('approval.respond', { reason: 'egress.deps', decision: 'deny' }));
  assert.match(say('exec.recover', { decision: 'fail', status: 'oom' }), /^Job failed/);
  assert.match(say('exec.recover', { decision: 'interrupt' }), /interrupted/);
  assert.equal(say('exec.recover', { decision: 'brand_new' }), 'Restart recovery recorded a decision');
  assert.equal(say('job.transition', { to: 'completed' }), 'Job ran; its checks give the result');
  for (const t of texts) assert.deepEqual(scanText(t, true), [], t);

  // Every headline, for every kind of run, with and without a sourced reason: headline, word and stage labels.
  const flavours = [...USER_ACTIONS.map((a) => ({ actionId: a.id, recipeId: null, kind: 'tool.run' })), { actionId: null, recipeId: null, kind: 'validate' },
    { actionId: null, recipeId: 'something.else', kind: 'tool.run' },
    // B2b: an agent turn and the jobs its flow starts (their titles are words, never a recipe id).
    { actionId: null, recipeId: null, kind: 'agent.run' }, ...['repo.worktree', 'changeset.collect', 'changeset.merge_check', 'changeset.accept', 'changeset.accept_rollback', 'repo.ff']
      .map((recipeId) => ({ actionId: null, recipeId, kind: 'tool.run' }))];
  const HEADLINES = ['queued', 'waiting:runner', 'waiting:docker', 'waiting:image', 'waiting:disk', 'waiting:slots', 'waiting:memory', 'waiting:git',
    'waiting:retry', 'provisioning', 'running', 'waiting_for_approval', 'collecting', 'validating', 'checks_passed', 'checks_failed',
    'checks_could_not_run', 'failed', 'cancelled', 'timed_out', 'interrupted'];
  let n = 0;
  for (const f of flavours) {
    for (const h of HEADLINES) {
      for (const reason of [null, 'No tests were executed.']) {
        const v = R.jobRun({ id: 'J', projectId: 'p', workspaceId: 'sde', state: 'completed', phase: null, headline: h, outcome: null, error: null, attempts: 1,
          retryOf: null, parentJobId: null, requestedByKind: 'user', inputs: [], createdAt: 1, updatedAt: 1, startedAt: 1, finishedAt: null, nextAttemptAt: null,
          cancelRequested: false, ...f }, { reason });
        for (const t of [v.headline, v.word, v.title, ...v.stages.map((s) => s.label)]) {
          n++;
          assert.doesNotMatch(t, NEVER_COMPLETE, `${f.actionId ?? f.kind} / ${h}: ${t}`);
        }
      }
    }
  }
  assert.ok(n > 1000, 'the headline scan is not vacuous');
});

test('HA1 no number without a source: rail numbers are sub-phase names or counts of the rail\'s own steps', () => {
  for (const v of L.bundledDomainViews()) {
    for (const records of RECORDS) {
      const r = L.railFor(v, records);
      const summary = L.railSummary(r);
      for (const t of railTexts(r)) {
        // Sub-phase names and the loopback address are names, not measurements.
        const rest = t.replace(/\bB\d[a-c]?\b/g, '').replace(/\b127\.0\.0\.1\b/g, '');
        if (t !== summary) { assert.doesNotMatch(rest, /\d/, `${v.id}: ${t}`); continue; }
        if (r.availability) continue;
        const inRelease = r.steps.filter((s) => !s.future);
        const nums = (rest.match(/\d+/g) || []).map(Number);
        const expected = [inRelease.filter((s) => s.state === 'done').length, inRelease.length];
        const attention = inRelease.filter((s) => s.state === 'failed').length;
        const moving = inRelease.filter((s) => s.state === 'in_progress').length;
        if (attention > 0) expected.push(attention);
        if (moving > 0) expected.push(moving);
        if (r.steps.length > inRelease.length) expected.push(r.steps.length - inRelease.length);
        assert.deepEqual(nums, expected, `${v.id}: ${t}`);
      }
    }
  }
  // The setup sheet's numbers come from the health view itself.
  const rows = X.setupSheet(health({ disk: { dataHomeFreeBytes: 18 * GIB, requiredBytes: 30 * GIB, recommendedBytes: 40 * GIB, leaseFloorBytes: 5 * GIB, gate: 'below_required' } }));
  assert.equal(rows.find((r) => r.id === 'disk').text, 'Free disk is 18 GB; preparing images and the execution checks need 30 GB (40 GB recommended)');
  // Final review C2: the gate's states, as ruled. Below 30 GB: ready with the advisory; below the floor: setup.
  assert.equal(STATES['disk below the gate'].kind, 'ready');
  assert.deepEqual(STATES['disk below the gate'].advisories, ['Free disk is 18 GB; preparing images and the execution checks need 30 GB (40 GB recommended).']);
  assert.deepEqual([STATES['disk below the lease floor'].kind, STATES['disk below the lease floor'].problems], ['setup', ['disk_low']]);
  const missing = X.setupSheet(health({ images: [{ profile: 'sde-node', present: false, matches: false }],
    disk: { dataHomeFreeBytes: 18 * GIB, requiredBytes: 30 * GIB, recommendedBytes: 40 * GIB, leaseFloorBytes: 5 * GIB, gate: 'below_required' } }));
  assert.equal(missing.find((r) => r.id === 'image:sde-node').prepare, null, 'below the gate no image can be prepared');
});

// ---------- HA-B2b ----------

test('HA-B2b the agent flow actions answer agents_unavailable while the agents part is off, and are never a button then', () => {
  const { ExecQueries } = loadTs('src/main/nexus/exec/execQueries.ts');
  const sde = DOMAINS.find((d) => d.id === 'sde');
  const flows = USER_ACTIONS.filter((a) => 'flow' in a.run);
  assert.deepEqual(flows.map((a) => a.id), ['sde.agent.turn', 'sde.changeset.review', 'sde.changeset.accept', 'sde.repo.merge']);
  // main's #24 reason for each flow action (ExecQueries.reasonFor, with every other check passing).
  const reason = (a, deps, versionKind = null) => {
    const step = sde.lifecycle.find((s) => s.via.some((v) => v.userAction === a.id));
    return ExecQueries.prototype.reasonFor.call({ deps, db: null }, a, step, versionKind, () => true, () => true, (k) => k, 'P', 'active');
  };
  for (const a of flows) {
    assert.ok(sde.actions.includes(a.id), `${a.id} is an SDE action`);
    for (const deps of [{}, { agentsAvailable: () => false }, { agentsAvailable: () => { throw new Error('x'); } }, { agentsAvailable: () => 'yes' }])
      assert.equal(reason(a, deps), 'agents_unavailable', `${a.id} with the agents part off`);
    // A version of a kind the action does not take is not applicable (it is never listed on that bar).
    assert.equal(reason(a, {}, 'requirement'), 'not_applicable', a.id);
    // Only once the agents part is on does it fall through to the permission check.
    assert.equal(reason(a, { agentsAvailable: () => true }), null, a.id);
  }
  // The renderer, given that answer, shows a sentence and never a button, in every state and on every bar.
  const answer = flows.map((a) => ({ actionId: a.id, label: a.label, available: false, reason: 'agents_unavailable', needsApproval: false,
    inputs: a.inputs.map((s) => ({ ...s })), stepId: null }));
  let sentences = 0;
  for (const [state, availability] of Object.entries(STATES)) {
    for (const version of [null, ...['change_set', 'requirement'].flatMap((kind) => ['draft', 'candidate', 'active'].map((status) => ({ kind, status })))]) {
      const bar = AM.actionBar(answer, { workspaceId: 'sde', availability, version });
      assert.deepEqual(bar.buttons, [], `${state} / ${version ? `${version.kind}:${version.status}` : 'project'}`);
      for (const s of bar.sentences) {
        sentences++;
        // Round 4 (final review I2) and round 6: one agent-off sentence that names no cause it cannot know (the action view carries no reason).
        assert.match(s.text, /: Agent work is not available on this computer right now\. Open Setup to see why\.$/, s.text);
        assert.doesNotMatch(s.text, /agents_unavailable/, 'never a raw code');
      }
    }
  }
  assert.ok(sentences > 0, 'the flows are explained as sentences (the audit is not vacuous)');
});

// ---------- HA2 ----------

const NEW_COPY = ['workspaces/lifecycleModel.ts', 'workspaces/LifecycleRail.tsx', 'data/useExecution.ts', 'data/executionModel.ts', 'data/errorCopy.ts',
  'runs/jobRunModel.ts', 'runs/JobLogSheet.tsx', 'runs/ProjectRuns.tsx', 'project/evidenceModel.ts', 'project/EvidenceSection.tsx', 'project/kindViewers.tsx',
  'project/ActionBar.tsx', 'project/ApprovalsSection.tsx', 'project/DeploymentsSection.tsx', 'project/RequirementSheet.tsx', 'project/actionModel.ts',
  'components/ExecutionSetupSheet.tsx', 'components/ExecutionNotice.tsx',
  // B2b Task 15: the agent panel, the change-set views and their models.
  'agent/agentModel.ts', 'agent/AgentPanel.tsx', 'agent/SessionLog.tsx', 'project/changeSetModel.ts', 'project/ChangeSetReview.tsx', 'data/useAgents.ts'];

test('HA2 the registry strings and the new copy pass the identity guard rules (no persona, office or lead words)', () => {
  const strings = [];
  const walk = (v) => { if (typeof v === 'string') strings.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(DOMAINS);
  walk(USER_ACTIONS.map((a) => a.label));
  assert.ok(strings.length > 300, `the registry was walked (${strings.length})`);
  for (const s of strings) assert.deepEqual(scanText(s, true), [], s);
  for (const f of NEW_COPY) for (const it of copyItems(path.join(NEXUS, f))) assert.deepEqual(scanText(it.text, true), [], `${f}: ${it.text}`);
  for (const v of L.bundledDomainViews()) for (const t of railTexts(L.railFor(v))) assert.deepEqual(scanText(t, true), [], t);
});
