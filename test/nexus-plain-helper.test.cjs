'use strict';
// Plain-words track B: the AI helper panel, the conversation log, the task list and the request box. What a newcomer reads is plain
// words (AI helper, conversation, request, step, safe copy, internet permission); while the AI helper works there is one progress
// line (what it is doing, for how long, that you can keep using Nexus, what happens next); every ending says why in plain words and
// gives one next step; the reason a task ended comes from a table keyed by its error CODE, never from the message stored with it.
// Only words changed: the actions, ids, reason codes and the honesty rules are pinned by nexus-ui-agent-models and nexus-ui-exec-models.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const ROOT = path.join(__dirname, '..');
const NEXUS = path.join(ROOT, 'src', 'renderer', 'src', 'nexus');
const src = (p) => fs.readFileSync(path.join(NEXUS, p), 'utf8');
const A = loadTs('src/renderer/src/nexus/agent/agentModel.ts');
const J = loadTs('src/renderer/src/nexus/runs/jobRunModel.ts');
const RM = loadTs('src/renderer/src/nexus/runs/runModel.ts');
const E = loadTs('src/renderer/src/nexus/data/errorCopy.ts');
const { GLOSSARY } = loadTs('src/renderer/src/nexus/data/glossary.ts');
const { resolveAssistantStatus } = loadTs('src/renderer/src/nexus/assistant/port.ts');

const NOW = 1_800_000_000_000;
const MIN = 60_000;
// Words a newcomer has no way to read. "Git" and "Docker" are real programs the setup names; the rest are internals.
const JARGON = /\b(turns?|sessions?|runtime|worktree|tool calls?|sandbox|repository|branch|refs?|fast-forward|commit|container|lease|heartbeat|proxy|egress|tokens?|payload|stderr|stdout|exit code|image|runner|probe|artifact|intent line|hidden refs|merge)\b/i;

const agentView = (o = {}) => ({
  state: 'ready', label: 'Acme Agent', version: '9.9.9', signedIn: 'yes', flagsOk: true,
  consent: { live: true, caps: { turnUsdCents: 200, dayUsdCents: 1000, turnsPerHour: 6, concurrentTurns: 1, turnTokens: 400000, toolCalls: 200, wallClockMs: 1800000, childJobs: 20 }, hostsCount: 1, grantedAt: NOW },
  usageToday: { usdCents: 120, turns: 2, estimated: false }, ...o
});
const health = (o = {}) => ({ db: { version: 10, platform: true, handoffs: true, execution: true }, registry: { valid: true, problems: 0 }, runner: { state: 'ready', attached: true, restarts: 0 }, agent: agentView(), ...o });
const READY = { kind: 'ready', advisories: [] };
const session = (o = {}) => ({ id: 'S1', projectId: 'p', workspaceId: 'sde', status: 'open', turns: 1, liveJobId: null, createdAt: NOW, updatedAt: NOW, ...o });
const job = (o = {}) => ({
  id: 'J1', kind: 'agent.run', projectId: 'p', workspaceId: 'sde', actionId: null, recipeId: null, state: 'running', phase: null, headline: 'running', outcome: null,
  error: null, attempts: 1, retryOf: null, parentJobId: null, requestedByKind: 'user', inputs: [], createdAt: NOW - 5 * MIN, updatedAt: NOW, startedAt: NOW - 150_000, finishedAt: null,
  nextAttemptAt: null, cancelRequested: false, ...o
});
const panel = (jobs, sessions = [], now = NOW) => A.agentPanelModel({ health: health(), availability: READY, sessions, sessionsFail: null, now,
  jobs: new Map(jobs.map((j, n) => [`J${n}`, j])) });
const strings = (v, out = []) => { if (typeof v === 'string') out.push(v); else if (Array.isArray(v)) v.forEach((x) => strings(x, out)); else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => { if (!['kind', 'tone', 'id', 'key', 'versionId'].includes(k)) strings(x, out); }); return out; };

// ---------- PH1 the progress line ----------

