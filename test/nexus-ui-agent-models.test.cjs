// test/nexus-ui-agent-models.test.cjs
// B2b Task 15: the renderer's agent models (through load-ts) and source pins on the components (no jsdom).
// UA1-UA9, UA11, UA12, plus the carries of the Task 9, 10 and 14 reviews that live in the renderer.
// Named nexus-ui-* (not nexus-exec-*): test:exec runs every test/nexus-exec-*.test.cjs under real Docker.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const A = loadTs('src/renderer/src/nexus/agent/agentModel.ts');
const CS = loadTs('src/renderer/src/nexus/project/changeSetModel.ts');
const E = loadTs('src/renderer/src/nexus/data/errorCopy.ts');
const X = loadTs('src/renderer/src/nexus/data/executionModel.ts');
const R = loadTs('src/renderer/src/nexus/runs/jobRunModel.ts');
const AM = loadTs('src/renderer/src/nexus/project/actionModel.ts');
const ACT = loadTs('src/renderer/src/nexus/project/activityModel.ts');
const ART = loadTs('src/renderer/src/nexus/project/artifactModel.ts');
const ENV = loadTs('src/main/nexusIpc/envelope.ts');
const { DOMAINS } = loadTs('src/shared/nexus/domains/index.ts');

const ROOT = path.join(__dirname, '..');
const NEXUS = path.join(ROOT, 'src', 'renderer', 'src', 'nexus');
const src = (p) => fs.readFileSync(path.join(NEXUS, p), 'utf8');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const NOW = 1_800_000_000_000;
const SHA = 'a'.repeat(40);

const VENDOR = /claude|anthropic|hermes|sonnet|opus|haiku|openai|gpt-/i;
const HOSTLIKE = /\b[a-z0-9-]+(\.[a-z0-9-]+)+:\d{2,5}\b|https?:\/\/|\bapi\.[a-z]+\.[a-z]+/i;

const agentView = (o = {}) => ({
  state: 'ready', label: 'Acme Agent', version: '9.9.9', signedIn: 'yes', flagsOk: true,
  consent: { live: true, caps: { turnUsdCents: 200, dayUsdCents: 1000, turnsPerHour: 6, concurrentTurns: 1, turnTokens: 400000, toolCalls: 200, wallClockMs: 1800000, childJobs: 20 },
    hostsCount: 1, grantedAt: NOW },
  usageToday: { usdCents: 120, turns: 2, estimated: false }, ...o
});
const health = (o = {}) => ({
  db: { version: 10, platform: true, handoffs: true, execution: true }, registry: { valid: true, problems: 0 }, runner: { state: 'ready', attached: true, restarts: 0 },
  docker: { state: 'running', version: '27', os: 'linux', wsl2: true, cpus: 8, memoryBytes: 16 * 2 ** 30 }, images: [{ profile: 'sde-node', present: true, matches: true }],
  disk: { dataHomeFreeBytes: 80 * 2 ** 30, requiredBytes: 30 * 2 ** 30, recommendedBytes: 40 * 2 ** 30, leaseFloorBytes: 5 * 2 ** 30, gate: 'ok' },
  problems: [], gpu: { detected: false, supported: false }, checkedAt: NOW, agent: agentView(), ...o
});
const READY = { kind: 'ready', advisories: [] };
const session = (o = {}) => ({ id: 'S1', projectId: 'p', workspaceId: 'sde', status: 'open', turns: 1, liveJobId: null, createdAt: NOW, updatedAt: NOW, ...o });
const job = (o = {}) => ({
  id: 'J1', kind: 'agent.run', projectId: 'p', workspaceId: 'sde', actionId: null, recipeId: null, state: 'queued', phase: null, headline: 'queued', outcome: null,
  error: null, attempts: 0, retryOf: null, parentJobId: null, requestedByKind: 'user', inputs: [], createdAt: NOW, updatedAt: NOW, startedAt: null, finishedAt: null,
  nextAttemptAt: null, cancelRequested: false, ...o
});
const validation = (id, status, o = {}) => ({ validatorId: id, blocking: true, status, summary: null, finishedAt: NOW, evidence: [], latestRun: null, history: 1, ...o });
const BLOCKING = ['git.diff_nonempty', 'git.paths_in_scope', 'sec.secret_scan', 'cs.tests_pass', 'git.applies_cleanly'];
const allPass = () => BLOCKING.map((id) => validation(id, 'passed'));
const repo = (o = {}) => ({ projectId: 'p', branch: 'main', head: SHA, dirty: false, integrationRef: 'refs/nexus/accepted/main', acceptedHead: SHA, acceptedNotMerged: 0,
  canFastForward: false, reason: 'nothing_to_merge', checkedAt: NOW, ...o });
// A change whose whole preview is shown (an explicit true); R5 covers every other value.
const cset = (status, o = {}) => ({ status, content: { type: 'git', commit: SHA }, previewComplete: true, previewReason: null, ...o });
// The whole patch is loaded (a fixture default; R7 covers every other state): changeSetModel fails closed without it.
const WHOLE = { whole: true, readBytes: 10, totalBytes: 10 };
const csm = (i) => CS.changeSetModel({ diffRead: WHOLE, ...i });

// ---------- UA1 ----------

test('UA1 every reason main words has one sentence in the renderer, word for word, and no raw code is ever shown', () => {
  const main = ENV.AGENT_REASON_MESSAGES;
  assert.ok(Object.keys(main).length >= 38, 'the mirror is not vacuous');
  for (const [k, text] of Object.entries(main)) {
    assert.equal(E.AGENT_REASON_TEXT[k], text, `${k} reads as main words it`);
    for (const code of ['conflict', 'invalid', 'unavailable', 'denied']) {
      const shown = E.errorCopy(code, k).text;
      assert.equal(shown, text, `${code}/${k}`);
      assert.doesNotMatch(shown, /[a-z]+_[a-z_]+/, `${k}: no raw code in "${shown}"`);
    }
  }
  // The refusals the brief names, each by detail.reason.
  for (const k of ['ref_moved', 'merge_conflict', 'accept_rolled_back', 'integration_unexpected', 'tree_dirty', 'branch_mismatch', 'not_fast_forward',
    'nothing_to_merge', 'cancelled', 'merge_pending', 'accept_pending']) {
    assert.ok(E.AGENT_REASON_TEXT[k] && E.AGENT_REASON_TEXT[k].length > 10, k);
    // Main's sentence, then (for the refusals that would leave the person stuck) one next step.
    const next = A.NEXT_STEP[k] ? ` ${A.NEXT_STEP[k]}` : '';
    assert.equal(A.agentFailText({ code: 'conflict', reason: k }), `${E.AGENT_REASON_TEXT[k]}${next}`);
  }
  // An unknown reason never shows its code; the owed undo is said after the sentence.
  const unknown = A.agentFailText({ code: 'conflict', reason: 'brand_new_reason_x' });
  assert.doesNotMatch(unknown, /brand_new_reason_x|brand new reason x/);
  assert.match(A.agentFailText({ code: 'conflict', reason: 'accept_rolled_back', detail: { rollbackOwed: true } }), /still has to undo a step that did not finish/);
  assert.doesNotMatch(A.agentFailText({ code: 'conflict', reason: 'ref_moved', detail: { current: SHA, rollbackOwed: false } }), new RegExp(SHA));
  // Agent work off reads a sentence, never "agents_unavailable".
  const off = E.errorCopy('platform_unavailable', 'agents_unavailable', 'not_enabled');
  assert.match(off.text, /^The AI helper is not available because it is not turned on in this version of the app/);
  assert.equal(off.kind, 'execution_unavailable');
  assert.doesNotMatch(E.errorCopy('platform_unavailable', 'agents_unavailable', 'weird').text, /agents_unavailable|weird/);
  // The reasons B2a and B1 word are untouched.
  assert.equal(E.errorCopy('invalid', 'queue_full').text, E.EXEC_REASON_TEXT.queue_full);
  assert.equal(E.errorCopy('invalid', 'path_refused').text, E.REASON_TEXT.path_refused);
});

// ---------- UA2, UA11 ----------

const agentFiles = () => walk(path.join(NEXUS, 'agent')).filter((f) => /\.(ts|tsx)$/.test(f));
// The change-set views, and the shared files this task's copy lives in (copy outside the setup row names no engine or host).
const VIEW_FILES = ['project/changeSetModel.ts', 'project/ChangeSetReview.tsx', 'data/errorCopy.ts', 'runs/jobRunModel.ts', 'intent/IntentLine.tsx', 'data/useAgents.ts'];

test('UA2 no engine or vendor name in agent/** or the change-set views (code or comments)', () => {
  const files = [...agentFiles(), ...VIEW_FILES.map((f) => path.join(NEXUS, f))];
  assert.ok(files.length >= 9, 'the scan sees the agent files and the change-set views');
  for (const f of files) {
    fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((l, i) => assert.doesNotMatch(l, VENDOR, `${path.relative(ROOT, f)}:${i + 1}`));
  }
});

test('UA11 no host or model string in agent/** or the change-set views; only the setup row carries the adapter label and the hosts', () => {
  for (const f of [...agentFiles(), ...VIEW_FILES.map((f) => path.join(NEXUS, f))]) {
    fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((l, i) => assert.doesNotMatch(l, HOSTLIKE, `${path.relative(ROOT, f)}:${i + 1}`));
  }
  // Every output of the panel, log and change-set models, built from a view that carries a label and hosts, names neither.
  const h = health({ agent: agentView({ label: 'Acme Agent' }) });
  const hosts = ['api.example.test:443'];
  const outs = [];
  const walkStrings = (v) => { if (typeof v === 'string') outs.push(v); else if (Array.isArray(v)) v.forEach(walkStrings); else if (v && typeof v === 'object') Object.values(v).forEach(walkStrings); };
  walkStrings(A.agentPanelModel({ health: h, availability: READY, sessions: [session({ status: 'running', liveJobId: 'J1' })], sessionsFail: null,
    jobs: new Map([['J1', job({ state: 'queued', phase: 'waiting:consent' })]]) }));
  walkStrings(A.agentPanelModel({ health: health({ agent: agentView({ consent: { live: false, caps: null, hostsCount: 1, grantedAt: null } }) }), availability: READY, sessions: [], sessionsFail: null }));
  walkStrings(A.sessionLogModel({ ...session(), turnHistory: [{ jobId: 'J1', state: 'completed', headline: 'checks_passed', outcome: 'completed', error: { code: 'x', message: 'api.example.test:443 said no' }, usage: null, createdAt: NOW, startedAt: NOW, finishedAt: NOW }],
    messages: [], toolCalls: [{ seq: 1, ts: NOW, jobId: 'J1', tool: 'Read', ok: true, resultBytes: 10 }], versions: [], approvals: [] }));
  for (const status of ['draft', 'candidate', 'active', 'failed', 'deprecated'])
    for (const review of [null, 'approve', 'reject']) walkStrings(csm({ version: cset(status), validations: allPass(), review, repo: repo({ acceptedNotMerged: 1, canFastForward: true, reason: null }) }));
  for (const t of outs) { assert.doesNotMatch(t, /Acme|api\.example|:443/, t); assert.doesNotMatch(t, VENDOR, t); }
  // The setup row does carry them (it is the one place).
  const rows = X.setupSheet(h, { hosts });
  assert.equal(rows.find((r) => r.id === 'agent').label, 'Acme Agent');
  assert.match(rows.find((r) => r.id === 'agent-consent').text, /api\.example\.test:443/);
  for (const r of rows.filter((r) => !r.id.startsWith('agent'))) assert.doesNotMatch(`${r.label} ${r.text} ${r.action ?? ''}`, /Acme|api\.example/);
  // Hosts are only ever read from the #51 answer's own list, shape-checked.
  assert.deepEqual(X.consentHostsOf({ consent: { hosts: ['api.example.test:443', 'not a host', 7, 'x.y:99999999'] } }), ['api.example.test:443']);
  assert.equal(X.consentHostsOf({ consent: { hostsCount: 1 } }), null);
});

// ---------- UA3 ----------

