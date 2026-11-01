'use strict';
// The earlier-conversation block of a turn that continues an earlier suggested change: "Prior user messages" lists what the person really typed, and a greeting or short question marks it as background only. Split from nexus-platform-agent-continue so each file stays well under the runner's per-file time limit. Fake sandbox, real git, real SQLite (test:db).
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
