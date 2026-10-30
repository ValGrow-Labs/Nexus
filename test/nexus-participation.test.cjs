// test/nexus-participation.test.cjs
// The pure participation model every screen reads (Task 8, R1-R7, R9, R10).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const M = loadTs('src/renderer/src/nexus/workspaces/participation.ts');
const { WORKSPACES } = loadTs('src/renderer/src/nexus/workspaces/registry.ts');
const { buildWorkspaceIndex } = loadTs('src/renderer/src/nexus/pages/workspaceIndex.ts');
const { pathSegments } = loadTs('src/renderer/src/nexus/chrome/navItems.ts');

const ROOT = path.join(__dirname, '..');
const NEXUS = path.join(ROOT, 'src', 'renderer', 'src', 'nexus');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const rel = (f) => path.relative(NEXUS, f).split(path.sep).join('/');

const P = [{ id: 'a', domainId: 'ai-ml' }, { id: 'b', domainId: 'cybersecurity' }, { id: 'c', domainId: 'web-app-dev' }];
const row = (id, projectId, workspaceId, isPrimary, status = 'active') => ({ id, projectId, workspaceId, status, isPrimary, source: 'user' });

test('R1 parity: without attachments, the DB index equals the legacy derivation', () => {
  const db = M.fromRows([row('1', 'a', 'ml', true), row('2', 'c', 'sde', true)]); const legacy = M.legacyIndex(P);
  for (const p of P) assert.equal(M.primaryOf(db, p.id)?.id ?? null, M.primaryOf(legacy, p.id)?.id ?? null, p.id);
  assert.deepEqual(M.countsByWorkspace(db, P), M.countsByWorkspace(legacy, P));
  assert.equal(M.unassignedCount(db, P), 1);
  assert.equal(M.unassignedCount(legacy, P), 1);
  assert.equal(db.mode, 'db');
  assert.equal(legacy.mode, 'legacy');
  for (const ws of WORKSPACES) {
    assert.deepEqual(M.projectsInWorkspace(db, P, ws.id), M.projectsInWorkspace(legacy, P, ws.id), ws.id);
  }
});

test('R2 a project with no rows is Unassigned', () => {
  const idx = M.fromRows([row('1', 'a', 'ml', true)]);
  assert.equal(M.primaryOf(idx, 'c'), null);
  assert.equal(M.primaryViewOf(idx, 'c'), null);
  assert.deepEqual(M.activeWorkspacesOf(idx, 'c'), []);
  assert.equal(M.unassignedCount(idx, P), 2);
  // Unassigned is "no primary", not "no rows": an attached-only project is Unassigned too.
  const attachedOnly = M.fromRows([row('1', 'a', 'qa', false)]);
  assert.equal(M.primaryOf(attachedOnly, 'a'), null);
  assert.equal(M.unassignedCount(attachedOnly, [{ id: 'a' }]), 1);
});

test('R3 attached projects appear in their workspace as attached; withdrawn rows do not', () => {
  const idx = M.fromRows([row('1', 'a', 'ml', true), row('2', 'a', 'qa', false), row('3', 'a', 'dl', false, 'withdrawn')]);
  assert.deepEqual(M.projectsInWorkspace(idx, P, 'qa').map((x) => [x.project.id, x.role]), [['a', 'attached']]);
  assert.deepEqual(M.projectsInWorkspace(idx, P, 'ml').map((x) => [x.project.id, x.role]), [['a', 'primary']]);
  assert.deepEqual(M.projectsInWorkspace(idx, P, 'dl'), []);
  assert.deepEqual(M.attachChoices(idx, 'a').map((w) => w.id).includes('dl'), true);
  assert.deepEqual(M.attachChoices(idx, 'a').map((w) => w.id).includes('qa'), false);
  assert.deepEqual(M.attachChoices(idx, 'a').map((w) => w.id).includes('ml'), false);
  // Primary first, then registry order; withdrawn rows are not active.
  assert.deepEqual(M.activeWorkspacesOf(idx, 'a').map((x) => x.row.workspaceId), ['ml', 'qa']);
  const counts = M.countsByWorkspace(idx, P);
  assert.equal(counts.ml, 1); assert.equal(counts.qa, 1); assert.equal(counts.dl, 0);
  // Within a workspace: primaries first, then attached, each in input order.
  const two = M.fromRows([row('1', 'a', 'qa', false), row('2', 'c', 'qa', true)]);
  assert.deepEqual(M.projectsInWorkspace(two, P, 'qa').map((x) => [x.project.id, x.role]), [['c', 'primary'], ['a', 'attached']]);
});

