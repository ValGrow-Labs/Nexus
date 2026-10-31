// "Try it": the pure parts (command reading, the buttons a change gets, the plain states and output) and the source pins of the wiring.
// The flow through main and the sandbox is test/nexus-platform-try-it.test.cjs (real SQLite, the fake sandbox driver).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const T = loadTs('src/shared/nexus/tryRun.ts');
const M = loadTs('src/renderer/src/nexus/project/tryModel.ts');
const PB = loadTs('src/main/nexus/exec/planBuilder.ts');
const { RECIPES, getRecipe } = loadTs('src/shared/nexus/recipes.ts');
const { USER_ACTIONS, getUserAction } = loadTs('src/shared/nexus/actions.ts');
const { DOMAINS } = loadTs('src/shared/nexus/domains/index.ts');
const ENV = loadTs('src/main/nexusIpc/envelope.ts');
const E = loadTs('src/renderer/src/nexus/data/errorCopy.ts');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const VENDOR = /claude|anthropic|hermes|sonnet|opus|haiku|openai|gpt-|docker/i;

test('TR1 a typed command becomes an argument array: quotes, no shell; everything else is refused', () => {
  const ok = (text) => { const r = T.tokenizeCommand(text); assert.equal(r.ok, true, text); return r.argv; };
  assert.deepEqual(ok('npm test'), ['npm', 'test']);
  assert.deepEqual(ok('  node   src/index.js  '), ['node', 'src/index.js']);
  assert.deepEqual(ok('node -e "console.log(require(\'./src\').isPrime(7))"'), ['node', '-e', "console.log(require('./src').isPrime(7))"]);
  assert.deepEqual(ok("echo 'a  b' \"c d\" e"), ['echo', 'a  b', 'c d', 'e']);
  assert.deepEqual(ok('echo "say \\"hi\\" \\\\ now"'), ['echo', 'say "hi" \\ now']);
  // shell characters are letters of an argument: nothing is ever interpreted
  assert.deepEqual(ok('echo a | b && c > d $(x) *'), ['echo', 'a', '|', 'b', '&&', 'c', '>', 'd', '$(x)', '*']);
  const why = (text) => { const r = T.tokenizeCommand(text); assert.equal(r.ok, false, String(text)); return r.reason; };
  assert.equal(why(''), 'empty'); assert.equal(why('   '), 'empty'); assert.equal(why(undefined), 'empty'); assert.equal(why(42), 'empty');
  assert.equal(why('echo "open'), 'quote'); assert.equal(why("echo 'open"), 'quote');
  assert.equal(why('echo a\nrm -rf /'), 'bad_text'); assert.equal(why('echo \u0000'), 'bad_text'); assert.equal(why('echo \u0007'), 'bad_text');
  assert.equal(why('x'.repeat(T.TRY_COMMAND_MAX_CHARS + 1)), 'too_long');
  assert.equal(why(`echo ${'a'.repeat(T.TRY_ARG_MAX_CHARS + 1)}`), 'too_long');
  assert.equal(why(Array.from({ length: T.TRY_MAX_ARGS + 1 }, () => 'a').join(' ')), 'too_many');
  assert.equal(why('echo --nexus-then rm'), 'bad_text');
  assert.equal(why('echo ""'), 'bad_text', 'an empty argument is refused');
  assert.equal(why('nexus-glob --out /out/x **/*.js'), 'helper');
  assert.equal(why('nexus-collect --from a --to /out/b'), 'helper');
  assert.equal(T.checkTryArgv([]).ok, false); assert.equal(T.checkTryArgv('npm test').ok, false); assert.equal(T.checkTryArgv(['a', '']).ok, false);
  assert.deepEqual(T.checkTryArgv(['npm', 'test']), { ok: true, argv: ['npm', 'test'] });
  assert.equal(T.checkTryArgv(['node', '--nexus-then']).ok, false);
});

