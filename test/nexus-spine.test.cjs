// test/nexus-spine.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { buildSpine, nodeLabel } = loadTs('src/renderer/src/nexus/project/spineModel.ts');
const ready = (o) => ({ status: 'ready', isRepo: true, branch: 'main', head: { sha: 'abc1234def', shortSha: 'abc1234', subject: 'Fix totals parser', time: 1 }, changed: [], ...o });
const nodes = (g) => g.flatMap((x) => x.nodes);
const { legacyIndex, fromRows } = loadTs('src/renderer/src/nexus/workspaces/participation.ts');
// The group source is the participation index; a one-project legacy index keeps the domain-based expectations.
const spine = ({ domainId, git }) => buildSpine({ idx: legacyIndex([{ id: 'p', domainId }]), projectId: 'p', git, artifacts: [] });

test('clean git repo: one source node, no changes node, no artifacts', () => {
  const g = spine({ domainId: 'ai-ml', git: ready({}) });
  assert.equal(g.length, 1);
  assert.equal(g[0].workspaceId, 'ml');
  assert.equal(g[0].hueSlot, 1);
  assert.deepEqual(nodes(g).map((n) => n.kind), ['source']);
  assert.equal(nodes(g)[0].vcs, 'git');
});

test('dirty repo: changes node carries the real count', () => {
  const g = spine({ domainId: 'ai-ml', git: ready({ changed: [{ path: 'a.py', kind: 'modified' }, { path: 'b.py', kind: 'untracked' }] }) });
  assert.deepEqual(nodes(g).map((n) => n.kind), ['source', 'changes']);
  assert.equal(nodes(g)[1].fileCount, 2);
});

test('non-git folder: plain folder node, never a changes node', () => {
  const g = spine({ domainId: 'ai-ml', git: { status: 'ready', isRepo: false, branch: null, head: null, changed: [] } });
  assert.deepEqual(nodes(g).map((n) => [n.kind, n.vcs]), [['source', 'none']]);
});

test('loading: source node with unknown vcs', () => {
  const g = spine({ domainId: 'ai-ml', git: { status: 'loading' } });
  assert.deepEqual(nodes(g).map((n) => [n.kind, n.vcs]), [['source', 'unknown']]);
});

test('unassigned domain: neutral group', () => {
  const g = spine({ domainId: 'cybersecurity', git: ready({}) });
  assert.deepEqual([g[0].workspaceId, g[0].label, g[0].hueSlot], ['unassigned', 'Unassigned', null]);
});

test('the source group follows the database primary, not the domain', () => {
  const row = (workspaceId, isPrimary, status = 'active') => ({ id: workspaceId, projectId: 'p', workspaceId, status, isPrimary, source: 'user' });
  const g = buildSpine({ idx: fromRows([row('qa', false), row('dl', true)]), projectId: 'p', git: ready({}), artifacts: [] });
  // The attached qa participation is real, so it has its own (empty) group after the primary (SP3).
  assert.deepEqual([g.length, g[0].workspaceId, g[0].label, g[0].hueSlot], [2, 'dl', 'Deep learning', 2]);
  assert.deepEqual(g[0].nodes.map((n) => n.kind), ['source']);
  const none = buildSpine({ idx: fromRows([row('qa', false)]), projectId: 'p', git: ready({}), artifacts: [] });
  assert.deepEqual(none[0].nodes.map((n) => n.kind), ['source']);
  assert.deepEqual([none[0].workspaceId, none[0].label, none[0].hueSlot], ['unassigned', 'Unassigned', null]);
});

test('labels describe real state only', () => {
  const [src] = nodes(spine({ domainId: 'ai-ml', git: ready({}) }));
  assert.equal(nodeLabel(src), 'Your project, line of work main, last saved version abc1234 Fix totals parser');
  const [folder] = nodes(spine({ domainId: 'ai-ml', git: { status: 'ready', isRepo: false, branch: null, head: null, changed: [] } }));
  assert.equal(nodeLabel(folder), 'Project folder, not set up with Git');
  const g = spine({ domainId: 'ai-ml', git: ready({ changed: [{ path: 'a', kind: 'modified' }] }) });
  assert.equal(nodeLabel(nodes(g)[1]), 'Changes not saved yet, 1 file');
});

const { tabStopId, kindOf } = loadTs('src/renderer/src/nexus/project/spineModel.ts');

