#!/usr/bin/env node
'use strict';
/**
 * The local-model showcase (never part of any test run): a REAL local model builds a small product through the REAL Nexus pipeline.
 *
 *   node tools/nexus-demo-local-model.cjs --go --out <folder> [--model qwen2.5-coder:7b] [--brief "<text>"] [--url http://127.0.0.1:11434] [--max-turns 3]
 *
 * What is real: the Ollama server at --url (loopback only), the local-model adapter (src/runner/runtimes/localModel/), main on a real
 * SQLite database in a temp data home, the runner core, the loopback MCP server, REAL Docker with the pinned sde-node image
 * (sandbox_exec and cs.tests_pass run for real, network none), review, accept and the merge into a temp repository. The only fake is
 * the user's merge confirmation dialog, answered "Merge" at its show seam (test/helpers/agentFlowWorld.cjs, as in the flows).
 * What it does: asks the model (a normal Nexus turn) for the brief; if cs.tests_pass fails (or the turn registers nothing) it sends the
 * failing summary back as the next turn (the iteration, up to --max-turns), then approves, accepts and merges through the real
 * handlers, copies the merged product to --out and writes an honest transcript next to it (<out>-transcript.json and .md).
 *
 * Refuses to start unless: --go is given (so no tool or agent runs it by accident); --url is a loopback address; the resource preflight
 * of tools/run-exec-tests.cjs passes (Docker running, pinned images, free disk); --out does not exist or is empty. Nothing is sent
 * anywhere but the loopback model server. Exit 0: merged; 1: ran but no merged product (the transcript says why); 2: refused; 3: preflight not ok.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_BRIEF = 'Build a small, dependency-free Node.js todo-list library in src/todo.js: createTodoList() returns an object with add(title) (returns the new item {id, title, done:false}), complete(id), remove(id), list({done}) (optionally filtered by done) and clear(). It must throw a TypeError for an empty or non-string title and a RangeError for an unknown id. Write its tests with node:test in test/todo.test.js (at least six tests covering every method and both errors) and run them with sandbox_exec using ["node","--test"].';
const EXIT = Object.freeze({ OK: 0, FAILED: 1, REFUSED: 2, NOT_RUN: 3 });

function usage() {
  return 'usage: node tools/nexus-demo-local-model.cjs --go --out <folder> [--model <name>] [--brief "<text>"] [--url http://127.0.0.1:11434] [--max-turns 3]\n'
    + '  --go is required: the showcase starts real Docker containers and talks to the real local model server.\n';
}

function parseArgs(argv) {
  const o = { go: false, out: null, model: 'qwen2.5-coder:7b', brief: DEFAULT_BRIEF, url: 'http://127.0.0.1:11434', maxTurns: 3, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[i + 1]; i += 1; return v; };
    if (a === '--go') o.go = true;
    else if (a === '--out') o.out = val();
    else if (a === '--model') o.model = val();
    else if (a === '--brief') o.brief = val();
    else if (a === '--url') o.url = val();
    else if (a === '--max-turns') o.maxTurns = Number(val());
    else o.unknown.push(a);
  }
  return o;
}

/** The rule of the runtime's destination (R2), for the showcase: the URL names a loopback host (127.0.0.1, ::1, localhost) and a port. */
function loopbackUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'http:' || u.username || u.password) return null;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!(host === '127.0.0.1' || host === '::1' || host === 'localhost')) return null;
  const port = u.port === '' ? 80 : Number(u.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `http://127.0.0.1:${port}`;
}

