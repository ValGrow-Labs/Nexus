'use strict';
// Plain-words track D: reviewing and merging suggested changes. The decision is a 3-step rail ("Looks good" -> "Keep these changes"
// -> "Add to my project"), the merge window is plain, and no check id or git word reaches a person. Only words changed: the actions,
// their order and the fail-closed rules are pinned by nexus-ui-agent-models (UA3, R5, R7-2) and the merge window's indices below.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const ROOT = path.join(__dirname, '..');
const CS = loadTs('src/renderer/src/nexus/project/changeSetModel.ts');
const EV = loadTs('src/renderer/src/nexus/project/evidenceModel.ts');
const RM = loadTs('src/renderer/src/nexus/review/reviewModel.ts');
const MD = loadTs('src/main/nexusExec/mergeDialog.ts');
const { VALIDATORS } = loadTs('src/shared/nexus/validators.ts');
const { GLOSSARY } = loadTs('src/renderer/src/nexus/data/glossary.ts');

const SHA = 'a'.repeat(40);
const NOW = 1_700_000_000_000;
const BLOCKING = ['git.diff_nonempty', 'git.paths_in_scope', 'sec.secret_scan', 'cs.tests_pass', 'git.applies_cleanly'];
const val = (id, status) => ({ validatorId: id, blocking: true, status, summary: null, finishedAt: NOW, evidence: [], latestRun: null, history: 1 });
const allPass = () => BLOCKING.map((id) => val(id, 'passed'));
const repo = (o = {}) => ({ projectId: 'p', branch: 'main', head: SHA, dirty: false, integrationRef: 'refs/nexus/accepted/main', acceptedHead: SHA, acceptedNotMerged: 0,
  canFastForward: false, reason: 'nothing_to_merge', checkedAt: NOW, ...o });
const WHOLE = { whole: true, readBytes: 10, totalBytes: 10 };
const cset = (status, o = {}) => ({ status, content: { type: 'git', commit: SHA }, previewComplete: true, previewReason: null, ...o });
const csm = (i) => CS.changeSetModel({ diffRead: WHOLE, ...i });

// Words a newcomer has no way to read (git internals, the old three verbs, ids).
const JARGON = /fast-forward|head commit|uncommitted|untracked|repository|change set|worktree|revalidate|\bdiff\b|\bcommit\b|\bbranch\b|\bsha\b|validator|\bhash(ed)?\b|lockfile|Merge accepted work|Accept the change|\bApprove\b/i;

test('P-D1 the decision is a plain 3-step rail with the glossary names, one next step at a time', () => {
  assert.deepEqual(CS.railOf('looks_good').map((x) => [x.n, x.label, x.state]), [[1, 'Looks good', 'current'], [2, 'Keep these changes', 'waiting'], [3, 'Add to my project', 'waiting']]);
  assert.deepEqual(CS.railOf('keep').map((x) => x.state), ['done', 'current', 'waiting']);
  assert.deepEqual(CS.railOf('add').map((x) => x.state), ['done', 'done', 'current']);
  assert.deepEqual(CS.railOf(null).map((x) => x.state), ['done', 'done', 'done']);
  for (const x of CS.railOf('keep')) assert.equal(x.help, Object.values(GLOSSARY).find((t) => t.name === x.label).help, 'the help line is the glossary line');
  // The three steps, end to end, with the plain status after each.
  const waiting = csm({ version: cset('candidate'), validations: allPass(), review: null, repo: repo() });
  assert.equal(waiting.headline, 'Waiting for you: read what changed, then decide');
  assert.deepEqual(waiting.buttons, ['approve', 'request_changes', 'reject']);
  assert.equal(CS.BUTTON_LABEL.approve, 'Looks good');
  const looksGood = csm({ version: cset('candidate'), validations: allPass(), review: 'approve', repo: repo() });
  assert.equal(looksGood.headline, 'Looks good: done. Next: Keep these changes');
  assert.equal(looksGood.buttons[0], 'accept');
  assert.equal(CS.BUTTON_LABEL.accept, 'Keep these changes');
  const kept = csm({ version: cset('active'), validations: allPass(), review: 'approve', repo: repo({ acceptedNotMerged: 1, canFastForward: true, reason: null }) });
  assert.match(kept.headline, /^Kept: saved in Nexus’s copy\. Your own files are not changed yet\.$/);
  assert.equal(kept.merge.button.label, 'Add to my project');
  assert.match(kept.sentences[0], /^Next: press “Add to my project”\./);
  const added = csm({ version: cset('active'), validations: allPass(), review: 'approve', repo: repo() });
  assert.equal(added.headline, 'Added to your project');
  // No rail where no decision is in play; the same three verbs never read as Approve / Accept / Merge.
  for (const [status, review] of [['draft', null], ['failed', null], ['deprecated', null], ['candidate', 'reject'], ['candidate', 'request_changes'], ['candidate', undefined]]) {
    assert.equal(csm({ version: cset(status), validations: allPass(), review, repo: repo() }).rail, null, `${status}/${review}`);
  }
});

