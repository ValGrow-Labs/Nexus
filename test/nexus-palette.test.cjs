'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { buildPaletteIndex, searchPalette } = loadTs('src/renderer/src/nexus/chrome/paletteIndex.ts');

const projects = [{ id: 'p1', name: 'Fraud Detector', rootPath: '/r/fraud', domainId: 'ai-ml', updatedAt: 2 }, { id: 'p2', name: 'Web Shop', rootPath: '/r/shop', domainId: 'web-app-dev', updatedAt: 1 }];

test('index has pages, workspaces, real projects and actions', () => {
  const idx = buildPaletteIndex(projects);
  assert.ok(idx.some((e) => e.group === 'Pages' && e.label === 'Home'));
  assert.equal(idx.filter((e) => e.group === 'Workspaces').length, 8);
  assert.deepEqual(idx.filter((e) => e.group === 'Projects').map((e) => e.route.id), ['p1', 'p2']);
  assert.ok(idx.filter((e) => e.group === 'Projects').every((e) => e.route.tool === 'bench'));
  assert.ok(idx.some((e) => e.action === 'newProject'));
});

test('search: case-insensitive over label and hint; no match → empty', () => {
  const idx = buildPaletteIndex(projects);
  assert.deepEqual(searchPalette(idx, 'fraud').map((e) => e.id), ['project:p1']);
  assert.ok(searchPalette(idx, 'ML').some((e) => e.id === 'ws:ml'));
  assert.ok(searchPalette(idx, '/r/shop').some((e) => e.id === 'project:p2'));
  assert.deepEqual(searchPalette(idx, 'zzzz'), []);
});

test('empty query shows a bounded default list', () => {
  const idx = buildPaletteIndex(Array.from({ length: 20 }, (_, i) => ({ id: `x${i}`, name: `P${i}`, rootPath: '/', domainId: 'ai-ml', updatedAt: i })));
  const res = searchPalette(idx, '  ');
  assert.equal(res.filter((e) => e.group === 'Projects').length, 5);
  assert.equal(res[0].group, 'Pages');
});

test('Tasks 12 and 13: Artifacts and Handoffs are no longer hinted as planned; Deployments still is', () => {
  const idx = buildPaletteIndex(projects);
  const page = (id) => idx.find((e) => e.id === id);
  assert.deepEqual(page('page:artifacts').route, { name: 'artifacts' });
  assert.doesNotMatch(page('page:artifacts').hint ?? '', /planned|coming later/i);
  assert.equal(page('page:artifacts').label, 'Saved items');
  assert.equal(page('page:handoffs').hint, 'items passed to another workspace');
  assert.ok(!searchPalette(idx, 'coming later').some((e) => e.id === 'page:handoffs'));
  assert.ok(searchPalette(idx, 'handoffs').some((e) => e.id === 'page:handoffs'));
  assert.equal(page('page:deployments').hint, 'coming later');
  assert.ok(searchPalette(idx, 'saved items').some((e) => e.id === 'page:artifacts'));
  assert.ok(!searchPalette(idx, 'coming later').some((e) => e.id === 'page:artifacts'));
  assert.equal(page('page:deployments').label, 'Publishing');
});