test('attachChoices offers catalogue workspaces only: active, complete and retired (off-catalogue) ones are excluded; withdrawn ones are offered again', () => {
  const idx = M.fromRows([
    row('1', 'a', 'ml', true), row('2', 'a', 'qa', false), row('3', 'a', 'dl', false, 'complete'),
    row('4', 'a', 'devops', false, 'withdrawn'), row('5', 'a', 'old-retired', false, 'active')
  ]);
  const ids = M.attachChoices(idx, 'a').map((w) => w.id);
  for (const gone of ['ml', 'qa', 'dl']) assert.equal(ids.includes(gone), false, gone);
  assert.equal(ids.includes('old-retired'), false, 'a workspace the catalogue no longer lists is never offered');
  assert.equal(ids.includes('devops'), true, 'a withdrawn participation can be attached again');
  // Catalogue order, and every choice is a registry entry.
  assert.deepEqual(ids, WORKSPACES.map((w) => w.id).filter((id) => !['ml', 'qa', 'dl'].includes(id)));
  // A project with no rows may join any catalogue workspace.
  assert.deepEqual(M.attachChoices(idx, 'zz').map((w) => w.id), WORKSPACES.map((w) => w.id));
});

test('R4 an unknown workspace id keeps its id as its label, has no hue, and is not counted in the registry rows', () => {
  const idx = M.fromRows([row('1', 'a', 'archive-lab', true), row('2', 'c', 'sde', true)]);
  assert.equal(M.primaryOf(idx, 'a'), null, 'no registry config for an unknown id');
  assert.deepEqual(M.primaryViewOf(idx, 'a'), { id: 'archive-lab', label: 'archive-lab', hueSlot: null, config: null });
  assert.deepEqual(M.viewOf('archive-lab'), { id: 'archive-lab', label: 'archive-lab', hueSlot: null, config: null });
  assert.equal(M.viewOf('ml').label, 'Machine learning');
  assert.equal(M.viewOf('ml').hueSlot, 1);
  const [only] = M.activeWorkspacesOf(idx, 'a');
  assert.equal(only.ws, null);
  assert.equal(only.row.workspaceId, 'archive-lab');
  const counts = M.countsByWorkspace(idx, P);
  assert.deepEqual(Object.keys(counts).sort(), WORKSPACES.map((w) => w.id).sort());
  assert.equal(Object.values(counts).reduce((n, x) => n + x, 0), 1);
  // It has a primary, so it is not Unassigned.
  assert.equal(M.unassignedCount(idx, P), 1);
  assert.equal(M.attachChoices(idx, 'a').length, WORKSPACES.length, 'only registry workspaces are offered');
});