test('PH1 while the AI helper works there is one plain progress line: what it is doing, for how long, that you can keep using Nexus, what happens next', () => {
  const p = panel([job()], [session({ status: 'running', liveJobId: 'J1' })]);
  assert.ok(p.progress, 'a live request has a progress line');
  assert.equal(p.progress.now, 'The AI helper is working on your request');
  assert.equal(p.progress.running, 'Working for 2 minutes');
  assert.equal(p.progress.keepUsing, 'You can keep using Nexus.');
  assert.match(p.progress.next, /When it stops, you will see here what it did and what to do next/);
  assert.equal(p.progress.line, 'The AI helper is working on your request. Working for 2 minutes. You can keep using Nexus. Next: when it stops, you will see here what it did and what to do next.');
  assert.equal(p.waiting, null);
  assert.equal(p.ending, null, 'no ending while one request is live');
  assert.equal(p.working, 'Working');
  // Getting ready and waiting for room read their own line, with what happens by itself.
  const leased = panel([job({ state: 'leased', headline: 'provisioning', startedAt: null })]);
  assert.equal(leased.progress.now, 'Getting the AI helper’s safe space ready');
  const queued = panel([job({ state: 'queued', headline: 'queued', startedAt: null, createdAt: NOW - 40_000 })]);
  assert.equal(queued.progress.running, 'Waiting for 40 seconds');
  assert.match(queued.progress.next, /Nothing to do\. It starts by itself\./);
  const stopping = panel([job({ cancelRequested: true })]);
  assert.equal(stopping.progress.now, 'Stopping: you asked it to stop');
  // The clock is the caller's: the model never reads one when told the time.
  assert.equal(A.agentProgress(job({ startedAt: NOW - 3_000 }), NOW).running, 'Working for a few seconds');
  assert.equal(A.agentProgress(job({ startedAt: null, createdAt: null }), NOW).running, null, 'no start time: no claim about how long');
});

test('PH2 elapsed time is said in words a person says it in', () => {
  const t = (ms) => A.elapsedText(ms);
  assert.deepEqual([t(2_000), t(10_000), t(45_000), t(60_000), t(61_000), t(59 * MIN), t(60 * MIN), t(65 * MIN), t(120 * MIN)],
    ['a few seconds', '10 seconds', '40 seconds', '1 minute', '1 minute', '59 minutes', '1 hour', '1 hour 5 minutes', '2 hours']);
  assert.equal(t(-5), 'a moment');
  assert.equal(t(NaN), 'a moment');
});

// ---------- PH3 waiting for you ----------

test('PH3 when the AI helper cannot go on without you the panel says so in plain words, with one next step; the OK stays inside the panel', () => {
  const ok = panel([job({ state: 'awaiting_approval', headline: 'waiting_for_approval' })], [session({ status: 'awaiting_approval', liveJobId: 'J1' })]);
  assert.equal(ok.waiting.title, 'Waiting for you');
  assert.equal(ok.waiting.text, 'The AI helper needs your OK before it can go on.');
  assert.match(ok.waiting.next, /Answer the question on this page/);
  assert.equal(ok.progress, null, 'waiting for you is not shown as progress');
  assert.equal(ok.working, 'Waiting for you');
  const consent = panel([job({ state: 'queued', headline: 'queued', phase: 'waiting:consent', startedAt: null })]);
  assert.equal(consent.waiting.text, 'Waiting for your internet permission.');
  assert.match(consent.waiting.next, /Get this computer ready/);
  // A wait nobody needs to answer is progress, not "waiting for you".
  const slots = panel([job({ state: 'queued', headline: 'queued', phase: 'waiting:slots', startedAt: null })]);
  assert.equal(slots.waiting, null);
  assert.equal(slots.progress.now, 'Waiting for room to start');
  // The panel keeps the approval inside itself, answered right there.
  const tsx = src('agent/AgentPanel.tsx');
  assert.ok(tsx.includes('<ApprovalList approvals={repoWaiting}'));
  assert.ok(tsx.includes('panel.progress') && tsx.includes('panel.waiting') && tsx.includes('panel.ending'));
  assert.ok(A.REPO_APPROVAL_WAIT_TEXT.startsWith('The AI helper is waiting for your OK.'));
  assert.doesNotMatch(A.REPO_APPROVAL_WAIT_TEXT, JARGON);
});

// ---------- PH4 endings ----------

