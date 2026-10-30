// test/nexus-activity-model.test.cjs
// Task 11: the project's recent activity as sentences (activityModel.ts, through
// load-ts), its read state, and source pins on ActivitySection.tsx and
// useActivity.ts (no jsdom).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const M = loadTs('src/renderer/src/nexus/project/activityModel.ts');
const { errorCopy } = loadTs('src/renderer/src/nexus/data/errorCopy.ts');

const ROOT = path.join(__dirname, '..');
const NEXUS = path.join(ROOT, 'src', 'renderer', 'src', 'nexus');
const src = (p) => fs.readFileSync(path.join(NEXUS, p), 'utf8');

const NOW = 1_800_000_000_000;
const row = (o = {}) => ({
  seq: 1, ts: NOW - 5 * 60_000, action: 'version.register', status: 'succeeded', actorKind: 'user', onBehalfOfUser: false,
  entityType: 'artifact_version', entityId: 'V1', projectId: 'p', workspaceId: 'sde', artifactId: 'A1', versionId: 'V1', details: {}, ...o
});
const ctx = (o = {}) => ({
  names: new Map([['A1', 'API notes']]), versionNos: new Map([['V2', 2]]),
  workspaceLabel: (id) => ({ sde: 'Software', qa: 'Quality' })[id] ?? id, now: NOW, ...o
});

/** Every action string the main services write to the activity log (scanned from the sources). */
function writtenActions() {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const out = new Set();
  for (const f of walk(path.join(ROOT, 'src', 'main')).filter((f) => f.endsWith('.ts'))) {
    const s = fs.readFileSync(f, 'utf8');
    for (const m of s.matchAll(/appendActivityRow\([\s\S]*?\}, *now\)/g)) for (const a of m[0].matchAll(/action: '([a-z_.]+)'/g)) out.add(a[1]);
    for (const m of s.matchAll(/const [A-Z_]*ACTION[A-Z_]* = '([a-z_.]+)'/g)) out.add(m[1]);
    for (const m of s.matchAll(/applyTransition\([^;]*?action: '([a-z_.]+)'/g)) out.add(m[1]);
  }
  return out;
}

// ---------- AC1–AC5 ----------

test('AC1: every action the services write maps to a sentence (never the "Recorded" fallback)', () => {
  const written = writtenActions();
  assert.ok(written.size >= 20, `the scan found the service actions (${written.size})`);
  for (const a of written) assert.ok(M.ACTIVITY_ACTIONS.includes(a), `${a} is listed`);
  for (const a of M.ACTIVITY_ACTIONS) {
    const t = M.activityText(row({ action: a }), ctx());
    assert.ok(t.length > 0 && t !== M.UNKNOWN_ACTION_SENTENCE, `${a} → ${t}`);
  }
  // The sentences the Passport shows for the B1 flows.
  assert.equal(M.activityText(row({ action: 'version.finalize', actorKind: 'system', onBehalfOfUser: true, versionId: 'V2', details: { from: 'draft', to: 'candidate' } }), ctx()), 'Version 2 of API notes marked as ready');
  assert.equal(M.activityText(row({ action: 'version.register', details: { versionNo: 3 } }), ctx()), 'Version 3 of API notes saved');
  assert.equal(M.activityText(row({ action: 'version.promote', versionId: 'V2', details: { rollback: false } }), ctx()), 'Version 2 of API notes is now in use');
  assert.equal(M.activityText(row({ action: 'version.promote', versionId: 'V2', details: { rollback: true } }), ctx()), 'Version 2 of API notes is in use again (went back)');
  assert.equal(M.activityText(row({ action: 'version.discard', versionId: 'V2' }), ctx()), 'Version 2 of API notes discarded');
  assert.equal(M.activityText(row({ action: 'version.discard', versionId: 'V9' }), ctx()), 'A version of API notes discarded');
  assert.equal(M.activityText(row({ action: 'lineage.write', versionId: 'V2', details: { source: 'user_action' } }), ctx()), 'Added what version 2 of API notes was made from');
  assert.equal(M.activityText(row({ action: 'artifact.create', details: { kind: 'text_file' } }), ctx()), 'File API notes created');
  assert.equal(M.activityText(row({ action: 'participation.attach', workspaceId: 'qa', details: { reactivated: true } }), ctx()), 'Project added to Quality again');
  assert.equal(M.activityText(row({ action: 'participation.withdraw', workspaceId: 'qa' }), ctx()), 'Project removed from Quality');
  assert.equal(M.activityText(row({ action: 'handoff.send', details: { subjects: 2, toWorkspaceId: 'qa' } }), ctx()), 'Handoff of 2 versions sent to Quality');
  assert.equal(M.activityText(row({ action: 'handoff.decline', details: { withNote: true } }), ctx()), 'Handoff declined, with a note');
  assert.equal(M.activityText(row({ action: 'job.transition', details: { to: 'timed_out' } }), ctx()), 'Task took too long and was stopped');
});