test('P-D2 the order and the fail-closed rules did not move: no Looks good without the whole preview loaded, Keep only after it, Add only through the window', () => {
  const part = csm({ version: cset('candidate'), validations: allPass(), review: null, repo: repo(), diffRead: { whole: false, readBytes: 1, totalBytes: 9 } });
  assert.ok(!part.buttons.includes('approve'));
  assert.match(part.sentences.join(' '), /Show all of what changed to say “Looks good”/);
  const incomplete = csm({ version: cset('candidate', { previewComplete: false, previewReason: 'hidden_lines' }), validations: allPass(), review: null, repo: repo() });
  assert.deepEqual(incomplete.buttons, ['request_changes', 'reject']);
  assert.match(incomplete.sentences[0], /You cannot say “Looks good” unless you can read all of it\./, 'the blocker says why, in plain words');
  assert.match(incomplete.sentences[0], /Press “Ask for different changes”/, 'and what to do');
  // Keep these changes only on an approved candidate.
  for (const review of [null, 'request_changes', 'reject']) assert.ok(!csm({ version: cset('candidate'), validations: allPass(), review, repo: repo() }).buttons.includes('accept'), String(review));
  assert.ok(csm({ version: cset('candidate'), validations: allPass(), review: 'approve', repo: repo() }).buttons.includes('accept'));
  // Add to my project: a button only when the project can simply move; a dirty project is a sentence.
  assert.equal(CS.mergeModel(repo({ acceptedNotMerged: 1, dirty: true, canFastForward: true, reason: null })).button, null);
  assert.equal(CS.mergeModel(repo({ acceptedNotMerged: 1, canFastForward: false, reason: 'weird_code' })).button, null);
  assert.match(CS.mergeModel(repo({ acceptedNotMerged: 1, canFastForward: false, reason: 'weird_code' })).sentence, /cannot be added to your project right now/);
  assert.equal(CS.mergedText({ branch: 'main' }), 'Added to your project. Your project’s main version (“main”) now has the kept changes.');
});