test('UA3 Accept appears only on a candidate whose newest review approves (and only when the accepted branch head is known)', () => {
  let accepts = 0;
  for (const status of ['draft', 'candidate', 'active', 'failed', 'deprecated']) {
    for (const review of [undefined, null, 'approve', 'request_changes', 'reject']) {
      for (const r of [null, repo(), repo({ acceptedHead: null })]) {
        for (const validations of [null, allPass(), [...allPass().slice(1), validation('git.diff_nonempty', 'failed')]]) {
          const v = csm({ version: cset(status), validations, review, repo: r });
          if (v.buttons.includes('accept')) {
            accepts++;
            assert.equal(status, 'candidate'); assert.equal(review, 'approve'); assert.ok(r && r.acceptedHead); assert.ok(validations === null || v.blocking.length === 0);
          }
        }
      }
    }
  }
  assert.ok(accepts > 0, 'Accept does appear when it should');
  const ok = csm({ version: cset('candidate'), validations: allPass(), review: 'approve', repo: repo() });
  assert.deepEqual(ok.buttons, ['accept', 'request_changes', 'reject'], 'after approving, Approve is gone and Accept is the next step (V9d)');
  const none = csm({ version: cset('candidate'), validations: allPass(), review: null, repo: repo() });
  assert.deepEqual(none.buttons, ['approve', 'request_changes', 'reject']);
  assert.equal(none.headline, 'Waiting for you: read what changed, then decide');
  assert.deepEqual(none.rail.map((x) => [x.n, x.label, x.state]), [[1, 'Looks good', 'current'], [2, 'Keep these changes', 'waiting'], [3, 'Add to my project', 'waiting']], 'the plain 3-step rail: Looks good, Keep these changes, Add to my project');
  assert.deepEqual(ok.rail.map((x) => x.state), ['done', 'current', 'waiting']);
  assert.equal(ok.headline, 'Looks good: done. Next: Keep these changes');
  // Approved but the branch head is unread: a sentence, not a button.
  const unread = csm({ version: cset('candidate'), validations: allPass(), review: 'approve', repo: repo({ acceptedHead: null }) });
  assert.ok(!unread.buttons.includes('accept') && unread.sentences.some((s) => /has not read its saved copy/.test(s)));
  // The newest review is the version's own `latestReview` (null: never reviewed; undefined: not read yet or not a change set).
  assert.equal(CS.reviewOf({ decision: 'approve', decidedAt: '2026-10-26T00:00:00.000Z' }), 'approve');
  assert.equal(CS.reviewOf(null), null);
  assert.equal(CS.reviewOf(undefined), undefined);
  assert.equal(CS.reviewOf({ decision: 'bogus' }), null, 'an unknown decision word is never an approval');
  const accepts2 = (latestReview) => csm({ version: cset('candidate'), validations: allPass(), review: CS.reviewOf(latestReview), repo: repo() }).buttons.includes('accept');
  assert.equal(accepts2({ decision: 'approve', decidedAt: 'x' }), true, 'Accept only on an approving latestReview');
  for (const lr of [null, undefined, { decision: 'request_changes', decidedAt: 'x' }, { decision: 'reject', decidedAt: 'x' }]) assert.equal(accepts2(lr), false, JSON.stringify(lr));
  // A version without latestReview (another kind, or not read yet) renders no review UI at all: no decision button, no Accept.
  const unknown = csm({ version: cset('candidate'), validations: allPass(), review: undefined, repo: repo() });
  assert.deepEqual(unknown.buttons, []);
  assert.deepEqual(unknown.sentences, []);
  // The activity-row derivation and its 50-row read are gone.
  assert.equal(CS.latestReviews, undefined);
  assert.doesNotMatch(src('data/useAgents.ts'), /useReviews|activityByProject/);
  const rvSrc = src('project/ChangeSetReview.tsx');
  assert.match(rvSrc, /reviewOf\(detail\.data\?\.latestReview\)/);
  assert.doesNotMatch(rvSrc, /useReviews|activityByProject/);
  // The Folio's generic version actions never make a change current by hand.
  const a = { status: 'active', ownerScope: 'participation', currentVersionId: null, kind: 'change_set' };
  assert.deepEqual(ART.actionsFor({ id: 'V1', status: 'candidate', producedByEngine: true, promotedAt: null }, a, true).map((x) => x.kind), ['discard']);
  assert.equal(ART.actionsFor({ id: 'V1', status: 'candidate', producedByEngine: true, promotedAt: null }, { ...a, kind: 'requirement' }, true).some((x) => x.kind === 'promote'), true);
});

// ---------- UA4 ----------

test('UA4 Merge appears only when accepted work is not on the branch, and is a sentence while tracked files are uncommitted', () => {
  assert.equal(CS.mergeModel(null), null);
  assert.equal(CS.mergeModel(repo({ acceptedNotMerged: 0, canFastForward: true, reason: null })), null);
  const ok = CS.mergeModel(repo({ acceptedNotMerged: 2, canFastForward: true, reason: null }));
  assert.equal(ok.line, '2 kept changes are not in your project yet.');
  assert.deepEqual(ok.button, { label: 'Add to my project', args: { branch: 'main', expectedAcceptedHead: SHA } });
  assert.equal(ok.sentence, null);
  const dirty = CS.mergeModel(repo({ acceptedNotMerged: 1, dirty: true, canFastForward: false, reason: 'tree_dirty' }));
  assert.equal(dirty.button, null);
  assert.match(dirty.sentence, /changes that are not saved in its history yet/);
  assert.match(dirty.sentence, /new files do not block/i);
  // Even if main said it could fast-forward, a dirty tree never gives the button.
  assert.equal(CS.mergeModel(repo({ acceptedNotMerged: 1, dirty: true, canFastForward: true, reason: null })).button, null);
  for (const reason of ['branch_mismatch', 'not_fast_forward', 'git_missing', 'runner_unavailable', 'weird_code']) {
    const m = CS.mergeModel(repo({ acceptedNotMerged: 1, canFastForward: false, reason }));
    assert.equal(m.button, null);
    assert.ok(m.sentence && m.sentence.length > 10 && !/_/.test(m.sentence), `${reason}: ${m.sentence}`);
  }
  assert.equal(CS.mergeModel(repo({ acceptedNotMerged: 1 })).line, '1 kept change is not in your project yet.');
  // The change view carries the merge only while there is something to merge.
  assert.equal(csm({ version: cset('active'), validations: allPass(), review: 'approve', repo: repo() }).merge, null);
  assert.ok(csm({ version: cset('active'), validations: allPass(), review: 'approve', repo: repo({ acceptedNotMerged: 1, canFastForward: true, reason: null }) }).merge.button);
  assert.equal(CS.mergedText({ branch: 'main', before: SHA, after: 'b'.repeat(40) }), 'Added to your project. Your project’s main version (“main”) now has the kept changes.');
  assert.doesNotMatch(CS.mergedText({ branch: 'main' }), /[0-9a-f]{8}/, 'no commit id in the text');
  assert.equal(CS.mergedTitle({ before: SHA, after: 'b'.repeat(40) }), 'Moved from saved version [aaaaaaaa] to the newest saved version [bbbbbbbb]', 'the ids are for a hover only');
});

// ---------- UA5, UA12 ----------

test('UA5 no percentage, and no cost without the "reported" or "estimated" label', () => {
  const usage = (o = {}) => ({ inputTokens: 1200, outputTokens: 300, cacheCreationTokens: 0, cacheReadTokens: 0, costUsdCents: 42, toolCalls: 7, estimated: false, ...o });
  const lines = [A.usageLine(usage()), A.usageLine(usage({ costUsdCents: null })), A.usageLine(usage({ estimated: true, costUsdCents: 200 })), A.usageLine(usage({ estimated: true, costUsdCents: null })),
    A.usageTodayLine({ usdCents: 120, turns: 2, estimated: false }), A.usageTodayLine({ usdCents: 200, turns: 1, estimated: true }), A.usageTodayLine({ usdCents: 0, turns: 0, estimated: false })];
  for (const t of lines) {
    assert.doesNotMatch(t, /%|percent/i, t);
    if (/\$/.test(t)) assert.match(t, /reported by the AI service|estimated/, t);
  }
  assert.equal(A.usageLine(null), null);
  assert.match(A.usageLine(usage()), /cost \$0\.42 \(reported by the AI service\)/);
  assert.match(A.usageLine(usage({ estimated: true })), /estimated/);
  assert.doesNotMatch(A.usageLine(usage({ estimated: true })), /reported by the AI service/);
  // The panel, the log and the setup rows say the same.
  const panel = A.agentPanelModel({ health: health({ agent: agentView({ usageToday: { usdCents: 150, turns: 3, estimated: true } }) }), availability: READY, sessions: [], sessionsFail: null });
  assert.match(panel.usageToday, /estimated/);
  const log = A.sessionLogModel({ ...session(), turnHistory: [{ jobId: 'J1', state: 'completed', headline: 'checks_passed', outcome: 'completed', error: null, usage: usage({ costUsdCents: 99 }), createdAt: NOW, startedAt: NOW, finishedAt: NOW }],
    messages: [], toolCalls: [], versions: [], approvals: [] });
  assert.match(log.turns[0].usage, /\(reported by the AI service\)/);
  for (const r of X.agentSetupRows(agentView({ usageToday: { usdCents: 99, turns: 1, estimated: false } }))) {
    const t = `${r.text} ${r.action ?? ''}`;
    assert.doesNotMatch(t, /%/);
    if (/cost \$/.test(t)) assert.match(t, /reported by the AI service|estimated/);
  }
});

test('UA12 a partial turn with no change reads "The AI helper made no changes", never done; no turn calls itself complete', () => {
  const noChange = job({ state: 'partial', outcome: 'no_change', headline: 'checks_could_not_run', startedAt: NOW, finishedAt: NOW });
  const v = R.jobRun(noChange);
  assert.equal(v.headline, 'The AI helper made no changes');
  assert.equal(v.word, 'No changes');
  assert.equal(R.agentTurnHeadline(noChange), 'The AI helper made no changes');
  assert.doesNotMatch(`${v.headline} ${v.word} ${v.title}`, /done|complete|finished|passed/i);
  // Only the recorded outcome `no_change` justifies that sentence: a partial turn with no or an unknown outcome says only that it ended in part.
  for (const outcome of [null, 'surprise', 'completed']) {
    const p = R.jobRun(job({ state: 'partial', outcome, headline: 'checks_could_not_run', startedAt: NOW }));
    assert.equal(p.headline, 'The AI helper stopped early. Nexus did not keep a record of what it changed', String(outcome));
    assert.equal(p.word, 'Stopped early');
  }
  // A turn has no sandbox / collecting / checking ladder: no stage of an agent.run job reads done (it has none at all).
  assert.deepEqual(v.stages, []);
  const NEVER = /\bcomplete(d)?\b|finished|end to end|\bdone\b/i;
  const states = ['queued', 'leased', 'running', 'awaiting_approval', 'retry_scheduled', 'completed', 'partial', 'failed', 'cancelled', 'timed_out', 'interrupted'];
  const outcomes = [null, 'completed', 'no_change', 'runtime_auth', 'limit', 'runtime_protocol', 'runtime_error', 'interrupted', 'surprise'];
  let n = 0;
  for (const state of states) for (const outcome of outcomes) for (const headline of ['queued', 'checks_failed', 'checks_passed', 'running', 'waiting_for_approval']) {
    const r = R.jobRun(job({ state, outcome, headline, startedAt: NOW, error: { code: 'x', message: 'raw runtime text' } }));
    assert.ok(r.stages.every((s) => s.state !== 'done'), `${state}/${outcome}: no stage reads done`);
    assert.deepEqual(r.stages, []);
    for (const t of [r.headline, r.word, r.title, ...r.stages.map((s) => s.label)]) { n++; assert.doesNotMatch(t, NEVER, `${state}/${outcome}: ${t}`); }
    assert.doesNotMatch(r.headline, /raw runtime text/, 'the runtime text is never shown');
    if (state === 'completed') assert.doesNotMatch(r.headline, /checks passed|checks could not run/);
  }
  assert.ok(n > 500);
  assert.equal(R.agentTurnHeadline(job({ state: 'completed', outcome: 'completed' })), 'The AI helper handed in its suggested changes');
  assert.equal(R.jobTitle(job()), 'Request to the AI helper');
  assert.equal(R.jobTitle({ kind: 'tool.run', actionId: null, recipeId: 'changeset.collect' }), 'Collect what the AI helper changed');
});

// ---------- UA6 ----------

test('UA6 what the AI helper wrote is labelled for reading only, and a step shows its plain description and whether it worked, never its arguments', () => {
  const d = { ...session(), turnHistory: [], versions: [{ versionId: 'V1', kind: 'change_set', status: 'candidate' }], approvals: [],
    messages: [{ seq: 1, ts: NOW, from: 'user', text: 'fix it', displayOnly: true }, { seq: 2, ts: NOW, from: 'agent', text: 'I fixed it. All checks are green.', displayOnly: true }],
    toolCalls: [{ seq: 3, ts: NOW, jobId: 'J1', tool: 'Read', ok: true, resultBytes: 2048 }, { seq: 4, ts: NOW, jobId: 'J1', tool: 'rm -rf / <script>', ok: false, resultBytes: null },
      { seq: 5, ts: NOW, jobId: 'J1', tool: 'Edit', ok: null, resultBytes: null }] };
  const v = A.sessionLogModel(d);
  assert.match(v.note, /for reading only/);
  assert.match(v.note, /not proof/);
  assert.equal(v.messages[1].author, 'AI helper (for reading only)');
  assert.equal(v.messages[0].author, 'You');
  assert.equal(v.toolCalls[0].tool, 'Reading a file');
  assert.equal(v.toolCalls[0].outcome, 'Worked');
  assert.equal(v.toolCalls[1].tool, 'A step', 'a name that is not a plain tool name is never shown');
  assert.equal(v.toolCalls[1].outcome, 'Did not work');
  assert.equal(v.toolCalls[2].tool, 'Writing a file');
  assert.equal(v.toolCalls[2].outcome, 'Result not recorded');
  for (const c of v.toolCalls) assert.equal('size' in c, false, 'no result size is shown: it means nothing to a person');
  assert.deepEqual(v.versions[0], { key: 'V1', versionId: 'V1', kind: ART.kindLabel('change_set'), status: ART.statusLabel('candidate') });
  const tsx = src('agent/SessionLog.tsx');
  assert.match(tsx, /view\.note/, 'the note is rendered');
  assert.match(tsx, /for reading only/i);
});

// ---------- UA7 ----------