test('PH4 every ending says what happened in plain words and gives one next step (or the sentence already says it)', () => {
  const end = (o) => panel([job({ finishedAt: NOW, ...o })]).ending;
  const done = end({ state: 'completed', outcome: 'completed', headline: 'checks_passed' });
  assert.deepEqual([done.tone, done.title], ['handed_in', 'Changes ready to look over']);
  assert.equal(done.text, 'The AI helper handed in its suggested changes.');
  assert.equal(done.next, 'Look over the suggested changes. Press “Looks good” if you are happy with them.');
  const none = end({ state: 'partial', outcome: 'no_change', headline: 'checks_could_not_run' });
  assert.deepEqual([none.tone, none.title, none.text], ['no_change', 'No changes', 'The AI helper answered but did not suggest changes.']);
  assert.equal(none.next, 'Ask again, or describe a change you want.');
  const early = end({ state: 'partial', outcome: null, headline: 'checks_could_not_run' });
  assert.deepEqual([early.tone, early.title], ['stopped', 'Stopped early']);
  assert.match(early.text, /Nexus did not keep a record of what it changed/);
  const cancelled = end({ state: 'cancelled', outcome: 'cancelled', headline: 'cancelled' });
  assert.deepEqual([cancelled.tone, cancelled.text], ['stopped', 'The request was stopped.']);
  assert.equal(cancelled.next, 'Ask again when you are ready.');
  const timed = end({ state: 'timed_out', outcome: 'timed_out', headline: 'timed_out' });
  assert.equal(timed.title, 'Ran out of time');
  assert.match(timed.next, /Ask for something smaller/);
  const cut = end({ state: 'interrupted', outcome: 'interrupted', headline: 'interrupted' });
  assert.deepEqual([cut.title, cut.next], ['Stopped early', 'Ask the AI helper again.']);
  // A failure: the reason in plain words and one next step, for every outcome the AI helper can fail with.
  const failed = (outcome, code = outcome) => end({ state: 'failed', outcome, headline: 'failed', error: { code, message: 'RAW lease heartbeat container text' } });
  const OUTCOMES = ['runtime_auth', 'limit', 'runtime_protocol', 'runtime_error', 'worktree_guard', 'consent_mismatch', 'proxy_failed', 'runtime_unknown', 'denied', 'expired',
    'branch_unknown', 'git_missing', 'hosted_rate_limited', 'hosted_quota_exhausted', 'hosted_key_rejected', 'budget_exhausted', 'some_brand_new_outcome'];
  for (const o of OUTCOMES) {
    const f = failed(o);
    assert.equal(f.tone, 'failed', o);
    assert.equal(f.title, 'Did not work', o);
    assert.doesNotMatch(f.text, /RAW|_|lease|heartbeat|container/i, `${o}: no raw text or code in "${f.text}"`);
    assert.doesNotMatch(f.text, JARGON, `${o}: ${f.text}`);
    assert.ok(f.next !== null || /\b(try again|Open|Install|Save|Sign in|Wait|Add|Choose|Check|allow it again|Start)\b/i.test(f.text), `${o}: one next step, in the sentence or after it: "${f.text}"`);
    if (f.next !== null) assert.doesNotMatch(f.next, JARGON, `${o}: ${f.next}`);
  }
  assert.equal(failed('runtime_auth').text, 'The AI helper could not sign in.');
  assert.equal(failed('runtime_auth').next, 'Open “Get this computer ready” and check it.');
  assert.equal(failed('limit').next, 'Ask for something smaller, or try again later.');
  assert.equal(failed('some_brand_new_outcome').text, 'The request did not work.');
  assert.equal(failed('some_brand_new_outcome').next, 'Ask the AI helper again.');
  assert.equal(failed('branch_unknown').snapshot, true, 'saving a starting point is offered when that is the way forward');
  assert.equal(failed('git_missing').snapshot, false);
  // Only the newest request is shown, and never while one is live.
  assert.equal(panel([job({ state: 'failed', headline: 'failed', outcome: 'limit', createdAt: 1 }), job({ state: 'completed', outcome: 'completed', createdAt: 5 })]).ending.tone, 'handed_in');
  assert.equal(panel([job({ state: 'failed', headline: 'failed', outcome: 'limit', createdAt: 1 }), job({ state: 'running', createdAt: 5 })]).ending, null);
  assert.equal(panel([]).ending, null);
});

// ---------- PH5 the next steps ----------

test('PH5 NEXT_STEP is plain words: no git word, no check-out, no command to run yourself', () => {
  assert.deepEqual(Object.keys(A.NEXT_STEP).sort(), ['branch_mismatch', 'integration_unexpected', 'merge_conflict', 'not_fast_forward']);
  assert.equal(A.NEXT_STEP.not_fast_forward, 'Ask the AI helper to do the work again on your latest project.');
  for (const [k, v] of Object.entries(A.NEXT_STEP)) {
    assert.doesNotMatch(v, /\bgit\b|branch|check out|accepted|\bmerge\b|repository|fast-forward/i, `${k}: ${v}`);
    assert.ok(v.length > 20 && /\.$/.test(v), k);
  }
  assert.match(A.NEXT_STEP.merge_conflict, /Ask for different changes/);
  // A refusal reads its sentence, then the step.
  assert.equal(A.agentFailText({ code: 'conflict', reason: 'not_fast_forward' }), `${E.AGENT_REASON_TEXT.not_fast_forward} ${A.NEXT_STEP.not_fast_forward}`);
});

