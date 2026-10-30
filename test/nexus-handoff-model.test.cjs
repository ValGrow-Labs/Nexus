// test/nexus-handoff-model.test.cjs
// Task 13: the Handoffs page, the send sheet, and accept, decline and withdraw.
// The pure model (inbox and sent per workspace, the list and detail reads,
// subjects by reference, which side may give which answer, the answer state
// machine, the send sheet's choices and checks, the Passport's handoff rows)
// through load-ts; plus source pins on the .tsx files (no jsdom).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const M = loadTs('src/renderer/src/nexus/handoffs/handoffModel.ts');
const { errorCopy, handoffsNotice } = loadTs('src/renderer/src/nexus/data/errorCopy.ts');
const { fromRows } = loadTs('src/renderer/src/nexus/workspaces/participation.ts');

const NEXUS = path.join(__dirname, '..', 'src', 'renderer', 'src', 'nexus');
const src = (p) => fs.readFileSync(path.join(NEXUS, p), 'utf8');
const fail = (code, extra = {}) => ({ ok: false, code, message: 'm', ...extra });

const H1 = '01J9ZQ3V4K5M6N7P8Q9R0STHH1';
const H2 = '01J9ZQ3V4K5M6N7P8Q9R0STHH2';
const H3 = '01J9ZQ3V4K5M6N7P8Q9R0STHH3';
const A1 = '01J9ZQ3V4K5M6N7P8Q9R0STVW1';
const A2 = '01J9ZQ3V4K5M6N7P8Q9R0STVW2';
const A3 = '01J9ZQ3V4K5M6N7P8Q9R0STVW3';
const V1 = '01J9ZQ3V4K5M6N7P8Q9R0STVV1';
const V2 = '01J9ZQ3V4K5M6N7P8Q9R0STVV2';
const V3 = '01J9ZQ3V4K5M6N7P8Q9R0STVV3';
const V4 = '01J9ZQ3V4K5M6N7P8Q9R0STVV4';
const V5 = '01J9ZQ3V4K5M6N7P8Q9R0STVV5';
const P_SDE = '01J9ZQ3V4K5M6N7P8Q9R0STPP1';
const P_QA = '01J9ZQ3V4K5M6N7P8Q9R0STPP2';
const P_ML = '01J9ZQ3V4K5M6N7P8Q9R0STPP3';
const P_OLD = '01J9ZQ3V4K5M6N7P8Q9R0STPP4';
const P_OTHER = '01J9ZQ3V4K5M6N7P8Q9R0STPP5';

function handoff(id, from, to, o = {}) {
  return {
    id, projectId: o.projectId ?? 'p1', fromParticipationId: `PART-${from}`, fromWorkspaceId: from, toParticipationId: `PART-${to}`, toWorkspaceId: to,
    title: o.title ?? `Handoff ${id.slice(-1)}`, note: o.note ?? null, subjectCount: o.subjectCount ?? 1, status: o.status ?? 'sent',
    respondedAt: o.respondedAt ?? null, responseNote: o.responseNote ?? null, receiptVersionId: o.receiptVersionId ?? null,
    createdAt: 10, updatedAt: 20, statusChangedAt: o.statusChangedAt ?? 20
  };
}
function subject(versionId, o = {}) {
  return {
    versionId, position: o.position ?? 0, contentHash: o.contentHash ?? 'git:0123456789abcdef0123456789abcdef01234567', artifactId: o.artifactId ?? A1,
    artifactName: o.artifactName ?? 'API notes', kind: o.kind ?? 'git_commit', versionNo: o.versionNo ?? 1, status: o.status ?? 'active',
    newerVersionNo: o.newerVersionNo === undefined ? null : o.newerVersionNo
  };
}
const detail = (h, subjects) => ({ ...h, subjects });

const IDX = fromRows([
  { id: P_SDE, projectId: 'p1', workspaceId: 'sde', status: 'active', isPrimary: true, source: 'backfill' },
  { id: P_QA, projectId: 'p1', workspaceId: 'qa', status: 'active', isPrimary: false, source: 'user' },
  { id: P_ML, projectId: 'p1', workspaceId: 'ml', status: 'active', isPrimary: false, source: 'user' },
  { id: P_OLD, projectId: 'p1', workspaceId: 'devops', status: 'withdrawn', isPrimary: false, source: 'user' },
  { id: P_OTHER, projectId: 'p2', workspaceId: 'qa', status: 'active', isPrimary: true, source: 'backfill' }
]);

function art(id, owner, versions, o = {}) {
  return {
    artifact: {
      id, projectId: o.projectId ?? 'p1', kind: o.kind ?? 'git_commit', name: o.name ?? `Art ${id.slice(-1)}`, description: null,
      ownerScope: 'participation', ownerParticipationId: owner, ownerWorkspaceId: 'sde', status: o.status ?? 'active',
      currentVersionId: null, createdAt: 1, updatedAt: o.updatedAt ?? 100
    },
    versions: versions.map(([vid, no, status]) => ({
      id: vid, artifactId: id, versionNo: no, projectId: o.projectId ?? 'p1', participationId: owner, status, draftFlag: null, storageKind: 'git',
      contentHash: `git:${'ab'.repeat(20)}`, validationState: 'passed', producedByEngine: false, producedByAction: null, createdAt: 1, statusChangedAt: 1, promotedAt: null
    }))
  };
}

// ---------- HM1: inbox and sent per workspace ----------

test('HM1 inbox and sent are partitioned per workspace', () => {
  const rows = [handoff(H1, 'sde', 'qa'), handoff(H2, 'qa', 'ml'), handoff(H3, 'sde', 'ml')];
  const parts = M.partitionByWorkspace(rows);
  const ids = (list) => list.map((h) => h.id);
  assert.deepEqual(ids(parts.get('sde').inbox), []);
  assert.deepEqual(ids(parts.get('sde').sent), [H1, H3]);
  assert.deepEqual(ids(parts.get('qa').inbox), [H1]);
  assert.deepEqual(ids(parts.get('qa').sent), [H2]);
  assert.deepEqual(ids(parts.get('ml').inbox), [H2, H3]);
  assert.deepEqual(ids(parts.get('ml').sent), []);
  // Each handoff is in exactly one inbox and one sent box.
  for (const h of rows) {
    let inbox = 0; let sent = 0;
    for (const b of parts.values()) { inbox += b.inbox.filter((x) => x.id === h.id).length; sent += b.sent.filter((x) => x.id === h.id).length; }
    assert.equal(inbox, 1); assert.equal(sent, 1);
  }
});

