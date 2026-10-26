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
  assert.match(A.agentFailText({ code: 'conflict', reason: 'accept_rolled_back', detail: { rollbackOwed: true } }), /still owes an undo/);
  assert.doesNotMatch(A.agentFailText({ code: 'conflict', reason: 'ref_moved', detail: { current: SHA, rollbackOwed: false } }), new RegExp(SHA));
  // Agent work off reads a sentence, never "agents_unavailable".
  const off = E.errorCopy('platform_unavailable', 'agents_unavailable', 'not_enabled');
  assert.match(off.text, /^Agent work is not available because it is not turned on in this build/);
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
  assert.deepEqual(ok.buttons, ['approve', 'request_changes', 'reject', 'accept']);
  const none = csm({ version: cset('candidate'), validations: allPass(), review: null, repo: repo() });
  assert.deepEqual(none.buttons, ['approve', 'request_changes', 'reject']);
  assert.equal(none.headline, 'Waiting for your decision');
  // Approved but the branch head is unread: a sentence, not a button.
  const unread = csm({ version: cset('candidate'), validations: allPass(), review: 'approve', repo: repo({ acceptedHead: null }) });
  assert.ok(!unread.buttons.includes('accept') && unread.sentences.some((s) => /accepted branch has not been read/.test(s)));
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
  assert.equal(ok.line, '2 accepted changes are not on your branch yet.');
  assert.deepEqual(ok.button, { label: 'Merge accepted work', args: { branch: 'main', expectedAcceptedHead: SHA } });
  assert.equal(ok.sentence, null);
  const dirty = CS.mergeModel(repo({ acceptedNotMerged: 1, dirty: true, canFastForward: false, reason: 'tree_dirty' }));
  assert.equal(dirty.button, null);
  assert.match(dirty.sentence, /uncommitted changes to tracked files/);
  assert.match(dirty.sentence, /untracked files do not block/i);
  // Even if main said it could fast-forward, a dirty tree never gives the button.
  assert.equal(CS.mergeModel(repo({ acceptedNotMerged: 1, dirty: true, canFastForward: true, reason: null })).button, null);
  for (const reason of ['branch_mismatch', 'not_fast_forward', 'git_missing', 'runner_unavailable', 'weird_code']) {
    const m = CS.mergeModel(repo({ acceptedNotMerged: 1, canFastForward: false, reason }));
    assert.equal(m.button, null);
    assert.ok(m.sentence && m.sentence.length > 10 && !/_/.test(m.sentence), `${reason}: ${m.sentence}`);
  }
  assert.equal(CS.mergeModel(repo({ acceptedNotMerged: 1 })).line, '1 accepted change is not on your branch yet.');
  // The change view carries the merge only while there is something to merge.
  assert.equal(csm({ version: cset('active'), validations: allPass(), review: 'approve', repo: repo() }).merge, null);
  assert.ok(csm({ version: cset('active'), validations: allPass(), review: 'approve', repo: repo({ acceptedNotMerged: 1, canFastForward: true, reason: null }) }).merge.button);
  assert.equal(CS.mergedText({ branch: 'main', before: SHA, after: 'b'.repeat(40) }), 'Merged: main now holds the accepted work.');
  assert.doesNotMatch(CS.mergedText({ branch: 'main' }), /[0-9a-f]{8}/, 'no commit id in the text');
  assert.equal(CS.mergedTitle({ before: SHA, after: 'b'.repeat(40) }), 'The branch moved from aaaaaaaa to bbbbbbbb', 'the ids are for a hover only');
});

// ---------- UA5, UA12 ----------