test('UA7 every unmet prerequisite is a sentence, never a button that would be refused; missing permission reads exactly the brief sentence', () => {
  const panel = (h, availability = READY, extra = {}) => A.agentPanelModel({ health: h, availability, sessions: [], sessionsFail: null, ...extra });
  const noConsent = panel(health({ agent: agentView({ consent: { live: false, caps: null, hostsCount: 1, grantedAt: null } }) }));
  // Track D (first-run): with no runtime permission the panel points to the guide "Choose your AI helper" with one sentence (and
  // the panel's one button); it no longer says "network permission" first, and never leads with the state of a program that may not be wanted.
  assert.deepEqual(noConsent.blockers, [A.CHOOSE_RUNTIME_TEXT]);
  assert.equal(noConsent.chooseRuntime, true);
  assert.equal(noConsent.canAsk, false); assert.equal(noConsent.setup, true); assert.equal(noConsent.kind, 'setup');
  assert.equal(A.CONSENT_MISSING_TEXT, 'The AI helper needs your internet permission before it can work. Open “Get this computer ready” to allow it.', 'the sentence for a refused start is the plain-words one');
  assert.equal(A.CHOOSE_RUNTIME_BUTTON, 'Choose your AI helper');
  assert.doesNotMatch(A.CHOOSE_RUNTIME_TEXT, VENDOR);
  // Even a program that is not installed does not lead the panel while nothing is chosen: the guide speaks for it.
  const noProgram = panel(health({ agent: agentView({ state: 'not_installed', consent: { live: false, caps: null, hostsCount: 0, grantedAt: null } }) }));
  assert.deepEqual(noProgram.blockers, [A.CHOOSE_RUNTIME_TEXT]);
  assert.equal(panel(health()).chooseRuntime, false, 'a live permission: no guide');
  const cases = [
    [{ state: 'not_installed' }, /not installed/], [{ state: 'not_signed_in', signedIn: 'no' }, /not signed in/], [{ state: 'version_unsupported' }, /a version Nexus does not support/],
    [{ state: 'unavailable' }, /Nexus could not check the AI helper/]
    // (Never probed and no permission yet is the guide's case, above.)
  ];
  for (const [o, re] of cases) {
    const p = panel(health({ agent: agentView(o) }));
    assert.equal(p.canAsk, false, JSON.stringify(o));
    assert.match(p.blockers[0], re);
    assert.doesNotMatch(p.blockers.join(' '), /_/, 'no raw code');
    // A runtime that is not ready never also says "permission": it cannot be granted yet.
    assert.ok(!p.blockers.includes(A.CONSENT_MISSING_TEXT));
  }
  const budget = panel(health({ agent: agentView({ usageToday: { usdCents: 1000, turns: 5, estimated: false } }) }));
  assert.deepEqual(budget.blockers, ['The AI helper has used up its limit for today. Try again later.']);
  const docker = panel(health(), { kind: 'setup', problems: ['docker_stopped'], profiles: [], text: 'Jobs cannot run on this computer yet: Docker is not running. Open the setup to see what to do.' });
  assert.match(docker.blockers[0], /Docker is not running/);
  assert.equal(docker.canAsk, false);
  assert.equal(panel(null).canAsk, false);
  assert.match(panel(null).blockers.join(' '), /not been checked/);
  const ready = panel(health());
  assert.equal(ready.canAsk, true); assert.equal(ready.kind, 'ready'); assert.deepEqual(ready.blockers, []);
  // Agent work off: one sentence, nothing to set up.
  const off = A.agentPanelModel({ health: health(), availability: READY, sessions: null, sessionsFail: { code: 'platform_unavailable', reason: 'agents_unavailable', subReason: 'not_enabled' } });
  assert.equal(off.kind, 'off'); assert.equal(off.canAsk, false); assert.equal(off.setup, false);
  assert.match(off.lead, /^The AI helper is not available because/);
  // The panel's sessions: Working / Waiting for you, and a queued turn says what it waits for.
  const s = A.agentPanelModel({ health: health(), availability: READY, sessionsFail: null,
    sessions: [session({ id: 'S1', status: 'running', liveJobId: 'J1', updatedAt: 2 }), session({ id: 'S2', status: 'awaiting_approval', liveJobId: 'J2', updatedAt: 1 }), session({ id: 'S3', status: 'open', updatedAt: 3 })],
    jobs: new Map([['J1', job({ id: 'J1', state: 'running', headline: 'running' })], ['J2', job({ id: 'J2', state: 'running', headline: 'waiting_for_approval' })]]) });
  assert.equal(s.working, 'Working');
  assert.deepEqual(s.sessions.map((r) => [r.id, r.word]), [['S3', 'Ready for your next message'], ['S1', 'Working'], ['S2', 'Waiting for you']]);
  assert.deepEqual(s.sessions.map((r) => [r.canSend, r.canStop, r.canEnd]), [[true, false, true], [false, true, false], [false, true, false]]);
  const waiting = A.agentPanelModel({ health: health(), availability: READY, sessionsFail: null, sessions: [session({ status: 'running', liveJobId: 'J1' })],
    jobs: new Map([['J1', job({ state: 'queued', phase: 'waiting:consent' })]]) });
  assert.equal(waiting.sessions[0].word, 'Waiting');
  assert.equal(waiting.sessions[0].turn, 'Waiting for your internet permission');
  assert.equal(waiting.working, null);
  assert.equal(A.agentPanelModel({ health: health(), availability: READY, sessionsFail: null, sessions: [session({ status: 'awaiting_approval', liveJobId: 'J2' })] }).working, 'Waiting for you');
  // The setup row: the disclosure appears once, on the permission row, in every state.
  for (const a of [agentView(), agentView({ consent: { live: false, caps: null, hostsCount: 1, grantedAt: null } }), agentView({ state: 'not_installed', consent: { live: false, caps: null, hostsCount: 1, grantedAt: null } })]) {
    const rows = X.agentSetupRows(a, { hosts: ['api.example.test:443'] });
    const all = rows.map((r) => `${r.text} ${r.action ?? ''} ${r.more ?? ''}`).join('\n');
    assert.equal(all.split('runs on this computer as you').length - 1, 1, 'disclosed exactly once');
    assert.match(all, /keeps its own sign-in and settings in your user folder/);
    assert.match(all, /Nexus never reads, copies or stores your sign-in/);
    // Round 4 (final review C3): the AI program runs on the host as the user; its own network is steered by a proxy setting, not enforced.
    // The two short sentences are on the row; the honest limits sit behind its "More details".
    assert.match(all, /Your AI program runs on this computer as you/);
    assert.match(all, /Its online requests go through Nexus, which allows only the address you approve/);
    assert.match(all, /The address rule is a setting the program follows, not a firewall/);
    assert.match(all, /every command it runs goes into a safe space with no internet/);
    assert.match(all, /the program’s own rule, not a wall your computer enforces/);
    assert.equal(X.AGENT_STATE_DISCLOSURE.split('. ').length, 2, 'the visible disclosure is two short sentences');
    assert.doesNotMatch(all, /runs in a sandbox with no other network|and nothing else/, 'the old, untrue claims are gone');
  }
  const grant = X.agentSetupRows(agentView({ consent: { live: false, caps: null, hostsCount: 1, grantedAt: null } }), { hosts: ['api.example.test:443'] });
  assert.deepEqual(grant.find((r) => r.id === 'agent-consent').consent, { op: 'grant', label: 'Give permission' });
  // The user sees the destination before granting; without it there is no Grant button, only a sentence.
  const unknownHosts = X.agentSetupRows(agentView({ consent: { live: false, caps: null, hostsCount: 1, grantedAt: null } }));
  assert.equal(unknownHosts.find((r) => r.id === 'agent-consent').consent, undefined);
  assert.equal(X.agentSetupRows(agentView(), { hosts: ['api.example.test:443'] }).find((r) => r.id === 'agent-consent').consent.op, 'revoke');
  // The AI helper rows never hold back "Tasks can run on this computer."
  const rows = X.setupSheet(health({ agent: agentView({ state: 'not_installed' }) }));
  assert.equal(X.setupLead(READY, rows), 'Tasks can run on this computer.');
  assert.ok(rows.some((r) => r.id === 'agent' && r.state === 'problem'));
  // A HealthView without the agent row (an older answer) still gives the B2a rows.
  const bare = health(); delete bare.agent;
  assert.ok(!X.setupSheet(bare).some((r) => r.id.startsWith('agent')));
});

// ---------- UA8 ----------