test('HM1 groups: the inbox by receiving workspace, sent by sending workspace, registry order; a chosen workspace keeps its own', () => {
  const rows = [handoff(H1, 'sde', 'qa'), handoff(H2, 'qa', 'ml'), handoff(H3, 'sde', 'ml')];
  const inbox = M.handoffGroups(rows, { box: 'inbox', workspaceId: '' });
  assert.deepEqual(inbox.map((g) => [g.workspaceId, g.title, g.rows.map((h) => h.id)]), [['ml', 'To Machine learning', [H2, H3]], ['qa', 'To Testing', [H1]]]);
  const sent = M.handoffGroups(rows, { box: 'sent', workspaceId: '' });
  assert.deepEqual(sent.map((g) => [g.title, g.rows.map((h) => h.id)]), [['From Software', [H1, H3]], ['From Testing', [H2]]]);
  assert.deepEqual(M.handoffGroups(rows, { box: 'inbox', workspaceId: 'qa' }).map((g) => g.title), ['To Testing']);
  assert.deepEqual(M.handoffGroups(rows, { box: 'sent', workspaceId: 'ml' }), []);
  const all = M.handoffGroups(rows, { box: 'all', workspaceId: 'qa' });
  assert.deepEqual(all.map((g) => [g.workspaceId, g.rows.map((h) => h.id)]), [[null, [H1, H2]]]);
  // An unknown workspace id shows its id, with no hue, after the registry's.
  const odd = M.handoffGroups([handoff(H1, 'zz-lab', 'qa'), handoff(H2, 'sde', 'zz-lab')], { box: 'inbox', workspaceId: '' });
  assert.deepEqual(odd.map((g) => [g.title, g.hueSlot]), [['To Testing', odd[0].hueSlot], ['To zz-lab', null]]);
});

test('the list request sends only valid keys; the limit is clamped', () => {
  assert.deepEqual(M.handoffListRequest(M.DEFAULT_HANDOFF_VIEW, 100), { box: 'inbox', limit: 100 });
  assert.deepEqual(M.handoffListRequest({ box: 'sent', workspaceId: 'qa', status: 'accepted' }, 9999), { box: 'sent', workspaceId: 'qa', status: 'accepted', limit: 500 });
  assert.deepEqual(M.handoffListRequest({ box: 'evil', workspaceId: '../x', status: 'gone' }, 0), { box: 'inbox', limit: 100 });
  assert.equal(M.nextHandoffLimit(100), 200);
  assert.equal(M.nextHandoffLimit(450), 500);
  assert.notEqual(M.handoffViewKey({ box: 'inbox', workspaceId: '', status: '' }), M.handoffViewKey({ box: 'sent', workspaceId: '', status: '' }));
});

test('rows carry labels and words only, never participation or principal ids', () => {
  const r = M.handoffRow(handoff(H1, 'sde', 'qa', { subjectCount: 3 }), new Map([['p1', 'Invoice OCR']]));
  assert.deepEqual(Object.keys(r).sort(), ['changedAt', 'fromHue', 'fromLabel', 'id', 'open', 'project', 'status', 'subjects', 'title', 'toHue', 'toLabel']);
  assert.equal(r.fromLabel, 'Software'); assert.equal(r.toLabel, 'Testing'); assert.equal(r.subjects, '3 versions'); assert.equal(r.project, 'Invoice OCR');
  assert.equal(r.status, 'Sent, waiting for an answer'); assert.equal(r.open, true);
  assert.ok(!JSON.stringify(r).includes('PART-'));
  assert.equal(M.handoffRow(handoff(H1, 'sde', 'qa', { subjectCount: 1 }), new Map()).subjects, '1 version');
  assert.equal(M.handoffRow(handoff(H1, 'sde', 'qa'), new Map()).project, 'Removed project');
  assert.equal(M.handoffRow(handoff(H1, 'sde', 'qa'), new Map(), false).project, '');
});

// ---------- list and detail reads ----------

test('the list read: rows and truncated, stale keys, unavailable, handoffs off with the sub-reason, passing failures, refusals', () => {
  const key = M.handoffViewKey(M.DEFAULT_HANDOFF_VIEW);
  const start = M.startHandoffListRead(M.NO_HANDOFF_LIST, key);
  assert.equal(start.loading, true);
  const rows = [handoff(H1, 'sde', 'qa')];
  const ok = M.nextHandoffList(start, key, { ok: true, data: rows, truncated: true });
  assert.deepEqual([ok.rows.length, ok.loaded, ok.truncated, ok.error], [1, true, true, null]);
  assert.equal(M.nextHandoffList(start, 'other', { ok: true, data: rows }), start, 'an answer for another view changes nothing');
  assert.deepEqual(M.nextHandoffList(start, key, { ok: true, data: 'x' }).rows, []);

  for (const sub of ['held', 'auto_held', 'backup_failed', 'failed', 'shape', undefined]) {
    const off = M.nextHandoffList(start, key, fail('platform_unavailable', { reason: 'handoffs_unavailable', subReason: sub }));
    assert.equal(off.handoffsOff, handoffsNotice(sub));
    assert.equal(off.handoffsOff, errorCopy('platform_unavailable', 'handoffs_unavailable', sub).text);
    assert.deepEqual(M.handoffListNotice(off, M.DEFAULT_HANDOFF_VIEW), { kind: 'handoffs-off', text: off.handoffsOff });
  }
  const down = M.nextHandoffList(start, key, fail('platform_unavailable', { reason: 'held' }));
  assert.deepEqual([down.unavailable, down.handoffsOff, down.rows.length], [true, null, 0]);
  assert.deepEqual(M.handoffListNotice(down, M.DEFAULT_HANDOFF_VIEW), { kind: 'unavailable' });

  const busy = M.nextHandoffList(ok, key, fail('platform_unavailable', { reason: 'busy' }));
  assert.equal(busy.rows.length, 1, 'busy keeps the rows');
  assert.deepEqual(M.staleHandoffError(busy), { text: errorCopy('platform_unavailable', 'busy').text, retry: true });
  const denied = M.nextHandoffList(ok, key, fail('denied'));
  assert.deepEqual([denied.rows.length, denied.error], [0, errorCopy('denied').text]);
  assert.deepEqual(M.handoffListNotice(denied, M.DEFAULT_HANDOFF_VIEW), { kind: 'error', text: errorCopy('denied').text, retry: false });
});