/** Every refusal, in order; returns { code, lines } or null. `preflight` is injectable (tests). */
function refusal(o, preflight) {
  if (!o.go) return { code: EXIT.REFUSED, lines: ['refused: --go was not given.', usage()] };
  if (o.unknown.length > 0) return { code: EXIT.REFUSED, lines: [`refused: unknown argument ${o.unknown[0]}`, usage()] };
  if (!o.out || o.out.startsWith('--')) return { code: EXIT.REFUSED, lines: ['refused: --out <folder> is required.', usage()] };
  if (loopbackUrl(o.url) === null) return { code: EXIT.REFUSED, lines: [`refused: --url must be a loopback address (127.0.0.1, ::1 or localhost) with http: got ${JSON.stringify(o.url)}.`] };
  if (!/^[A-Za-z0-9._:/@-]{1,128}$/.test(o.model)) return { code: EXIT.REFUSED, lines: ['refused: --model is not a model name.'] };
  if (!Number.isInteger(o.maxTurns) || o.maxTurns < 1 || o.maxTurns > 6) return { code: EXIT.REFUSED, lines: ['refused: --max-turns must be 1 to 6.'] };
  if (typeof o.brief !== 'string' || o.brief.trim().length < 10 || o.brief.length > 4000) return { code: EXIT.REFUSED, lines: ['refused: --brief must be 10 to 4000 characters.'] };
  const out = path.resolve(o.out);
  if (fs.existsSync(out) && (!fs.statSync(out).isDirectory() || fs.readdirSync(out).length > 0)) return { code: EXIT.REFUSED, lines: [`refused: ${out} exists and is not an empty folder.`] };
  const pre = preflight();
  if (!pre.ok) return { code: EXIT.NOT_RUN, lines: [...pre.checks.filter((c) => !c.ok).map((c) => `NOT RUN: ${c.notRun} ${c.action}`)] };
  return null;
}

function realPreflight() { return require('./run-exec-tests.cjs').runPreflight(); }

// ---------------------------------------------------------------- the run

const MIN = 60_000;
const clip = (t, n) => { const s = String(t ?? ''); return s.length <= n ? s : `${s.slice(0, n)}...[cut]`; };
/** node:test's own totals from a run's output: `# tests N`, `# pass N`, `# fail N`. */
function testCounts(stdout) {
  const n = (k) => { const m = new RegExp(`^# ${k} (\\d+)`, 'm').exec(stdout ?? ''); return m ? Number(m[1]) : null; };
  return { tests: n('tests'), pass: n('pass'), fail: n('fail') };
}
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules' || e.isSymbolicLink()) continue;
    const a = path.join(from, e.name); const b = path.join(to, e.name);
    if (e.isDirectory()) copyTree(a, b); else if (e.isFile()) fs.copyFileSync(a, b);
  }
}