test('UA5 no percentage, and no cost without the "reported" or "estimated" label', () => {
  const usage = (o = {}) => ({ inputTokens: 1200, outputTokens: 300, cacheCreationTokens: 0, cacheReadTokens: 0, costUsdCents: 42, toolCalls: 7, estimated: false, ...o });
  const lines = [A.usageLine(usage()), A.usageLine(usage({ costUsdCents: null })), A.usageLine(usage({ estimated: true, costUsdCents: 200 })), A.usageLine(usage({ estimated: true, costUsdCents: null })),
    A.usageTodayLine({ usdCents: 120, turns: 2, estimated: false }), A.usageTodayLine({ usdCents: 200, turns: 1, estimated: true }), A.usageTodayLine({ usdCents: 0, turns: 0, estimated: false })];
  for (const t of lines) {
    assert.doesNotMatch(t, /%|percent/i, t);
    if (/\$/.test(t)) assert.match(t, /reported by the agent runtime|estimated/, t);
  }
  assert.equal(A.usageLine(null), null);
  assert.match(A.usageLine(usage()), /cost \$0\.42 \(reported by the agent runtime\)/);
  assert.match(A.usageLine(usage({ estimated: true })), /estimated/);
  assert.doesNotMatch(A.usageLine(usage({ estimated: true })), /reported by the agent runtime/);
  // The panel, the log and the setup rows say the same.
  const panel = A.agentPanelModel({ health: health({ agent: agentView({ usageToday: { usdCents: 150, turns: 3, estimated: true } }) }), availability: READY, sessions: [], sessionsFail: null });
  assert.match(panel.usageToday, /estimated/);
  const log = A.sessionLogModel({ ...session(), turnHistory: [{ jobId: 'J1', state: 'completed', headline: 'checks_passed', outcome: 'completed', error: null, usage: usage({ costUsdCents: 99 }), createdAt: NOW, startedAt: NOW, finishedAt: NOW }],
    messages: [], toolCalls: [], versions: [], approvals: [] });
  assert.match(log.turns[0].usage, /\(reported by the agent runtime\)/);
  for (const r of X.agentSetupRows(agentView({ usageToday: { usdCents: 99, turns: 1, estimated: false } }))) {
    const t = `${r.text} ${r.action ?? ''}`;
    assert.doesNotMatch(t, /%/);
    if (/cost \$/.test(t)) assert.match(t, /reported by the agent runtime|estimated/);
  }
});

