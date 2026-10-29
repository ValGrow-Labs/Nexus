#!/usr/bin/env node
'use strict';
/**
 * The real-CLI check (CONTROLLER ONLY, never part of any test run, never run by an implementing agent): ONE real turn of the user's
 * installed vendor CLI through the REAL Nexus pipeline, on a scratch fixture.
 *
 *   node tools/nexus-demo-cli-agent.cjs --go --i-accept-quota --out <new-or-empty folder> [--brief "<text>"] [--max-turns 2]
 *
 * This spends the user's real model quota under the user's own login (D-B1: the CLI uses its login store in place; Nexus never reads,
 * copies or stores it, and this driver never touches the CLI's own home folder). That is why TWO explicit flags are required.
 *
 * What is real: the installed CLI (resolved by the production adapter itself: no test seam), main on a real SQLite database in a temp
 * data home, the runner core, the loopback MCP server, the REAL host egress proxy bound to the consent (api.anthropic.com:443 only, D-B2),
 * REAL Docker with the pinned sde-node image (sandbox_exec and cs.tests_pass run for real, network none), review, accept and the merge
 * into a temp repository. The only fake is the user's merge confirmation dialog, answered "Merge" at its show seam (as in the flows).
 * The consent is granted through #51 with the adapter's own host list and the DEFAULT caps (D-B4: $2 per turn, $10 per day, 6 turns per
 * hour, one at a time, 400k tokens, 200 tool calls, 30 minutes); the driver never raises them.
 *
 * What it records (the controller's STOP rules): every proxy decision of each turn (host:port, allowed or refused), usage and reported
 * cost per turn, the tools the agent used, wall time, and a STOP section, non-empty (exit 4) when any host other than
 * api.anthropic.com:443 was requested or refused (or decisions went unreported), when the CLI is not signed in or not usable, when a
 * change landed outside the turn's worktree and the scratch folders, or when the consent is not what was asked for. A STOP halts the run
 * at once: no further turn, no approve, no merge. The transcript never holds a login, a token, an environment value or anything of the
 * CLI's own folder; free text is scrubbed before it is written.
 *
 * Refuses to start (exit 2) unless: --go AND --i-accept-quota; no unknown argument; --out does not exist or is an empty folder; no
 * NEXUS_DB_HOLD_* variable is set; the temp data home is a scratch folder (not inside the app's real userData). Exit 3: the resource
 * preflight of tools/run-exec-tests.cjs is not ok (Docker running, pinned images, free disk). Exit 0: merged and no STOP; 1: ran but no
 * merged product; 4: STOP section non-empty.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ALLOWED_HOST = 'api.anthropic.com:443';
const DEFAULT_BRIEF = 'Add a tiny CommonJS module src/greet.js that exports greet(name): it returns the string "Hello, <name>!" (for example greet("Ada") returns "Hello, Ada!") and throws a TypeError when name is not a string (a number, null or undefined). Write its tests with node:test in test/greet.test.js (at least three tests: a normal name, a second name, and a non-string that throws TypeError), run all the tests with sandbox_exec using ["node","--test"], then register the change with changeset_register.';
const FIXTURE = 'node-test-app';
const FIXTURE_NOTE = 'The project already has a src/ and a test/ folder; add your files there.';
const TEST_ARGV = '["node","--test"]';
const EXIT = Object.freeze({ OK: 0, FAILED: 1, REFUSED: 2, NOT_RUN: 3, STOP: 4 });
const MAX_TURNS_LIMIT = 2;

function usage() {
  return 'usage: node tools/nexus-demo-cli-agent.cjs --go --i-accept-quota --out <new or empty folder> [--brief "<text>"] [--max-turns 1|2]\n'
    + '  --go and --i-accept-quota are both required: this starts real Docker containers and runs the installed CLI for real,\n'
    + '  which uses the real model quota of the signed-in user.\n';
}

function parseArgs(argv) {
  const o = { go: false, acceptQuota: false, out: null, brief: null, maxTurns: 2, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[i + 1]; i += 1; return v; };
    if (a === '--go') o.go = true;
    else if (a === '--i-accept-quota') o.acceptQuota = true;
    else if (a === '--out') o.out = val();
    else if (a === '--brief') o.brief = val();
    else if (a === '--max-turns') o.maxTurns = Number(val());
    else o.unknown.push(a);
  }
  if (o.brief === null) o.brief = DEFAULT_BRIEF;
  return o;
}

const inside = (child, parent) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

function realPreflight() { return require('./run-exec-tests.cjs').runPreflight(); }
/** The folders of the app's own user data (the place a scratch data home must never be). */
function realUserDataDirs() { return require('./run-exec-tests.cjs').REAL_PROBES.userDataDirs(); }