test('AC2: an unknown action says Nexus has no words for it, never its name, and shows no details', () => {
  const t = M.activityText(row({ action: 'future.thing', details: { versionNo: 4, secret: 'sk-live-123', note: 'hello' } }), ctx());
  assert.equal(t, M.UNKNOWN_ACTION_SENTENCE);
  assert.doesNotMatch(t, /future\.thing|sk-live|hello/);
  // An action name never reaches the screen, whatever its shape.
  assert.equal(M.activityText(row({ action: 'x <script>' }), ctx()), M.UNKNOWN_ACTION_SENTENCE);
  assert.equal(M.activityText(row({ action: 'a'.repeat(80) }), ctx()), M.UNKNOWN_ACTION_SENTENCE);
});

// The words the plain-words glossary retired never reach an activity sentence, whatever the action, status or detail.
test('AC-P: no activity sentence uses an internal word (job, session, sandbox, dev deployment, health check, refs, worktree, branch, commit, artifact...)', () => {
  const BANNED = /\b(jobs?|sessions?|sandbox|dev deployment|health check|probe|hidden refs?|worktree|working copy|change sets?|branch|commits?|artifacts?|fast-forward|merged?|repository|revalidate|egress|dependenc(y|ies)|manifest|runtime|agent|engine|database|registry|domain|consent|turn)\b/i;
  const details = [{}, { to: 'candidate' }, { to: 'failed' }, { to: 'healthy' }, { to: 'unhealthy' }, { to: 'stopped' }, { rollback: true }, { source: 'handoff_convert' },
    { reason: 'egress.deps', decision: 'once' }, { reason: 'image.prepare', decision: 'once' }, { reason: 'repo.write_refs', decision: 'once' }, { decision: 'deny' },
    { decision: 'approve' }, { decision: 'request_changes' }, { decision: 'reject' }, { op: 'grant' }, { op: 'revoke' }, { op: 'delete' }, { reused: true },
    { status: 'succeeded' }, { status: 'failed' }, { status: 'interrupted' }, { status: 'cancelled' }, { job: 'completes_on_exit' }, { requested: 3 }, { reactivated: true }];
  const variants = [];
  for (const a of M.ACTIVITY_ACTIONS) for (const d of details) {
    variants.push(row({ action: a, details: d }));
    for (const reason of ['probe_failed', 'exited', 'start_timeout', 'refused', 'preflight_failed', 'runner_lost', 'exit_not_reported', 'idle', 'app_quit', 'recovery', 'cancel', 'user']) variants.push(row({ action: a, details: { ...d, reason } }));
  }
  for (const decision of ['requeue', 'retry', 'interrupt', 'reown', 'expire', 'adopt', 'finalize', 'exit_lost', 'unreconciled', 'unknown_resources', 'image_interrupted', 'orphans', 'accept_rollback', 'fail', 'zzz']) {
    variants.push(row({ action: 'exec.recover', details: { decision } }));
    for (const status of ['oom', 'nonzero_exit', 'invalid_output']) variants.push(row({ action: 'exec.recover', details: { decision, status } }));
  }
  for (const status of ['denied', 'failed', 'cancelled']) for (const a of [...M.ACTIVITY_ACTIONS, 'project.read', 'workspace.read', 'artifact.read', 'lineage.read', 'job.read', 'session.read', 'activity.read', 'system.reconcile',
    'handoff.read', 'handoff.respond', 'approval.read', 'platform.health', 'agent.start']) variants.push(row({ action: a, status }));
  assert.ok(variants.length > 500, `the scan covers many rows (${variants.length})`);
  for (const r of variants) {
    const t = M.activityText(r, ctx());
    assert.doesNotMatch(t, BANNED, `${r.action} ${r.status} ${JSON.stringify(r.details)} -> ${t}`);
  }
  assert.doesNotMatch(M.actorText({ actorKind: 'agent' }), BANNED);
});

