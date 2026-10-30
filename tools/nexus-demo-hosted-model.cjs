#!/usr/bin/env node
'use strict';
/**
 * The hosted-model showcase (CONTROLLER ONLY: never part of any test run, never run by an implementing agent): a REAL hosted free-tier model
 * API builds a small product through the REAL Nexus pipeline, with the user's OWN API key.
 *
 *   NEXUS_DEMO_API_KEY=<the key> node tools/nexus-demo-hosted-model.cjs --go --i-accept-limits --provider <id> --out <folder>
 *       [--model <name>] [--weather | --fixture node-test-app|pytest-app] [--brief "<text>"] [--max-turns 3] [--key-env <NAME>]
 *
 * This sends the task, the project's context and the model's tool results to the provider's server under the user's own free key, and it uses
 * that key's free quota and rate limits. That is why TWO explicit flags are required (--go and --i-accept-limits).
 *
 * The KEY: it comes from an environment variable that the controller sets for this one process (default NEXUS_DEMO_API_KEY, or the name given
 * by --key-env), never from an argument (a --key argument does not exist: it is refused as unknown), never from a file. The driver reads it ONCE,
 * removes it from its own environment at once (so no child process inherits it), stores it into the scratch world's key store (the same store API
 * the app uses, over an in-memory fake safeStorage: nothing is written to disk), and never prints, logs or writes it: every text on its way into
 * the transcript is scrubbed of it (and of key-shaped strings); test/nexus-demo-hosted-model-guards.test.cjs scans this file's source for any
 * line that writes or prints the key. Scratch folders live under the temp folder only (the data home, the repository, --out's transcript).
 *
 * What is real: the provider's API, the hosted-model adapter (src/runner/runtimes/hostedModel/), main on a real SQLite database in a temp data home,
 * the runner core, the loopback MCP server, the REAL host egress proxy bound to the consent (the adapter reaches the provider ONLY through it:
 * no test seam), REAL Docker with the pinned sde-node image (sandbox_exec and cs.tests_pass run for real, network none), review, accept and
 * the merge into a temp repository. The only fake is the user's merge confirmation dialog, answered "Merge" at its show seam (as in the flows).
 * The consent is granted through #51 with the chosen provider and model and the default caps; the driver never raises them. The provider id must
 * be one the runner's own preset table lists (read through the adapter's table, not repeated here); so must the model (with tool support).
 *
 * What it records (the controller's STOP rules): every proxy decision of each turn (host:port, allowed or refused), provider requests per turn,
 * token counts as the provider reports them, wall time, and a STOP section, non-empty (exit 4) when any host other than the chosen provider's
 * host:443 was requested or refused (or decisions went unreported), when the provider rejected the key (nothing more is run), when a change
 * landed outside the turn's worktree and the scratch folders, or when the consent is not what was asked for. A STOP halts the run at once: no
 * further turn, no approve, no merge. Rate-limit waits happen inside the adapter and are not reported by it: the transcript shows how many
 * requests a turn made (a retry after a 429 or a 5xx is one more request), the wall time, and, when a turn ended on the limit, which limit.
 *
 * Refuses to start (exit 2) unless: --go AND --i-accept-limits; no unknown argument; --provider is one of the preset table's ids; --model (default:
 * the provider's own default) is one of that provider's tool-capable models; the key variable is set and is shaped like a key (the value is never
 * shown); --out does not exist or is an empty folder; no NEXUS_DB_HOLD_* variable is set; the temp data home is a scratch folder (not inside the
 * app's real userData). Exit 3: the resource preflight of tools/run-exec-tests.cjs is not ok (Docker running, pinned images, free disk).
 * Exit 0: merged and no STOP; 1: ran but no merged product; 4: STOP section non-empty.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const EXIT = Object.freeze({ OK: 0, FAILED: 1, REFUSED: 2, NOT_RUN: 3, STOP: 4 });
const MAX_TURNS_LIMIT = 4;
const DEFAULT_KEY_ENV = 'NEXUS_DEMO_API_KEY';
const KEY_ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const DEFAULT_BRIEF = 'Build a small, dependency-free Node.js todo-list library in src/todo.js: createTodoList() returns an object with add(title) (returns the new item {id, title, done:false}), complete(id), remove(id), list({done}) (optionally filtered by done) and clear(). It must throw a TypeError for an empty or non-string title and a RangeError for an unknown id. Write its tests with node:test in test/todo.test.js (at least six tests covering every method and both errors) and run them with sandbox_exec using ["node","--test"].';
const FIXTURES = Object.freeze({
  'node-test-app': { where: 'The project already has a src/ and a test/ folder; add your files there.', test: '["node","--test"]' },
  'pytest-app': { where: 'The project is a Python package: put code under src/pytest_app/ and tests under tests/ (pytest finds src automatically; import with `from pytest_app.<module> import ...`).', test: '["python","-m","pytest","-q"]' }
});
const WEATHER_BRIEF = 'Build a tiny weather-prediction model in pure Python (no numpy, no internet, standard library only) in src/pytest_app/weather.py: make_dataset(days, seed) returns a reproducible synthetic list of daily temperatures (a yearly sine wave plus seeded noise); train(series, lags=3) fits a linear model that predicts the temperature of the next day from the previous `lags` days (ordinary least squares, solved yourself, for example with gradient descent or normal equations) and returns the weights; predict(weights, last_days) returns the next-day temperature; mae(weights, series, lags=3) returns the mean absolute error. Write at least six pytest tests in tests/test_weather.py (dataset is reproducible, training reduces error versus predicting the mean, predict has the right shape, mae is non-negative, a perfect linear series is recovered, errors on too-short input) and run them with sandbox_exec using ["python","-m","pytest","-q"].';

function usage() {
  return 'usage: NEXUS_DEMO_API_KEY=<key> node tools/nexus-demo-hosted-model.cjs --go --i-accept-limits --provider <id> --out <new or empty folder>\n'
    + '         [--model <name>] [--weather | --fixture node-test-app|pytest-app --brief "<text>"] [--max-turns 1-4] [--key-env <NAME>]\n'
    + '  --go and --i-accept-limits are both required: this starts real Docker containers and sends the task and project context to the\n'
    + '  provider under your own free API key, which uses that key\'s free quota. The key is read from the environment variable named by\n'
    + '  --key-env (default NEXUS_DEMO_API_KEY); there is no key argument.\n';
}

// ---------------------------------------------------------------- the preset table, read through the runner's own file (never repeated here)

let tableCache = null;
/** The runner's own provider table: `{ providers: [{ id, defaultModel, host, port, models: [{ name, tools }] }], hosts: ['host:port', ...] }`. */
function table() {
  if (tableCache) return tableCache;
  const loadTs = require(path.join(ROOT, 'test', 'load-ts.cjs'));
  const P = loadTs('src/runner/runtimes/hostedModel/presets.ts');
  tableCache = {
    providers: P.PROVIDER_PRESETS.map((p) => ({ id: p.id, label: p.label, defaultModel: p.defaultModel, host: p.host, port: p.port, models: p.models.map((m) => ({ name: m.name, tools: m.tools })) })),
    hosts: P.allPresetHosts().map((x) => `${x.host}:${x.port}`)
  };
  return tableCache;
}
/** Whether a value has the shape of an API key (the same rule the key store applies); the value is never shown. */
function keyShaped(v) { return require(path.join(ROOT, 'test', 'load-ts.cjs'))('src/shared/nexus/hostedModel.ts').isApiKeyShape(v); }

