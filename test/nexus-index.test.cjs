'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { entriesFromRegistry, matchEntries, moveActive, resolveEnter } = loadTs('src/renderer/src/nexus/launcher/indexModel.ts');
const { WORKSPACES } = loadTs('src/renderer/src/nexus/workspaces/registry.ts');
const E = entriesFromRegistry(WORKSPACES);
const ids = (xs) => xs.map((x) => x.id);

test('empty query returns every environment in registry order', () => {
  assert.deepEqual(ids(matchEntries(E, '')), WORKSPACES.map((w) => w.id));
  assert.deepEqual(ids(matchEntries(E, '   ')), WORKSPACES.map((w) => w.id));
});

test('name and label prefixes rank first', () => {
  assert.equal(matchEntries(E, 'mach')[0].id, 'ml');
  assert.equal(matchEntries(E, 'ml')[0].id, 'ml');
  assert.equal(matchEntries(E, 'dev')[0].id, 'devops');
});

test('vocabulary finds the environment that works with a thing', () => {
  assert.equal(matchEntries(E, 'dashboards')[0].id, 'data');
  assert.equal(matchEntries(E, 'saved versions')[0].id, 'dl');
});

test('matching is case-insensitive and ignores surrounding space', () => {
  assert.deepEqual(ids(matchEntries(E, '  ML ')), ids(matchEntries(E, 'ml')));
});

test('no match returns an empty list', () => {
  assert.deepEqual(matchEntries(E, 'zzz'), []);
});

test('moveActive clamps instead of wrapping', () => {
  assert.equal(moveActive(0, -1, 8), 0);
  assert.equal(moveActive(7, 1, 8), 7);
  assert.equal(moveActive(3, 1, 8), 4);
  assert.equal(moveActive(0, 1, 0), -1);
});

test('resolveEnter returns the active id or null', () => {
  assert.equal(resolveEnter(E, 1), E[1].id);
  assert.equal(resolveEnter([], 0), null);
  assert.equal(resolveEnter(E, -1), null);
});
