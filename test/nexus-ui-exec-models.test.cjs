// test/nexus-ui-exec-models.test.cjs
// B2a Task 14: the renderer's execution models (through load-ts) and source pins on the
// components (no jsdom). Named nexus-ui-* (not nexus-exec-*): test:exec runs every
// test/nexus-exec-*.test.cjs under real Docker, and its P6 pin lists exactly four files.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const R = loadTs('src/renderer/src/nexus/runs/jobRunModel.ts');
const EV = loadTs('src/renderer/src/nexus/project/evidenceModel.ts');
const AM = loadTs('src/renderer/src/nexus/project/actionModel.ts');
const X = loadTs('src/renderer/src/nexus/data/executionModel.ts');
const E = loadTs('src/renderer/src/nexus/data/errorCopy.ts');
const C = loadTs('src/renderer/src/nexus/data/nexusClient.ts');

const ROOT = path.join(__dirname, '..');
const NEXUS = path.join(ROOT, 'src', 'renderer', 'src', 'nexus');
const src = (p) => fs.readFileSync(path.join(NEXUS, p), 'utf8');
const GIB = 2 ** 30;
const NOW = 1_800_000_000_000;

const job = (o = {}) => ({
  id: 'J1', kind: 'tool.run', projectId: 'p', workspaceId: 'sde', actionId: 'sde.tests.run', recipeId: 'sde.test.node', state: 'queued', phase: null,
  headline: 'queued', outcome: null, error: null, attempts: 0, retryOf: null, parentJobId: null, requestedByKind: 'user', inputs: [],
  createdAt: NOW, updatedAt: NOW, startedAt: null, finishedAt: null, nextAttemptAt: null, cancelRequested: false, ...o
});
const HEADLINES = ['queued', 'waiting:runner', 'waiting:docker', 'waiting:image', 'waiting:disk', 'waiting:slots', 'waiting:memory', 'waiting:git',
  'waiting:retry', 'provisioning', 'running', 'waiting_for_approval', 'collecting', 'validating', 'checks_passed', 'checks_failed',
  'checks_could_not_run', 'failed', 'cancelled', 'timed_out', 'interrupted'];
const STATE_OF = { checks_passed: 'completed', checks_failed: 'completed', checks_could_not_run: 'completed', failed: 'failed', cancelled: 'cancelled',
  timed_out: 'timed_out', interrupted: 'interrupted', provisioning: 'leased', running: 'running', waiting_for_approval: 'awaiting_approval',
  collecting: 'running', validating: 'completed', 'waiting:retry': 'retry_scheduled' };

// ---------- U-R1, U-R2 ----------

test('U-R1 every headline maps to a stage strip and one plain sentence; the brief sentences exactly', () => {
  for (const h of HEADLINES) {
    const v = R.jobRun(job({ headline: h, state: STATE_OF[h] ?? 'queued', startedAt: NOW }));
    assert.equal(v.stages.length, 6, h);
    assert.ok(v.stages.every((s) => typeof s.label === 'string' && s.label && R.STAGE_STATE_TEXT[s.state]), h);
    assert.ok(v.headline.length > 3 && !/\n/.test(v.headline), h);
    assert.ok(v.word.length > 0, `${h} has a status word`);
    assert.doesNotMatch(`${v.headline} ${v.word}`, /complet/i, `${h}: never "Completed"`);
    assert.doesNotMatch(`${v.headline} ${v.word}`, /\d\s*%|percent/i, `${h}: no percentage`);
  }
  assert.equal(R.jobRun(job({ headline: 'checks_failed', state: 'completed' }), { reason: 'No tests were executed.' }).headline,
    'Tests ran; checks failed: no tests were executed');
  assert.equal(R.jobRun(job({ actionId: 'sde.deps.install', recipeId: 'sde.deps.node', headline: 'waiting_for_approval', state: 'awaiting_approval' })).headline,
    'Waiting for your OK to download the add-ons your project needs');
  assert.equal(R.jobRun(job({ headline: 'waiting:memory' })).headline, 'Waiting: Docker is using all of its memory for other tasks');
});

test('U-R1 a job whose outputs failed their checks never reads completed or passed; stages follow the headline', () => {
  const v = R.jobRun(job({ headline: 'checks_failed', state: 'completed' }));
  assert.equal(v.result, 'failed');
  assert.equal(v.word, 'Checks failed');
  assert.equal(v.stages.find((s) => s.id === 'result').state, 'stopped');
  const ok = R.jobRun(job({ headline: 'checks_passed', state: 'completed' }));
  assert.ok(ok.stages.every((s) => s.state === 'done'));
  assert.equal(ok.headline, 'Tests ran; checks passed');
  const val = R.jobRun(job({ headline: 'validating', state: 'completed' }));
  assert.equal(val.stages.find((s) => s.id === 'validating').state, 'active');
  assert.equal(R.jobRun(job({ headline: 'waiting_for_approval', state: 'awaiting_approval' })).stages.find((s) => s.id === 'running').state, 'waiting');
  // No percentage source exists: the model has no progress input at all.
  assert.doesNotMatch(src('runs/jobRunModel.ts'), /progress\.|\$\{[^}]*\}%/);
});

test('U-R2 Cancel only for live states; Retry only for failed, timed_out, cancelled, interrupted', () => {
  const LIVE = ['queued', 'leased', 'running', 'awaiting_approval', 'retry_scheduled'];
  const ALL = [...LIVE, 'completed', 'partial', 'failed', 'cancelled', 'timed_out', 'interrupted'];
  for (const s of ALL) {
    assert.equal(R.canCancelJob({ state: s, cancelRequested: false }), LIVE.includes(s), s);
    assert.equal(R.canRetryJob({ state: s }), ['failed', 'timed_out', 'cancelled', 'interrupted'].includes(s), s);
  }
  assert.equal(R.canCancelJob({ state: 'running', cancelRequested: true }), false, 'already asked to stop');
  assert.equal(R.jobRun(job({ headline: 'checks_failed', state: 'completed' })).canRetry, false);
});

// ---------- U-E1 ----------

const val = (o = {}) => ({ validatorId: 'sde.tests_pass', blocking: true, status: 'passed', summary: 'All 3 tests passed.', finishedAt: NOW, evidence: [], latestRun: null, history: 1, ...o });

test('U-E1 evidence rows: JUnit counts reported by the framework, 12-character hashes, HTTP probes, git checks, exit facts', () => {
  const v = EV.evidenceView([val({ evidence: [
    { type: 'junit', name: null, value: '3/5 passed, 1 failed, 1 errored' },
    { type: 'hash', name: 'junit.xml', value: 'sha256:0123456789ab' },
    { type: 'exit', name: null, value: 1 }
  ] }), val({ validatorId: 'app.preview_health', evidence: [{ type: 'http', name: '/health', value: 200 }] }),
  val({ validatorId: 'git.head_resolves', evidence: [{ type: 'git', name: null, value: 'a'.repeat(40) }] })], { status: 'candidate' });
  const facts = v.rows.flatMap((r) => r.facts);
  const junit = facts.find((f) => f.kind === 'junit');
  assert.deepEqual([junit.label, junit.value, junit.source], ['Test counts', '3/5 passed, 1 failed, 1 errored', 'Reported by the test tool']);
  assert.equal(facts.find((f) => f.kind === 'hash').value, 'sha256:0123456789ab');
  assert.equal(EV.shortHash('f'.repeat(64)), 'f'.repeat(12));
  assert.equal(EV.shortHash(`sha256:${'e'.repeat(64)}`), `sha256:${'e'.repeat(12)}`);
  assert.deepEqual([facts.find((f) => f.kind === 'http').label, facts.find((f) => f.kind === 'http').value], ['Answer from /health', 'Answered 200']);
  assert.equal(facts.find((f) => f.kind === 'git').value, 'a'.repeat(12));
  assert.equal(facts.find((f) => f.kind === 'exit').value, '1');
  for (const f of facts) assert.ok(f.source.length > 0, `${f.kind} names its source`);
  assert.equal(v.headline, 'Checks passed');
});

test('U-E1 log ranges carry {jobId, offset, length}; the attempt only when the job has one', () => {
  const report = { version: 1, subject: { target: 'job', id: 'J9' }, fields: [
    { name: 'log.frames', value: 12, source: { type: 'log', attemptId: 'A1', offset: 100, length: 50, sha256: 'b'.repeat(64) } },
    { name: 'log.lastLine', value: 'x', source: { type: 'log', attemptId: 'A1', offset: 100, length: 50, sha256: 'b'.repeat(64) } },
    { name: 'container.exitCode', value: 0, source: { type: 'inspect', container: { sha256: 'c'.repeat(64) }, field: 'State.ExitCode' } },
    { name: 'bad', value: 1, source: { type: 'log', offset: -1, length: 5, sha256: 'x' } }
  ] };
  const one = EV.logRangesOf(report, 'J9', 1);
  assert.equal(one.length, 1, 'duplicates and malformed ranges are dropped');
  assert.deepEqual({ jobId: one[0].jobId, offset: one[0].offset, length: one[0].length, attempt: one[0].attempt }, { jobId: 'J9', offset: 100, length: 50, attempt: 1 });
  assert.equal(one[0].sha256, 'b'.repeat(12));
  assert.equal(EV.logRangesOf(report, 'J9', 2)[0].attempt, null);
  assert.deepEqual(EV.logRangesOf(null, 'J9', 1), []);
  // Final review item 4: AttemptSummaryView carries the attempt id, so a multi-attempt job's link is exact.
  assert.equal(one[0].attemptId, 'A1');
  const multi = { ...report, fields: [...report.fields,
    { name: 'log.frames', value: 3, source: { type: 'log', attemptId: 'A2', offset: 100, length: 50, sha256: 'b'.repeat(64) } }] };
  const history = [{ id: 'A1', n: 1 }, { id: 'A2', n: 2 }, { id: 'A3', n: 3 }];
  const exact = EV.logRangesOf(multi, 'J9', history);
  assert.deepEqual(exact.map((r) => [r.attemptId, r.attempt]), [['A1', 1], ['A2', 2]], 'the same bytes of two attempts are two ranges, each exact');
  const unresolved = EV.logRangesOf(multi, 'J9', []);
  assert.deepEqual(unresolved.map((r) => r.attempt), [null, null]);
  assert.equal(EV.rangeAttempt(unresolved[1], history), 2, 'the log reader resolves the id against the job history');
  assert.equal(EV.rangeAttempt({ attempt: null, attemptId: 'ZZ' }, history), null, 'an unknown id names no attempt');
  assert.equal(EV.rangeAttempt({ attempt: null, attemptId: null }, history), null);
  assert.equal(EV.logRangesOf({ fields: [{ name: 'x', source: { type: 'log', attemptId: '../etc', offset: 1, length: 1, sha256: 'b'.repeat(64) } }] }, 'J9', history)[0].attemptId,
    null, 'an id of another shape is dropped');
  const viewer = src('project/kindViewers.tsx');
  assert.match(viewer, /logRangesOf\(c\.json, jobId, \[\]\)/);
  assert.doesNotMatch(viewer, /attempt: null \}\)\)/, 'the viewer no longer throws the attempt away');
  const reader = src('runs/JobLogSheet.tsx');
  assert.match(reader, /rangeAttempt\(range, history\)/);
  assert.match(reader, /target !== null && target === shown \? range\.offset : 0/, 'the offset applies only to its own attempt');
  const { jobDetailView } = loadTs('src/main/nexusIpc/dto.ts');
  const d = jobDetailView({ id: 'J9', kind: 'tool.run', projectId: 'p', workspaceId: 'sde', actionId: null, recipeId: null, state: 'failed', phase: null,
    headline: 'failed', outcome: null, error: null, attempts: 2, retryOf: null, parentJobId: null, requestedBy: 'user:local', inputs: [], createdAt: 1, updatedAt: 1,
    startedAt: null, finishedAt: null, nextAttemptAt: null, cancelRequestedAt: null, approvals: [], outputs: [], deployment: null,
    attemptHistory: [1, 2].map((n) => ({ id: `A${n}`, n, state: 'failed', outcome: null, exitCode: 1, signal: null, oomKilled: false, network: 'none', preflight: null,
      error: null, createdAt: 1, startedAt: 1, finishedAt: 2, imageId: null, profile: null })) });
  assert.deepEqual(d.attemptHistory.map((a) => [a.id, a.n]), [['A1', 1], ['A2', 2]], 'the DTO sends each attempt id');
  const facts = EV.reportFacts(report);
  assert.equal(facts.find((f) => f.name === 'container.exitCode').source, 'read from Docker State.ExitCode');
  assert.equal(facts.find((f) => f.name === 'log.frames').source, 'part of the task log');
});

