'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { groupChanges, REVIEW_PHASE_NOTE } = loadTs('src/renderer/src/nexus/review/reviewModel.ts');

test('groups by kind in a fixed order, paths sorted', () => {
  const g = groupChanges([{ path: 'b.py', kind: 'modified' }, { path: 'new.md', kind: 'untracked' }, { path: 'a.py', kind: 'modified' }, { path: 'old.py', kind: 'deleted' }]);
  assert.deepEqual(g.map((x) => [x.title, x.paths]), [['Edited files', ['a.py', 'b.py']], ['Removed files', ['old.py']], ['New files not saved yet', ['new.md']]]);
});

test('empty input gives no groups', () => { assert.deepEqual(groupChanges([]), []); });

test('the note says why keep and undo are missing here, and where the AI helper’s suggested changes are decided (V9: it no longer says that keeping "arrives" later); plain words, no git terms but the program name', () => {
  assert.match(REVIEW_PHASE_NOTE, /keep/i);
  assert.match(REVIEW_PHASE_NOTE, /undo/i);
  assert.match(REVIEW_PHASE_NOTE, /Add to my project/);
  assert.doesNotMatch(REVIEW_PHASE_NOTE, /arrives|until then|commit|revert|discard|merged|change set/i);
});