test('AC3: a denied row reads "Refused: <action>"', () => {
  assert.equal(M.activityText(row({ status: 'denied', action: 'version.promote' }), ctx()), 'Refused: put a version in use');
  assert.equal(M.activityText(row({ status: 'denied', action: 'project.read' }), ctx()), 'Refused: read the project');
  assert.equal(M.activityText(row({ status: 'denied', action: 'future.thing', details: { reason: 'no_membership' } }), ctx()), 'Refused: an action this version of Nexus does not know');
  assert.equal(M.activityText(row({ status: 'failed', action: 'job.create' }), ctx()), 'Failed: start a task');
  assert.equal(M.activityText(row({ status: 'cancelled', action: 'job.create' }), ctx()), 'Cancelled: start a task');
});

test('AC4: a system-on-behalf row reads "Nexus, for you"; the principal id is never shown', () => {
  assert.equal(M.actorText({ actorKind: 'system', onBehalfOfUser: true }), 'Nexus, for you');
  assert.equal(M.actorText({ actorKind: 'system', onBehalfOfUser: false }), 'Nexus');
  assert.equal(M.actorText({ actorKind: 'user', onBehalfOfUser: false }), 'You');
  assert.equal(M.actorText({ actorKind: 'agent', onBehalfOfUser: false }), 'The AI helper');
  const line = M.activityLine(row({ actorKind: 'system', onBehalfOfUser: true, actorId: 'user:local', action: 'version.finalize', details: { to: 'candidate' } }), ctx());
  assert.equal(line.actor, 'Nexus, for you');
  assert.doesNotMatch(JSON.stringify(line), /user:local|system:/);
});

test('AC5: no detail key outside the allow-list is ever read or rendered', () => {
  const read = new Set();
  const details = new Proxy({ versionNo: 2, to: 'candidate', rollback: true, source: 'user_action', reactivated: true, subjects: 3,
    toWorkspaceId: 'qa', withNote: true, kind: 'text_file', relation: 'derived_from', toVersionId: 'SECRETVERSIONID', inputs: 4,
    edges: 9, result: 'SECRETRESULT', path: 'C:/Users/me/.env', previous: 'SECRETPREV', from: 'SECRETFROM' }, {
    get(t, k) { if (typeof k === 'string') read.add(k); return t[k]; },
    has(t, k) { if (typeof k === 'string') read.add(k); return k in t; },
    getOwnPropertyDescriptor(t, k) { if (typeof k === 'string') read.add(k); return Object.getOwnPropertyDescriptor(t, k); }
  });
  const texts = [];
  for (const a of [...M.ACTIVITY_ACTIONS, 'future.thing']) {
    for (const status of ['succeeded', 'denied', 'failed', 'started']) {
      const l = M.activityLine(row({ action: a, status, details }), ctx());
      texts.push(l.text, l.actor, l.when);
    }
  }
  for (const k of read) assert.ok(M.ACTIVITY_DETAIL_ALLOW.includes(k), `read ${k}`);
  const all = texts.join('\n');
  assert.doesNotMatch(all, /SECRET|\.env|C:\/|derived_from|\{|\}/);
  // An allow-listed key with an unexpected value shape is not echoed either.
  const odd = M.activityText(row({ action: 'artifact.create', details: { kind: 'Bad Kind <b>' } }), ctx({ names: new Map() }));
  assert.equal(odd, 'Saved item created');
  const odd2 = M.activityText(row({ action: 'handoff.send', details: { toWorkspaceId: '../../etc', subjects: '7 secrets' } }), ctx());
  assert.equal(odd2, 'Handoff sent');
  const odd3 = M.activityText(row({ action: 'version.register', versionId: 'V9', details: { versionNo: 'nine' } }), ctx());
  assert.equal(odd3, 'A version of API notes saved');
});