test('R5 a complete mapped row with no primary shows Unassigned (platform-core section 16 item 3)', () => {
  const idx = M.fromRows([row('1', 'a', 'ml', false, 'complete')]);
  assert.equal(M.primaryOf(idx, 'a'), null);
  assert.equal(M.primaryViewOf(idx, 'a'), null);
  assert.deepEqual(M.projectsInWorkspace(idx, P, 'ml'), []);
  assert.equal(M.unassignedCount(idx, [{ id: 'a' }]), 1);
  assert.equal(M.attachChoices(idx, 'a').map((w) => w.id).includes('ml'), false, 'a complete participation cannot be re-attached');
  // The legacy derivation would still say ML: the DB index is the authority.
  assert.equal(M.primaryOf(M.legacyIndex([{ id: 'a', domainId: 'ai-ml' }]), 'a').id, 'ml');
  // An isPrimary row that is not active is never the primary (the DDL forbids it; the model does not trust it).
  assert.equal(M.primaryOf(M.fromRows([row('1', 'a', 'ml', true, 'withdrawn')]), 'a'), null);
});

test('R6 buildWorkspaceIndex(projects, idx) counts primary plus attached', () => {
  const projects = [
    { id: 'a', name: 'A', domainId: 'ai-ml', updatedAt: 3, rootPath: '/a' },
    { id: 'b', name: 'B', domainId: 'cybersecurity', updatedAt: 2, rootPath: '/b' },
    { id: 'c', name: 'C', domainId: 'web-app-dev', updatedAt: 1, rootPath: '/c' }
  ];
  const idx = M.fromRows([row('1', 'a', 'ml', true), row('2', 'a', 'qa', false), row('3', 'c', 'sde', true), row('4', 'c', 'qa', false), row('5', 'b', 'qa', false)]);
  const wi = buildWorkspaceIndex(projects, idx);
  const qa = wi.rows.find((r) => r.id === 'qa');
  assert.equal(qa.count, 3);
  assert.equal(qa.attached, 3);
  assert.equal(wi.rows.find((r) => r.id === 'sde').attached, 0);
  assert.deepEqual(qa.recent.map((p) => p.id), ['a', 'b']);
  assert.equal(wi.rows.find((r) => r.id === 'ml').count, 1);
  assert.equal(wi.totalProjects, 3);
  assert.equal(wi.unassigned, 1, 'b is only attached, so it has no primary');
});

test('R7 pathSegments for a project that is only attached shows the Unassigned segment first', () => {
  const projects = [{ id: 'a', name: 'Alpha', domainId: 'ai-ml' }];
  const idx = M.fromRows([row('1', 'a', 'qa', false)]);
  const s = pathSegments({ name: 'project', id: 'a', tool: 'bench' }, projects, idx);
  assert.deepEqual(s, [{ kind: 'workspace', id: 'unassigned', label: 'Unassigned', hueSlot: null }, { kind: 'project', id: 'a', label: 'Alpha', hueSlot: null }]);
  const primary = pathSegments({ name: 'project', id: 'a', tool: 'bench' }, projects, M.fromRows([row('1', 'a', 'dl', true)]));
  assert.deepEqual(primary[0], { kind: 'workspace', id: 'dl', label: 'Deep learning', hueSlot: 2 });
});

test('legacyIndex: mapped domains become one active primary each; unmapped ones get no row', () => {
  const idx = M.legacyIndex(P);
  assert.deepEqual(M.activeWorkspacesOf(idx, 'a').map((x) => [x.row.workspaceId, x.row.isPrimary, x.row.source]), [['ml', true, 'legacy_domain']]);
  assert.deepEqual(M.activeWorkspacesOf(idx, 'b'), []);
  assert.equal(M.primaryOf(idx, 'c').id, 'sde');
});

test('R9 workspaceForDomain is imported only by workspaces/participation.ts and workspaces/mapping.ts', () => {
  const users = walk(NEXUS).filter((f) => /\.(ts|tsx)$/.test(f))
    .filter((f) => /\bworkspaceForDomain\b/.test(fs.readFileSync(f, 'utf8'))).map(rel).sort();
  assert.deepEqual(users, ['workspaces/mapping.ts', 'workspaces/participation.ts']);
  // The legacy-only helpers left mapping.ts.
  const mapping = fs.readFileSync(path.join(NEXUS, 'workspaces', 'mapping.ts'), 'utf8');
  assert.doesNotMatch(mapping, /export function (projectsForWorkspace|countsByWorkspace)\b/);
});