async function run(o) {
  const { flowWorld, useFixture } = require(path.join(ROOT, 'test', 'helpers', 'agentFlowWorld.cjs'));
  const { intent } = require(path.join(ROOT, 'test', 'helpers', 'ipcExec.cjs'));
  const started = Date.now();
  const out = path.resolve(o.out);
  const url = loopbackUrl(o.url);
  const T = { startedAt: new Date(started).toISOString(), model: o.model, endpoint: url, brief: o.brief, maxTurns: o.maxTurns, turns: [], changeSets: [], merge: null, result: 'running', problems: [], totals: null, wallMs: null };
  const log = (l) => console.log(`[demo] ${l}`);
  let w = null;
  try {
    log(`model ${o.model} at ${url}; real Docker; up to ${o.maxTurns} turns`);
    w = await flowWorld({ runtime: 'local-model', modelUrl: url, model: o.model, real: true });
    await useFixture(w, 'node-test-app');
    await w.snapshot();
    try { await w.consent(); } catch (e) { T.problems.push(`consent was refused: ${clip(e && e.message, 400)}`); throw new Error('the local model runtime could not be granted: is the server running and does the model support tools?'); }
    log('permission granted for the local model; the first turn starts');
    const progress = (job, kind) => w.db.prepare("SELECT json_extract(data_json, '$.tool') t FROM job_events WHERE job_id = ? AND type = 'attempt.progress' AND json_extract(data_json, '$.t') = ? ORDER BY rowid").all(job, kind).map((e) => e.t);

    let message = `${o.brief}\n\nThe project already has a src/ and a test/ folder; add your files there. When the tests pass, register the change with changeset_register.`;
    let sessionId = null; let artifactId = null; let candidate = null;
    for (let n = 1; n <= o.maxTurns && candidate === null; n++) {
      const t0 = Date.now();
      log(`turn ${n}: asking the model`);
      const turn = await w.turn(message, { sessionId, ms: 40 * MIN });
      sessionId = turn.sessionId;
      const attempt = w.db.prepare('SELECT usage_json, state FROM job_attempts WHERE job_id = ? ORDER BY n DESC LIMIT 1').get(turn.jobId);
      const usage = attempt && attempt.usage_json ? JSON.parse(attempt.usage_json) : null;
      const execs = w.execResults(turn.jobId).map((e) => ({ argv: e.argv, exit: e.exit, failed: e.failed, ...testCounts(e.stdout), tail: clip(String(e.stdout).trim().split('\n').slice(-12).join('\n'), 800) }));
      const rec = { n, state: turn.job.state, outcome: turn.job.outcome, error: turn.job.error_json ? clip(turn.job.error_json, 400) : null, tools: progress(turn.jobId, 'runtime.tool'),
        sandboxRuns: execs, tokens: usage ? { in: usage.inputTokens, out: usage.outputTokens } : null, toolCalls: usage ? usage.toolCalls : null, ms: Date.now() - t0, changeSet: null };
      T.turns.push(rec);
      log(`turn ${n}: ${rec.state}/${rec.outcome}; ${rec.tools.length} tool calls; ${execs.length} sandbox runs; ${rec.ms / 1000}s`);
      const [cs] = w.changeSetsOf(turn.jobId);
      if (!cs) {
        message = 'You did not register a change set. Finish the work: write the files with write_file, run the tests with sandbox_exec, and call changeset_register.';
        continue;
      }
      const status = await w.until_candidate(cs, 30 * MIN);
      const checks = w.checks(cs);
      const tp = w.db.prepare("SELECT summary FROM validations WHERE version_id = ? AND validator_id = 'cs.tests_pass' ORDER BY rowid DESC").get(cs);
      artifactId = w.versionRow(cs).artifact_id;
      rec.changeSet = { versionId: cs, artifactId, status, checks, testsSummary: tp ? tp.summary : null };
      T.changeSets.push(rec.changeSet);
      log(`turn ${n}: change set ${status}; ${tp ? tp.summary : 'no test summary'}`);
      if (status === 'candidate') { candidate = cs; break; }
      const lastRun = execs.length > 0 ? execs[execs.length - 1].tail : '';
      message = `The change set you registered did not pass its checks: ${JSON.stringify(checks)}. Tests: ${tp ? tp.summary : 'unknown'}.\n`
        + `Output of your last test run:\n${lastRun}\n\nFix the code or the tests, run them again with sandbox_exec, then call changeset_register again with reviseArtifactId "${artifactId}" so it becomes the next version of the same change set.`;
    }
    if (candidate === null) { T.result = 'no_candidate'; T.problems.push(`no change set reached candidate in ${T.turns.length} turns`); return T; }

    await w.x.ok('nexus:review:decide', candidate, { decision: 'approve' }, intent());
    const st0 = await w.okd('nexus:repo:status', w.PROJECT);
    const acc = await w.okd('nexus:changeSet:accept', candidate, st0.acceptedHead);
    const st1 = await w.okd('nexus:repo:status', w.PROJECT);
    await w.okd('nexus:repo:mergeAccepted', w.PROJECT, { branch: st1.branch, expectedAcceptedHead: st1.acceptedHead });
    T.merge = { commit: w.userHead(), acceptCommit: acc.accept.mergeCommit, branch: st1.branch, mergedFastForward: w.userHead() === acc.accept.mergeCommit };
    copyTree(w.repoDir, out);
    T.result = T.merge.mergedFastForward ? 'merged' : 'merge_mismatch';
    log(`merged ${T.merge.commit.slice(0, 8)}; product copied to ${out}`);
    return T;
  } catch (e) {
    T.result = 'error'; T.problems.push(clip(e && e.stack ? e.stack : e, 1500));
    return T;
  } finally {
    T.wallMs = Date.now() - started;
    T.totals = { turns: T.turns.length, toolCalls: T.turns.reduce((s, t) => s + (t.toolCalls || 0), 0), inTokens: T.turns.reduce((s, t) => s + ((t.tokens && t.tokens.in) || 0), 0), outTokens: T.turns.reduce((s, t) => s + ((t.tokens && t.tokens.out) || 0), 0) };
    if (w) { try { await w.close(); } catch { /* best effort */ } }
  }
}