test('P-D3 no check id on screen: every check has one plain line for each result, an unknown check reads "Another check", never its id', () => {
  const ids = VALIDATORS.map((x) => x.id);
  assert.ok(ids.length >= 19, 'the registry was walked');
  for (const id of ids) {
    const lines = [EV.validatorLabel(id), ...['passed', 'failed', 'error', 'skipped', null].map((s) => EV.validatorLine(id, s))];
    for (const l of lines) {
      assert.ok(l.length > 8, `${id}: "${l}"`);
      assert.doesNotMatch(l, /[a-z]+\.[a-z_]+|_/, `${id}: no id in "${l}"`);
      assert.doesNotMatch(l, JARGON, `${id}: "${l}"`);
    }
    assert.notEqual(EV.validatorLine(id, 'passed'), EV.validatorLine(id, 'failed'), id);
  }
  assert.equal(EV.validatorLabel('zzz.never_heard_of_it'), 'Another check');
  for (const s of ['passed', 'failed', 'error', 'skipped', null]) assert.doesNotMatch(EV.validatorLine('zzz.never_heard_of_it', s), /zzz|never|_/, String(s));
  // The four lines the brief names.
  assert.equal(EV.validatorLine('cs.tests_pass', 'passed'), 'Your tests ran and passed');
  assert.equal(EV.validatorLine('git.paths_in_scope', 'passed'), 'The changes only touch files they should');
  assert.equal(EV.validatorLine('sec.secret_scan', 'passed'), 'No common secret keys found');
  assert.equal(EV.validatorLine('git.applies_cleanly', 'passed'), 'The changes fit your project without conflicts');
  // A failing check never reads as passing, and a source never prints an id.
  for (const id of BLOCKING) assert.doesNotMatch(EV.validatorLine(id, 'failed'), /passed|\bpass\b/i, id);
  const ev = EV.evidenceView([val('git.paths_in_scope', 'passed'), { ...val('x.y_z', 'passed'), evidence: [{ type: 'number', name: null, value: 3 }, { type: 'schema', name: null, value: null }, { type: 'location', name: null, value: 'a' }] }], { status: 'candidate' }, true, { kind: 'change_set' });
  for (const r of ev.rows) {
    assert.doesNotMatch(r.label, /[a-z]+\.[a-z_]+|_/, r.label);
    for (const f of r.facts) assert.doesNotMatch(`${f.label} ${f.value} ${f.source}`, /x\.y_z|git\.paths|_/, `${f.label} / ${f.source}`);
  }
  assert.deepEqual(ev.rows.filter((r) => r.validatorId === 'x.y_z').map((r) => r.facts.map((f) => f.source)), [['Recorded by Nexus', 'Checked by Nexus', 'Recorded by Nexus']]);
  // Required checks are marked in the page (a "Required" tag), advice-only ones are told apart.
  const sec = fs.readFileSync(path.join(ROOT, 'src/renderer/src/nexus/project/EvidenceSection.tsx'), 'utf8');
  assert.match(sec, /r\.blocking \? 'Required' : 'Advice only'/);
  assert.match(sec, /'Run the checks again'/);
});

test('P-D4 the blocked headline says how many required checks need attention, with each check as its own plain line', () => {
  const one = csm({ version: cset('draft'), validations: [...allPass().slice(0, 3), val('cs.tests_pass', 'failed'), val('git.applies_cleanly', 'passed')], review: null, repo: repo() });
  assert.equal(one.headline, 'Blocked: Some of your tests failed');
  assert.deepEqual(one.blocking.map((b) => [b.label, b.word]), [['Some of your tests failed', 'Failed']]);
  const none = csm({ version: cset('failed'), validations: null, review: null, repo: repo() });
  assert.equal(none.headline, 'These suggested changes did not pass their checks');
  assert.doesNotMatch(`${none.headline} ${none.sentences.join(' ')}`, JARGON);
});

