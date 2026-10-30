// test/nexus-artifact-model.test.cjs
// Task 10: the artifact model (labels, the actions the platform would allow, the
// read-only Passport view) and the Save sheet model, through load-ts; plus source
// pins on the .tsx files (no jsdom).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const A = loadTs('src/renderer/src/nexus/project/artifactModel.ts');
const S = loadTs('src/renderer/src/nexus/project/saveSheetModel.ts');
const P = loadTs('src/renderer/src/nexus/workspaces/participation.ts');
const { errorCopy } = loadTs('src/renderer/src/nexus/data/errorCopy.ts');

const NEXUS = path.join(__dirname, '..', 'src', 'renderer', 'src', 'nexus');
const src = (p) => fs.readFileSync(path.join(NEXUS, p), 'utf8');
const fail = (code, extra = {}) => ({ ok: false, code, message: 'm', ...extra });

const SHA = 'a'.repeat(40);
const ver = (o = {}) => ({ id: 'V1', status: 'draft', producedByEngine: false, promotedAt: null, ...o });
const art = (o = {}) => ({ status: 'active', ownerScope: 'participation', currentVersionId: 'CUR', ...o });

// ---------- actions (AM1–AM4) ----------

test('AM1: a user-made draft offers Mark ready and Discard; a job-made draft offers Discard only', () => {
  assert.deepEqual(A.actionsFor(ver(), art(), true).map((a) => a.kind), ['markReady', 'discard']);
  assert.deepEqual(A.actionsFor(ver({ producedByEngine: true }), art(), true).map((a) => a.kind), ['discard']);
});

test('AM2: candidate → Promote and Discard; active → Hand off; deprecated (once promoted) → Roll back; failed → nothing', () => {
  assert.deepEqual(A.actionsFor(ver({ status: 'candidate' }), art(), true).map((a) => a.kind), ['promote', 'discard']);
  assert.deepEqual(A.actionsFor(ver({ status: 'active' }), art(), true).map((a) => a.kind), ['handoff']);
  assert.deepEqual(A.actionsFor(ver({ status: 'deprecated', promotedAt: 5 }), art(), true).map((a) => a.kind), ['rollback']);
  assert.deepEqual(A.actionsFor(ver({ status: 'deprecated', promotedAt: null }), art(), true), []);
  assert.deepEqual(A.actionsFor(ver({ status: 'failed' }), art(), true), []);
});

test('AM3: a frozen owner, an archived artifact or a project-owned one offers no write action', () => {
  for (const status of ['draft', 'candidate', 'active', 'deprecated']) {
    const v = ver({ status, promotedAt: 1 });
    assert.deepEqual(A.actionsFor(v, art(), false), [], status);
    assert.deepEqual(A.actionsFor(v, art({ status: 'archived' }), true), [], status);
    assert.deepEqual(A.actionsFor(v, art({ ownerScope: 'project' }), true), [], status);
  }
});

test("AM4: Promote and Roll back pass the artifact's currentVersionId as expectedCurrentVersionId", () => {
  const [promote] = A.actionsFor(ver({ id: 'V2', status: 'candidate' }), art({ currentVersionId: 'V1' }), true);
  assert.deepEqual(promote, { kind: 'promote', versionId: 'V2', expectedCurrentVersionId: 'V1' });
  const [first] = A.actionsFor(ver({ id: 'V1', status: 'candidate' }), art({ currentVersionId: null }), true);
  assert.equal(first.expectedCurrentVersionId, null);
  const [rollback] = A.actionsFor(ver({ id: 'V1', status: 'deprecated', promotedAt: 3 }), art({ currentVersionId: 'V2' }), true);
  assert.deepEqual(rollback, { kind: 'rollback', versionId: 'V1', expectedCurrentVersionId: 'V2' });
});

test('labels: kinds and statuses in words', () => {
  assert.equal(A.kindLabel('git_commit'), 'Commit');
  assert.equal(A.kindLabel('text_file'), 'Text file');
  assert.equal(A.kindLabel('handoff_receipt'), 'Received');
  assert.equal(A.kindLabel('change_set'), 'Change set');
  assert.deepEqual(['draft', 'candidate', 'active', 'failed', 'deprecated'].map(A.statusLabel), ['draft', 'ready', 'active', 'failed', 'deprecated']);
  assert.equal(A.relationLabel('derived_from'), 'derived from');
});

// ---------- the project's summaries ----------

test('nextArtifacts: success replaces; unavailable empties quietly; busy keeps the last read with a sentence; not_found empties', () => {
  const s1 = A.nextArtifacts(A.NO_ARTIFACTS, { ok: true, data: [{ artifact: { id: 'x' } }] });
  assert.deepEqual([s1.artifacts.length, s1.loaded, s1.error], [1, true, null]);
  const off = A.nextArtifacts(s1, fail('platform_unavailable', { reason: 'held' }));
  assert.deepEqual(off, { artifacts: [], loaded: true, error: null, retry: false, truncated: false });
  assert.equal(s1.retry, false);
  const busy = A.nextArtifacts(s1, fail('platform_unavailable', { reason: 'busy' }));
  assert.equal(busy.artifacts, s1.artifacts);
  assert.equal(busy.error, errorCopy('platform_unavailable', 'busy').text);
  assert.equal(busy.retry, true);
  const gone = A.nextArtifacts(s1, fail('not_found'));
  assert.deepEqual(gone.artifacts, []);
  assert.equal(gone.error, errorCopy('not_found').text);
  assert.equal(gone.retry, false);
});

test('nextArtifacts carries truncated from nexus:artifacts:byProject; the Spine says which artifacts are drawn', () => {
  assert.equal(A.NO_ARTIFACTS.truncated, false);
  const capped = A.nextArtifacts(A.NO_ARTIFACTS, { ok: true, data: [{ artifact: { id: 'x' } }], truncated: true });
  assert.equal(capped.truncated, true);
  assert.equal(A.nextArtifacts(A.NO_ARTIFACTS, { ok: true, data: [] }).truncated, false, 'no flag: not truncated');
  assert.equal(A.nextArtifacts(capped, { ok: true, data: [], truncated: false }).truncated, false);
  // A passing failure keeps the last read and its cap; unavailable and not_found clear both.
  assert.equal(A.nextArtifacts(capped, fail('platform_unavailable', { reason: 'busy' })).truncated, true);
  assert.equal(A.nextArtifacts(capped, fail('internal')).truncated, true);
  assert.equal(A.nextArtifacts(capped, fail('platform_unavailable', { reason: 'held' })).truncated, false);
  assert.equal(A.nextArtifacts(capped, fail('not_found')).truncated, false);
  assert.equal(A.nextArtifacts(capped, fail('denied')).truncated, false);
  assert.match(A.SPINE_TRUNCATED_TEXT, /first 1000/);
});

