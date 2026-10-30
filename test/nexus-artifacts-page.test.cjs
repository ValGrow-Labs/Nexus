// test/nexus-artifacts-page.test.cjs
// Task 12: the Artifacts page. The pure model (filters and the request they make,
// sorting, the list read with paging, the empty-state choice, rows, the detail
// read) through load-ts; plus source pins on the .tsx files (no jsdom).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const M = loadTs('src/renderer/src/nexus/pages/artifactsPageModel.ts');
const { errorCopy } = loadTs('src/renderer/src/nexus/data/errorCopy.ts');

const NEXUS = path.join(__dirname, '..', 'src', 'renderer', 'src', 'nexus');
const src = (p) => fs.readFileSync(path.join(NEXUS, p), 'utf8');
const fail = (code, extra = {}) => ({ ok: false, code, message: 'm', ...extra });

const A1 = '01J9ZQ3V4K5M6N7P8Q9R0STVW1';
const A2 = '01J9ZQ3V4K5M6N7P8Q9R0STVW2';
const A3 = '01J9ZQ3V4K5M6N7P8Q9R0STVW3';
const V1 = '01J9ZQ3V4K5M6N7P8Q9R0STVV1';
const V2 = '01J9ZQ3V4K5M6N7P8Q9R0STVV2';
const V3 = '01J9ZQ3V4K5M6N7P8Q9R0STVV3';

function summary(id, o = {}) {
  return {
    artifact: {
      id, projectId: o.projectId ?? 'p1', kind: o.kind ?? 'git_commit', name: o.name ?? `Art ${id.slice(-1)}`, description: null,
      ownerScope: o.ownerWorkspaceId === null ? 'project' : 'participation', ownerParticipationId: o.ownerWorkspaceId === null ? null : 'PART-SECRET-ID',
      ownerWorkspaceId: o.ownerWorkspaceId === undefined ? 'sde' : o.ownerWorkspaceId,
      status: o.status ?? 'active', currentVersionId: o.current ? V1 : null, createdAt: 1, updatedAt: o.updatedAt ?? 100
    },
    versionCount: o.versionCount ?? 1,
    latest: o.latest === undefined ? { id: V1, versionNo: 1, status: 'draft' } : o.latest,
    current: o.current ?? null
  };
}
const NAMES = new Map([['p1', 'Invoice OCR'], ['p2', 'Web Shop']]);

// ---------- filters and the request ----------

test('listRequest sends only the keys a filter sets, in the shape main accepts', () => {
  assert.deepEqual(M.listRequest(M.NO_FILTERS, M.ARTIFACT_PAGE), { limit: 100 });
  const f = { projectId: 'p1', workspaceId: 'sde', kind: 'text_file', status: 'archived', sort: 'name' };
  assert.deepEqual(M.listRequest(f, 200), { limit: 200, projectId: 'p1', workspaceId: 'sde', kind: 'text_file', status: 'archived' });
  // Values that do not fit are left out, never sent.
  const bad = { projectId: '../x', workspaceId: 'SDE', kind: 'repository', status: 'deleted', sort: 'recent' };
  assert.deepEqual(M.listRequest(bad, 100), { limit: 100 });
  assert.equal(M.listRequest(M.NO_FILTERS, 9999).limit, M.ARTIFACT_LIST_MAX);
  assert.equal(M.listRequest(M.NO_FILTERS, -3).limit, M.ARTIFACT_PAGE);
  assert.equal(M.listRequest(M.NO_FILTERS, 1.5).limit, M.ARTIFACT_PAGE);
});

test('filtersActive and filterKey: sorting never narrows and never starts a new read', () => {
  assert.equal(M.filtersActive(M.NO_FILTERS), false);
  assert.equal(M.filtersActive({ ...M.NO_FILTERS, sort: 'name' }), false);
  for (const k of ['projectId', 'workspaceId', 'kind']) assert.equal(M.filtersActive({ ...M.NO_FILTERS, [k]: k === 'kind' ? 'git_commit' : k === 'workspaceId' ? 'ml' : 'p1' }), true, k);
  assert.equal(M.filtersActive({ ...M.NO_FILTERS, status: 'active' }), true);
  assert.equal(M.filterKey(M.NO_FILTERS), M.filterKey({ ...M.NO_FILTERS, sort: 'name' }));
  assert.notEqual(M.filterKey(M.NO_FILTERS), M.filterKey({ ...M.NO_FILTERS, kind: 'text_file' }));
  assert.deepEqual([...M.ARTIFACT_KINDS], ['git_commit', 'text_file', 'handoff_receipt']);
});