// ---------- lines, numbers and the read state ----------

test('activityLine: time in plain words with an ISO stamp; versionNumbers from summaries and saved rows', () => {
  const l = M.activityLine(row({ seq: 7 }), ctx());
  assert.equal(l.key, '7');
  assert.equal(l.when, '5m ago');
  assert.equal(l.at, new Date(NOW - 5 * 60_000).toISOString());
  assert.equal(M.activityLine(row({ ts: NaN }), ctx()).when, '');
  const nos = M.versionNumbers([row({ versionId: 'V5', details: { versionNo: 5 } }), row({ action: 'version.discard', versionId: 'V6', details: { versionNo: 6 } })],
    [{ artifact: { id: 'A1' }, versionCount: 2, latest: { id: 'V2', versionNo: 2, status: 'draft' }, current: { id: 'V1', versionNo: 1 } }]);
  assert.deepEqual([...nos.entries()].sort(), [['V1', 1], ['V2', 2], ['V5', 5]]);
});

test('nextActivity: first page replaces, older pages append, truncated is kept, failures say why', () => {
  const r1 = { ok: true, data: [row({ seq: 9 }), row({ seq: 8 })], truncated: true };
  const s1 = M.nextActivity(M.NO_ACTIVITY, r1, 'first');
  assert.deepEqual(s1.rows.map((r) => r.seq), [9, 8]);
  assert.equal(s1.truncated, true);
  assert.equal(M.olderPageCursor(s1), 8);
  const s2 = M.nextActivity({ ...s1, loadingMore: true }, { ok: true, data: [row({ seq: 8 }), row({ seq: 7 })] }, 'more');
  assert.deepEqual(s2.rows.map((r) => r.seq), [9, 8, 7], 'no duplicate');
  assert.equal(s2.truncated, false);
  assert.equal(s2.loadingMore, false);
  assert.equal(M.olderPageCursor(s2), null);
  // Empty.
  const e = M.nextActivity(M.NO_ACTIVITY, { ok: true, data: [] }, 'first');
  assert.deepEqual(M.activityNotice(e), { kind: 'empty', text: 'Nothing has happened in this project yet. What you and Nexus do will be listed here.', retry: false });
  assert.equal(M.activityNotice(M.NO_ACTIVITY).kind, 'loading');
  // Busy keeps what was read and offers a retry.
  const b = M.nextActivity(s1, { ok: false, code: 'platform_unavailable', reason: 'busy', message: 'm' }, 'first');
  assert.deepEqual(b.rows.map((r) => r.seq), [9, 8]);
  assert.equal(b.error, errorCopy('platform_unavailable', 'busy').text);
  assert.equal(b.retry, true);
  assert.equal(M.activityNotice(b), null, 'rows stay; the error shows beside them');
  const i = M.nextActivity(M.NO_ACTIVITY, { ok: false, code: 'internal', message: 'm' }, 'first');
  assert.deepEqual(M.activityNotice(i), { kind: 'error', text: errorCopy('internal').text, retry: true });
  // Denied or not found: nothing stale.
  const d = M.nextActivity(s1, { ok: false, code: 'denied', message: 'm' }, 'first');
  assert.deepEqual(d.rows, []);
  assert.equal(d.error, errorCopy('denied').text);
  assert.equal(d.retry, false);
  // The platform is off: nothing, and the section hides.
  const u = M.nextActivity(s1, { ok: false, code: 'platform_unavailable', reason: 'held', message: 'm' }, 'first');
  assert.equal(u.unavailable, true);
  assert.deepEqual(u.rows, []);
  assert.equal(u.error, null);
});

test('ACTIVITY_PAGE stays within the channel limit', () => {
  assert.ok(M.ACTIVITY_PAGE >= 1 && M.ACTIVITY_PAGE <= 50);
});