// ---------- the Passport view ----------

const versionView = (id, versionNo, status, o = {}) => ({
  id, artifactId: 'A1', versionNo, projectId: 'p', participationId: 'PART-1', status, draftFlag: null, storageKind: 'git', contentHash: 'h',
  validationState: 'passed', producedByEngine: false, producedByAction: 'user.save_commit', createdAt: 1, statusChangedAt: 1, promotedAt: null, ...o
});
const detail = {
  artifact: { id: 'A1', projectId: 'p', kind: 'git_commit', name: 'Release', description: null, ownerScope: 'participation', ownerParticipationId: 'PART-1',
    ownerWorkspaceId: 'sde', status: 'active', currentVersionId: 'V2', createdAt: 1, updatedAt: 2 },
  versions: [versionView('V1', 1, 'deprecated', { promotedAt: 1 }), versionView('V2', 2, 'active', { promotedAt: 2 }), versionView('V3', 3, 'draft')]
};
const OTHER = 'b'.repeat(40);
const input = (o = {}) => ({
  detail, shownVersionId: 'V2', owner: { label: 'SDE', active: true },
  contents: new Map([['V1', { type: 'git', commit: OTHER }], ['V2', { type: 'git', commit: SHA }], ['V3', { type: 'text', path: 'docs/notes.md', text: 'secret-ish body' }]]),
  subjects: new Map([[SHA, 'Ship the release']]),
  names: new Map([['A1', 'Release'], ['N1', 'Notes']]),
  up: { nodes: [], truncated: false },
  down: { nodes: [{ versionId: 'NV1', artifactId: 'N1', kind: 'text_file', versionNo: 1, status: 'candidate', depth: 1, relation: 'derived_from' },
    { versionId: 'RV1', artifactId: 'R9', kind: 'handoff_receipt', versionNo: 1, status: 'active', depth: 1, relation: 'depends_on' }], truncated: true },
  ...o
});

test('passport: the artifact, its versions newest first with statuses, the current one marked', () => {
  const v = A.artifactPassportView(input());
  assert.equal(v.title, 'Release');
  assert.equal(v.kind, 'Commit');
  const rows = Object.fromEntries(v.rows.map((r) => [r.label, r.value]));
  assert.deepEqual(rows, { Kind: 'Commit', Workspace: 'SDE', 'Current version': 'Version 2', Versions: '3' });
  assert.deepEqual(v.versions.map((x) => [x.versionNo, x.status, x.current, x.shown]), [[3, 'draft', false, false], [2, 'active', true, true], [1, 'deprecated', false, false]]);
});

test('passport: git versions show the full SHA; the subject only when the project git log knows the commit', () => {
  const v = A.artifactPassportView(input());
  const byNo = Object.fromEntries(v.versions.map((x) => [x.versionNo, x]));
  assert.equal(byNo[2].content, `Commit ${SHA}`);
  assert.equal(byNo[2].subject, 'Ship the release');
  assert.equal(byNo[1].content, `Commit ${OTHER}`);
  assert.equal(byNo[1].subject, null, 'not in the allow-list: no subject');
  assert.equal(byNo[3].content, 'File docs/notes.md');
  assert.equal(byNo[3].subject, null);
  assert.doesNotMatch(JSON.stringify(v), /secret-ish body/, 'the text body is not shown');
  const none = A.artifactPassportView(input({ contents: new Map() }));
  assert.ok(none.versions.every((x) => x.content === null), 'unknown content is not invented');
  const receipt = A.artifactPassportView(input({ contents: new Map([['V2', { type: 'receipt', handoffId: 'H1' }]]) }));
  assert.equal(receipt.versions[1].content, 'Received through a handoff');
});

test('passport: lineage as sources and uses, with truncated; names only from the summaries', () => {
  const v = A.artifactPassportView(input());
  assert.deepEqual(v.upstream, []);
  assert.equal(v.upstreamTruncated, false);
  assert.deepEqual(v.downstream, [
    { versionId: 'NV1', label: 'Text file Notes, version 1', relation: 'derived from', status: 'ready' },
    { versionId: 'RV1', label: 'Received, version 1', relation: 'depends on', status: 'active' }
  ]);
  assert.equal(v.downstreamTruncated, true);
  const unread = A.artifactPassportView(input({ up: null, down: null }));
  assert.deepEqual([unread.upstream, unread.downstream], [null, null]);
});

test('passport: a withdrawn owner and an archived artifact say so in words; no principal or participation id is shown', () => {
  const archived = { ...detail, artifact: { ...detail.artifact, status: 'archived', currentVersionId: null } };
  const v = A.artifactPassportView(input({ detail: archived, owner: { label: 'QA', active: false } }));
  const rows = Object.fromEntries(v.rows.map((r) => [r.label, r.value]));
  assert.equal(rows.Workspace, 'QA (withdrawn)');
  assert.equal(rows['Current version'], 'None yet');
  assert.equal(rows.Status, 'Archived');
  const text = JSON.stringify(A.artifactPassportView(input()));
  for (const leak of ['PART-1', 'user:', 'participationId', 'createdBy', 'producedByAction', 'user.save_commit']) assert.ok(!text.includes(leak), leak);
});

test('shownVersionOf: current, else latest, else nothing', () => {
  assert.deepEqual(A.shownVersionOf({ current: { id: 'c', versionNo: 2 }, latest: { id: 'l', versionNo: 3, status: 'draft' } }), { id: 'c', versionNo: 2, status: 'active', isCurrent: true });
  assert.deepEqual(A.shownVersionOf({ current: null, latest: { id: 'l', versionNo: 3, status: 'draft' } }), { id: 'l', versionNo: 3, status: 'draft', isCurrent: false });
  assert.equal(A.shownVersionOf({ current: null, latest: null }), null);
});

