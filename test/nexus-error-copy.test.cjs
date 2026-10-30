// test/nexus-error-copy.test.cjs
// R8: every nexus:* error code and every reason in the IPC table has plain copy; no raw code is ever shown.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const E = loadTs('src/renderer/src/nexus/data/errorCopy.ts');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** The string literals of a `export type Name = 'a' | 'b' ...;` union in a source file. */
function unionOf(file, name) {
  const src = read(file);
  const m = src.match(new RegExp(`export type ${name} =([^;]+);`));
  assert.ok(m, `${name} in ${file}`);
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

const CODES = [...unionOf('src/shared/nexus/platform.ts', 'PlatformErrorCode'), 'internal'];
const UNAVAILABLE = unionOf('src/shared/nexus/ipc.ts', 'PlatformUnavailableReason');
const HANDOFF_SUBS = unionOf('src/shared/nexus/ipc.ts', 'HandoffsUnavailableSubReason');
// The service reasons in the IPC table (channels #9, #10, #11) plus bad_request from validation.
const SERVICE = ['bad_request', 'not_a_repository', 'not_a_commit', 'project_folder_unavailable', 'kind_mismatch', 'secret_in_metadata',
  'file_not_found', 'path_refused', 'too_large', 'not_text', 'secret_in_content', 'sensitive_name', 'produced_by_job'];

/** A shown sentence: non-empty, one line, ends with a full stop, and holds no snake_case token. */
function plain(text, what) {
  assert.equal(typeof text, 'string', what);
  assert.ok(text.trim().length > 10, what);
  assert.doesNotMatch(text, /\n/, what);
  assert.match(text, /\.$/, what);
  assert.doesNotMatch(text, /\b[a-z]+_[a-z_]+\b/, `${what}: ${text}`);
}

test('R8 every NexusErrorCode has its own plain sentence that never names the code', () => {
  assert.deepEqual([...E.NEXUS_ERROR_CODES].sort(), [...CODES].sort());
  for (const code of CODES) {
    const c = E.errorCopy(code);
    plain(c.text, code);
    assert.doesNotMatch(c.text, new RegExp(`\\b${code.replace(/_/g, '[ _]')}\\b`, 'i'), `${code}: ${c.text}`);
  }
});

test('R8 every platform-unavailable reason has a notice; busy is "try again", not the degraded mode', () => {
  assert.deepEqual([...E.UNAVAILABLE_REASONS].sort(), [...UNAVAILABLE].sort());
  for (const r of UNAVAILABLE) {
    const c = E.errorCopy('platform_unavailable', r);
    plain(c.text, r);
    assert.equal(c.kind, 'unavailable', r);
    assert.equal(c.retry, false, r);
    assert.match(c.text, /grouped by their kind of work/, r);
    assert.doesNotMatch(c.text, /database|domain|upgrade|schema/i, `${r}: no technical word`);
  }
  assert.equal(E.unavailableNotice('held'),
    "Some of Nexus's saved information is not ready because an update to it is on hold. Projects are grouped by their kind of work for now. Try restarting the app.");
  // True at startup and mid-session alike.
  assert.equal(E.unavailableNotice('startup_failed'),
    "Some of Nexus's saved information is not ready because Nexus could not read it. Projects are grouped by their kind of work for now. Try restarting the app.");
  // A newer app already changed the saved information: restarting cannot help, updating can.
  assert.match(E.unavailableNotice('newer_schema'), /Update this app/);
  assert.doesNotMatch(E.unavailableNotice('startup_failed'), /did not start/);
  const busy = E.errorCopy('platform_unavailable', 'busy');
  assert.deepEqual([busy.kind, busy.retry], ['busy', true]);
  assert.match(busy.text, /try again/i);
  assert.doesNotMatch(busy.text, /grouped by/);
  plain(E.errorCopy('platform_unavailable', 'something_new').text, 'unknown unavailable reason');
  plain(E.errorCopy('platform_unavailable').text, 'no reason');
});

test('R8 handoffs_unavailable affects only handoffs, with every sub-reason covered', () => {
  assert.deepEqual([...E.HANDOFFS_SUB_REASONS].sort(), [...HANDOFF_SUBS].sort());
  for (const s of [...HANDOFF_SUBS, null, 'unknown_sub']) {
    const c = E.errorCopy('platform_unavailable', 'handoffs_unavailable', s);
    plain(c.text, `handoffs ${s}`);
    assert.equal(c.kind, 'handoffs_unavailable');
    assert.match(c.text, /^Handoffs are not available/);
    assert.doesNotMatch(c.text, /Workspace data|grouped by/);
  }
});

test('R8 every service reason in the IPC table has a sentence; internal may be retried', () => {
  assert.deepEqual([...E.SERVICE_REASONS].sort(), [...SERVICE].sort());
  for (const r of SERVICE) {
    const c = E.errorCopy('invalid', r);
    plain(c.text, r);
    assert.equal(c.kind, 'refused');
    if (r !== 'bad_request') assert.notEqual(c.text, E.errorCopy('invalid').text, `${r} has its own sentence`);
  }
  assert.deepEqual([E.errorCopy('internal').kind, E.errorCopy('internal').retry], ['internal', true]);
  plain(E.errorCopy('some_future_code').text, 'unknown code');
  plain(E.errorCopy('invalid', 'some_future_reason').text, 'unknown reason falls back to the code');
});

test('R8b every reason main words (REASON_MESSAGES) reads the same in the renderer (REASON_TEXT)', () => {
  const { REASON_MESSAGES, BUSY_MESSAGE } = loadTs('src/main/nexusIpc/envelope.ts');
  const shared = Object.keys(REASON_MESSAGES).filter((k) => Object.prototype.hasOwnProperty.call(E.REASON_TEXT, k));
  assert.deepEqual(shared.sort(), Object.keys(REASON_MESSAGES).sort(), 'every main reason has a renderer sentence');
  for (const k of shared) {
    assert.equal(E.REASON_TEXT[k], REASON_MESSAGES[k], k);
    assert.equal(E.errorCopy('invalid', k).text, REASON_MESSAGES[k], k);
  }
  assert.match(E.REASON_TEXT.path_refused, /outside the project folder/);
  assert.match(E.REASON_TEXT.path_refused, /linked file that is also stored under other names/);
  assert.equal(E.BUSY_TEXT, BUSY_MESSAGE);
});

/** Words a newcomer should never meet in a fixed sentence: git internals and the old agent/runtime/sandbox vocabulary. */
const JARGON = /\b(branch(es)?|worktree|fast-forward|working tree|uncommitted|untracked|tracked files|hidden refs?|repository|snapshot|commit(s)?|merge[ds]?|runtime|sandbox|artifacts?|change sets?|API key|pnpm|hard links?|database|domain|registry|proxy|egress|probe|execution runner|dev deployment|jobs?)\b/i;

test('R8c plain words: every fixed sentence (agent, review, accept, setup, run) is one plain line with no git or internal words', () => {
  const { AGENT_REASON_MESSAGES, SETUP_MESSAGES, EXECUTION_UNAVAILABLE_MESSAGE, AGENTS_UNAVAILABLE_MESSAGE } = loadTs('src/main/nexusIpc/envelope.ts');
  const tables = { AGENT_REASON_TEXT: E.AGENT_REASON_TEXT, SETUP_TEXT: E.SETUP_TEXT, EXEC_REASON_TEXT: E.EXEC_REASON_TEXT,
    AGENT_OFF_REASON_TEXT: E.AGENT_OFF_REASON_TEXT, AGENT_REASON_MESSAGES, SETUP_MESSAGES };
  for (const [name, table] of Object.entries(tables)) {
    for (const [k, v] of Object.entries(table)) {
      plain(v, `${name}.${k}`);
      assert.doesNotMatch(v, JARGON, `${name}.${k}: ${v}`);
    }
  }
  for (const v of [E.ROLLBACK_OWED_TEXT, E.AGENT_OFF_TEXT, E.AGENT_ACTION_OFF_TEXT, E.BUSY_TEXT, EXECUTION_UNAVAILABLE_MESSAGE, AGENTS_UNAVAILABLE_MESSAGE]) {
    plain(v, v);
    assert.doesNotMatch(v, JARGON, v);
  }
  for (const s of E.EXECUTION_SUB_REASONS) { const t = E.executionNotice(s); plain(t, s); assert.doesNotMatch(t, JARGON, t); }
  for (const s of E.HANDOFFS_SUB_REASONS) { const t = E.handoffsNotice(s); plain(t, s); assert.doesNotMatch(t, JARGON, t); }
  for (const s of E.EXECUTION_SUB_REASONS) { const t = E.agentsNotice(s); plain(t, s); assert.doesNotMatch(t, JARGON, t); }
  for (const s of E.UNAVAILABLE_REASONS) { const t = E.unavailableNotice(s); plain(t, s); assert.doesNotMatch(t, JARGON, t); }
});

test('R8c main and renderer word the agent and setup sentences the same, word for word', () => {
  const { AGENT_REASON_MESSAGES, SETUP_MESSAGES } = loadTs('src/main/nexusIpc/envelope.ts');
  for (const [k, v] of Object.entries(AGENT_REASON_MESSAGES)) assert.equal(E.AGENT_REASON_TEXT[k], v, k);
  for (const [k, v] of Object.entries(SETUP_MESSAGES)) assert.equal(E.SETUP_TEXT[k], v, k);
  assert.deepEqual(Object.keys(E.SETUP_TEXT).sort(), Object.keys(SETUP_MESSAGES).sort());
});

test('R8c the hard cases say what happened and the safe next step in plain words', () => {
  // Diverged: no "merge in your own tools"; nothing was changed; someone who knows the project's history combines the two.
  assert.match(E.AGENT_REASON_TEXT.integration_diverged, /Nothing was changed/);
  assert.match(E.AGENT_REASON_TEXT.integration_diverged, /ask a developer/);
  assert.doesNotMatch(E.AGENT_REASON_TEXT.integration_diverged, /your own tools|merge|branch|code/i);
  // The model and key sentences keep their meaning.
  assert.match(E.AGENT_REASON_TEXT.hosted_key_rejected, /did not accept your access key/);
  assert.match(E.AGENT_REASON_TEXT.hosted_quota_exhausted, /free allowance/);
  assert.match(E.AGENT_REASON_TEXT.hosted_rate_limited, /fewer requests/);
  assert.match(E.AGENT_REASON_TEXT.hosted_model_unavailable, /not available from this AI service/);
  assert.match(E.AGENT_REASON_TEXT.hosted_provider_not_chosen, /No online AI service is chosen/);
  assert.match(E.AGENT_REASON_TEXT.local_model_not_chosen, /No AI model is chosen/);
  assert.match(E.AGENT_REASON_TEXT.local_model_server_down, /not running/);
  assert.match(E.AGENT_REASON_TEXT.consent_missing, /internet permission/);
  // Every refusal that asks the person to go somewhere names the one place.
  for (const [k, v] of Object.entries(E.AGENT_REASON_TEXT)) assert.doesNotMatch(v, /\bSetup\b/, `${k} names the old Setup`);
});
