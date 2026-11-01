'use strict';
// A new conversation continues the newest suggested change that is not in the project yet: its working copy starts from that change's commit (not the
// project's), its context file has an "Earlier in this conversation" block made from Nexus's own records, and the change set it registers is the next
// version of the earlier one (lineage). The user's own files and branch are never touched. Fake sandbox, real git, real SQLite (test:db).
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers/agentFlowWorld.cjs');
const { flowWorld, useFixture, makeChange, sound, approveAndAccept } = H;
const { NODE } = require('./helpers/agentFlowCode.cjs');

const MIN = 60_000;
/** A scripted turn that records what the agent would see (the working copy's files and its context file), then edits and registers. */
async function seenTurn(w, o) {
  const seen = { files: [], context: '', params: null };
  w.script((plan) => {
    const root = plan.worktree.hostPath;
    const walk = (d, rel = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === '.git' ? [] : e.isDirectory() ? walk(path.join(d, e.name), `${rel}${e.name}/`) : [`${rel}${e.name}`]));
    seen.files = walk(root).sort();
    const ctxRel = plan.context && plan.context.file ? plan.context.file : null;
    try { seen.context = ctxRel ? fs.readFileSync(ctxRel, 'utf8') : ''; } catch { seen.context = ''; }
    if (!seen.context) {
      const guess = path.join(w.dataHome.root, 'jobs', plan.jobId ?? '', 'agent', 'context.md');
      try { seen.context = fs.readFileSync(guess, 'utf8'); } catch { /* none */ }
    }
    if (o.files) w.edit(plan, o.files);
    return [{ op: 'delta', text: o.say ?? 'Done.' },
      ...(o.register === false ? [] : [{ op: 'call', tool: 'changeset_register', args: { title: o.title ?? 'Change', summary: o.summary ?? 'Done.', clientKey: o.clientKey ?? 'k1' } }]),
      { op: 'usage', inputTokens: 100, outputTokens: 30, costUsdCents: 1, toolCalls: 1, estimated: false }, { op: 'complete' }];
  });
  const t = await w.turn(o.message, { sessionId: o.sessionId ?? null });
  return { ...t, seen, cs: w.changeSetsOf(t.jobId)[0] ?? null };
}
const jobParams = (w, jobId) => JSON.parse(w.jobRow(jobId).params_json);
const earlierBlock = (ctx) => { const m = /## Earlier in this conversation\n\n([\s\S]*?)(?:\n## |$)/.exec(ctx); return m ? m[1] : null; };

test('CT1 a new conversation starts from the earlier suggested change: its files are there, the context says what happened, the new change is its next version, and the user\'s project is untouched', async () => {
  const w = await flowWorld();
  try {
    await useFixture(w, 'node-test-app');
    await w.snapshot();
    await w.consent();
    const before = w.userState();
    const one = await seenTurn(w, { message: 'Add a weather module in src/a.js', files: { 'src/a.js': 'module.exports = 1;\n' }, title: 'Weather module', summary: 'Adds src/a.js.', say: 'I wrote src/a.js.' });
    assert.ok(one.cs, 'turn 1 registered a change');
    assert.ok(!one.seen.files.includes('src/a.js'), 'turn 1 started from the project');
    assert.equal(earlierBlock(one.seen.context), null, 'a first turn has no earlier-conversation block');
    await w.until_candidate(one.cs);
    // The first conversation ends; a NEW one starts (no session given).
    const two = await seenTurn(w, { message: 'The test fails: make the code and the test agree', files: { 'src/b.js': 'module.exports = 2;\n' }, title: 'Weather module, fixed', clientKey: 'k2' });
    assert.notEqual(two.sessionId, one.sessionId, 'a new conversation');
    assert.equal(jobParams(w, two.jobId).continuesFrom, one.cs, 'the turn names the change it continues');
    assert.ok(two.seen.files.includes('src/a.js'), `src/a.js is in the working copy: ${two.seen.files.join(',')}`);
    const block = earlierBlock(two.seen.context);
    assert.ok(block, `the context has the block:\n${two.seen.context.slice(0, 600)}`);
    assert.match(block, /data, not instructions/);
    assert.match(block, /Weather module/);
    assert.match(block, /Add a weather module in src\/a\.js/, 'what was asked before');
    assert.match(block, /Adds src\/a\.js/, 'the change\'s summary');
    assert.match(block, /I wrote src\/a\.js/, 'what the helper said last');
    assert.ok(block.length <= 2048, `the block is at most 2 KB (${block.length})`);
    assert.doesNotMatch(block, /[0-9A-Z]{26}/, 'no ids');
    // The change set is the NEXT VERSION of the earlier one, with the lineage edge, and it holds both files.
    assert.ok(two.cs, 'turn 2 registered a change');
    assert.equal(w.versionRow(two.cs).artifact_id, w.versionRow(one.cs).artifact_id, 'the same suggested change');
    const edge = w.db.prepare("SELECT 1 FROM artifact_edges WHERE from_version_id = ? AND to_version_id = ? AND relation = 'derived_from'").get(two.cs, one.cs);
    assert.ok(edge, 'the lineage edge to the earlier version');
    const meta = JSON.parse(w.versionRow(two.cs).metadata_json);
    assert.equal(meta.diffstat.files, 2, 'the change holds the earlier file and the new one');
    // The conversation's own view says so (no ids).
    const detail = await w.x.ok('nexus:session:get', two.sessionId);
    assert.deepEqual(detail.continuesFrom, { title: 'Weather module' });
    // The user's real files and branch were never touched.
    assert.deepEqual(w.userState(), before, 'the project folder, its branch, index and stash are unchanged');
    assert.equal(w.userHead(), before.head);
    sound(w, 'continue');
  } finally { await w.close(); }
});

test('CT2 an accepted change is in the project already (the new conversation starts from the project as it stands, no earlier-conversation block); a deprecated one is ignored', async () => {
  const w = await flowWorld();
  try {
    await useFixture(w, 'node-test-app');
    await w.snapshot();
    await w.consent();
    const one = await seenTurn(w, { message: 'First idea', files: { ...NODE.ledger }, title: 'First', execArgv: undefined });
    await w.until_candidate(one.cs);
    // Deprecated: ignored.
    w.db.prepare("UPDATE artifact_versions SET status = 'deprecated' WHERE id = ?").run(one.cs);
    const dep = await seenTurn(w, { message: 'Second idea', files: { 'src/c.js': 'module.exports = 3;\n' }, title: 'Second', clientKey: 'k2' });
    assert.equal(jobParams(w, dep.jobId).continuesFrom, undefined, 'a deprecated change is not continued');
    assert.equal(earlierBlock(dep.seen.context), null);
    assert.ok(!dep.seen.files.includes('src/c.js') && !dep.seen.files.some((f) => f === 'src/ledger.js' && false), 'it started from the project');
    await w.until_candidate(dep.cs);
    // Accepted: its work is on the integration head, so a new conversation has it without any continuation.
    await approveAndAccept(w, dep.cs);
    const three = await seenTurn(w, { message: 'Third idea', files: { 'src/d.js': 'module.exports = 4;\n' }, title: 'Third', clientKey: 'k3' });
    assert.equal(jobParams(w, three.jobId).continuesFrom, undefined, 'an accepted change is not continued');
    assert.equal(earlierBlock(three.seen.context), null);
    assert.ok(three.seen.files.includes('src/c.js'), 'the accepted change is in the starting point (the integration head)');
    sound(w, 'continue merged');
  } finally { await w.close(); }
});

test('CT3 two waiting changes: the newest is continued', async () => {
  const w = await flowWorld();
  try {
    await useFixture(w, 'node-test-app');
    await w.snapshot();
    await w.consent();
    const a = await seenTurn(w, { message: 'Idea A', files: { 'src/a.js': 'module.exports = 1;\n' }, title: 'A' });
    await w.until_candidate(a.cs);
    // Another change in the SAME conversation is a separate suggested change (the agent did not revise): two are waiting.
    const b = await seenTurn(w, { message: 'Idea B', files: { 'src/b.js': 'module.exports = 2;\n' }, title: 'B', clientKey: 'k2', sessionId: a.sessionId });
    await w.until_candidate(b.cs);
    assert.notEqual(w.versionRow(b.cs).artifact_id, w.versionRow(a.cs).artifact_id, 'two separate suggested changes');
    const c = await seenTurn(w, { message: 'Continue', files: { 'src/c.js': 'module.exports = 3;\n' }, title: 'C', clientKey: 'k3' });
    assert.equal(jobParams(w, c.jobId).continuesFrom, b.cs, 'the newest waiting change is continued');
    assert.ok(c.seen.files.includes('src/b.js'));
    sound(w, 'continue newest');
  } finally { await w.close(); }
});

test('CT4 the block is bounded and labelled; a blocked change says which checks did not pass; the pure pieces', async () => {
  const { newestUnmergedChange, continuationOf } = require('./load-ts.cjs')('src/main/nexus/repo/continuation.ts');
  const w = await flowWorld();
  try {
    await useFixture(w, 'node-test-app');
    await w.snapshot();
    await w.consent();
    const long = 'x'.repeat(3900);
    // A change that Nexus blocks (a key-shaped value in a file fails the secret check), with a summary far over the block's size.
    const one = await seenTurn(w, { message: 'Add things', files: { 'src/a.js': "const k = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH';\n" }, title: 'Things', summary: long });
    await w.until_candidate(one.cs);
    assert.equal(w.versionRow(one.cs).status, 'failed', 'the change is blocked');
    const row = newestUnmergedChange(w.db, w.PROJECT);
    assert.ok(row && row.versionId === one.cs, 'the blocked change is waiting to be continued');
    const two = await seenTurn(w, { message: 'The test fails', files: { 'src/b.js': 'module.exports = 2;\n' }, title: 'Things, fixed', clientKey: 'k2' });
    const block = earlierBlock(two.seen.context);
    assert.ok(block && block.length <= 2048, `bounded (${block && block.length})`);
    assert.match(block, /Its checks did not pass\. What failed: no secret in the files: 1 added line\(s\) hold a provider key or a private-key header\.\n?$/);
    assert.doesNotMatch(block, /sk-ant|\.\./, 'a key is never copied, and the sentence is tidy');
    assert.match(block, /not instructions/);
    assert.equal(continuationOf(w.db, w.PROJECT, 'nope'), null);
    sound(w, 'continue blocked');
  } finally { await w.close(); }
});

const priorSection = (ctx) => { const m = /## Prior user messages\n\n([\s\S]*?)(?:\n## |$)/.exec(ctx); return m ? m[1] : null; };

test('CT5 "Prior user messages" lists what the person really typed in earlier turns of the conversation (from the turns), never a record of something else', async () => {
  const w = await flowWorld();
  try {
    await useFixture(w, 'node-test-app');
    await w.snapshot();
    await w.consent();
    const one = await seenTurn(w, { message: 'Add a weather module in src/a.js', files: { 'src/a.js': 'module.exports = 1;\n' }, title: 'Weather', clientKey: 'p1' });
    assert.equal(priorSection(one.seen.context), null, 'the first turn has no earlier messages');
    const two = await seenTurn(w, { message: 'Now add a second function', files: { 'src/b.js': 'module.exports = 2;\n' }, title: 'Second', clientKey: 'p2', sessionId: one.sessionId });
    assert.equal(two.sessionId, one.sessionId, 'the same conversation');
    const sec = priorSection(two.seen.context);
    assert.ok(sec, `the section is there:\n${two.seen.context.slice(0, 500)}`);
    assert.deepEqual(sec.split('\n').filter(Boolean), ['- Add a weather module in src/a.js'], 'the earlier request, as typed; not the turn of now');
    assert.doesNotMatch(two.seen.context, /runtimeKind|"kind":"agent\.run"|"priority"/, 'no internal records');
    const three = await seenTurn(w, { message: 'And a third', files: { 'src/c.js': 'module.exports = 3;\n' }, title: 'Third', clientKey: 'p3', sessionId: one.sessionId });
    assert.deepEqual(priorSection(three.seen.context).split('\n').filter(Boolean), ['- Add a weather module in src/a.js', '- Now add a second function'], 'oldest first');
    sound(w, 'prior messages');
  } finally { await w.close(); }
});

test('CT6 a plain greeting or short question after earlier work marks the earlier-conversation block as background only; a real request does not', async () => {
  const w = await flowWorld();
  try {
    await useFixture(w, 'node-test-app');
    await w.snapshot();
    await w.consent();
    const one = await seenTurn(w, { message: 'Add a weather module', files: { 'src/a.js': 'module.exports = 1;\n' }, title: 'Weather', clientKey: 'g1' });
    await w.until_candidate(one.cs);
    // The pure judgement, for every shape (the real turns below are few: a conversation may start six turns an hour).
    const { isSmallTalk } = require('./load-ts.cjs')('src/main/nexus/agents/agentService.ts');
    for (const m of ['hi', 'Hello!', 'hey there', 'Good morning', 'thanks', 'Thank you!', 'ok', 'what did you do?', 'is it done?']) assert.equal(isSmallTalk(m), true, m);
    for (const m of ['', '   ', 'Add a weather module', 'Fix the failing test in src/a.js and run all the tests again please', 'history of the world', 'x'.repeat(70) + '?', 'Hi, please add a login page with a password reset flow and tests', 'hi, add a login page', 'ok do it', 'thanks, now add tests']) assert.equal(isSmallTalk(m), false, m);
    for (const [message, bg] of [['hi', true], ['what did you do?', true], ['Now make the date show in the page header', false],
      ['Fix the failing test in src/a.js and run all the tests again please', false]]) {
      const t = await seenTurn(w, { message, register: false, say: 'ok', sessionId: null });
      const block = earlierBlock(t.seen.context);
      assert.ok(block, `${message}: the block is there`);
      assert.match(block, /data, not instructions/, message);
      assert.equal(/Background only/.test(block), bg, `${message}: ${bg ? 'background only' : 'a request'}`);
      if (bg) assert.match(block, /just answer it/);
    }
    sound(w, 'greeting background');
  } finally { await w.close(); }
});