function markdown(T) {
  const L = [];
  L.push(`# Nexus local-model showcase: ${T.result}`, '', `- model: \`${T.model}\` at ${T.endpoint} (real Ollama, real Docker sandbox)`, `- started: ${T.startedAt}; wall time: ${((T.wallMs || 0) / 1000).toFixed(0)} s`,
    `- turns: ${T.totals.turns} of at most ${T.maxTurns}; tool calls: ${T.totals.toolCalls}; tokens: ${T.totals.inTokens} in / ${T.totals.outTokens} out (the server's own counts; cost 0)`);
  if (T.merge) L.push(`- merge commit: \`${T.merge.commit}\` on \`${T.merge.branch}\` (fast-forward: ${T.merge.mergedFastForward})`);
  L.push('', '## Brief', '', T.brief, '', '## Turns', '');
  for (const t of T.turns) {
    L.push(`### Turn ${t.n}: ${t.state} / ${t.outcome ?? '-'}`, '', `- ${t.tools.length} tool calls: ${t.tools.join(', ') || 'none'}; ${(t.ms / 1000).toFixed(0)} s; tokens ${t.tokens ? `${t.tokens.in} in / ${t.tokens.out} out` : 'unknown'}`);
    for (const r of t.sandboxRuns) L.push(`- sandbox run \`${r.argv}\`: exit ${r.exit}${r.tests !== null ? `; tests ${r.tests}, pass ${r.pass}, fail ${r.fail}` : ''}`);
    if (t.changeSet) L.push(`- change set ${t.changeSet.versionId}: **${t.changeSet.status}**; cs.tests_pass: ${t.changeSet.testsSummary ?? 'n/a'}`);
    if (t.error) L.push(`- error: ${t.error}`);
    L.push('');
  }
  if (T.problems.length > 0) L.push('## Problems', '', ...T.problems.map((p) => `- ${clip(p, 600)}`), '');
  return L.join('\n');
}

function writeTranscript(T, o) {
  const out = path.resolve(o.out);
  const base = path.join(path.dirname(out), `${path.basename(out)}-transcript`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(`${base}.json`, `${JSON.stringify(T, null, 2)}\n`);
  fs.writeFileSync(`${base}.md`, `${markdown(T)}\n`);
  return base;
}

async function main(argv) {
  const o = parseArgs(argv);
  const refused = refusal(o, realPreflight);
  if (refused) { for (const l of refused.lines) console.error(l); return refused.code; }
  const electron = Boolean(process.versions.electron) && process.env.ELECTRON_RUN_AS_NODE === '1';
  if (!electron) {
    // better-sqlite3 is built for Electron: re-run this file under Electron-as-node (as tools/run-exec-tests.cjs runs its files).
    const r = spawnSync(require('electron'), [__filename, ...argv], { cwd: ROOT, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' });
    return r.status === null ? EXIT.FAILED : r.status;
  }
  const T = await run(o);
  const base = writeTranscript(T, o);
  console.log(`[demo] result: ${T.result}; ${T.totals.turns} turns, ${T.totals.toolCalls} tool calls, ${T.totals.inTokens}/${T.totals.outTokens} tokens, ${((T.wallMs || 0) / 1000).toFixed(0)} s`);
  console.log(`[demo] transcript: ${base}.md and ${base}.json`);
  return T.result === 'merged' ? EXIT.OK : EXIT.FAILED;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(`[demo] failed: ${e && e.message}`); process.exit(EXIT.FAILED); });
}

module.exports = { parseArgs, refusal, loopbackUrl, testCounts, markdown, DEFAULT_BRIEF, EXIT };