test('sort: recently changed first (id breaks ties), or by name', () => {
  const list = [
    summary(A1, { name: 'beta', updatedAt: 10 }),
    summary(A2, { name: 'Alpha', updatedAt: 30 }),
    summary(A3, { name: 'alpha', updatedAt: 10 })
  ];
  assert.deepEqual(M.sortedRows(list, NAMES, 'recent').map((r) => r.id), [A2, A3, A1]);
  assert.deepEqual(M.sortedRows(list, NAMES, 'name').map((r) => r.id), [A2, A3, A1]);
  const list2 = [summary(A1, { name: 'Zed', updatedAt: 50 }), summary(A2, { name: 'Ant', updatedAt: 1 })];
  assert.deepEqual(M.sortedRows(list2, NAMES, 'recent').map((r) => r.id), [A1, A2]);
  assert.deepEqual(M.sortedRows(list2, NAMES, 'name').map((r) => r.id), [A2, A1]);
  // The input is never reordered in place.
  assert.deepEqual(list2.map((s) => s.artifact.id), [A1, A2]);
  assert.deepEqual(M.projectChoices([{ id: 'b', name: 'web', rootPath: '/x' }, { id: 'a', name: 'Api' }]), [{ id: 'a', name: 'Api' }, { id: 'b', name: 'web' }]);
});

// ---------- rows ----------

test('rows: kind, workspace and version in words; a project missing from the list shows "Removed project"', () => {
  const r = M.artifactRow(summary(A1, { current: { id: V1, versionNo: 3 }, latest: { id: V1, versionNo: 3, status: 'active' } }), NAMES);
  assert.equal(r.kind, 'Saved version');
  assert.equal(r.project, 'Invoice OCR');
  assert.equal(r.projectKnown, true);
  assert.equal(r.workspace, 'Software');
  assert.equal(typeof r.hueSlot, 'number');
  assert.equal(r.version, 'Version 3, in use');
  assert.equal(r.archived, false);

  const gone = M.artifactRow(summary(A2, { projectId: 'gone', kind: 'text_file', latest: { id: V2, versionNo: 2, status: 'candidate' } }), NAMES);
  assert.equal(gone.project, 'Removed project');
  assert.equal(gone.project, M.REMOVED_PROJECT);
  assert.equal(gone.projectKnown, false);
  assert.equal(gone.kind, 'File');
  assert.equal(gone.version, 'Version 2, ready');
  // Before the project list is read, nothing is called removed.
  assert.equal(M.artifactRow(summary(A2, { projectId: 'gone' }), NAMES, false).project, '');
  assert.equal(M.sortedRows([summary(A2, { projectId: 'gone' })], NAMES, 'recent', false)[0].project, '');

  const none = M.artifactRow(summary(A3, { latest: null, versionCount: 0, status: 'archived', ownerWorkspaceId: null, kind: 'handoff_receipt' }), NAMES);
  assert.equal(none.version, 'No versions');
  assert.equal(none.archived, true);
  assert.equal(none.workspace, 'Whole project');
  assert.equal(none.hueSlot, null);
  assert.equal(none.kind, 'Received item');
  // An unknown workspace id reads as its id, without a hue.
  assert.equal(M.artifactRow(summary(A1, { ownerWorkspaceId: 'robotics' }), NAMES).workspace, 'robotics');
});

test('rows never carry a participation or principal id', () => {
  const row = M.artifactRow(summary(A1), NAMES);
  assert.deepEqual(Object.keys(row).sort(), ['archived', 'hueSlot', 'id', 'kind', 'name', 'project', 'projectKnown', 'updatedAt', 'version', 'workspace']);
  assert.doesNotMatch(JSON.stringify(row), /PART-SECRET-ID|principal|actor/i);
});