function parseArgs(argv) {
  const o = { go: false, acceptLimits: false, out: null, provider: null, model: null, fixture: 'node-test-app', brief: null, maxTurns: 3, keyEnv: DEFAULT_KEY_ENV, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[i + 1]; i += 1; return v; };
    if (a === '--go') o.go = true;
    else if (a === '--i-accept-limits') o.acceptLimits = true;
    else if (a === '--out') o.out = val();
    else if (a === '--provider') o.provider = val();
    else if (a === '--model') o.model = val();
    else if (a === '--fixture') o.fixture = val();
    else if (a === '--weather') { o.fixture = 'pytest-app'; o.brief = WEATHER_BRIEF; }
    else if (a === '--brief') o.brief = val();
    else if (a === '--max-turns') o.maxTurns = Number(val());
    else if (a === '--key-env') o.keyEnv = val();
    else o.unknown.push(a);
  }
  if (o.brief === null) o.brief = o.fixture === 'pytest-app' ? WEATHER_BRIEF : DEFAULT_BRIEF;
  return o;
}

/** An argument as a refusal may name it: only the flag part (up to any `=`), cut short, so a value pasted into an unknown argument is never echoed. */
const argName = (a) => String(a ?? '').split('=')[0].slice(0, 40);

const inside = (child, parent) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
function realPreflight() { return require('./run-exec-tests.cjs').runPreflight(); }
/** The folders of the app's own user data (the place a scratch data home must never be). */
function realUserDataDirs() { return require('./run-exec-tests.cjs').REAL_PROBES.userDataDirs(); }

/**
 * Every refusal, in order; returns { code, lines } or null. Everything it consults is injectable (tests): `deps.env` (default: this process's
 * environment; the key variable is read for its SHAPE only and never shown, the NEXUS_DB_HOLD_* variables for their NAMES only), `deps.tmpdir`,
 * `deps.userDataDirs`, `deps.preflight`, `deps.table`. All refusals except the preflight (exit 3) are exit 2 and none starts anything.
 */