// ---------- PH6 the conversation log ----------

test('PH6 the conversation log is plain: requests, what was said, steps in plain words, no tool id and no result size', () => {
  const d = { ...session(), turnHistory: [
    { jobId: 'J1', state: 'completed', headline: 'checks_passed', outcome: 'completed', error: null, usage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, costUsdCents: 42, toolCalls: 7, estimated: false }, createdAt: NOW, startedAt: NOW, finishedAt: NOW },
    { jobId: 'J2', state: 'failed', headline: 'failed', outcome: 'limit', error: { code: 'limit', message: 'RAW text' }, usage: null, createdAt: NOW, startedAt: NOW, finishedAt: NOW }],
  messages: [{ seq: 1, ts: NOW, from: 'user', text: 'fix it', displayOnly: true }, { seq: 2, ts: NOW, from: 'agent', text: 'Done.', displayOnly: true }],
  toolCalls: [{ seq: 1, ts: NOW, jobId: 'J1', tool: 'mcp__nexus__sandbox_exec', ok: true, resultBytes: 10 }, { seq: 2, ts: NOW, jobId: 'J1', tool: 'write_file', ok: false, resultBytes: null },
    { seq: 3, ts: NOW, jobId: 'J1', tool: 'rm -rf / <script>', ok: null, resultBytes: null }],
  versions: [], approvals: [] };
  const v = A.sessionLogModel(d);
  assert.match(v.note, /for reading only/);
  assert.equal(v.messages[1].author, 'AI helper (for reading only)');
  assert.equal(v.turns[0].usage, '7 steps, cost $0.42 (reported by the AI service)');
  assert.equal(v.turns[1].headline, 'The AI helper stopped at one of its limits (time, number of steps, size of the job or cost)');
  assert.equal(v.turns[1].next, 'Ask for something smaller, or try again later.');
  assert.deepEqual(v.toolCalls.map((c) => [c.tool, c.outcome]), [['Running a command in the safe space', 'Worked'], ['Writing a file', 'Did not work'], ['A step', 'Result not recorded']]);
  const all = strings(v);
  for (const t of all) assert.doesNotMatch(t, /sandbox_exec|write_file|_|<script>|RAW/, t);
  const tsx = src('agent/SessionLog.tsx');
  for (const h of ['Requests', 'What was said (for reading only)', 'Steps the AI helper took', 'Saved by the AI helper']) assert.ok(tsx.includes(`>${h}<`), h);
  assert.doesNotMatch(tsx, />Turns<|>Tool calls<|Registered by the agent|result \{/);
  // Every step the AI helper can take has one plain line.
  const TOOLS = ['context_get', 'artifact_list', 'artifact_read', 'validations_get', 'job_status', 'job_logs', 'sandbox_exec', 'job_request', 'changeset_register', 'requirement_draft', 'review_request',
    'read_file', 'write_file', 'list_files', 'delete_file'];
  for (const t of TOOLS) { const w = A.toolLabel(t); assert.notEqual(w, 'A step', t); assert.doesNotMatch(w, JARGON); assert.ok(/^[A-Z]/.test(w) && !/_/.test(w), w); assert.equal(A.toolLabel(`mcp__nexus__${t}`), w); }
  assert.equal(A.toolLabel('read_file'), 'Reading a file');
  assert.equal(A.toolLabel('write_file'), 'Writing a file');
  assert.equal(A.toolLabel('review_request'), 'Sending the suggested changes for review');
  // The built-in steps of the helper's own program (seen on a real build) read in plain words, not "A step".
  for (const t of ['ToolSearch', 'TodoWrite', 'Task', 'Skill', 'NotebookEdit', 'WebFetch', 'WebSearch', 'ExitPlanMode', 'EnterPlanMode']) {
    const w = A.toolLabel(t); assert.notEqual(w, 'A step', t); assert.doesNotMatch(w, JARGON); assert.ok(/^[A-Z]/.test(w) && !/_/.test(w), w);
  }
  assert.equal(A.toolLabel('mcp__claude__ToolSearch'), 'Getting its tools ready');
});

// ---------- PH7 tasks and the codes they end with ----------

const TASK = (o = {}) => ({
  id: 'T1', kind: 'tool.run', projectId: 'p', workspaceId: 'sde', actionId: 'sde.tests.run', recipeId: 'sde.test.node', state: 'failed', phase: null, headline: 'failed', outcome: null,
  error: null, attempts: 1, retryOf: null, parentJobId: null, requestedByKind: 'user', inputs: [], createdAt: NOW, updatedAt: NOW, startedAt: NOW, finishedAt: NOW, nextAttemptAt: null, cancelRequested: false, ...o
});