// ---------- the list read and paging ----------

const K = M.filterKey(M.NO_FILTERS);
const ok = (data, truncated) => ({ ok: true, data, ...(truncated ? { truncated: true } : {}) });

test('list read: success, truncated, stale keys, and a new key starting over', () => {
  let s = M.startListRead(M.NO_LIST, K);
  assert.equal(s.loading, true);
  assert.equal(s.loaded, false);
  s = M.nextArtifactList(s, K, ok([summary(A1)], true));
  assert.equal(s.loaded, true);
  assert.equal(s.loading, false);
  assert.equal(s.truncated, true);
  assert.equal(s.rows.length, 1);
  // "Show more" (same key) keeps the rows while it reads.
  const more = M.startListRead(s, K);
  assert.equal(more.rows.length, 1);
  assert.equal(more.loading, true);
  // An answer for another key changes nothing.
  assert.equal(M.nextArtifactList(more, 'other', ok([])), more);
  // A new filter starts over.
  const fresh = M.startListRead(s, 'other');
  assert.deepEqual(fresh.rows, []);
  assert.equal(fresh.loaded, false);
  assert.equal(fresh.key, 'other');
  // A non-array answer is read as empty.
  assert.deepEqual(M.nextArtifactList(M.startListRead(M.NO_LIST, K), K, ok(null)).rows, []);
});

test('list read: busy and internal keep the rows with a retry; refusals and unavailable show nothing stale', () => {
  const loaded = M.nextArtifactList(M.startListRead(M.NO_LIST, K), K, ok([summary(A1)]));
  const busy = M.nextArtifactList(M.startListRead(loaded, K), K, fail('platform_unavailable', { reason: 'busy' }));
  assert.equal(busy.rows.length, 1);
  assert.equal(busy.error, errorCopy('platform_unavailable', 'busy').text);
  assert.equal(busy.retry, true);
  assert.equal(busy.loading, false);
  const internal = M.nextArtifactList(M.startListRead(loaded, K), K, fail('internal'));
  assert.equal(internal.rows.length, 1);
  assert.equal(internal.retry, true);
  const invalid = M.nextArtifactList(M.startListRead(loaded, K), K, fail('invalid', { reason: 'bad_request' }));
  assert.deepEqual(invalid.rows, []);
  assert.equal(invalid.retry, false);
  assert.equal(invalid.error, errorCopy('invalid', 'bad_request').text);
  const off = M.nextArtifactList(M.startListRead(loaded, K), K, fail('platform_unavailable', { reason: 'held' }));
  assert.deepEqual(off.rows, []);
  assert.equal(off.unavailable, true);
  assert.equal(off.error, null);
});

test('paging: show more until the channel maximum, then say the list is capped', () => {
  assert.equal(M.ARTIFACT_PAGE, 100);
  assert.equal(M.ARTIFACT_LIST_MAX, 500);
  assert.equal(M.nextLimit(100), 200);
  assert.equal(M.nextLimit(450), 500);
  assert.equal(M.nextLimit(500), 500);
  assert.equal(M.pagingOf({ loaded: true, truncated: false }, 100), null);
  assert.equal(M.pagingOf({ loaded: false, truncated: true }, 100), null);
  assert.equal(M.pagingOf({ loaded: true, truncated: true }, 100), 'more');
  assert.equal(M.pagingOf({ loaded: true, truncated: true }, 400), 'more');
  assert.equal(M.pagingOf({ loaded: true, truncated: true }, 500), 'capped');
  assert.match(M.CAPPED_TEXT, /500 saved items changed most recently/);
});

// ---------- the empty-state choice ----------