test('U-E1 (fix round 1) the headline reads blocking rows only; unchecked kinds never read "Checking…"', () => {
  assert.equal(EV.evidenceView([], { status: 'draft' }, false).headline, 'This kind of item has no checks');
  assert.equal(EV.evidenceView([], { status: 'draft' }, false).revalidate, false);
  // A failed advisory run never makes the headline "Checks passed".
  const advFailed = EV.evidenceView([val({ blocking: false, status: null, latestRun: { status: 'failed', summary: 'x', finishedAt: NOW } })], { status: 'active' });
  assert.equal(advFailed.headline, 'No required checks');
  // A blocking row with no status yet reads "Checking…" only on a draft.
  assert.equal(EV.evidenceView([val({ status: null })], { status: 'candidate' }).headline, 'Some checks have not run');
  assert.equal(EV.evidenceView([val({ status: null })], { status: 'draft' }).headline, 'Checking…');
  assert.equal(EV.evidenceView([val({ status: 'skipped' }), val({ validatorId: 'x', status: 'skipped' })], { status: 'active' }).headline, 'No checks ran');
  assert.equal(EV.evidenceView([val({ status: 'skipped' }), val({ validatorId: 'x', status: 'passed' })], { status: 'active' }).headline, 'Checks passed');
  assert.match(src('project/ArtifactPassport.tsx'), /<EvidenceSection key=\{shownVersion\.id\} version=\{shownVersion\} kind=\{artifact\.kind\} checked=\{kindIsChecked\(artifact\.kind\)\} \/>/);
  assert.match(src('project/EvidenceSection.tsx'), /useValidations\(checked \? version\.id : null\)/);
});

test('(fix round 1) robustness: hashes in any case, object facts as JSON, sizes that are not numbers, unique keys, shared gate constants', () => {
  assert.equal(EV.shortHash(`sha256:${'AB'.repeat(32)}`), `sha256:${'ab'.repeat(6)}`);
  assert.equal(EV.shortHash('C'.repeat(64)), 'c'.repeat(12));
  const facts = EV.reportFacts({ fields: [{ name: 'limits', value: { cpus: 2, memory: 4 }, source: { type: 'inspect', field: 'HostConfig' } }, { name: 'ports', value: ['a', 'b'], source: {} }] });
  assert.equal(facts[0].value, '{"cpus":2,"memory":4}');
  assert.equal(facts[1].value, '["a","b"]');
  for (const bad of [NaN, Infinity, -1, undefined]) assert.equal(X.gb(bad), 'unknown');
  assert.match(src('project/kindViewers.tsx'), /<li key=\{`\$\{i\}:\$\{x\}`\}>/);
  assert.doesNotMatch(src('project/kindViewers.tsx'), /<li key=\{x\}>/);
  assert.match(src('data/executionModel.ts'), /import \{ GIB, MIN_DOCKER_CPUS, MIN_DOCKER_MEMORY \} from '@shared\/nexus\/resourceGate';/);
  assert.doesNotMatch(src('data/executionModel.ts'), /const (GIB|MIN_DOCKER_MEMORY|MIN_DOCKER_CPUS) =/);
});

test('U-E1 a check that could not run reads "Checks could not run: <reason>" and offers Revalidate on a draft only', () => {
  const rows = [val({ status: 'error', summary: 'The runner was not available.' })];
  const draft = EV.evidenceView(rows, { status: 'draft' });
  assert.equal(draft.headline, 'Checks could not run');
  assert.equal(draft.rows[0].summary, 'Checks could not run: The runner was not available.');
  assert.equal(draft.rows[0].word, 'Could not run');
  assert.equal(draft.revalidate, true);
  assert.equal(EV.evidenceView(rows, { status: 'candidate' }).revalidate, false);
  assert.equal(EV.evidenceView([val({ status: 'failed' })], { status: 'draft' }).headline, 'Checks failed');
  assert.equal(EV.evidenceView([], { status: 'draft' }).headline, 'Checking…');
  assert.equal(EV.evidenceView([], { status: 'active' }).headline, 'No checks saved yet');
  // An advisory row is a run result, never the status.
  const adv = EV.evidenceView([val({ validatorId: 'sde.deps.lock_matches', blocking: false, status: null, latestRun: { status: 'passed', summary: 'ok', finishedAt: NOW } })], { status: 'active' });
  assert.equal(adv.headline, 'No required checks');
  assert.equal(adv.rows[0].word, 'Not run yet');
  assert.equal(adv.rows[0].latestRun.word, 'Passed');
  // "Checking…" on a non-draft is never shown (the B1 default validation state is "pending").
  assert.equal(EV.checksWord('pending', 'active'), null);
  assert.equal(EV.checksWord('pending', 'draft'), 'Checking…');
  assert.equal(EV.checksWord('failed', 'failed'), 'Checks failed');
});

// ---------- U-A1 ----------

const READY = { kind: 'ready', advisories: [] };
const SETUP = { kind: 'setup', problems: ['docker_stopped'], profiles: [], text: 't' };
const act = (id, o = {}) => ({ actionId: id, label: id, stepId: null, available: true, reason: null, inputs: [], needsApproval: false, ...o });

test('U-A1 available actions are buttons; unavailable ones are sentences with the setup link; FUTURE actions are absent', () => {
  const list = [
    act('sde.requirement.write', { label: 'Write a requirement', stepId: 'requirement' }),
    act('sde.repository.snapshot', { label: 'Save a starting point', stepId: 'repository', available: false, reason: 'setup:git_missing' }),
    act('sde.build.run', { label: 'Build', stepId: 'build', available: false, reason: 'blocked_by_step:repository', inputs: [{ slot: 'repository', kinds: ['repository'], min: 1, max: 1 }] }),
    act('sde.future.thing', { label: 'Later', available: false, reason: 'future' }),
    act('sde.preview.stop', { label: 'Stop' })
  ];
  const v = AM.actionBar(list, { workspaceId: 'sde', availability: READY, version: null });
  assert.deepEqual(v.buttons.map((b) => [b.actionId, b.inline]), [['sde.requirement.write', true]]);
  assert.deepEqual(v.sentences.map((s) => [s.actionId, s.setup]), [['sde.repository.snapshot', true], ['sde.build.run', false]]);
  assert.equal(v.sentences[0].text, 'Save a starting point: Git, a free program, is not installed, so this cannot run on this computer yet. Install it, then try again.');
  assert.equal(v.sentences[1].text, 'Build: finish the “Repository” step first.');
  const all = JSON.stringify(v);
  assert.doesNotMatch(all, /Later|sde\.future/, 'a FUTURE action is not present at all');
});

test('U-A1 a button needs the machine ready, a usable input and a step in this release (defence in depth)', () => {
  const tests = act('sde.tests.run', { label: 'Run tests on a commit', stepId: 'tests', inputs: [{ slot: 'suite', kinds: ['test_suite'], min: 1, max: 1 }] });
  // While the setup fails, a Docker action that main still listed as available is a sentence.
  const off = AM.actionBar([tests], { workspaceId: 'sde', availability: SETUP, version: { kind: 'test_suite', status: 'candidate' } });
  assert.equal(off.buttons.length, 0);
  assert.equal(off.sentences[0].setup, true);
  const on = AM.actionBar([tests], { workspaceId: 'sde', availability: READY, version: { kind: 'test_suite', status: 'candidate' } });
  assert.deepEqual(on.buttons.map((b) => [b.actionId, b.slot]), [['sde.tests.run', 'suite']]);
  const draft = AM.actionBar([tests], { workspaceId: 'sde', availability: READY, version: { kind: 'test_suite', status: 'draft' } });
  assert.equal(draft.buttons.length, 0, 'a draft is not an input');
  const other = AM.actionBar([tests], { workspaceId: 'sde', availability: READY, version: { kind: 'build', status: 'candidate' } });
  assert.deepEqual([other.buttons.length, other.sentences.length], [0, 0], 'not an action on this version');
});