test('PH7 a task that ends with an error CODE reads a plain sentence and one next step for that code; the stored message is never shown', () => {
  const RAW = 'the lease ran out without a heartbeat from the runner; container image sha256:abc exit 137';
  // Every code main and the runner end a task with has plain words.
  const CODES = ['runner_lost', 'limits_not_applied', 'timed_out', 'cancelled', 'stopped', 'not_sent', 'interrupted', 'exit_not_reported', 'timeout', 'session_ended', 'runtime_error',
    'probe_failed', 'start_window_unobserved', 'outputs_missing', 'oom', 'nonzero_exit', 'no_evidence', 'limit', 'ingest_unavailable', 'ingest_error', 'exited', 'container_vanished',
    'build_failed', 'bad_plan', 'approvals_unavailable', 'approval_stale', 'approval_expired', 'approval_denied', 'agents_unavailable', 'constraint', 'network_not_approved', 'busy',
    'unknown_attempt', 'input_changed', 'docker_missing', 'docker_stopped', 'image_missing', 'image_mismatch', 'disk_low', 'git_missing', 'deployment_refused', 'not_in_this_build',
    'consent_revoked', 'hosted_key_missing', 'unreadable_output_entry', 'symlink', 'hardlink', 'special_file', 'bad_name', 'file_locked', 'too_many_files', 'output_too_large',
    'workspace_too_large', 'secret_in_report', 'secret_in_output',
    // The git write failures a task can end with.
    'bad_task', 'repo_layout_unsupported', 'repo_empty', 'branch_missing', 'worktree_tampered', 'worktree_conflict', 'link_or_gitlink', 'unknown_commit', 'git_failed',
    'symlink_in_worktree', 'nested_repo', 'worktree_too_large', 'file_too_large'];
  for (const code of CODES) {
    assert.ok(Object.prototype.hasOwnProperty.call(J.CODE_WORDS, code), `${code} has plain words`);
    const w = J.codeWords(code);
    assert.equal(w.known, true, code);
    for (const t of [w.text, w.next].filter(Boolean)) {
      assert.doesNotMatch(t, JARGON, `${code}: ${t}`);
      assert.doesNotMatch(t, /[a-z]+_[a-z_]+|sha256|\b\d{3}\b exit/i, `${code}: no code or hash in "${t}"`);
    }
    for (const state of ['failed', 'timed_out', 'interrupted']) {
      const r = J.jobRun(TASK({ state, headline: state, error: { code, message: RAW } }));
      assert.doesNotMatch(r.headline, /lease|heartbeat|runner|container|sha256|137/i, `${code}/${state}: the stored message is never shown: "${r.headline}"`);
      assert.ok(r.next && r.next.length > 8 || /\b(try again|Open|Install|Start|Free|give|Save|Download)\b/i.test(r.headline), `${code}/${state}: a next step: ${r.next}`);
    }
  }
  // A known code reads its own sentence, then the step.
  const lost = J.jobRun(TASK({ error: { code: 'runner_lost', message: RAW } }));
  assert.equal(lost.headline, 'Failed: Nexus lost contact with the part of the app that runs tasks, so this task stopped');
  assert.equal(lost.next, 'Press Retry.');
  const oom = J.jobRun(TASK({ error: { code: 'oom', message: RAW } }));
  assert.equal(oom.headline, 'Failed: It ran out of memory, so Nexus stopped it');
  assert.equal(oom.next, 'Close other programs or give Docker more memory in “Get this computer ready”, then press Retry.');
  const timed = J.jobRun(TASK({ state: 'timed_out', headline: 'timed_out', error: { code: 'timed_out', message: RAW } }));
  assert.equal(timed.headline, 'Stopped: It ran for longer than its time limit, so Nexus stopped it');
  assert.equal(timed.next, 'Press Retry, or ask for something smaller.');
  // The setup sentences are the ones the error table says, so a person reads the same words everywhere.
  assert.equal(J.CODE_WORDS.docker_stopped, E.SETUP_TEXT.docker_stopped);
  assert.equal(J.CODE_WORDS.git_missing, E.SETUP_TEXT.git_missing);
  // An unknown code reads the generic sentence and step, never the message.
  const unknown = J.jobRun(TASK({ error: { code: 'a_code_from_a_newer_nexus', message: RAW } }));
  assert.equal(unknown.headline, 'Failed: Something went wrong while this ran');
  assert.equal(unknown.next, 'Press Retry. If it fails again, open “Get this computer ready” to check this computer, or contact support.');
  assert.doesNotMatch(`${unknown.headline} ${unknown.next}`, /newer|a_code|lease|heartbeat/);
  assert.deepEqual(J.codeWords(undefined), { text: J.UNKNOWN_WORDS.text, next: J.UNKNOWN_WORDS.next, known: false });
  assert.equal(J.jobRun(TASK({ error: null })).headline, 'Failed', 'no error recorded: nothing is invented');
  // Every step has a code sentence to go with it.
  for (const k of Object.keys(J.CODE_NEXT)) assert.ok(J.CODE_WORDS[k], `${k} has a sentence`);
});