test('the empty-state choice: loading, empty, no-match, rows; paging', () => {
  const key = M.handoffViewKey(M.DEFAULT_HANDOFF_VIEW);
  assert.deepEqual(M.handoffListNotice(M.NO_HANDOFF_LIST, M.DEFAULT_HANDOFF_VIEW), { kind: 'loading' });
  const empty = M.nextHandoffList(M.startHandoffListRead(M.NO_HANDOFF_LIST, key), key, { ok: true, data: [] });
  assert.deepEqual(M.handoffListNotice(empty, M.DEFAULT_HANDOFF_VIEW), { kind: 'empty' });
  assert.deepEqual(M.handoffListNotice(empty, { box: 'inbox', workspaceId: 'qa', status: '' }), { kind: 'no-match' });
  assert.deepEqual(M.handoffListNotice(empty, { box: 'inbox', workspaceId: '', status: 'declined' }), { kind: 'no-match' });
  const some = { ...empty, rows: [handoff(H1, 'sde', 'qa')] };
  assert.equal(M.handoffListNotice(some, M.DEFAULT_HANDOFF_VIEW), null);
  assert.equal(M.EMPTY_TITLE, 'No handoffs yet');
  for (const b of M.HANDOFF_BOXES) assert.ok(M.EMPTY_BODY[b].length > 0);
  assert.equal(M.handoffPaging({ loaded: true, truncated: true }, 100), 'more');
  assert.equal(M.handoffPaging({ loaded: true, truncated: true }, 500), 'capped');
  assert.equal(M.handoffPaging({ loaded: true, truncated: false }, 100), null);
});

test('the detail read: ready, missing, handoffs off, platform off, refusal, passing failure after ready, stale id, malformed', () => {
  const s0 = M.handoffDetailLoading(H1);
  const d = detail(handoff(H1, 'sde', 'qa'), [subject(V1)]);
  const ready = M.nextHandoffDetail(s0, H1, { ok: true, data: d });
  assert.equal(ready.status, 'ready');
  assert.equal(M.nextHandoffDetail(s0, H2, { ok: true, data: d }), s0, 'another id changes nothing');
  assert.equal(M.nextHandoffDetail(s0, H1, fail('not_found')).status, 'missing');
  const off = M.nextHandoffDetail(s0, H1, fail('platform_unavailable', { reason: 'handoffs_unavailable', subReason: 'held' }));
  assert.deepEqual([off.status, off.notice], ['unavailable', handoffsNotice('held')]);
  const down = M.nextHandoffDetail(s0, H1, fail('platform_unavailable', { reason: 'migration_failed' }));
  assert.deepEqual([down.status, down.notice], ['unavailable', M.UNAVAILABLE_DETAIL_TEXT]);
  assert.deepEqual([M.nextHandoffDetail(s0, H1, fail('denied')).status, M.nextHandoffDetail(s0, H1, fail('denied')).error], ['error', errorCopy('denied').text]);
  const stale = M.nextHandoffDetail(ready, H1, fail('internal'));
  assert.deepEqual([stale.status, stale.detail, stale.retry], ['ready', d, true]);
  assert.equal(M.nextHandoffDetail(s0, H1, { ok: true, data: { ...d, id: H2 } }).status, 'error');
});

// ---------- HM3 and subjects by reference ----------

test('HM3 "a newer version exists" appears only when newerVersionNo > versionNo', () => {
  assert.equal(M.newerVersionText({ versionNo: 2, newerVersionNo: null }), null);
  assert.equal(M.newerVersionText({ versionNo: 2, newerVersionNo: 2 }), null);
  assert.equal(M.newerVersionText({ versionNo: 2, newerVersionNo: 1 }), null);
  assert.equal(M.newerVersionText({ versionNo: 2, newerVersionNo: 3 }), 'There is a newer version (version 3).');
  const rows = M.subjectRows([subject(V2, { position: 1, versionNo: 1, newerVersionNo: 4, kind: 'text_file', artifactName: 'Spec', contentHash: 'f'.repeat(64), status: 'deprecated' }), subject(V1, { position: 0 })]);
  assert.deepEqual(rows.map((r) => r.versionId), [V1, V2], 'in position order');
  assert.deepEqual(rows[1], { versionId: V2, artifactId: A1, label: 'File Spec', version: 'Version 1', hash: 'ffffffffffff', status: 'replaced', newer: 'There is a newer version (version 4).' });
  assert.equal(rows[0].hash, 'git:0123456789ab');
  assert.equal(rows[0].newer, null);
});

test('the detail rows: registry labels, words for status, notes, no ids beyond versions and artifacts', () => {
  const h = detail(handoff(H1, 'sde', 'qa', { status: 'declined', note: 'Please check', responseNote: 'Not now', respondedAt: 30 }), [subject(V1)]);
  const r = M.handoffDetailRows(h);
  assert.deepEqual([r.fromLabel, r.toLabel, r.status, r.note, r.responseNote, r.open], ['Software', 'Testing', 'Declined', 'Please check', 'Not now', false]);
  assert.ok(!JSON.stringify(r).includes('PART-'));
  assert.equal(M.receiptText('QA'), 'Accepting added a received item to QA. It points to these versions and does not copy them.');
  assert.equal(M.receiptArtifactId(V5, { ok: true, data: { id: V5, artifactId: A3 } }), A3);
  assert.equal(M.receiptArtifactId(V5, { ok: true, data: { id: V4, artifactId: A3 } }), null);
  assert.equal(M.receiptArtifactId(V5, { ok: true, data: { id: V5, artifactId: '../x' } }), null);
  assert.equal(M.receiptArtifactId(V5, fail('not_found')), null);
  assert.equal(M.receiptArtifactId(null, null), null);
});

// ---------- HM4: status is always text ----------

test('HM4 status is always text', () => {
  for (const s of M.HANDOFF_STATUSES) {
    const t = M.handoffStatusLabel(s);
    assert.ok(typeof t === 'string' && t.length > 0 && t !== s, s);
    assert.ok(M.handoffStatusOption(s).length > 0);
  }
  assert.equal(M.handoffStatusLabel('sent'), 'Sent, waiting for an answer');
  assert.equal(M.handoffStatusLabel('converted'), 'Converted');
  assert.equal(M.handoffStatusLabel(''), 'Unknown status');
  assert.equal(M.handoffStatusLabel('<b>'), 'B');
  for (const h of M.HANDOFF_STATUSES.map((s) => handoff(H1, 'sde', 'qa', { status: s }))) {
    assert.ok(M.handoffRow(h, new Map()).status.length > 0);
    assert.ok(M.handoffDetailRows(detail(h, [])).status.length > 0);
  }
});

// ---------- HM2: answers by side and status ----------

test('HM2 actions by side and status: receiving + sent = Accept, Decline; sending + sent = Withdraw; otherwise none', () => {
  assert.deepEqual(M.handoffActionsFor('receiving', 'sent'), ['accept', 'decline']);
  assert.deepEqual(M.handoffActionsFor('sending', 'sent'), ['withdraw']);
  for (const s of ['accepted', 'declined', 'withdrawn', 'other']) {
    assert.deepEqual(M.handoffActionsFor('receiving', s), [], s);
    assert.deepEqual(M.handoffActionsFor('sending', s), [], s);
  }
  assert.deepEqual(M.handoffActionsFor('nobody', 'sent'), []);
});