function refusal(o, deps = {}) {
  const env = deps.env || process.env;
  const tmp = (deps.tmpdir || os.tmpdir)();
  const userDataDirs = deps.userDataDirs || realUserDataDirs;
  const preflight = deps.preflight || realPreflight;
  const tbl = (deps.table || table)();
  const R = (...lines) => ({ code: EXIT.REFUSED, lines });
  if (!o.go) return R('refused: --go was not given.', usage());
  if (!o.acceptLimits) return R('refused: --i-accept-limits was not given: this run sends the task and project context to the provider under your own API key and uses its free quota.', usage());
  if (o.unknown.length > 0) return R(`refused: unknown argument ${argName(o.unknown[0])}`, usage());
  if (typeof o.provider !== 'string' || o.provider.startsWith('--') || o.provider === '') return R(`refused: --provider <id> is required; one of ${tbl.providers.map((p) => p.id).join(', ')}.`, usage());
  const prov = tbl.providers.find((p) => p.id === o.provider);
  if (!prov) return R(`refused: --provider must be one of ${tbl.providers.map((p) => p.id).join(', ')}.`);
  const model = o.model === null ? prov.defaultModel : o.model;
  if (typeof model !== 'string' || !prov.models.some((m) => m.name === model && m.tools)) return R(`refused: --model must be one of the tool-capable models of ${prov.id}: ${prov.models.filter((m) => m.tools).map((m) => m.name).join(', ')}.`);
  if (!Object.prototype.hasOwnProperty.call(FIXTURES, o.fixture)) return R(`refused: --fixture must be one of ${Object.keys(FIXTURES).join(', ')}.`);
  if (typeof o.keyEnv !== 'string' || !KEY_ENV_RE.test(o.keyEnv)) return R('refused: --key-env must be the NAME of an environment variable (letters, digits, underscore).');
  if (!o.out || o.out.startsWith('--')) return R('refused: --out <folder> is required.', usage());
  if (!Number.isInteger(o.maxTurns) || o.maxTurns < 1 || o.maxTurns > MAX_TURNS_LIMIT) return R(`refused: --max-turns must be 1 to ${MAX_TURNS_LIMIT}.`);
  if (typeof o.brief !== 'string' || o.brief.trim().length < 10 || o.brief.length > 4000) return R('refused: --brief must be 10 to 4000 characters.');
  const out = path.resolve(o.out);
  if (fs.existsSync(out) && (!fs.statSync(out).isDirectory() || fs.readdirSync(out).length > 0)) return R(`refused: ${out} exists and is not an empty folder.`);
  const holds = Object.keys(env).filter((k) => /^NEXUS_DB_HOLD_/.test(k)).sort();
  if (holds.length > 0) return R(`refused: ${holds.join(', ')} ${holds.length === 1 ? 'is' : 'are'} set; unset ${holds.length === 1 ? 'it' : 'them'}.`);
  const real = userDataDirs().find((d) => inside(tmp, d)) || null;
  if (real !== null) return R(`refused: the temp data home ${tmp} is inside the app's real user data (${real}); point TEMP/TMPDIR at a scratch folder.`);
  const raw = env[o.keyEnv];
  if (typeof raw !== 'string' || raw.length === 0) return R(`refused: the environment variable ${o.keyEnv} is not set: set it to your API key for this one run (the key is never taken from an argument).`);
  if (!(deps.keyShaped || keyShaped)(raw.trim())) return R(`refused: the environment variable ${o.keyEnv} does not hold something shaped like an API key (visible characters, no spaces, 8 to 512 long).`);
  const pre = preflight();
  if (!pre.ok) return { code: EXIT.NOT_RUN, lines: [...pre.checks.filter((c) => !c.ok).map((c) => `NOT RUN: ${c.notRun} ${c.action}`)] };
  return null;
}

// ---------------------------------------------------------------- what the transcript says and never says