// ---------- the Save sheet ----------

const prow = (id, workspaceId, isPrimary, status = 'active') => ({ id, projectId: 'p', workspaceId, status, isPrimary, source: 'user' });
const IDX = P.fromRows([prow('P-QA', 'qa', false), prow('P-SDE', 'sde', true), prow('P-DL', 'dl', false, 'withdrawn')]);
const sum = (id, name, kind, part, ws, o = {}) => ({
  artifact: { id, projectId: 'p', kind, name, description: null, ownerScope: 'participation', ownerParticipationId: part, ownerWorkspaceId: ws,
    status: 'active', currentVersionId: null, createdAt: 1, updatedAt: 1, ...o },
  versionCount: 1, latest: { id: `${id}v`, versionNo: 2, status: 'draft' }, current: null
});
const ARTS = [
  sum('A-REL', 'Release', 'git_commit', 'P-SDE', 'sde'),
  sum('A-NOTES', 'notes.md', 'text_file', 'P-SDE', 'sde'),
  sum('A-QA', 'Release', 'git_commit', 'P-QA', 'qa'),
  sum('A-OLD', 'Old', 'git_commit', 'P-SDE', 'sde', { status: 'archived' })
];
const commitSrc = { kind: 'commit', sha: SHA, subject: '  Ship\tthe release  ' };

test('save: the workspace choices are the active participations, primary first; none while writes are off or legacy', () => {
  assert.deepEqual(S.workspaceChoices(IDX, 'p', true).map((c) => [c.workspaceId, c.isPrimary, c.participationId]), [['sde', true, 'P-SDE'], ['qa', false, 'P-QA']]);
  assert.deepEqual(S.workspaceChoices(IDX, 'p', false), []);
  assert.deepEqual(S.workspaceChoices(P.legacyIndex([{ id: 'p', domainId: 'web-app-dev' }]), 'p', true), []);
});

test('save: "New version of…" lists same-kind, unarchived artifacts owned by that participation', () => {
  const [sde, qa] = S.workspaceChoices(IDX, 'p', true);
  assert.deepEqual(S.existingTargets(ARTS, sde, 'git_commit').map((t) => t.artifactId), ['A-REL']);
  assert.deepEqual(S.existingTargets(ARTS, sde, 'text_file').map((t) => [t.artifactId, t.latestVersionNo]), [['A-NOTES', 2]]);
  assert.deepEqual(S.existingTargets(ARTS, qa, 'git_commit').map((t) => t.artifactId), ['A-QA']);
  assert.deepEqual(S.existingTargets(ARTS, null, 'git_commit'), []);
});

test('save: the name is prefilled from the commit subject or the file name; an existing name steers to a new version', () => {
  const choices = S.workspaceChoices(IDX, 'p', true);
  assert.equal(S.defaultName(commitSrc), 'Ship the release');
  assert.equal(S.defaultName({ kind: 'file', relPath: 'docs/api/notes.md' }), 'notes.md');
  assert.equal(S.defaultName({ kind: 'file', relPath: null }), '');
  const fresh = S.initialSaveState(commitSrc, choices, ARTS);
  assert.deepEqual(fresh, { workspaceId: 'sde', target: { mode: 'new', name: 'Ship the release' }, pending: false, error: null });
  // A file whose name already is an artifact there: the sheet opens on "New version of" that artifact.
  const file = S.initialSaveState({ kind: 'file', relPath: 'notes.md' }, choices, ARTS);
  assert.deepEqual(file.target, { mode: 'existing', artifactId: 'A-NOTES' });
  // Typing an existing name (case and spacing ignored) shows the steer.
  const typed = S.setTarget(fresh, { mode: 'new', name: '  release ' });
  const steer = S.steerTarget(typed, commitSrc, choices, ARTS);
  assert.equal(steer.artifactId, 'A-REL');
  assert.equal(S.steerText(steer.name, 'SDE'), 'An artifact named “Release” already exists in SDE. Add this as a new version of it instead of making a second one.');
  assert.equal(S.steerTarget(S.setTarget(fresh, { mode: 'new', name: 'Brand new' }), commitSrc, choices, ARTS), null);
});

test('save: changing the workspace drops an existing target not owned there', () => {
  const choices = S.workspaceChoices(IDX, 'p', true);
  const s = S.setTarget(S.initialSaveState(commitSrc, choices, ARTS), { mode: 'existing', artifactId: 'A-REL' });
  const moved = S.selectWorkspace(s, 'qa', commitSrc, choices, ARTS);
  assert.equal(moved.workspaceId, 'qa');
  assert.deepEqual(moved.target, { mode: 'new', name: 'Ship the release' });
  assert.equal(S.selectWorkspace(s, 'dl', commitSrc, choices, ARTS), s, 'a withdrawn workspace is not a choice');
  const named = S.setTarget(s, { mode: 'new', name: 'Mine' });
  assert.deepEqual(S.selectWorkspace(named, 'qa', commitSrc, choices, ARTS).target, { mode: 'new', name: 'Mine' }, 'a typed name is kept');
});