test('the viewed side: inbox receives, sent sends, a chosen workspace decides, All stands on both; writes off shows none', () => {
  const h = handoff(H1, 'sde', 'qa');
  assert.deepEqual(M.sidesFor(h, { box: 'inbox', workspaceId: '' }), ['receiving']);
  assert.deepEqual(M.sidesFor(h, { box: 'inbox', workspaceId: 'qa' }), ['receiving']);
  assert.deepEqual(M.sidesFor(h, { box: 'inbox', workspaceId: 'sde' }), []);
  assert.deepEqual(M.sidesFor(h, { box: 'sent', workspaceId: 'sde' }), ['sending']);
  assert.deepEqual(M.sidesFor(h, { box: 'sent', workspaceId: 'qa' }), []);
  assert.deepEqual(M.sidesFor(h, { box: 'all', workspaceId: 'qa' }), ['receiving']);
  assert.deepEqual(M.sidesFor(h, { box: 'all', workspaceId: 'sde' }), ['sending']);
  assert.deepEqual(M.sidesFor(h, { box: 'all', workspaceId: '' }), ['receiving', 'sending']);
  assert.deepEqual(M.detailActions(h, { box: 'inbox', workspaceId: '' }, true), ['accept', 'decline']);
  assert.deepEqual(M.detailActions(h, { box: 'sent', workspaceId: '' }, true), ['withdraw']);
  assert.deepEqual(M.detailActions(h, { box: 'all', workspaceId: '' }, true), ['accept', 'decline', 'withdraw']);
  assert.deepEqual(M.detailActions(h, { box: 'inbox', workspaceId: '' }, false), []);
  assert.deepEqual(M.detailActions({ ...h, status: 'accepted' }, { box: 'all', workspaceId: '' }, true), []);
  assert.equal(M.sideText(['receiving'], 'SDE', 'QA'), 'Answering for QA, the workspace that gets it.');
  assert.equal(M.sideText(['sending'], 'SDE', 'QA'), 'Acting for SDE, the workspace that sent it.');
  assert.equal(M.sideText([], 'SDE', 'QA'), null);
});

test('answers: decline and withdraw confirm first, one at a time, the note is checked, any answer ends it', () => {
  const S = M.IDLE_HANDOFF_ACTIONS;
  assert.ok(M.beginHandoffAction(S, 'accept'));
  assert.equal(M.beginHandoffAction(S, 'decline'), null, 'decline only from its confirmation');
  assert.equal(M.beginHandoffAction(S, 'withdraw'), null);
  const c = M.askHandoffConfirm(S, 'decline');
  assert.equal(M.beginHandoffAction(c, 'withdraw'), null);
  const noted = M.setDeclineNote(c, 'Not this sprint');
  const running = M.beginHandoffAction(noted, 'decline');
  assert.deepEqual([running.pending, running.confirming, running.note], ['decline', 'decline', 'Not this sprint']);
  assert.equal(M.beginHandoffAction(running, 'accept'), null, 'no double submit');
  assert.equal(M.cancelHandoffConfirm(running), running, 'cannot cancel while pending');
  assert.equal(M.askHandoffConfirm(running, 'withdraw'), running);
  assert.equal(M.setDeclineNote(running, 'x'), running);
  assert.equal(M.beginHandoffAction(M.setDeclineNote(c, 'x'.repeat(2001)), 'decline'), null);
  assert.equal(M.beginHandoffAction(M.setDeclineNote(c, 'a\u0000b'), 'decline'), null);
  assert.deepEqual(M.cancelHandoffConfirm(noted), { ...noted, confirming: null, note: '' });
  assert.deepEqual(M.handoffActionSucceeded(running, 'done'), { ...S, announce: 'done' });
  assert.deepEqual(M.handoffActionFailed(running, 'no'), { ...S, error: 'no' });
  assert.equal(M.declineNoteArg('  '), undefined);
  assert.equal(M.declineNoteArg(' ok '), 'ok');
});

test('answer copy: labels, pending lines, confirmations, results, failures and reloads', () => {
  assert.deepEqual(['accept', 'decline', 'withdraw'].map((k) => [M.handoffActionLabel(k, false), M.handoffActionLabel(k, true)]),
    [['Accept', 'Accepting…'], ['Decline', 'Declining…'], ['Take back', 'Taking back…']]);
  assert.equal(M.handoffPendingText('accept'), 'Accepting the handoff…');
  assert.match(M.handoffConfirmText('decline', 'SDE', 'QA'), /^Decline this handoff from SDE\?/);
  assert.match(M.handoffConfirmText('withdraw', 'SDE', 'QA'), /^Take this handoff back from QA\?/);
  assert.equal(M.handoffDoneText('accept', 'QA'), 'Accepted. A received item was added to QA.');
  assert.equal(M.handoffFailureText(fail('illegal_transition')), M.ALREADY_ANSWERED_TEXT);
  for (const code of ['denied', 'participation_inactive', 'conflict', 'not_found', 'internal']) assert.equal(M.handoffFailureText(fail(code)), errorCopy(code).text, code);
  assert.equal(M.handoffFailureText(fail('platform_unavailable', { reason: 'handoffs_unavailable', subReason: 'failed' })), handoffsNotice('failed'));
  for (const code of ['conflict', 'not_found', 'illegal_transition', 'participation_inactive']) assert.equal(M.shouldReloadAfterHandoffAction(fail(code)), true, code);
  assert.equal(M.shouldReloadAfterHandoffAction(fail('platform_unavailable', { reason: 'handoffs_unavailable' })), true);
  assert.equal(M.shouldReloadAfterHandoffAction(fail('platform_unavailable', { reason: 'busy' })), false);
  for (const code of ['invalid', 'denied', 'internal']) assert.equal(M.shouldReloadAfterHandoffAction(fail(code)), false, code);
});

// ---------- HM5: the send sheet's choices ----------