const MIN = 60_000;
/** The scrubber for a run: `secrets` are the exact strings that must never appear (the key); key-shaped and secret-shaped text is cut out as well. */
function scrubber(secrets = []) {
  const exact = secrets.filter((s) => typeof s === 'string' && s.length >= 8);
  const forms = [];
  for (const s of exact) forms.push(s, Buffer.from(s, 'utf8').toString('base64'), encodeURIComponent(s));
  return (text) => {
    let t = String(text ?? '');
    for (const f of forms) if (f.length >= 8 && t.includes(f)) t = t.split(f).join('[key]');
    return t
      .replace(/\b(?:sk|pk|rk|gsk|xai)[-_][A-Za-z0-9_-]{12,}/g, '[secret]')
      .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, '[secret]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [secret]')
      .replace(/\b[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*=\S+/g, '[assignment]')
      .replace(/[A-Za-z]:\\Users\\[^\\\s"']+/g, 'C:\\Users\\<user>')
      .replace(/\/(?:Users|home)\/[^/\s"']+/g, '/<home>/<user>');
  };
}
/** The default scrubber (shapes only; a run's own scrubber also knows its key). */
const scrub = scrubber();
const clipWith = (sc) => (t, n) => { const s = sc(t); return s.length <= n ? s : `${s.slice(0, n)}...[cut]`; };
const clip = clipWith(scrub);

/** node:test's (or pytest's) own totals from a run's output. */
function testCounts(stdout) {
  const py = /(?:(\d+) failed)?[ ,]*(?:(\d+) passed)/.exec(stdout ?? '');
  if (py && !/^# tests /m.test(stdout ?? '')) { const f = Number(py[1] ?? 0); const ok = Number(py[2] ?? 0); return { tests: f + ok, pass: ok, fail: f }; }
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
const hostKey = (d) => `${d.host}:${d.port}`;

/**
 * The STOP section, PURE over the transcript: a list of sentences, empty when nothing says stop.
 *   - the runtime check does not list the chosen provider and model (nothing was run);
 *   - the consent is not the whole preset table's host list for kind hosted-model, or its caps are not the defaults;
 *   - any proxy decision for a host other than the chosen provider's host:port (requested, whether allowed or refused), or decisions the runner
 *     did not report (their hosts are unknown);
 *   - a turn the provider rejected the key for;
 *   - a change outside the turn's worktree and the scratch folders.
 */
function stopFindings(T) {
  const out = [];
  const chosen = T.chosenHost;
  if (T.probe && T.probe.listed === false) out.push(`the runtime check does not list the chosen provider and model (${T.provider} / ${T.model}): nothing was run`);
  if (T.consent) {
    const c = T.consent;
    if (c.kind !== 'hosted-model') out.push(`the consent is for kind ${c.kind}, not hosted-model`);
    if (JSON.stringify(c.hosts) !== JSON.stringify(T.tableHosts)) out.push(`the consent's hosts are ${JSON.stringify(c.hosts)}, not the preset table's ${JSON.stringify(T.tableHosts)}`);
    if (c.provider !== T.provider || c.model !== T.model) out.push(`the consent records ${c.provider} / ${c.model}, not ${T.provider} / ${T.model}`);
    const d = c.defaults;
    if (d) for (const k of Object.keys(d)) if (c.caps[k] !== d[k]) out.push(`the consent's cap ${k} is ${c.caps[k]}, not the default ${d[k]}`);
  }
  const hosts = new Map();
  for (const t of T.turns || []) {
    for (const d of (t.egress && t.egress.decisions) || []) {
      const k = hostKey(d);
      if (k !== chosen) { const s = hosts.get(k) || { allowed: 0, refused: 0, reasons: new Set() }; s[d.decision === 'allowed' ? 'allowed' : 'refused'] += 1; s.reasons.add(d.reason); hosts.set(k, s); }
    }
    if (t.egress && t.egress.truncated > 0) out.push(`turn ${t.n}: ${t.egress.truncated} proxy decision(s) were not reported, so their hosts are unknown`);
    if (t.keyRejected) out.push(`turn ${t.n}: the provider rejected the API key (check the key and its project; nothing more was run)`);
  }
  for (const [k, s] of hosts) out.push(`a host other than ${chosen} was requested: ${k} (allowed ${s.allowed}, refused ${s.refused}; ${[...s.reasons].sort().join(', ')})`);
  for (const x of T.outside || []) out.push(`a change landed outside the worktree and the scratch folders (${x.when}): ${x.what}`);
  return out;
}

/** Totals of every decision over the run: per host:port, allowed and refused counts. */
function egressSummary(T) {
  const by = {};
  for (const t of T.turns || []) for (const d of (t.egress && t.egress.decisions) || []) {
    const k = hostKey(d); by[k] = by[k] || { allowed: 0, refused: 0, reasons: [] };
    by[k][d.decision === 'allowed' ? 'allowed' : 'refused'] += 1;
    if (!by[k].reasons.includes(d.reason)) by[k].reasons.push(d.reason);
  }
  return by;
}

// ---------------------------------------------------------------- the detectors of a change outside the scratch folders

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
/** A read-only look at this app's own checkout (git status and the numstat of tracked changes): a changed digest means a file of the app changed. */
function appCheckoutDigest() {
  const g = (...a) => { const r = spawnSync('git', ['-C', ROOT, '-c', 'core.fsmonitor=false', ...a], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }); return r.status === 0 ? r.stdout : `error:${r.status}`; };
  return sha(`${g('rev-parse', 'HEAD')}\n${g('status', '--porcelain')}\n${g('diff', '--numstat')}`);
}
/** Which parts of the scratch user repository's state differ (names only). */
function userStateDiff(a, b) {
  const out = [];
  for (const k of ['head', 'branch', 'status', 'stash', 'index']) if (a[k] !== b[k]) out.push(k);
  if (JSON.stringify(a.files) !== JSON.stringify(b.files)) out.push('files');
  return out;
}

// ---------------------------------------------------------------- the run

async function run(o) {
  // The key is read ONCE and removed from this process's environment at once: nothing started later (Docker's CLI, a child) inherits it.
  const apiKey = String(process.env[o.keyEnv] ?? '').trim();
  delete process.env[o.keyEnv];
  const sc = scrubber([apiKey]);
  const clipS = clipWith(sc);
  const tbl = table();
  const prov = tbl.providers.find((p) => p.id === o.provider);
  const model = o.model === null ? prov.defaultModel : o.model;
  const chosenHost = `${prov.host}:${prov.port}`;
  const { flowWorld, useFixture } = require(path.join(ROOT, 'test', 'helpers', 'agentFlowWorld.cjs'));
  const { intent } = require(path.join(ROOT, 'test', 'helpers', 'ipcExec.cjs'));
  const { AGENT_DEFAULTS } = require(path.join(ROOT, 'test', 'load-ts.cjs'))('src/shared/nexus/agentPolicy.ts');
  const started = Date.now();
  const out = path.resolve(o.out);
  const T = { startedAt: new Date(started).toISOString(), provider: o.provider, model, keyEnv: o.keyEnv, keyHeld: 'in memory for this run only (never printed or written)', fixture: o.fixture, brief: o.brief, maxTurns: o.maxTurns,
    chosenHost, tableHosts: tbl.hosts, probe: { listed: null, providers: [] }, consent: null, turns: [], changeSets: [], merge: null, outside: [], stop: [], egress: {}, result: 'running', problems: [], totals: null, wallMs: null };
  const log = (l) => console.log(`[hosted-demo] ${sc(l)}`);
  const halt = () => { T.stop = stopFindings(T); return T.stop.length > 0; };
  let w = null;
  try {
    log(`provider ${o.provider}, model ${model}, host ${chosenHost}; real Docker; the default caps; up to ${o.maxTurns} turn(s)`);
    w = await flowWorld({ runtime: 'hosted-model', provider: o.provider, model, real: true, hostedSeam: null });
    // The data home and the repository are scratch: never the app's real user data, always under the temp folder.
    const real = realUserDataDirs().find((d) => [w.userData, w.dataHome.root, w.file].some((p) => inside(p, d)));
    if (real || ![w.userData, w.dataHome.root].every((p) => inside(p, os.tmpdir()))) throw new Error('the data home is not a scratch folder under the temp folder; nothing was started');
    await useFixture(w, o.fixture);
    await w.snapshot();
    if (!inside(w.repoDir, os.tmpdir())) throw new Error('the fixture repository is not a scratch folder; nothing was started');

    // 1. The runtime check lists the chosen provider and model (offline preset data; no key is involved, no request is made).
    await w.probeAgain();
    const entry = w.nx.agentProbe.cache.fresh('hosted-model');
    const listed = ((entry && entry.setup && entry.setup.providers) || []);
    T.probe.providers = listed.map((p) => p.id);
    T.probe.listed = listed.some((p) => p.id === o.provider && p.models.some((m) => m.name === model && m.tools));
    if (halt()) { T.result = 'stopped'; return T; }

    // 2. The key into the scratch world's key store (the app's own store API over an in-memory fake safeStorage), then the permission through #51.
    const stored = await w.setKey(apiKey, o.provider);
    if (!stored.ok) { T.problems.push(`the key was not accepted by the key store (${stored.reason})`); throw new Error('the key could not be stored'); }
    const watch = { app: appCheckoutDigest(), user: w.userState() };
    try { await w.consent(); } catch (e) { T.problems.push(`consent was refused: ${clipS(e && e.message, 400)}`); throw new Error('the hosted runtime could not be granted'); }
    const row = w.consentRow();
    const choice = w.nx.budget.liveChoice();
    T.consent = { kind: row.runtime_kind, hosts: JSON.parse(row.hosts_json), provider: choice.provider, model: choice.model,
      caps: { turnUsdCents: row.turn_usd_cents, dayUsdCents: row.day_usd_cents, turnsPerHour: row.turns_per_hour, concurrentTurns: row.concurrent_turns, turnTokens: row.turn_tokens, toolCalls: row.tool_calls },
      defaults: { turnUsdCents: AGENT_DEFAULTS.turnUsdCents, dayUsdCents: AGENT_DEFAULTS.dayUsdCents, turnsPerHour: AGENT_DEFAULTS.turnsPerHour, concurrentTurns: AGENT_DEFAULTS.concurrentTurns,
        turnTokens: AGENT_DEFAULTS.turnTokens, toolCalls: AGENT_DEFAULTS.toolCalls } };
    if (halt()) { T.result = 'stopped'; return T; }
    log(`permission granted for ${T.consent.hosts.join(', ')}; the adapter will call ${chosenHost} only; the first turn starts`);

    let message = `${o.brief}\n\n${FIXTURES[o.fixture].where} Run the tests with sandbox_exec using ${FIXTURES[o.fixture].test}. When the tests pass, register the change with changeset_register.`;
    let sessionId = null; let artifactId = null; let candidate = null;
    for (let n = 1; n <= o.maxTurns && candidate === null; n++) {
      const t0 = Date.now();
      log(`turn ${n}: asking the model`);
      const turn = await w.turn(message, { sessionId, ms: 40 * MIN });
      sessionId = turn.sessionId;
      const usage = w.usageOf(turn.jobId);
      const execs = w.execResults(turn.jobId).map((e) => ({ argv: e.argv, exit: e.exit, failed: e.failed, ...testCounts(e.stdout), tail: clipS(String(e.stdout).trim().split('\n').slice(-12).join('\n'), 800) }));
      const tools = w.toolCallsOf(turn.jobId);
      const decisions = w.egressDecisions(turn.jobId);
      const errorText = turn.job.error_json ? String(turn.job.error_json) : null;
      const requests = decisions.filter((d) => hostKey(d) === chosenHost && d.decision === 'allowed').length;
      const rec = { n, state: turn.job.state, outcome: turn.job.outcome, error: errorText ? clipS(errorText, 400) : null, keyRejected: turn.job.outcome === 'hosted_key_rejected',
        limitHit: ['hosted_rate_limited', 'hosted_quota_exhausted'].includes(turn.job.outcome) ? turn.job.outcome : null,
        tools, sandboxRuns: execs, providerRequests: requests, egress: { decisions, truncated: w.egressTruncated(turn.jobId) },
        usage: usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, toolCalls: usage.toolCalls, costUsdCents: usage.costUsdCents, estimated: usage.estimated } : null,
        ms: Date.now() - t0, changeSet: null };
      T.turns.push(rec);
      // Nothing outside the worktree may have changed: the scratch user repository is as it was (until the merge), and so is this app's checkout.
      const ud = userStateDiff(watch.user, w.userState());
      if (ud.length > 0) T.outside.push({ when: `after turn ${n}`, what: `the scratch user repository changed before any approval (${ud.join(', ')})` });
      if (appCheckoutDigest() !== watch.app) T.outside.push({ when: `after turn ${n}`, what: 'this app\'s own checkout changed (git status or tracked diff differs; verify it was not another session)' });
      T.egress = egressSummary(T);
      log(`turn ${n}: ${rec.state}/${rec.outcome}; ${tools.length} tool calls; ${execs.length} sandbox runs; ${requests} provider request(s) (a retry after a rate limit counts); tokens ${rec.usage ? `${rec.usage.inputTokens} in / ${rec.usage.outputTokens} out` : 'unknown'}; ${(rec.ms / 1000).toFixed(0)}s${rec.limitHit ? `; ENDED ON THE LIMIT: ${rec.limitHit}` : ''}`);
      if (halt()) { T.result = 'stopped'; return T; }
      if (rec.limitHit) { T.problems.push(`turn ${n} ended on the provider's ${rec.limitHit === 'hosted_quota_exhausted' ? 'free quota' : 'rate limit'}: no further turn was started`); T.result = 'limit'; return T; }
      const [cs] = w.changeSetsOf(turn.jobId);
      if (!cs) {
        message = 'You did not register a change set. Finish the work: write the files with write_file, run the tests with sandbox_exec, and call changeset_register.';
        continue;
      }
      const status = await w.until_candidate(cs, 30 * MIN);
      const checks = w.checks(cs);
      const tp = w.db.prepare("SELECT summary FROM validations WHERE version_id = ? AND validator_id = 'cs.tests_pass' ORDER BY rowid DESC").get(cs);
      artifactId = w.versionRow(cs).artifact_id;
      rec.changeSet = { versionId: cs, artifactId, status, checks, testsSummary: tp ? clipS(tp.summary, 300) : null };
      T.changeSets.push(rec.changeSet);
      log(`turn ${n}: change set ${status}; ${tp ? tp.summary : 'no test summary'}`);
      if (status === 'candidate') { candidate = cs; break; }
      const lastRun = execs.length > 0 ? execs[execs.length - 1].tail : '';
      message = `The change set you registered did not pass its checks: ${JSON.stringify(checks)}. Tests: ${tp ? tp.summary : 'unknown'}.\n`
        + `Output of your last test run:\n${lastRun}\n\nFix the code or the tests, run them again with sandbox_exec, then call changeset_register again with reviseArtifactId "${artifactId}" so it becomes the next version of the same change set.`;
    }
    if (candidate === null) { T.result = 'no_candidate'; T.problems.push(`no change set reached candidate in ${T.turns.length} turn(s)`); return T; }

    await w.x.ok('nexus:review:decide', candidate, { decision: 'approve' }, intent());
    const st0 = await w.okd('nexus:repo:status', w.PROJECT);
    const acc = await w.okd('nexus:changeSet:accept', candidate, st0.acceptedHead);
    // Accept never touches the user's checked-out branch or files: the scratch repository is still as it was.
    const ud = userStateDiff(watch.user, w.userState());
    if (ud.length > 0) T.outside.push({ when: 'after accept', what: `the scratch user repository changed on accept (${ud.join(', ')})` });
    if (halt()) { T.result = 'stopped'; return T; }
    const st1 = await w.okd('nexus:repo:status', w.PROJECT);
    await w.okd('nexus:repo:mergeAccepted', w.PROJECT, { branch: st1.branch, expectedAcceptedHead: st1.acceptedHead });
    T.merge = { commit: w.userHead(), acceptCommit: acc.accept.mergeCommit, branch: st1.branch, mergedFastForward: w.userHead() === acc.accept.mergeCommit };
    if (appCheckoutDigest() !== watch.app) T.outside.push({ when: 'after merge', what: 'this app\'s own checkout changed (git status or tracked diff differs; verify it was not another session)' });
    copyTree(w.repoDir, out);
    T.result = T.merge.mergedFastForward ? 'merged' : 'merge_mismatch';
    log(`merged ${T.merge.commit.slice(0, 8)}; product copied to ${out}`);
    return T;
  } catch (e) {
    T.result = 'error'; T.problems.push(clipS(e && e.stack ? e.stack : e, 1500));
    return T;
  } finally {
    T.wallMs = Date.now() - started;
    T.egress = egressSummary(T);
    T.stop = stopFindings(T);
    const sum = (f) => T.turns.reduce((s, t) => s + ((t.usage && t.usage[f]) || 0), 0);
    T.totals = { turns: T.turns.length, toolCalls: T.turns.reduce((s, t) => s + t.tools.length, 0), providerRequests: T.turns.reduce((s, t) => s + t.providerRequests, 0),
      proxyDecisions: T.turns.reduce((s, t) => s + t.egress.decisions.length, 0), inTokens: sum('inputTokens'), outTokens: sum('outputTokens') };
    if (w) {
      // Revocable: the permission is ended and the scratch key store emptied before the world is closed; best effort.
      try { await w.x.call('nexus:agent:consent', { op: 'revoke' }); } catch { /* best effort */ }
      try { w.keys.delete(o.provider); } catch { /* best effort */ }
      try { await w.close(); } catch { /* best effort */ }
    }
    // The transcript is scrubbed of the key as a whole, one last time, by the caller's writer (see writeTranscript).
    T.scrubWith = sc;
  }
}

function markdown(T) {
  const L = [];
  L.push(`# Nexus hosted-model showcase: ${T.result}${T.stop.length > 0 ? ' (STOP)' : ''}`, '', `- provider \`${T.provider}\`, model \`${T.model}\` (the user's own free API key, held in memory only; read from the variable ${T.keyEnv}); host ${T.chosenHost}`,
    `- fixture: \`${T.fixture}\` (scratch); real Docker sandbox, the real host egress proxy`,
    `- started: ${T.startedAt}; wall time: ${((T.wallMs || 0) / 1000).toFixed(0)} s`,
    `- turns: ${T.totals.turns} of at most ${T.maxTurns}; tool calls: ${T.totals.toolCalls}; provider requests: ${T.totals.providerRequests}; proxy decisions: ${T.totals.proxyDecisions}; tokens: ${T.totals.inTokens} in / ${T.totals.outTokens} out (the provider's own counts; cost 0, free tier)`);
  if (T.consent) L.push(`- permission: kind ${T.consent.kind}, hosts ${T.consent.hosts.join(', ')}, chosen ${T.consent.provider} / ${T.consent.model}; default caps`);
  if (T.merge) L.push(`- merge commit: \`${T.merge.commit}\` on \`${T.merge.branch}\` (fast-forward: ${T.merge.mergedFastForward})`);
  L.push('', '## STOP', '');
  if (T.stop.length === 0) L.push('Nothing says stop.');
  else L.push(...T.stop.map((s) => `- ${s}`));
  L.push('', '## Network', '');
  const hosts = Object.entries(T.egress || {});
  if (hosts.length === 0) L.push('No proxy decision was recorded.');
  else for (const [k, s] of hosts) L.push(`- \`${k}\`: allowed ${s.allowed}, refused ${s.refused}${s.reasons.length > 0 ? ` (${s.reasons.join(', ')})` : ''}${k === T.chosenHost ? '' : '  <- NOT the chosen provider\'s host'}`);
  L.push('', `- runtime check lists the chosen provider and model: ${T.probe.listed}`);
  L.push('', '## Brief', '', T.brief, '', '## Turns', '');
  for (const t of T.turns) {
    L.push(`### Turn ${t.n}: ${t.state} / ${t.outcome ?? '-'}`, '', `- ${t.tools.length} tool calls: ${t.tools.join(', ') || 'none'}; ${(t.ms / 1000).toFixed(0)} s`);
    L.push(`- usage: ${t.usage ? `${t.usage.inputTokens} in / ${t.usage.outputTokens} out; ${t.usage.toolCalls} tool calls` : 'none recorded'}; provider requests: ${t.providerRequests} (a retry after a rate limit or a server error is one more request; the waits themselves are not reported by the adapter)${t.limitHit ? `; ENDED ON THE LIMIT: ${t.limitHit}` : ''}`);
    L.push(`- proxy decisions (${t.egress.decisions.length}${t.egress.truncated > 0 ? `, ${t.egress.truncated} not reported` : ''}): ${t.egress.decisions.map((d) => `${d.decision} ${hostKey(d)}${d.decision === 'refused' ? ` (${d.reason})` : ''}`).join('; ') || 'none'}`);
    for (const r of t.sandboxRuns) L.push(`- sandbox run \`${r.argv}\`: exit ${r.exit}${r.tests !== null ? `; tests ${r.tests}, pass ${r.pass}, fail ${r.fail}` : ''}`);
    if (t.changeSet) L.push(`- change set ${t.changeSet.versionId}: **${t.changeSet.status}**; cs.tests_pass: ${t.changeSet.testsSummary ?? 'n/a'}`);
    if (t.error) L.push(`- error: ${t.error}`);
    L.push('');
  }
  if (T.problems.length > 0) L.push('## Problems', '', ...T.problems.map((p) => `- ${clip(p, 600)}`), '');
  return L.join('\n');
}

/** Writes the transcript next to --out, every byte passed through the run's scrubber (the key is cut out wherever it could appear). */
function writeTranscript(T, o, sc = scrub) {
  const out = path.resolve(o.out);
  const base = path.join(path.dirname(out), `${path.basename(out)}-transcript`);
  const { scrubWith: _drop, ...plain } = T;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(`${base}.json`, `${sc(JSON.stringify(plain, null, 2))}\n`);
  fs.writeFileSync(`${base}.md`, `${sc(markdown(plain))}\n`);
  return base;
}

async function main(argv) {
  const o = parseArgs(argv);
  const refused = refusal(o);
  if (refused) { for (const l of refused.lines) console.error(l); return refused.code; }
  const electron = Boolean(process.versions.electron) && process.env.ELECTRON_RUN_AS_NODE === '1';
  if (!electron) {
    // better-sqlite3 is built for Electron: re-run this file under Electron-as-node (as tools/run-exec-tests.cjs runs its files).
    const r = spawnSync(require('electron'), [__filename, ...argv], { cwd: ROOT, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' });
    return r.status === null ? EXIT.FAILED : r.status;
  }
  const T = await run(o);
  const sc = T.scrubWith || scrub;
  const base = writeTranscript(T, o, sc);
  console.log(`[hosted-demo] result: ${T.result}; ${T.totals.turns} turn(s), ${T.totals.toolCalls} tool calls, ${T.totals.providerRequests} provider requests, ${T.totals.inTokens}/${T.totals.outTokens} tokens, ${((T.wallMs || 0) / 1000).toFixed(0)} s`);
  console.log(`[hosted-demo] transcript: ${base}.md and ${base}.json`);
  if (T.stop.length > 0) { console.error('[hosted-demo] STOP:'); for (const s of T.stop) console.error(`[hosted-demo]   ${sc(s)}`); return EXIT.STOP; }
  return T.result === 'merged' ? EXIT.OK : EXIT.FAILED;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(`[hosted-demo] failed: ${scrub(e && e.message)}`); process.exit(EXIT.FAILED); });
}

module.exports = { parseArgs, refusal, stopFindings, egressSummary, userStateDiff, scrub, scrubber, testCounts, markdown, writeTranscript, argName, table, DEFAULT_BRIEF, WEATHER_BRIEF, DEFAULT_KEY_ENV, EXIT, MAX_TURNS_LIMIT };