test('tabStopId: selected present, missing, empty', () => {
  assert.equal(tabStopId(['source', 'changes'], 'changes'), 'changes');
  assert.equal(tabStopId(['source', 'changes'], 'nope'), 'source');
  assert.equal(tabStopId([], 'source'), null);
});

test('error state: distinguishable and honest label', () => {
  const [n] = nodes(spine({ domainId: 'ai-ml', git: { status: 'error', message: 'boom' } }));
  assert.equal(n.vcs, 'error');
  assert.equal(nodeLabel(n), 'Project folder, its changes cannot be read');
  const [l] = nodes(spine({ domainId: 'ai-ml', git: { status: 'loading' } }));
  assert.equal(nodeLabel(l), 'Project folder, reading its changes');
});

test('kindOf maps porcelain columns', () => {
  assert.equal(kindOf(' ', 'M'), 'modified');
  assert.equal(kindOf('M', ' '), 'modified');
  assert.equal(kindOf('A', ' '), 'added');
  assert.equal(kindOf('A', 'M'), 'added');
  assert.equal(kindOf('D', ' '), 'deleted');
  assert.equal(kindOf(' ', 'D'), 'deleted');
  assert.equal(kindOf('R', ' '), 'renamed');
});

// ---------- Task 10: artifact nodes from real versions ----------

const { hasArtifactNodes } = loadTs('src/renderer/src/nexus/project/spineModel.ts');
const { kindLabel } = loadTs('src/renderer/src/nexus/project/artifactModel.ts');
const prow = (id, workspaceId, isPrimary, status = 'active') => ({ id, projectId: 'p', workspaceId, status, isPrimary, source: 'user' });
let seq = 0;
const summary = ({ id, name = 'Release', kind = 'git_commit', part = 'P-SDE', ws = 'sde', createdAt, status = 'active', current = null, latest = { id: `${id}-v1`, versionNo: 1, status: 'draft' } }) => ({
  artifact: { id, projectId: 'p', kind, name, description: null, ownerScope: 'participation', ownerParticipationId: part, ownerWorkspaceId: ws,
    status, currentVersionId: current ? current.id : null, createdAt: createdAt ?? ++seq, updatedAt: 1 },
  versionCount: 1, latest, current
});
const DBX = fromRows([prow('P-SDE', 'sde', true), prow('P-QA', 'qa', false), prow('P-DL', 'dl', false, 'withdrawn')]);

test('SP1: no artifacts and no attachments gives exactly the previous output', () => {
  const git = ready({ changed: [{ path: 'a.py', kind: 'modified' }] });
  const g = buildSpine({ idx: legacyIndex([{ id: 'p', domainId: 'ai-ml' }]), projectId: 'p', git, artifacts: [] });
  assert.deepEqual(g, [{ workspaceId: 'ml', label: 'Machine learning', hueSlot: 1, nodes: [
    { kind: 'source', id: 'source', vcs: 'git', branch: 'main', head: { shortSha: 'abc1234', subject: 'Fix totals parser' } },
    { kind: 'changes', id: 'changes', fileCount: 1 }
  ] }]);
  const db = buildSpine({ idx: fromRows([prow('P-ML', 'ml', true)]), projectId: 'p', git, artifacts: [] });
  assert.deepEqual(db, g);
  assert.equal(hasArtifactNodes(g), false);
});

test('SP2: artifacts group by owner workspace, primary first; source and changes stay in the primary', () => {
  const g = buildSpine({ idx: DBX, projectId: 'p', git: ready({ changed: [{ path: 'a', kind: 'added' }] }), artifacts: [
    summary({ id: 'A2', name: 'QA notes', kind: 'text_file', part: 'P-QA', ws: 'qa', createdAt: 5 }),
    summary({ id: 'A1', name: 'Release', part: 'P-SDE', createdAt: 3 }),
    summary({ id: 'A3', name: 'Later', part: 'P-SDE', createdAt: 9 })
  ] });
  assert.deepEqual(g.map((x) => x.workspaceId), ['sde', 'qa']);
  assert.deepEqual(g[0].nodes.map((n) => n.id), ['source', 'changes', 'artifact:A1', 'artifact:A3'], 'creation order');
  assert.deepEqual(g[1].nodes.map((n) => n.id), ['artifact:A2']);
  assert.equal(hasArtifactNodes(g), true);
  assert.deepEqual(g[0].nodes[2], { kind: 'artifact', id: 'artifact:A1', artifactId: 'A1', artifactKind: 'git_commit', name: 'Release', versionNo: 1, status: 'draft', isCurrent: false });
});