test('PH8 a waiting task says what it waits for and what happens by itself; no "queued", "slot", "sandbox image", "passing fault"', () => {
  const HEADLINES = ['queued', 'waiting:runner', 'waiting:docker', 'waiting:image', 'waiting:disk', 'waiting:slots', 'waiting:memory', 'waiting:git', 'waiting:retry', 'provisioning', 'running',
    'waiting_for_approval', 'collecting', 'validating', 'checks_passed', 'checks_failed', 'checks_could_not_run', 'cancelled', 'interrupted'];
  const STATE = { checks_passed: 'completed', checks_failed: 'completed', checks_could_not_run: 'completed', cancelled: 'cancelled', interrupted: 'interrupted', provisioning: 'leased', running: 'running',
    waiting_for_approval: 'awaiting_approval', collecting: 'running', validating: 'completed', 'waiting:retry': 'retry_scheduled' };
  for (const h of HEADLINES) {
    const r = J.jobRun(TASK({ headline: h, state: STATE[h] ?? 'queued', error: null }));
    assert.doesNotMatch(`${r.headline} ${r.word} ${r.next ?? ''}`, JARGON, h);
    assert.doesNotMatch(`${r.headline} ${r.next ?? ''}`, /\bqueued\b|\bslot\b|passing fault|execution runner/i, h);
    for (const s of r.stages) assert.doesNotMatch(s.label, /Sandbox|Collecting/);
    if (h.startsWith('waiting:') || h === 'queued') assert.ok(r.next, `${h} says what happens next`);
  }
  assert.equal(J.jobRun(TASK({ headline: 'waiting:docker', state: 'queued' })).next, 'Start Docker Desktop. The task carries on by itself.');
  assert.equal(J.jobRun(TASK({ headline: 'waiting:image', state: 'queued' })).next, 'Open “Get this computer ready” to download it.');
  assert.deepEqual(J.jobRun(TASK({ headline: 'running', state: 'running' })).stages.map((s) => s.label), ['Waiting', 'Safe space', 'Running', 'Saving results', 'Checking', 'Result']);
  // The titles of the tasks the AI helper starts for itself.
  assert.equal(J.jobTitle({ kind: 'tool.run', actionId: null, recipeId: 'repo.worktree' }), 'Get the AI helper’s safe copy of your project ready');
  assert.equal(J.jobTitle({ kind: 'tool.run', actionId: null, recipeId: 'changeset.accept' }), 'Keep these changes');
  assert.equal(J.jobTitle({ kind: 'tool.run', actionId: null, recipeId: 'repo.ff' }), 'Add to my project');
  assert.equal(J.jobTitle({ kind: 'tool.run', actionId: null, recipeId: 'changeset.merge_check' }), 'Check that the changes fit your project');
  // An AI helper request that ends reads like one: never "complete", and what to do next.
  const turn = J.jobRun(job({ state: 'completed', outcome: 'completed', headline: 'checks_passed' }));
  assert.deepEqual([turn.headline, turn.word, turn.title], ['The AI helper handed in its suggested changes', 'Changes ready to look over', 'Request to the AI helper']);
  assert.equal(turn.next, 'Look over the suggested changes. Press “Looks good” if you are happy with them.');
});