test('TR2 the buttons a change gets come from what it holds; a button with no command is not offered', () => {
  const o = (packageJson, has = []) => T.tryOptions({ packageJson, has }).map((x) => [x.what, x.label, x.shows]);
  assert.deepEqual(o({ scripts: { test: 'node --test', start: 'node server.js' } }), [['tests', 'Run the tests', 'npm test'], ['program', 'Run the program', 'npm start']]);
  assert.deepEqual(o({ main: 'src/app.js', scripts: { test: 'jest' } }, ['package.json', 'src/app.js']), [['tests', 'Run the tests', 'npm test'], ['program', 'Run the program', 'node src/app.js']]);
  assert.deepEqual(o({ main: './src/app.js' }, ['src/app.js']), [['program', 'Run the program', 'node src/app.js']], 'a leading ./ is dropped');
  assert.deepEqual(o({}, ['src/index.js']), [['program', 'Run the program', 'node src/index.js']]);
  assert.deepEqual(o({}, ['index.js']), [['program', 'Run the program', 'node index.js']]);
  assert.deepEqual(o({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }), [], 'the npm placeholder is not a test');
  assert.deepEqual(o({ scripts: { build: 'x' } }), [], 'a build script is not a button');
  assert.deepEqual(o({ main: '../outside.js' }, ['../outside.js']), [], 'a main file outside the project is never offered');
  assert.deepEqual(o({ main: '-e' }, ['-e']), [], 'a main that looks like an option is never offered');
  assert.deepEqual(o({ main: 'src/gone.js' }, []), [], 'a main file that is not in the change is not offered');
  assert.deepEqual(o(null, ['requirements.txt', 'tests', 'main.py']), [['tests', 'Run the tests', 'python -m pytest -q -p no:cacheprovider'], ['program', 'Run the program', 'python main.py']]);
  assert.deepEqual(o(null, ['pyproject.toml', 'app.py']), [['program', 'Run the program', 'python app.py']]);
  assert.deepEqual(o(null, []), []);
  for (const x of T.tryOptions({ packageJson: { scripts: { test: 't', start: 's' } }, has: [] })) assert.deepEqual(T.checkTryArgv(x.argv), { ok: true, argv: x.argv });
});

test('TR3 every state of a try run has its own plain words, and a run never stays "running" once it ended', () => {
  const NOW = 1_800_000_000_000;
  const job = (o = {}) => ({ state: 'queued', headline: 'queued', outcome: null, startedAt: null, finishedAt: null, createdAt: NOW - 5000, cancelRequested: false, ...o });
  const v = (j, extra = {}) => M.tryView({ job: j, exitCode: null, setup: false, now: NOW, ...extra });
  assert.equal(v(null).state, 'idle');
  assert.deepEqual([v(null, { setup: true }).state, v(null, { setup: true }).headline], ['setup', M.TRY_SETUP_TEXT]);
  const starting = v(job());
  assert.deepEqual([starting.state, starting.live, starting.canStop], ['starting', true, true]);
  assert.equal(v(job({ headline: 'waiting:docker' })).state, 'setup');
  assert.equal(v(job({ headline: 'waiting:image' })).state, 'setup');
  const running = v(job({ state: 'running', headline: 'running', startedAt: NOW - 65_000 }));
  assert.deepEqual([running.state, running.live, running.canStop, running.headline, running.detail], ['running', true, true, 'Running in the safe space…', 'Running for 1 minute 5 seconds.']);
  assert.equal(v(job({ state: 'running', startedAt: NOW - 1000, cancelRequested: true })).headline, 'Stopping…');
  const done = v(job({ state: 'completed', outcome: 'completed', startedAt: NOW - 4000, finishedAt: NOW - 1000 }));
  assert.deepEqual([done.state, done.headline, done.detail, done.live, done.ended], ['done', 'It ran and finished fine.', 'It took 3 seconds.', false, true]);
  const err = v(job({ state: 'failed', outcome: 'nonzero_exit', startedAt: NOW - 3000, finishedAt: NOW - 1000 }), { exitCode: 3 });
  assert.deepEqual([err.state, err.headline, err.detail], ['failed', 'It stopped with an error.', 'It ran for 2 seconds. Its exit code was 3.']);
  assert.equal(v(job({ state: 'failed', outcome: 'oom', startedAt: NOW - 3000, finishedAt: NOW })).state, 'failed');
  assert.equal(v(job({ state: 'failed', outcome: 'image_missing', startedAt: NOW - 3000, finishedAt: NOW })).state, 'could_not_run');
  assert.equal(v(job({ state: 'timed_out', outcome: 'timed_out', startedAt: NOW - 900_000, finishedAt: NOW })).state, 'timeout');
  assert.equal(v(job({ state: 'cancelled', startedAt: NOW - 3000, finishedAt: NOW })).headline, 'You stopped it.');
  assert.equal(v(job({ state: 'interrupted', startedAt: NOW - 3000, finishedAt: NOW })).state, 'interrupted');
  // every possible job state lands in a state that is either live (Stop) or ended: nothing is stuck
  for (const state of ['queued', 'leased', 'running', 'awaiting_approval', 'retry_scheduled', 'completed', 'partial', 'failed', 'cancelled', 'timed_out', 'interrupted']) {
    const x = v(job({ state, startedAt: NOW - 1000, finishedAt: ['queued', 'leased', 'running', 'awaiting_approval', 'retry_scheduled'].includes(state) ? null : NOW }));
    assert.ok(x.live || x.ended, state);
    assert.equal(x.canStop, x.live, state);
  }
  assert.equal(M.tryDuration(400), 'under a second'); assert.equal(M.tryDuration(1000), '1 second'); assert.equal(M.tryDuration(120_000), '2 minutes'); assert.equal(M.tryDuration(null), null);
  // plain words: no id, hash or vendor word in any sentence
  const all = [M.TRY_INTRO, M.TRY_SETUP_TEXT, M.TRY_NO_BUTTONS, M.TRY_NO_OUTPUT, M.TRY_OWN_HINT, starting.headline, running.headline, done.headline, err.headline].join(' ');
  assert.doesNotMatch(all, VENDOR);
  assert.doesNotMatch(all, /[0-9a-f]{12}|sha256|\bid\b/i);
});