test('the empty-state choice: loading, unavailable, error, empty, no match, rows', () => {
  const F = M.NO_FILTERS;
  const narrowed = { ...F, kind: 'text_file' };
  assert.deepEqual(M.listNotice(M.NO_LIST, F), { kind: 'loading' });
  assert.deepEqual(M.listNotice(M.startListRead(M.NO_LIST, K), F), { kind: 'loading' });
  const empty = M.nextArtifactList(M.startListRead(M.NO_LIST, K), K, ok([]));
  assert.deepEqual(M.listNotice(empty, F), { kind: 'empty' });
  assert.deepEqual(M.listNotice(empty, { ...F, sort: 'name' }), { kind: 'empty' });
  assert.deepEqual(M.listNotice(empty, narrowed), { kind: 'no-match' });
  const off = M.nextArtifactList(M.startListRead(M.NO_LIST, K), K, fail('platform_unavailable', { reason: 'held' }));
  assert.deepEqual(M.listNotice(off, F), { kind: 'unavailable' }, 'never "no artifacts yet" while the platform is off');
  const busy = M.nextArtifactList(M.startListRead(M.NO_LIST, K), K, fail('platform_unavailable', { reason: 'busy' }));
  assert.deepEqual(M.listNotice(busy, F), { kind: 'error', text: errorCopy('platform_unavailable', 'busy').text, retry: true });
  const internal = M.nextArtifactList(M.startListRead(M.NO_LIST, K), K, fail('internal'));
  assert.deepEqual(M.listNotice(internal, F), { kind: 'error', text: errorCopy('internal').text, retry: true });
  const denied = M.nextArtifactList(M.startListRead(M.NO_LIST, K), K, fail('denied'));
  assert.deepEqual(M.listNotice(denied, F), { kind: 'error', text: errorCopy('denied').text, retry: false });
  const rows = M.nextArtifactList(M.startListRead(M.NO_LIST, K), K, ok([summary(A1)]));
  assert.equal(M.listNotice(rows, F), null);
  assert.equal(M.staleError(rows), null);
  // A passing failure over shown rows: the rows stay, with one line above them.
  const staleBusy = M.nextArtifactList(M.startListRead(rows, K), K, fail('internal'));
  assert.equal(M.listNotice(staleBusy, F), null);
  assert.deepEqual(M.staleError(staleBusy), { text: errorCopy('internal').text, retry: true });
  assert.equal(`${M.EMPTY_TITLE}. ${M.EMPTY_BODY}`, 'No saved items yet. Saved items are the things your projects make or keep: notes, builds, suggested changes. Open a project and press "Add a file to saved items" in its details to keep your first one.');
  assert.doesNotMatch(`${M.EMPTY_TITLE} ${M.EMPTY_BODY} ${M.NO_MATCH_TEXT} ${M.MISSING_TITLE} ${M.MISSING_BODY} ${M.CAPPED_TEXT}`, /artifact|passport|commit/i, 'the page says saved items, never artifact, passport or commit');
});

// ---------- the detail read ----------

function detail(o = {}) {
  const versions = o.versions ?? [
    { id: V1, versionNo: 1, status: 'deprecated' },
    { id: V2, versionNo: 2, status: 'active' },
    { id: V3, versionNo: 3, status: 'draft' }
  ];
  return { artifact: { ...summary(A1).artifact, currentVersionId: o.current === undefined ? V2 : o.current }, versions };
}

test('detail read: ready, not found, unavailable, refusals, passing failures, stale ids', () => {
  const L = M.detailLoading(A1);
  assert.equal(L.status, 'loading');
  const ready = M.nextDetail(L, A1, ok(detail()));
  assert.equal(ready.status, 'ready');
  assert.equal(ready.detail.artifact.id, A1);
  assert.equal(M.nextDetail(L, A1, fail('not_found')).status, 'missing');
  assert.equal(M.nextDetail(ready, A1, fail('not_found')).detail, null, 'a removed artifact is not kept on screen');
  assert.equal(M.nextDetail(L, A1, fail('platform_unavailable', { reason: 'held' })).status, 'unavailable');
  const denied = M.nextDetail(L, A1, fail('denied'));
  assert.deepEqual([denied.status, denied.error, denied.retry], ['error', errorCopy('denied').text, false]);
  const busyFirst = M.nextDetail(L, A1, fail('platform_unavailable', { reason: 'busy' }));
  assert.deepEqual([busyFirst.status, busyFirst.retry], ['error', true]);
  const busyLater = M.nextDetail(ready, A1, fail('internal'));
  assert.deepEqual([busyLater.status, busyLater.retry, busyLater.detail.artifact.id], ['ready', true, A1]);
  assert.equal(busyLater.error, errorCopy('internal').text);
  // Another id's answer changes nothing; a malformed answer is an internal failure.
  assert.equal(M.nextDetail(L, A2, ok(detail())), L);
  assert.equal(M.nextDetail(M.detailLoading(A2), A2, ok(detail())).status, 'error');
  assert.equal(M.MISSING_TITLE, 'Saved item not found');
});