/**
 * Every refusal, in order; returns { code, lines } or null. Everything it consults is injectable (tests): `deps.env` (default: this
 * process's environment, read for NEXUS_DB_HOLD_* NAMES only), `deps.tmpdir`, `deps.userDataDirs`, `deps.preflight`.
 * All refusals except the preflight (exit 3) are exit 2 and none starts anything.
 */
function refusal(o, deps = {}) {
  const env = deps.env || process.env;
  const tmp = (deps.tmpdir || os.tmpdir)();
  const userDataDirs = deps.userDataDirs || realUserDataDirs;
  const preflight = deps.preflight || realPreflight;
  if (!o.go) return { code: EXIT.REFUSED, lines: ['refused: --go was not given.', usage()] };
  if (!o.acceptQuota) return { code: EXIT.REFUSED, lines: ['refused: --i-accept-quota was not given: this run spends the real model quota of the signed-in user.', usage()] };
  if (o.unknown.length > 0) return { code: EXIT.REFUSED, lines: [`refused: unknown argument ${o.unknown[0]}`, usage()] };
  if (!o.out || o.out.startsWith('--')) return { code: EXIT.REFUSED, lines: ['refused: --out <folder> is required.', usage()] };
  if (!Number.isInteger(o.maxTurns) || o.maxTurns < 1 || o.maxTurns > MAX_TURNS_LIMIT) return { code: EXIT.REFUSED, lines: [`refused: --max-turns must be 1 to ${MAX_TURNS_LIMIT}.`] };
  if (typeof o.brief !== 'string' || o.brief.trim().length < 10 || o.brief.length > 4000) return { code: EXIT.REFUSED, lines: ['refused: --brief must be 10 to 4000 characters.'] };
  const out = path.resolve(o.out);
  if (fs.existsSync(out) && (!fs.statSync(out).isDirectory() || fs.readdirSync(out).length > 0)) return { code: EXIT.REFUSED, lines: [`refused: ${out} exists and is not an empty folder.`] };
  const holds = Object.keys(env).filter((k) => /^NEXUS_DB_HOLD_/.test(k)).sort();
  if (holds.length > 0) return { code: EXIT.REFUSED, lines: [`refused: ${holds.join(', ')} ${holds.length === 1 ? 'is' : 'are'} set; unset ${holds.length === 1 ? 'it' : 'them'}.`] };
  const real = userDataDirs().find((d) => inside(tmp, d)) || null;
  if (real !== null) return { code: EXIT.REFUSED, lines: [`refused: the temp data home ${tmp} is inside the app's real user data (${real}); point TEMP/TMPDIR at a scratch folder.`] };
  const pre = preflight();
  if (!pre.ok) return { code: EXIT.NOT_RUN, lines: [...pre.checks.filter((c) => !c.ok).map((c) => `NOT RUN: ${c.notRun} ${c.action}`)] };
  return null;
}

// ---------------------------------------------------------------- what the transcript says and never says