test('TR4 the output panel shows what the program printed and its errors apart, never Nexus\'s own notes', () => {
  const frame = (stream, text, extra = {}) => JSON.stringify({ ts: 1, stream, text, ...extra });
  const text = [frame('stdout', 'true\n'), frame('stderr', 'warning: x\n'), frame('nexus', 'container 1234 started'), frame('stdout', 'false'), 'not a frame'].join('\n');
  const out = M.tryOutput(text);
  assert.deepEqual(out.lines.map((l) => [l.stream, l.text]), [['stdout', 'true'], ['stderr', 'warning: x'], ['stdout', 'false']]);
  assert.equal(out.cutMiddle, false);
  assert.equal(M.tryOutput(frame('stdout', '…', { truncatedMiddle: true })).cutMiddle, true);
  assert.deepEqual(M.tryOutput('').lines, []);
});

test('TR5 the recipe and the action: the same sandbox as a test run, no network, fixed limits, started only by its own request', () => {
  const r = getRecipe('sde.try.run');
  assert.ok(r);
  assert.deepEqual([r.executor, r.network, r.profiles, r.argvTemplates, r.parsers, r.produces, r.retry], ['tool', 'none', ['sde-node', 'sde-python'], ['try.run'], [], [], { idempotent: false, maxAttempts: 1 }]);
  const t = getRecipe('sde.test.node');
  assert.equal(r.wallClockMs, t.wallClockMs, 'the same wall clock as a test run');
  assert.deepEqual([r.limits.cpus, r.limits.memoryMb], [t.limits.cpus, t.limits.memoryMb]);
  assert.ok(r.limits.outputMaxBytes <= t.limits.outputMaxBytes, 'the output cap is never larger than a test run');
  assert.deepEqual(Object.keys(r.params.properties), [], 'the job start carries no parameter for it');
  const a = getUserAction('sde.try.run');
  assert.deepEqual([a.domain, a.run, a.inputs.map((i) => [i.slot, i.kinds, i.min, i.max]), Object.keys(a.params.properties)], ['sde', { recipes: ['sde.try.run'] }, [['change', ['change_set'], 0, 1]], []]);
  assert.ok(a.prerequisites.includes('docker') && a.prerequisites.includes('git'));
  const sde = DOMAINS.find((d) => d.id === 'sde');
  assert.ok(sde.recipes.includes('sde.try.run') && sde.actions.includes('sde.try.run'));
  assert.ok(sde.lifecycle.find((s) => s.id === 'review').via.some((v) => v.userAction === 'sde.try.run'));
  // the agent can never request it: no capability scope of any domain names it
  for (const d of DOMAINS) for (const c of d.capabilities) assert.ok(!(c.scope && c.scope.recipes && c.scope.recipes.includes('sde.try.run')), `${d.id} ${c.id}`);
  assert.equal(USER_ACTIONS.filter((x) => x.id === 'sde.try.run').length, 1);
  // the plan: the lease checks the argument array again; a template holds nothing of its own
  assert.deepEqual(PB.ARGV_TEMPLATES['try.run'], []);
  assert.deepEqual(PB.expandArgv(r, null, [], { argv: ['node', '-e', 'console.log(1)'] }), ['node', '-e', 'console.log(1)']);
  for (const bad of [undefined, {}, { argv: 'npm test' }, { argv: [] }, { argv: [''] }, { argv: ['nexus-glob'] }, { argv: ['a', '--nexus-then', 'b'] }, { argv: ['a', 'b\0'] }, { argv: Array(33).fill('a') }, { argv: ['a'.repeat(513)] },
    { argv: ['echo', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'] }]) {
    assert.throws(() => PB.tryRunArgv(bad), (e) => e && e.code === 'invalid', JSON.stringify(bad)?.slice(0, 60));
  }
  assert.ok(PB.plannedRecipeIds(RECIPES).includes('sde.try.run'));
});

test('TR6 the wiring: one request, no shell, no auto-run, in the right place on the review page, plain sentences mirrored word for word', () => {
  const ipc = read('src/main/nexusIpc/registerNexusIpc.ts');
  assert.match(ipc, /reg\('nexus:try'/);
  assert.match(ipc, /NEXUS_TRY_CHANNELS: readonly string\[\] = Object\.freeze\(\['nexus:try'\]\)/);
  // the handler passes the command text to main's tokenizer only; the renderer never sends an argument array or an image, a network or a folder
  const handler = ipc.slice(ipc.indexOf("reg('nexus:try'"), ipc.indexOf('// ---------- B2b Task 14'));
  assert.match(handler, /V\.object\(args\[0\], \['op', 'projectId', 'versionId', 'what', 'command', 'intentId'\]/);
  assert.doesNotMatch(handler, /argv|image|network|cwd|path/i);
  const svc = read('src/main/nexus/exec/executionService.ts');
  assert.match(svc, /if \(action\.id === TRY_ACTION_ID\) return invalid\('unknown_action', 'a try run is started through its own request'\)/, 'the generic job start refuses it');
  assert.match(svc, /startTry\(p: Principal/); assert.match(svc, /async tryStart\(p: Principal/); assert.match(svc, /async tryOptions\(p: Principal/);
  assert.match(svc, /reason: 'try_busy'/, 'one at a time per project');
  assert.match(svc, /requireActiveParticipation\(this\.access, this\.db, p, r\.projectId, 'sde', 'job\.create'\)/);
  assert.match(svc, /tryRunArgv\(\{ argv: \[\.\.\.r\.argv\] \}\)/, 'checked again before the job is written');
  // a try run is a record-only job (its record is its own attempt): the list is exactly these four
  assert.match(svc, /RECORD_ONLY_RECIPES: readonly string\[\] = Object\.freeze\(\['repo\.worktree', 'changeset\.accept_rollback', 'repo\.ff', 'sde\.try\.run'\]\)/);
  // the argument array runs as given: the plan appends it to an empty template, never through a shell
  const pb = read('src/main/nexus/exec/planBuilder.ts');
  assert.match(pb, /if \(id === 'try\.run'\) out\.push\(\.\.\.tryRunArgv\(params\)\);/);
  assert.doesNotMatch(read('src/shared/nexus/tryRun.ts'), /child_process|exec\(|spawn|eval\(|new Function/);
  // the renderer: TryIt sits between the proof and "What changed"; nothing runs unless a button or the form is pressed
  const review = read('src/renderer/src/nexus/project/ChangeSetReview.tsx');
  assert.ok(review.indexOf('<h3 className="nx-cs__sub">Proof</h3>') < review.indexOf('<TryIt projectId={projectId} versionId={versionId} />')
    && review.indexOf('<TryIt projectId={projectId} versionId={versionId} />') < review.indexOf('<h3 className="nx-cs__sub">What changed</h3>'));
  const comp = read('src/renderer/src/nexus/project/TryIt.tsx');
  const calls = [...comp.matchAll(/void run\(/g)].map((m) => m[0]);
  assert.equal(calls.length, 2, calls.join(' '));
  assert.ok(comp.includes("onClick={() => { void run(o.what); }}") && comp.includes("onSubmit={(e) => { e.preventDefault(); void run('custom'); }}"));
  assert.doesNotMatch(comp.slice(0, comp.indexOf('const run = async')), /tryRun\(\{\s*op: 'run'/, 'no effect starts a run');
  assert.doesNotMatch(comp.replace(/\/\*[\s\S]*?\*\//g, ''), VENDOR);
  assert.ok(comp.includes('nexusClient.jobCancel(jobId)') && comp.includes('LIVE_REFRESH_MS') && comp.includes('nexusClient.jobLogs('), 'Stop, a live read, and the one log reader');
  const stage = read('src/renderer/src/nexus/agent/BuildStage.tsx');
  assert.ok(stage.includes("view.state === 'ready' && <Button variant=\"secondary\" onClick={onReview}>Try it in the safe space first</Button>"), 'the building page links to it');
  // the sentences main words are the renderer's, word for word
  for (const k of ['try_busy', 'try_command', 'try_secret', 'try_nothing']) {
    assert.equal(typeof ENV.AGENT_REASON_MESSAGES[k], 'string', k);
    assert.equal(E.AGENT_REASON_TEXT[k], ENV.AGENT_REASON_MESSAGES[k], k);
    assert.doesNotMatch(ENV.AGENT_REASON_MESSAGES[k], VENDOR);
  }
  // main's git read is the only way the buttons are found
  assert.match(read('src/main/index.ts'), /readAtRev: async \(root, rev, rel\) => \{ const f = await getFileAtRev\(root, rev, rel\)/);
});

const RI = loadTs('src/renderer/src/nexus/agent/runIntent.ts');

test('TR7 a message that is only "run it" is a run request; every near miss stays work for the AI helper', () => {
  for (const yes of ['run', 'Run', 'run this', 'run it', 'Run it!', 'run that.', 'start it', 'start this', 'test it', 'try it', 'try this', 'Try it!!', 'run the tests', 'run tests', 'run the test',
    'please run it', 'run it please', 'Please, run this.', 'ok run it', 'run the program', 'run the app', 'start the app', 'test the project', 'try my project', '  run   it  ', 'RUN THE TESTS?', "run it, please!"]) {
    assert.equal(RI.isRunRequest(yes), true, yes);
  }
  for (const no of ['', '   ', 'run a migration that adds a column', 'add a run button', 'run the tests and fix what fails', 'run it again and then deploy', 'start', 'test', 'try',
    'please add tests', 'how do I run this', 'run this through the linter', 'rerun it', 'do not run it', 'run it in production', 'try it with a dark theme', 'runit', 'start a new project',
    'test the login page and tell me what is wrong', 'x'.repeat(200)]) {
    assert.equal(RI.isRunRequest(no), false, no || '(empty)');
  }
  assert.equal(RI.isRunRequest(undefined), false);
  assert.equal(RI.normalizeRunText('  Please, RUN it!  '), 'run it');
  assert.doesNotMatch([RI.RUN_REPLY_TEXT, RI.RUN_REPLY_BUTTON].join(' '), VENDOR);
  assert.equal(RI.RUN_REPLY_BUTTON, 'Try it');
});

test('TR8 the dock answers a run request itself (no helper turn), with one button to Try it; Try it also runs the project as it stands', () => {
  const intent = read('src/renderer/src/nexus/intent/IntentLine.tsx');
  const sendAt = intent.indexOf("if (mode === 'agent' && ctx.project && isRunRequest(text))");
  assert.ok(sendAt > 0 && sendAt < intent.indexOf("if (mode === 'agent' && ctx.project) { void sendToAgent(text, ctx.project.id); return; }"), 'the run check comes before the send to the AI helper');
  assert.match(intent, /isRunRequest\(text\)\) \{ useRunReply\.getState\(\)\.show\(ctx\.project\.id\); setDraft\(''\); setError\(null\); setSent\(null\); return; \}/, 'the words are cleared as after a send, nothing is sent');
  assert.match(intent, /setDraft\(''\); setError\(null\);\n\s+useRunReply\.getState\(\)\.clear\(\);/, 'a normal send clears the reply');
  const panel = read('src/renderer/src/nexus/agent/AgentPanel.tsx');
  assert.match(panel, /Nexus: \{RUN_REPLY_TEXT\}/, 'labelled as Nexus, never as the AI helper');
  assert.match(panel, /navigate\(\{ name: 'project', id: projectId, tool: 'try' \}\)/);
  assert.equal((panel.match(/RUN_REPLY_BUTTON/g) || []).length, 2, 'one button');
  // the project's Try it page
  const routes = loadTs('src/renderer/src/nexus/router/routes.ts');
  assert.deepEqual([...routes.PROJECT_TOOLS], ['bench', 'changes', 'completion', 'runs', 'try']);
  assert.deepEqual(routes.parseHash('#/p/proj-1/try'), { name: 'project', id: 'proj-1', tool: 'try' });
  assert.equal(routes.formatRoute({ name: 'project', id: 'proj-1', tool: 'try' }), '#/p/proj-1/try');
  assert.match(read('src/renderer/src/nexus/project/FocusSurface.tsx'), /if \(tool === 'try'\) return <ProjectTry projectId=\{project\.id\} change=\{tryChange\} \/>;/);
  assert.match(read('src/renderer/src/nexus/project/ToolRail.tsx'), /\{ tool: 'try', label: 'Try it', icon: 'rocket' \}/);
  assert.match(read('src/renderer/src/nexus/project/ProjectBench.tsx'), /canTry=\{hasSde && !card\}/);
  const pt = read('src/renderer/src/nexus/project/ProjectTry.tsx');
  assert.ok(pt.includes("<TryIt key={versionId ?? 'project'} projectId={projectId} versionId={versionId} heading={false} />"), 'one Try it panel, not a second one');
  assert.ok(pt.includes('Your project now') === false && pt.includes('TRY_PROJECT_NOW'), 'the words live in the model');
  assert.equal(M.TRY_PROJECT_NOW, 'Your project now'); assert.equal(M.TRY_CHANGE_CHOICE, 'The suggested changes');
  assert.doesNotMatch([M.TRY_PROJECT_NOTE, M.TRY_NO_COMMIT, M.TRY_PROJECT_NOW, M.TRY_CHANGE_CHOICE].join(' '), VENDOR);
  // main: the project target is the commit main reads itself, written into the job (never a renderer value), checked as a full sha at the lease
  const svc = read('src/main/nexus/exec/executionService.ts');
  assert.match(svc, /\(r\.versionId === undefined\) === \(r\.commit === undefined\)/, 'exactly one of a change or a commit');
  assert.match(svc, /params: r\.versionId !== undefined \? \{ argv \} : \{ argv, commit: r\.commit! \}/);
  assert.match(svc, /reason: 'try_no_commit'/);
  const pb = read('src/main/nexus/exec/planBuilder.ts');
  assert.match(pb, /if \(recipe\.id === 'sde\.try\.run' && !source\) refuse\('bad_input', 'a try run needs a commit to run'\);/, 'a try run never runs without a commit');
  assert.deepEqual(PB.tryRunSource({ commit: 'a'.repeat(40) }), { commit: 'a'.repeat(40) });
  assert.equal(PB.tryRunSource({}), null); assert.equal(PB.tryRunSource(undefined), null);
  for (const bad of [{ commit: 'HEAD' }, { commit: 'abc' }, { commit: 42 }, { commit: 'A'.repeat(40) }, { commit: '../..' }]) assert.throws(() => PB.tryRunSource(bad), (e) => e && e.code === 'invalid', JSON.stringify(bad));
  const a = getUserAction('sde.try.run');
  assert.deepEqual(a.inputs.map((i) => [i.slot, i.kinds, i.min, i.max]), [['change', ['change_set'], 0, 1]]);
  // #52's key set is unchanged (versionId is optional now); no folder, no revision name, no argument array from the renderer
  const handler = read('src/main/nexusIpc/registerNexusIpc.ts');
  assert.match(handler, /V\.object\(args\[0\], \['op', 'projectId', 'versionId', 'what', 'command', 'intentId'\] as const, \['versionId', 'what', 'command', 'intentId'\] as const\)/);
  for (const k of ['try_no_commit']) assert.equal(E.AGENT_REASON_TEXT[k], ENV.AGENT_REASON_MESSAGES[k], k);
});