test('SP3: an attached participation with no artifacts still shows its label, with no nodes', () => {
  const g = buildSpine({ idx: DBX, projectId: 'p', git: ready({}), artifacts: [] });
  assert.deepEqual(g.map((x) => [x.workspaceId, x.label, x.nodes.length]), [['sde', 'Software', 1], ['qa', 'Testing', 0]]);
  assert.ok(g.every((x) => !('muted' in x)), 'active groups are not muted');
});

test('SP4: a withdrawn participation that owns artifacts gives a muted group labelled withdrawn; without artifacts, none', () => {
  const g = buildSpine({ idx: DBX, projectId: 'p', git: ready({}), artifacts: [summary({ id: 'D1', name: 'Model card', kind: 'text_file', part: 'P-DL', ws: 'dl' })] });
  assert.deepEqual(g.map((x) => [x.workspaceId, x.muted ?? null]), [['sde', null], ['qa', null], ['dl', 'withdrawn']]);
  assert.deepEqual(g[2].nodes.map((n) => n.id), ['artifact:D1']);
  assert.equal(g[2].label, 'Deep learning');
});

test('SP5: a node shows the current version when there is one, else the latest; archived or versionless artifacts are not shown', () => {
  const g = buildSpine({ idx: DBX, projectId: 'p', git: ready({}), artifacts: [
    summary({ id: 'C1', current: { id: 'C1-v2', versionNo: 2 }, latest: { id: 'C1-v3', versionNo: 3, status: 'candidate' } }),
    summary({ id: 'C2', latest: { id: 'C2-v4', versionNo: 4, status: 'candidate' } }),
    summary({ id: 'C3', status: 'archived', current: { id: 'C3-v1', versionNo: 1 } }),
    summary({ id: 'C4', latest: null })
  ] });
  const arts = g[0].nodes.filter((n) => n.kind === 'artifact');
  assert.deepEqual(arts.map((n) => [n.artifactId, n.versionNo, n.status, n.isCurrent]), [['C1', 2, 'active', true], ['C2', 4, 'candidate', false]]);
});

test('SP6: a receipt node has the kind label "Received item"', () => {
  const g = buildSpine({ idx: DBX, projectId: 'p', git: ready({}), artifacts: [summary({ id: 'R1', name: 'From SDE', kind: 'handoff_receipt', part: 'P-QA', ws: 'qa', current: { id: 'R1-v1', versionNo: 1 } })] });
  const r = g[1].nodes[0];
  assert.equal(kindLabel(r.artifactKind), 'Received item');
  assert.equal(nodeLabel(r), 'Received item From SDE, version 1, in use');
});

test('SP7: nodeLabel for an artifact reads "Saved version Release, version 2, in use"', () => {
  const g = buildSpine({ idx: DBX, projectId: 'p', git: ready({}), artifacts: [summary({ id: 'X', name: 'Release', current: { id: 'X-v2', versionNo: 2 } })] });
  assert.equal(nodeLabel(g[0].nodes[1]), 'Saved version Release, version 2, in use');
});

test('artifacts with no owner participation go to the lead group; legacy mode keeps one group', () => {
  const projectOwned = summary({ id: 'P1', part: null, ws: null });
  projectOwned.artifact.ownerScope = 'project';
  const g = buildSpine({ idx: DBX, projectId: 'p', git: ready({}), artifacts: [projectOwned] });
  assert.deepEqual(g[0].nodes.map((n) => n.id), ['source', 'artifact:P1']);
  const legacy = buildSpine({ idx: legacyIndex([{ id: 'p', domainId: 'web-app-dev' }]), projectId: 'p', git: ready({}), artifacts: [summary({ id: 'L1' })] });
  assert.deepEqual(legacy.map((x) => [x.workspaceId, x.nodes.map((n) => n.id)]), [['sde', ['source', 'artifact:L1']]]);
});

// ---------- source pins (no jsdom) ----------
const fs = require('node:fs');
const path = require('node:path');
const NEXUS = path.join(__dirname, '..', 'src', 'renderer', 'src', 'nexus');
const read = (p) => fs.readFileSync(path.join(NEXUS, p), 'utf8');