test('U-A1 (fix round 1) the step comes from the registry, never the answer; other domains actions and no-input actions stay off a version bar', () => {
  // The answer's stepId is ignored: the registry's own step decides (here the REAL requirement step).
  const lied = AM.actionBar([act('sde.requirement.write', { label: 'Write a requirement', stepId: 'ai-implementation' })], { workspaceId: 'sde', availability: READY, version: null });
  assert.deepEqual(lied.buttons.map((b) => b.actionId), ['sde.requirement.write']);
  const noStep = AM.actionBar([act('sde.requirement.write', { label: 'Write a requirement', stepId: null })], { workspaceId: 'sde', availability: READY, version: null });
  assert.equal(noStep.buttons.length, 1, 'stepId null does not matter');
  // An action of another workspace, answered under this one, is never listed.
  const cross = AM.actionBar([act('data.problem.write', { label: 'Write a business question' }), act('ml.problem.write')], { workspaceId: 'sde', availability: READY, version: null });
  assert.equal(cross.buttons.length + cross.sentences.length, 0);
  // A version bar never shows project-level, no-input actions.
  const onVersion = AM.actionBar([act('sde.requirement.write', { label: 'Write a requirement' }), act('sde.repository.snapshot', { label: 'Snapshot' })],
    { workspaceId: 'sde', availability: READY, version: { kind: 'requirement', status: 'candidate' } });
  assert.equal(onVersion.buttons.length + onVersion.sentences.length, 0);
  // A registry-only workspace offers nothing.
  assert.equal(AM.actionBar([act('sde.requirement.write')], { workspaceId: 'research', availability: READY, version: null }).buttons.length, 0);
  assert.doesNotMatch(src('project/actionModel.ts'), /usableKinds/);
  assert.match(src('project/actionModel.ts'), /domain\.lifecycle\.find\(\(s\) => s\.via\.some/);
});

// ---------- U-AP1 ----------

const approval = (o = {}) => ({
  id: 'AP1', projectId: 'p', jobId: 'J1', reason: 'egress.deps', summary: 'Download the npm packages named in package-lock.json once.', status: 'pending',
  request: { recipeId: 'sde.deps.node', profile: 'sde-node', registries: ['registry.npmjs.org'], lockfileSha256: 'd'.repeat(64), estimatedBytes: 300 * 2 ** 20 },
  requestedAt: NOW - 60_000, expiresAt: NOW + 14 * 60_000, decidedAt: null, decision: null, consumedAt: null, imageBuild: null, ...o
});

test('U-AP1 approval rows say in plain words what is reached or downloaded, the size and the expiry, and only "Allow once" / "Do not allow"', () => {
  const fmt = () => '14:32';
  const v = AM.approvalRow(approval(), NOW, fmt);
  assert.equal(v.title, 'Download the add-ons your project needs');
  assert.equal(v.summary, 'Nexus needs to download the add-ons your project lists. It may connect to only registry.npmjs.org, for this one request.', 'plain words, from what the request really holds');
  assert.equal(v.recorded, 'Download the npm packages named in package-lock.json once.', 'the sentence as Nexus recorded it is kept, behind More details');
  assert.deepEqual(v.facts.find((f) => f.label === 'Connects to'), { label: 'Connects to', value: 'registry.npmjs.org' });
  assert.equal(v.facts.find((f) => f.label === 'Download size').value, 'about 0.2 GB');
  assert.equal(v.facts.some((f) => /sha256|lockfile/i.test(`${f.label} ${f.value}`)), false, 'no fingerprint in the plain facts');
  assert.equal(v.details.find((f) => f.label === 'Fingerprint of the add-on list').value, `sha256:${'d'.repeat(12)}`, 'the fingerprints sit behind More details');
  assert.equal(v.expires, 'Expires at 14:32 (in 14 min)');
  assert.deepEqual(v.answers, ['Allow once', 'Do not allow']);
  for (const s of ['approved', 'denied', 'expired', 'withdrawn']) assert.deepEqual(AM.approvalRow(approval({ status: s, decidedAt: NOW }), NOW, fmt).answers, [], s);
  assert.deepEqual(AM.approvalRow(approval({ expiresAt: NOW - 1 }), NOW, fmt).answers, [], 'a lapsed request offers nothing');
  const img = AM.approvalRow(approval({ reason: 'image.prepare', request: { profile: 'sde-python', estimatedBytes: 600 * 2 ** 20, contextSha256: 'e'.repeat(64) } }), NOW, fmt);
  assert.equal(img.title, 'Prepare the safe-space kit for Python projects');
  assert.equal(AM.approvalRow(approval({ reason: 'image.prepare', request: { profile: 'sde-node' } }), NOW, fmt).title, 'Prepare the safe-space kit for JavaScript (Node) projects');
  assert.equal(AM.approvalRow(approval({ reason: 'image.prepare', request: { profile: 'nexus-fwd' } }), NOW, fmt).title, 'Prepare the safe-space kit for trying your app');
  for (const profile of ['sde-node', 'sde-python', 'nexus-fwd', 'something-new']) {
    const t = AM.approvalRow(approval({ reason: 'image.prepare', request: { profile } }), NOW, fmt);
    assert.doesNotMatch(`${t.title} ${t.summary} ${t.facts.map((f) => `${f.label} ${f.value}`).join(' ')}`, /sde-|nexus-fwd|something-new|sha256|image/i, 'no id, fingerprint or "image" in what a person reads first');
  }
  assert.match(img.summary, /Docker uses the internet for this, and in this version Nexus cannot limit which websites it visits/, 'the honest limit of the kit download is kept');
  assert.equal(AM.approvalRow(approval({ reason: 'repo.write_refs', request: {} }), NOW, fmt).title, 'Let Nexus keep hidden Nexus notes in your project');
  assert.doesNotMatch(AM.approvalRow(approval({ reason: 'repo.write_refs', request: {} }), NOW, fmt).summary, /refs|worktree|index|objects|branch/i);
  // No "always", no "for this session" anywhere in the approval UI.
  const ui = src('project/ApprovalsSection.tsx');
  assert.doesNotMatch(ui, /always|for (the|this) session/i);
  assert.match(ui, /nexusClient\.approvalRespond\(id, decision\)/);
  assert.match(ui, /answer\(a\.id, 'once'\)/);
  assert.match(ui, /answer\(a\.id, 'deny'\)/);
});

// ---------- U-H1 to U-H5 ----------

const health = (o = {}) => ({
  db: { version: 9, platform: true, handoffs: true, execution: true }, registry: { valid: true, problems: 0 },
  runner: { state: 'ready', attached: true, restarts: 0 },
  docker: { state: 'running', version: '29.1.3', cpus: 8, memoryBytes: 8 * GIB },
  images: [{ profile: 'sde-node', present: true, matches: true, sizeBytes: GIB, imageIdShort: 'sha256:0123456789ab' }],
  disk: { dataHomeFreeBytes: 52 * GIB, requiredBytes: 30 * GIB, recommendedBytes: 40 * GIB, leaseFloorBytes: 5 * GIB, gate: 'ok' },
  problems: [], gpu: { detected: false, supported: false }, checkedAt: NOW, ...o
});
const rowOf = (h, id, ctx) => X.setupSheet(h, ctx).find((r) => r.id === id);

test('U-H1 disk below the gate (ruled, final review C2): an advisory with the exact numbers; tasks run, only preparing a kit waits', () => {
  const h = health({ images: [{ profile: 'sde-node', present: true, matches: true }, { profile: 'sde-python', present: false, matches: false }],
    disk: { dataHomeFreeBytes: 18 * GIB, requiredBytes: 30 * GIB, recommendedBytes: 40 * GIB, leaseFloorBytes: 5 * GIB, gate: 'below_required' }, problems: ['disk_low', 'image_missing:sde-python'] });
  const r = rowOf(h, 'disk');
  assert.equal(r.text, 'You have 18 GB free. Getting the safe-space kits ready and running checks needs 30 GB (40 GB is better).');
  assert.equal(r.state, 'advisory', 'below 30 GB is an advisory, not a blocker');
  assert.equal(r.word, 'Tasks run; kits cannot be prepared');
  assert.match(r.action, /^Tasks can still run while there is room for their results\. Free up space .* Then you can prepare the safe-space kits\.$/);
  // Only preparing a kit is unavailable, with the reason in numbers.
  const img = rowOf(h, 'image:sde-python');
  assert.equal(img.prepare, null);
  assert.equal(img.action, 'You can prepare it once you have 30 GB free.');
  // Availability is not `setup` for this reason: main's `disk_low` gate id alone blocks nothing.
  const ready = health({ disk: h.disk, problems: ['disk_low'] });
  const a = X.availabilityFrom({ unavailable: null }, { ok: true, data: ready });
  assert.equal(a.kind, 'ready');
  assert.deepEqual(a.advisories, ['You have 18 GB free. Getting the safe-space kits ready and running checks needs 30 GB (40 GB is better).']);
  assert.deepEqual(X.noticeFor(a), { text: a.advisories[0], setup: true });
  assert.equal(X.setupLead(a, X.setupSheet(ready)), 'Tasks can run on this computer.');
  // Heavy actions are not disabled for it: with main's answer "available", the run buttons stay.
  const bar = AM.actionBar([{ actionId: 'sde.build.run', label: 'Build', stepId: 'build', available: true, reason: null, needsApproval: false,
    inputs: [{ slot: 'repository', kinds: ['repository'], min: 1, max: 1 }] }], { workspaceId: 'sde', availability: a, version: { kind: 'repository', status: 'active' } });
  assert.deepEqual(bar.buttons.map((b) => b.actionId), ['sde.build.run']);
  // Below the lease floor no job starts: that alone is a setup problem, with the floor in numbers.
  const floor = health({ disk: { ...h.disk, dataHomeFreeBytes: 3 * GIB }, problems: ['disk_low'] });
  const f = X.availabilityFrom({ unavailable: null }, { ok: true, data: floor });
  assert.deepEqual([f.kind, f.problems], ['setup', ['disk_low']]);
  const fr = rowOf(floor, 'disk');
  assert.deepEqual([fr.state, fr.text], ['problem', 'You have 3 GB free. Getting the safe-space kits ready and running checks needs 30 GB (40 GB is better). Below 5 GB, no task can start.']);
  // 35 GB: it runs, below the recommendation (never stated as a problem).
  const mid = rowOf(health({ disk: { ...h.disk, dataHomeFreeBytes: 35 * GIB, gate: 'below_recommended' } }), 'disk');
  assert.deepEqual([mid.state, mid.text], ['advisory', 'You have 35 GB free. Getting the safe-space kits ready and running checks needs 30 GB (40 GB is better).']);
  // Not measured: never ready.
  const unk = X.availabilityFrom({ unavailable: null }, { ok: true, data: health({ disk: { ...h.disk, dataHomeFreeBytes: null, gate: 'unknown' }, problems: ['disk_low'] }) });
  assert.equal(unk.kind, 'unknown');
  assert.equal(X.gb(18.96 * GIB), '18.9 GB', 'free space is never rounded up');
});

test('U-H2 Docker stopped: a problem with the action, and no kit can be prepared', () => {
  const h = health({ docker: { state: 'stopped' }, images: [{ profile: 'sde-node', present: false, matches: false }], problems: ['docker_stopped'] });
  const d = rowOf(h, 'docker');
  assert.deepEqual([d.state, d.text, d.action], ['problem', 'Docker is not running.', 'Open Docker Desktop and wait until it says it is running. Then press Check again.']);
  assert.equal(rowOf(h, 'image:sde-node').prepare, null);
  assert.equal(X.availabilityFrom({ unavailable: null }, { ok: true, data: h }).kind, 'setup');
  assert.equal(rowOf(health({ docker: { state: 'missing' } }), 'docker').text, 'Docker is not installed. It is a free program.');
});

test('U-H3 Docker memory low: the numbers and where to change it', () => {
  const r = rowOf(health({ docker: { state: 'running', cpus: 4, memoryBytes: 2 * GIB }, problems: ['docker_memory_low'] }), 'memory');
  assert.deepEqual([r.state, r.text], ['problem', 'Docker has 2 GB of memory. Nexus needs 4 GB.']);
  assert.match(r.action, /^Open Docker Desktop and go to Settings > Resources\. Set memory to 4 GB, then press Check again\.$/, 'the path in the other app is stated');
  assert.equal(r.label, 'Memory for Docker');
});

test('U-H4 kit missing: "Prepare this kit (about <size>)" only with a stated size, and only when it can be asked', () => {
  const h = health({ images: [{ profile: 'sde-python', present: false, matches: false }], problems: ['image_missing:sde-python'] });
  assert.deepEqual(rowOf(h, 'image:sde-python').prepare, { profile: 'sde-python', label: 'Prepare this kit' }, 'no size without a source');
  assert.equal(rowOf(h, 'image:sde-python').label, 'Safe-space kit for Python projects', 'a kit is named for what it is for, never by its id');
  const sized = rowOf(h, 'image:sde-python', { estimates: new Map([['sde-python', 0.6 * GIB]]) });
  assert.equal(sized.prepare.label, 'Prepare this kit (about 0.6 GB)');
  assert.equal(rowOf(h, 'image:sde-python', { pending: new Set(['sde-python']) }).prepare, null, 'an open request is answered instead');
  const a = X.availabilityFrom({ unavailable: null }, { ok: true, data: h });
  assert.deepEqual([a.kind, a.problems, a.profiles], ['setup', ['image_missing'], ['sde-python']]);
  assert.equal(X.prepareLabel(GIB, true), 'Prepare this kit again (about 1 GB)');
  assert.equal(X.PREPARE_ALL_LABEL, 'Prepare the safe-space kits');
});

test('U-H5 the GPU line, exactly', () => {
  assert.equal(X.gpuLine({ detected: true, model: 'RTX 3050 Laptop', supported: false }), 'GPU (graphics chip) found: RTX 3050 Laptop. Nexus does not use it yet.');
  assert.equal(X.gpuLine({ detected: false, supported: false }), 'No GPU (graphics chip) found. Nexus does not need one.');
  assert.equal(rowOf(health({ gpu: { detected: true, model: 'RTX 3050 Laptop', supported: false } }), 'gpu').text, 'GPU (graphics chip) found: RTX 3050 Laptop. Nexus does not use it yet.');
  assert.equal(rowOf(health(), 'gpu').prepare, null);
});

test('availability: platform off, execution off for every sub-reason (including a channel main never registered), ready', () => {
  assert.equal(X.availabilityFrom({ unavailable: { reason: 'held' } }, null).kind, 'platform_off');
  assert.equal(X.availabilityFrom({ unavailable: null }, null).kind, 'unknown');
  for (const sub of ['held', 'auto_held', 'backup_failed', 'failed', 'shape', 'not_enabled', 'v8_unavailable', 'registry_invalid', 'not_started', 'unreachable']) {
    const a = X.availabilityFrom({ unavailable: null }, { ok: false, code: 'platform_unavailable', reason: 'execution_unavailable', subReason: sub, message: 'm' });
    assert.equal(a.kind, 'execution_off', sub);
    assert.equal(a.text, E.executionNotice(sub));
    assert.doesNotMatch(a.text, /\b[a-z]+_[a-z_]+\b/, `${sub}: no raw reason`);
  }
  assert.equal(X.availabilityFrom({ unavailable: null }, { ok: true, data: health({ db: { version: 9, platform: true, handoffs: true, execution: false, subReason: 'held' } }) }).subReason, 'held');
  assert.equal(X.availabilityFrom({ unavailable: null }, { ok: true, data: health({ registry: { valid: false, problems: 2 } }) }).subReason, 'registry_invalid');
  assert.equal(X.availabilityFrom({ unavailable: null }, { ok: true, data: health() }).kind, 'ready');
  assert.equal(X.noticeFor({ kind: 'ready', advisories: [] }), null);
  assert.deepEqual(X.noticeFor({ kind: 'execution_off', subReason: 'unreachable', text: 'x' }), { text: 'x', setup: false });
});

test('a rejected or unregistered execution call answers "execution unreachable", never a throw', async () => {
  global.window = { cth: { nexusJobsList: () => Promise.reject(new Error("No handler registered for 'nexus:jobs:list'")) } };
  try {
    const r = await C.nexusClient.jobsList({ projectId: 'p' });
    assert.deepEqual([r.ok, r.code, r.reason, r.subReason], [false, 'platform_unavailable', 'execution_unavailable', 'unreachable']);
    const missing = await C.nexusClient.platformHealth();
    assert.equal(missing.subReason, 'unreachable', 'a method the preload lacks');
    assert.equal(typeof C.nexusClient.onHint(() => {}), 'function', 'no push channel: a no-op unsubscribe');
    assert.equal(E.errorCopy('platform_unavailable', 'execution_unavailable', 'unreachable').kind, 'execution_unavailable');
  } finally { delete global.window; }
  assert.match(C.newIntentId(), /^[0-9A-HJKMNP-TV-Z]{26}$/);
});

test('the setup sentences are main\'s, word for word', () => {
  const { SETUP_MESSAGES } = loadTs('src/main/nexusIpc/envelope.ts');
  assert.deepEqual({ ...E.SETUP_TEXT }, { ...SETUP_MESSAGES });
  assert.equal(E.execFailText({ code: 'unavailable', reason: 'setup:docker_stopped' }), SETUP_MESSAGES.docker_stopped);
  // errorCopy itself keeps the generic sentence for `unavailable` (AR2 in nexus-platform-exec-approvals pins it).
  assert.equal(E.errorCopy('unavailable', 'setup:disk_low').text, 'This cannot run on this computer yet. Open “Get this computer ready” to see what is missing.');
  assert.equal(E.errorCopy('invalid', 'queue_full').text, E.EXEC_REASON_TEXT.queue_full);
});

// ---------- U-D1 ----------

const dep = (o = {}) => ({ id: 'D1', projectId: 'p', subjectVersionId: 'V1', jobId: 'J1', status: 'healthy', stopReason: null, url: 'http://127.0.0.1:49152/health',
  bindAddress: '127.0.0.1', hostPort: 49152, healthPath: '/health', lastProbe: { at: NOW, status: 200, ms: 12 }, probes: 4, startedAt: NOW, stoppedAt: null, endsAt: NOW + 7_200_000, ...o });

test('U-D1 deployment rows: a URL only while healthy or unhealthy, always http://127.0.0.1:<port>; status words', () => {
  const fmt = () => '10:00';
  for (const [status, word] of [['starting', 'Starting'], ['healthy', 'Working'], ['unhealthy', 'Not answering'], ['stopped', 'Stopped'], ['failed', 'Failed']]) {
    const v = AM.deploymentRow(dep({ status }), fmt);
    assert.equal(v.word, word, status);
    assert.equal(v.url, status === 'healthy' || status === 'unhealthy' ? 'http://127.0.0.1:49152' : null, status);
    assert.equal(v.canStop, ['starting', 'healthy', 'unhealthy'].includes(status), status);
  }
  // Never another host, whatever the view says.
  assert.equal(AM.deploymentRow(dep({ url: 'http://0.0.0.0:80/', hostPort: 80 })).url, 'http://127.0.0.1:80');
  assert.equal(AM.deploymentRow(dep({ hostPort: null })).url, null);
  assert.equal(AM.deploymentRow(dep({ hostPort: 70000 })).url, null);
  assert.equal(AM.deploymentRow(dep(), fmt).facts[0].value, 'your app answered, in 12 ms, at 10:00');
  assert.equal(AM.deploymentRow(dep({ lastProbe: { at: NOW, status: 500, ms: 3 } }), fmt).facts[0].value, 'your app answered with an error (code 500), in 3 ms, at 10:00');
  assert.equal(AM.deploymentRow(dep({ lastProbe: { at: NOW, status: null, ms: null } }), fmt).facts[0].value, 'no answer, at 10:00');
  assert.match(AM.deploymentRow(dep({ status: 'stopped', stopReason: 'idle', stoppedAt: NOW }), fmt).facts.find((f) => f.label === 'Stopped').value, /\(it was not used for a while\)/, 'a stop reason is words, never a code');
});

// ---------- hints: coalesced, only the affected lists ----------

test('a page of events re-reads only the lists it touches', () => {
  const t = (type, summary = 'x') => ({ type, summary });
  assert.deepEqual([...X.affectedLists([t('approval')])].sort(), ['approvals', 'jobs']);
  assert.deepEqual([...X.affectedLists([t('attempt.progress'), t('attempt.output')])], ['jobs']);
  assert.deepEqual([...X.affectedLists([t('job.transition', 'job running -> completed')])].sort(), ['artifacts', 'jobs', 'validations']);
  assert.deepEqual([...X.affectedLists([t('job.transition', 'job queued -> leased')])], ['jobs']);
  assert.deepEqual([...X.affectedLists([t('deployment')])].sort(), ['artifacts', 'deployments']);
  const hook = src('data/useExecution.ts');
  assert.match(hook, /export const HINT_COALESCE_MS = 300;/);
  assert.match(hook, /if \(!timer && !pulling\) timer = setTimeout/, 'one pull at a time, coalesced');
  assert.equal((hook.match(/nexusClient\.onHint\(/g) || []).length, 1, 'one subscription shared by every hook');
});

// ---------- writing sheet content ----------

test('a requirement and a problem statement are built to the schemas main checks', () => {
  assert.deepEqual(AM.requirementContent({ title: ' T ', body: '', criteria: [{ id: 'C1', text: ' a ' }, { id: 'C2', text: '' }] }),
    { content: { title: 'T', criteria: [{ id: 'C1', text: 'a' }] } });
  assert.equal(AM.requirementContent({ title: 'T', body: '', criteria: [{ id: 'C1', text: '' }] }).problem, 'Add at least one acceptance criterion.');
  assert.equal(AM.nextCriterionId([{ id: 'C1' }, { id: 'C3' }]), 'C4');
  assert.deepEqual(AM.problemContent({ question: 'Why?', context: '', audience: '', successCriteria: ['a', ' '], constraints: [] }),
    { content: { question: 'Why?', successCriteria: ['a'] } });
});

// ---------- pins ----------

const NEW_FILES = ['data/useExecution.ts', 'data/executionModel.ts', 'runs/jobRunModel.ts', 'runs/JobLogSheet.tsx', 'project/evidenceModel.ts',
  'project/EvidenceSection.tsx', 'project/kindViewers.tsx', 'project/ActionBar.tsx', 'project/ApprovalsSection.tsx', 'project/DeploymentsSection.tsx',
  'project/RequirementSheet.tsx', 'project/actionModel.ts', 'project/execContext.ts', 'components/ExecutionSetupSheet.tsx', 'components/ExecutionNotice.tsx',
  'styles/execution.css'];

test('pin: ProjectRuns still renders the session requests (useRuns) under the persisted Jobs', () => {
  const runs = src('runs/ProjectRuns.tsx');
  assert.match(runs, /useRuns\(\)\.filter\(\(e\) => e\.request\.projectId === projectId\)\.reverse\(\)/);
  assert.match(runs, /<RunStrip/);
  assert.ok(runs.indexOf('<JobsSection') < runs.indexOf('<RunStrip'), 'Jobs above the requests');
  assert.match(runs, /nexusClient\.jobCancel\(job\.id\)/);
  assert.match(runs, /nexusClient\.jobRetry\(job\.id, id\)/);
});

test('pin: no new file holds card, dashboard, gradient, percentage text, office words or persona names; no peer imports', () => {
  const { copyItems, scanText } = require('./helpers/identityGuard.cjs');
  for (const f of NEW_FILES) {
    const s = src(f);
    assert.doesNotMatch(s, /\bcards?\b|-card\b|Card\b|dashboard|gradient/i, f);
    assert.doesNotMatch(s, /routes\/RouteView|WelcomePage|hairline|from '\.\.\/state\/uiStore'/, `${f}: no peer import`);
    if (f.endsWith('.css')) continue;
    // Shown text only (string literals and JSX text), with the identity guard's own rules.
    for (const it of copyItems(path.join(NEXUS, f))) {
      assert.deepEqual(scanText(it.text, true), [], `${f}: ${it.text}`);
      assert.doesNotMatch(it.text, /\d\s*%|^%|percent/i, `${f}: no percentage text: ${it.text}`);
    }
  }
});

test('pin: status is always a word in the models (never a colour-only state)', () => {
  for (const h of HEADLINES) assert.ok(R.jobRun(job({ headline: h })).word, h);
  for (const r of X.setupSheet(health({ docker: { state: 'stopped' } }))) assert.ok(r.word && r.text, r.id);
  for (const s of ['passed', 'failed', 'error', 'skipped', null]) assert.ok(EV.statusWord(s), String(s));
  // The CSS keys a state only on rows that also print their word.
  assert.match(src('components/ExecutionSetupSheet.tsx'), /data-state=\{r\.state\}>[\s\S]*?<span className="nx-xs__word">\{r\.word\}<\/span>/);
});

test('pin: execution.css is imported and uses only existing tokens', () => {
  assert.match(src('styles/index.css'), /@import '\.\/execution\.css';/);
  const css = src('styles/execution.css');
  const tokens = src('styles/tokens.css');
  for (const v of new Set(css.match(/var\(--nx-[a-z0-9-]+\)/g) || [])) assert.ok(tokens.includes(`${v.slice(4, -1)}:`), v);
});

test('pin: the bench lends the Folio its sheets and mounts the notice and the approvals', () => {
  const bench = src('project/ProjectBench.tsx');
  assert.match(bench, /<ExecutionUiContext\.Provider value=\{execUi\}>/);
  assert.match(bench, /<ExecutionNotice availability=\{availability\} onSetup=\{execUi\.openSetup\} \/>/);
  assert.match(bench, /<ApprovalsSection projectId=\{project\.id\} except=\{hasSde \? \['repo\.write_refs'\] : \[\]\} \/>/);
  const passport = src('project/ArtifactPassport.tsx');
  for (const c of ['<KindViewer', '<EvidenceSection', '<ActionBar', '<DeploymentsSection']) assert.ok(passport.includes(c), c);
});

// ---------- fix round 1 ----------

test('(fix round 1, item 1) before the first probe nothing reads as ready, and the sheet never says tasks can run', () => {
  const unprobed = health({ checkedAt: null, docker: { state: 'unknown' }, disk: { dataHomeFreeBytes: null, requiredBytes: 30 * GIB, recommendedBytes: 40 * GIB, leaseFloorBytes: 5 * GIB, gate: 'unknown' }, problems: [] });
  const a = X.availabilityFrom({ unavailable: null }, { ok: true, data: unprobed });
  assert.deepEqual([a.kind, a.checking], ['unknown', true]);
  assert.match(a.text, /Nexus has not checked this computer yet/);
  assert.deepEqual(X.noticeFor(a), { text: a.text, setup: true }, 'the notice shows, with "Get this computer ready"');
  assert.notEqual(X.setupLead(a, X.setupSheet(unprobed)), 'Tasks can run on this computer.');
  // Checked, but Docker or the disk still unknown: still not ready.
  for (const h of [health({ docker: { state: 'unknown' } }), health({ disk: { dataHomeFreeBytes: null, requiredBytes: 30 * GIB, recommendedBytes: 40 * GIB, leaseFloorBytes: 5 * GIB, gate: 'unknown' } })]) {
    assert.equal(X.availabilityFrom({ unavailable: null }, { ok: true, data: h }).kind, 'unknown');
  }
  // The lead says tasks can run only when ready and every row is fine.
  const ready = X.availabilityFrom({ unavailable: null }, { ok: true, data: health() });
  assert.equal(X.setupLead(ready, X.setupSheet(health())), 'Tasks can run on this computer.');
  assert.equal(X.setupLead(ready, X.setupSheet(health({ runner: { state: 'x', attached: false, restarts: 0 } }))), null);
  assert.match(src('components/ExecutionSetupSheet.tsx'), /const lead = setupLead\(availability, rows\);/);
  assert.doesNotMatch(src('components/ExecutionSetupSheet.tsx'), /availability\.kind === 'ready' && <p/);
  // "Tasks can run" sits behind More details (the steps above it say it first); the notice shows on top only when there are no steps to read.
  assert.match(src('components/ExecutionSetupSheet.tsx'), /availability\.kind !== 'setup' && availability\.kind !== 'ready' && notice && <p className="nx-xs__lead">\{notice\.text\}<\/p>/);
});

test('(fix round 1) git_missing is a problem and a row of the sheet, never ready', () => {
  const h = health({ problems: ['git_missing'] });
  const a = X.availabilityFrom({ unavailable: null }, { ok: true, data: h });
  assert.deepEqual([a.kind, a.problems], ['setup', ['git_missing']]);
  const r = X.setupSheet(h).find((x) => x.id === 'git');
  assert.deepEqual([r.state, r.text], ['problem', 'Git is not installed. It is a free program that keeps the history of your project.']);
  assert.equal(r.action, 'Install Git, then restart Nexus.');
  assert.equal(X.setupSheet(health()).some((x) => x.id === 'git'), false, 'no claim about git when main says nothing');
});

test('(fix round 1, item 5) an unknown headline reads neutrally, never "Failed"; validating reads "Checking"', () => {
  const v = R.jobRun(job({ headline: 'waiting:something_new', state: 'queued' }));
  assert.doesNotMatch(`${v.headline} ${v.word}`, /fail/i);
  const u = R.jobRun(job({ headline: 'brand_new', state: 'completed' }));
  assert.equal(u.headline, 'Status: completed');
  assert.equal(u.word, 'Status unknown');
  assert.equal(R.jobRun(job({ headline: 'validating', state: 'completed' })).word, 'Checking');
  // The message stored with an error is never shown: an unknown code reads the generic words, a known code its own plain sentence.
  const raw = R.jobRun(job({ headline: 'failed', state: 'failed', error: { code: 'x', message: 'Out of memory.' } }));
  assert.equal(raw.headline, 'Failed: Something went wrong while this ran');
  assert.doesNotMatch(raw.headline, /memory/i, 'the raw message is not displayed');
  assert.match(raw.next, /Press Retry/);
  const oom = R.jobRun(job({ headline: 'failed', state: 'failed', error: { code: 'oom', message: 'the container ran out of memory (exit 137)' } }));
  assert.equal(oom.headline, 'Failed: It ran out of memory, so Nexus stopped it');
  assert.doesNotMatch(oom.headline, /137|container/);
});

test('(fix round 1, item 8) one shared health read, re-read on preflight and recovery, polled while the sheet is open; previews keep their pages', () => {
  const hook = src('data/useExecution.ts');
  assert.equal((hook.match(/nexusClient\.platformHealth\(\)/g) || []).length, 1, 'one read site');
  assert.match(hook, /if \(healthInFlight \|\| \(!force && healthLoadedTick === st\.ticks\.health\)\) return;/);
  assert.match(hook, /export const HEALTH_POLL_MS = 15_000;/);
  assert.match(src('components/ExecutionSetupSheet.tsx'), /useHealthPoll\(true\);/);
  for (const t of ['preflight', 'recovery']) assert.ok(X.affectedLists([{ type: t, summary: '' }]).has('health'), t);
  const viewers = src('project/kindViewers.tsx');
  assert.match(viewers, /\}, \[versionId, part\]\);/, 'pages reset only for another version or part');
  assert.match(viewers, /if \(tick === firstTick\.current \|\| pageCount\.current > 1\) return;/);
});

