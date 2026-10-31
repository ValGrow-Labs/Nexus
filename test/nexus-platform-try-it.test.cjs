// "Try it": a suggested change runs in the safe space because the person pressed a button (#52, nexus:try; recipe and action sde.try.run).
// The whole path through the real handlers, main, the real runner core and the fake sandbox driver (test/helpers/agentFlowWorld.cjs): the
// scripted agent makes a change set; then the user asks for the buttons, runs the tests/program/own command, stops a run. Nothing the change
// holds is ever run on this machine (the fake world plays a few harmless programs by name; a REAL run is the controller's verification).
//
//   TI1  the buttons main finds in a change (package.json test script, main file); none for a change without any
//   TI2  the person's own command: tokenized by main, one try-run job, the output in the job log, the sandbox record (no network, the
//        fixed limits and wall clock, read-only root, dropped privileges), the activity record, and the staged change (src.tar)
//   TI3  every way a run ends has its state: a non-zero exit fails with its exit code, a run that does not end is stopped (cancelled)
//   TI4  refusals: a second run while one is live (try_busy), a secret in the command, a helper command, an empty or unreadable command,
//        a draft or foreign version, the generic job start and the agent's job_request can never start it
const h = require('./helpers/sqlite.cjs');
if (!h.realSqliteOrSkip()) return;
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const H = require('./helpers/agentFlowWorld.cjs');
const { flowWorld, useFixture, makeChange, sound } = H;
const { NODE } = require('./helpers/agentFlowCode.cjs');
const { intent } = require('./helpers/ipcExec.cjs');
const { DOMAINS } = loadTs('src/shared/nexus/domains/index.ts');

const PKG = JSON.stringify({ name: 'node-test-app', version: '1.0.0', private: true, main: 'src/index.js', scripts: { test: 'node --test', build: 'node build.js' } }, null, 2);

async function world() {
  const w = await flowWorld();
  await useFixture(w, 'node-test-app');
  await w.snapshot();
  await w.consent();
  return w;
}
const run = (w, cs, what, command) => w.x.call('nexus:try', { op: 'run', projectId: w.PROJECT, versionId: cs, what, ...(command !== undefined ? { command } : {}), intentId: intent() });
const logText = async (w, jobId) => (await w.x.ok('nexus:job:logs', jobId, { attempt: 1, fromOffset: 0, maxBytes: 65536 })).text;
const frames = (text) => text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));