test('HM5 send-sheet choices: to = the other active participations; subjects = the sender\'s candidate and active versions', () => {
  const from = M.fromChoice(IDX, 'p1', P_SDE);
  assert.deepEqual(from, { participationId: P_SDE, workspaceId: 'sde', label: 'Software', hueSlot: from.hueSlot });
  assert.equal(M.fromChoice(IDX, 'p1', P_OLD), null, 'a withdrawn owner cannot send');
  assert.equal(M.fromChoice(IDX, 'p1', P_OTHER), null, 'another project\'s participation is not the owner here');
  assert.equal(M.fromChoice(IDX, 'p1', null), null);
  assert.equal(M.fromChoice({ ...IDX, mode: 'legacy' }, 'p1', P_SDE), null);
  const to = M.toChoices(IDX, 'p1', P_SDE);
  assert.deepEqual(to.map((c) => [c.participationId, c.label]), [[P_ML, 'Machine learning'], [P_QA, 'Testing']]);
  assert.ok(!to.some((c) => c.participationId === P_SDE || c.participationId === P_OLD || c.participationId === P_OTHER));
  assert.deepEqual(M.toChoices({ ...IDX, mode: 'legacy' }, 'p1', P_SDE), []);

  const details = [
    art(A1, P_SDE, [[V1, 1, 'deprecated'], [V2, 2, 'active'], [V3, 3, 'candidate'], [V4, 4, 'draft']], { name: 'API notes' }),
    art(A2, P_QA, [[V5, 1, 'active']], { name: 'QA plan' }),
    art(A3, P_SDE, [['01J9ZQ3V4K5M6N7P8Q9R0STVV6', 1, 'active']], { name: 'Archived', status: 'archived' })
  ];
  const subjects = M.subjectChoices(details, 'p1', P_SDE);
  assert.deepEqual(subjects.map((c) => [c.versionId, c.label, c.status]), [[V3, 'Saved version API notes, version 3', 'ready'], [V2, 'Saved version API notes, version 2', 'in use']]);
  assert.equal(subjects[0].hash, 'git:abababababab');
  assert.deepEqual(M.subjectChoices(details, 'p2', P_SDE), []);
});

test('the sheet reads only the sender\'s own artifacts, capped, most recently changed first', () => {
  const sum = (id, owner, o = {}) => ({ artifact: { ...art(id, owner, [], o).artifact, ownerParticipationId: owner }, versionCount: o.versionCount ?? 1, latest: null, current: null });
  const r = M.subjectArtifactIds([sum(A1, P_SDE, { updatedAt: 5 }), sum(A2, P_QA), sum(A3, P_SDE, { updatedAt: 9 }), sum('01J9ZQ3V4K5M6N7P8Q9R0STVW4', P_SDE, { versionCount: 0 })], 'p1', P_SDE);
  assert.deepEqual(r, { ids: [A3, A1], capped: false });
  const many = Array.from({ length: 31 }, (_, i) => sum(`01J9ZQ3V4K5M6N7P8Q9R0ST${String(i).padStart(3, '0')}`, P_SDE, { updatedAt: i }));
  const c = M.subjectArtifactIds(many, 'p1', P_SDE);
  assert.equal(c.ids.length, M.SUBJECT_CANDIDATE_ARTIFACTS);
  assert.equal(c.capped, true);
});

test('send-sheet validation: a target, 1 to 20 offered versions, a title, an optional note; only offered ids are sent', () => {
  const to = M.toChoices(IDX, 'p1', P_SDE);
  const subjects = [V2, V3].map((v) => ({ versionId: v, artifactId: A1, label: v, status: 'active', hash: 'h' }));
  let s = M.initialSendState(to, V2, M.defaultHandoffTitle('API\nnotes', 2));
  assert.deepEqual([s.toParticipationId, s.versionIds, s.title], [P_ML, [V2], 'API notes, version 2']);
  assert.equal(M.sendBlocker(s, subjects, to), null);
  assert.deepEqual(M.buildSendRequest('p1', P_SDE, s, subjects, to), { projectId: 'p1', fromParticipationId: P_SDE, toParticipationId: P_ML, versionIds: [V2], title: 'API notes, version 2' });
  s = M.toggleSubject(s, V3);
  s = M.toggleSubject({ ...s, versionIds: [...s.versionIds, 'TYPED-BY-HAND'], note: '  please review  ' }, V5);
  const req = M.buildSendRequest('p1', P_SDE, s, subjects, to);
  assert.deepEqual(req.versionIds, [V2, V3], 'only versions the sheet offered');
  assert.equal(req.note, 'please review');
  assert.deepEqual(M.toggleSubject(M.toggleSubject(s, V2), V2).versionIds.slice(-1), [V2]);
  assert.match(M.sendBlocker({ ...s, versionIds: [] }, subjects, to), /at least one version/);
  assert.match(M.sendBlocker({ ...s, title: '   ' }, subjects, to), /title/);
  assert.match(M.sendBlocker({ ...s, title: 'x'.repeat(201) }, subjects, to), /title/);
  assert.match(M.sendBlocker({ ...s, note: 'x'.repeat(2001) }, subjects, to), /note/);
  assert.match(M.sendBlocker({ ...s, toParticipationId: P_SDE }, subjects, to), /Choose the workspace/);
  assert.match(M.sendBlocker(s, subjects, []), /not in any other workspace/);
  assert.equal(M.buildSendRequest('p1', P_SDE, { ...s, title: '' }, subjects, to), null);
  // Never more than the service's maximum.
  let full = { ...s, versionIds: Array.from({ length: 20 }, (_, i) => `V${i}`) };
  assert.equal(M.toggleSubject(full, V3 + 'x'), full);
  assert.equal(M.SEND_MAX_SUBJECTS, 20);
  // Pending and sent freeze the choices; one send at a time.
  const p = M.beginSend(s, true);
  assert.equal(p.pending, true);
  assert.equal(M.beginSend(p, true), null);
  assert.equal(M.beginSend(s, false), null);
  assert.equal(M.toggleSubject(p, V3), p);
  const done = M.sendSucceeded(p, { handoffId: H1, toLabel: 'ML', created: true });
  assert.equal(M.beginSend(done, true), null);
  assert.equal(M.sentText('ML', true), 'Handoff sent to ML.');
  assert.match(M.sentText('ML', false), /already sent/);
  assert.deepEqual(M.sendFailed(p, 'no'), { ...p, pending: false, error: 'no' });
  for (const r of [fail('participation_inactive'), fail('invalid', { reason: 'bad_request' }), fail('platform_unavailable', { reason: 'handoffs_unavailable', subReason: 'held' }), fail('denied')]) {
    assert.equal(M.sendFailureText(r), errorCopy(r.code, r.reason, r.subReason).text);
  }
});

test('Hand off renders only with writes on, handoffs known to be on, and actionsFor allowing it', () => {
  const allowed = [{ kind: 'handoff' }];
  assert.equal(M.canHandOff(allowed, true, true, true), true);
  assert.equal(M.canHandOff(allowed, false, true, true), false);
  assert.equal(M.canHandOff(allowed, true, false, true), false, 'handoffs off (v8 held): no Hand off anywhere');
  assert.equal(M.canHandOff(allowed, true, null, true), false, 'not yet known');
  assert.equal(M.canHandOff([{ kind: 'promote' }], true, true, true), false);
  assert.equal(M.canHandOff(allowed, true, true, false), false, 'no receiving participation: no Hand off');
});