test('UA12 a partial turn with no change reads "The agent made no change", never done; no turn calls itself complete', () => {
  const noChange = job({ state: 'partial', outcome: 'no_change', headline: 'checks_could_not_run', startedAt: NOW, finishedAt: NOW });
  const v = R.jobRun(noChange);
  assert.equal(v.headline, 'The agent made no change');
  assert.equal(v.word, 'No change');
  assert.equal(R.agentTurnHeadline(noChange), 'The agent made no change');
  assert.doesNotMatch(`${v.headline} ${v.word} ${v.title}`, /done|complete|finished|passed/i);
  // Only the recorded outcome `no_change` justifies that sentence: a partial turn with no or an unknown outcome says only that it ended in part.
  for (const outcome of [null, 'surprise', 'completed']) {
    const p = R.jobRun(job({ state: 'partial', outcome, headline: 'checks_could_not_run', startedAt: NOW }));
    assert.equal(p.headline, 'The agent’s turn ended in part; what it changed is not recorded', String(outcome));
    assert.equal(p.word, 'Ended in part');
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
  assert.equal(R.agentTurnHeadline(job({ state: 'completed', outcome: 'completed' })), 'The agent ended its turn and registered its work');
  assert.equal(R.jobTitle(job()), 'Agent turn');
  assert.equal(R.jobTitle({ kind: 'tool.run', actionId: null, recipeId: 'changeset.collect' }), 'Collect the change');
});

// ---------- UA6 ----------

test('UA6 the agent\'s messages are labelled display only, and a tool call shows its name and result size, never its arguments', () => {
  const d = { ...session(), turnHistory: [], versions: [{ versionId: 'V1', kind: 'change_set', status: 'candidate' }], approvals: [],
    messages: [{ seq: 1, ts: NOW, from: 'user', text: 'fix it', displayOnly: true }, { seq: 2, ts: NOW, from: 'agent', text: 'I fixed it. All checks are green.', displayOnly: true }],
    toolCalls: [{ seq: 3, ts: NOW, jobId: 'J1', tool: 'Read', ok: true, resultBytes: 2048 }, { seq: 4, ts: NOW, jobId: 'J1', tool: 'rm -rf / <script>', ok: false, resultBytes: null },
      { seq: 5, ts: NOW, jobId: 'J1', tool: 'Edit', ok: null, resultBytes: null }] };
  const v = A.sessionLogModel(d);
  assert.match(v.note, /for reading only/);
  assert.match(v.note, /not evidence/);
  assert.equal(v.messages[1].author, 'Agent (display only)');
  assert.equal(v.messages[0].author, 'You');
  assert.equal(v.toolCalls[0].size, '2 KB');
  assert.equal(v.toolCalls[1].tool, 'a tool', 'a name that is not a plain tool name is never shown');
  assert.equal(v.toolCalls[1].size, 'size not recorded');
  assert.equal(v.toolCalls[2].outcome, 'result not recorded');
  assert.deepEqual(v.versions[0], { key: 'V1', versionId: 'V1', kind: 'Change set', status: 'ready' });
  const tsx = src('agent/SessionLog.tsx');
  assert.match(tsx, /view\.note/, 'the note is rendered');
  assert.match(tsx, /display only/i);
});

// ---------- UA7 ----------

test('UA7 every unmet prerequisite is a sentence, never a button that would be refused; missing permission reads exactly the brief sentence', () => {
  const panel = (h, availability = READY, extra = {}) => A.agentPanelModel({ health: h, availability, sessions: [], sessionsFail: null, ...extra });
  const noConsent = panel(health({ agent: agentView({ consent: { live: false, caps: null, hostsCount: 1, grantedAt: null } }) }));
  assert.deepEqual(noConsent.blockers, ['Agent turns need your network permission. Open Setup to grant it.']);
  assert.equal(noConsent.canAsk, false); assert.equal(noConsent.setup, true); assert.equal(noConsent.kind, 'setup');
  assert.equal(A.CONSENT_MISSING_TEXT, 'Agent turns need your network permission. Open Setup to grant it.');
  const cases = [
    [{ state: 'not_installed' }, /not installed/], [{ state: 'not_signed_in', signedIn: 'no' }, /not signed in/], [{ state: 'version_unsupported' }, /not a version Nexus supports/],
    [{ state: 'unavailable' }, /could not be checked/],
    // Never probed and no permission yet: nothing to ask with (a live permission with a stale check is askable, below).
    [{ state: 'unknown', signedIn: 'unknown', consent: { live: false, caps: null, hostsCount: 0, grantedAt: null } }, /has not been checked/]
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
  assert.deepEqual(budget.blockers, ['The agent has used its budget for today.']);
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
  assert.match(off.lead, /^Agent work is not available because/);
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
  assert.equal(waiting.sessions[0].turn, 'Waiting for your network permission');
  assert.equal(waiting.working, null);
  assert.equal(A.agentPanelModel({ health: health(), availability: READY, sessionsFail: null, sessions: [session({ status: 'awaiting_approval', liveJobId: 'J2' })] }).working, 'Waiting for you');
  // The setup row: the disclosure appears once, on the permission row, in every state.
  for (const a of [agentView(), agentView({ consent: { live: false, caps: null, hostsCount: 1, grantedAt: null } }), agentView({ state: 'not_installed', consent: { live: false, caps: null, hostsCount: 1, grantedAt: null } })]) {
    const rows = X.agentSetupRows(a, { hosts: ['api.example.test:443'] });
    const all = rows.map((r) => `${r.text} ${r.action ?? ''}`).join('\n');
    assert.equal(all.split('keeps its own state files').length - 1, 1, 'disclosed exactly once');
    assert.match(all, /sign-in, settings and log files\) in your own user folder/);
    assert.match(all, /Nexus never reads, copies or stores the sign-in/);
    // Round 4 (final review C3): the agent program runs on the host as the user; its own network is steered by a proxy setting, not enforced.
    assert.match(all, /The agent program runs on this computer as you/);
    assert.match(all, /sent through Nexus’s proxy, which allows only the destination you grant \(this is a setting the program follows, not a firewall\)/);
    assert.match(all, /Every command it runs goes into a sandbox with no network/);
    assert.match(all, /rule of the agent program, not an operating-system wall/);
    assert.doesNotMatch(all, /runs in a sandbox with no other network|and nothing else/, 'the old, untrue claims are gone');
  }
  const grant = X.agentSetupRows(agentView({ consent: { live: false, caps: null, hostsCount: 1, grantedAt: null } }), { hosts: ['api.example.test:443'] });
  assert.deepEqual(grant.find((r) => r.id === 'agent-consent').consent, { op: 'grant', label: 'Grant permission' });
  // The user sees the destination before granting; without it there is no Grant button, only a sentence.
  const unknownHosts = X.agentSetupRows(agentView({ consent: { live: false, caps: null, hostsCount: 1, grantedAt: null } }));
  assert.equal(unknownHosts.find((r) => r.id === 'agent-consent').consent, undefined);
  assert.equal(X.agentSetupRows(agentView(), { hosts: ['api.example.test:443'] }).find((r) => r.id === 'agent-consent').consent.op, 'revoke');
  // The agent rows never hold back "Jobs can run on this computer."
  const rows = X.setupSheet(health({ agent: agentView({ state: 'not_installed' }) }));
  assert.equal(X.setupLead(READY, rows), 'Jobs can run on this computer.');
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
    assert.match(v.headline, /own tests: failed/);
    assert.match(v.headline, /merges onto the accepted work: could not run/);
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
  assert.match(pending.headline, /^Being checked: /);
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
  assert.match(ACT.activityText(row('agent.consent', { op: 'grant' }), ctx), /given network permission/);
  assert.equal(ACT.activityText(row('agent.consent', { op: 'revoke' }), ctx), "The agent's network permission was revoked");
  assert.equal(ACT.activityText(row('agent.consent', {}), ctx), "The agent's network permission was changed");
  assert.equal(ACT.activityText(row('agent.consent', { op: 'sudo' }), ctx), "The agent's network permission was changed");
  assert.ok(ACT.ACTIVITY_ACTIONS.includes('auth.denied'));
  for (const status of ['denied', 'failed', 'succeeded']) {
    const t = ACT.activityText(row('auth.denied', { reason: 'out_of_scope', requested: 'x' }, status), ctx);
    assert.equal(t, 'The agent asked for something its permission does not cover, so it was refused');
    assert.doesNotMatch(t, /auth\.denied|out_of_scope/);
  }
});

test('carry: a queued job says why it waits (the phase), the flow actions are never a job-start button, the client has the new methods', () => {
  for (const [phase, text] of [['waiting:consent', 'Waiting for your network permission'], ['waiting:budget', 'Waiting for budget'], ['waiting:slots', 'Waiting for a free slot'],
    ['waiting:runtime', 'Waiting for the agent to be checked on this computer'], ['waiting:approval', 'Waiting for your approval']]) {
    assert.equal(R.jobRun(job({ phase })).headline, text, phase);
    assert.equal(R.jobRun(job({ kind: 'tool.run', actionId: 'sde.tests.run', phase })).headline, text, `${phase} on a recipe job`);
  }
  assert.equal(R.jobRun(job({ kind: 'tool.run', phase: null })).headline, 'Queued; it starts when a slot is free');
  assert.equal(R.jobRun(job({ kind: 'tool.run', phase: 'waiting:mystery' })).headline, 'Queued; it starts when a slot is free');
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
  assert.doesNotMatch(rv + src('agent/AgentPanel.tsx') + src('data/useAgents.ts').replace(/setInterval\(\(\) => read\(0\), CONSENT_REASK_MS\)/, ''), /setInterval/, 'no background polling');
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
  assert.match(il, /mode === 'agent' \? 'A message continues this project’s open conversation, or starts one when there is none;[^']*' : port\.replyHint/);
  assert.equal((il.match(/port\.replyHint/g) || []).length, 1, 'the lead-agent terminal hint is rendered only through the legacy branch');
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
  assert.deepEqual(X.agentSetupRows(landed, { hosts: X.consentHostsOf(landed) }).find((r) => r.id === 'agent-consent').consent, { op: 'grant', label: 'Grant permission' });
  assert.equal(X.agentSetupRows(view({ state: 'ready' })).find((r) => r.id === 'agent-consent').consent, undefined, 'before the destination is known there is no Grant');
  // Settled "cannot be granted" and a live permission are not asked again.
  for (const state of ['not_installed', 'not_signed_in', 'version_unsupported']) assert.equal(X.consentRereadDelay(view({ state }), 0), null, state);
  assert.equal(X.consentRereadDelay(view({ state: 'ready' }, { live: true }), 0), null);
  assert.equal(X.consentRereadDelay(null, 0), null);
  // Not granted: the D-B4 ceilings are shown on the row before the user grants.
  const text = X.agentSetupRows(landed, { hosts: X.consentHostsOf(landed) }).find((r) => r.id === 'agent-consent').text;
  assert.match(text, /Limits if you grant it: up to \$2\.00 per turn and \$10\.00 per day, 6 turns an hour, 1 at a time, 400k tokens, 200 tool calls, 30 minutes and 20 child jobs per turn/, 'all eight D-B4 caps');
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

test('F5 a no-change turn that main headlines `checks_could_not_run` reads "The agent made no change" in the run row, the log and the runs list', () => {
  const t = job({ state: 'partial', outcome: 'no_change', headline: 'checks_could_not_run', startedAt: NOW, finishedAt: NOW });
  const run = R.jobRun(t, { reason: 'No tests were executed.' });
  assert.equal(run.headline, 'The agent made no change');
  assert.doesNotMatch(`${run.headline} ${run.word}`, /checks|could not run/i);
  // The conversation log words the same turn from its state and outcome, never from the headline.
  const log = A.sessionLogModel({ ...session(), turnHistory: [{ jobId: 'J1', state: 'partial', headline: 'checks_could_not_run', outcome: 'no_change', error: null, usage: null, createdAt: NOW, startedAt: NOW, finishedAt: NOW }],
    messages: [], toolCalls: [], versions: [], approvals: [] });
  assert.equal(log.turns[0].headline, 'The agent made no change');
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
  assert.match(src('agent/AgentPanel.tsx'), /if \(panel\.working\) setOpen\(true\)/);
});

test('R4-I1 the program is "signed in" only when the view says so; an unreadable sign-in is said so', () => {
  for (const signedIn of ['unknown', 'no']) {
    const r = X.agentSetupRows(agentView({ signedIn })).find((x) => x.id === 'agent');
    assert.match(r.text, /Nexus could not confirm that the agent program is signed in\./, signedIn);
    assert.doesNotMatch(r.text, /installed and signed in/);
    assert.notEqual(r.state, 'ok');
  }
  assert.match(X.agentSetupRows(agentView({ signedIn: 'yes' })).find((x) => x.id === 'agent').text, /installed and signed in/);
  const p = A.agentPanelModel({ health: health({ agent: agentView({ signedIn: 'unknown' }) }), availability: READY, sessions: [], sessionsFail: null });
  assert.equal(p.note, 'Nexus could not confirm that the agent program is signed in.');
});

test('R4-I2 agent work off is its own state: one sentence, no check-again advice, no Grant row; flow actions use the same sentence', () => {
  const off = agentView({ state: 'off', label: null, version: null, consent: { live: false, caps: null, hostsCount: 0, grantedAt: null } });
  const rows = X.setupSheet(health({ agent: off }));
  const agentRows = rows.filter((r) => r.id.startsWith('agent'));
  assert.deepEqual(agentRows.map((r) => r.id), ['agent']);
  assert.equal(agentRows[0].text, E.AGENT_OFF_TEXT);
  assert.equal(E.AGENT_OFF_TEXT, 'Agent work is not available because it is not turned on in this build.');
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
  assert.equal(p.note, 'Nexus will check the agent again when you send.');
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
  assert.equal(f('worktree_guard'), 'The agent was stopped: it changed something outside its working copy; nothing was collected');
  assert.equal(f('consent_mismatch'), E.AGENT_REASON_TEXT.consent_mismatch.replace(/\.$/, ''));
  assert.match(f('consent_mismatch'), /Revoke it and grant it again in Setup/);
  assert.equal(f('proxy_failed'), 'The agent’s network proxy could not start; check again in Setup');
  assert.equal(f('runtime_unknown'), E.AGENT_REASON_TEXT.runtime_unknown.replace(/\.$/, ''));
  assert.equal(f('some_new_word'), 'The agent’s turn failed');
  for (const o of ['worktree_guard', 'consent_mismatch', 'proxy_failed']) assert.doesNotMatch(f(o), /_|raw runtime text/);
});

test('R4-I5 the intent chip makes no promise the code does not keep in agent mode', () => {
  const il = src('intent/IntentLine.tsx');
  assert.match(il, /mode === 'agent' \? `You are looking at: \$\{chip\}\. The agent is told your message and which project this is, not this selection\.` : `Sent with context: \$\{chip\}`/);
  const built = A.startArgs({ projectId: 'P', workspaceId: 'sde', sessionId: null, message: 'x', intentId: 'I' });
  assert.deepEqual(built.args.focusVersionIds, [], 'agent mode sends no focus, so it never says "sent with context"');
});

test('R4-minors copy and hygiene: merge copy, no raw ids, hashed intent keys, plain tool labels, refusal next steps, repo.write_refs', () => {
  const rv = src('project/ChangeSetReview.tsx');
  assert.match(rv, /Your branch and the files git tracks move to the accepted work only if you confirm; untracked files and other branches are not touched\./);
  assert.match(rv, /Nothing here touches your files until you merge accepted work\./);
  assert.doesNotMatch(rv, /Nothing here has touched your files|nothing else in your folder changes/);
  assert.doesNotMatch(rv, /Head of the change: <span/, 'no raw sha as visible text');
  assert.equal(CS.headTitle('aaaaaaaa'), 'Head commit aaaaaaaa');
  assert.equal(CS.changeSetRows([{ artifact: { id: 'a', kind: 'change_set', status: 'active', name: 'n', createdAt: 1 }, latest: { id: 'v', versionNo: 1, status: 'candidate' }, current: null }])[0].word, 'Ready for review');
  // The merge dialog's sentence (main).
  assert.match(fs.readFileSync(path.join(ROOT, 'src/main/nexusExec/mergeDialog.ts'), 'utf8'), /Your branch and the files git tracks move to the accepted work; untracked files and other branches are not touched\./);
  // Intent keys: a hash of the message, not its first characters.
  assert.equal(A.messageKey('hello world'), A.messageKey('hello world'));
  assert.notEqual(A.messageKey('hello world'), A.messageKey('hello worle'));
  assert.doesNotMatch(A.messageKey('my secret message'), /secret|message/);
  assert.doesNotMatch(src('agent/AgentPanel.tsx') + src('intent/IntentLine.tsx'), /message\.slice\(0, 64\)|text\.slice\(0, 64\)/);
  // Tool ids in plain words.
  assert.equal(A.toolLabel('mcp__nexus__changeset_register'), 'Register the change');
  assert.equal(A.toolLabel('sandbox_exec'), 'Run a command in the sandbox');
  assert.equal(A.toolLabel('mcp__other__weird_tool'), 'a tool');
  assert.equal(A.toolLabel('Read'), 'Read');
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
  assert.match(EV.validatorLabel('sec.secret_scan'), /known key and private-key patterns/);
  const live = X.agentSetupRows(agentView(), { hosts: ['api.example.test:443'] }).find((r) => r.id === 'agent-consent').text;
  assert.match(live, /400k tokens, 200 tool calls, 30 minutes and 20 child jobs per turn/);
  assert.doesNotMatch(live, /and nothing else/);
  // The once-per-project approval and its activity row.
  const row = AM.approvalRow({ id: 'a', projectId: 'p', jobId: null, reason: 'repo.write_refs', summary: 's', status: 'pending', request: {}, requestedAt: NOW, expiresAt: NOW + 60000, decidedAt: null, decision: null, consumedAt: null, imageBuild: null }, NOW);
  assert.equal(row.title, 'Let Nexus write hidden refs in this repository');
  const ctx = { names: new Map(), versionNos: new Map(), workspaceLabel: (x) => x, now: NOW };
  const act = (action, details) => ACT.activityText({ seq: 1, ts: NOW, action, status: 'succeeded', actorKind: 'user', onBehalfOfUser: false, entityType: 'x', entityId: null, projectId: 'p', workspaceId: null, artifactId: null, versionId: null, details }, ctx);
  assert.equal(act('approval.request', { reason: 'repo.write_refs' }), 'Approval asked: let Nexus write hidden refs in this repository');
  assert.equal(act('approval.respond', { reason: 'repo.write_refs', decision: 'once' }), 'Nexus was allowed to write hidden refs in this repository');
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
  assert.ok(!ok.sentences.some((s) => /can’t be approved/.test(s)));
  // Not complete, absent, wrong type or an unfamiliar reason: no Approve; the others stay.
  const cases = [[false, 'hidden_lines'], [false, 'too_large'], [false, 'truncated'], [false, 'unknown'], [false, null], [undefined, undefined], [null, null], ['true', null], [1, null],
    [false, 'brand_new_reason'], [undefined, 'hidden_lines'], [false, 7]];
  for (const [pc, reason] of cases) {
    const v = view(pc, reason);
    assert.ok(!v.buttons.includes('approve'), `${pc}/${reason}: no Approve`);
    assert.deepEqual(v.buttons, ['request_changes', 'reject'], `${pc}/${reason}: Reject and Request changes stay`);
    assert.ok(!v.buttons.includes('accept'));
    const said = v.sentences.filter((s) => /can’t be approved from Nexus/.test(s));
    assert.equal(said.length, 1, `${pc}/${reason}: exactly one sentence`);
    assert.doesNotMatch(v.sentences.join(' '), /hidden_lines|too_large|truncated|brand_new_reason|preview_incomplete|_/, 'no raw code');
  }
  // One sentence per reason, an unfamiliar one reads as unknown.
  assert.match(view(false, 'hidden_lines').sentences[0], /^Part of this change is hidden here because it looks like a secret/);
  assert.match(view(false, 'too_large').sentences[0], /^This change is too large to show here, so it can’t be approved from Nexus/);
  assert.match(view(false, 'truncated').sentences[0], /^This change is too large to show here in full/);
  assert.match(view(false, 'unknown').sentences[0], /^Nexus could not confirm that the whole change can be shown here/);
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
  assert.equal(v.sentences[0], 'A file in this change is binary, so it can’t be shown here and can’t be approved from Nexus. Review it in your own tools, or ask the agent to leave it out.');
  assert.doesNotMatch(v.sentences[0], /binary_file|_/);
  // Five distinct sentences for the five closed reasons; the old claim is not made.
  const said = ['hidden_lines', 'too_large', 'truncated', 'binary_file', 'unknown'].map((r) => CS.previewIncompleteText(r));
  assert.equal(new Set(said).size, 5);
  assert.doesNotMatch(CS.previewIncompleteText('hidden_lines'), /added|wrote|contains a secret/i);
  assert.match(CS.previewIncompleteText('hidden_lines'), /^Part of this change is hidden here because it looks like a secret/);
  // Still fail closed for anything but an explicit true.
  assert.ok(!csm({ version: { ...cset('candidate'), previewComplete: undefined, previewReason: 'binary_file' }, validations: allPass(), review: null, repo: repo() }).buttons.includes('approve'));
  assert.match(fs.readFileSync(path.join(ROOT, 'src/shared/nexus/ipc.ts'), 'utf8'), /'hidden_lines' \| 'too_large' \| 'truncated' \| 'binary_file'[^;]*'unknown' \| null/);
});

test('R6 agent work off says what is true: build, database, held or execution; an older answer reads as the build', () => {
  const off = (offReason) => agentView({ state: 'off', offReason, label: null, version: null, consent: { live: false, caps: null, hostsCount: 0, grantedAt: null } });
  const text = (offReason, h = {}) => X.setupSheet(health({ agent: off(offReason), ...h })).find((r) => r.id === 'agent').text;
  assert.equal(text('build'), 'Agent work is not available because it is not turned on in this build.');
  assert.equal(text(undefined), 'Agent work is not available because it is not turned on in this build.');
  assert.equal(text('database'), 'Agent work needs the newer database format, which is not applied on this computer yet.');
  assert.equal(text('held'), 'Agent work is paused on this computer: the database upgrade it needs is on hold.');
  assert.equal(text('execution'), 'Agent work needs running jobs, which are not available right now.');
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
  assert.ok(part.sentences.includes('Load the whole change to approve it (64 KB of 2 MB loaded).'), part.sentences.join('|'));
  assert.equal(m({ whole: false, readBytes: 1024, totalBytes: null }).sentences[0], 'Load the whole change to approve it (1 KB loaded).');
  // A failed page keeps Approve hidden, with its own sentence.
  const failed = m({ whole: false, readBytes: 65536, totalBytes: 200000, failed: true });
  assert.deepEqual(failed.buttons, ['request_changes', 'reject']);
  assert.match(failed.sentences[0], /^The whole change could not be read, so it can’t be approved from Nexus\./);
  assert.deepEqual(m({ whole: true, readBytes: 1, totalBytes: 1, failed: true }).buttons, ['request_changes', 'reject'], 'whole but failed: still closed');
  // Not supplied at all: fail closed.
  assert.deepEqual(m(undefined).buttons, ['request_changes', 'reject']);
  assert.match(m(undefined).sentences[0], /^Load the whole change to approve it\./);
  // Never a raw code, and an incomplete preview says its own reason rather than "load more".
  for (const x of [part, failed]) assert.doesNotMatch(x.sentences.join(' '), /_/);
  const inc = CS.changeSetModel({ version: { ...cset('candidate'), previewComplete: false, previewReason: 'too_large' }, validations: allPass(), review: null, repo: repo(), diffRead: { whole: false, readBytes: 1, totalBytes: 9 } });
  assert.equal(inc.sentences.filter((s) => /Load the whole change/.test(s)).length, 0, 'an incomplete preview is not cured by loading more');
  // Accept still needs only an approving review (the approval already saw the whole change).
  assert.ok(CS.changeSetModel({ version: cset('candidate'), validations: allPass(), review: 'approve', repo: repo(), diffRead: { whole: false, readBytes: 1, totalBytes: 9 } }).buttons.includes('accept'));
  // The reader reports what it loaded.
  const rv = src('project/ChangeSetReview.tsx');
  assert.match(rv, /diffRead: \{ whole: diff\.whole, readBytes: diff\.readBytes, totalBytes: diff\.totalBytes, failed: diff\.failed \}/);
  assert.match(rv, /whole: loaded && last !== null && last\.nextPage === null && !unread/);
  assert.match(rv, /d\.error \? 'Try again' : 'Show more of the change'/, 'a failed page can be retried with the same control');
});

test('R7-3 new closed reasons: unsafe_characters has its own sentence, an unfamiliar reason still reads unknown', () => {
  assert.equal(CS.previewIncompleteText('unsafe_characters'),
    'This change contains characters that can make code look different from what it does (hidden or reordering characters), so it can’t be approved from Nexus. Review it in your own tools, or ask the agent to remove them.');
  const v = CS.changeSetModel({ version: { ...cset('candidate'), previewComplete: false, previewReason: 'unsafe_characters' }, validations: allPass(), review: null, repo: repo(), diffRead: WHOLE });
  assert.deepEqual(v.buttons, ['request_changes', 'reject']);
  assert.equal(v.sentences.length, 1);
  assert.doesNotMatch(v.sentences[0], /unsafe_characters|_/);
  const all = ['hidden_lines', 'too_large', 'truncated', 'binary_file', 'unsafe_characters', 'unknown'].map((r) => CS.previewIncompleteText(r));
  assert.equal(new Set(all).size, 6, 'six closed reasons, six distinct sentences');
  assert.equal(CS.previewIncompleteText('never_heard_of_it'), CS.previewIncompleteText('unknown'));
});

test('R7-3 the accept refusal base_moved reads main\'s sentence (mirrored word for word), never its code', () => {
  const s = 'The ground this change was made on has moved; ask the agent to redo it on your current code.';
  assert.equal(E.AGENT_REASON_TEXT.base_moved, s);
  assert.equal(A.agentFailText({ code: 'conflict', reason: 'base_moved' }), s);
  assert.equal(E.errorCopy('conflict', 'base_moved').text, s);
  assert.doesNotMatch(s, /base_moved|_/);
  assert.equal(ENV.AGENT_REASON_MESSAGES.base_moved, s, 'main words it the same');
});
