'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { emblemPath, EMBLEM_POINTS, EMBLEM_VIEW } = loadTs('src/renderer/src/nexus/launcher/emblems.ts');
const { WORKSPACES } = loadTs('src/renderer/src/nexus/workspaces/registry.ts');

test('emblems: every workspace has a closed path with the same point count, inside the view', () => {
  const counts = new Set();
  for (const w of WORKSPACES) {
    const d = emblemPath(w.id);
    assert.match(d, /^M [\d.]+ [\d.]+( L [\d.]+ [\d.]+)+ Z$/, w.id);
    const nums = d.match(/[\d.]+/g).map(Number);
    counts.add(nums.length / 2);
    for (const n of nums) assert.ok(n >= 0 && n <= EMBLEM_VIEW, `${w.id}: ${n} outside 0..${EMBLEM_VIEW}`);
  }
  assert.deepEqual([...counts], [EMBLEM_POINTS], 'identical point counts let the shapes morph into each other');
});

test('emblems: shapes are distinct per workspace; unknown ids get the generic shape', () => {
  const paths = WORKSPACES.map((w) => emblemPath(w.id));
  assert.equal(new Set(paths).size, WORKSPACES.length);
  assert.equal(emblemPath('future-workspace'), emblemPath('generic'));
  assert.equal(emblemPath('ml'), emblemPath('ml'), 'deterministic');
});