test('UA8 the intent line sends to the agent only on an SDE project route with the agent ready; every other route keeps the legacy behaviour', () => {
  const r = (routeName, primaryWorkspaceId, canAsk) => A.intentRoute({ routeName, primaryWorkspaceId, canAsk });
  assert.equal(r('project', 'sde', true), 'agent');
  assert.equal(r('project', 'sde', false), 'legacy');
  assert.equal(r('project', 'qa', true), 'legacy');
  assert.equal(r('project', null, true), 'legacy');
  for (const name of ['workspace', 'projects', 'agents', 'artifacts', 'handoffs', 'launcher', 'start', 'welcome']) assert.equal(r(name, 'sde', true), 'legacy', name);
  const args = A.startArgs({ projectId: 'P', workspaceId: 'sde', sessionId: null, message: '  add a test  ', intentId: 'I1' });
  assert.deepEqual(args.args, { projectId: 'P', workspaceId: 'sde', sessionId: null, focusVersionIds: [], message: 'add a test', intentId: 'I1' });
  assert.match(A.startArgs({ projectId: 'P', workspaceId: 'sde', sessionId: null, message: '   ', intentId: 'I1' }).problem, /Write a message/);
  assert.equal(A.startArgs({ projectId: 'P', workspaceId: 'sde', sessionId: null, message: 'x'.repeat(8001), intentId: 'I1' }).problem, E.AGENT_REASON_TEXT.message_too_long);
  // Source pins: the intent line calls #42 only inside the agent branch, and keeps the legacy send for every other case.
  const il = src('intent/IntentLine.tsx');
  assert.match(il, /intentRoute\(/);
  assert.match(il, /port\.send\(/, 'the legacy send is still there');
  // #42 is called in one place (sendToAgent), which is reached from one place: the agent branch of the route rule.
  assert.equal((il.match(/nexusClient\.agentStart\(/g) || []).length, 1);
  assert.equal((il.match(/\bsendToAgent\b/g) || []).length, 2, 'its definition and one call');
  assert.match(il, /if \(mode === 'agent' && ctx\.project\) \{ void sendToAgent\(text, ctx\.project\.id\); return; \}/);
  assert.ok(il.indexOf('port.send(') > il.indexOf("if (mode === 'agent' && ctx.project)"), 'the legacy send is the fallthrough');
  // The line reads what the bench loaded (no health or sessions request of its own on other routes).
  assert.doesNotMatch(il, /useHealth\(|useSessions\(|platformHealth\(/);
  // The model never reads a path or host: the request is ids and the text.
  assert.deepEqual(Object.keys(args.args).sort(), ['focusVersionIds', 'intentId', 'message', 'projectId', 'sessionId', 'workspaceId']);
});

// ---------- UA9 ----------

test('UA9 a failing cs.tests_pass never reads "passed"; the headline names every blocking check', () => {
  const validations = [validation('git.diff_nonempty', 'passed'), validation('git.paths_in_scope', 'passed'), validation('sec.secret_scan', 'passed'),
    validation('cs.tests_pass', 'failed', { summary: '1 of 4 executed test(s) failed.' }), validation('git.applies_cleanly', 'error')];
  for (const status of ['draft', 'failed']) {
    const v = csm({ version: cset(status), validations, review: null, repo: repo() });
    assert.deepEqual(v.blocking.map((b) => b.id), ['cs.tests_pass', 'git.applies_cleanly']);
    assert.match(v.headline, /^Blocked: /);
    assert.match(v.headline, /^Blocked: 2 required checks need attention$/, 'the headline counts the required checks that need attention');
    assert.deepEqual(v.blocking.map((b) => b.label), ['Some of your tests failed', 'Nexus could not run this check: fit with your project'], 'each check is one plain line, never its id');
    assert.deepEqual(v.blocking.map((b) => b.word), ['Failed', 'Could not run']);
    assert.doesNotMatch(JSON.stringify(v), /passed/i, `${status}: nothing in the view reads passed`);
    assert.deepEqual(v.buttons, []);
  }
  // A candidate whose checks disagree (cannot happen in main) offers nothing and still never says passed.
  const odd = csm({ version: cset('candidate'), validations, review: 'approve', repo: repo() });
  assert.deepEqual(odd.buttons, []);
  assert.doesNotMatch(JSON.stringify(odd), /passed/i);
  // A check that has not run is named too.
  const pending = csm({ version: cset('draft'), validations: allPass().slice(0, 3), review: null, repo: repo() });
  assert.deepEqual(pending.blocking.map((b) => b.word), ['Not run yet', 'Not run yet']);
  assert.match(pending.headline, /^Being checked: 2 required checks are not finished yet$/);
  // The evidence page words the check as the change's own tests, Failed.
  const EV = loadTs('src/renderer/src/nexus/project/evidenceModel.ts');
  const ev = EV.evidenceView(validations, { status: 'draft' }, true, { kind: 'change_set' });
  const row = ev.rows.find((x) => x.validatorId === 'cs.tests_pass');
  assert.equal(row.word, 'Failed');
  assert.doesNotMatch(row.label, /pass/i);
  assert.equal(ev.headline, 'Checks failed');
  for (const id of BLOCKING) assert.doesNotMatch(EV.validatorLabel(id), /^Check |_/, `${id} has a plain label`);
  // The diff descriptor names the head the change records; no path or full hash.
  const d = csm({ version: cset('candidate'), validations: allPass(), review: null, repo: repo() }).diff;
  assert.deepEqual(d, { base: null, head: 'aaaaaaaa' });
  // The kinds come from hunk context (see R7); a plain patch reads as expected.
  const kinds = (t) => CS.classifyDiff(t).map((l) => l.kind);
  assert.deepEqual(kinds('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-gone\n+added'), ['meta', 'meta', 'meta', 'hunk', 'del', 'add']);
});

// ---------- carries ----------

test('carry: a consent revoke row reads revoked, a grant row reads given; an unknown op is neutral; auth.denied has a sentence', () => {
  const ctx = { names: new Map(), versionNos: new Map(), workspaceLabel: (x) => x, now: NOW };
  const row = (action, details, status = 'succeeded') => ({ seq: 1, ts: NOW, action, status, actorKind: 'user', onBehalfOfUser: false, entityType: 'x', entityId: null, projectId: 'p',
    workspaceId: null, artifactId: null, versionId: null, details });
  assert.ok(ACT.ACTIVITY_DETAIL_ALLOW.includes('op'));
  assert.match(ACT.activityText(row('agent.consent', { op: 'grant' }), ctx), /given internet permission/);
  assert.equal(ACT.activityText(row('agent.consent', { op: 'revoke' }), ctx), "The AI helper's internet permission was taken back");
  assert.equal(ACT.activityText(row('agent.consent', {}), ctx), "The AI helper's internet permission was changed");
  assert.equal(ACT.activityText(row('agent.consent', { op: 'sudo' }), ctx), "The AI helper's internet permission was changed");
  assert.ok(ACT.ACTIVITY_ACTIONS.includes('auth.denied'));
  for (const status of ['denied', 'failed', 'succeeded']) {
    const t = ACT.activityText(row('auth.denied', { reason: 'out_of_scope', requested: 'x' }, status), ctx);
    assert.equal(t, 'The AI helper asked for something its permission does not cover, so it was refused');
    assert.doesNotMatch(t, /auth\.denied|out_of_scope/);
  }
});

test('carry: a queued job says why it waits (the phase), the flow actions are never a job-start button, the client has the new methods', () => {
  for (const [phase, text] of [['waiting:consent', 'Waiting for your internet permission'], ['waiting:budget', 'Waiting: the AI helper has used its limit for today'], ['waiting:slots', 'Waiting for room to start'],
    ['waiting:runtime', 'Waiting for the AI helper to be checked on this computer'], ['waiting:approval', 'Waiting for your OK']]) {
    assert.equal(R.jobRun(job({ phase })).headline, text, phase);
    assert.equal(R.jobRun(job({ kind: 'tool.run', actionId: 'sde.tests.run', phase })).headline, text, `${phase} on a recipe job`);
  }
  assert.equal(R.jobRun(job({ kind: 'tool.run', phase: null })).headline, 'Waiting to start. It starts as soon as there is room');
  assert.equal(R.jobRun(job({ kind: 'tool.run', phase: 'waiting:mystery' })).headline, 'Waiting to start. It starts as soon as there is room');
  // An AVAILABLE flow action is never a button on the generic action bar (it would start a job); the generic bar skips it.
  const sde = DOMAINS.find((d) => d.id === 'sde');
  const flows = ['sde.agent.turn', 'sde.changeset.review', 'sde.changeset.accept', 'sde.repo.merge'];
  const answer = flows.map((id) => ({ actionId: id, label: id, available: true, reason: null, needsApproval: false, inputs: [], stepId: null }));
  for (const version of [null, { kind: 'change_set', status: 'candidate' }]) {
    const bar = AM.actionBar(answer, { workspaceId: sde.id, availability: READY, version });
    assert.deepEqual(bar.buttons.filter((b) => flows.includes(b.actionId)), []);
  }
  // The client: each new method calls its own preload method through the one wrapper.
  const calls = [];
  const cth = new Proxy({}, { get: (_t, k) => (...a) => { calls.push([k, a]); return Promise.resolve({ ok: true, data: null }); } });
  global.window = { cth };
  const C = loadTs('src/renderer/src/nexus/data/nexusClient.ts');
  return Promise.all([
    C.nexusClient.agentStart({ projectId: 'p' }), C.nexusClient.sessionsList({ projectId: 'p' }), C.nexusClient.sessionGet('S'), C.nexusClient.sessionEnd('S'), C.nexusClient.sessionCancel('S'),
    C.nexusClient.reviewDecide('V', { decision: 'approve' }, 'I'), C.nexusClient.changeSetAccept('V', SHA), C.nexusClient.repoStatus('p'),
    C.nexusClient.repoMergeAccepted('p', { branch: 'main', expectedAcceptedHead: SHA }), C.nexusClient.agentConsent({ op: 'get' })
  ]).then(() => {
    assert.deepEqual(calls.map((c) => c[0]), ['nexusAgentStart', 'nexusSessionsList', 'nexusSessionGet', 'nexusSessionEnd', 'nexusSessionCancel', 'nexusReviewDecide',
      'nexusChangeSetAccept', 'nexusRepoStatus', 'nexusRepoMergeAccepted', 'nexusAgentConsent']);
    delete global.window;
  });
});

test('source pins: the merge asks only the channel (the dialog is main\'s), Accept and the decisions go through withIntent or their own channel, nothing polls', () => {
  const rv = src('project/ChangeSetReview.tsx');
  assert.match(rv, /nexusClient\.repoMergeAccepted\(/);
  assert.match(rv, /nexusClient\.changeSetAccept\(/);
  assert.match(rv, /nexusClient\.reviewDecide\(/);
  assert.doesNotMatch(rv, /confirm\(|window\.confirm|showMessageBox/, 'the confirmation is main\'s native dialog, never a renderer one');
  assert.doesNotMatch(rv + src('agent/AgentPanel.tsx').replace(/setInterval\(\(\) => setNow\(Date\.now\(\)\), PROGRESS_TICK_MS\)/, '').replace(/setInterval\(\(\) => \{ useExecStore\.getState\(\)\.bump\(\['jobs'\]\); sessions\.reload\(\); \}, LIVE_REFRESH_MS\)/, '') + src('data/useAgents.ts').replace(/setInterval\(\(\) => read\(0\), CONSENT_REASK_MS\)/, ''), /setInterval/, 'no background polling (the one tick is a local clock for "working for 2 minutes" while a request is live: it asks main for nothing)');
  const hooks = src('data/useAgents.ts');
  assert.equal((hooks.match(/setInterval\(/g) || []).length, 1, 'only the open setup sheet re-asks');
  assert.match(hooks, /if \(!open\) return;/);
  // The setup sheet reads #51 when it opens and carries the grant and revoke buttons.
  const sheet = src('components/ExecutionSetupSheet.tsx');
  assert.match(sheet, /useAgentConsent\(/);
  assert.match(sheet, /consentHostsOf\(/);
  assert.match(sheet, /r\.consent/);
  // The panel sits in the bench, the change sets in the Changes tool above the uncommitted review, the viewer in the Folio.
  assert.match(src('project/ProjectBench.tsx'), /<AgentPanel /);
  assert.match(src('review/ReviewSurface.tsx'), /<ChangeSets /);
  assert.match(src('project/kindViewers.tsx'), /case 'change_set'/);
});

// ---------- fix round 1 ----------

test('F1 the intent line says the legacy reply hint only in legacy mode; in agent mode each send starts a new conversation (UA8 pin)', () => {
  const il = src('intent/IntentLine.tsx');
  const lead = { state: 'ready', deliveryPaused: false };
  const agentWords = A.intentWords({ mode: 'agent', lead, onSoftwareProject: false, note: null, replyHint: 'Its reply shows up in Agents.' });
  const legacyWords = A.intentWords({ mode: 'legacy', lead, onSoftwareProject: false, note: null, replyHint: 'Its reply shows up in Agents.' });
  assert.doesNotMatch(agentWords.explain, /Its reply shows up in Agents/, 'the lead AI helper reply hint is said only in the lead AI helper mode');
  assert.match(legacyWords.explain, /Its reply shows up in Agents\./);
  assert.match(agentWords.explain, /open conversation|AI helper panel/);
  assert.equal((il.match(/port\.replyHint/g) || []).length, 1, 'the lead AI helper reply hint is handed to the words once, and only the lead mode says it');
});

test('F2 the change view is keyed by version (no asking, comment, note or busy state leaks across versions); ActionArtifact.kind is required', () => {
  assert.match(src('project/kindViewers.tsx'), /<ChangeSetReview key=\{version\.id\}/);
  assert.match(src('project/ArtifactPassport.tsx'), /<KindViewer key=\{shownVersion\.id\}/);
  assert.match(src('project/artifactModel.ts'), /type ActionArtifact = Pick<ArtifactView, 'status' \| 'ownerScope' \| 'currentVersionId' \| 'kind'>;/);
  // The Changes tool reads the repository status only once a change exists: the hook lives in the list, below the early return.
  const rv = src('project/ChangeSetReview.tsx');
  const top = rv.slice(rv.indexOf('export function ChangeSets()'), rv.indexOf('function ChangeSetList'));
  assert.doesNotMatch(top, /useRepoStatus\(/);
  assert.match(top, /rows\.length === 0\) return null/);
  assert.match(rv.slice(rv.indexOf('function ChangeSetList')), /useRepoStatus\(projectId\)/);
});

test('F3 #51 get never waits: an answer with no destination yet is asked again (bounded), a settled one is not; the sheet reads #51 after the health re-read', () => {
  const view = (o = {}, c = {}) => ({ ...agentView(), state: 'unknown', consent: { live: false, caps: null, hostsCount: 0, grantedAt: null, hosts: [], ...c }, ...o });
  // First open with a stale cache: no destination, state unknown -> look again soon, then later, then stop.
  assert.equal(X.consentRereadDelay(view(), 0), 1500);
  assert.equal(X.consentRereadDelay(view(), 1), 3000);
  assert.equal(X.consentRereadDelay(view(), X.CONSENT_REREAD_LIMIT), null, 'bounded');
  assert.equal(X.consentRereadDelay(view({ state: 'ready' }), 0), 1500, 'ready but no destination yet');
  // Once the probe landed (ready, with the destination) the Grant button can show and nothing is asked again.
  const landed = view({ state: 'ready' }, { hosts: ['api.example.test:443'], hostsCount: 1 });
  assert.equal(X.consentRereadDelay(landed, 0), null);
  assert.deepEqual(X.consentHostsOf(landed), ['api.example.test:443']);
  assert.deepEqual(X.agentSetupRows(landed, { hosts: X.consentHostsOf(landed) }).find((r) => r.id === 'agent-consent').consent, { op: 'grant', label: 'Give permission' });
  assert.equal(X.agentSetupRows(view({ state: 'ready' })).find((r) => r.id === 'agent-consent').consent, undefined, 'before the destination is known there is no Grant');
  // Settled "cannot be granted" and a live permission are not asked again.
  for (const state of ['not_installed', 'not_signed_in', 'version_unsupported']) assert.equal(X.consentRereadDelay(view({ state }), 0), null, state);
  assert.equal(X.consentRereadDelay(view({ state: 'ready' }, { live: true }), 0), null);
  assert.equal(X.consentRereadDelay(null, 0), null);
  // Not granted: the D-B4 ceilings are shown on the row before the user grants.
  const consentRow = X.agentSetupRows(landed, { hosts: X.consentHostsOf(landed) }).find((r) => r.id === 'agent-consent');
  assert.match(consentRow.text, /Limits: up to \$2\.00 per request, \$10\.00 per day\./, 'the two limits that matter, in plain words');
  assert.doesNotMatch(consentRow.text, /token|tool call|child job|turns an hour/, 'no engineering words on the row itself');
  assert.match(consentRow.more, /Other limits: 6 requests an hour and 1 at a time\. Each request is also limited to about 400k tokens \(a way of counting text\), 200 uses of tools, 30 minutes and 20 extra tasks\./, 'all eight D-B4 caps, in plain words behind More details');
  // Source pins: the hook looks again by that policy; the sheet takes only the destinations from #51 and reads it after the health re-read.
  const hooks = src('data/useAgents.ts');
  assert.match(hooks, /consentRereadDelay\(r\.data, tries\)/);
  assert.match(hooks, /view: AgentConsentView \| null/);
  const sheet = src('components/ExecutionSetupSheet.tsx');
  assert.match(sheet, /consent\.reloadAfter\(CHECK_AGAIN_REREAD_MS \+ 500\)/);
  assert.doesNotMatch(sheet, /agent: consent\.view/, 'the health row is not replaced by the #51 answer');
  assert.match(sheet, /hosts: consentHostsOf\(consent\.view\)/);
  assert.match(src('data/nexusClient.ts'), /agentConsent: \(args: AgentConsentArgs\): Promise<NexusResult<AgentConsentView>>/);
});

test('F4 a SessionLog heading sits one level under the panel heading', () => {
  const log = src('agent/SessionLog.tsx');
  assert.doesNotMatch(log, /<h4/);
  assert.match(log, /<h3 /);
});

test('F5 a no-change turn that main headlines `checks_could_not_run` reads "The AI helper made no changes" in the run row, the log and the runs list', () => {
  const t = job({ state: 'partial', outcome: 'no_change', headline: 'checks_could_not_run', startedAt: NOW, finishedAt: NOW });
  const run = R.jobRun(t, { reason: 'No tests were executed.' });
  assert.equal(run.headline, 'The AI helper made no changes');
  assert.doesNotMatch(`${run.headline} ${run.word}`, /checks|could not run/i);
  // The conversation log words the same turn from its state and outcome, never from the headline.
  const log = A.sessionLogModel({ ...session(), turnHistory: [{ jobId: 'J1', state: 'partial', headline: 'checks_could_not_run', outcome: 'no_change', error: null, usage: null, createdAt: NOW, startedAt: NOW, finishedAt: NOW }],
    messages: [], toolCalls: [], versions: [], approvals: [] });
  assert.equal(log.turns[0].headline, 'The AI helper made no changes');
  // The runs list does not even read a check reason for an agent turn.
  assert.match(src('runs/ProjectRuns.tsx'), /explain && job\.kind !== 'agent\.run' && \(job\.headline === 'checks_failed'/);
});

// ---------- fix round 4 (final honesty review) ----------

test('R4-C1 a session main keeps `running` with no live turn reads "Ready for your next message" and is continued, never "Working" forever', () => {
  const panel = (sessions, jobs) => A.agentPanelModel({ health: health(), availability: READY, sessions, sessionsFail: null, jobs });
  const idle = panel([session({ id: 'S1', status: 'running', liveJobId: null })]);
  assert.equal(idle.working, null, 'no live turn: not working');
  assert.deepEqual(idle.sessions.map((r) => [r.word, r.live, r.canSend, r.canEnd, r.canStop]), [['Ready for your next message', false, true, true, false]]);
  // With a live turn it is working; Stop is offered, Send and End are not.
  const live = panel([session({ id: 'S1', status: 'running', liveJobId: 'J1' })], new Map([['J1', job({ state: 'running', headline: 'running' })]]));
  assert.equal(live.working, 'Working');
  assert.deepEqual(live.sessions.map((r) => [r.word, r.live, r.canSend, r.canEnd, r.canStop]), [['Working', true, false, false, true]]);
  // Several finished conversations never pile up as "Working".
  const many = panel([session({ id: 'A', status: 'running', liveJobId: null, updatedAt: 3 }), session({ id: 'B', status: 'running', liveJobId: null, updatedAt: 2 }), session({ id: 'C', status: 'open', updatedAt: 1 })]);
  assert.equal(many.working, null);
  assert.ok(many.sessions.every((r) => r.word === 'Ready for your next message'));
  // The intent line continues the newest such conversation instead of starting another.
  assert.equal(A.continuableSession([session({ id: 'A', status: 'running', liveJobId: null, updatedAt: 3 }), session({ id: 'B', status: 'open', updatedAt: 5 })]).id, 'B');
  assert.equal(A.continuableSession([session({ id: 'A', status: 'running', liveJobId: 'J1' }), session({ id: 'Z', status: 'completed' })]), null, 'a live turn or an ended one is not continued');
  assert.equal(A.continuableSession(null), null);
  assert.match(src('intent/IntentLine.tsx'), /continuableSession\(list\.data\)/);
  assert.match(src('intent/IntentLine.tsx'), /nexusClient\.sessionsList\(\{ projectId \}\)/);
  // The panel opens itself only for a live turn.
  assert.match(src('agent/AgentPanel.tsx'), /if \(panel\.working \|\| repoWaiting\.length > 0\) setOpen\(true\)/);
});

test('R4-I1 the program is "signed in" only when the view says so; an unreadable sign-in is said so', () => {
  for (const signedIn of ['unknown', 'no']) {
    const r = X.agentSetupRows(agentView({ signedIn })).find((x) => x.id === 'agent');
    assert.match(r.text, /Nexus could not confirm that you are signed in\./, signedIn);
    assert.doesNotMatch(r.text, /installed and signed in/);
    assert.notEqual(r.state, 'ok');
  }
  assert.match(X.agentSetupRows(agentView({ signedIn: 'yes' })).find((x) => x.id === 'agent').text, /installed and signed in/);
  assert.match(X.agentSetupRows(agentView({ signedIn: 'yes' })).find((x) => x.id === 'agent').text, /^Your AI program is installed and signed in/);
  const p = A.agentPanelModel({ health: health({ agent: agentView({ signedIn: 'unknown' }) }), availability: READY, sessions: [], sessionsFail: null });
  assert.equal(p.note, 'Nexus could not confirm that the program for your own plan is signed in.');
});

test('R4-I2 agent work off is its own state: one sentence, no check-again advice, no Grant row; flow actions use the same sentence', () => {
  const off = agentView({ state: 'off', label: null, version: null, consent: { live: false, caps: null, hostsCount: 0, grantedAt: null } });
  const rows = X.setupSheet(health({ agent: off }));
  const agentRows = rows.filter((r) => r.id.startsWith('agent'));
  assert.deepEqual(agentRows.map((r) => r.id), ['agent']);
  assert.equal(agentRows[0].text, E.AGENT_OFF_TEXT);
  assert.equal(E.AGENT_OFF_TEXT, 'The AI helper is not available because it is not turned on in this version of the app.');
  assert.equal(agentRows[0].word, 'Not available');
  assert.equal(agentRows[0].consent, undefined);
  assert.doesNotMatch(`${agentRows[0].text} ${agentRows[0].action ?? ''}`, /check again|Check again|Not granted/);
  const p = A.agentPanelModel({ health: health({ agent: off }), availability: READY, sessions: null, sessionsFail: null });
  assert.deepEqual([p.kind, p.canAsk, p.setup, p.lead], ['off', false, false, E.AGENT_OFF_TEXT]);
  const flow = AM.reasonSentence({ label: 'Ask the agent', reason: 'agents_unavailable' }, 'sde');
  assert.equal(flow, `Ask the agent: ${E.AGENT_ACTION_OFF_TEXT}`);
  assert.equal(AM.reasonSentence({ label: 'X', reason: 'weird' }, 'sde'), 'X: not available right now.');
  // main's #23 says `off` when the agents part is not in place.
  assert.match(fs.readFileSync(path.join(ROOT, 'src/main/nexusIpc/agentSetup.ts'), 'utf8'), /state: 'off'/);
  assert.match(fs.readFileSync(path.join(ROOT, 'src/shared/nexus/ipc.ts'), 'utf8'), /'unavailable' \| 'unknown' \| 'off';/);
});

test('R4-I3 a stale check with a live permission is askable (the send checks again); it never blocks the panel or silently falls back to the lead agent', () => {
  const stale = health({ agent: agentView({ state: 'unknown', signedIn: 'unknown', label: null, version: null }) });
  const p = A.agentPanelModel({ health: stale, availability: READY, sessions: [], sessionsFail: null });
  assert.equal(p.canAsk, true);
  assert.equal(p.kind, 'ready');
  assert.equal(p.note, 'Nexus will check the AI helper again when you send.');
  assert.deepEqual(p.blockers, []);
  assert.doesNotMatch(JSON.stringify(p), /has not been checked/);
  assert.equal(A.intentRoute({ routeName: 'project', primaryWorkspaceId: 'sde', canAsk: p.canAsk }), 'agent', 'the intent line sends to the agent');
  // Without a live permission the unknown check still blocks (nothing can be granted before the program is known).
  const none = A.agentPanelModel({ health: health({ agent: agentView({ state: 'unknown', consent: { live: false, caps: null, hostsCount: 0, grantedAt: null } }) }), availability: READY, sessions: [], sessionsFail: null });
  assert.equal(none.canAsk, false);
  // A program known to be missing is never askable, whatever the permission.
  assert.equal(A.agentPanelModel({ health: health({ agent: agentView({ state: 'not_installed' }) }), availability: READY, sessions: [], sessionsFail: null }).canAsk, false);
});

test('R4-I4 failed-turn outcomes each read their own sentence', () => {
  const f = (outcome) => R.jobRun(job({ state: 'failed', outcome, headline: 'failed', error: { code: outcome, message: 'raw runtime text' } })).headline;
  assert.equal(f('worktree_guard'), 'The AI helper tried to change something outside its safe copy, so it was stopped. Nothing was kept');
  assert.equal(f('consent_mismatch'), E.AGENT_REASON_TEXT.consent_mismatch.replace(/\.$/, ''));
  assert.match(f('consent_mismatch'), /Take it back and allow it again in “Get this computer ready”/);
  assert.equal(f('proxy_failed'), 'The AI helper’s link to the internet could not start');
  assert.equal(f('runtime_unknown'), E.AGENT_REASON_TEXT.runtime_unknown.replace(/\.$/, ''));
  assert.equal(f('some_new_word'), 'The request did not work');
  for (const o of ['worktree_guard', 'consent_mismatch', 'proxy_failed']) assert.doesNotMatch(f(o), /_|raw runtime text/);
});

test('R4-I5 the intent chip makes no promise the code does not keep in agent mode', () => {
  const il = src('intent/IntentLine.tsx');
  assert.match(il, /title=\{words\.chipTitle\(chip\)\}/);
  const w = (mode) => A.intentWords({ mode, lead: { state: 'ready', deliveryPaused: false }, onSoftwareProject: false });
  assert.equal(w('agent').chipTitle('Fix login'), 'You are looking at: Fix login. The AI helper is told your message and which project this is, not this selection.');
  assert.equal(w('legacy').chipTitle('Fix login'), 'Sent with context: Fix login');
  const built = A.startArgs({ projectId: 'P', workspaceId: 'sde', sessionId: null, message: 'x', intentId: 'I' });
  assert.deepEqual(built.args.focusVersionIds, [], 'agent mode sends no focus, so it never says "sent with context"');
});

test('R4-minors copy and hygiene: merge copy, no raw ids, hashed intent keys, plain tool labels, refusal next steps, repo.write_refs', () => {
  const rv = src('project/ChangeSetReview.tsx');
  assert.match(rv, /Your project’s main version and its files change only if you confirm\. New files you have not saved, and your other versions, are not touched\./);
  assert.match(rv, /Nothing here touches your files until you press “Add to my project”\./);
  assert.doesNotMatch(rv, /Nothing here has touched your files|nothing else in your folder changes/);
  assert.doesNotMatch(rv, /Head of the change: <span/, 'no raw sha as visible text');
  assert.equal(CS.headLine('aaaaaaaa'), 'Newest saved version of these changes: [aaaaaaaa]', 'a saved version with its short id in brackets, no commit word');
  assert.equal(CS.headTitle('aaaaaaaa'), "A saved point in your project's history.");
  assert.equal(CS.headLine(null), null);
  assert.equal(CS.changeSetRows([{ artifact: { id: 'a', kind: 'change_set', status: 'active', name: 'n', createdAt: 1 }, latest: { id: 'v', versionNo: 1, status: 'candidate' }, current: null }])[0].word, 'Ready for review');
  // The merge dialog's sentence (main).
  assert.match(fs.readFileSync(path.join(ROOT, 'src/main/nexusExec/mergeDialog.ts'), 'utf8'), /The files in your project will change to match the kept changes\. New files you have not saved, and your other versions, are not touched\./);
  // Intent keys: a hash of the message, not its first characters.
  assert.equal(A.messageKey('hello world'), A.messageKey('hello world'));
  assert.notEqual(A.messageKey('hello world'), A.messageKey('hello worle'));
  assert.doesNotMatch(A.messageKey('my secret message'), /secret|message/);
  assert.doesNotMatch(src('agent/AgentPanel.tsx') + src('intent/IntentLine.tsx'), /message\.slice\(0, 64\)|text\.slice\(0, 64\)/);
  // Tool ids in plain words.
  assert.equal(A.toolLabel('mcp__nexus__changeset_register'), 'Saving the suggested changes');
  assert.equal(A.toolLabel('sandbox_exec'), 'Running a command in the safe space');
  assert.equal(A.toolLabel('review_request'), 'Sending the suggested changes for review');
  assert.equal(A.toolLabel('write_file'), 'Writing a file');
  assert.equal(A.toolLabel('mcp__other__weird_tool'), 'A step');
  assert.equal(A.toolLabel('Read'), 'Reading a file');
  assert.doesNotMatch(src('agent/SessionLog.tsx'), /className="nx-id">\{c\.tool\}/);
  // Refusals with a next step each.
  for (const k of ['not_fast_forward', 'integration_unexpected', 'merge_conflict', 'branch_mismatch']) {
    assert.ok(A.NEXT_STEP[k] && A.NEXT_STEP[k].length > 20, k);
    assert.ok(A.agentFailText({ code: 'conflict', reason: k }).endsWith(A.NEXT_STEP[k]), k);
  }
  // "Look again in a moment" only when the status simply was not read; a git or runner problem says its own sentence.
  const unread = (reason) => csm({ version: cset('candidate'), validations: allPass(), review: 'approve', repo: repo({ acceptedHead: null, reason }) }).sentences.join(' ');
  assert.equal(unread('git_missing'), E.AGENT_REASON_TEXT.git_missing);
  assert.equal(unread('branch_unknown'), E.AGENT_REASON_TEXT.branch_unknown);
  assert.match(unread(null), /Look again in a moment/);
  // The secret scan is not over-claimed; the caps row lists all eight.
  const EV = loadTs('src/renderer/src/nexus/project/evidenceModel.ts');
  assert.doesNotMatch(EV.validatorLabel('sec.secret_scan'), /holds no key or secret/);
  assert.match(EV.validatorLabel('sec.secret_scan'), /common kinds of secret keys/, 'the scan is named for what it looks for: common kinds only');
  assert.equal(EV.validatorLine('sec.secret_scan', 'passed'), 'No common secret keys found');
  const liveRow = X.agentSetupRows(agentView(), { hosts: ['api.example.test:443'] }).find((r) => r.id === 'agent-consent');
  const live = `${liveRow.text} ${liveRow.more ?? ''}`;
  assert.match(live, /about 400k tokens \(a way of counting text\), 200 uses of tools, 30 minutes and 20 extra tasks/);
  assert.doesNotMatch(live, /and nothing else/);
  // The once-per-project approval and its activity row.
  const row = AM.approvalRow({ id: 'a', projectId: 'p', jobId: null, reason: 'repo.write_refs', summary: 's', status: 'pending', request: {}, requestedAt: NOW, expiresAt: NOW + 60000, decidedAt: null, decision: null, consumedAt: null, imageBuild: null }, NOW);
  assert.equal(row.title, 'Let Nexus keep hidden Nexus notes in your project');
  const ctx = { names: new Map(), versionNos: new Map(), workspaceLabel: (x) => x, now: NOW };
  const act = (action, details) => ACT.activityText({ seq: 1, ts: NOW, action, status: 'succeeded', actorKind: 'user', onBehalfOfUser: false, entityType: 'x', entityId: null, projectId: 'p', workspaceId: null, artifactId: null, versionId: null, details }, ctx);
  assert.equal(act('approval.request', { reason: 'repo.write_refs' }), 'Asked for your OK: keep hidden Nexus notes in your project');
  assert.equal(act('approval.respond', { reason: 'repo.write_refs', decision: 'once' }), 'Allowed once: Nexus may keep hidden Nexus notes in your project');
  // A failed read of the conversations (not "agent work is off") is a sentence; the toggles say whether they are expanded.
  const failed = A.agentPanelModel({ health: health(), availability: READY, sessions: null, sessionsFail: { code: 'internal' } });
  assert.match(failed.readError, /could not be completed/);
  const panelSrc = src('agent/AgentPanel.tsx') + src('project/ChangeSetReview.tsx');
  assert.ok((panelSrc.match(/ariaExpanded=/g) || []).length >= 3);
  assert.match(src('project/ChangeSetReview.tsx'), /commentBox\.current\?\.focus\(\)/);
});

// ---------- fix round 5: an approval needs the whole change shown (preview_incomplete) ----------

test('R5 Approve is offered only when previewComplete === true (fail closed); Reject and Request changes stay; one fixed sentence says why, never a raw code', () => {
  const view = (previewComplete, previewReason, o = {}) => csm({ version: { ...cset('candidate'), previewComplete, previewReason }, validations: allPass(), review: null, repo: repo(), ...o });
  // Complete: the three decisions.
  const ok = view(true, null);
  assert.deepEqual(ok.buttons, ['approve', 'request_changes', 'reject']);
  assert.ok(!ok.sentences.some((s) => /cannot say “Looks good”/.test(s)));
  // Not complete, absent, wrong type or an unfamiliar reason: no Approve; the others stay.
  const cases = [[false, 'hidden_lines'], [false, 'too_large'], [false, 'truncated'], [false, 'unknown'], [false, null], [undefined, undefined], [null, null], ['true', null], [1, null],
    [false, 'brand_new_reason'], [undefined, 'hidden_lines'], [false, 7]];
  for (const [pc, reason] of cases) {
    const v = view(pc, reason);
    assert.ok(!v.buttons.includes('approve'), `${pc}/${reason}: no Approve`);
    assert.deepEqual(v.buttons, ['request_changes', 'reject'], `${pc}/${reason}: Reject and Request changes stay`);
    assert.ok(!v.buttons.includes('accept'));
    const said = v.sentences.filter((s) => /cannot say “Looks good”/.test(s));
    assert.equal(said.length, 1, `${pc}/${reason}: exactly one sentence`);
    assert.doesNotMatch(v.sentences.join(' '), /hidden_lines|too_large|truncated|brand_new_reason|preview_incomplete|_/, 'no raw code');
  }
  // One sentence per reason, an unfamiliar one reads as unknown.
  assert.match(view(false, 'hidden_lines').sentences[0], /^Part of these changes is hidden because it looks like a secret key or password/);
  assert.match(view(false, 'too_large').sentences[0], /^These changes are too big to show here, so you cannot say “Looks good” here/);
  assert.match(view(false, 'truncated').sentences[0], /^Only the first part of these changes can be shown/);
  assert.match(view(false, 'unknown').sentences[0], /^Nexus could not confirm that all of these changes can be shown here/);
  // Every reason says what is wrong, why Looks good is missing, and what to do next (a button that exists).
  for (const r of ['hidden_lines', 'too_large', 'truncated', 'unsafe_characters', 'binary_file', 'unknown']) assert.match(view(false, r).sentences[0], /Press “Ask for different changes”/, r);
  assert.equal(CS.BUTTON_LABEL.request_changes, 'Ask for different changes', 'the sentences name a button that is there');
  assert.equal(view(false, 'brand_new_reason').sentences[0], view(false, 'unknown').sentences[0]);
  assert.equal(new Set(['hidden_lines', 'too_large', 'truncated', 'unknown'].map((r) => view(false, r).sentences[0])).size, 4);
  // The other conditions still apply on top: Accept needs an approving review and a known branch head; a draft or failed change offers nothing.
  assert.ok(csm({ version: { ...cset('candidate'), previewComplete: true }, validations: allPass(), review: 'approve', repo: repo() }).buttons.includes('accept'));
  assert.deepEqual(csm({ version: { ...cset('draft'), previewComplete: true }, validations: allPass(), review: null, repo: repo() }).buttons, []);
  assert.deepEqual(csm({ version: { ...cset('candidate'), previewComplete: true }, validations: allPass(), review: undefined, repo: repo() }).buttons, [], 'review state unknown: no review UI');
  // Main's refusal of an approval reads its own sentence, never the code.
  assert.equal(A.agentFailText({ code: 'conflict', reason: 'preview_incomplete' }), E.AGENT_REASON_TEXT.preview_incomplete);
  assert.doesNotMatch(E.AGENT_REASON_TEXT.preview_incomplete, /preview_incomplete/);
  // The view feeds the model from the version's own fields.
  assert.match(src('project/ChangeSetReview.tsx'), /previewComplete: detail\.data\?\.previewComplete, previewReason: detail\.data\?\.previewReason/);
  // The diff panel says when the shown diff has redacted parts.
  assert.equal(CS.diffHasRedaction('+const k = "[redacted]"\n'), true);
  assert.equal(CS.diffHasRedaction('+const k = 1\n'), false);
  assert.equal(CS.diffHasRedaction(null), false);
  assert.match(CS.DIFF_REDACTED_NOTE, /\[redacted\]/);
  assert.match(src('project/ChangeSetReview.tsx'), /diffHasRedaction\(d\.text\) && /);
  // No vendor, host or code in the new copy (UA2 and UA11 also scan changeSetModel.ts and ChangeSetReview.tsx line by line).
  for (const t of Object.values(CS.PREVIEW_INCOMPLETE_TEXT)) assert.doesNotMatch(t, VENDOR);
});

// ---------- fix round 6 ----------

test('R6 binary_file: no Approve, its own fixed sentence; Request changes and Reject stay; hidden_lines does not say the agent added a secret', () => {
  const v = csm({ version: { ...cset('candidate'), previewComplete: false, previewReason: 'binary_file' }, validations: allPass(), review: null, repo: repo() });
  assert.ok(!v.buttons.includes('approve') && !v.buttons.includes('accept'));
  assert.deepEqual(v.buttons, ['request_changes', 'reject']);
  assert.equal(v.sentences.length, 1);
  assert.equal(v.sentences[0], 'One file in these changes is not text (for example a picture), so it cannot be shown here and you cannot say “Looks good” here. Press “Ask for different changes” and ask the AI helper to leave that file out.');
  assert.doesNotMatch(v.sentences[0], /binary_file|_/);
  // Five distinct sentences for the five closed reasons; the old claim is not made.
  const said = ['hidden_lines', 'too_large', 'truncated', 'binary_file', 'unknown'].map((r) => CS.previewIncompleteText(r));
  assert.equal(new Set(said).size, 5);
  assert.doesNotMatch(CS.previewIncompleteText('hidden_lines'), /added|wrote|contains a secret/i);
  assert.match(CS.previewIncompleteText('hidden_lines'), /^Part of these changes is hidden because it looks like a secret key or password/);
  // Still fail closed for anything but an explicit true.
  assert.ok(!csm({ version: { ...cset('candidate'), previewComplete: undefined, previewReason: 'binary_file' }, validations: allPass(), review: null, repo: repo() }).buttons.includes('approve'));
  assert.match(fs.readFileSync(path.join(ROOT, 'src/shared/nexus/ipc.ts'), 'utf8'), /'hidden_lines' \| 'too_large' \| 'truncated' \| 'binary_file'[^;]*'unknown' \| null/);
});

test('R6 agent work off says what is true: build, database, held or execution; an older answer reads as the build', () => {
  const off = (offReason) => agentView({ state: 'off', offReason, label: null, version: null, consent: { live: false, caps: null, hostsCount: 0, grantedAt: null } });
  const text = (offReason, h = {}) => X.setupSheet(health({ agent: off(offReason), ...h })).find((r) => r.id === 'agent').text;
  assert.equal(text('build'), 'The AI helper is not available because it is not turned on in this version of the app.');
  assert.equal(text(undefined), 'The AI helper is not available because it is not turned on in this version of the app.');
  assert.equal(text('database'), "The AI helper needs an update to Nexus's saved information, and that update has not been applied on this computer yet.");
  assert.equal(text('held'), 'The AI helper is paused on this computer because an update it needs is on hold.');
  assert.equal(text('execution'), 'The AI helper needs to run tasks, and that is not available right now.');
  assert.equal(text('execution', { db: { version: 9, platform: true, handoffs: true, execution: false, subReason: 'held' } }), E.agentsNotice('held'));
  assert.equal(new Set(['build', 'database', 'held', 'execution'].map((r) => text(r))).size, 4);
  for (const r of ['build', 'database', 'held', 'execution']) assert.doesNotMatch(text(r), /check again|Check again|_/i);
  // The panel's lead says the same; the off state is never askable.
  for (const r of ['database', 'held']) {
    const p = A.agentPanelModel({ health: health({ agent: off(r) }), availability: READY, sessions: null, sessionsFail: null });
    assert.deepEqual([p.kind, p.canAsk, p.lead], ['off', false, text(r)]);
  }
  // main: the view carries the reason, mapped from its own vocabulary; #23 passes it.
  const AS = loadTs('src/main/nexusIpc/agentSetup.ts');
  for (const [reason, word] of [['not_enabled', 'build'], [null, 'build'], ['held', 'held'], ['auto_held', 'held'], ['backup_failed', 'held'], ['failed', 'database'], ['shape', 'database'],
    ['v8_unavailable', 'execution'], ['registry_invalid', 'execution'], ['not_started', 'execution']]) assert.equal(AS.offReasonOf(reason), word, String(reason));
  assert.match(fs.readFileSync(path.join(ROOT, 'src/main/nexusIpc/registerNexusIpc.ts'), 'utf8'), /agentSetupView\(nx, agentsOff\(nx\)\)/);
  assert.match(fs.readFileSync(path.join(ROOT, 'src/shared/nexus/ipc.ts'), 'utf8'), /offReason\?: 'build' \| 'database' \| 'held' \| 'execution' \| null;/);
});

// ---------- fix round 7 ----------

test('R7-1 diff lines are classified by hunk context: an added line that looks like a header is an added line; headers only outside a hunk', () => {
  const kinds = (t) => CS.classifyDiff(t).map((l) => [l.kind, l.text]);
  const patch = ['diff --git a/README.md b/README.md', 'index 1111111..2222222 100644', '--- a/README.md', '+++ b/README.md', '@@ -1,2 +1,4 @@', ' keep', '-gone',
    '+++ b/other.txt', '+--- a/x', '++ b/README.md', '\\ No newline at end of file', '@@ -9 +11 @@', '-x', '+y'].join('\n');
  assert.deepEqual(kinds(patch).map(([k]) => k), ['meta', 'meta', 'meta', 'meta', 'hunk', 'ctx', 'del', 'add', 'add', 'add', 'ctx', 'hunk', 'del', 'add']);
  // `+++ b/x`, `--- a/x` and `++ b/README.md` as CONTENT.
  const content = ['@@ -1,2 +1,2 @@', '--- a/x', '+++ b/x'].join('\n');
  assert.deepEqual(CS.classifyDiff(content).map((l) => l.kind), ['hunk', 'del', 'add'], 'a removed `-- a/x` and an added `++ b/x` are content');
  assert.deepEqual(CS.classifyDiff('@@ -0,0 +1 @@\n++ b/README.md').map((l) => l.kind), ['hunk', 'add']);
  assert.deepEqual(CS.classifyDiff('@@ -1 +0,0 @@\n--- a/README.md').map((l) => l.kind), ['hunk', 'del']);
  // After the counts run out the next lines are headers again, and a malformed hunk ends at the line that does not fit.
  assert.deepEqual(CS.classifyDiff('@@ -1 +1 @@\n-a\n+b\n+++ b/next\n@@ -1 +1 @@\n-c\n+d').map((l) => l.kind), ['hunk', 'del', 'add', 'meta', 'hunk', 'del', 'add']);
  assert.deepEqual(CS.classifyDiff('@@ -1,3 +1,3 @@\n-a\ndiff --git a/n b/n').map((l) => l.kind), ['hunk', 'del', 'meta'], 'a line that does not fit leaves the hunk');
  // Without a regex over the line text: no header pattern is applied inside a hunk, and every line keeps its text and its sign.
  assert.doesNotMatch(src('project/changeSetModel.ts'), /const META\b|diffLineKind/);
  for (const l of CS.classifyDiff(patch)) assert.equal(typeof l.text, 'string');
  assert.equal(CS.classifyDiff('+x\r\n')[0].text, '+x\r', 'the text is kept exactly');
  // The reader renders those kinds.
  assert.match(src('project/ChangeSetReview.tsx'), /classifyDiff\(d\.text\)/);
  assert.match(src('project/ChangeSetReview.tsx'), /data-k=\{l\.kind\}/);
});

test('R7-2 Approve needs the WHOLE patch loaded; a partial or failed load keeps it hidden; Request changes and Reject are unaffected', () => {
  const m = (diffRead, o = {}) => CS.changeSetModel({ version: cset('candidate'), validations: allPass(), review: null, repo: repo(), diffRead, ...o });
  assert.deepEqual(m({ whole: true, readBytes: 65536, totalBytes: 65536 }).buttons, ['approve', 'request_changes', 'reject']);
  // First page of a larger patch.
  const part = m({ whole: false, readBytes: 65536, totalBytes: 2 * 1024 * 1024 });
  assert.deepEqual(part.buttons, ['request_changes', 'reject']);
  assert.ok(part.sentences.includes('Show all of what changed to say “Looks good” (64 KB of 2 MB shown so far).'), part.sentences.join('|'));
  assert.equal(m({ whole: false, readBytes: 1024, totalBytes: null }).sentences[0], 'Show all of what changed to say “Looks good” (1 KB shown so far).');
  // A failed page keeps Approve hidden, with its own sentence.
  const failed = m({ whole: false, readBytes: 65536, totalBytes: 200000, failed: true });
  assert.deepEqual(failed.buttons, ['request_changes', 'reject']);
  assert.match(failed.sentences[0], /^Nexus could not load all of these changes, so you cannot say “Looks good” yet\. Press “Try again”/);
  assert.deepEqual(m({ whole: true, readBytes: 1, totalBytes: 1, failed: true }).buttons, ['request_changes', 'reject'], 'whole but failed: still closed');
  // Not supplied at all: fail closed.
  assert.deepEqual(m(undefined).buttons, ['request_changes', 'reject']);
  assert.match(m(undefined).sentences[0], /^Show all of what changed to say “Looks good”\./);
  // Never a raw code, and an incomplete preview says its own reason rather than "load more".
  for (const x of [part, failed]) assert.doesNotMatch(x.sentences.join(' '), /_/);
  const inc = CS.changeSetModel({ version: { ...cset('candidate'), previewComplete: false, previewReason: 'too_large' }, validations: allPass(), review: null, repo: repo(), diffRead: { whole: false, readBytes: 1, totalBytes: 9 } });
  assert.equal(inc.sentences.filter((s) => /Show all of what changed/.test(s)).length, 0, 'an incomplete preview is not cured by loading more');
  // Accept still needs only an approving review (the approval already saw the whole change).
  assert.ok(CS.changeSetModel({ version: cset('candidate'), validations: allPass(), review: 'approve', repo: repo(), diffRead: { whole: false, readBytes: 1, totalBytes: 9 } }).buttons.includes('accept'));
  // The reader reports what it loaded.
  const rv = src('project/ChangeSetReview.tsx');
  assert.match(rv, /diffRead: \{ whole: diff\.whole, readBytes: diff\.readBytes, totalBytes: diff\.totalBytes, failed: diff\.failed \}/);
  assert.match(rv, /whole: loaded && last !== null && last\.nextPage === null && !unread/);
  assert.match(rv, /d\.error \? 'Try again' : 'Show more of the changes'/, 'a failed page can be retried with the same control');
});

test('R7-3 new closed reasons: unsafe_characters has its own sentence, an unfamiliar reason still reads unknown', () => {
  assert.equal(CS.previewIncompleteText('unsafe_characters'),
    'These changes contain invisible or unusual characters that can make code look different from what it does, so you cannot say “Looks good” here. Press “Ask for different changes” and ask the AI helper to remove them.');
  const v = CS.changeSetModel({ version: { ...cset('candidate'), previewComplete: false, previewReason: 'unsafe_characters' }, validations: allPass(), review: null, repo: repo(), diffRead: WHOLE });
  assert.deepEqual(v.buttons, ['request_changes', 'reject']);
  assert.equal(v.sentences.length, 1);
  assert.doesNotMatch(v.sentences[0], /unsafe_characters|_/);
  const all = ['hidden_lines', 'too_large', 'truncated', 'binary_file', 'unsafe_characters', 'unknown'].map((r) => CS.previewIncompleteText(r));
  assert.equal(new Set(all).size, 6, 'six closed reasons, six distinct sentences');
  assert.equal(CS.previewIncompleteText('never_heard_of_it'), CS.previewIncompleteText('unknown'));
});

test('R7-3 the accept refusal base_moved reads main\'s sentence (mirrored word for word), never its code', () => {
  const s = 'Your project changed after the AI helper started. Ask the AI helper to do the work again on your latest project.';
  assert.equal(E.AGENT_REASON_TEXT.base_moved, s);
  assert.equal(A.agentFailText({ code: 'conflict', reason: 'base_moved' }), s);
  assert.equal(E.errorCopy('conflict', 'base_moved').text, s);
  assert.doesNotMatch(s, /base_moved|_/);
  assert.equal(ENV.AGENT_REASON_MESSAGES.base_moved, s, 'main words it the same');
});

test('V9-1 after a revoke the setup sheet reads #51 again soon: the revoke answer is built before the probe refills, so without it the runtime list would show one row until the next 45 s re-ask', () => {
  const sheet = src('components/ExecutionSetupSheet.tsx');
  assert.match(sheet, /if \(op === 'grant'\) checkAgain\(\);\s*\/\/[^\n]*\s*else consent\.reloadAfter\(CHECK_AGAIN_REREAD_MS \+ 500\);/);
});

// ---------- V9b: the live click-through fixes ----------

const v9opt = (o = {}) => ({ kind: 'cli-agent', label: 'Test Engine', version: '1', state: 'ready', signedIn: 'yes', selected: false, models: null, model: null, problem: null, hosts: ['cli.example.com:443'], ...o });
const v9local = (o = {}) => v9opt({ kind: 'local-model', label: 'Local model (Test)', models: [{ name: 'coder:7b', tools: true }], model: null, problem: 'model_not_chosen', hosts: ['127.0.0.1:11434'], ...o });
const v9view = (runtimes, live = false) => ({ runtimes, consent: { live, caps: null, hostsCount: 0, grantedAt: null, hosts: [] } });

test('V9-2 the not-chosen sentence points at the model list (the person is in Setup when they read it), main and renderer word it the same', () => {
  const s = 'No AI model is chosen yet. Pick one from the list under AI on this computer.';
  assert.equal(E.AGENT_REASON_TEXT.local_model_not_chosen, s);
  assert.equal(ENV.AGENT_REASON_MESSAGES.local_model_not_chosen, s);
  assert.ok(!s.includes('in Setup'));
});

test('V9-3 the runtime in use says "In use" once: the word carries it, the text does not repeat it', () => {
  const rows = X.runtimeChoices(v9view([v9opt({ selected: true }), v9local({ model: 'coder:7b', problem: null })], true));
  assert.equal(rows[0].word, 'In use');
  assert.ok(!rows[0].text.startsWith('In use'));
  assert.equal(rows[0].text, 'Your AI program is installed and signed in.');
});

test('V9-4 the picker is remembered for the session: the model picked and the runtime last in use survive a revoke and a reopened sheet; a revoke never leaves a Grant button that would pick the program', () => {
  X.runtimeMemory.clear();
  const live = v9view([v9opt(), v9local({ selected: true, model: 'coder:7b', problem: null })], true);
  assert.deepEqual(X.runtimeInUse(live), { kind: 'local-model', model: 'coder:7b' });
  assert.equal(X.runtimeInUse(v9view([v9opt(), v9local()], false)), null, 'nothing in use without a live permission');
  const u = X.runtimeInUse(live);
  X.runtimeMemory.rememberInUse(u.kind, u.model);
  // After the revoke (and a fresh sheet): the model is still picked, the runtime is named as the last one, its button grants it with that model.
  const after = X.runtimeChoices(v9view([v9opt(), v9local()], false), X.runtimeMemory.models(), X.runtimeMemory.kind());
  assert.deepEqual([after[1].model, after[1].action.op, after[1].action.disabled], ['coder:7b', 'grant', false]);
  assert.ok(after[1].text.includes('It was in use before the permission was taken back.'));
  assert.ok(!after[0].text.includes('before the permission was taken back'));
  // The permission row of the default runtime loses its Grant button while the picker is shown and nothing is live; Revoke is untouched.
  const rows = [{ id: 'agent-consent', label: 'Internet permission', state: 'problem', word: 'Needs attention', text: 'Not allowed yet. Giving permission lets x.', action: null, prepare: null, consent: { op: 'grant', label: 'Give permission' } }];
  const fixed = X.pickerPermissionRows(rows, { picker: true, live: false });
  assert.equal(fixed[0].consent, undefined);
  assert.ok(fixed[0].text.includes('Press “Use this AI service” on a service below'));
  assert.equal(X.pickerPermissionRows(rows, { picker: false, live: false })[0].consent.op, 'grant', 'no picker: the row is as it was');
  const revoke = [{ ...rows[0], consent: { op: 'revoke', label: 'Take permission back' } }];
  assert.equal(X.pickerPermissionRows(revoke, { picker: true, live: true })[0].consent.op, 'revoke');
  X.runtimeMemory.clear();
  assert.equal(X.runtimeMemory.kind(), null);
  const sheet = src('components/ExecutionSetupSheet.tsx');
  assert.ok(sheet.includes('useState<Record<string, string>>(() => runtimeMemory.models())'));
  assert.ok(sheet.includes('runtimeMemory.rememberModel(c.kind, model)'));
  assert.ok(sheet.includes('runtimeMemory.rememberInUse(c.kind, c.model)'));
  assert.ok(sheet.includes('pickerPermissionRows(baseRows'));
});

test('V9-5 layout pins: the notice strip is bounded and scrolls (the bench keeps its height), the message box shares a row with its button, the title takes no focus ring', () => {
  const x = fs.readFileSync(path.join(NEXUS, 'styles', 'execution.css'), 'utf8');
  assert.ok(x.includes('.nx-xstrip { flex: none; }'), 'the notices and the panel are in normal flow: no cap, no inner scroll, nothing overlaps (V9e)');
  assert.ok(x.includes('.nx-ag__form { grid-template-columns: minmax(0, 1fr) auto;'));
  const pc = fs.readFileSync(path.join(NEXUS, 'styles', 'project.css'), 'utf8');
  assert.ok(pc.includes('.nx-workbench { overflow-y: auto; }'));
  assert.ok(pc.includes('.nx-workbench > .nx-spine { flex: none; }'), 'the step rail keeps its own height when the bench is held at 340px');
  assert.ok(pc.includes('min-height: 340px; flex: 1 0 340px; }'));
  assert.ok(fs.readFileSync(path.join(NEXUS, 'styles', 'project.css'), 'utf8').includes('.nx-surface__title:focus, .nx-surface__title:focus-visible { outline: none; }'));
});

test('V9-6 the project agent is asked with the same words in the panel and in the intent line', () => {
  const il = src('intent/IntentLine.tsx');
  const ask = A.intentWords({ mode: 'agent', lead: { state: 'ready' }, onSoftwareProject: false }).button;
  assert.equal(ask, 'Ask the AI helper');
  assert.ok(il.includes('aria-label={words.button}'));
  assert.ok(il.includes('{words.button}</span>'));
  // One place to ask on the project page: the bottom bar. The panel has no message box (V9e).
  assert.ok(!src('agent/AgentPanel.tsx').includes('<textarea'));
});

test('V9-7 an answer that lists fewer runtimes than the sheet showed (a revoke answers before the probe refills) keeps the missing rows, no longer in use; a complete answer is taken as is', () => {
  const prev = v9view([v9opt(), v9local({ selected: true, model: 'coder:7b', problem: null })], true);
  const afterRevoke = v9view([v9local({ model: 'coder:7b', problem: null })], false);
  const kept = X.keepRuntimes(prev, afterRevoke);
  assert.deepEqual(kept.runtimes.map((r) => [r.kind, r.selected]), [['cli-agent', false], ['local-model', false]]);
  assert.equal(kept.consent.live, false, 'the permission facts are the answer\'s own');
  const full = v9view([v9opt(), v9local()], false);
  assert.equal(X.keepRuntimes(prev, full), full);
  assert.equal(X.keepRuntimes(null, afterRevoke), afterRevoke);
  const prevB = v9view([v9opt({ selected: true })], true);
  assert.equal(X.keepRuntimes(prevB, { consent: afterRevoke.consent }).runtimes, undefined, 'an answer without a list is left alone');
  assert.ok(src('data/useAgents.ts').includes('keepRuntimes(prev.view, r.data)'));
  // A read that still lists fewer runtimes (the probe is refilling) is looked at again, bounded; a complete or unrelated answer is not.
  assert.equal(X.shrunkRereadDelay(prev, afterRevoke, 0), X.SHRUNK_REREAD_MS);
  assert.equal(X.shrunkRereadDelay(prev, afterRevoke, X.SHRUNK_REREAD_LIMIT), null, 'bounded');
  assert.equal(X.shrunkRereadDelay(prev, full, 0), null);
  assert.equal(X.shrunkRereadDelay(null, afterRevoke, 0), null);
  const hooks = src('data/useAgents.ts');
  assert.ok(hooks.includes('shrunkRereadDelay(viewRef.current, r.data, tries)'));
  assert.ok(hooks.includes('shrunk ?? consentRereadDelay(r.data, tries)'));
});

// ---------- V9d: the rough edges of the live demo ----------

const J = loadTs('src/renderer/src/nexus/runs/jobRunModel.ts');
const SPINE = loadTs('src/renderer/src/nexus/project/spineModel.ts');

test('V9d-1 a failed turn says why, with the fixed sentence for its reason (never the runtime text), and the panel offers the snapshot when that is the way forward', () => {
  const failed = (outcome, createdAt = 2, extra = {}) => ({ state: 'failed', phase: null, headline: 'failed', outcome, cancelRequested: false, createdAt, error: { code: outcome, message: 'RAW internal text' }, ...extra });
  assert.equal(J.agentTurnHeadline(failed('branch_unknown')), 'Nexus has not saved a starting point for this project yet. Save one first');
  assert.equal(J.agentTurnHeadline(failed('git_missing')), 'Git, a free program Nexus needs, is not installed on this computer. Install it, then try again');
  assert.match(J.agentTurnHeadline(failed('denied')), /you said no/);
  assert.match(J.agentTurnHeadline(failed('expired')), /not answered in time/);
  assert.equal(J.agentTurnHeadline(failed('some_unknown_code')), 'The request did not work', 'a reason without copy stays the plain sentence');
  assert.equal(J.agentTurnHeadline(failed('runtime_auth')), 'The AI helper could not sign in', 'the reason is one sentence; what to do is the separate next step');
  assert.match(J.agentTurnNext(failed('runtime_auth')), /Get this computer ready/);
  const panel = (jobs) => A.agentPanelModel({ health: health(), availability: READY, sessions: [], sessionsFail: null, jobs: new Map(jobs.map((j, n) => [`J${n}`, j])) });
  const p = panel([failed('branch_unknown')]);
  assert.deepEqual(p.failure, { text: 'Nexus has not saved a starting point for this project yet. Save one first', snapshot: true });
  assert.equal(p.ending.tone, 'failed');
  assert.equal(p.ending.text, 'Nexus has not saved a starting point for this project yet. Save one first.');
  assert.equal(p.ending.next, null, 'the sentence already says what to do');
  assert.equal(p.ending.snapshot, true);
  assert.doesNotMatch(JSON.stringify(p.failure), /RAW internal text/);
  assert.deepEqual(panel([failed('git_missing')]).failure, { text: 'Git, a free program Nexus needs, is not installed on this computer. Install it, then try again', snapshot: false });
  assert.equal(panel([failed('branch_unknown', 1), { ...failed('branch_unknown'), state: 'completed', outcome: 'completed', createdAt: 5 }]).failure, null, 'only the newest turn is shown, and only when it failed');
  assert.equal(panel([]).failure, null);
  const panelSrc = src('agent/AgentPanel.tsx');
  assert.ok(panelSrc.includes("actionId: 'sde.repository.snapshot'"));
  assert.ok(panelSrc.includes('Save a starting point'));
  assert.ok(panelSrc.includes('!snapshotStarted'), 'once the snapshot was started from the panel the old failure is not shown again');
});

test('V9d-2 a turn waiting for the repository-write approval says so in the panel and the approval is answered there; the strip leaves it out; the second step of the confirm is labelled', () => {
  assert.ok(A.REPO_APPROVAL_WAIT_TEXT.startsWith('The AI helper is waiting for your OK. Nexus wants to keep hidden Nexus notes in a small hidden area of your project.'));
  assert.doesNotMatch(A.REPO_APPROVAL_WAIT_TEXT, /refs|worktree|index|objects|branch|repository/i, 'no git word in the lead sentence of a blocking question');
  const panelSrc = src('agent/AgentPanel.tsx');
  assert.ok(panelSrc.includes('REPO_APPROVAL_WAIT_TEXT'));
  assert.ok(panelSrc.includes("a.reason === 'repo.write_refs'"));
  assert.ok(panelSrc.includes('<ApprovalList approvals={repoWaiting}'));
  const ap = src('project/ApprovalsSection.tsx');
  assert.ok(ap.includes('except?: readonly string[]'));
  assert.ok(ap.includes("'Yes, allow once'"));
  assert.ok(ap.includes('<span>Allow once</span>'), 'the first step keeps its label');
});

test('V9d-3 a merged change reads "Merged" (the repository status holds no accepted work waiting), a change not yet merged reads "Accepted" with its next step, and the repository head is the checked-out commit, not a hidden ref', () => {
  const merged = { acceptedNotMerged: 0, acceptedHead: 'a'.repeat(40) };
  const waiting = { acceptedNotMerged: 1, acceptedHead: 'a'.repeat(40) };
  assert.equal(CS.mergedOnBranch(merged), true);
  assert.equal(CS.mergedOnBranch(waiting), false);
  assert.equal(CS.mergedOnBranch({ acceptedNotMerged: 0, acceptedHead: null }), false, 'no accepted branch read: not known');
  assert.equal(CS.mergedOnBranch(null), false);
  const active = (o) => csm({ version: cset('active'), validations: allPass(), review: 'approve', repo: repo(o) });
  assert.equal(active(merged).headline, 'Added to your project');
  assert.deepEqual(active(merged).rail.map((x) => x.state), ['done', 'done', 'done'], 'after adding, every step is done');
  assert.equal(active(merged).merge, null);
  const acc = active({ ...waiting, canFastForward: true, reason: null });
  assert.equal(acc.headline, 'Kept: saved in Nexus’s copy. Your own files are not changed yet.');
  assert.deepEqual(acc.rail.map((x) => x.state), ['done', 'done', 'current'], 'kept: the last step is next');
  assert.ok(acc.sentences[0].startsWith('Next: press “Add to my project”'));
  const summaries = [{ artifact: { kind: 'change_set', status: 'active', id: 'A', name: 'n', createdAt: 1 }, latest: { id: 'V', versionNo: 1, status: 'active' } }];
  assert.equal(CS.changeSetRows(summaries, merged)[0].word, 'Added to your project');
  assert.equal(CS.changeSetRows(summaries, waiting)[0].word, 'Kept');
  assert.equal(CS.changeSetRows(summaries)[0].word, 'Kept');
  // Approve is gone once approved; Accept comes first.
  const ap = csm({ version: cset('candidate'), validations: allPass(), review: 'approve', repo: repo() });
  assert.ok(!ap.buttons.includes('approve'));
  assert.equal(ap.buttons[0], 'accept');
  // The head: HEAD's commit, not the newest commit of any ref.
  const log = [{ sha: 'jobhead', refs: ['refs/nexus/job/x'] }, { sha: 'tip', refs: ['HEAD -> main', 'refs/nexus/accepted/main'] }, { sha: 'old', refs: [] }];
  assert.equal(SPINE.checkedOutHead(log).sha, 'tip');
  assert.equal(SPINE.checkedOutHead([{ sha: 'det', refs: ['HEAD'] }, { sha: 'x' }]).sha, 'det');
  assert.equal(SPINE.checkedOutHead([{ sha: 'only' }]).sha, 'only', 'no HEAD mark in the page: the newest, as before');
  assert.equal(SPINE.checkedOutHead([]), null);
  assert.ok(src('project/useProjectGit.ts').includes('checkedOutHead(log)'));
});

// ---------- V9e: the project page says what is happening, in one place ----------

const NS = loadTs('src/renderer/src/nexus/project/nextStepModel.ts');
const SPN = loadTs('src/renderer/src/nexus/project/spineModel.ts');

test('V9e-1 one box says what is happening and the one thing to do next; a request with no live job never reads as working', () => {
  const panelOf = (o = {}) => A.agentPanelModel({ health: health(), availability: READY, sessions: [], sessionsFail: null, ...o });
  const ready = NS.nextStep({ panel: panelOf(), reviewReady: 0, repoApprovalWaiting: false });
  assert.equal(ready.tone, 'ready');
  assert.equal(ready.action, null, 'the box below is the one control; there is no second button');
  assert.ok(ready.text.includes('in the box below.'));
  assert.equal(NS.nextStep({ panel: panelOf(), reviewReady: 2, repoApprovalWaiting: false }).tone, 'review');
  assert.equal(NS.nextStep({ panel: panelOf(), reviewReady: 1, repoApprovalWaiting: false }).action.kind, 'review');
  const waiting = NS.nextStep({ panel: panelOf(), reviewReady: 1, repoApprovalWaiting: true });
  assert.equal(waiting.tone, 'waiting'); assert.equal(waiting.action, null);
  const notAllowed = NS.nextStep({ panel: panelOf({ health: health({ agent: agentView({ consent: { live: false, caps: null, hostsCount: 1, grantedAt: null } }) }) }), reviewReady: 0, repoApprovalWaiting: false });
  assert.equal(notAllowed.tone, 'setup'); assert.equal(notAllowed.action.kind, 'setup');
  // A conversation main keeps `running` after its request ended, with no live job: ready, never working.
  const idle = panelOf({ sessions: [session({ status: 'running', liveJobId: null })], jobs: new Map([['J1', job({ state: 'partial', outcome: 'no_change', createdAt: 5 })]]) });
  assert.equal(idle.progress, null);
  assert.equal(idle.working, null);
  assert.equal(NS.nextStep({ panel: idle, reviewReady: 0, repoApprovalWaiting: false }).tone, 'ready');
  const live = panelOf({ sessions: [session({ status: 'running', liveJobId: 'J1' })], jobs: new Map([['J1', job({ state: 'running', createdAt: 5, startedAt: 5 })]]), now: 20_000 });
  const w = NS.nextStep({ panel: live, reviewReady: 0, repoApprovalWaiting: false });
  assert.equal(w.tone, 'working'); assert.equal(w.action, null);
  const sourceOfPanel = src('agent/AgentPanel.tsx');
  assert.ok(sourceOfPanel.includes('LIVE_REFRESH_MS'));
  assert.ok(sourceOfPanel.includes("useExecStore.getState().bump(['jobs']); sessions.reload();"));
  assert.ok(!sourceOfPanel.includes('<textarea'), 'the bottom bar is the one place to ask');
});

test('V9e-2 the page order and plain words: header, notice strip (only when something blocks), progress closed by default; the disk advice stays in Get this computer ready', () => {
  const bench = src('project/ProjectBench.tsx');
  const iHeader = bench.indexOf('<ProjectHeader'); const iStrip = bench.indexOf('<div className="nx-xstrip">'); const iProg = bench.indexOf('<ProgressSection>'); const iBench = bench.indexOf('<div className="nx-bench">');
  assert.ok(iHeader > 0 && iHeader < iStrip && iStrip < iProg && iProg < iBench);
  assert.ok(src('project/ProgressSection.tsx').includes('useState(false)'), 'closed by default');
  assert.ok(src('components/ExecutionNotice.tsx').includes("availability.kind === 'ready') return null"), 'a recommendation is not shown on the project page');
  const base = { kind: 'artifact', artifactKind: 'repository', name: 'Repository', versionNo: 1, status: 'active', isCurrent: true };
  assert.equal(SPN.nodeTitle(base), 'Starting point');
  assert.equal(SPN.nodeTitle({ ...base, artifactKind: 'test_suite', name: 'Test suite' }), 'Your tests');
  assert.equal(SPN.nodeTitle({ ...base, artifactKind: 'change_set', name: 'Add a model' }), 'Add a model');
  const text = JSON.stringify(NS.nextStep({ panel: A.agentPanelModel({ health: health(), availability: READY, sessions: [], sessionsFail: null }), reviewReady: 1, repoApprovalWaiting: false }));
  assert.ok(!/\b(repository|commit|branch|job|worktree)\b/i.test(text), 'plain words');
});

test('V9f the request bar has its own row under the page and never covers content: the shell is a grid whose last rows are the bar, the page row can shrink and scrolls, the bar is not fixed or absolute', () => {
  const sh = fs.readFileSync(path.join(NEXUS, 'styles', 'shell.css'), 'utf8');
  assert.ok(sh.includes('grid-template-rows: var(--nx-bar-h) minmax(0, 1fr) auto auto; height: 100%;'));
  assert.ok(sh.includes('.nx-main { min-height: 0; overflow: auto; }'));
  const ag = fs.readFileSync(path.join(NEXUS, 'styles', 'agent.css'), 'utf8');
  const bar = ag.split('\n').find((l) => l.startsWith('.nx-intent {')) || '';
  assert.ok(bar.includes('position: sticky') && !/position:\s*(fixed|absolute)/.test(bar));
  const pc = fs.readFileSync(path.join(NEXUS, 'styles', 'project.css'), 'utf8');
  assert.ok(pc.includes('.nx-workbench { overflow-y: auto; }') && pc.includes('min-height: 340px; flex: 1 0 340px;'), 'the page scrolls instead of squeezing or overlapping');
  assert.ok(pc.includes('padding: var(--nx-s6) var(--nx-s6) 120px'), 'the work area keeps room under its last line');
});

test('V9g the project page has no fixed bottom bar: its request box is inside the next-step box, drawn in the flow; only the workspace page docks the line', () => {
  const shell = fs.readFileSync(path.join(NEXUS, 'NexusShell.tsx'), 'utf8');
  assert.ok(shell.includes("const docked = route.name === 'workspace';"));
  const panelSrc = src('agent/AgentPanel.tsx');
  const card = panelSrc.slice(panelSrc.indexOf('nx-ag__next'), panelSrc.indexOf('nx-ag__head'));
  assert.ok(card.includes('<IntentLine inline />'), 'the card contains the input');
  assert.ok(src('project/ProjectBench.tsx').includes('{!hasSde && <section className="nx-ag__next"'), 'a project without the AI helper keeps its lead-helper box, inline');
  assert.ok(src('intent/IntentLine.tsx').includes("inline ? 'nx-intent nx-intent--inline'"));
  assert.ok(fs.readFileSync(path.join(NEXUS, 'styles', 'agent.css'), 'utf8').includes('.nx-intent--inline { position: static;'));
});