test('(fix round 1, item 8) a finished job re-reads only new, changed or draft versions', () => {
  const SM = loadTs('src/renderer/src/nexus/project/spineModel.ts');
  const wanted = [{ versionId: 'A', status: 'candidate' }, { versionId: 'B', status: 'draft' }, { versionId: 'C', status: 'active' }, { versionId: 'D', status: 'candidate' }];
  const readAt = new Map([['A', 'candidate'], ['B', 'draft'], ['C', 'candidate']]);
  assert.deepEqual(SM.versionsToRead(wanted, readAt).map((w) => w.versionId), ['B', 'C', 'D']);
  const bench = src('project/ProjectBench.tsx');
  assert.match(bench, /const todo = versionsToRead\(wanted, readAt\);/);
  assert.doesNotMatch(bench, /function useSpineChecks|function useRailChecks/);
});

test('(fix round 1, item 9) execution actions word their failures with execFailText', () => {
  for (const f of ['project/ApprovalsSection.tsx', 'project/EvidenceSection.tsx', 'runs/ProjectRuns.tsx', 'runs/JobLogSheet.tsx', 'project/ActionBar.tsx',
    'project/DeploymentsSection.tsx', 'components/ExecutionSetupSheet.tsx']) {
    const s = src(f);
    assert.match(s, /execFailText\(/, f);
    assert.doesNotMatch(s, /errorCopy\(r\.code/, `${f}: a failed action never uses the generic copy`);
  }
});

test('(fix round 1, item 10) approving moves focus into the confirmation and back on Cancel or Escape', () => {
  const s = src('project/ApprovalsSection.tsx');
  assert.match(s, /useEffect\(\(\) => \{ if \(confirming\) cancelRef\.current\?\.focus\(\); \}, \[confirming\]\);/);
  assert.match(s, /approveRefs\.current\.get\(returnTo\)\?\.focus\(\)/);
  assert.match(s, /<button ref=\{cancelRef\} type="button" className="nx-btn" disabled=\{pending !== null\} onClick=\{\(\) => cancelConfirm\(a\.id\)\}>/);
  assert.match(s, /onKeyDown=\{onConfirmKey\(a\.id\)\}/);
});

test('(fix round 1, item 11) the Runs tool does not repeat the bench notice', () => {
  assert.doesNotMatch(src('runs/ProjectRuns.tsx'), /<ExecutionNotice/);
  assert.equal((src('project/ProjectBench.tsx').match(/<ExecutionNotice/g) || []).length, 1);
});

test('(fix round 1, item 13) the loopback address opens through a guarded helper; failed list reads say so', async () => {
  const calls = [];
  global.window = { cth: { openExternal: (u) => { calls.push(u); return Promise.resolve({ ok: u.endsWith(':8080') }); } } };
  try {
    assert.deepEqual(await C.openLoopbackUrl('http://127.0.0.1:8080'), { ok: true });
    assert.deepEqual(await C.openLoopbackUrl('http://127.0.0.1:9090'), { ok: false }, 'main refused it');
    for (const bad of ['http://0.0.0.0:80', 'https://127.0.0.1:80', 'http://127.0.0.1:99999', 'http://127.0.0.1:80/x', 'http://localhost:80']) {
      assert.deepEqual(await C.openLoopbackUrl(bad), { ok: false }, bad);
    }
    assert.deepEqual(calls, ['http://127.0.0.1:8080', 'http://127.0.0.1:9090'], 'a refused address is never handed to the shell');
    global.window = { cth: { openExternal: () => Promise.reject(new Error('x')) } };
    assert.deepEqual(await C.openLoopbackUrl('http://127.0.0.1:8080'), { ok: false });
  } finally { delete global.window; }
  const dep = src('project/DeploymentsSection.tsx');
  assert.doesNotMatch(dep, /window\.cth/);
  assert.match(dep, /const r = await openLoopbackUrl\(url\);/);
  assert.match(dep, /Nexus could not load the test runs\./);
  assert.match(src('project/ActionBar.tsx'), /Nexus could not load the actions here\./);
});

test('(fix round 1, item 14) the hint pull stops when the cursor does not move', () => {
  assert.match(src('data/useExecution.ts'), /if \(knownSeq <= before\) break;/);
});

// ---------- final review C (renderer) ----------

test('C5 the derived name collapses whitespace: a newline in the question never breaks the save', () => {
  assert.equal(AM.derivedName('', 'Why do\nusers\r\n  churn?\t'), 'Why do users churn?');
  assert.equal(AM.derivedName('  My\nname ', 'ignored'), 'My name');
  assert.equal(AM.derivedName(' \n ', 'Fallback title'), 'Fallback title');
  assert.ok(!/\s{2}|\n/.test(AM.derivedName('', `${'a '.repeat(100)}\n${'b'.repeat(50)}`)));
  assert.ok(AM.derivedName('', 'x'.repeat(300)).length <= 120);
  const sheet = src('project/RequirementSheet.tsx');
  assert.match(sheet, /const title = derivedName\(name, kind === 'requirement' \? req\.title : prob\.question\);/);
});

test('C7 PLACED_ACTIONS says where each lives; the diagnostic report pages and says when it is larger than one page', () => {
  const am = src('project/actionModel.ts');
  assert.match(am, /Stop and Diagnose live on the dev deployment row\. A run row does not offer\n \*  Diagnose in this release\./);
  assert.doesNotMatch(src('runs/ProjectRuns.tsx'), /sde\.diagnose/, 'the comment matches the code: no Diagnose on run rows');
  const kv = src('project/kindViewers.tsx');
  assert.equal(EV.partialReportNote(65536, 200000), 'This report is too long for one page: 65536 of 200000 bytes loaded so far. Its facts show once all of it is loaded.');
  assert.equal(EV.partialReportNote(10, null), 'This report is too long for one page. Its facts show once all of it is loaded.');
  const diag = kv.slice(kv.indexOf('function DiagnosticReport'), kv.indexOf('function Repository'));
  assert.match(diag, /if \(c\.more\) \{[\s\S]*partialReportNote\(c\.readBytes, c\.totalBytes\)[\s\S]*<Button variant="quiet" onClick=\{c\.more\}>Show more<\/Button>/);
  assert.ok(diag.indexOf('if (c.more)') < diag.indexOf('reportFacts(c.json)'), 'never "no fact" from part of a report');
});

test('C3 "Check again" asks main for a fresh probe (#23 { probe: true }) and keeps the "Checked at" line', async () => {
  const sheet = src('components/ExecutionSetupSheet.tsx');
  assert.match(sheet, /<Button variant="primary" icon="refresh" onClick=\{checkAgain\}>Check again<\/Button>/);
  assert.match(sheet, /<p className="nx-muted">\{checkedLine\(health\.checkedAt\)\}<\/p>/, 'the "Checked at" line sits behind More details');
  const hook = src('data/useExecution.ts');
  assert.match(hook, /function checkAgain\(\): void \{\n  void nexusClient\.platformHealthProbe\(\)\.then\(\(r\) => \{\n    useExecStore\.getState\(\)\.setHealth\(r\);\n    setTimeout\(\(\) => loadHealth\(true\), CHECK_AGAIN_REREAD_MS\);/);
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'index.ts'), 'utf8');
  assert.match(preload, /nexusPlatformHealth: \(query\?: HealthQuery\): Promise<NexusResult<HealthView>> =>\n    ipcRenderer\.invoke\('nexus:platform:health', \.\.\.\(query \? \[\{ probe: true \}\] : \[\]\)\),/,
    'the preload sends only the fixed flag, never what the renderer passed');
  // The client sends exactly { probe: true }; a plain read sends no argument.
  const calls = [];
  const prev = global.window;
  global.window = { cth: { nexusPlatformHealth: async (...a) => { calls.push(a); return { ok: true, data: null }; } } };
  try {
    await C.nexusClient.platformHealthProbe();
    await C.nexusClient.platformHealth();
  } finally { global.window = prev; }
  assert.deepEqual(calls, [[{ probe: true }], []]);
  assert.equal(X.checkedLine(NOW, () => '14:05'), 'Checked at 14:05.');
  assert.equal(X.checkedLine(null), 'Nexus has not checked this computer yet.');
});

test('final fix: the new labels read as words (unreadable_output_entry, start_window_unobserved); Check again re-reads after 1.5 s', () => {
  assert.equal(R.jobRun(job({ headline: 'failed', state: 'failed', startedAt: NOW, error: { code: 'unreadable_output_entry', message: 'unreadable_output_entry' } })).headline,
    'Failed: One of the files the task made could not be read');
  assert.equal(R.jobRun(job({ headline: 'failed', state: 'failed', startedAt: NOW, error: { code: 'start_window_unobserved', message: 'start_window_unobserved' } })).headline,
    'Failed: Nexus was closed or stalled while your app was starting, so it could not tell if the app started');
  assert.equal(R.jobRun(job({ headline: 'failed', state: 'failed', error: { code: 'x', message: 'Out of memory.' } })).headline, 'Failed: Something went wrong while this ran', 'an unknown code never shows the stored message');
  assert.match(src('data/useExecution.ts'), /export const CHECK_AGAIN_REREAD_MS = 1_500;/);
});

// ---------- B2a stabilization (workstream B): the screen gaps the fresh-app click-through found ----------

const { getUserAction } = loadTs('src/shared/nexus/actions.ts');
/** main's #24 answer for the SDE actions on a version (as the click-through saw it: discover, deps and build available). */
const sdeAnswer = (available = true) => ['sde.deps.install', 'sde.tests.discover', 'sde.build.run', 'sde.tests.run', 'sde.app.assemble'].map((id) => {
  const def = getUserAction(id);
  return { actionId: id, label: def.label, stepId: null, available, reason: available ? null : 'blocked_by_step:repository', needsApproval: id === 'sde.deps.install',
    inputs: def.inputs.map((s) => ({ ...s })) };
});
test('S1/S2 a project-owned repository version gets the SDE version bar: "Find tests on a commit" and "Build" with the registry\'s input slot', () => {
  // The repository snapshot is project-owned (ownerWorkspaceId null): the bar comes from each active workspace whose actions take it.
  assert.deepEqual(AM.workspacesActingOn('repository', ['sde', 'ml', 'data', 'research']), ['sde']);
  assert.deepEqual(AM.workspacesActingOn('test_suite', ['ml', 'sde']), ['sde']);
  assert.deepEqual(AM.workspacesActingOn('repository', ['ml', 'dl']), [], 'no other domain acts on a repository in B2a');
  for (const status of ['active', 'candidate']) {
    const bar = AM.actionBar(sdeAnswer(), { workspaceId: 'sde', availability: READY, version: { kind: 'repository', status } });
    const ids = bar.buttons.map((b) => b.actionId);
    assert.deepEqual(ids, ['sde.deps.install', 'sde.tests.discover', 'sde.build.run'], status);
    // Each button fills the slot the registry defines for that action (sde.build.run: one repository version).
    for (const b of bar.buttons) assert.equal(b.slot, getUserAction(b.actionId).inputs.find((s) => s.kinds.includes('repository')).slot, b.actionId);
    assert.deepEqual(getUserAction('sde.build.run').inputs, [{ slot: 'repository', kinds: ['repository'], min: 1, max: 1 }]);
  }
  // A draft or failed repository version is not offered; main's refusal gives no button; a setup problem gives the setup sentence.
  assert.equal(AM.actionBar(sdeAnswer(), { workspaceId: 'sde', availability: READY, version: { kind: 'repository', status: 'draft' } }).buttons.length, 0);
  assert.equal(AM.actionBar(sdeAnswer(false), { workspaceId: 'sde', availability: READY, version: { kind: 'repository', status: 'active' } }).buttons.length, 0);
  const setup = AM.actionBar(sdeAnswer(), { workspaceId: 'sde', availability: { kind: 'setup', problems: ['docker_stopped'], profiles: [], text: 't' },
    version: { kind: 'repository', status: 'active' } });
  assert.equal(setup.buttons.length, 0);
  assert.ok(setup.sentences.every((s) => s.setup));
  // Where it renders: the Folio of a project-owned version, one bar per acting workspace, through the same ActionBar.
  const passport = src('project/ArtifactPassport.tsx');
  assert.match(passport, /\{shownVersion && projectOwned\(artifact\) && artifact\.status === 'active' && workspacesActingOn\(artifact\.kind, activeWorkspaces\)\.map\(\(w\) => \(\n\s*<ActionBar key=\{w\} projectId=\{project\.id\} workspaceId=\{w\}/);
  assert.match(passport, /version=\{\{ id: shownVersion\.id, kind: artifact\.kind, status: shownVersion\.status \}\} \/>\n\s*\)\)\}/);
  // The real job API with that version as the input, under one intent; loading, failure (execFailText) and cancellation.
  const bar = src('project/ActionBar.tsx');
  assert.match(bar, /const inputs = slot && version \? \[\{ versionId: version\.id, slot \}\] : \[\];/);
  assert.match(bar, /withIntent\(key, \(intentId\) => nexusClient\.jobStart\(\{ projectId, workspaceId, actionId, inputs, params: \{\}, intentId \}\)\)/);
  assert.match(bar, /\{busy === b\.actionId \? 'Starting…' : /);
  assert.match(bar, /: \{ text: execFailText\(r\), alert: true \}\);/);
  assert.match(bar, /const r = await nexusClient\.jobCancel\(started\.jobId\);/);
  assert.match(bar, /\{cancelling \? 'Cancelling…' : 'Cancel'\}/);
  assert.equal(AM.startedNote('Find tests on a commit', true), 'Find tests on a commit: started. Follow it in Runs.');
  assert.equal(AM.startedNote('Build', false), 'Build: already started. Follow it in Runs.');
});

test('S3 the execution setup sheet opens from the Runs tool in every availability state, ready included', () => {
  const runs = src('runs/ProjectRuns.tsx');
  assert.match(runs, /\{ui && <Button variant="quiet" onClick=\{ui\.openSetup\}>\{GLOSSARY\.getReady\.name\}<\/Button>\}/);
  const jobs = runs.slice(runs.indexOf('function JobsSection'), runs.indexOf('export function ProjectRuns'));
  assert.doesNotMatch(jobs, /availability|useHealth/, 'the link is not gated by any availability state');
  assert.ok(jobs.indexOf('ui.openSetup') < jobs.indexOf('{off &&'), 'shown before (and whatever) the jobs read says');
  // The bench lends the Runs tool the sheet: ProjectRuns renders inside the ExecutionUiContext provider.
  const bench = src('project/ProjectBench.tsx');
  assert.match(bench, /openSetup: \(\) => setSetupOpen\(true\),/);
  assert.match(bench, /<ExecutionSetupSheet open=\{setupOpen\} onClose=\{closeSetup\} \/>/);
  // The sheet itself renders in every state: rows when health was read, a sentence otherwise.
  for (const a of [READY, { kind: 'unknown', text: null, retry: false }, { kind: 'execution_off', subReason: 'held', text: 't' }, { kind: 'platform_off', text: 't' }]) {
    assert.equal(typeof X.setupLead(a, []) === 'string' || X.setupLead(a, []) === null, true);
  }
});

test('S5 image sizes read in KB, MB or GB (never "0 GB" for 71.5 MB); an unknown size reads "unknown"', () => {
  const MIB = 2 ** 20;
  assert.equal(X.sizeLabel(71.5 * MIB), '71.5 MB');
  assert.equal(X.sizeLabel(60 * MIB), '60 MB');
  assert.equal(X.sizeLabel(4 * MIB), '4 MB');
  assert.equal(X.sizeLabel(1.25 * GIB), '1.3 GB');
  assert.equal(X.sizeLabel(512 * 1024), '512 KB');
  assert.equal(X.sizeLabel(900), '900 bytes');
  for (const bad of [NaN, Infinity, -1, undefined, null]) assert.equal(X.sizeLabel(bad), 'unknown');
  const h = health({ images: [{ profile: 'sde-node', present: true, matches: true, sizeBytes: 71.5 * MIB, imageIdShort: 'sha256:abcdef012345' },
    { profile: 'sde-python', present: true, matches: true, sizeBytes: 60 * MIB }, { profile: 'nexus-fwd', present: true, matches: true, sizeBytes: 4 * MIB }] });
  const rows = X.setupSheet(h);
  assert.equal(rows.find((r) => r.id === 'image:sde-node').text, 'Ready (71.5 MB on your disk).', 'no image fingerprint is shown');
  assert.equal(rows.find((r) => r.id === 'image:sde-python').text, 'Ready (60 MB on your disk).');
  assert.equal(rows.find((r) => r.id === 'image:nexus-fwd').text, 'Ready (4 MB on your disk).');
  assert.ok(rows.every((r) => !/\b0 GB\b/.test(r.text)), 'no "0 GB" anywhere');
  // The gate's own numbers keep their GB wording (free disk is never overstated).
  assert.equal(X.gb(18.96 * GIB), '18.9 GB');
});

test('S6 a run log reads as lines: a time, a stream marker and the text; anything else is shown safely as raw text', () => {
  const LG = loadTs('src/renderer/src/nexus/runs/logModel.ts');
  const fmt = (ts) => `t${ts}`;
  const text = [
    JSON.stringify({ ts: 1, stream: 'stdout', text: '✔ adds two numbers (0.5ms)' }),
    JSON.stringify({ ts: 2, stream: 'stderr', text: '<script>alert(1)</script>' }),
    JSON.stringify({ ts: 3, stream: 'nexus', text: '[output truncated: the middle of the output was dropped]', truncatedMiddle: true }),
    '{"ts":4,"stream":"elsewhere","text":"x"}',
    'not json at all',
    `{"ts":5,"stream":"stdout","text":"${'y'.repeat(1000)}`,
    '', '\r'
  ].join('\n');
  const lines = LG.logLines(text, fmt);
  assert.equal(lines.length, 6, 'blank lines are dropped');
  assert.deepEqual(lines[0], { kind: 'frame', time: 't1', stream: 'stdout', marker: 'out', text: '✔ adds two numbers (0.5ms)', truncatedMiddle: false });
  assert.deepEqual([lines[1].marker, lines[1].text], ['err', '<script>alert(1)</script>'], 'the text is kept as text');
  assert.deepEqual([lines[2].marker, lines[2].truncatedMiddle], ['nexus', true]);
  for (const l of lines.slice(3)) { assert.equal(l.kind, 'raw'); assert.equal(l.marker, LG.RAW_MARKER); }
  assert.equal(lines[3].text, '{"ts":4,"stream":"elsewhere","text":"x"}', 'an unknown stream is not a frame');
  assert.equal(lines[5].cut, true);
  assert.equal(lines[5].text.length, LG.RAW_LINE_CHARS + 1, 'a malformed line is cut, with an ellipsis');
  assert.match(LG.logTime(new Date(2026, 0, 2, 3, 4, 5, 6).getTime()), /^03:04:05\.006$/);
  // The sheet renders the lines as React text, never as HTML, and no longer prints the raw page text.
  const sheet = src('runs/JobLogSheet.tsx');
  assert.match(sheet, /const lines = useMemo\(\(\) => logLines\(pages\.map\(\(p\) => p\.text\)\.join\(''\)\), \[pages\]\);/);
  assert.doesNotMatch(sheet, /dangerouslySetInnerHTML|innerHTML/);
  assert.doesNotMatch(sheet, /aria-label="Log text">\{pages\.map/);
  assert.match(sheet, /<span className="nx-xl__ts">\{l\.time\}<\/span> <span className="nx-xl__st">\{l\.marker\}<\/span> \{l\.text\}/);
});

test('S8 an application\'s health check state comes from its deployments and checks: draft, not checked, checking, healthy, failed', () => {
  const P = (status, validators, deployments) => EV.applicationPreview({ status, validators, deployments });
  const MANIFEST = { 'app.manifest_schema': 'passed', 'app.preview_health': null };
  const dep = (status, startedAt = 1) => ({ status, startedAt });
  assert.deepEqual(P('draft', MANIFEST, []), { state: 'not_checked', word: 'Ready to check: start a test run of your app' });
  assert.deepEqual(P('draft', MANIFEST, [dep('stopped')]), { state: 'not_checked', word: 'Ready to check: start a test run of your app' });
  assert.deepEqual(P('draft', MANIFEST, [dep('starting')]), { state: 'checking', word: 'Checking: the test run of your app is starting' });
  assert.deepEqual(P('draft', MANIFEST, [dep('healthy')]).state, 'checking', 'healthy, its check not recorded yet');
  assert.deepEqual(P('draft', { ...MANIFEST, 'app.preview_health': 'passed' }, [dep('healthy')]), { state: 'healthy', word: 'Your app answered the app check' });
  assert.deepEqual(P('draft', { ...MANIFEST, 'app.preview_health': 'failed' }, []), { state: 'failed', word: 'Your app failed the app check' });
  assert.deepEqual(P('draft', MANIFEST, [dep('failed', 2), dep('stopped', 1)]), { state: 'failed', word: 'The test run of your app failed' });
  assert.deepEqual(P('draft', { 'app.manifest_schema': 'failed' }, []).state, 'failed');
  // Unread checks or deployments: no claim either way ("Draft"), never "Checking…".
  assert.deepEqual(P('draft', null, []), { state: 'draft', word: 'Draft' });
  assert.deepEqual(P('draft', MANIFEST, null), { state: 'draft', word: 'Draft' });
  assert.equal(P('candidate', { ...MANIFEST, 'app.preview_health': null }, []), null, 'a version that left draft keeps its own word');
  // The evidence headline of a draft application never reads "Checking…" before a deployment.
  const results = [val({ validatorId: 'app.manifest_schema', status: 'passed' }), val({ validatorId: 'app.preview_health', status: null })];
  assert.equal(EV.evidenceView(results, { status: 'draft' }).headline, 'Checking…', 'without the application context: unchanged');
  assert.equal(EV.evidenceView(results, { status: 'draft' }, true, { kind: 'application', deployments: [] }).headline, 'Settings check passed; app check not run yet — start a test run of your app');
  assert.equal(EV.evidenceView(results, { status: 'draft' }, true, { kind: 'application', deployments: [dep('starting')] }).headline, 'Checking: the test run of your app is starting');
  assert.equal(EV.evidenceView(results, { status: 'draft' }, true, { kind: 'application', deployments: null }).headline, 'Some checks have not run');
  // The version row and the Spine word.
  assert.equal(EV.applicationChecksWord({ status: 'draft', validationState: 'pending', validators: null, deployments: [] }), null);
  assert.equal(EV.applicationChecksWord({ status: 'draft', validationState: 'pending', validators: MANIFEST, deployments: [] }), 'Ready to check: start a test run of your app');
  assert.equal(EV.applicationChecksWord({ status: 'candidate', validationState: 'passed', validators: null, deployments: null }), 'Checks passed');
  const SM = loadTs('src/renderer/src/nexus/project/spineModel.ts');
  const app = (id, status) => ({ artifact: { id, kind: 'application', status: 'active', ownerWorkspaceId: 'sde', ownerParticipationId: 'pp', name: id, createdAt: 1 },
    versionCount: 1, current: null, latest: { id: `v-${id}`, versionNo: 1, status } });
  const words = new Map([['artifact:a1', 'Checking…'], ['artifact:a2', 'Checking…'], ['artifact:a3', 'Checks passed']]);
  const out = SM.withApplicationWords(words, [app('a1', 'draft'), app('a2', 'draft'), app('a3', 'candidate')],
    new Map([['v-a1', MANIFEST], ['v-a2', MANIFEST]]), [{ subjectVersionId: 'v-a2', status: 'starting', startedAt: 1 }]);
  assert.equal(out.get('artifact:a1'), 'Ready to check: start a test run of your app');
  assert.equal(out.get('artifact:a2'), 'Checking: the test run of your app is starting');
  assert.equal(out.get('artifact:a3'), 'Checks passed');
  assert.equal(SM.withApplicationWords(words, [app('a1', 'draft')], null, null).has('artifact:a1'), false, 'unread: no word, never "Checking…"');
  const passport = src('project/ArtifactPassport.tsx');
  assert.match(passport, /\{shownVersion && isApp && <EvidenceSection key=\{shownVersion\.id\} version=\{shownVersion\} kind=\{artifact\.kind\} checked preview=\{\{ deployments: deploymentsOf\(shownVersion\.id\) \}\} \/>\}/);
  assert.match(src('project/ProjectBench.tsx'), /withApplicationWords\(versionChecks\.words, artifacts, versionChecks\.validators, projectDeployments\.data,\n\s*projectJobs\.data \? \{ jobs: projectJobs\.data, builds: draftBuilds \} : null\)/);
});

test('S9 before the first probe the setup sheet reads "not checked yet" (the HealthView main produces, and main\'s own health())', () => {
  // The HealthView main sends before its first probe: checkedAt null, Docker unknown, free disk unmeasured, no images.
  const unprobed = health({ checkedAt: null, docker: { state: 'unknown' }, images: [], runner: { state: 'unavailable', attached: false, restarts: 0 },
    disk: { dataHomeFreeBytes: null, requiredBytes: 30 * GIB, recommendedBytes: 40 * GIB, leaseFloorBytes: 5 * GIB, gate: 'unknown' }, problems: [] });
  const sheetOf = (h) => {
    const a = X.availabilityFrom({ unavailable: null }, { ok: true, data: h });
    const rows = X.setupSheet(h);
    return { a, rows, lead: X.setupLead(a, rows), checked: X.checkedLine(h.checkedAt) };
  };
  const s = sheetOf(unprobed);
  assert.deepEqual([s.a.kind, s.a.checking], ['unknown', true]);
  assert.equal(s.lead, X.NOT_CHECKED);
  assert.match(s.lead, /has not checked this computer yet/);
  assert.equal(s.checked, 'Nexus has not checked this computer yet.');
  assert.deepEqual([s.rows.find((r) => r.id === 'docker').word, s.rows.find((r) => r.id === 'disk').word], ['Not checked', 'Not checked']);
  assert.ok(!s.rows.some((r) => r.id.startsWith('image:')), 'no image is claimed either way');
  // Main's own health() before any probe (no runner attached, nothing cached), through the real DTO mapping.
  const { ExecutionService } = loadTs('src/main/nexus/exec/executionService.ts');
  const { healthView } = loadTs('src/main/nexusIpc/dto.ts');
  const db = { pragma: () => 9, prepare: () => { throw new Error('health() reads no table'); } };
  const svc = new ExecutionService(db, { available: true, auth: { require() {} }, now: () => NOW });
  const snap = svc.health();
  assert.deepEqual([snap.checkedAt, snap.docker.state, snap.disk.freeBytes, snap.gate, snap.images.length], [null, 'unknown', null, null, 0]);
  const view = healthView(snap, { handoffs: true, execution: true, registry: { valid: true, problems: 0 }, subReason: null });
  assert.deepEqual([view.checkedAt, view.docker.state, view.disk.gate, view.disk.dataHomeFreeBytes], [null, 'unknown', 'unknown', null]);
  const m = sheetOf(view);
  assert.deepEqual([m.a.kind, m.lead, m.checked], ['unknown', X.NOT_CHECKED, 'Nexus has not checked this computer yet.']);
  assert.notEqual(m.lead, 'Jobs can run on this computer.');
});

// ---------- B2a stabilization, click-through 2 (workstream B) ----------

test('S10 the Assemble job\'s Runs row reads "Ready to check: start a test run of your app" while its output waits only for a preview (the awaiting_check rule)', () => {
  assert.deepEqual(R.expectedChecksFor('sde.app.assemble'), ['app.manifest_schema', 'app.preview_health']);
  assert.deepEqual(R.DEPLOYMENT_ACTIONS, ['sde.preview.start', 'sde.preview.stop']);
  const row = (validatorId, status) => ({ validatorId, blocking: true, status });
  const expected = R.expectedChecksFor('sde.app.assemble');
  // #32 lists only validators that have a row: the draft has its manifest result and no preview result.
  assert.equal(R.awaitingUserCheck({ expected, outputs: [[row('app.manifest_schema', 'passed')]], liveDeployments: 0 }), true);
  assert.equal(R.awaitingUserCheck({ expected, outputs: [[row('app.manifest_schema', 'passed')]], liveDeployments: 1 }), false, 'a live preview can be checking it');
  assert.equal(R.awaitingUserCheck({ expected, outputs: [[row('app.manifest_schema', 'passed'), row('app.preview_health', 'failed')]], liveDeployments: 0 }), false);
  assert.equal(R.awaitingUserCheck({ expected, outputs: [[]], liveDeployments: 0 }), false, 'the manifest check (main) is still owed');
  assert.equal(R.awaitingUserCheck({ expected, outputs: [], liveDeployments: 0 }), false, 'no output read: no claim');
  assert.equal(R.awaitingUserCheck({ expected: R.expectedChecksFor('sde.build.run'), outputs: [[row('build.exit_zero', 'passed')]], liveDeployments: 0 }), false,
    'a runner re-hash is a live check, never the user\'s');
  // What could run the check, per version: a live deployment row of the version, or a live preview job of its build
  // (a preview job's input is the build) that has no deployment row yet.
  const deps = [{ jobId: 'JA', subjectVersionId: 'V1', status: 'starting', startedAt: 1 }, { jobId: 'JB', subjectVersionId: 'V1', status: 'stopped', startedAt: 1 },
    { jobId: 'JC', subjectVersionId: 'V2', status: 'healthy', startedAt: 1 }];
  const pj = (id, state, build) => job({ id, state, actionId: 'sde.preview.start', recipeId: 'sde.preview.start', inputs: [{ versionId: build, slot: 'build', contentHash: 'h' }] });
  assert.deepEqual(R.livePreviewsOf({ versionId: 'V1', buildVersionId: 'B1' }, deps, []), [{ status: 'starting', startedAt: 1 }]);
  assert.equal(R.livePreviewsOf({ versionId: 'V3', buildVersionId: 'B3' }, deps, [pj('JQ', 'queued', 'B3')]).length, 1, 'not leased yet: its build');
  assert.equal(R.livePreviewsOf({ versionId: 'V3', buildVersionId: 'B3' }, deps, [pj('JQ', 'completed', 'B3')]).length, 0);
  assert.equal(R.livePreviewsOf({ versionId: 'V3', buildVersionId: null }, deps, [pj('JQ', 'queued', 'B3')]).length, 0, 'build unknown: no claim');
  assert.equal(R.livePreviewsOf({ versionId: 'V3', buildVersionId: 'B2' }, deps, [pj('JC', 'running', 'B2')]).length, 0, 'its row names V2');
  // The row: main's headline is `validating`; the renderer's records say nothing is checking.
  const assemble = job({ actionId: 'sde.app.assemble', recipeId: 'sde.app.assemble', state: 'completed', headline: 'validating', startedAt: NOW });
  const waiting = R.jobRun(assemble, { awaitingCheck: true });
  assert.equal(waiting.headline, 'The app was put together; ready to check: start a test run of your app');
  assert.equal(waiting.word, 'Ready to check');
  const st = waiting.stages.find((s) => s.id === 'validating');
  assert.deepEqual([st.state, R.STAGE_STATE_TEXT[st.state]], ['waiting', 'waiting']);
  assert.ok(!waiting.stages.some((s) => s.state === 'active'), 'no stage reads "in progress"');
  assert.equal(R.jobRun(assemble).headline, 'The app was put together; checking the results', 'unread or live: unchanged');
  assert.equal(R.jobRun({ ...assemble, headline: 'checks_passed' }, { awaitingCheck: true }).headline, 'The app was put together; checks passed');
  const runs = src('runs/ProjectRuns.tsx');
  assert.match(runs, /const awaitingCheck = useAwaitingCheck\(job, jobs, deployments\);\n\s*const run = jobRun\(job, \{ reason, awaitingCheck \}\);/);
  assert.match(runs, /const buildVersionId = job\.inputs\.find\(\(x\) => x\.slot === 'build'\)\?\.versionId \?\? null;/);
  assert.match(runs, /livePreviewsOf\(\{ versionId: o\.versionId, buildVersionId \}, deployments, jobs\)\.length/);
  assert.match(runs, /<JobRow job=\{j\} explain=\{i < 5\} jobs=\{jobs\.data \?\? \[\]\} deployments=\{deployments\.data\} \/>/);
});

test('S11 the evidence headline never says passed while a blocking check has no result; it says what passed and what waits', () => {
  // A draft application as #32 answers it: the manifest row only (app.preview_health has no row yet).
  const manifestOnly = [val({ validatorId: 'app.manifest_schema', status: 'passed', summary: 'The manifest is valid.' })];
  assert.equal(EV.evidenceView(manifestOnly, { status: 'draft' }).headline, 'Checks passed', 'without the kind nothing more is known (the old reading)');
  const v = EV.evidenceView(manifestOnly, { status: 'draft' }, true, { kind: 'application', deployments: [] });
  assert.equal(v.headline, 'Settings check passed; app check not run yet — start a test run of your app');
  const pending = v.rows.find((r) => r.validatorId === 'app.preview_health');
  assert.deepEqual([pending.word, pending.status, pending.blocking, pending.summary], ['Not run yet', null, true, 'This check needs your app to be running: start a test run of your app to run it.']);
  assert.equal(EV.evidenceView(manifestOnly, { status: 'draft' }, true, { kind: 'application', deployments: [{ status: 'starting', startedAt: 1 }] }).headline,
    'Checking: the test run of your app is starting');
  assert.equal(EV.evidenceView(manifestOnly, { status: 'draft' }, true, { kind: 'application', deployments: null }).headline, 'Some checks have not run');
  // Every checked kind: with any blocking check missing, never "Checks passed".
  const { VALIDATORS } = loadTs('src/shared/nexus/validators.ts');
  const kinds = [...new Set(VALIDATORS.filter((x) => x.blocking).flatMap((x) => x.kinds))];
  for (const kind of kinds) {
    const ids = VALIDATORS.filter((x) => x.blocking && x.kinds.includes(kind) && (x.stage === 'register' || x.stage === 'candidate')).map((x) => x.id);
    if (ids.length < 2) continue;
    const partial = ids.slice(0, -1).map((id) => val({ validatorId: id, status: 'passed' }));
    for (const status of ['draft', 'candidate']) {
      const h = EV.evidenceView(partial, { status }, true, { kind }).headline;
      assert.notEqual(h, 'Checks passed', `${kind} ${status}: ${h}`);
    }
    assert.equal(EV.evidenceView(ids.map((id) => val({ validatorId: id, status: 'passed' })), { status: 'candidate' }, true, { kind }).headline, 'Checks passed', kind);
  }
  const sec = src('project/EvidenceSection.tsx');
  assert.match(sec, /evidenceView\(v\.data \?\? \[\], version, checked, \{ kind, \.\.\.\(preview \? \{ deployments: preview\.deployments \} : \{\}\) \}\)/);
});

test('S12 reason codes ("(tests_failed)") never reach visible text in Runs or the Folio; a title attribute keeps them', () => {
  assert.deepEqual(EV.plainSentence('1 of 2 executed test(s) failed. (tests_failed)'), { text: '1 of 2 executed test(s) failed.', codes: ['tests_failed'] });
  assert.deepEqual(EV.plainSentence('No JUnit (junit_missing) report (exit_code_mismatch).'), { text: 'No JUnit report.', codes: ['junit_missing', 'exit_code_mismatch'] });
  assert.deepEqual(EV.plainSentence('test(s) ran (in 2 s)'), { text: 'test(s) ran (in 2 s)', codes: [] }, 'plain parentheses stay');
  const ev = EV.evidenceView([val({ status: 'failed', summary: '1 of 2 executed test(s) failed. (tests_failed)' }),
    val({ validatorId: 'x.y', status: 'error', summary: 'The runner was lost. (runner_lost)' })], { status: 'draft' });
  assert.deepEqual([ev.rows[0].summary, ev.rows[0].codes], ['1 of 2 executed test(s) failed.', ['tests_failed']]);
  assert.deepEqual([ev.rows[1].summary, ev.rows[1].codes], ['Checks could not run: The runner was lost.', ['runner_lost']]);
  const failed = R.jobRun(job({ actionId: 'sde.tests.discover', recipeId: 'sde.test.discover', headline: 'checks_failed', state: 'completed' }),
    { reason: '1 of 2 executed test(s) failed. (tests_failed)' });
  assert.equal(failed.headline, 'The tests were found; checks failed: 1 of 2 executed test(s) failed');
  assert.deepEqual(failed.codes, ['tests_failed']);
  const err = R.jobRun(job({ headline: 'failed', state: 'failed', error: { code: 'x', message: 'The container exited (oom_killed).' } }));
  assert.equal(err.headline, 'Failed: Something went wrong while this ran', 'the stored message is never shown');
  assert.doesNotMatch(`${failed.headline} ${err.headline} ${ev.rows.map((r) => r.summary).join(' ')}`, /\([a-z]+_[a-z_]+\)/);
  assert.match(src('project/EvidenceSection.tsx'), /<p className="nx-xe__text" title=\{r\.codes\.length \? r\.codes\.join\(', '\) : undefined\}>\{r\.summary\}<\/p>/);
  assert.match(src('runs/ProjectRuns.tsx'), /<span className="nx-run__headline" aria-live="polite" title=\{run\.codes\.length \? run\.codes\.join\(', '\) : undefined\}>\{run\.headline\}<\/span>/);
});

test('S13 the rail, the Folio and Runs use the same words for a draft waiting on a preview', () => {
  const L = loadTs('src/renderer/src/nexus/workspaces/lifecycleModel.ts');
  const views = L.bundledDomainViews();
  const rail = L.railFor(views.find((x) => x.id === 'sde'), { versions: [{ kind: 'build', status: 'candidate', validators: {} },
    { kind: 'application', status: 'draft', validators: { 'app.manifest_schema': 'passed' } }], liveActions: [], participation: true, deploymentHealthy: false, liveDeployments: 0 });
  const word = rail.steps.find((s) => s.id === 'application').word;
  assert.equal(word, 'Ready to check: start a test run of your app');
  assert.equal(EV.applicationPreview({ status: 'draft', validators: { 'app.manifest_schema': 'passed' }, deployments: [] }).word, word, 'the Spine node and version rows');
  assert.equal(R.READY_TO_CHECK, word, 'the Runs row');
  for (const f of ['project/evidenceModel.ts', 'project/spineModel.ts', 'project/ArtifactPassport.tsx', 'runs/jobRunModel.ts']) {
    assert.doesNotMatch(src(f), /Not checked yet: start a dev deployment/, f);
  }
});

test('S15 no second "Start a test run of your app" while one of that version is starting or running (main refuses one: deployment_live)', () => {
  const def = getUserAction('sde.preview.start');
  const answer = [{ actionId: def.id, label: def.label, stepId: null, available: true, reason: null, needsApproval: false, inputs: def.inputs.map((s) => ({ ...s })) }];
  const ctx = (liveDeployment) => ({ workspaceId: 'sde', availability: READY, version: { kind: 'application', status: 'draft' }, liveDeployment });
  assert.deepEqual(AM.actionBar(answer, ctx(null)).buttons.map((b) => b.actionId), ['sde.preview.start']);
  const starting = AM.actionBar(answer, ctx('starting'));
  assert.equal(starting.buttons.length, 0);
  assert.deepEqual(starting.sentences, [{ actionId: 'sde.preview.start', setup: false, text: 'A test run of your app is starting for this saved version. Follow it under “Test runs of your app”.' }]);
  assert.equal(AM.actionBar(answer, ctx('running')).sentences[0].text, 'A test run of your app is already running for this saved version. Stop it to start another.');
  // Which deployment is live, from the records: a deployment row of the version, or a live job starting one before its row exists.
  const dep = (subjectVersionId, status, jobId = 'JX') => ({ jobId, subjectVersionId, status, startedAt: 1 });
  const j = (state, build, id = 'JQ') => ({ id, state, actionId: 'sde.preview.start', inputs: [{ versionId: build }], createdAt: 1 });
  const V1 = { versionId: 'V1', buildVersionId: 'B1' };
  assert.equal(AM.liveDeploymentOf(V1, [dep('V1', 'starting')], []), 'starting');
  assert.equal(AM.liveDeploymentOf(V1, [dep('V1', 'healthy')], []), 'running');
  assert.equal(AM.liveDeploymentOf(V1, [dep('V1', 'unhealthy')], []), 'running');
  assert.equal(AM.liveDeploymentOf(V1, [dep('V1', 'stopped'), dep('V2', 'starting')], []), null, 'another version, or a stopped one');
  assert.equal(AM.liveDeploymentOf(V1, [], [j('queued', 'B1')]), 'starting', 'a preview job of its build, not leased yet');
  assert.equal(AM.liveDeploymentOf(V1, [], [j('completed', 'B1')]), null);
  assert.equal(AM.liveDeploymentOf(V1, [], [j('queued', 'B2')]), null, 'another version\'s build');
  // Main's own rule now: a second start for a version with a live deployment or preview job is refused (deployment_live).
  const svc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'nexus', 'exec', 'executionService.ts'), 'utf8');
  assert.match(svc, /if \(!hasPrior && this\.previewLive\(recipe\.id, appIn\.versionId\)\) \{\r?\n\s*throw new PlatformError\('conflict', 'a dev deployment of this application version is already live', \{ reason: 'deployment_live' \}\);/);
  assert.equal(E.execFailText({ code: 'conflict', reason: 'deployment_live' }),
    'A test run of this app is already starting or running. Stop it before you start another.');
  const bar = src('project/ActionBar.tsx');
  assert.match(bar, /const liveDeployment = version \? liveDeploymentOf\(\{ versionId: version\.id, buildVersionId: version\.buildId \?\? null \}, deployments\.data \?\? \[\], jobs\.data \?\? \[\]\) : null;/);
  assert.match(bar, /version: version \? \{ kind: version\.kind, status: version\.status \} : null, liveDeployment \}\);/);
  assert.match(src('project/ArtifactPassport.tsx'), /version=\{\{ id: shownVersion\.id, kind: artifact\.kind, status: shownVersion\.status, buildId: shownBuildId \}\} \/>/);
  // Two clicks before main answers start one job: the busy guard, and one intent per request.
  assert.match(bar, /if \(!def \|\| busy\) return;/);
});