test('Hand off needs a receiver: one active participation offers no button, two do', () => {
  const allowed = [{ kind: 'handoff' }];
  const one = fromRows([
    { id: P_SDE, projectId: 'p1', workspaceId: 'sde', status: 'active', isPrimary: true, source: 'backfill' },
    { id: P_OLD, projectId: 'p1', workspaceId: 'devops', status: 'withdrawn', isPrimary: false, source: 'user' }
  ]);
  assert.equal(M.hasReceiver(one, 'p1', P_SDE), false, 'a withdrawn participation never receives');
  assert.equal(M.canHandOff(allowed, true, true, M.hasReceiver(one, 'p1', P_SDE)), false);
  const two = fromRows([
    { id: P_SDE, projectId: 'p1', workspaceId: 'sde', status: 'active', isPrimary: true, source: 'backfill' },
    { id: P_QA, projectId: 'p1', workspaceId: 'qa', status: 'active', isPrimary: false, source: 'user' }
  ]);
  assert.equal(M.hasReceiver(two, 'p1', P_SDE), true);
  assert.equal(M.canHandOff(allowed, true, true, M.hasReceiver(two, 'p1', P_SDE)), true);
  // The same choices the send sheet offers: none in legacy mode, so no button either.
  assert.equal(M.hasReceiver({ ...two, mode: 'legacy' }, 'p1', P_SDE), false);
  assert.equal(M.hasReceiver(two, 'p1', P_SDE), M.toChoices(two, 'p1', P_SDE).length > 0);
});

test('the Passport lists only handoffs that carry a version of this artifact', () => {
  const rows = M.handoffsCarrying([
    detail(handoff(H1, 'sde', 'qa', { title: 'For review' }), [subject(V1, { versionNo: 3 }), subject(V2, { versionNo: 1 }), subject(V3, { artifactId: A2 })]),
    detail(handoff(H2, 'sde', 'ml'), [subject(V4, { artifactId: A2 })]),
    detail(handoff(H3, 'qa', 'sde', { status: 'accepted' }), [subject(V5, { versionNo: 2 })])
  ], A1);
  assert.deepEqual(rows, [
    { id: H1, title: 'For review', route: 'Software to Testing', status: 'Sent, waiting for an answer', versions: 'versions 1 and 3' },
    { id: H3, title: 'Handoff 3', route: 'Testing to Software', status: 'Accepted', versions: 'version 2' }
  ]);
});

test('the lead says it once', () => {
  assert.equal(M.HANDOFFS_LEAD, 'A handoff passes a saved item to another workspace in the same project.');
  const page = src('pages/HandoffsPage.tsx');
  assert.equal((page.match(/HANDOFFS_LEAD/g) || []).length, 2, 'imported once, rendered once');
  assert.doesNotMatch(page, /A handoff passes a saved item to another/);
});

// ---------- source pins (no jsdom) ----------

const page = src('pages/HandoffsPage.tsx');
const sheet = src('handoffs/SendHandoffSheet.tsx');
const hooks = src('data/useHandoffs.ts');
const passport = src('project/ArtifactPassport.tsx');