test('pin: the Spine renders artifact nodes from the model, drafts dashed, status in words, the placeholder only while empty', () => {
  const s = read('project/Spine.tsx');
  assert.match(s, /\{line\?\.kind === 'empty' && <p className="nx-spine__future">Nothing has been saved yet\. Items your project makes will show up here, in order\.<\/p>\}/);
  assert.equal((s.match(/will show up here, in order/g) || []).length, 1, 'the placeholder renders in one branch only');
  assert.match(s, /n\.status === 'draft' \? ' nx-node--draft' : ''/);
  assert.match(s, /\{kindLabel\(n\.artifactKind\)\} · \{statusLabel\(n\.status\)\}/);
  assert.match(s, /v\{n\.versionNo\}/);
  assert.match(s, /g\.muted && <span className="nx-spx-state">\{MUTED_WORD\[g\.muted\]\}<\/span>/);
  assert.match(s, /\{ withdrawn: 'removed', complete: 'closed' \}/, 'a muted group says removed or closed, never the raw state word');
  // The source and changes nodes render as before.
  assert.match(s, /\{n\.kind === 'changes' \? 'not saved yet' : n\.vcs === 'git' \? 'your project' : 'folder'\}/);
  assert.match(s, /aria-label="Project timeline"/, 'the spine is called the timeline for people');
  assert.match(s, /\{n\.kind === 'source' && n\.head && <span className="nx-node__v nx-id">\{n\.head\.shortSha\}<\/span>\}/);
  assert.match(s, /className=\{`nx-node\$\{n\.kind === 'changes' \? ' nx-node--draft' : ''\}`\}/);
});

