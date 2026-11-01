'use strict';
// "Use these changes": Looks good, Keep these changes and Add to my project run in that order from one button, each only after the one before worked.
// Nothing is weakened: the button is offered only where "Looks good" is, each step is its own call, a failed step stops the run and says which one.
// Plain node (the pure flow through load-ts) plus source pins on where the button is shown.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const F = loadTs('src/renderer/src/nexus/project/changesFlow.ts');
const src = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

const ok = (data = {}) => ({ ok: true, data });
const fail = (code, reason) => ({ ok: false, code, reason, message: 'x' });
const repo = (o = {}) => ({ acceptedNotMerged: 1, dirty: false, canFastForward: true, branch: 'main', acceptedHead: 'h2', reason: null, ...o });
const deps = (o = {}) => {
  const calls = [];
  return { calls, head: 'h1',
    approve: async () => { calls.push('approve'); return ok(); },
    keep: async (h) => { calls.push(`keep:${h}`); return ok(); },
    repoStatus: async () => { calls.push('status'); return ok(repo()); },
    add: async (a) => { calls.push(`add:${a.branch}:${a.expectedAcceptedHead}`); return ok({ branch: 'main', before: null, after: null }); },
    ...o };
};

test('CF1 the three steps run in order, each with the arguments its own button uses, and the run ends "added"', async () => {
  const d = deps();
  const out = await F.runChangesFlow(d);
  assert.deepEqual(d.calls, ['approve', 'keep:h1', 'status', 'add:main:h2'], 'the head the person saw is used to keep; the head AFTER keeping is used to add');
  assert.equal(out.done, 'added');
});

test('CF2 a failed step stops the run and says which one; nothing after it is called', async () => {
  for (const [stop, expected, calls] of [
    ['approve', 'looks_good', ['approve']],
    ['keep', 'keep', ['approve', 'keep:h1']],
    ['repoStatus', 'add', ['approve', 'keep:h1', 'status']],
    ['add', 'add', ['approve', 'keep:h1', 'status', 'add:main:h2']]
  ]) {
    const d = deps({ [stop]: async () => { d.calls.push(stop); return fail('conflict', 'x'); } });
    // a replaced step records its own name, the others as above
    const out = await F.runChangesFlow(d);
    assert.equal(out.failed, expected, stop);
    assert.equal(d.calls.length, calls.length, `${stop}: ${d.calls.join(',')}`);
  }
});

test('CF3 not adding: the person pressing Cancel in the window is told apart from an error; a project that cannot take it now leaves the changes kept, with the reason', async () => {
  const cancelled = await F.runChangesFlow(deps({ add: async () => fail('conflict', 'cancelled') }));
  assert.equal(cancelled.failed, 'add');
  assert.equal(F.isCancelled(cancelled.result), true);
  assert.equal(F.isCancelled(fail('conflict', 'other')), false);
  assert.equal(F.isCancelled(fail('invalid', 'cancelled')), false);
  const dirty = await F.runChangesFlow(deps({ repoStatus: async () => ok(repo({ dirty: true })) }));
  assert.equal(dirty.done, 'kept');
  assert.match(dirty.sentence, /\S/, 'its own sentence says why');
  const nothing = await F.runChangesFlow(deps({ repoStatus: async () => ok(repo({ acceptedNotMerged: 0 })) }));
  assert.deepEqual(nothing, { done: 'kept', sentence: null });
});

test('CF4 without a known head nothing is run at all', async () => {
  const d = deps({ head: null });
  assert.equal(await F.runChangesFlow(d), null);
  assert.deepEqual(d.calls, []);
});

test('CF5 the button is offered only where "Looks good" is, and every step is the same call as its own button; the confirmation window stays main\'s', () => {
  const tsx = src('src/renderer/src/nexus/project/ChangeSetReview.tsx');
  assert.match(tsx, /view\.buttons\.includes\('approve'\) && \(\s*<div className="nx-cs__use">/, 'only when Looks good is offered (all required checks passed, the whole change read)');
  assert.match(tsx, /nexusClient\.reviewDecide\(versionId, \{ decision: 'approve' \}, intentId\)/);
  assert.match(tsx, /nexusClient\.changeSetAccept\(versionId, head\)/);
  assert.match(tsx, /nexusClient\.repoMergeAccepted\(projectId, args\)/);
  assert.match(tsx, /Use these changes/);
  const flow = src('src/renderer/src/nexus/project/changesFlow.ts');
  assert.doesNotMatch(flow, /confirm\(|dialog|showMessageBox/i, 'the renderer never confirms for the person');
  for (const w of ['Looks good', 'Keep these changes', 'Add to my project']) assert.ok(flow.includes(w), w);
});