// ---------- source pins ----------

const section = src('project/ActivitySection.tsx');
const hook = src('data/useActivity.ts');
const panel = src('project/PassportPanel.tsx');

test('pin: useActivity reads nexus:activity:byProject with the paging limit, reloads on rev, and never rejects', () => {
  assert.match(hook, /nexusClient\.activityByProject\(projectId, \{ limit: ACTIVITY_PAGE \}\)/);
  assert.match(hook, /nexusClient\.activityByProject\(projectId, \{ beforeSeq, limit: ACTIVITY_PAGE \}\)/);
  assert.match(hook, /\[projectId, rev, mode, attempt\]/);
  assert.equal((hook.match(/try \{/g) || []).length, 2);
  assert.equal((hook.match(/\} catch \{/g) || []).length, 2);
  assert.doesNotMatch(hook, /\.then\(/);
});

test('pin: the activity section shows sentences, actor words and time only; hides while the platform is off', () => {
  assert.match(section, /if \(a\.unavailable\) return null;/);
  assert.match(section, /activityLine\(r, ctx\)/);
  assert.match(section, /<time dateTime=\{l\.at\}>\{l\.when\}<\/time>/);
  assert.doesNotMatch(section, /JSON\.stringify|\.details|actorId|entityId|onBehalfOf/);
  assert.match(section, /Show older activity/);
  assert.match(section, /onClick=\{a\.loadOlder\}/);
  assert.match(section, /onClick=\{a\.reload\}>Try again/);
  assert.match(panel, /\{node\.kind === 'source' && <ActivitySection key=\{project\.id\} projectId=\{project\.id\} artifacts=\{artifacts\} \/>\}/);
});

test('pin: the activity styles use a unique prefix and existing tokens only', () => {
  const css = fs.readFileSync(path.join(NEXUS, 'styles', 'platform.css'), 'utf8');
  for (const cls of ['nx-acx__list', 'nx-acx__row', 'nx-acx__text', 'nx-acx__meta', 'nx-acx__line', 'nx-acx__more']) {
    assert.match(css, new RegExp(`\\.${cls}\\b`), cls);
    assert.match(section, new RegExp(`className="(?:[^"]* )?${cls}(?: [^"]*)?"`), cls);
  }
  const tokens = fs.readFileSync(path.join(NEXUS, 'styles', 'tokens.css'), 'utf8');
  for (const v of new Set(css.match(/var\(--nx-[a-z0-9-]+\)/g) || [])) assert.ok(tokens.includes(`${v.slice(4, -1)}:`), v);
});

test('every written action (including the legacy primary sync) reads as a plain sentence', () => {
  const written = writtenActions();
  assert.ok(written.has('project_workspace.primary_synced'), 'the scan sees the constant-named action');
  for (const a of written) {
    const t = M.activityText(row({ action: a, workspaceId: null, details: {} }), ctx());
    assert.ok(t !== M.UNKNOWN_ACTION_SENTENCE && !t.includes(a), `${a} → ${t}`);
  }
  assert.equal(M.activityText(row({ action: 'project_workspace.primary_synced', details: { workspaceId: 'qa', result: 'x' } }), ctx()), 'Main workspace set to Quality, from what Nexus found in the project');
  assert.equal(M.activityText(row({ action: 'project_workspace.primary_synced', details: { workspaceId: null } }), ctx()), 'Main workspace set from what Nexus found in the project');
});

test('source pins: the Details sheet focuses its heading; the handoff title is selected on first focus', () => {
  const sheet = src('ui/Sheet.tsx');
  assert.match(sheet, /focusHeading/);
  assert.match(sheet, /heading\.focus\(\)/);
  assert.match(src('project/ProjectBench.tsx'), /<Sheet open=\{detailsOpen\}[^>]*\bfocusHeading\b/);
  const send = src('handoffs/SendHandoffSheet.tsx');
  assert.match(send, /value=\{state\.title\}[\s\S]{0,200}onFocus=\{\(e\) => \{[^}]*e\.currentTarget\.select\(\)/);
});