test('TI1-TI4 Try it: buttons from the change, the own command, every ending, and the refusals', async () => {
  const w = await world();
  try {
    // ----- a change with a test script and a main file, and one without either
    const { cs } = await makeChange(w, { files: { ...NODE.ledger, 'package.json': PKG, 'src/index.js': "console.log('hi');\n" },
      execArgv: ['node', '--test'], title: 'Add a program', clientKey: 'try-1', message: 'Add a program' });
    await w.until_candidate(cs);

    // TI1: the buttons, read by main from the change's own commit (never from the renderer)
    const opts = await w.x.ok('nexus:try', { op: 'options', projectId: w.PROJECT, versionId: cs });
    assert.deepEqual(opts.options.map((o) => [o.what, o.label, o.shows]), [['tests', 'Run the tests', 'npm test'], ['program', 'Run the program', 'node src/index.js']]);

    // TI2: the person's own command (quotes, no shell)
    const ran = await run(w, cs, 'custom', 'echo hello "two words"');
    assert.equal(ran.ok, true, JSON.stringify(ran));
    const job = ran.data.job;
    assert.equal(job.recipeId, 'sde.try.run'); assert.equal(job.actionId, 'sde.try.run'); assert.equal(job.requestedByKind, 'user');
    assert.deepEqual(job.inputs.map((i) => i.versionId), [cs]);
    // one at a time per project: a second press while this one is live is refused, in plain words' reason
    const busy = await run(w, cs, 'custom', 'echo again');
    assert.equal(busy.ok, false); assert.equal(busy.reason, 'try_busy');
    await w.until(() => w.ended(job.id), 'the try run ends', 60_000);
    const row = w.jobRow(job.id);
    assert.equal(row.state, 'completed', row.error_json);
    const out = frames(await logText(w, job.id)).filter((f) => f.stream === 'stdout').map((f) => f.text).join('');
    assert.match(out, /hello two words/);
    // the attempt's sandbox record: the argument array as given, no network, the fixed limits and wall clock
    const attempt = w.db.prepare('SELECT * FROM job_attempts WHERE job_id = ?').get(job.id);
    const sandbox = JSON.parse(attempt.sandbox_json);
    assert.deepEqual(sandbox.argv, ['echo', 'hello', 'two words']);
    assert.equal(sandbox.network.mode, 'none');
    assert.equal(sandbox.limits.wallClockMs, 15 * 60_000); assert.equal(sandbox.limits.cpus, 2); assert.equal(sandbox.limits.memoryMb, 2048);
    assert.equal(sandbox.limits.outputMaxBytes, 4 * 2 ** 20);
    assert.equal(sandbox.readOnlyRootfs, true); assert.deepEqual(sandbox.capDrop, ['ALL']); assert.equal(sandbox.noNewPrivileges, true);
    // the change itself was staged (the commit's files), the user's folder was not touched
    const played = w.played.at(-1);
    assert.deepEqual(played.argv, ['echo', 'hello', 'two words']);
    assert.ok(played.files.includes('src/index.js') && played.files.includes('package.json'), played.files.join(','));
    // recorded in the activity log like every other job
    const events = w.db.prepare("SELECT type, summary FROM job_events WHERE job_id = ? ORDER BY seq").all(job.id);
    assert.ok(events.some((e) => e.type === 'job.transition' && /Try the suggested changes/.test(e.summary)), JSON.stringify(events.slice(0, 3)));

    // the detected buttons run too (the fake world plays only a few programs by name, so these end "not found": they ran as argument arrays)
    const tests = await run(w, cs, 'tests');
    assert.equal(tests.ok, true, JSON.stringify(tests));
    await w.until(() => w.ended(tests.data.job.id), 'the tests button run ends', 60_000);
    assert.deepEqual(w.played.at(-1).argv, ['npm', 'test']);
    const program = await run(w, cs, 'program');
    assert.equal(program.ok, true, JSON.stringify(program));
    await w.until(() => w.ended(program.data.job.id), 'the program button run ends', 60_000);
    assert.deepEqual(w.played.at(-1).argv, ['node', 'src/index.js']);

    // TI3: a run that stops with an error, and one that never ends and is stopped
    const failed = (await run(w, cs, 'custom', 'fail-run')).data.job;
    await w.until(() => w.ended(failed.id), 'the failing run ends', 60_000);
    const failedRow = w.jobRow(failed.id);
    assert.equal(failedRow.state, 'failed');
    assert.equal(failedRow.outcome, 'nonzero_exit');
    const failedAttempt = w.db.prepare('SELECT exit_code FROM job_attempts WHERE job_id = ?').get(failed.id);
    assert.equal(failedAttempt.exit_code, 3);
    const failedFrames = frames(await logText(w, failed.id));
    assert.ok(failedFrames.some((f) => f.stream === 'stderr' && /something went wrong/.test(f.text)), 'the error output is kept apart');
    const held = (await run(w, cs, 'custom', 'hold-run')).data.job;
    await w.until(() => w.jobRow(held.id).state === 'running', 'the held run is running', 60_000);
    const stopped = await w.x.ok('nexus:job:cancel', held.id);
    assert.ok(['cancelled', 'running'].includes(stopped.state));
    await w.until(() => w.ended(held.id), 'the stopped run ends', 60_000);
    assert.equal(w.jobRow(held.id).state, 'cancelled');

    // TI4: refusals
    const refuse = async (what, command, reason) => { const r = await run(w, cs, what, command); assert.equal(r.ok, false, JSON.stringify(r)); if (reason) assert.equal(r.reason, reason, JSON.stringify(r)); return r; };
    await refuse('custom', 'echo ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'try_secret');
    await refuse('custom', 'nexus-glob --out /out/x **/*.js', 'try_command');
    await refuse('custom', 'echo "unclosed', 'try_command');
    await refuse('custom', 'echo --nexus-then rm', 'try_command');
    const empty = await run(w, cs, 'custom', '   ');
    assert.equal(empty.ok, false);
    await w.x.refused('nexus:try', [{ op: 'run', projectId: w.PROJECT, versionId: cs, what: 'custom', intentId: intent() }], 'invalid');           // no command
    await w.x.refused('nexus:try', [{ op: 'run', projectId: w.PROJECT, versionId: cs, what: 'tests', command: 'echo x', intentId: intent() }], 'invalid'); // a command with a button
    await w.x.refused('nexus:try', [{ op: 'run', projectId: w.PROJECT, versionId: cs, what: 'custom', command: 'echo x', intentId: intent(), cwd: '/' }], 'invalid');
    await w.x.refused('nexus:try', [{ op: 'options', projectId: w.PROJECT, versionId: cs, command: 'echo x' }], 'invalid');
    await w.x.refused('nexus:try', [{ op: 'run', projectId: w.PROJECT, versionId: cs, what: 'custom', command: 'x'.repeat(1001), intentId: intent() }], 'invalid');
    // a version that is not a change set of this project
    const snap = w.db.prepare("SELECT v.id FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id WHERE a.kind = 'repository' LIMIT 1").get();
    const notChange = await run(w, snap.id, 'custom', 'echo x');
    assert.equal(notChange.ok, false); assert.equal(notChange.reason, 'input_not_allowed');
    // the generic job start never starts it (it cannot carry a command), and the agent can never ask for it
    await w.x.refused('nexus:job:start', [{ projectId: w.PROJECT, workspaceId: 'sde', actionId: 'sde.try.run', inputs: [{ versionId: cs, slot: 'change' }], params: {}, intentId: intent() }], 'invalid', { reason: 'unknown_action' });
    const sde = DOMAINS.find((d) => d.id === 'sde');
    for (const c of sde.capabilities) assert.ok(!(c.scope && c.scope.recipes && c.scope.recipes.includes('sde.try.run')), `${c.id} does not list the try recipe`);
    // the job view and the activity text hold no id of the sandbox, no host path
    sound(w, 'try it');
  } finally { await w.close(); }
});