test('PH9 the task list reads: Tasks, tries, See the log; the run log is plain; no job, attempt or byte', () => {
  const runs = src('runs/ProjectRuns.tsx');
  for (const t of ['>Tasks<', 'Reading your tasks…', 'No tasks have run for this project yet.', 'tries', 'See the log', 'Requests to the lead AI helper', '{run.next}']) assert.ok(runs.includes(t), t);
  assert.ok(runs.includes('{GLOSSARY.getReady.name}'), 'one name for the setup sheet');
  assert.doesNotMatch(runs, />Jobs<|Reading jobs|No jobs have run|\$\{job\.attempts\} attempts|>Logs<|This computer’s execution setup/);
  const sheet = src('runs/JobLogSheet.tsx');
  for (const t of ['What the task wrote down', 'Try {n}', 'This task has not started yet, so there is no log.', 'Show more', 'That is the end of the log.']) assert.ok(sheet.includes(t), t);
  assert.doesNotMatch(sheet, />Run log<|Attempt \{|Load more|Starts at byte|Hash \{/);
  // The lead AI helper's requests (the legacy list) are plain too.
  const lead = RM.leadAgentRun({ request: { id: 'r', text: 'x', sentAt: 1 }, queued: false, delivered: true, isLatestDelivered: true, agentPresent: true, agentStatus: 'idle', blocked: false });
  assert.equal(lead.headline, 'Handed to the lead AI helper. Open Agents to see its reply');
  assert.deepEqual(lead.stages.map((s) => s.label), ['Your request', 'Plan', 'Work', 'Result', 'Look over']);
  const strip = src('runs/RunStrip.tsx');
  assert.ok(strip.includes('Open Agents') && strip.includes('Edit and send again'));
  assert.doesNotMatch(strip, /Open conversation|>Send again<|not reported by this agent/i);
});

// ---------- PH10 the request box ----------

test('PH10 the request box says who gets your message: this project\'s AI helper, or the lead AI helper; one label and one plain line', () => {
  const lead = { state: 'ready', deliveryPaused: false };
  const agent = A.intentWords({ mode: 'agent', lead, onSoftwareProject: false, note: null, replyHint: 'Its reply shows up in Agents.' });
  assert.equal(agent.label, 'AI helper for this project');
  assert.equal(agent.explain, 'Your message goes to the AI helper for this project. It works in a safe copy of your project, and your real files change only when you press “Add to my project”. You can follow it in the AI helper panel on the project page.');
  assert.equal(agent.button, 'Ask the AI helper');
  // The box's own name is the button's words (shortened: the dock already says it is this project's AI helper).
  assert.equal(agent.ariaLabel, 'Ask the AI helper');
  const legacy = A.intentWords({ mode: 'legacy', lead, onSoftwareProject: false, note: null, replyHint: 'Its reply shows up in Agents.' });
  assert.equal(legacy.label, 'Lead AI helper');
  assert.equal(legacy.explain, 'Your message goes to the lead AI helper, which passes the work on to others. Its reply shows up in Agents.');
  assert.equal(legacy.button, 'Ask the lead AI helper');
  assert.notEqual(agent.label, legacy.label);
  // A software project whose own AI helper is not ready says why the lead AI helper gets the message.
  const fallback = A.intentWords({ mode: 'legacy', lead, onSoftwareProject: true, note: null });
  assert.match(fallback.explain, /This project’s own AI helper is not ready yet, so the lead AI helper gets it\. To set it up, open “Get this computer ready”\./);
  // The lead AI helper's own states.
  assert.match(A.intentWords({ mode: 'legacy', lead: { state: 'starting' }, onSoftwareProject: false }).explain, /^The lead AI helper is starting\. Your requests wait until it is ready\./);
  assert.match(A.intentWords({ mode: 'legacy', lead: { state: 'ready', deliveryPaused: true }, onSoftwareProject: false }).explain, /ready, but sending is paused in Agents/);
  const off = resolveAssistantStatus({ god: null, godStatus: 'ready', deliveryPaused: false });
  assert.equal(off.reason, 'The lead AI helper is not running. Open Agents to start it.');
  assert.equal(A.intentWords({ mode: 'legacy', lead: off, onSoftwareProject: false }).explain, 'The lead AI helper is not running. Open Agents to start it.');
  // What is sent, and where to follow it.
  // Shortened: the box is inside the AI helper's own conversation, so "Sent." says it; a new conversation is still said.
  assert.equal(agent.sentLead(true), 'Sent.');
  assert.equal(agent.sentLead(false), 'Sent in a new conversation.');
  assert.equal(legacy.sentLead(false), 'Sent to the lead AI helper.');
  assert.equal(agent.followLabel, 'See how it is going in the AI helper panel');
  assert.equal(legacy.followLabel, 'See it in Runs');
  for (const w of [agent, legacy]) for (const t of [w.label, w.explain, w.placeholder, w.button, w.ariaLabel, w.sentLead(true), w.followLabel, w.chipTitle('Fix login')]) {
    assert.doesNotMatch(t, JARGON, t);
    assert.doesNotMatch(t, /\bagent\b/i, `"agent" alone is not a name people see: ${t}`);
  }
  // The box shows the label and the line.
  const il = src('intent/IntentLine.tsx');
  assert.ok(il.includes('className="nx-intent__mode"') && il.includes('{words.label}'));
  assert.ok(il.includes('<span>{words.explain}</span>'));
  // The dock's box is compact: no caption under it (only a locked box says why), and the send button is a small icon with a name and a tooltip.
  assert.ok(!il.includes('Works in a safe copy of your project.'));
  assert.ok(il.includes('(lockedBox && <span className="nx-intent__details">{words.explain}</span>)'));
  assert.ok(il.includes('aria-label={words.button} title={words.button}'));
  const dockCss = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'nexus', 'styles', 'execution.css'), 'utf8');
  assert.ok(dockCss.includes('.nx-ag__input .nx-intent__send-text { display: none; }') && /\.nx-ag__input \.nx-intent__field \{[^}]*max-height: 80px/.test(dockCss));
  assert.equal((il.match(/port\.replyHint/g) || []).length, 1);
});