test('P-D5 the merge window: plain title, message and detail; button INDICES and Cancel-by-default are unchanged (security)', async () => {
  const sha = (c) => c.repeat(40);
  const info = { projectId: 'p', branch: 'main', from: sha('a'), to: sha('b'), commitCount: 2, accepted: [
    { versionId: 'v1', title: 'Add the export', mergeCommit: sha('1'), acceptedAt: 1 }, { versionId: 'v2', title: '', mergeCommit: sha('2'), acceptedAt: 2 }] };
  const o = MD.mergeDialogOptions(info);
  // The indices and defaults are exactly what they were: Cancel is 0 (default and escape), the confirming button is 1.
  assert.deepEqual([...MD.MERGE_BUTTONS], ['Cancel', 'Add to my project']);
  assert.equal(MD.MERGE_CONFIRM_INDEX, 1);
  assert.deepEqual([o.defaultId, o.cancelId, o.noLink, o.type], [0, 0, true, 'question']);
  assert.equal(o.buttons.indexOf('Add to my project'), MD.MERGE_CONFIRM_INDEX);
  assert.equal(await MD.confirmMergeWith(async () => ({ response: 1 }), info), true);
  for (const r of [{ response: 0 }, { response: 2 }, {}, null]) assert.equal(await MD.confirmMergeWith(async () => r, info), false, JSON.stringify(r));
  // Plain words.
  assert.equal(o.title, 'Add to my project');
  assert.equal(o.message, 'Add 2 kept changes to your project\'s main version, "main"?');
  assert.match(o.detail, /^Your project's main version, "main", is at the saved version \[aaaaaaaa\]\. It will be updated to the newest saved version \[bbbbbbbb\]\./);
  assert.match(o.detail, /• Title from the AI helper: "Add the export" \[11111111\]/);
  assert.match(o.detail, /• Title from the AI helper: "Suggested change" \[22222222\]/);
  assert.match(o.detail, /Press Cancel to leave your project exactly as it is\./);
  assert.doesNotMatch(`${o.title}\n${o.message}\n${o.detail}`, /fast-forward|\bcommit|\bbranch|tracked|\bgit\b|accepted|Merge/i);
  for (const l of o.detail.split('\n')) assert.ok(l.length < 400, 'lines stay short');
});

test('P-D6 the words of these views: no git words, ids or old verbs in a string a person reads', () => {
  const files = ['project/changeSetModel.ts', 'project/ChangeSetReview.tsx', 'project/evidenceModel.ts', 'project/EvidenceSection.tsx', 'review/ReviewSurface.tsx', 'review/reviewModel.ts'];
  const seen = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(ROOT, 'src/renderer/src/nexus', f), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const code = line.replace(/\/\/.*$/, '').replace(/^\s*(\*|\/\*).*$/, '');
      for (const m of code.matchAll(/(['"`])((?:\\.|(?!\1).){12,})\1/g)) {
        const t = m[2].replace(/\$\{[^}]*\}/g, '');
        if (/^(nx-|@|\.\.?\/|[a-z]+:|\^|\$)/.test(t) || /^[\w.:\-/ ${}()[\]|^\\+*?,]*$/.test(t) && !/ [a-z]+ [a-z]+ /i.test(t)) continue; // class names, imports, code
        seen.push([f, t]);
        assert.doesNotMatch(t, JARGON, `${f}: ${t}`);
      }
    }
  }
  assert.ok(seen.length > 60, `the scan read the visible strings (${seen.length})`);
});

test('P-D7 what changed: a plain summary above it, "what changed" and "suggested changes" are the names, loading and empty states say what to do', () => {
  assert.equal(CS.diffSummary('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n-old\n+new\n+newer\n keep\n'), 'In all: 1 file, 2 lines added, 1 line removed.');
  assert.equal(CS.diffSummary('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/y b/y\n--- a/y\n+++ b/y\n@@ -0,0 +1 @@\n+c\n', false), 'So far: 2 files, 2 lines added, 1 line removed.');
  assert.equal(CS.diffSummary(''), 'There are no edits to show.');
  const rv = fs.readFileSync(path.join(ROOT, 'src/renderer/src/nexus/project/ChangeSetReview.tsx'), 'utf8');
  assert.match(rv, /<h2 id="nx-cs-title" className="nx-cs__title nx-visually-hidden">Suggested changes<\/h2>/);
  assert.match(rv, /<h3 className="nx-cs__sub">What changed<\/h3>/);
  assert.match(rv, /aria-label="What changed \(read only\)"/);
  assert.match(rv, /Loading what changed…/);
  assert.match(rv, /There are no edits to show\. Ask the AI helper to try again\./);
  assert.match(rv, /Write a short note first\. The AI helper reads it\./);
  // One primary button at a time: the next step is primary, the other decisions are quiet.
  assert.match(rv, /variant=\{b === 'accept' \|\| b === 'approve' \? 'primary' : 'quiet'\}/);
  // The rail is shown in words, not colour alone.
  assert.match(rv, /x\.state === 'done' \? 'Done' : x\.state === 'current' \? 'Next' : 'Later'/);
  assert.match(rv, /aria-current=\{x\.state === 'current' \? 'step' : undefined\}/);
  assert.equal(RM.groupChanges([{ path: 'a', kind: 'untracked' }])[0].title, 'New files not saved yet');
});