test('pin: the page lists through its hook, shows handoffs-off, unavailable, error, empty and no-match states', () => {
  assert.match(page, /const list = useHandoffList\(view\);/);
  assert.match(page, /\{notice\?\.kind === 'handoffs-off' && <p className="nx-hfx__off" role="status">\{notice\.text\}<\/p>\}/);
  assert.match(page, /\{notice\?\.kind === 'unavailable' && <p className="nx-muted" role="status">\{UNAVAILABLE_LIST_TEXT\}<\/p>\}/);
  assert.match(page, /\{notice\.retry && <Button variant="quiet" icon="refresh" onClick=\{list\.reload\}>Try again<\/Button>\}/);
  assert.match(page, /<EmptyState level=\{2\} icon="handoffs" title=\{EMPTY_TITLE\} body=\{EMPTY_BODY\[view\.box\]\}/);
  assert.match(page, /\{d\.status === 'unavailable' && <p className="nx-hfx__off" role="status">\{d\.notice\}<\/p>\}/);
  assert.match(page, /<PlatformNotice \/>/);
  assert.match(page, /aria-pressed=\{view\.box === b\}/);
  assert.match(page, /navigate\(\{ name: 'handoffs', id: h\.id \}\)/);
  assert.match(page, /<HandoffDetailPane key=\{id\} id=\{id\}/);
  assert.match(page, /\{paging === 'more' && <Button onClick=\{showMore\}>/);
});

test('pin: the detail shows subjects by reference, the answer note, and the receipt link once accepted', () => {
  assert.match(page, /\{rows\.subjects\.map\(\(s\) => \(/);
  assert.match(page, /<span title=\{`Reference \$\{s\.hash\}`\}>\{s\.version\}, \{s\.status\}<\/span>/);
  assert.doesNotMatch(page, /<span className="nx-id">\{s\.hash\}/, 'the raw reference is not shown as text');
  assert.match(page, /\{s\.newer && <span className="nx-muted">\{s\.newer\}<\/span>\}/);
  assert.match(page, /<dt>Answer note<\/dt>/);
  assert.match(page, /const receiptId = useReceiptArtifact\(h\.status === 'accepted' \? h\.receiptVersionId : null\);/);
  assert.match(page, /\{receiptId && <Button icon="artifacts" onClick=\{\(\) => navigate\(\{ name: 'artifacts', id: receiptId \}\)\}>Open the received item<\/Button>\}/);
  assert.doesNotMatch(page, /ParticipationId|createdBy|respondedBy|principal|actorId|JSON\.stringify/);
});

test('pin: answers are gated by writes and side; one IPC call each; bumpRev before the unmount check; focus on the status line', () => {
  assert.match(page, /const actions = detailActions\(h, view, canWrite\);/);
  assert.match(page, /case 'accept': return nexusClient\.handoffAccept\(h\.id\);/);
  assert.match(page, /case 'decline': return nexusClient\.handoffDecline\(h\.id, declineNoteArg\(note\)\);/);
  assert.match(page, /case 'withdraw': return nexusClient\.handoffWithdraw\(h\.id\);/);
  assert.match(page, /if \(running\.current\) return;\s*const next = beginHandoffAction\(acts, kind\);\s*if \(!next\) return;\s*running\.current = true;\s*setActs\(next\);\s*requestFocus\('result'\);/);
  assert.match(page, /try \{\s*r = await send\(kind, acts\.note\);\s*\} catch \{\s*r = INTERNAL_FAIL;\s*\}/);
  assert.match(page, /if \(r\.ok \|\| shouldReloadAfterHandoffAction\(r\)\) bumpRev\(\);\s*if \(!alive\.current\) return;/);
  assert.equal((page.match(/bumpRev\(\);/g) || []).length, 1);
  assert.match(page, /setActs\(\(s\) => handoffActionFailed\(s, text\)\);\s*\}\s*requestFocus\('result'\);/);
  assert.match(page, /\{pending && <p ref=\{resultRef\} tabIndex=\{-1\} className="nx-hfx__status" role="status">\{handoffPendingText\(pending\)\}<\/p>\}/);
  assert.match(page, /\{!pending && acts\.announce && <p ref=\{resultRef\} tabIndex=\{-1\} className="nx-hfx__status" role="status">/);
  assert.match(page, /\{!pending && acts\.error && <p ref=\{resultRef\} tabIndex=\{-1\} className="nx-passport__note" role="alert">/);
});

test('pin: decline and withdraw confirm inline, Cancel takes focus, Escape closes; decline takes an optional note', () => {
  assert.match(page, /onClick=\{k === 'accept' \? \(\) => \{ void act\('accept'\); \} : \(\) => setActs\(\(s\) => askHandoffConfirm\(s, k as 'decline' \| 'withdraw'\)\)\}/);
  assert.match(page, /useEffect\(\(\) => \{ if \(acts\.confirming && !acts\.pending\) cancelRef\.current\?\.focus\(\); \}, \[acts\.confirming, acts\.pending\]\);/);
  assert.match(page, /role="group" aria-label=\{`\$\{handoffActionLabel\(confirming, false\)\} this handoff`\} onKeyDown=\{onConfirmKey\}/);
  assert.match(page, /if \(e\.key !== 'Escape' \|\| acts\.pending\) return;\s*e\.preventDefault\(\);\s*e\.stopPropagation\(\);\s*cancelConfirm\(\);/);
  assert.match(page, /<button ref=\{cancelRef\} type="button" className="nx-btn" disabled=\{pending !== null\} onClick=\{cancelConfirm\}><span>Cancel<\/span><\/button>/);
  assert.match(page, /<span>Note to the sender \(optional\)<\/span>/);
  assert.match(page, /maxLength=\{NOTE_MAX\}/);
});

test('pin: the hooks guard stale answers, note handoff availability, reload on rev, and never reject', () => {
  assert.match(hooks, /const r = await nexusClient\.handoffsList\(request\);\s*noteHandoffs\(r\);\s*if \(mine !== seq\.current\) return;/);
  assert.match(hooks, /const r = await nexusClient\.handoffGet\(id\);\s*noteHandoffs\(r\);\s*if \(mine !== seq\.current\) return;/);
  assert.match(hooks, /\}, \[key, limit, rev, mode, attempt\]\);/);
  assert.equal((hooks.match(/\} catch \{/g) || []).length, 4, 'every loader catches');
  assert.doesNotMatch(hooks, /\.then\(/);
  assert.doesNotMatch(hooks, /handoffSend|handoffAccept|handoffDecline|handoffWithdraw/);
  const store = src('data/platformStore.ts');
  assert.match(store, /if \(r\.ok\) \{\s*if \(get\(\)\.handoffsAvailable !== true\) set\(\{ handoffsAvailable: true, handoffsSubReason: null \}\);/);
  assert.match(store, /r\.code === 'platform_unavailable' && r\.reason === 'handoffs_unavailable'/);
});

test('pin: the send sheet: writes and handoffs on, From is the owner, To the other active ones, lazy subjects, one call, errorCopy', () => {
  assert.match(sheet, /if \(!canWrite \|\| !openable\) return null;/);
  assert.match(sheet, /fromChoice\(idx, start\.projectId, start\.ownerParticipationId\)/);
  assert.match(sheet, /toChoices\(idx, start\.projectId, from\.participationId\)/);
  assert.match(sheet, /const subjects = useSubjectDetails\(ids\);/);
  assert.match(sheet, /subjectChoices\(subjects\.details, start\.projectId, start\.ownerParticipationId\)/);
  assert.match(sheet, /r = await nexusClient\.handoffSend\(req\);/);
  assert.equal((sheet.match(/nexusClient\.handoff/g) || []).length, 1);
  assert.match(sheet, /if \(r\.ok \|\| shouldReloadAfterHandoffAction\(r\)\) bumpRev\(\);\s*if \(!alive\.current\) return;/);
  assert.match(sheet, /const text = sendFailureText\(r\);/);
  assert.match(sheet, /\{!pending && state\.error && <p ref=\{resultRef\} tabIndex=\{-1\} className="nx-passport__note" role="alert">\{state\.error\}<\/p>\}/);
  assert.match(sheet, /\{pending && <p ref=\{resultRef\} tabIndex=\{-1\} className="nx-shx__status" role="status">/);
  assert.match(sheet, /setHandoffView\(\{ box: 'sent', workspaceId: from\.workspaceId, status: '' \}\);/);
  assert.match(sheet, /<input type="checkbox"/);
  assert.doesNotMatch(sheet, /ParticipationId\}<|principal|JSON\.stringify/);
  assert.equal((sheet.match(/\} catch \{/g) || []).length, 2, 'the subject read and the send both catch');
});

test('pin: the Passport renders Hand off only through canHandOff and onHandOff, and lists the handoffs carrying its versions', () => {
  assert.match(passport, /const handOff = v !== null && onHandOff !== undefined && ownerRow !== null && canHandOff\(actionsFor\(v, artifact, ownerActive\), canWrite, handoffsAvailable, receiver\);/);
  assert.match(passport, /const receiver = ownerRow !== null && hasReceiver\(idx, project\.id, ownerRow\.id\);/);
  assert.match(passport, /\{handOff && ownerRow && \(/);
  assert.match(passport, /ariaLabel=\{`Send version \$\{v\.versionNo\} to another workspace`\}/);
  assert.match(passport, />\s*Send to another workspace…\s*<\/Button>/);
  assert.match(passport, /const carrying = useArtifactHandoffs\(canWrite, project\.id, node\.artifactId\);/);
  assert.match(passport, /navigate\(\{ name: 'handoffs', id: c\.id \}\)/);
  assert.doesNotMatch(passport, /handoffSend/);
  const bench = src('project/ProjectBench.tsx');
  assert.match(bench, /\{handoffStart && canWrite && <SendHandoffSheet start=\{handoffStart\} artifacts=\{artifacts\} onClose=\{closeHandoff\} \/>\}/);
  assert.match(bench, /const onHandOff = canWrite \? openHandoff : undefined;/);
});

test('pin: routing, nav and the styles', () => {
  assert.match(src('routes/RouteView.tsx'), /case 'handoffs': page = <HandoffsPage id=\{route\.id \?\? null\} \/>; break;/);
  assert.deepEqual(Object.keys(loadTs('src/renderer/src/nexus/pages/plannedContent.ts').PLANNED), ['deployments']);
  const css = src('styles/platform.css');
  for (const cls of ['nx-hfx', 'nx-hfx__list', 'nx-hfx__row', 'nx-hfx__detail', 'nx-hfx__off', 'nx-hfx__confirm', 'nx-hfx__status', 'nx-shx', 'nx-shx__list', 'nx-shx__status', 'nx-apx__handoff']) {
    assert.match(css, new RegExp(`\\.${cls}[\\s\\[{:.>]`), cls);
  }
  const tokens = src('styles/tokens.css');
  for (const v of new Set(css.match(/var\(--nx-[a-z0-9-]+\)/g) || [])) assert.ok(tokens.includes(`${v.slice(4, -1)}:`), v);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b[^}]*\.nx-(hfx|shx)/, 'tokens only');
});

// ---------- Task 13 fix round 1 ----------

test('fix 1: every failed Passport handoffs read gives a sentence; "no handoff carries" shows only after an ok read', () => {
  for (const r of [fail('platform_unavailable', { reason: 'held' }), fail('platform_unavailable', { reason: 'startup_failed' })]) {
    assert.equal(M.carryingFailureText(r), M.CARRYING_UNAVAILABLE_TEXT);
  }
  assert.equal(M.carryingFailureText(fail('platform_unavailable', { reason: 'handoffs_unavailable', subReason: 'held' })), handoffsNotice('held'));
  for (const code of ['denied', 'not_found', 'internal', 'invalid']) {
    const t = M.carryingFailureText(fail(code));
    assert.ok(typeof t === 'string' && t.length > 0, code);
    assert.equal(t, errorCopy(code).text, code);
  }
  assert.equal(M.carryingFailureText(fail('platform_unavailable', { reason: 'busy' })), errorCopy('platform_unavailable', 'busy').text);
  assert.match(hooks, /setState\(\{ rows: \[\], loaded: true, ok: false, error: carryingFailureText\(list\), capped: false \}\);/);
  assert.match(hooks, /loaded: true, ok: true, capped: list\.truncated === true,/);
  assert.match(passport, /carrying\.rows\.length === 0 \? \(carrying\.ok && !carrying\.error && <p className="nx-muted">This saved item has not been sent to another workspace\.<\/p>\)/);
});

test('fix 2: the send sheet checks availability at open only, so a handoffs_unavailable refusal stays on screen', () => {
  assert.match(sheet, /const \[openable\] = useState\(\(\) => usePlatform\.getState\(\)\.handoffsAvailable === true\);/);
  assert.match(sheet, /if \(!canWrite \|\| !openable\) return null;/);
  assert.doesNotMatch(sheet, /handoffsAvailable !== true\) return null/);
  assert.doesNotMatch(sheet, /usePlatform\(\(s\) => s\.handoffsAvailable\)/, 'no live subscription that could unmount the result');
  assert.match(sheet, /\{!pending && state\.error && <p ref=\{resultRef\}/);
});

test('fix 3: handoff details are read again only when their list row changed', () => {
  const list = [handoff(H1, 'sde', 'qa', { statusChangedAt: 20 }), handoff(H2, 'sde', 'ml', { statusChangedAt: 20 }), handoff(H3, 'qa', 'sde')];
  assert.deepEqual(M.detailIdsToRead(list, new Map()), [H1, H2, H3], 'the first read reads every detail');
  const cache = new Map([[H1, detail(list[0], [])], [H2, detail(list[1], [])], [H3, detail(list[2], [])]]);
  assert.deepEqual(M.detailIdsToRead(list, cache), [], 'a rev with nothing changed reads no detail');
  const answered = [{ ...list[0], status: 'accepted', statusChangedAt: 40, updatedAt: 40 }, list[1], list[2]];
  assert.deepEqual(M.detailIdsToRead(answered, cache), [H1]);
  assert.deepEqual(M.detailIdsToRead([{ ...list[1], updatedAt: 99 }], cache), [H2]);
  assert.match(hooks, /const ids = detailIdsToRead\(rows, cache\.current\);\s*const reads = await Promise\.all\(ids\.map\(\(id\) => nexusClient\.handoffGet\(id\)\)\);/);
  assert.match(hooks, /useEffect\(\(\) => \{ cache\.current = new Map\(\); \}, \[projectId\]\);/);
});

test('fix 4: a passing failure clears a stale handoffs-off or unavailable flag', () => {
  const key = M.handoffViewKey(M.DEFAULT_HANDOFF_VIEW);
  const start = M.startHandoffListRead(M.NO_HANDOFF_LIST, key);
  const off = M.nextHandoffList(start, key, fail('platform_unavailable', { reason: 'handoffs_unavailable', subReason: 'held' }));
  for (const prev of [off, M.nextHandoffList(start, key, fail('platform_unavailable', { reason: 'held' }))]) {
    for (const r of [fail('internal'), fail('platform_unavailable', { reason: 'busy' })]) {
      const next = M.nextHandoffList(M.startHandoffListRead(prev, key), key, r);
      assert.deepEqual([next.handoffsOff, next.unavailable, next.loaded, next.loading, next.retry], [null, false, true, false, true]);
      assert.equal(next.error, errorCopy(r.code, r.reason).text);
      assert.deepEqual(M.handoffListNotice(next, M.DEFAULT_HANDOFF_VIEW), { kind: 'error', text: next.error, retry: true });
    }
  }
});

test('fix 5: only offered versions are counted and sent', () => {
  const to = M.toChoices(IDX, 'p1', P_SDE);
  const subjects = [V2, V3].map((v) => ({ versionId: v, artifactId: A1, label: v, status: 'active', hash: 'h' }));
  const s = { ...M.initialSendState(to, V4, 'T'), versionIds: [V4, V2, V2, V3, 'TYPED'] };
  assert.deepEqual(M.offeredIds(s.versionIds, subjects), [V2, V3]);
  assert.deepEqual(M.buildSendRequest('p1', P_SDE, s, subjects, to).versionIds, [V2, V3]);
  const kept = M.keepOffered(s, subjects);
  assert.deepEqual(kept.versionIds, [V2, V3]);
  assert.equal(M.keepOffered(kept, subjects), kept, 'nothing to drop: unchanged');
  const pending = M.beginSend(kept, true);
  assert.equal(M.keepOffered(pending, []), pending, 'never changed while sending');
  assert.match(sheet, /const chosenCount = offeredIds\(state\.versionIds, choices\)\.length;/);
  assert.match(sheet, /Versions \(\{chosenCount\} of at most \{SEND_MAX_SUBJECTS\}\)/);
  assert.match(sheet, /useEffect\(\(\) => \{ if \(subjects\.loaded\) setState\(\(s\) => keepOffered\(s, choices\)\); \}, \[subjects\.loaded, choices\]\);/);
});