test('detailNode: the current version, else the newest, else version 0', () => {
  const n = M.detailNode(detail());
  assert.deepEqual(n, { kind: 'artifact', id: `artifact:${A1}`, artifactId: A1, artifactKind: 'git_commit', name: 'Art 1', versionNo: 2, status: 'active', isCurrent: true });
  const noCurrent = M.detailNode(detail({ current: null }));
  assert.deepEqual([noCurrent.versionNo, noCurrent.status, noCurrent.isCurrent], [3, 'draft', false]);
  const none = M.detailNode(detail({ current: null, versions: [] }));
  assert.deepEqual([none.versionNo, none.isCurrent], [0, false]);
});

// ---------- source pins ----------

const page = src('pages/ArtifactsPage.tsx');
const hook = src('data/useArtifacts.ts');

test('pin: the page reads through its hooks only and reuses the artifact Passport', () => {
  assert.doesNotMatch(page, /nexusClient|window\.cth/, 'the page itself makes no IPC call');
  assert.match(page, /import \{ ArtifactPassport \} from '\.\.\/project\/ArtifactPassport';/);
  assert.match(page, /<ArtifactPassport key=\{detail\.artifact\.id\} project=\{\{ id: projectId, rootPath: project \? project\.rootPath : '' \}\} node=\{node\} artifacts=\{summaries\.artifacts\} onSpine=\{false\}\s*onHandOff=\{canWrite \? setHandoffStart : undefined\} \/>/);
  assert.doesNotMatch(page, /versionMarkReady|versionPromote|versionDiscard|versionLinkSources/, 'version actions stay inside the Passport, gated there');
  // Task 13: the page hosts the send sheet the Passport's "Hand off…" opens, only while writes are on.
  assert.match(page, /\{handoffStart && canWrite && <SendHandoffSheet start=\{handoffStart\} artifacts=\{summaries\.artifacts\} onClose=\{\(\) => setHandoffStart\(null\)\} \/>\}/);
  assert.match(page, /const summaries = useProjectArtifacts\(projectId\);/);
  assert.match(page, /navigate\(\{ name: 'project', id: project\.id, tool: 'bench' \}\)\}>Open project<\/Button>/);
  assert.match(page, /navigate\(\{ name: 'artifacts', id: r\.id \}\)/);
  assert.doesNotMatch(page, /ownerParticipationId|principal|actorId|JSON\.stringify/);
});

test('pin: empty, unavailable, error and not-found states', () => {
  assert.match(page, /<EmptyState level=\{2\} icon="artifacts" title=\{EMPTY_TITLE\} body=\{EMPTY_BODY\}\s*actions=\{<Button variant="primary" icon="projects" onClick=\{\(\) => navigate\(\{ name: 'projects' \}\)\}>Open your projects<\/Button>\} \/>/);
  assert.match(page, /<PlatformNotice \/>/);
  // The PlatformNotice alone explains an unavailable platform: no second sentence under it.
  assert.doesNotMatch(page, /UNAVAILABLE_LIST_TEXT|notice\?\.kind === 'unavailable' &&/);
  assert.equal(M.UNAVAILABLE_LIST_TEXT, undefined);
  assert.match(page, /\{notice\.retry && <Button variant="quiet" icon="refresh" onClick=\{list\.reload\}>Try again<\/Button>\}/);
  assert.match(page, /\{stale\.retry && <Button variant="quiet" icon="refresh" onClick=\{list\.reload\}>Try again<\/Button>\}/);
  assert.match(page, /\{d\.retry && <Button variant="quiet" icon="refresh" onClick=\{d\.reload\}>Try again<\/Button>\}/);
  assert.match(page, /d\.status === 'missing' && <EmptyState level=\{2\} icon="artifacts" title=\{MISSING_TITLE\} body=\{MISSING_BODY\} \/>/);
  assert.match(page, /NO_MATCH_TEXT/);
  assert.match(page, /CAPPED_TEXT/);
});