// ---------- PH11 the one scan ----------

test('PH11 every sentence the panel, the log, the task list and the request box can show is free of jargon and the old names', () => {
  const states = [
    health(), health({ agent: agentView({ consent: { live: false, caps: null, hostsCount: 1, grantedAt: null } }) }), health({ agent: agentView({ state: 'not_installed' }) }),
    health({ agent: agentView({ state: 'unknown' }) }), health({ agent: agentView({ usageToday: { usdCents: 1000, turns: 5, estimated: false } }) })];
  const outs = [];
  for (const h of states) outs.push(...strings(A.agentPanelModel({ health: h, availability: READY, sessions: [session({ status: 'running', liveJobId: 'J1' }), session({ id: 'S2', status: 'awaiting_approval', liveJobId: 'J2' }), session({ id: 'S3' })], sessionsFail: null, now: NOW,
    jobs: new Map([['J1', job()], ['J2', job({ state: 'awaiting_approval', headline: 'waiting_for_approval' })]]) })));
  for (const status of ['open', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled', 'timed_out', 'interrupted']) outs.push(...strings(A.agentPanelModel({ health: health(), availability: READY, sessions: [session({ status })], sessionsFail: null, now: NOW })));
  for (const phase of Object.keys(J.WAIT_PHASE_TEXT)) outs.push(J.WAIT_PHASE_TEXT[phase], J.WAIT_PHASE_NEXT[phase]);
  outs.push(A.CHOOSE_RUNTIME_TEXT, A.ISOLATION_NOTE, A.DISPLAY_ONLY_NOTE, A.REPO_APPROVAL_WAIT_TEXT, A.SIGNIN_UNCONFIRMED_TEXT, A.RECHECK_ON_SEND_TEXT, ...Object.values(A.NEXT_STEP));
  outs.push(A.usageLine({ inputTokens: 9, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, costUsdCents: 3, toolCalls: 2, estimated: false }), A.usageLine({ inputTokens: 9, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, costUsdCents: null, toolCalls: 1, estimated: true }),
    A.usageTodayLine({ usdCents: 0, turns: 0, estimated: false }), A.usageTodayLine({ usdCents: 120, turns: 2, estimated: false }));
  assert.ok(outs.length > 60);
  for (const t of outs) {
    assert.doesNotMatch(t, JARGON, t);
    assert.doesNotMatch(t, /\bthe agent\b|\bagent turns?\b|agent runtime|working copy|network permission|hidden refs|\bSetup\b/i, t);
    assert.doesNotMatch(t, /[a-z]+_[a-z_]+/, `no code: ${t}`);
  }
  const names = [GLOSSARY.aiHelper.name, GLOSSARY.safeCopy.name, GLOSSARY.addToProject.name, GLOSSARY.getReady.name];
  assert.deepEqual(names, ['AI helper', 'safe copy of your project', 'Add to my project', 'Get this computer ready']);
  assert.match(A.ISOLATION_NOTE, /AI helper works in a safe copy of your project/);
  assert.match(A.ISOLATION_NOTE, /Add to my project/);
  // The panel's own words.
  const tsx = src('agent/AgentPanel.tsx');
  for (const t of ['aria-label="AI helper"', 'Hi! What would you like to build?', 'Show what happened', 'Conversations with the AI helper', 'More about the AI helper']) assert.ok(tsx.includes(t), t);
  assert.doesNotMatch(tsx, />Agent<|Ask the agent|Take a repository snapshot|Open Setup|Show log|Hide log|Send to the agent|Message to the agent/);
});
