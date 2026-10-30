'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { shouldScheduleAutoRestore, restoreStatusLine } = loadTs('src/renderer/src/hooks/restoreTeamPolicy.ts');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const base = { autoRestoreEnabled: true, autoStarted: false, restoring: false, onboardingComplete: true, restorableCount: 2 };

test('the shell schedules the boot restore once, only when there is something to restore', () => {
  assert.equal(shouldScheduleAutoRestore(base), true);
  assert.equal(shouldScheduleAutoRestore({ ...base, autoStarted: true }), false);
  assert.equal(shouldScheduleAutoRestore({ ...base, restoring: true }), false);
  assert.equal(shouldScheduleAutoRestore({ ...base, restorableCount: 0 }), false);
  assert.equal(shouldScheduleAutoRestore({ ...base, onboardingComplete: false }), false);
});

test('regression: a mount without autoRestore (fullscreen) never restores', () => {
  assert.equal(shouldScheduleAutoRestore({ ...base, autoRestoreEnabled: false }), false);
});

test('only App.tsx opts in to the automatic restore', () => {
  assert.match(read('src/renderer/src/App.tsx'), /useRestoreTeam\([^;]*\{\s*autoRestore:\s*true\s*\}\s*\)/);
  for (const f of ['src/renderer/src/components/FullscreenTerminal.tsx', 'src/renderer/src/nexus/agents/AgentsPage.tsx'])
    assert.doesNotMatch(read(f), /autoRestore:\s*true/, f);
});

test('restore status lines are plain', () => {
  assert.equal(restoreStatusLine({ kind: 'pending', count: 2 }), 'Bringing back 2 AI helpers from your last session in a moment.');
  assert.equal(restoreStatusLine({ kind: 'pending', count: 1 }), 'Bringing back 1 AI helper from your last session in a moment.');
  assert.equal(restoreStatusLine({ kind: 'running', auto: true }), 'Bringing back your AI helpers from your last session…');
  assert.equal(restoreStatusLine({ kind: 'running', auto: false }), 'Bringing back your AI helpers…');
  assert.equal(restoreStatusLine({ kind: 'done', note: '2 brought back · 1 already running' }), 'Last session: 2 brought back · 1 already running');
  assert.equal(restoreStatusLine({ kind: 'done', note: 'nothing to restore' }), null);
  assert.equal(restoreStatusLine({ kind: 'idle' }), null);
});

test('restore failures name agents by their on-screen label, not the stored name', () => {
  const { restoreLabeler } = loadTs('src/renderer/src/hooks/restoreTeamPolicy.ts');
  const live = [{ id: 'god', name: 'Michael', isGod: true, cwd: 'C:\\h', ptyId: 'pty-god' }];
  const restorable = [
    { id: 'w1', name: 'Dwight', cwd: 'C:\\repos\\api' },
    { id: 'w2', name: 'Builder', cwd: 'C:\\repos\\web' }
  ];
  const labelOf = restoreLabeler(live, restorable, [], { godId: 'god', registryIds: new Set(['god', 'w1', 'w2']) });
  assert.equal(labelOf('w1'), 'Agent · api');
  assert.equal(labelOf('w2'), 'Builder');
  assert.equal(labelOf('missing'), 'Agent');
  const src = read('src/renderer/src/hooks/useRestoreTeam.ts');
  assert.doesNotMatch(src, /failures\.push\(`\$\{a\.name\}/);
  assert.equal((src.match(/failures\.push\(`\$\{labelOf\(a\.id\)\}/g) || []).length, 3);
});