test('pin: filters for project, workspace, kind and status, plus sort; paging keeps focus', () => {
  for (const label of ['Project', 'Workspace', 'Type', 'Archived or not', 'Sort']) assert.match(page, new RegExp(`aria-label="${label}"`), label);
  assert.match(page, /const list = useArtifactList\(filters\);/);
  assert.match(page, /\{paging === 'more' && <Button onClick=\{showMore\}>/);
  assert.match(page, /if \(paging !== 'more'\) countRef\.current\?\.focus\(\);/);
  assert.match(page, /<p ref=\{countRef\} tabIndex=\{-1\} className="nx-muted nx-afx__count" role="status">/);
  assert.match(page, /<ArtifactDetailPane key=\{id\} id=\{id\}/);
});

test('pin: the hooks guard stale answers, reload on rev and mode, and never reject', () => {
  assert.match(hook, /const r = await nexusClient\.artifactsList\(request\);\s*if \(mine !== seq\.current\) return;/);
  assert.match(hook, /const r = await nexusClient\.artifactGet\(id\);\s*if \(mine !== seq\.current\) return;/);
  assert.equal((hook.match(/\} catch \{/g) || []).length, 2, 'both loaders catch');
  assert.match(hook, /\}, \[key, limit, rev, mode, attempt\]\);/);
  assert.match(hook, /\}, \[id, rev, mode, attempt\]\);/);
  assert.doesNotMatch(hook, /\.then\(/);
  assert.match(hook, /const limit = paging\.key === key \? paging\.limit : ARTIFACT_PAGE;/, 'a new filter starts from the first page');
  assert.match(hook, /return \{ \.\.\.\(state\.id === id \? state : detailLoading\(id\)\), reload \};/);
  assert.doesNotMatch(hook, /versionMarkReady|versionPromote|versionDiscard|versionLinkSources|artifactSave/);
});

test('pin: routing, the Passport outside the Spine, and the styles', () => {
  const view = src('routes/RouteView.tsx');
  assert.match(view, /case 'artifacts': page = <ArtifactsPage id=\{route\.id \?\? null\} \/>; break;/);
  // Task 13: Handoffs is real; only Deployments stays planned.
  assert.match(view, /case 'handoffs': page = <HandoffsPage id=\{route\.id \?\? null\} \/>; break;/);
  assert.match(view, /case 'deployments': page = <PlannedPage which="deployments" \/>; break;/);
  const planned = loadTs('src/renderer/src/nexus/pages/plannedContent.ts').PLANNED;
  assert.deepEqual(Object.keys(planned), ['deployments']);
  const passport = src('project/ArtifactPassport.tsx');
  assert.match(passport, /\{row\.shown && !row\.current \? \(onSpine \? ', shown on the timeline' : ', shown here'\) : ''\}/);
  assert.match(passport, /if \(rootPath && \[\.\.\.contents\.values\(\)\]\.some\(\(c\) => c\.type === 'git'\)\)/, 'no git read without a project folder');
  const css = src('styles/platform.css');
  for (const cls of ['nx-afx', 'nx-afx__list', 'nx-afx__rows', 'nx-afx__row', 'nx-afx__detail', 'nx-afx__pane', 'nx-afx__bar', 'nx-afx__line', 'nx-afx__count']) {
    assert.match(css, new RegExp(`\\.${cls}[\\s\\[{:.>]`), cls);
  }
  const tokens = src('styles/tokens.css');
  for (const v of new Set(css.match(/var\(--nx-[a-z0-9-]+\)/g) || [])) assert.ok(tokens.includes(`${v.slice(4, -1)}:`), v);
  // The bench hides only its own inline Passport on narrow screens, so the page's detail pane stays visible.
  const project = src('styles/project.css');
  assert.match(project, /\.nx-bench > \.nx-passport \{ display: none; \}/);
  assert.doesNotMatch(project, /^\s*\.nx-passport \{ display: none; \}/m);
});