test('pin: the bench loads the project artifacts and keeps an artifact selection on the bench tool', () => {
  const bench = read('project/ProjectBench.tsx');
  assert.match(bench, /const \{ artifacts, loaded: artifactsLoaded, error: artifactsError, retry: artifactsRetry, truncated: artifactsTruncated, reload: reloadArtifacts \} = useProjectArtifacts\(project\.id\);/);
  assert.match(bench, /buildSpine\(\{ idx, projectId: project\.id, git, artifacts \}\)/);
  assert.match(bench, /setSelected\(\(s\) => \(s === 'changes' \? 'source' : s\)\)/);
  assert.match(bench, /setSelected\(`artifact:\$\{artifactId\}`\)/);
  assert.match(bench, /\{saveSource && canWrite && \(/);
  assert.match(bench, /const onSave = canWrite \? openSave : undefined;/);
  const hook = read('data/useProjectArtifacts.ts');
  assert.match(hook, /nexusClient\.artifactsByProject\(projectId\)/);
  assert.match(hook, /if \(mine !== seq\.current\) return;/);
});

// ---------- Fix round 1: the line under the spine follows the artifacts read ----------

const { spineLine } = loadTs('src/renderer/src/nexus/project/spineModel.ts');

test('spineLine: before the first answer a neutral loading line, never the placeholder', () => {
  const g = buildSpine({ idx: DBX, projectId: 'p', git: ready({}), artifacts: [] });
  assert.deepEqual(spineLine({ loaded: false, error: null, retry: false }, g), { kind: 'loading' });
});

test('spineLine: the placeholder only once loaded, with no error and no artifact node', () => {
  const empty = buildSpine({ idx: DBX, projectId: 'p', git: ready({}), artifacts: [] });
  assert.deepEqual(spineLine({ loaded: true, error: null, retry: false }, empty), { kind: 'empty' });
  const full = buildSpine({ idx: DBX, projectId: 'p', git: ready({}), artifacts: [summary({ id: 'F1' })] });
  assert.equal(spineLine({ loaded: true, error: null, retry: false }, full), null);
});

test('spineLine: a failed read shows its sentence (with retry when it can help), never the placeholder', () => {
  const empty = buildSpine({ idx: DBX, projectId: 'p', git: ready({}), artifacts: [] });
  assert.deepEqual(spineLine({ loaded: true, error: 'The database is busy.', retry: true }, empty), { kind: 'error', text: 'The database is busy.', retry: true });
  // not_found / denied emptied the list: still the error, not "no artifacts".
  assert.deepEqual(spineLine({ loaded: true, error: 'gone', retry: false }, empty), { kind: 'error', text: 'gone', retry: false });
  // A busy re-read that kept the old nodes still says the read failed.
  const full = buildSpine({ idx: DBX, projectId: 'p', git: ready({}), artifacts: [summary({ id: 'F2' })] });
  assert.equal(spineLine({ loaded: true, error: 'busy', retry: true }, full).kind, 'error');
});

test('spineLine end to end with nextArtifacts: initial, busy, internal, not_found, denied, unavailable, ok', () => {
  const { nextArtifacts, NO_ARTIFACTS } = loadTs('src/renderer/src/nexus/project/artifactModel.ts');
  const { errorCopy } = loadTs('src/renderer/src/nexus/data/errorCopy.ts');
  const lineFor = (st) => spineLine(st, buildSpine({ idx: DBX, projectId: 'p', git: ready({}), artifacts: st.artifacts }));
  const f = (code, extra = {}) => ({ ok: false, code, message: 'm', ...extra });
  assert.deepEqual(lineFor(NO_ARTIFACTS), { kind: 'loading' });
  assert.deepEqual(lineFor(nextArtifacts(NO_ARTIFACTS, f('platform_unavailable', { reason: 'busy' }))), { kind: 'error', text: errorCopy('platform_unavailable', 'busy').text, retry: true });
  assert.deepEqual(lineFor(nextArtifacts(NO_ARTIFACTS, f('internal'))), { kind: 'error', text: errorCopy('internal').text, retry: true });
  assert.deepEqual(lineFor(nextArtifacts(NO_ARTIFACTS, f('not_found'))), { kind: 'error', text: errorCopy('not_found').text, retry: false });
  assert.deepEqual(lineFor(nextArtifacts(NO_ARTIFACTS, f('denied'))), { kind: 'error', text: errorCopy('denied').text, retry: false });
  assert.deepEqual(lineFor(nextArtifacts(NO_ARTIFACTS, { ok: true, data: [] })), { kind: 'empty' });
  assert.equal(lineFor(nextArtifacts(NO_ARTIFACTS, { ok: true, data: [summary({ id: 'F3' })] })), null);
});

test('pin: the Spine draws the loading and error lines, Try again re-runs the read, and a saved node gets focus', () => {
  const s = read('project/Spine.tsx');
  assert.match(s, /\{line\?\.kind === 'loading' && <p className="nx-spine__future" role="status">Reading your saved items…<\/p>\}/);
  assert.match(s, /line\?\.kind === 'error' && \(\s*<p className="nx-spine__future nx-spx-line" role="status">\s*<span>\{line\.text\}<\/span>/);
  assert.match(s, /\{line\.retry && <button type="button" className="nx-btn nx-btn--quiet" onClick=\{onRetryLine\}><span>Try again<\/span><\/button>\}/);
  assert.match(s, /const el = refs\.current\.get\(focusRequest\);\s*if \(el && el\.isConnected\) \{ el\.focus\(\); onFocused\?\.\(\); \}/);
  const bench = read('project/ProjectBench.tsx');
  assert.match(bench, /const line = spineLine\(\{ loaded: artifactsLoaded, error: artifactsError, retry: artifactsRetry \}, groups\);/);
  assert.match(bench, /line=\{line\} onRetryLine=\{reloadArtifacts\} truncated=\{artifactsTruncated\} focusRequest=\{focusRequest\} onFocused=\{focused\}/);
  assert.match(s, /\{truncated && <p className="nx-spine__future" role="status">\{SPINE_TRUNCATED_TEXT\}<\/p>\}/);
  assert.match(bench, /setSelected\(`artifact:\$\{artifactId\}`\);[\s\S]*?setFocusRequest\(`artifact:\$\{artifactId\}`\);/);
  const hook = read('data/useProjectArtifacts.ts');
  assert.match(hook, /\[projectId, rev, mode, attempt\]/);
  assert.match(hook, /return \{ \.\.\.state, reload \};/);
});

test('pin: the artifact Passport loader catches a throw and shows the internal sentence while mounted', () => {
  const s = read('project/ArtifactPassport.tsx');
  assert.match(s, /void \(async \(\) => \{\s*try \{/);
  assert.match(s, /\} catch \{[\s\S]*?if \(alive\) setState\(\(s\) => \(\{ loaded: s\.loaded, error: errorCopy\('internal'\)\.text \}\)\);/);
});