test('R10 no .tsx under nexus/ calls window.cth.nexus* directly; only data/nexusClient.ts does', () => {
  const callers = walk(NEXUS).filter((f) => /\.(ts|tsx)$/.test(f))
    .filter((f) => /window\.cth\.nexus[A-Z]/.test(fs.readFileSync(f, 'utf8'))).map(rel);
  assert.deepEqual(callers, ['data/nexusClient.ts']);
});

const src = (p) => fs.readFileSync(path.join(NEXUS, p), 'utf8');

test('the loader is mounted once, in the shell, and never writes the project list', () => {
  const mounts = walk(NEXUS).filter((f) => /\.tsx$/.test(f)).filter((f) => /\buseParticipations\(\)/.test(fs.readFileSync(f, 'utf8'))).map(rel);
  assert.deepEqual(mounts, ['NexusShell.tsx']);
  const hook = src('data/useParticipations.ts');
  assert.doesNotMatch(hook, /setProjects|setState\(/);
  assert.match(hook, /\$\{p\.id\}:\$\{p\.domainId\}:\$\{p\.updatedAt\}/, 'reloads on the project-list signature');
  assert.match(hook, /\[signature, rev\]/, 'reloads on rev');
  assert.match(hook, /nexusClient\.participationsList\(\)/);
});

test('the notice is on the Workspaces, Workspace and Projects pages, and every screen reads the one index', () => {
  for (const f of ['pages/WorkspacesPage.tsx', 'pages/WorkspacePage.tsx', 'pages/ProjectsPage.tsx']) assert.match(src(f), /<PlatformNotice \/>/, f);
  for (const f of ['pages/WorkspacesPage.tsx', 'pages/WorkspacePage.tsx', 'pages/ProjectsPage.tsx', 'launcher/LauncherPage.tsx', 'start/StartPage.tsx',
    'chrome/ContextBar.tsx', 'intent/IntentLine.tsx', 'project/SourceView.tsx', 'project/CompletionPlaceholder.tsx', 'project/PassportPanel.tsx', 'project/ProjectBench.tsx'])
    assert.match(src(f), /useParticipationIndex\(\)/, f);
  const notice = src('components/PlatformNotice.tsx');
  assert.match(notice, /role="status"/);
  assert.match(notice, /unavailableNotice\(/);
  assert.match(notice, />Try again</);
});

test('the store delegates every transition to the pure platformState module', () => {
  const store = src('data/platformStore.ts');
  assert.match(store, /nextPlatformState\(/);
  assert.match(store, /selectCanWrite = \(s: PlatformState\): boolean => canWrite\(s\)/);
  assert.doesNotMatch(src('data/platformState.ts'), /from 'zustand'|from 'react'/);
});

test('the Workspaces count tooltip says projects join by what Nexus finds in them and added projects are included', () => {
  const page = src('pages/WorkspacesPage.tsx');
  assert.match(page, /title=\{projectsTitle\(r\)\}/);
  assert.match(page, /Projects join this workspace by what Nexus finds in them/);
  assert.match(page, /plural\(r\.attached, 'project'\)\} added by hand/);
  assert.doesNotMatch(page, /Projects detected as:|Primary by detected domain|domainIds\.join/, 'no raw domain id is printed');
});

test('the workspace page lists attached projects with a tag; its empty state no longer promises handoffs later', () => {
  const page = src('pages/WorkspacePage.tsx');
  assert.match(page, /role=\{roleOf\.get\(p\.id\)\}/);
  assert.doesNotMatch(page, /arrive through handoffs in a later phase/);
  assert.match(src('components/ProjectRow.tsx'), /role === 'attached' && <span className="nx-attached-tag"><Badge>Added<\/Badge><\/span>/);
});