const MIN = 60_000;
/** Free text on its way into the transcript: secret shapes, bearers and the user's profile folder name are cut out. */
function scrub(text) {
  return String(text ?? '')
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, '[secret]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [secret]')
    .replace(/\b[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*=\S+/g, '[assignment]')
    .replace(/[A-Za-z]:\\Users\\[^\\\s"']+/g, 'C:\\Users\\<user>')
    .replace(/\/(?:Users|home)\/[^/\s"']+/g, '/<home>/<user>');
}
const clip = (t, n) => { const s = scrub(t); return s.length <= n ? s : `${s.slice(0, n)}...[cut]`; };
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
const hostKey = (d) => `${d.host}:${d.port}`;

/** One probe cache entry as the transcript keeps it: fixed words and facts only (never the CLI's own output). */
function probeFacts(entry) {
  if (!entry) return null;
  const h = entry.health || {};
  return { healthOk: h.ok === true, reason: h.ok === true ? null : (h.reason ?? null), detail: h.ok === true ? null : clip(h.detail ?? '', 160), version: h.ok === true ? (h.version ?? null) : null,
    signedIn: entry.setup ? entry.setup.signedIn : null, flagsOk: entry.setup ? entry.setup.flagsOk === true : null,
    hosts: entry.setup ? entry.setup.egressHosts.map((x) => `${x.host}:${x.port}`).sort() : [] };
}

/**
 * The STOP section, PURE over the transcript: a list of sentences, empty when nothing says stop (D-B1, D-B2 and the run's own rules).
 *   - the CLI is not signed in, or not usable here (version, flags, not installed);
 *   - the consent is not api.anthropic.com:443 alone with the default caps;
 *   - any proxy decision for a host other than api.anthropic.com:443 (requested, whether allowed or refused), or decisions the runner
 *     did not report (their hosts are unknown);
 *   - a turn that failed because the model service refused the CLI's login;
 *   - a change outside the turn's worktree and the scratch folders.
 */
function stopFindings(T) {
  const out = [];
  for (const [when, p] of [['before the permission', T.probe && T.probe.before], ['after the permission', T.probe && T.probe.after]]) {
    if (!p) continue;
    if (p.signedIn === 'no' || p.reason === 'not_authenticated') out.push(`the CLI is not signed in (the probe ${when} says not authenticated): nothing was run`);
    else if (!p.healthOk) out.push(`the CLI is not usable here (the probe ${when}: ${p.reason ?? 'unknown'}${p.detail ? `, ${p.detail}` : ''}): nothing was run`);
    else if (p.flagsOk === false) out.push(`the CLI does not have the pinned flags (the probe ${when})`);
  }
  if (T.consent) {
    const c = T.consent;
    if (JSON.stringify(c.hosts) !== JSON.stringify([ALLOWED_HOST])) out.push(`the consent's hosts are ${JSON.stringify(c.hosts)}, not [${ALLOWED_HOST}]`);
    if (c.kind !== 'cli-agent') out.push(`the consent is for kind ${c.kind}, not cli-agent`);
    const d = c.defaults;
    if (d) for (const k of Object.keys(d)) if (c.caps[k] !== d[k]) out.push(`the consent's cap ${k} is ${c.caps[k]}, not the default ${d[k]}`);
  }
  const hosts = new Map();
  for (const t of T.turns || []) {
    for (const d of (t.egress && t.egress.decisions) || []) {
      const k = hostKey(d);
      if (k !== ALLOWED_HOST) { const s = hosts.get(k) || { allowed: 0, refused: 0, reasons: new Set() }; s[d.decision === 'allowed' ? 'allowed' : 'refused'] += 1; s.reasons.add(d.reason); hosts.set(k, s); }
    }
    if (t.egress && t.egress.truncated > 0) out.push(`turn ${t.n}: ${t.egress.truncated} proxy decision(s) were not reported, so their hosts are unknown`);
    if (t.authFailure) out.push(`turn ${t.n}: the model service refused the CLI's login (not signed in, or the login expired)`);
  }
  for (const [k, s] of hosts) out.push(`a host other than ${ALLOWED_HOST} was requested: ${k} (allowed ${s.allowed}, refused ${s.refused}; ${[...s.reasons].sort().join(', ')})`);
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
  const { flowWorld, useFixture } = require(path.join(ROOT, 'test', 'helpers', 'agentFlowWorld.cjs'));
  const { intent } = require(path.join(ROOT, 'test', 'helpers', 'ipcExec.cjs'));
  const { AGENT_DEFAULTS } = require(path.join(ROOT, 'test', 'load-ts.cjs'))('src/shared/nexus/agentPolicy.ts');
  const started = Date.now();
  const out = path.resolve(o.out);
  const T = { startedAt: new Date(started).toISOString(), fixture: FIXTURE, brief: o.brief, maxTurns: o.maxTurns, probe: { before: null, after: null }, consent: null, turns: [], changeSets: [],
    merge: null, outside: [], stop: [], egress: {}, result: 'running', problems: [], totals: null, wallMs: null };
  const log = (l) => console.log(`[cli-demo] ${l}`);
  const halt = () => { T.stop = stopFindings(T); return T.stop.length > 0; };
  let w = null;
  try {
    log('real CLI, real Docker; the default caps; up to ' + `${o.maxTurns} turn(s)`);
    w = await flowWorld({ runtime: 'cli-agent', real: true });
    // The data home and the repository are scratch: never the app's real user data, always under the temp folder.
    const real = realUserDataDirs().find((d) => [w.userData, w.dataHome.root, w.file].some((p) => inside(p, d)));
    if (real || ![w.userData, w.dataHome.root].every((p) => inside(p, os.tmpdir()))) throw new Error('the data home is not a scratch folder under the temp folder; nothing was started');
    await useFixture(w, FIXTURE);
    await w.snapshot();
    if (!inside(w.repoDir, os.tmpdir())) throw new Error('the fixture repository is not a scratch folder; nothing was started');

    // 1. The probe, BEFORE any permission: not signed in or not usable stops here (no consent, no turn).
    T.probe.before = probeFacts(await w.probeCli());
    if (T.probe.before === null) { T.problems.push('the runtime check did not report the CLI'); T.result = 'not_run'; return T; }
    if (halt()) { T.result = 'stopped'; return T; }

    // 2. The permission: through #51, the adapter's own hosts, the default caps (the world refuses any other caps).
    const watch = { app: appCheckoutDigest(), user: w.userState() };
    try { await w.consent(); } catch (e) { T.problems.push(`consent was refused: ${clip(e && e.message, 400)}`); throw new Error('the CLI runtime could not be granted'); }
    const row = w.consentRow();
    T.consent = { kind: row.runtime_kind, hosts: JSON.parse(row.hosts_json), caps: { turnUsdCents: row.turn_usd_cents, dayUsdCents: row.day_usd_cents, turnsPerHour: row.turns_per_hour,
      concurrentTurns: row.concurrent_turns, turnTokens: row.turn_tokens, toolCalls: row.tool_calls }, defaults: { turnUsdCents: AGENT_DEFAULTS.turnUsdCents, dayUsdCents: AGENT_DEFAULTS.dayUsdCents,
      turnsPerHour: AGENT_DEFAULTS.turnsPerHour, concurrentTurns: AGENT_DEFAULTS.concurrentTurns, turnTokens: AGENT_DEFAULTS.turnTokens, toolCalls: AGENT_DEFAULTS.toolCalls } };
    // The probe again, with the permission in force (the allow-list proxy): the sign-in word is read again.
    T.probe.after = probeFacts(await w.probeCli());
    if (halt()) { T.result = 'stopped'; return T; }
    log(`permission granted for ${T.consent.hosts.join(', ')} with the default caps; the turn starts`);

    let message = `${o.brief}\n\n${FIXTURE_NOTE} Create and edit files with your file tools, run the tests with the sandbox_exec tool using ${TEST_ARGV}. When the tests pass, register the change with the changeset_register tool.`;
    let sessionId = null; let artifactId = null; let candidate = null;
    for (let n = 1; n <= o.maxTurns && candidate === null; n++) {
      const t0 = Date.now();
      log(`turn ${n}: the CLI works`);
      const turn = await w.turn(message, { sessionId, ms: 40 * MIN });
      sessionId = turn.sessionId;
      const usage = w.usageOf(turn.jobId);
      const execs = w.execResults(turn.jobId).map((e) => ({ argv: e.argv, exit: e.exit, failed: e.failed, ...testCounts(e.stdout), tail: clip(String(e.stdout).trim().split('\n').slice(-12).join('\n'), 800) }));
      const tools = w.toolCallsOf(turn.jobId);
      const decisions = w.egressDecisions(turn.jobId);
      const errorText = turn.job.error_json ? String(turn.job.error_json) : null;
      const rec = { n, state: turn.job.state, outcome: turn.job.outcome, error: errorText ? clip(errorText, 400) : null, authFailure: errorText !== null && /\bauth\b/i.test(errorText),
        tools, sandboxRuns: execs, egress: { decisions, truncated: w.egressTruncated(turn.jobId) },
        usage: usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheCreationTokens: usage.cacheCreationTokens, cacheReadTokens: usage.cacheReadTokens, toolCalls: usage.toolCalls,
          costUsdCents: usage.costUsdCents, costUsd: usage.costUsdCents === null ? null : usage.costUsdCents / 100, estimated: usage.estimated } : null,
        ms: Date.now() - t0, changeSet: null };
      T.turns.push(rec);
      // Nothing outside the worktree may have changed: the scratch user repository is as it was (until the merge), and so is this app's checkout.
      const ud = userStateDiff(watch.user, w.userState());
      if (ud.length > 0) T.outside.push({ when: `after turn ${n}`, what: `the scratch user repository changed before any approval (${ud.join(', ')})` });
      if (appCheckoutDigest() !== watch.app) T.outside.push({ when: `after turn ${n}`, what: 'this app\'s own checkout changed (git status or tracked diff differs; verify it was not another session)' });
      T.egress = egressSummary(T);
      log(`turn ${n}: ${rec.state}/${rec.outcome}; ${tools.length} tool calls; ${execs.length} sandbox runs; ${decisions.length} proxy decisions; ${(rec.ms / 1000).toFixed(0)}s; cost ${rec.usage && rec.usage.costUsd !== null ? `$${rec.usage.costUsd.toFixed(2)}` : 'unknown'}`);
      if (halt()) { T.result = 'stopped'; return T; }
      const [cs] = w.changeSetsOf(turn.jobId);
      if (!cs) {
        message = 'You did not register a change set. Finish the work: create the files, run the tests with the sandbox_exec tool, and call the changeset_register tool.';
        continue;
      }
      const status = await w.until_candidate(cs, 30 * MIN);
      const checks = w.checks(cs);
      const tp = w.db.prepare("SELECT summary FROM validations WHERE version_id = ? AND validator_id = 'cs.tests_pass' ORDER BY rowid DESC").get(cs);
      artifactId = w.versionRow(cs).artifact_id;
      rec.changeSet = { versionId: cs, artifactId, status, checks, testsSummary: tp ? clip(tp.summary, 300) : null };
      T.changeSets.push(rec.changeSet);
      log(`turn ${n}: change set ${status}; ${tp ? tp.summary : 'no test summary'}`);
      if (status === 'candidate') { candidate = cs; break; }
      const lastRun = execs.length > 0 ? execs[execs.length - 1].tail : '';
      message = `The change set you registered did not pass its checks: ${JSON.stringify(checks)}. Tests: ${tp ? tp.summary : 'unknown'}.\n`
        + `Output of your last test run:\n${lastRun}\n\nFix the code or the tests, run them again with the sandbox_exec tool, then call changeset_register again with reviseArtifactId "${artifactId}" so it becomes the next version of the same change set.`;
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
    T.result = 'error'; T.problems.push(clip(e && e.stack ? e.stack : e, 1500));
    return T;
  } finally {
    T.wallMs = Date.now() - started;
    T.egress = egressSummary(T);
    T.stop = stopFindings(T);
    const sum = (f) => T.turns.reduce((s, t) => s + ((t.usage && t.usage[f]) || 0), 0);
    T.totals = { turns: T.turns.length, toolCalls: T.turns.reduce((s, t) => s + t.tools.length, 0), proxyDecisions: T.turns.reduce((s, t) => s + t.egress.decisions.length, 0), inTokens: sum('inputTokens'), outTokens: sum('outputTokens'),
      costUsdCents: T.turns.some((t) => t.usage && t.usage.costUsdCents !== null) ? sum('costUsdCents') : null };
    if (w) {
      // Revocable (D-B2): the permission is ended before the world is closed; best effort.
      try { await w.x.call('nexus:agent:consent', { op: 'revoke' }); } catch { /* best effort */ }
      try { await w.close(); } catch { /* best effort */ }
    }
  }
}

function markdown(T) {
  const L = [];
  const usd = (c) => (c === null || c === undefined ? 'unknown' : `$${(c / 100).toFixed(2)}`);
  L.push(`# Nexus real-CLI check: ${T.result}${T.stop.length > 0 ? ' (STOP)' : ''}`, '', `- fixture: \`${T.fixture}\` (scratch); the installed CLI, real Docker sandbox, the real host egress proxy`,
    `- started: ${T.startedAt}; wall time: ${((T.wallMs || 0) / 1000).toFixed(0)} s`,
    `- turns: ${T.totals.turns} of at most ${T.maxTurns}; tool calls: ${T.totals.toolCalls}; proxy decisions: ${T.totals.proxyDecisions}; tokens: ${T.totals.inTokens} in / ${T.totals.outTokens} out; reported cost: ${usd(T.totals.costUsdCents)} (an estimate, as the CLI reports it)`);
  if (T.consent) L.push(`- permission: kind ${T.consent.kind}, hosts ${T.consent.hosts.join(', ')}; caps $${(T.consent.caps.turnUsdCents / 100).toFixed(2)}/turn, $${(T.consent.caps.dayUsdCents / 100).toFixed(2)}/day, ${T.consent.caps.turnsPerHour} turns/hour, ${T.consent.caps.concurrentTurns} at a time`);
  if (T.merge) L.push(`- merge commit: \`${T.merge.commit}\` on \`${T.merge.branch}\` (fast-forward: ${T.merge.mergedFastForward})`);
  L.push('', '## STOP', '');
  if (T.stop.length === 0) L.push('Nothing says stop.');
  else L.push(...T.stop.map((s) => `- ${s}`));
  L.push('', '## Network', '');
  const hosts = Object.entries(T.egress || {});
  if (hosts.length === 0) L.push('No proxy decision was recorded.');
  else for (const [k, s] of hosts) L.push(`- \`${k}\`: allowed ${s.allowed}, refused ${s.refused}${s.reasons.length > 0 ? ` (${s.reasons.join(', ')})` : ''}${k === ALLOWED_HOST ? '' : '  <- NOT the consented host'}`);
  for (const [when, p] of [['before the permission', T.probe && T.probe.before], ['after the permission', T.probe && T.probe.after]]) {
    if (p) L.push('', `- probe ${when}: ${p.healthOk ? `healthy, version ${p.version}` : `not healthy (${p.reason}${p.detail ? `: ${p.detail}` : ''})`}; signed in: ${p.signedIn}; flags ok: ${p.flagsOk}; hosts ${p.hosts.join(', ')}`);
  }
  L.push('', '## Brief', '', T.brief, '', '## Turns', '');
  for (const t of T.turns) {
    L.push(`### Turn ${t.n}: ${t.state} / ${t.outcome ?? '-'}`, '', `- ${t.tools.length} tool calls: ${t.tools.join(', ') || 'none'}; ${(t.ms / 1000).toFixed(0)} s`);
    L.push(`- usage: ${t.usage ? `${t.usage.inputTokens} in / ${t.usage.outputTokens} out (cache write ${t.usage.cacheCreationTokens}, read ${t.usage.cacheReadTokens}); ${t.usage.toolCalls} tool calls; cost ${usd(t.usage.costUsdCents)}${t.usage.estimated ? ' (estimate)' : ''}` : 'none recorded'}`);
    L.push(`- proxy decisions (${t.egress.decisions.length}${t.egress.truncated > 0 ? `, ${t.egress.truncated} not reported` : ''}): ${t.egress.decisions.map((d) => `${d.decision} ${hostKey(d)}${d.decision === 'refused' ? ` (${d.reason})` : ''}`).join('; ') || 'none'}`);
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
  const refused = refusal(o);
  if (refused) { for (const l of refused.lines) console.error(l); return refused.code; }
  const electron = Boolean(process.versions.electron) && process.env.ELECTRON_RUN_AS_NODE === '1';
  if (!electron) {
    // better-sqlite3 is built for Electron: re-run this file under Electron-as-node (as tools/run-exec-tests.cjs runs its files).
    const r = spawnSync(require('electron'), [__filename, ...argv], { cwd: ROOT, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' });
    return r.status === null ? EXIT.FAILED : r.status;
  }
  const T = await run(o);
  const base = writeTranscript(T, o);
  console.log(`[cli-demo] result: ${T.result}; ${T.totals.turns} turn(s), ${T.totals.toolCalls} tool calls, ${T.totals.proxyDecisions} proxy decisions, ${((T.wallMs || 0) / 1000).toFixed(0)} s`);
  console.log(`[cli-demo] transcript: ${base}.md and ${base}.json`);
  if (T.stop.length > 0) { console.error('[cli-demo] STOP:'); for (const s of T.stop) console.error(`[cli-demo]   ${s}`); return EXIT.STOP; }
  return T.result === 'merged' ? EXIT.OK : EXIT.FAILED;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(`[cli-demo] failed: ${scrub(e && e.message)}`); process.exit(EXIT.FAILED); });
}

module.exports = { parseArgs, refusal, stopFindings, egressSummary, probeFacts, userStateDiff, scrub, testCounts, markdown, DEFAULT_BRIEF, ALLOWED_HOST, EXIT, MAX_TURNS_LIMIT };