test('save: the request carries only { projectId, workspaceId, commit | relPath, target }', () => {
  const choices = S.workspaceChoices(IDX, 'p', true);
  const s = S.initialSaveState(commitSrc, choices, ARTS);
  const c = S.buildRequest('p', s, commitSrc);
  assert.deepEqual(c, { kind: 'commit', args: { projectId: 'p', workspaceId: 'sde', commit: SHA, target: { name: 'Ship the release' } } });
  assert.deepEqual(Object.keys(c.args).sort(), ['commit', 'projectId', 'target', 'workspaceId']);
  const f = S.buildRequest('p', S.setTarget(s, { mode: 'existing', artifactId: 'A-NOTES' }), { kind: 'file', relPath: 'docs\\notes.md' });
  assert.deepEqual(f, { kind: 'file', args: { projectId: 'p', workspaceId: 'sde', relPath: 'docs/notes.md', target: { artifactId: 'A-NOTES' } } });
  assert.deepEqual(Object.keys(f.args).sort(), ['projectId', 'relPath', 'target', 'workspaceId']);
  // Incomplete or unsafe: no request.
  assert.equal(S.buildRequest('p', S.setTarget(s, { mode: 'new', name: '   ' }), commitSrc), null);
  assert.equal(S.buildRequest('p', S.setTarget(s, { mode: 'new', name: 'x'.repeat(201) }), commitSrc), null);
  assert.equal(S.buildRequest('p', S.setTarget(s, { mode: 'new', name: 'a\u0007b' }), commitSrc), null);
  assert.equal(S.buildRequest('p', S.setTarget(s, { mode: 'existing', artifactId: null }), commitSrc), null);
  assert.equal(S.buildRequest('p', s, { kind: 'commit', sha: 'abc1234', subject: '' }), null, 'a short sha is not a commit id');
  assert.equal(S.buildRequest('p', { ...s, workspaceId: null }, commitSrc), null);
  for (const bad of [null, '', '/etc/passwd', 'C:/x.txt', 'c:x', '..\\up.txt', 'a/../../b', 'a//b', 'a\0b'])
    assert.equal(S.buildRequest('p', s, { kind: 'file', relPath: bad }), null, String(bad));
});

test('save: pending blocks a second submit; a failure clears pending and keeps the choices', () => {
  const s = S.initialSaveState(commitSrc, S.workspaceChoices(IDX, 'p', true), ARTS);
  assert.equal(S.beginSave(s, false), null, 'an incomplete sheet cannot submit');
  const p = S.beginSave(s, true);
  assert.equal(p.pending, true);
  assert.equal(S.beginSave(p, true), null);
  assert.equal(S.setTarget(p, { mode: 'new', name: 'other' }), p, 'nothing changes while saving');
  const f = S.saveFailed(p, 'nope');
  assert.deepEqual([f.pending, f.error, f.workspaceId, f.target.mode], [false, 'nope', 'sde', 'new']);
});

test('save: every refusal reads through errorCopy, each with its own sentence', () => {
  const reasons = ['sensitive_name', 'secret_in_content', 'too_large', 'not_text', 'path_refused', 'not_a_commit', 'not_a_repository',
    'file_not_found', 'project_folder_unavailable', 'kind_mismatch', 'secret_in_metadata'];
  const seen = new Set();
  for (const reason of reasons) {
    const text = S.saveFailureText(fail('invalid', { reason }));
    assert.equal(text, errorCopy('invalid', reason).text, reason);
    assert.notEqual(text, errorCopy('invalid').text, `${reason} has its own sentence`);
    seen.add(text);
  }
  assert.equal(seen.size, reasons.length);
  assert.match(S.saveFailureText(fail('invalid', { reason: 'path_refused' })), /It is outside the project folder, or it is a linked file that is also stored under other names/);
  for (const code of ['not_participating', 'participation_inactive', 'conflict', 'not_found', 'denied', 'internal'])
    assert.equal(S.saveFailureText(fail(code)), errorCopy(code).text, code);
  assert.equal(S.saveFailureText(fail('platform_unavailable', { reason: 'busy' })), errorCopy('platform_unavailable', 'busy').text);
});

test('save: failures that may mean stale screens ask for a reload; busy and plain refusals do not', () => {
  for (const r of [fail('not_found'), fail('conflict'), fail('not_participating'), fail('participation_inactive'), fail('platform_unavailable', { reason: 'held' })])
    assert.equal(S.shouldReloadAfterSave(r), true, r.code);
  for (const r of [fail('platform_unavailable', { reason: 'busy' }), fail('invalid', { reason: 'too_large' }), fail('denied'), fail('internal')])
    assert.equal(S.shouldReloadAfterSave(r), false, r.code);
});

test('save: the file chooser lists entries relative to the project root, never .git or odd names; big files are marked', () => {
  const entries = [{ name: 'src', isDir: true, size: 0 }, { name: '.git', isDir: true, size: 0 }, { name: 'README.md', isDir: false, size: 10 },
    { name: 'big.log', isDir: false, size: 70000 }, { name: '..', isDir: true, size: 0 }, { name: 'a/b', isDir: false, size: 1 }];
  assert.deepEqual(S.fileChoices('', entries).map((f) => [f.relPath, f.isDir, f.tooLarge]), [['src', true, false], ['README.md', false, false], ['big.log', false, true]]);
  assert.deepEqual(S.fileChoices('src/lib', [{ name: 'x.ts', isDir: false, size: 1 }]).map((f) => f.relPath), ['src/lib/x.ts']);
  assert.deepEqual(S.fileChoices('../out', entries), [], 'a folder outside the project lists nothing');
  assert.equal(S.parentDir('src/lib'), 'src');
  assert.equal(S.parentDir('src'), '');
});

// ---------- source pins ----------

const sheet = src('project/SaveArtifactSheet.tsx');
const passport = src('project/ArtifactPassport.tsx');
const panel = src('project/PassportPanel.tsx');

test('pin: the Save sheet renders only while writes are on and sends only through the two save channels', () => {
  assert.match(sheet, /const canWrite = usePlatform\(selectCanWrite\);/);
  assert.match(sheet, /if \(!canWrite\) return null;/);
  assert.match(sheet, /nexusClient\.artifactSaveCommit\(req\.args\) : await nexusClient\.artifactSaveTextFile\(req\.args\)/);
  assert.match(sheet, /const req = buildRequest\(project\.id, state, source\);/);
  // The renderer never reads file contents; it lists the project folder and the git log through the existing channels.
  assert.doesNotMatch(sheet, /readFile|readBinary|statAbs|writeFile/);
  assert.match(sheet, /window\.cth\.listDir\(root, dir\)/);
  assert.match(sheet, /useFolder\(project\.rootPath, dir,/);
  assert.match(sheet, /window\.cth\.gitLog\(root, 30\)/);
  assert.doesNotMatch(sheet, /\.path\b(?!\w)/, 'the absolute path listDir returns is not used');
});

test('pin: the Save sheet bumps rev before the unmount check, blocks a double submit, and cannot be closed mid-save', () => {
  assert.match(sheet, /if \(r\.ok \|\| shouldReloadAfterSave\(r\)\) bumpRev\(\);\s*if \(!alive\.current\) return;/);
  assert.equal((sheet.match(/bumpRev\(\)/g) || []).length, 1);
  assert.match(sheet, /if \(running\.current\) return;/);
  assert.match(sheet, /const next = beginSave\(state, req !== null\);\s*if \(!next \|\| !req\) return;/);
  assert.match(sheet, /const safeClose = useCallback\(\(\) => \{ if \(!pendingRef\.current\) closeRef\.current\(\); \}, \[\]\);/);
  assert.match(sheet, /<Sheet open onClose=\{safeClose\}/);
  assert.match(sheet, /disabled=\{pending \|\| request === null\}>\{pending \? 'Saving…' : 'Save'\}/);
  assert.match(sheet, /<Button disabled=\{pending\} onClick=\{safeClose\}>Cancel<\/Button>/);
  assert.match(sheet, /setState\(\(s\) => saveFailed\(s, saveFailureText\(r\)\)\)/);
  assert.match(sheet, /role="alert">\{state\.error\}/);
  assert.match(sheet, /workspaceChoices\(idx, project\.id, canWrite\)/);
  assert.match(sheet, /steerText\(steer\.name, ws\.label\)/);
});

test('pin: the artifact Passport reads the artifact, its versions and lineage both ways', () => {
  for (const call of ['artifactGet', 'versionGet', 'lineageGet']) assert.match(passport, new RegExp(`nexusClient\\.${call}\\(`), call);
  assert.match(passport, /direction: 'up', depth: 1/);
  assert.match(passport, /direction: 'down', depth: 1/);
  for (const write of ['handoffSend', 'artifactSave']) assert.doesNotMatch(passport, new RegExp(write), write);
  assert.match(passport, /artifactPassportView\(/);
  assert.match(passport, /truncated=\{view\.upstreamTruncated\}/);
  assert.match(passport, /truncated=\{view\.downstreamTruncated\}/);
});

test('pin: the project Passport offers saving only when the bench passes onSave, and shows the artifact Passport for artifact nodes', () => {
  // Task 13: the artifact branch also passes the bench's send-sheet opener (closing the Details sheet first).
  assert.match(panel, /if \(props\.node\.kind === 'artifact'\) \{/);
  assert.match(panel, /return <ArtifactPassport key=\{props\.node\.artifactId\} project=\{props\.project\} node=\{props\.node\} artifacts=\{props\.artifacts\} onHandOff=\{handOff\} \/>;/);
  assert.match(panel, /if \(onBeforeAction\) \{ onBeforeAction\(\); setTimeout\(\(\) => onHandOff\(start\), 0\); \} else onHandOff\(start\);/);
  assert.match(panel, /\{onSave && c && \(/);
  assert.match(panel, />Save as artifact<\/Button>/);
  assert.match(panel, /\{onSave && node\.kind === 'source' && <Button icon="files" onClick=\{\(\) => save\(\{ kind: 'file', relPath: null \}\)\}>Save a file…<\/Button>\}/);
  assert.match(panel, /\{p\.relationshipsNote && <p className="nx-muted">\{p\.relationshipsNote\}<\/p>\}/);
});

test('pin: the new styles use unique prefixes and existing tokens only', () => {
  const css = fs.readFileSync(path.join(NEXUS, 'styles', 'platform.css'), 'utf8');
  for (const cls of ['nx-spx-muted', 'nx-spx-state', 'nx-apx__links', 'nx-svx', 'nx-svx__steer', 'nx-svx-commit']) assert.match(css, new RegExp(`\\.${cls}\\b`), cls);
  const tokens = fs.readFileSync(path.join(NEXUS, 'styles', 'tokens.css'), 'utf8');
  for (const v of new Set(css.match(/var\(--nx-[a-z0-9-]+\)/g) || [])) assert.ok(tokens.includes(`${v.slice(4, -1)}:`), v);
});

test('the passport relationships note gives way once the project has artifacts', () => {
  const { passportFor, RELATIONSHIPS_NOTE } = loadTs('src/renderer/src/nexus/project/passport.ts');
  const project = { id: 'p', name: 'X', rootPath: 'C:/x', domainId: 'web-app-dev', detectedLanguages: [], frameworks: [], health: {} };
  const node = { kind: 'source', id: 'source', vcs: 'git', branch: 'main', head: null };
  const idx = P.legacyIndex([project]);
  assert.equal(passportFor({ project, idx, node, commits: [] }).relationshipsNote, RELATIONSHIPS_NOTE);
  assert.equal(passportFor({ project, idx, node, commits: [], hasArtifacts: true }).relationshipsNote, null);
  const artNode = { kind: 'artifact', id: 'artifact:A', artifactId: 'A', artifactKind: 'text_file', name: 'n', versionNo: 1, status: 'draft', isCurrent: false };
  assert.equal(passportFor({ project, idx, node: artNode, commits: [] }).kind, 'Text file');
});

// ---------- Task 11: version actions in the Passport ----------

test('VA1: the Passport offers exactly what actionsFor allows, minus hand off, and nothing while writes are off', () => {
  const kinds = (v, a = art(), owner = true, write = true) => A.passportActionsFor(v, a, owner, write).map((x) => x.kind);
  assert.deepEqual(kinds(ver()), ['markReady', 'discard']);
  assert.deepEqual(kinds(ver({ producedByEngine: true })), ['discard']);
  assert.deepEqual(kinds(ver({ status: 'candidate' })), ['promote', 'discard']);
  assert.deepEqual(kinds(ver({ status: 'active' })), [], 'hand off is not a Passport button here');
  assert.deepEqual(kinds(ver({ status: 'deprecated', promotedAt: 5 })), ['rollback']);
  assert.deepEqual(kinds(ver({ status: 'deprecated', promotedAt: null })), []);
  for (const v of [ver(), ver({ status: 'candidate' }), ver({ status: 'deprecated', promotedAt: 5 })]) {
    assert.deepEqual(kinds(v, art(), true, false), [], 'writes off');
    assert.deepEqual(kinds(v, art(), false, true), [], 'frozen owner');
    assert.deepEqual(kinds(v, art({ status: 'archived' })), [], 'archived');
    assert.deepEqual(kinds(v, art({ ownerScope: 'project' })), [], 'project-owned');
  }
  assert.equal(A.canLinkSources(art(), true, true), true);
  assert.equal(A.canLinkSources(art(), true, false), false);
  assert.equal(A.canLinkSources(art(), false, true), false);
  assert.equal(A.canLinkSources(art({ status: 'archived' }), true, true), false);
  assert.equal(A.canLinkSources(art({ ownerScope: 'project' }), true, true), false);
});

test('VA2: promote and roll back carry the current version the person saw; null only when there is none', () => {
  const p = A.passportActionsFor(ver({ status: 'candidate' }), art({ currentVersionId: 'CUR' }), true, true).find((a) => a.kind === 'promote');
  assert.equal(p.expectedCurrentVersionId, 'CUR');
  const r = A.passportActionsFor(ver({ status: 'deprecated', promotedAt: 1 }), art({ currentVersionId: 'V9' }), true, true)[0];
  assert.equal(r.expectedCurrentVersionId, 'V9');
  const first = A.passportActionsFor(ver({ status: 'candidate' }), art({ currentVersionId: null }), true, true)[0];
  assert.equal(first.expectedCurrentVersionId, null);
});

test('VA3: the pending/confirm machine blocks double submits and starts destructive actions only from their confirmation', () => {
  const S0 = A.IDLE_ACTIONS;
  assert.equal(A.needsConfirm('discard'), true);
  assert.equal(A.needsConfirm('rollback'), true);
  assert.equal(A.needsConfirm('promote'), false);
  assert.equal(A.needsConfirm('markReady'), false);
  assert.equal(A.needsConfirm('link'), false);
  assert.equal(A.beginAction(S0, 'discard', 'V1'), null, 'no discard without confirming');
  assert.equal(A.beginAction(S0, 'rollback', 'V1'), null);
  const c = A.askActionConfirm({ ...S0, error: 'old', announce: 'old' }, 'discard', 'V1');
  assert.deepEqual(c, { pending: null, confirming: { kind: 'discard', versionId: 'V1' }, error: null, announce: null });
  assert.equal(A.beginAction(c, 'discard', 'V2'), null, 'the confirmation is for another version');
  assert.equal(A.beginAction(c, 'rollback', 'V1'), null, 'the confirmation is for another action');
  const p = A.beginAction(c, 'discard', 'V1');
  assert.deepEqual(p.pending, { kind: 'discard', versionId: 'V1' });
  assert.deepEqual(p.confirming, { kind: 'discard', versionId: 'V1' }, 'the confirmation stays visible, disabled, while pending');
  assert.equal(A.beginAction(p, 'discard', 'V1'), null, 'double submit');
  assert.equal(A.beginAction(p, 'markReady', 'V2'), null, 'any other action while one runs');
  assert.equal(A.askActionConfirm(p, 'rollback', 'V3'), p, 'no new confirmation while pending');
  assert.equal(A.cancelActionConfirm(p), p, 'no cancel while pending');
  assert.equal(A.cancelActionConfirm(c).confirming, null);
  const m = A.beginAction(S0, 'markReady', 'V1');
  assert.deepEqual(m, { pending: { kind: 'markReady', versionId: 'V1' }, confirming: null, error: null, announce: null });
  // Any answer re-enables everything.
  assert.deepEqual(A.actionSucceeded(p, 'done'), { pending: null, confirming: null, error: null, announce: 'done' });
  assert.deepEqual(A.actionFailed(p, 'no'), { pending: null, confirming: null, error: 'no', announce: null });
});

test('VA4: a promote or roll back conflict says plainly that the current version changed, and reloads', () => {
  const conflict = { code: 'conflict', detail: { currentVersionId: 'X' } };
  assert.equal(A.actionFailureText('promote', conflict), 'The current version changed; the list is refreshed');
  assert.equal(A.actionFailureText('rollback', conflict), A.PROMOTE_CONFLICT_TEXT);
  assert.equal(A.shouldReloadAfterAction(conflict), true);
  // A conflict elsewhere (an archived artifact) keeps the general sentence.
  assert.equal(A.actionFailureText('discard', { code: 'conflict' }), errorCopy('conflict').text);
});

test('VA5: failure copy: cycle and bad sources for links; errorCopy for everything else', () => {
  assert.equal(A.actionFailureText('link', { code: 'cycle' }), A.LINK_CYCLE_TEXT);
  assert.notEqual(A.LINK_CYCLE_TEXT, errorCopy('cycle').text);
  assert.equal(A.actionFailureText('link', { code: 'invalid' }), A.LINK_INVALID_TEXT);
  assert.equal(A.actionFailureText('link', { code: 'invalid', reason: 'bad_request' }), errorCopy('invalid', 'bad_request').text);
  assert.equal(A.actionFailureText('markReady', { code: 'invalid', reason: 'produced_by_job' }), errorCopy('invalid', 'produced_by_job').text);
  for (const code of ['denied', 'not_found', 'illegal_transition', 'participation_inactive', 'internal'])
    for (const k of ['markReady', 'promote', 'rollback', 'discard', 'link']) assert.equal(A.actionFailureText(k, { code }), errorCopy(code).text, `${k} ${code}`);
  assert.equal(A.actionFailureText('promote', { code: 'platform_unavailable', reason: 'busy' }), errorCopy('platform_unavailable', 'busy').text);
});

test('VA6: which failures reload the readers', () => {
  const yes = [{ code: 'conflict' }, { code: 'not_found' }, { code: 'illegal_transition' }, { code: 'participation_inactive' },
    { code: 'invalid' }, { code: 'platform_unavailable', reason: 'held' }];
  const no = [{ code: 'cycle' }, { code: 'denied' }, { code: 'internal' }, { code: 'invalid', reason: 'bad_request' },
    { code: 'invalid', reason: 'produced_by_job' }, { code: 'platform_unavailable', reason: 'busy' }, { code: 'platform_unavailable', reason: 'handoffs_unavailable' }];
  for (const r of yes) assert.equal(A.shouldReloadAfterAction(r), true, JSON.stringify(r));
  for (const r of no) assert.equal(A.shouldReloadAfterAction(r), false, JSON.stringify(r));
});

test('VA7: labels, confirmation questions and result sentences', () => {
  assert.equal(A.actionLabel('markReady', false), 'Mark ready');
  assert.equal(A.actionLabel('markReady', true), 'Marking ready…');
  assert.equal(A.actionLabel('promote', false), 'Make current');
  assert.equal(A.actionLabel('rollback', true), 'Rolling back…');
  assert.equal(A.actionLabel('discard', true), 'Discarding…');
  assert.equal(A.actionLabel('link', false), 'Link a source…');
  assert.match(A.confirmText('discard', 3, 2), /^Discard version 3\?/);
  assert.equal(A.confirmText('rollback', 1, 2), 'Make version 1 current again? Version 2 stops being current.');
  assert.equal(A.confirmText('rollback', 1, null), 'Make version 1 current again?');
  assert.equal(A.actionDoneText('markReady', 3), 'Version 3 is ready.');
  assert.equal(A.actionDoneText('promote', 3), 'Version 3 is now current.');
  assert.equal(A.actionDoneText('rollback', 1), 'Rolled back: version 1 is current again.');
  assert.equal(A.actionDoneText('discard', 4), 'Version 4 was discarded.');
  assert.equal(A.actionDoneText('link', 2, { created: 1, sourceLabel: 'Commit Release, version 1' }), 'Commit Release, version 1 is now a source of version 2.');
  assert.equal(A.actionDoneText('link', 2, { created: 0, sourceLabel: 'Commit Release, version 1' }), 'Commit Release, version 1 was already a source of version 2.');
});

test('VA8: link choices come only from returned versions: out of draft, other non-archived artifacts of this project, not already linked', () => {
  const v = (id, artifactId, versionNo, status, projectId = 'p') => ({ id, artifactId, versionNo, status, projectId });
  const d = (id, name, kind, versions, o = {}) => ({ artifact: { id, projectId: 'p', name, kind, status: 'active', ...o }, versions });
  const details = [
    d('SELF', 'Me', 'text_file', [v('S1', 'SELF', 1, 'active')]),
    d('R', 'Release', 'git_commit', [v('R1', 'R', 1, 'deprecated'), v('R2', 'R', 2, 'active'), v('R3', 'R', 3, 'candidate'), v('R4', 'R', 4, 'draft'), v('R5', 'R', 5, 'failed')]),
    d('N', 'Notes', 'text_file', [v('N1', 'N', 1, 'candidate'), v('N2', 'N', 2, 'active')]),
    d('OLD', 'Old', 'text_file', [v('O1', 'OLD', 1, 'active')], { status: 'archived' }),
    d('X', 'Elsewhere', 'text_file', [v('X1', 'X', 1, 'active', 'q')], { projectId: 'q' }),
    d('M', 'Mixed', 'text_file', [v('M1', 'OTHER', 1, 'active')])
  ];
  const c = A.sourceChoices('SELF', 'p', details, new Set(['N2']));
  assert.deepEqual(c, [
    { versionId: 'N1', label: 'Text file Notes, version 1', status: 'ready' },
    { versionId: 'R3', label: 'Commit Release, version 3', status: 'ready' },
    { versionId: 'R2', label: 'Commit Release, version 2', status: 'active' }
  ]);
  assert.deepEqual(A.sourceChoices('SELF', 'p', [], new Set()), []);
});

test('VA9: the picker reads the most recently changed other artifacts, capped, and says when it is capped', () => {
  const s = (id, updatedAt, o = {}) => ({ artifact: { id, status: 'active', updatedAt, ...o }, versionCount: 1, latest: null, current: null });
  const r = A.candidateArtifactIds('SELF', [s('SELF', 9), s('A', 1), s('B', 3), s('C', 2, { status: 'archived' }), { ...s('E', 5), versionCount: 0 }]);
  assert.deepEqual(r, { ids: ['B', 'A'], capped: false });
  const many = Array.from({ length: A.LINK_CANDIDATE_ARTIFACTS + 2 }, (_, i) => s(`A${i}`, i));
  const big = A.candidateArtifactIds('SELF', many);
  assert.equal(big.ids.length, A.LINK_CANDIDATE_ARTIFACTS);
  assert.equal(big.capped, true);
  assert.equal(big.ids[0], `A${A.LINK_CANDIDATE_ARTIFACTS + 1}`);
});

test('pin: the Passport actions render only while writes are on and only where actionsFor allows them', () => {
  assert.match(passport, /const canWrite = usePlatform\(selectCanWrite\);/);
  assert.match(passport, /passportActionsFor\(v, artifact, ownerActive, canWrite\)/);
  assert.match(passport, /canLinkSources\(artifact, ownerActive, canWrite\)/);
  assert.match(passport, /const ownerActive = ownerRow !== null && ownerRow\.status === 'active';/);
  // Task 13: the row's action strip also renders for "Hand off…" alone.
  assert.match(passport, /\{v && \(allowed\.length > 0 \|\| handOff\) && !confirming && \(/);
  assert.match(passport, /\{linkable && shownVersion && \(/);
});

test('pin: every Passport action is one real IPC call; promote sends the current version shown', () => {
  assert.match(passport, /case 'markReady': return nexusClient\.versionMarkReady\(v\.id\);/);
  assert.match(passport, /case 'rollback': return nexusClient\.versionPromote\(v\.id, loaded\?\.detail\.artifact\.currentVersionId \?\? null\);/);
  assert.match(passport, /case 'discard': return nexusClient\.versionDiscard\(v\.id\);/);
  assert.match(passport, /nexusClient\.versionLinkSources\(v\.id, \[source\.versionId\]\)/);
  assert.equal((passport.match(/nexusClient\.versionPromote\(/g) || []).length, 1);
});

test('pin: pending blocks double submits, bumpRev runs before the unmount check, and failures use the action copy', () => {
  assert.match(passport, /if \(running\.current\) return;\s*const next = beginAction\(acts, kind, v\.id\);\s*if \(!next\) return;/);
  assert.match(passport, /const r = await send\(kind, v, source\)\.catch\(\(\): NexusResult<unknown> => INTERNAL\);/);
  assert.match(passport, /if \(r\.ok \|\| shouldReloadAfterAction\(r\)\) bumpRev\(\);\s*if \(!alive\.current\) return;/);
  assert.equal((passport.match(/bumpRev\(\)/g) || []).length, 1);
  assert.match(passport, /setActs\(\(s\) => actionFailed\(s, actionFailureText\(kind, r\)\)\)/);
  assert.match(passport, /disabled=\{pending !== null\} onClick=\{onClick\}/);
  assert.match(passport, /\{!pending && acts\.error && <p ref=\{resultRef\} tabIndex=\{-1\} className="nx-passport__note" role="alert">\{acts\.error\}<\/p>\}/);
  assert.match(passport, /\{!pending && acts\.announce && <p ref=\{resultRef\} tabIndex=\{-1\} className="nx-apx__status" role="status">\{acts\.announce\}<\/p>\}/);
});

test('pin: discard and roll back confirm inline with focus on Cancel', () => {
  assert.match(passport, /a\.kind === 'discard' \|\| a\.kind === 'rollback'\s*\? \(\) => setActs\(\(s\) => askActionConfirm\(s, a\.kind as 'discard' \| 'rollback', v\.id\)\)/);
  assert.match(passport, /if \(acts\.confirming && !acts\.pending\) cancelRef\.current\?\.focus\(\);/);
  assert.match(passport, /<button ref=\{cancelRef\} type="button" className="nx-btn" disabled=\{pending !== null\} onClick=\{\(\) => cancelConfirm\(v\.id\)\}><span>Cancel<\/span><\/button>/);
});

test('pin: link sources picks from returned versions in a Popover; no id is typed; loaders never reject', () => {
  assert.match(passport, /<Popover kind="listbox" label=\{`Versions to link as sources of version \$\{shownVersion\.versionNo\}`\}/);
  assert.match(passport, /sourceChoices\(node\.artifactId, project\.id, candidates\.details, linked\)/);
  assert.doesNotMatch(passport, /<input|<textarea|contentEditable/);
  assert.equal((passport.match(/\} catch \{/g) || []).length, 2, 'both async loaders catch');
  assert.match(panel, /return <ArtifactPassport key=\{props\.node\.artifactId\} /);
});

test('pin: the Passport action styles use unique prefixes', () => {
  const css = fs.readFileSync(path.join(NEXUS, 'styles', 'platform.css'), 'utf8');
  for (const cls of ['nx-apx__acts', 'nx-apx__confirm', 'nx-apx__confirm-actions', 'nx-apx__link', 'nx-apx__status']) {
    assert.match(css, new RegExp(`\\.${cls}\\b`), cls);
    assert.match(passport, new RegExp(`className="${cls}"`), cls);
  }
});

// ---------- Task 11 fix round 1: lazy picker, focus, Escape ----------

test('pin: link candidates are read only after the picker was first opened, then refresh on rev', () => {
  assert.match(passport, /const \[pickerOpened, setPickerOpened\] = useState\(false\);/);
  assert.match(passport, /const candidates = useLinkCandidates\(linkable && pickerOpened, node\.artifactId, artifacts\);/);
  assert.match(passport, /onOpen=\{\(\) => setPickerOpened\(true\)\}/);
  assert.match(passport, /if \(!enabled\) \{ setState\(NO_CANDIDATES\); return; \}/);
  assert.match(passport, /\}, \[enabled, key, rev\]\);/);
  // Nothing about the candidates shows before the picker opened; inside it, a loading line until the read lands.
  assert.match(passport, /\{\(close\) => !candidates\.loaded \? \(\s*<p className="nx-muted nx-apx__pick-note" role="status">Reading versions to link…<\/p>/);
  assert.match(passport, /\{pickerOpened && candidates\.error && /);
  assert.match(passport, /\{pickerOpened && candidates\.capped && /);
  // The shared Popover reports opening, focuses items that arrive late, and closes on Escape from the trigger.
  const sheetUi = src('ui/Sheet.tsx');
  assert.match(sheetUi, /setOpen\(true\);\s*onOpen\?\.\(\);/);
  assert.match(sheetUi, /if \(!open \|\| pop\.current\?\.contains\(document\.activeElement\)\) return;/);
  assert.match(sheetUi, /\}, \[open, itemsKey\]\);/);
  assert.match(sheetUi, /else if \(e\.key === 'Escape' && open\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); close\(\); \}/);
});

test('pin: focus rests on the status line while an action runs and when it ends; Cancel returns it to the row', () => {
  assert.match(passport, /setActs\(next\);\s*requestFocus\('result'\);\s*const r = await send/);
  assert.match(passport, /setActs\(\(s\) => actionFailed\(s, actionFailureText\(kind, r\)\)\);\s*\}\s*requestFocus\('result'\);/);
  assert.match(passport, /if \(focusReq\.to === 'result'\) resultRef\.current\?\.focus\(\);/);
  assert.match(passport, /\{pending && <p ref=\{resultRef\} tabIndex=\{-1\} className="nx-apx__status" role="status">\{actionPendingText\(pending\.kind, /);
  assert.match(passport, /setActs\(\(s\) => cancelActionConfirm\(s\)\);\s*requestFocus\('row', versionId\);/);
  assert.match(passport, /rowActs\.current\.get\(focusReq\.versionId\)\?\.querySelector<HTMLButtonElement>\('button:not\(\[disabled\]\)'\)\?\.focus\(\)/);
  assert.equal(A.actionPendingText('markReady', 3), 'Marking version 3 ready…');
  assert.equal(A.actionPendingText('promote', 3), 'Making version 3 current…');
  assert.equal(A.actionPendingText('rollback', 1), 'Rolling back to version 1…');
  assert.equal(A.actionPendingText('discard', 4), 'Discarding version 4…');
  assert.equal(A.actionPendingText('link', 2), 'Linking a source to version 2…');
});

test('pin: Escape closes the inline confirmation while nothing is pending', () => {
  assert.match(passport, /role="group" aria-label=\{`\$\{actionLabel\(confirming\.kind, false\)\} version \$\{v\.versionNo\}`\} onKeyDown=\{onConfirmKey\(v\.id\)\}/);
  assert.match(passport, /if \(e\.key !== 'Escape' \|\| acts\.pending\) return;\s*e\.preventDefault\(\);\s*e\.stopPropagation\(\);\s*cancelConfirm\(versionId\);/);
  assert.match(passport, /const cancelConfirm = \(versionId: string\) => \{\s*if \(acts\.pending\) return;/);
});
